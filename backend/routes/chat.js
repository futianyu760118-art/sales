const express = require('express');
const logger = require('../lib/logger');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('chat_channels');
ensureTable('chat_messages');
ensureTable('chat_action_items');
ensureTable('chat_ai_context');

// ===== 频道管理 =====
router.get('/channels', requirePerm('ai:view'), (req, res) => {
  const table = getTable('chat_channels');
  const user = req.query.user || '';
  let channels = table.all();
  if (user) {
    channels = channels.filter(ch => {
      if (ch.type === 'public') return true;
      if (ch.type === 'direct') {
        const members = (ch.members || '').split(',').map(m => m.trim());
        return members.includes(user);
      }
      if (ch.type === 'business') {
        const members = (ch.members || '').split(',').map(m => m.trim());
        return members.includes(user) || ch.created_by === user;
      }
      return ch.created_by === user;
    });
  }
  channels.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  res.json(channels);
});

router.post('/channels', requirePerm('ai:view'), (req, res) => {
  const table = getTable('chat_channels');
  const { name, type, members, business_type, business_id, business_title, created_by } = req.body;
  if (type === 'direct' && members) {
    const memberArr = members.split(',').map(m => m.trim()).sort();
    const existing = table.all().find(ch => {
      if (ch.type !== 'direct') return false;
      const existingMembers = (ch.members || '').split(',').map(m => m.trim()).sort();
      return existingMembers.join(',') === memberArr.join(',');
    });
    if (existing) return res.json(existing);
  }
  if (type === 'business' && business_type && business_id) {
    const existing = table.all().find(ch =>
      ch.type === 'business' && ch.business_type === business_type && ch.business_id === Number(business_id)
    );
    if (existing) return res.json(existing);
  }
  const record = {
    name: name || '',
    type: type || 'public',
    members: members || '',
    business_type: business_type || '',
    business_id: business_id ? Number(business_id) : null,
    business_title: business_title || '',
    created_by: created_by || 'system',
    created_at: now(),
    updated_at: now()
  };
  const result = table.insert(record);
  res.json({ ...record, id: result.lastID });
});

router.put('/channels/:id', requirePerm('ai:view'), (req, res) => {
  const table = getTable('chat_channels');
  const fields = { updated_at: now() };
  ['name', 'members'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '频道更新成功' });
});

// ===== 消息管理 =====
router.get('/messages', requirePerm('ai:view'), (req, res) => {
  const table = getTable('chat_messages');
  const { channel_id, limit, before } = req.query;
  let messages = table.all();
  if (channel_id) {
    messages = messages.filter(m => m.channel_id === Number(channel_id));
  }
  messages.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  if (before) {
    const idx = messages.findIndex(m => m.id === Number(before));
    if (idx > 0) messages = messages.slice(Math.max(0, idx - 50), idx);
  }
  if (limit) {
    const n = Number(limit) || 50;
    messages = messages.slice(-n);
  }
  res.json(messages);
});

router.post('/messages', requirePerm('ai:view'), (req, res) => {
  const table = getTable('chat_messages');
  const { channel_id, sender, content, msg_type, metadata } = req.body;
  if (!channel_id || !sender || !content) {
    return res.status(400).json({ error: '频道、发送者和内容为必填项' });
  }
  const record = {
    channel_id: Number(channel_id),
    sender,
    content,
    msg_type: msg_type || 'text',
    metadata: metadata ? JSON.stringify(metadata) : '',
    created_at: now()
  };
  const result = table.insert(record);
  const chTable = getTable('chat_channels');
  chTable.update(channel_id, { updated_at: now() });
  res.json({ ...record, id: result.lastID });
});

// ===== AI 对话 =====
router.post('/ai-chat', requirePerm('ai:view'), async (req, res) => {
  const { message, user, context_type, context_id, history } = req.body;
  if (!message) return res.status(400).json({ error: '消息内容为必填项' });

  const businessContext = buildBusinessContext(context_type, context_id, message);
  const systemPrompt = buildSystemPrompt(businessContext, user);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || []).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  const settingsTable = getTable('settings');
  const settings = settingsTable.all();
  const aiSetting = settings.find(s => s.key === 'ai_api_config');
  let apiKey = '', apiBase = 'https://api.openai.com/v1', model = 'gpt-4o-mini';

  if (aiSetting) {
    try {
      const cfg = JSON.parse(aiSetting.value);
      apiKey = cfg.apiKey || '';
      apiBase = cfg.apiBase || apiBase;
      model = cfg.model || model;
    } catch(e) {}
  }

  if (!apiKey) {
    const aiResponse = generateLocalResponse(message, businessContext, user);
    const actionItems = extractActionItems(aiResponse);
    saveAiMessage(user, message, aiResponse, actionItems, context_type, context_id);
    return res.json({ reply: aiResponse, action_items: actionItems, model: 'local' });
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 2000
      })
    });
    const data = await response.json();
    if (data.error) {
      logger.error('AI API Error:', data.error);
      const fallback = generateLocalResponse(message, businessContext, user);
      return res.json({ reply: fallback, action_items: [], model: 'fallback', error: data.error.message });
    }
    const aiReply = data.choices?.[0]?.message?.content || '抱歉，无法生成回复。';
    const actionItems = extractActionItems(aiReply);
    saveAiMessage(user, message, aiReply, actionItems, context_type, context_id);
    res.json({ reply: aiReply, action_items, model });
  } catch(err) {
    logger.error('AI API fetch error:', err.message);
    const fallback = generateLocalResponse(message, businessContext, user);
    res.json({ reply: fallback, action_items: [], model: 'fallback', error: err.message });
  }
});

function saveAiMessage(user, userMsg, aiReply, actionItems, contextType, contextId) {
  const table = getTable('chat_messages');
  const ctxTable = getTable('chat_ai_context');
  const record = {
    channel_id: 0,
    sender: user,
    content: userMsg,
    msg_type: 'ai_chat',
    metadata: JSON.stringify({ ai_reply: aiReply, context_type: contextType, context_id: contextId }),
    created_at: now()
  };
  table.insert(record);

  ctxTable.insert({
    user,
    question: userMsg,
    answer: aiReply,
    context_type: contextType || '',
    context_id: contextId ? Number(contextId) : null,
    action_items: actionItems.length > 0 ? JSON.stringify(actionItems) : '',
    created_at: now()
  });

  if (actionItems.length > 0) {
    const actionTable = getTable('chat_action_items');
    actionItems.forEach(item => {
      actionTable.insert({
        content: item.content,
        assignee: item.assignee || '',
        priority: item.priority || 'medium',
        source: 'ai_chat',
        source_id: null,
        status: 'pending',
        created_by: user,
        created_at: now(),
        updated_at: now()
      });
    });
  }
}

function buildBusinessContext(contextType, contextId, message) {
  const parts = [];
  try {
    // 近期聊天历史上下文
    try {
      const chatTable = getTable('chat_messages');
      const recentMsgs = chatTable.all().filter(m => m.msg_type === 'ai_chat').slice(-10);
      if (recentMsgs.length > 0) {
        const topics = recentMsgs.map(m => {
          const c = (m.content || '').substring(0, 40);
          return c;
        }).join(' | ');
        parts.push(`近期讨论话题: ${topics}`);
      }
    } catch(e) {}

    // 当前实体上下文
    if (contextType === 'inquiry' && contextId) {
      const table = getTable('inquiries');
      const inq = table.findById(contextId);
      if (inq) {
        parts.push(`当前询价单: 单号${inq.serial_number}, 客户${inq.customer_name}, 产品${inq.external_model || inq.product_name}, 状态${inq.status}, 数量${inq.quantity}, 目标价${inq.target_price}`);
        if (inq.final_price) parts.push(`最终报价: ${inq.final_price}`);
      }
      const related = table.all().filter(i => i.customer_name === inq?.customer_name && i.id !== inq?.id);
      if (related.length > 0) parts.push(`该客户还有 ${related.length} 条询价记录`);
    }
    if (contextType === 'customer' && contextId) {
      const table = getTable('customers');
      const cust = table.findById(contextId);
      if (cust) {
        parts.push(`当前客户: ${cust.name}, 来源${cust.source}, 联系人${cust.contact || '未知'}`);
        const inqTable = getTable('inquiries');
        const inqs = inqTable.all().filter(i => i.customer_name === cust.name);
        parts.push(`该客户有 ${inqs.length} 条询价记录`);
        const projTable = getTable('projects');
        const projs = projTable.all().filter(p => p.customer_name === cust.name);
        if (projs.length > 0) parts.push(`该客户有 ${projs.length} 个研发项目`);
      }
    }
    if (contextType === 'pricing' && contextId) {
      const table = getTable('bom_pricing');
      const pricing = table.findById(contextId);
      if (pricing) parts.push(`当前核价: 型号${pricing.model}, 客户${pricing.customer}, 总成本${pricing.total_cost || '未填'}, 最低价${pricing.min_price || '未填'}`);
    }
    if (contextType === 'project' && contextId) {
      const table = getTable('projects');
      const proj = table.findById(contextId);
      if (proj) {
        parts.push(`当前项目: ${proj.project_no||''} ${proj.project_name||''}, 客户${proj.customer_name||''}, 负责人${proj.owner||''}, 阶段${proj.current_stage||''}, 状态${proj.status||''}`);
        const progTable = getTable('rd_project_progress');
        progTable._invalidate();
        const prog = progTable.all().find(p => p.project_id === proj.id);
        if (prog) {
          const done = ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','mold','mold_sample','packaging','elec_trial','rd_trial','eng_trial','prod_trial','test_report','tech_transfer','shipment','review','other'].filter(k => prog[k]==='V'||prog[k]==='√').length;
          parts.push(`技转节点: ${done}/18 已完成`);
        }
      }
    }

    // 全系统数据概览
    const msg = (message || '').toLowerCase();

    // 询价相关
    if (msg.includes('询价') || msg.includes('报价') || msg.includes('客户') || msg.includes('销售')) {
      const inqTable = getTable('inquiries');
      const all = inqTable.all();
      const statusCount = {};
      all.forEach(i => { statusCount[i.status] = (statusCount[i.status] || 0) + 1; });
      parts.push(`询价统计: 总计${all.length}条, ${Object.entries(statusCount).map(([k,v]) => `${k}:${v}`).join(', ')}`);
      const now7 = new Date(Date.now() + 8*3600000 - 7*86400000).toISOString().replace('T',' ').substring(0,19);
      const recent = all.filter(i => i.created_at && i.created_at > now7);
      parts.push(`近7天新增: ${recent.length}条`);
      const lostRecent = all.filter(i => i.status === 'lost' && i.created_at > now7);
      if (lostRecent.length > 0) parts.push(`近7天流失: ${lostRecent.length}条`);
      const closedTotal = all.filter(i => i.status === 'closed');
      const closedAmount = closedTotal.reduce((s,i) => s + (Number(i.final_price)||0)*(Number(i.quantity)||1), 0);
      parts.push(`成交金额: ¥${Math.round(closedAmount).toLocaleString()}`);
    }

    // 核价/成本相关
    if (msg.includes('核价') || msg.includes('成本') || msg.includes('bom')) {
      const pTable = getTable('bom_pricing');
      const all = pTable.all();
      const noPrice = all.filter(p => !p.total_cost);
      parts.push(`核价统计: 总计${all.length}条, 未完成${noPrice.length}条`);
    }

    // 项目相关 - 新增
    if (msg.includes('项目') || msg.includes('研发') || msg.includes('进度')) {
      const projTable = getTable('projects');
      projTable._invalidate();
      const all = projTable.all();
      const byStatus = {};
      all.forEach(p => { const s = p.status || 'init'; byStatus[s] = (byStatus[s]||0) + 1; });
      const stMap = {init:'预项目',executing:'进行中',completed:'已完成',paused:'暂停',cancelled:'取消'};
      parts.push(`研发项目统计: 总计${all.length}个, ${Object.entries(byStatus).map(([k,v]) => (stMap[k]||k)+':'+v+'个').join(', ')}`);
      const executing = all.filter(p => p.status === 'executing');
      if (executing.length > 0) {
        parts.push(`进行中项目: ${executing.slice(0,5).map(p => (p.project_no||'')+' '+(p.project_name||'').substring(0,10)).join(', ')}`);
      }
      const overdue = all.filter(p => p.target_date && p.target_date < new Date().toISOString().substring(0,10) && p.status === 'executing');
      if (overdue.length > 0) parts.push(`超期项目: ${overdue.length}个`);
    }

    // 订单相关 - 新增
    if (msg.includes('订单') || msg.includes('出货') || msg.includes('发货')) {
      const ordTable = getTable('orders');
      const all = ordTable.all();
      const byStatus = {};
      all.forEach(o => { byStatus[o.status||'unknown'] = (byStatus[o.status||'unknown']||0) + 1; });
      parts.push(`订单统计: 总计${all.length}条, ${Object.entries(byStatus).map(([k,v])=>`${k}:${v}`).join(', ')}`);
      const openOrders = all.filter(o => o.status === 'open' || o.status === 'confirmed');
      if (openOrders.length > 0) parts.push(`待处理订单: ${openOrders.length}条`);
    }

    // 样品相关 - 新增
    if (msg.includes('样品') || msg.includes('打样')) {
      const sampleTable = getTable('samples');
      const all = sampleTable.all();
      const byStatus = {};
      all.forEach(s => { byStatus[s.status||'unknown'] = (byStatus[s.status||'unknown']||0) + 1; });
      parts.push(`样品统计: 总计${all.length}条, ${Object.entries(byStatus).map(([k,v])=>`${k}:${v}`).join(', ')}`);
    }

    // 物料相关 - 新增
    if (msg.includes('物料') || msg.includes('库存') || msg.includes('采购')) {
      const matTable = getTable('materials');
      const all = matTable.all();
      parts.push(`物料统计: 总计${all.length}种, ${all.filter(m=>m.status==='normal').length}种正常`);
      const lowStock = all.filter(m => m.inventory_qty !== undefined && m.min_inventory !== undefined && Number(m.inventory_qty) <= Number(m.min_inventory));
      if (lowStock.length > 0) parts.push(`库存预警: ${lowStock.length}种物料低于最低库存`);
    }

    // 供应商相关 - 新增
    if (msg.includes('供应商') || msg.includes('采购')) {
      const supTable = getTable('suppliers');
      const all = supTable.all();
      const cooperating = all.filter(s => s.lifecycle_status === 'cooperating');
      parts.push(`供应商统计: 总计${all.length}家, 合作中${cooperating.length}家`);
    }

    // 问题反馈 - 新增
    if (msg.includes('问题') || msg.includes('反馈') || msg.includes('bug')) {
      const fbTable = getTable('feedback');
      const all = fbTable.all();
      const open = all.filter(f => f.status === 'open' || f.status === 'processing');
      parts.push(`问题反馈: 总计${all.length}条, 待处理${open.length}条`);
    }

    // 型号查询
    const modelCtx = message.match(/[A-Za-z0-9]+-[A-Za-z0-9-]+/);
    if (modelCtx && modelCtx[0].length >= 6) {
      const sm = modelCtx[0].toUpperCase();
      const quoteTable = getTable('quote_library');
      const qMatches = quoteTable.all().filter(q => (q.external_model || '').toUpperCase().includes(sm));
      if (qMatches.length > 0) {
        parts.push(`报价库(${qMatches.length}条): ` + qMatches.slice(0,3).map(q =>
          `${q.external_model} RMB:${q.price_rmb||'?'} USD:${q.price_usd||'?'} 限价:${q.min_price||'?'}`
        ).join('; '));
      }
      const pTable2 = getTable('bom_pricing');
      const pMatches = pTable2.all().filter(p => (p.model || '').toUpperCase().includes(sm));
      if (pMatches.length > 0) {
        parts.push(`核价库(${pMatches.length}条): ` + pMatches.slice(0,3).map(p =>
          `${p.model} 成本:${p.total_cost||'?'} RMB:${p.price_rmb||'?'}`
        ).join('; '));
      }
    }

    // 总览模式：提供全系统概览
    if (msg.includes('总览') || msg.includes('概况') || msg.includes('统计') || msg.includes('数据')) {
      const tables = {
        '询价单': () => getTable('inquiries').all().length,
        '客户': () => getTable('customers').all().length,
        '产品': () => getTable('products').all().length,
        '物料': () => getTable('materials').all().length,
        '供应商': () => getTable('suppliers').all().length,
        '订单': () => getTable('orders').all().length,
        '样品': () => getTable('samples').all().length,
        '研发项目': () => { const t = getTable('projects'); t._invalidate(); return t.all().length; },
        '核价记录': () => getTable('bom_pricing').all().length,
        '报价记录': () => getTable('quote_library').all().length,
        '问题反馈': () => getTable('feedback').all().length,
        '学习记录': () => getTable('ai_learning_records').all().length,
        '待办行动': () => getTable('ai_actions').all().length
      };
      parts.push('系统数据总览:\n' + Object.entries(tables).map(([k,fn]) => {
        try { return `  ${k}: ${fn()}条`; } catch(e) { return `  ${k}: 读取失败`; }
      }).join('\n'));
    }

    // 客户名匹配 - 新增跨表查询
    const custNameMatch = message.match(/(?:客户|关于)\s*['"']?(\S{2,10})['"']?/);
    if (custNameMatch) {
      const cn = custNameMatch[1];
      const cTable = getTable('customers');
      const cust = cTable.all().find(c => (c.name||'').includes(cn));
      if (cust) {
        const inqs = getTable('inquiries').all().filter(i => i.customer_name === cust.name);
        const projs = getTable('projects').all().filter(p => p.customer_name === cust.name);
        parts.push(`客户"${cust.name}": 询价${inqs.length}条, 项目${projs.length}个, 等级${cust.customer_level||'未知'}, 状态${cust.customer_status||'未知'}`);
      }
    }
  } catch(e) { logger.error('构建业务上下文失败:', e.message); }
  return parts.join('\n');
}

function buildSystemPrompt(context, user) {
  let prompt = `你是企业经营管理平台（EBMS）的AI助手，帮助销售团队分析业务数据、解决问题、制定策略。

你的能力：
1. 查询和分析询价、核价、客户、产品数据
2. 查询和分析研发项目、项目进度、供应链异常
3. 查询和分析订单、样品、物料、供应商数据
4. 跨表关联分析（如客户的项目+询价+订单全貌）
5. 提供销售策略建议和报价建议
6. 识别业务风险和机会
7. 生成待办行动项（用【行动】标记）
8. 回答业务流程和操作问题
9. 提供系统数据总览

回复要求：
- 用中文回复
- 简洁专业，重点突出
- 如果有具体行动建议，用【行动】标记，格式如：【行动】@负责人 优先级 行动内容
- 优先级用：高/中/低
- 数据驱动，基于实际系统数据回答

当前用户: ${user || '未知'}`;
  if (context) {
    prompt += `\n\n当前业务上下文:\n${context}`;
  }
  return prompt;
}

function generateLocalResponse(message, context, user) {
  const msg = message;
  const hasKeyword = (keywords) => keywords.some(k => msg.includes(k));

  if (hasKeyword(['询价'])) {
    let reply = '根据系统数据分析：\n\n';
    try {
      const inqTable = getTable('inquiries');
      const all = inqTable.all();
      const statusMap = {};
      all.forEach(i => { statusMap[i.status] = (statusMap[i.status] || 0) + 1; });
      reply += `📊 询价单状态分布：\n`;
      const statusNames = {
        'new':'新建','cert_configured':'证书已选型','config_generated':'配置表已生成',
        'pending_pricing':'待核价','pending_quote':'待报价','quoted':'已报价',
        'negotiating':'洽谈中','sample':'转样品','project':'转项目',
        'lost':'已流失','closed':'已成交'
      };
      Object.entries(statusMap).forEach(([k,v]) => { reply += `  - ${statusNames[k]||k}: ${v}条\n`; });
      reply += `\n总计 ${all.length} 条询价单`;
      const recent = all.filter(i => {
        const d = i.created_at || '';
        return d > new Date(Date.now() + 8*3600000 - 7*86400000).toISOString().replace('T',' ').substring(0,19);
      });
      if (recent.length > 0) reply += `\n近7天新增: ${recent.length}条`;
      const pending = all.filter(i => i.status === 'new' || i.status === 'pending_pricing' || i.status === 'pending_quote');
      if (pending.length > 0) {
        reply += `\n\n⚠️ 有 ${pending.length} 条询价单待处理`;
        reply += `\n【行动】@${user || '销售'} 高 优先处理待处理询价单`;
      }
      const quoted = all.filter(i => i.status === 'quoted' || i.status === 'negotiating');
      if (quoted.length > 0) {
        reply += `\n\n💡 有 ${quoted.length} 条已报价/洽谈中，建议及时跟进`;
        reply += `\n【行动】@${user || '销售'} 中 跟进已报价客户`;
      }
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  if (hasKeyword(['核价', '成本', 'BOM', 'bom'])) {
    let reply = '核价数据分析：\n\n';
    try {
      const pTable = getTable('bom_pricing');
      const all = pTable.all();
      const noPrice = all.filter(p => !p.total_cost);
      const hasPrice = all.filter(p => p.total_cost);
      reply += `📊 核价统计：\n  - 总计: ${all.length}条\n  - 已完成: ${hasPrice.length}条\n  - 待核价: ${noPrice.length}条\n`;
      if (noPrice.length > 0) {
        reply += `\n⚠️ 有 ${noPrice.length} 条核价待完成`;
        const models = noPrice.slice(0,5).map(p => p.model).join(', ');
        reply += `\n待核价型号: ${models}`;
        reply += `\n【行动】@采购 高 尽快完成待核价项目`;
      }
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  if (hasKeyword(['客户'])) {
    let reply = '客户数据分析：\n\n';
    try {
      const cTable = getTable('customers');
      const inqTable = getTable('inquiries');
      const customers = cTable.all();
      reply += `📊 客户总数: ${customers.length}\n\n`;
      const topCustomers = [];
      customers.forEach(c => {
        const count = inqTable.all().filter(i => i.customer_name === c.name).length;
        if (count > 0) topCustomers.push({ name: c.name, count });
      });
      topCustomers.sort((a,b) => b.count - a.count);
      if (topCustomers.length > 0) {
        reply += `🏆 询价最多的客户：\n`;
        topCustomers.slice(0,5).forEach((c,i) => { reply += `  ${i+1}. ${c.name}: ${c.count}条询价\n`; });
      }
      const noInquiry = customers.filter(c => !topCustomers.find(t => t.name === c.name));
      if (noInquiry.length > 0) {
        reply += `\n💡 有 ${noInquiry.length} 个客户暂无询价记录，建议主动跟进`;
        reply += `\n【行动】@${user || '销售'} 中 主动联系无询价客户`;
      }
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  if (hasKeyword(['产品', '型号'])) {
    let reply = '产品数据分析：\n\n';
    try {
      const pTable = getTable('products');
      const products = pTable.all();
      reply += `📊 产品总数: ${products.length}\n`;
      const categories = {};
      products.forEach(p => { const c = p.category || '未分类'; categories[c] = (categories[c]||0)+1; });
      Object.entries(categories).forEach(([k,v]) => { reply += `  - ${k}: ${v}个\n`; });
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  const modelPattern = /[A-Za-z0-9]+-[A-Za-z0-9-]+/;
  const modelMatch = msg.match(modelPattern);
  if (modelMatch && (hasKeyword(['价格', '报价', '多少钱', '单价', '限价', '核价', 'RMB', 'USD', 'rmb', 'usd']) || modelMatch[0].length >= 8)) {
    const searchModel = modelMatch[0].toUpperCase();
    let reply = '';
    try {
      const quoteTable = getTable('quote_library');
      const quotes = quoteTable.all().filter(q => (q.external_model || '').toUpperCase().includes(searchModel));
      const pTable = getTable('bom_pricing');
      const pricings = pTable.all().filter(p => (p.model || '').toUpperCase().includes(searchModel));

      if (quotes.length > 0) {
        reply += `📊 报价库中找到 ${quotes.length} 条匹配记录：\n\n`;
        quotes.forEach((q, i) => {
          reply += `${i+1}. 型号: ${q.external_model}\n`;
          if (q.product_name) reply += `   产品: ${q.product_name}\n`;
          if (q.power) reply += `   功率: ${q.power}\n`;
          if (q.certificate_level) reply += `   证书: ${q.certificate_level}\n`;
          if (q.price_rmb) reply += `   💰 单价(RMB): ¥${q.price_rmb}\n`;
          if (q.price_usd) reply += `   💲 单价(USD): $${q.price_usd}\n`;
          if (q.min_price) reply += `   ⚠️ 最低限价: ¥${q.min_price}\n`;
          if (q.validity_days) reply += `   有效期: ${q.validity_days}天\n`;
          if (q.creator) reply += `   创建人: ${q.creator}\n`;
          reply += '\n';
        });
      }

      if (pricings.length > 0) {
        reply += `📋 核价库中找到 ${pricings.length} 条匹配记录：\n\n`;
        pricings.slice(0, 5).forEach((p, i) => {
          reply += `${i+1}. 型号: ${p.model}\n`;
          if (p.customer) reply += `   客户: ${p.customer}\n`;
          if (p.total_cost) reply += `   总成本: ¥${p.total_cost}\n`;
          if (p.price_rmb) reply += `   💰 核价(RMB): ¥${p.price_rmb}\n`;
          if (p.price_usd) reply += `   💲 核价(USD): $${p.price_usd}\n`;
          if (p.min_price) reply += `   ⚠️ 最低限价: ¥${p.min_price}\n`;
          if (p.pricer) reply += `   核价人: ${p.pricer}\n`;
          reply += '\n';
        });
        if (pricings.length > 5) reply += `   ...还有 ${pricings.length - 5} 条记录\n`;
      }

      if (!reply) {
        reply = `未找到型号包含"${searchModel}"的记录。\n\n你可以前往报价库或核价库页面查看更多数据。`;
      }
    } catch(e) { reply = '查询失败，请稍后重试'; }
    return reply;
  }

  // 项目相关查询
  if (hasKeyword(['项目', '研发', '进度', '技转'])) {
    let reply = '研发项目分析：\n\n';
    try {
      const pTable = getTable('projects');
      pTable._invalidate();
      const all = pTable.all();
      const byStatus = {};
      all.forEach(p => { const s = p.status || 'init'; byStatus[s] = (byStatus[s]||0) + 1; });
      const stMap = {init:'预项目',executing:'进行中',completed:'已完成',paused:'暂停',cancelled:'取消'};
      reply += `📊 项目总数: ${all.length}个\n`;
      Object.entries(byStatus).forEach(([k,v]) => { reply += `  - ${stMap[k]||k}: ${v}个\n`; });
      const executing = all.filter(p => p.status === 'executing');
      if (executing.length > 0) {
        reply += `\n🔄 进行中项目 (${executing.length}个):\n`;
        executing.slice(0,8).forEach(p => {
          reply += `  ${p.project_no||''} ${(p.project_name||'').substring(0,16)} [${p.current_stage||'?'}] 负责人:${p.owner||'?'}\n`;
        });
      }
      const overdue = all.filter(p => p.target_date && p.target_date < new Date().toISOString().substring(0,10) && p.status === 'executing');
      if (overdue.length > 0) {
        reply += `\n⚠️ 超期项目: ${overdue.length}个\n`;
        reply += `【行动】@负责人 高 跟进超期研发项目`;
      }
      const issueTable = getTable('rd_supply_issues');
      issueTable._invalidate();
      const openIssues = issueTable.all().filter(i => i.closed !== 1);
      if (openIssues.length > 0) reply += `\n⚠️ 未闭环品质异常: ${openIssues.length}个`;
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  // 订单相关查询
  if (hasKeyword(['订单', '出货', '发货', '交付'])) {
    let reply = '订单分析：\n\n';
    try {
      const oTable = getTable('orders');
      const all = oTable.all();
      const byStatus = {};
      all.forEach(o => { byStatus[o.status||'unknown'] = (byStatus[o.status||'unknown']||0) + 1; });
      reply += `📊 订单总数: ${all.length}条\n`;
      Object.entries(byStatus).forEach(([k,v]) => { reply += `  - ${k}: ${v}条\n`; });
      const open = all.filter(o => o.status === 'open' || o.status === 'confirmed');
      if (open.length > 0) {
        reply += `\n⚠️ 待处理: ${open.length}条`;
        reply += `\n【行动】@销售 高 处理待确认订单`;
      }
      const totalAmount = all.reduce((s,o) => s + (Number(o.order_amount)||0), 0);
      reply += `\n💰 订单总额: ¥${Math.round(totalAmount).toLocaleString()}`;
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  // 样品相关查询
  if (hasKeyword(['样品', '打样', '送样'])) {
    let reply = '样品分析：\n\n';
    try {
      const sTable = getTable('samples');
      const all = sTable.all();
      const byStatus = {};
      all.forEach(s => { byStatus[s.status||'?'] = (byStatus[s.status||'?']||0) + 1; });
      reply += `📊 样品总数: ${all.length}条\n`;
      Object.entries(byStatus).forEach(([k,v]) => { reply += `  - ${k}: ${v}条\n`; });
      const pending = all.filter(s => s.status === 'pending' || s.status === 'confirmed' || s.status === 'producing');
      if (pending.length > 0) {
        reply += `\n⚠️ 待完成: ${pending.length}条`;
        reply += `\n【行动】@生产 中 跟进样品进度`;
      }
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  // 物料和库存查询
  if (hasKeyword(['物料', '库存', '采购', '材料'])) {
    let reply = '物料分析：\n\n';
    try {
      const mTable = getTable('materials');
      const all = mTable.all();
      reply += `📊 物料总数: ${all.length}种\n`;
      const byStatus = {};
      all.forEach(m => { byStatus[m.status||'?'] = (byStatus[m.status||'?']||0) + 1; });
      Object.entries(byStatus).forEach(([k,v]) => { reply += `  - ${k}: ${v}种\n`; });
      const lowStock = all.filter(m => m.inventory_qty !== undefined && m.min_inventory !== undefined && Number(m.inventory_qty) <= Number(m.min_inventory));
      if (lowStock.length > 0) {
        reply += `\n⚠️ 库存预警: ${lowStock.length}种低于最低库存`;
        lowStock.slice(0,5).forEach(m => { reply += `\n  ${m.material_name||m.material_code}: 库存${m.inventory_qty||0}/${m.min_inventory||0}`; });
        reply += `\n【行动】@采购 高 补充库存不足物料`;
      }
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  // 供应商查询
  if (hasKeyword(['供应商', '供应'])) {
    let reply = '供应商分析：\n\n';
    try {
      const sTable = getTable('suppliers');
      const all = sTable.all();
      const coop = all.filter(s => s.lifecycle_status === 'cooperating');
      reply += `📊 供应商总数: ${all.length}家, 合作中: ${coop.length}家\n`;
      const byLevel = {};
      all.forEach(s => { byLevel[s.level||'?'] = (byLevel[s.level||'?']||0) + 1; });
      Object.entries(byLevel).forEach(([k,v]) => { reply += `  - ${k}: ${v}家\n`; });
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  // 问题反馈查询
  if (hasKeyword(['问题', '反馈', '建议', 'bug', 'Bug'])) {
    let reply = '问题反馈分析：\n\n';
    try {
      const fbTable = getTable('feedback');
      const all = fbTable.all();
      const open = all.filter(f => f.status === 'open' || f.status === 'processing');
      reply += `📊 反馈总数: ${all.length}条, 待处理: ${open.length}条\n`;
      if (open.length > 0) {
        reply += `\n待处理问题:\n`;
        open.slice(0,5).forEach(f => { reply += `  ${f.id}. ${(f.title||'').substring(0,30)} [${f.priority||'?'}]\n`; });
        reply += `\n【行动】@管理员 中 处理待解决问题反馈`;
      }
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  // 总览/概况
  if (hasKeyword(['总览', '概况', '概览', '整体', '系统'])) {
    let reply = '系统数据总览：\n\n';
    try {
      const tables = {
        '询价单': () => getTable('inquiries').all().length,
        '客户': () => getTable('customers').all().length,
        '产品': () => getTable('products').all().length,
        '物料': () => getTable('materials').all().length,
        '供应商': () => getTable('suppliers').all().length,
        '订单': () => getTable('orders').all().length,
        '样品': () => getTable('samples').all().length,
        '研发项目': () => { const t = getTable('projects'); t._invalidate(); return t.all().length; },
        '核价记录': () => getTable('bom_pricing').all().length,
        '报价记录': () => getTable('quote_library').all().length,
        '问题反馈': () => getTable('feedback').all().length,
        '待办行动': () => getTable('ai_actions').all().length
      };
      Object.entries(tables).forEach(([k,fn]) => {
        try { reply += `  ${k}: ${fn()}条\n`; } catch(e) { reply += `  ${k}: -\n`; }
      });
      reply += `\n💡 输入具体模块名称获取详细分析（如"项目""订单""物料"等）`;
    } catch(e) { reply += '暂无法获取数据'; }
    return reply;
  }

  if (hasKeyword(['帮助', '你能做什么', '功能', 'help'])) {
    return `我是企业经营管理平台（EBMS）AI助手，可以帮你：

📋 数据查询 - 询价、核价、客户、产品、项目、订单、样品、物料、供应商
🔍 型号查询 - 输入型号查价格，如"JFS04B-B1WA100价格"
📊 数据分析 - 各模块状态分布、趋势、关键指标
🏗️ 项目管理 - 研发项目进度、技转节点、品质异常
📦 订单管理 - 订单状态、交付跟踪
🧪 样品跟踪 - 打样进度
📦 物料库存 - 库存预警、采购建议
🏭 供应商 - 供应商统计与合作状态
💡 策略建议 - 报价策略、客户跟进建议
⚠️ 风险预警 - 识别逾期、滞留、库存不足
📝 待办生成 - 自动提取行动项
📈 系统总览 - 输入"总览"查看全局数据

你可以问我：
- "项目进度如何"
- "订单情况"
- "物料库存"
- "总览"
- "JFS04B-B1WA100价格"
- "帮助"`;
  }

  if (context) {
    return `我已了解当前业务上下文。\n\n关于你的问题"${message}"：\n\n基于当前数据分析，建议你：\n1. 检查相关业务数据的完整性\n2. 关注关键时间节点\n3. 及时跟进待处理事项\n\n如需更详细的分析，请提供更具体的问题描述。\n\n【行动】@${user || '销售'} 中 跟进当前业务事项`;
  }

  return `你好！我是企业经营管理平台（EBMS）AI助手。\n\n你可以问我关于询价、核价、客户、产品等业务问题，我会自动分析数据并提供建议。\n\n输入"帮助"查看我能做什么。`;
}

function extractActionItems(reply) {
  const items = [];
  const regex = /【行动】@?([^\s]*)\s*(高|中|低)?\s*(.+)/g;
  let match;
  while ((match = regex.exec(reply)) !== null) {
    items.push({
      assignee: match[1] || '',
      priority: match[2] || '中',
      content: match[3].trim()
    });
  }
  return items;
}

// ===== 待办行动 =====
router.get('/action-items', requirePerm('ai:view'), (req, res) => {
  const table = getTable('chat_action_items');
  const { status, assignee, created_by } = req.query;
  let items = table.all();
  if (status) items = items.filter(i => i.status === status);
  if (assignee) items = items.filter(i => i.assignee === assignee || i.created_by === assignee);
  if (created_by) items = items.filter(i => i.created_by === created_by);
  items.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(items);
});

router.put('/action-items/:id', requirePerm('ai:view'), (req, res) => {
  const table = getTable('chat_action_items');
  const fields = { updated_at: now() };
  ['status', 'assignee', 'priority', 'content'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '待办更新成功' });
});

// ===== AI 对话历史 =====
router.get('/ai-history', requirePerm('ai:view'), (req, res) => {
  const table = getTable('chat_ai_context');
  const { user, limit } = req.query;
  let records = table.all();
  if (user) records = records.filter(r => r.user === user);
  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  if (limit) records = records.slice(0, Number(limit));
  res.json(records);
});

// ===== 在线用户 =====
router.get('/online-users', requirePerm('ai:view'), (req, res) => {
  const table = getTable('users');
  const users = table.all().map(u => ({
    id: u.id,
    username: u.username,
    display_name: u.display_name || u.username,
    role: u.role,
    avatar: u.avatar || ''
  }));
  res.json(users);
});

module.exports = router;
