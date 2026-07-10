const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('ai_learning_records');
ensureTable('ai_summaries');
ensureTable('ai_plans');
ensureTable('ai_reviews');
ensureTable('ai_solutions');
ensureTable('ai_actions');

// ===== 自我学习 =====
router.post('/learn', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_learning_records');
  const { user, question, answer, category, tags, feedback, context_type, context_id } = req.body;
  if (!question) return res.status(400).json({ error: '问题内容为必填项' });

  const existing = table.all().find(r =>
    r.question && r.question.trim().toLowerCase() === question.trim().toLowerCase()
  );

  if (existing) {
    const updateFields = { updated_at: now() };
    if (answer) updateFields.answer = answer;
    if (category) updateFields.category = category;
    if (tags) updateFields.tags = tags;
    if (feedback) updateFields.feedback = feedback;
    updateFields.hit_count = (existing.hit_count || 0) + 1;
    table.update(existing.id, updateFields);
    return res.json({ message: '学习记录已更新', id: existing.id, hit_count: updateFields.hit_count });
  }

  const record = {
    user: user || 'system',
    question,
    answer: answer || '',
    category: category || 'general',
    tags: tags || '',
    feedback: feedback || '',
    context_type: context_type || '',
    context_id: context_id ? Number(context_id) : null,
    hit_count: 1,
    created_at: now(),
    updated_at: now()
  };
  const result = table.insert(record);
  res.json({ message: '学习记录已创建', id: result.lastID });
});

router.get('/learn', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_learning_records');
  const { category, user, keyword, limit } = req.query;
  let records = table.all();
  if (category) records = records.filter(r => r.category === category);
  if (user) records = records.filter(r => r.user === user);
  if (keyword) {
    const kw = keyword.toLowerCase();
    records = records.filter(r =>
      (r.question || '').toLowerCase().includes(kw) ||
      (r.answer || '').toLowerCase().includes(kw) ||
      (r.tags || '').toLowerCase().includes(kw)
    );
  }
  records.sort((a, b) => (b.hit_count || 0) - (a.hit_count || 0));
  if (limit) records = records.slice(0, Number(limit));
  res.json(records);
});

router.get('/learn/search', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_learning_records');
  const { q } = req.query;
  if (!q) return res.json([]);
  const keyword = q.toLowerCase();
  const records = table.all().filter(r =>
    (r.question || '').toLowerCase().includes(keyword) ||
    (r.answer || '').toLowerCase().includes(keyword) ||
    (r.tags || '').toLowerCase().includes(keyword)
  );
  records.sort((a, b) => (b.hit_count || 0) - (a.hit_count || 0));
  res.json(records.slice(0, 10));
});

router.delete('/learn/:id', requirePerm('ai:delete'), (req, res) => {
  const table = getTable('ai_learning_records');
  table.delete(req.params.id);
  res.json({ message: '学习记录已删除' });
});

// ===== 总结 =====
router.post('/summary', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_summaries');
  const { user, title, content, summary_type, source_type, source_id, date_range_start, date_range_end } = req.body;
  if (!content) return res.status(400).json({ error: '总结内容为必填项' });

  const record = {
    user: user || 'system',
    title: title || '',
    content,
    summary_type: summary_type || 'daily',
    source_type: source_type || '',
    source_id: source_id ? Number(source_id) : null,
    date_range_start: date_range_start || '',
    date_range_end: date_range_end || '',
    created_at: now(),
    updated_at: now()
  };
  const result = table.insert(record);
  res.json({ message: '总结已保存', id: result.lastID });
});

router.get('/summary', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_summaries');
  const { summary_type, user, start, end } = req.query;
  let records = table.all();
  if (summary_type) records = records.filter(r => r.summary_type === summary_type);
  if (user) records = records.filter(r => r.user === user);
  if (start) records = records.filter(r => r.date_range_start >= start);
  if (end) records = records.filter(r => r.date_range_end <= end);
  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(records);
});

router.get('/summary/generate', requirePerm('ai:view'), (req, res) => {
  const { type, start_date, end_date, user } = req.query;
  const summary = generateBusinessSummary(type || 'daily', start_date, end_date, user);
  res.json(summary);
});

function generateBusinessSummary(type, startDate, endDate, user) {
  const result = { type, period: `${startDate || '起始'} ~ ${endDate || '至今'}`, sections: [] };

  try {
    const inqTable = getTable('inquiries');
    const custTable = getTable('customers');
    const pricingTable = getTable('bom_pricing');
    const quoteTable = getTable('quote_library');

    let inquiries = inqTable.all();
    let customers = custTable.all();
    let pricings = pricingTable.all();
    let quotes = quoteTable.all();

    if (startDate) {
      inquiries = inquiries.filter(i => (i.created_at || '') >= startDate);
      customers = customers.filter(c => (c.created_at || '') >= startDate);
      pricings = pricings.filter(p => (p.created_at || '') >= startDate);
    }
    if (endDate) {
      inquiries = inquiries.filter(i => (i.created_at || '') <= endDate + ' 23:59:59');
      customers = customers.filter(c => (c.created_at || '') <= endDate + ' 23:59:59');
    }

    result.sections.push({
      title: '询价概况',
      data: {
        total: inquiries.length,
        by_status: countBy(inquiries, 'status'),
        by_source: countBy(inquiries, 'customer_source'),
        by_sales: countBy(inquiries, 'sales_person'),
        top_customers: getTopN(inquiries, 'customer_name', 5)
      }
    });

    result.sections.push({
      title: '客户概况',
      data: {
        total: customers.length,
        by_level: countBy(customers, 'customer_level'),
        by_source: countBy(customers, 'source'),
        by_country: countBy(customers, 'country_region')
      }
    });

    result.sections.push({
      title: '核价概况',
      data: {
        total: pricings.length,
        completed: pricings.filter(p => p.total_cost).length,
        pending: pricings.filter(p => !p.total_cost).length
      }
    });

    result.sections.push({
      title: '报价概况',
      data: {
        total: quotes.length,
        with_price: quotes.filter(q => q.price_rmb).length
      }
    });

    if (user) {
      const userInquiries = inquiries.filter(i => i.sales_person === user);
      result.sections.push({
        title: `${user} 个人概况`,
        data: {
          inquiry_count: userInquiries.length,
          by_status: countBy(userInquiries, 'status'),
          customers_served: [...new Set(userInquiries.map(i => i.customer_name))].length
        }
      });
    }
  } catch (e) {
    result.error = e.message;
  }

  return result;
}

// ===== 计划 =====
router.post('/plan', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_plans');
  const { user, title, plan_type, content, goals, milestones, start_date, end_date, priority } = req.body;
  if (!title) return res.status(400).json({ error: '计划标题为必填项' });

  const record = {
    user: user || 'system',
    title,
    plan_type: plan_type || 'weekly',
    content: content || '',
    goals: goals ? JSON.stringify(goals) : '',
    milestones: milestones ? JSON.stringify(milestones) : '',
    start_date: start_date || '',
    end_date: end_date || '',
    priority: priority || 'medium',
    status: 'active',
    progress: 0,
    created_at: now(),
    updated_at: now()
  };
  const result = table.insert(record);
  res.json({ message: '计划已创建', id: result.lastID });
});

router.get('/plan', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_plans');
  const { plan_type, status, user } = req.query;
  let records = table.all();
  if (plan_type) records = records.filter(r => r.plan_type === plan_type);
  if (status) records = records.filter(r => r.status === status);
  if (user) records = records.filter(r => r.user === user);
  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(records);
});

router.put('/plan/:id', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_plans');
  const fields = { updated_at: now() };
  ['title', 'content', 'goals', 'milestones', 'start_date', 'end_date', 'priority', 'status', 'progress'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  if (req.body.goals && typeof req.body.goals !== 'string') fields.goals = JSON.stringify(req.body.goals);
  if (req.body.milestones && typeof req.body.milestones !== 'string') fields.milestones = JSON.stringify(req.body.milestones);
  table.update(req.params.id, fields);
  res.json({ message: '计划已更新' });
});

router.delete('/plan/:id', requirePerm('ai:delete'), (req, res) => {
  const table = getTable('ai_plans');
  table.delete(req.params.id);
  res.json({ message: '计划已删除' });
});

// ===== 复盘分析 =====
router.post('/review', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_reviews');
  const { user, title, review_type, content, findings, root_causes, lessons, improvements } = req.body;
  if (!title) return res.status(400).json({ error: '复盘标题为必填项' });

  const record = {
    user: user || 'system',
    title,
    review_type: review_type || 'project',
    content: content || '',
    findings: findings ? JSON.stringify(findings) : '',
    root_causes: root_causes ? JSON.stringify(root_causes) : '',
    lessons: lessons ? JSON.stringify(lessons) : '',
    improvements: improvements ? JSON.stringify(improvements) : '',
    status: 'open',
    created_at: now(),
    updated_at: now()
  };
  const result = table.insert(record);
  res.json({ message: '复盘已创建', id: result.lastID });
});

router.get('/review', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_reviews');
  const { review_type, status, user } = req.query;
  let records = table.all();
  if (review_type) records = records.filter(r => r.review_type === review_type);
  if (status) records = records.filter(r => r.status === status);
  if (user) records = records.filter(r => r.user === user);
  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(records);
});

router.put('/review/:id', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_reviews');
  const fields = { updated_at: now() };
  ['title', 'content', 'findings', 'root_causes', 'lessons', 'improvements', 'status'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  if (req.body.findings && typeof req.body.findings !== 'string') fields.findings = JSON.stringify(req.body.findings);
  if (req.body.root_causes && typeof req.body.root_causes !== 'string') fields.root_causes = JSON.stringify(req.body.root_causes);
  if (req.body.lessons && typeof req.body.lessons !== 'string') fields.lessons = JSON.stringify(req.body.lessons);
  if (req.body.improvements && typeof req.body.improvements !== 'string') fields.improvements = JSON.stringify(req.body.improvements);
  table.update(req.params.id, fields);
  res.json({ message: '复盘已更新' });
});

router.get('/review/analyze', requirePerm('ai:view'), (req, res) => {
  const { type, inquiry_id, customer_name, start_date, end_date } = req.query;
  const analysis = performReviewAnalysis(type, inquiry_id, customer_name, start_date, end_date);
  res.json(analysis);
});

function performReviewAnalysis(type, inquiryId, customerName, startDate, endDate) {
  const result = { type, findings: [], root_causes: [], lessons: [], improvements: [], actions: [] };

  try {
    const inqTable = getTable('inquiries');
    const custTable = getTable('customers');
    let inquiries = inqTable.all();

    if (inquiryId) {
      const inq = inqTable.findById(Number(inquiryId));
      if (inq) {
        inquiries = [inq];
        result.title = `询价单 ${inq.serial_number} 复盘分析`;
      }
    }
    if (customerName) {
      inquiries = inquiries.filter(i => i.customer_name === customerName);
      result.title = `客户 ${customerName} 复盘分析`;
    }
    if (startDate) inquiries = inquiries.filter(i => (i.created_at || '') >= startDate);
    if (endDate) inquiries = inquiries.filter(i => (i.created_at || '') <= endDate + ' 23:59:59');

    const lost = inquiries.filter(i => i.status === 'lost');
    const closed = inquiries.filter(i => i.status === 'closed');
    const pending = inquiries.filter(i => ['new', 'pending_pricing', 'pending_quote'].includes(i.status));
    const longPending = pending.filter(i => {
      const created = new Date(i.created_at);
      const days = (Date.now() - created.getTime()) / 86400000;
      return days > 7;
    });

    if (lost.length > 0) {
      result.findings.push({ type: 'risk', content: `${lost.length}条询价已流失`, detail: lost.map(i => `${i.serial_number} - ${i.customer_name} - ${i.external_model || i.product_name}`).slice(0, 5) });
      result.root_causes.push({ type: 'price', content: '可能原因：报价偏高或响应速度慢', confidence: 'medium' });
      result.improvements.push({ type: 'process', content: '建立快速报价机制，缩短响应时间', priority: 'high' });
    }

    if (longPending.length > 0) {
      result.findings.push({ type: 'warning', content: `${longPending.length}条询价滞留超过7天`, detail: longPending.map(i => `${i.serial_number} - ${i.customer_name} - 滞留${Math.round((Date.now() - new Date(i.created_at).getTime()) / 86400000)}天`).slice(0, 5) });
      result.root_causes.push({ type: 'process', content: '可能原因：核价/报价流程卡点', confidence: 'high' });
      result.improvements.push({ type: 'process', content: '设定各环节SLA时限，超时自动提醒', priority: 'high' });
    }

    if (closed.length > 0) {
      result.findings.push({ type: 'success', content: `${closed.length}条询价已成交`, detail: closed.map(i => `${i.serial_number} - ${i.customer_name}`).slice(0, 5) });
      result.lessons.push({ type: 'best_practice', content: '分析成交客户特征，复制成功经验', confidence: 'high' });
    }

    const sourceStats = countBy(inquiries.filter(i => i.customer_source), 'customer_source');
    const topSource = Object.entries(sourceStats).sort((a, b) => b[1] - a[1])[0];
    if (topSource) {
      result.findings.push({ type: 'insight', content: `主要客户来源: ${topSource[0]} (${topSource[1]}条)`, detail: Object.entries(sourceStats).map(([k, v]) => `${k}: ${v}条`) });
      result.lessons.push({ type: 'channel', content: `加大${topSource[0]}渠道投入`, confidence: 'medium' });
    }

    const salesStats = countBy(inquiries, 'sales_person');
    Object.entries(salesStats).forEach(([sales, count]) => {
      const salesInqs = inquiries.filter(i => i.sales_person === sales);
      const salesClosed = salesInqs.filter(i => i.status === 'closed').length;
      const salesLost = salesInqs.filter(i => i.status === 'lost').length;
      if (count >= 3) {
        result.findings.push({ type: 'performance', content: `${sales}: ${count}条询价, 成交${salesClosed}, 流失${salesLost}`, detail: [] });
      }
    });

    result.actions = generateActionsFromReview(result);
  } catch (e) {
    result.error = e.message;
  }

  return result;
}

// ===== 方案制定 =====
router.post('/solution', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_solutions');
  const { user, title, problem, analysis, solution, steps, expected_outcome, priority, related_review_id } = req.body;
  if (!title) return res.status(400).json({ error: '方案标题为必填项' });

  const record = {
    user: user || 'system',
    title,
    problem: problem || '',
    analysis: analysis || '',
    solution: solution || '',
    steps: steps ? JSON.stringify(steps) : '',
    expected_outcome: expected_outcome || '',
    priority: priority || 'medium',
    status: 'draft',
    related_review_id: related_review_id ? Number(related_review_id) : null,
    created_at: now(),
    updated_at: now()
  };
  const result = table.insert(record);
  res.json({ message: '方案已创建', id: result.lastID });
});

router.get('/solution', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_solutions');
  const { status, priority, user } = req.query;
  let records = table.all();
  if (status) records = records.filter(r => r.status === status);
  if (priority) records = records.filter(r => r.priority === priority);
  if (user) records = records.filter(r => r.user === user);
  records.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json(records);
});

router.put('/solution/:id', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_solutions');
  const fields = { updated_at: now() };
  ['title', 'problem', 'analysis', 'solution', 'steps', 'expected_outcome', 'priority', 'status'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  if (req.body.steps && typeof req.body.steps !== 'string') fields.steps = JSON.stringify(req.body.steps);
  table.update(req.params.id, fields);
  res.json({ message: '方案已更新' });
});

router.delete('/solution/:id', requirePerm('ai:delete'), (req, res) => {
  const table = getTable('ai_solutions');
  table.delete(req.params.id);
  res.json({ message: '方案已删除' });
});

router.get('/solution/generate', requirePerm('ai:view'), (req, res) => {
  const { problem_type, context, review_id } = req.query;
  const solution = generateSolution(problem_type, context, review_id);
  res.json(solution);
});

function generateSolution(problemType, context, reviewId) {
  const solution = { problem_type, title: '', problem: '', analysis: '', solution: '', steps: [], expected_outcome: '', actions: [] };

  try {
    const inqTable = getTable('inquiries');
    const custTable = getTable('customers');
    const pricingTable = getTable('bom_pricing');
    const allInq = inqTable.all();

    switch (problemType) {
      case 'low_conversion':
        solution.title = '询价转化率提升方案';
        solution.problem = '询价到成交的转化率偏低';
        const total = allInq.length;
        const closed = allInq.filter(i => i.status === 'closed').length;
        const lost = allInq.filter(i => i.status === 'lost').length;
        solution.analysis = `总询价${total}条，成交${closed}条(${total?Math.round(closed/total*100):0}%)，流失${lost}条(${total?Math.round(lost/total*100):0}%)`;
        solution.solution = '从响应速度、报价竞争力、客户跟进三个维度提升转化率';
        solution.steps = [
          { step: 1, action: '设定询价响应SLA：新询价2小时内首次响应', owner: '销售', deadline: '立即' },
          { step: 2, action: '分析流失客户原因，针对性改进报价策略', owner: '销售经理', deadline: '1周内' },
          { step: 3, action: '建立客户分级跟进机制，重点客户每周至少1次联系', owner: '销售', deadline: '1周内' },
          { step: 4, action: '优化核价流程，缩短报价周期至3天内', owner: '采购/工程', deadline: '2周内' },
          { step: 5, action: '定期复盘成交案例，总结成功经验并推广', owner: '销售经理', deadline: '每月' }
        ];
        solution.expected_outcome = `目标：转化率提升至${total?Math.min(Math.round(closed/total*100)+15,80):30}%以上`;
        break;

      case 'slow_pricing':
        solution.title = '核价效率提升方案';
        solution.problem = '核价周期过长，影响报价速度';
        const allPricing = pricingTable.all();
        const pendingPricing = allPricing.filter(p => !p.total_cost);
        solution.analysis = `核价总数${allPricing.length}条，待核价${pendingPricing.length}条`;
        solution.solution = '优化核价流程，建立快速核价通道';
        solution.steps = [
          { step: 1, action: '对标准产品建立价格模板，实现秒级核价', owner: '工程', deadline: '2周内' },
          { step: 2, action: '设定核价SLA：常规3天，加急1天', owner: '采购/工程', deadline: '立即' },
          { step: 3, action: '建立核价进度看板，超时自动预警', owner: '系统', deadline: '1周内' },
          { step: 4, action: '对历史核价数据做回归分析，建立预估模型', owner: '工程', deadline: '1月内' }
        ];
        solution.expected_outcome = '目标：平均核价周期缩短50%';
        break;

      case 'customer_churn':
        solution.title = '客户流失防范方案';
        solution.problem = '客户流失率偏高，需建立防范机制';
        const allCust = custTable.all();
        const dormants = allCust.filter(c => c.customer_status === '未合作休眠客户');
        solution.analysis = `客户总数${allCust.length}，休眠客户${dormants.length}个(${allCust.length?Math.round(dormants.length/allCust.length*100):0}%)`;
        solution.solution = '建立客户健康度评分体系，提前预警流失风险';
        solution.steps = [
          { step: 1, action: '建立客户健康度评分模型（交易频次/金额/最近联系时间）', owner: '销售经理', deadline: '2周内' },
          { step: 2, action: '对休眠客户制定激活计划，分批联系', owner: '销售', deadline: '1周内' },
          { step: 3, action: '设定客户联系提醒，超30天未联系自动提醒', owner: '系统', deadline: '1周内' },
          { step: 4, action: '分析流失客户共性，制定针对性保留策略', owner: '销售经理', deadline: '2周内' }
        ];
        solution.expected_outcome = '目标：客户流失率降低30%';
        break;

      default:
        solution.title = '综合业务优化方案';
        solution.problem = context || '业务流程整体优化';
        solution.analysis = `基于${allInq.length}条询价数据分析`;
        solution.solution = '从流程、人员、工具三个维度全面优化';
        solution.steps = [
          { step: 1, action: '梳理现有业务流程，识别瓶颈环节', owner: '管理层', deadline: '1周内' },
          { step: 2, action: '制定各环节SLA标准', owner: '管理层', deadline: '1周内' },
          { step: 3, action: '建立数据驱动的决策机制', owner: '全员', deadline: '2周内' },
          { step: 4, action: '定期复盘，持续改进', owner: '管理层', deadline: '每月' }
        ];
        solution.expected_outcome = '目标：整体业务效率提升30%';
    }

    solution.actions = solution.steps.map(s => ({
      content: s.action,
      assignee: s.owner,
      priority: s.step <= 2 ? 'high' : 'medium',
      deadline: s.deadline
    }));
  } catch (e) {
    solution.error = e.message;
  }

  return solution;
}

// ===== 行动输出 =====
router.post('/action', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_actions');
  const { user, title, content, assignee, priority, deadline, source_type, source_id, related_plan_id, related_solution_id } = req.body;
  if (!content) return res.status(400).json({ error: '行动内容为必填项' });

  const record = {
    user: user || 'system',
    title: title || '',
    content,
    assignee: assignee || '',
    priority: priority || 'medium',
    deadline: deadline || '',
    source_type: source_type || 'manual',
    source_id: source_id ? Number(source_id) : null,
    related_plan_id: related_plan_id ? Number(related_plan_id) : null,
    related_solution_id: related_solution_id ? Number(related_solution_id) : null,
    status: 'pending',
    result: '',
    created_at: now(),
    updated_at: now()
  };
  const result = table.insert(record);
  res.json({ message: '行动已创建', id: result.lastID });
});

router.get('/action', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_actions');
  const { status, assignee, priority, source_type, user } = req.query;
  let records = table.all();
  if (status) records = records.filter(r => r.status === status);
  if (assignee) records = records.filter(r => r.assignee === assignee);
  if (priority) records = records.filter(r => r.priority === priority);
  if (source_type) records = records.filter(r => r.source_type === source_type);
  if (user) records = records.filter(r => r.user === user);
  records.sort((a, b) => {
    const pMap = { high: 0, medium: 1, low: 2 };
    return (pMap[a.priority] || 1) - (pMap[b.priority] || 1) || (b.created_at || '').localeCompare(a.created_at || '');
  });
  res.json(records);
});

router.put('/action/:id', requirePerm('ai:view'), (req, res) => {
  const table = getTable('ai_actions');
  const fields = { updated_at: now() };
  ['title', 'content', 'assignee', 'priority', 'deadline', 'status', 'result', 'related_plan_id', 'related_solution_id'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '行动已更新' });
});

router.delete('/action/:id', requirePerm('ai:delete'), (req, res) => {
  const table = getTable('ai_actions');
  table.delete(req.params.id);
  res.json({ message: '行动已删除' });
});

// ===== 综合仪表盘 =====
router.get('/dashboard', requirePerm('ai:view'), (req, res) => {
  const { user } = req.query;
  const dashboard = { learning_stats: {}, plan_stats: {}, review_stats: {}, action_stats: {}, recent_insights: [] };

  try {
    const learnTable = getTable('ai_learning_records');
    const planTable = getTable('ai_plans');
    const reviewTable = getTable('ai_reviews');
    const actionTable = getTable('ai_actions');

    const learns = learnTable.all();
    const plans = planTable.all();
    const reviews = reviewTable.all();
    const actions = actionTable.all();

    dashboard.learning_stats = {
      total: learns.length,
      by_category: countBy(learns, 'category'),
      top_questions: learns.sort((a, b) => (b.hit_count || 0) - (a.hit_count || 0)).slice(0, 5).map(l => ({ question: l.question, hits: l.hit_count }))
    };

    dashboard.plan_stats = {
      total: plans.length,
      active: plans.filter(p => p.status === 'active').length,
      completed: plans.filter(p => p.status === 'completed').length,
      by_type: countBy(plans, 'plan_type')
    };

    dashboard.review_stats = {
      total: reviews.length,
      open: reviews.filter(r => r.status === 'open').length,
      closed: reviews.filter(r => r.status === 'closed').length,
      by_type: countBy(reviews, 'review_type')
    };

    dashboard.action_stats = {
      total: actions.length,
      pending: actions.filter(a => a.status === 'pending').length,
      in_progress: actions.filter(a => a.status === 'in_progress').length,
      completed: actions.filter(a => a.status === 'completed').length,
      overdue: actions.filter(a => a.status !== 'completed' && a.deadline && a.deadline < new Date().toISOString().substring(0, 10)).length,
      by_priority: countBy(actions, 'priority')
    };

    const inqTable = getTable('inquiries');
    const allInq = inqTable.all();
    const recentPending = allInq.filter(i => ['new', 'pending_pricing', 'pending_quote'].includes(i.status));
    const recentLost = allInq.filter(i => i.status === 'lost');

    if (recentPending.length > 0) {
      dashboard.recent_insights.push({ type: 'warning', content: `${recentPending.length}条询价待处理`, action: '建议优先处理' });
    }
    if (recentLost.length > 0) {
      dashboard.recent_insights.push({ type: 'risk', content: `${recentLost.length}条询价已流失`, action: '建议复盘分析' });
    }
  } catch (e) {
    dashboard.error = e.message;
  }

  res.json(dashboard);
});

// ===== 工具函数 =====
function countBy(arr, field) {
  const result = {};
  arr.forEach(item => {
    const key = item[field] || '未知';
    result[key] = (result[key] || 0) + 1;
  });
  return result;
}

function getTopN(arr, field, n) {
  const counts = countBy(arr, field);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

function generateActionsFromReview(review) {
  const actions = [];
  review.findings.forEach(f => {
    if (f.type === 'risk' || f.type === 'warning') {
      actions.push({ content: `处理: ${f.content}`, assignee: '', priority: 'high', deadline: '3天内' });
    }
  });
  review.improvements.forEach(imp => {
    actions.push({ content: `改进: ${imp.content}`, assignee: '', priority: imp.priority || 'medium', deadline: '1周内' });
  });
  return actions;
}

// ===== 自动化引擎：一键全流程 =====
router.post('/auto-run', requirePerm('ai:view'), async (req, res) => {
  const { user: runUser } = req.body;
  const operator = runUser || 'system';
  const result = { scan: [], learned: [], summary: null, plans: [], actions: [], timestamp: now() };

  try {
    result.scan = await autoScanProblems(operator);
    result.learned = await autoLearnFromScan(result.scan, operator);
    result.summary = await autoGenerateSummary(operator);
    result.plans = await autoGeneratePlans(result.scan, operator);
    result.actions = await autoGenerateActions(result.scan, result.plans, operator);
  } catch (e) {
    result.error = e.message;
  }

  res.json(result);
});

router.get('/auto-run/status', requirePerm('ai:view'), (req, res) => {
  const actionTable = getTable('ai_actions');
  const planTable = getTable('ai_plans');
  const learnTable = getTable('ai_learning_records');
  const reviewTable = getTable('ai_reviews');

  const actions = actionTable.all();
  const plans = planTable.all();
  const learns = learnTable.all();

  const lastAuto = actions.filter(a => a.source_type === 'auto').sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];

  res.json({
    last_auto_run: lastAuto ? lastAuto.created_at : null,
    total_actions: actions.length,
    pending_actions: actions.filter(a => a.status === 'pending').length,
    active_plans: plans.filter(p => p.status === 'active').length,
    learning_records: learns.length,
    auto_actions_today: actions.filter(a => a.source_type === 'auto' && (a.created_at || '').startsWith(new Date().toISOString().substring(0, 10))).length
  });
});

async function autoScanProblems(operator) {
  const problems = [];
  const inqTable = getTable('inquiries');
  const custTable = getTable('customers');
  const pricingTable = getTable('bom_pricing');
  const quoteTable = getTable('quote_library');

  const allInq = inqTable.all();
  const allCust = custTable.all();
  const allPricing = pricingTable.all();
  const today = new Date().toISOString().substring(0, 10);

  const pending = allInq.filter(i => ['new', 'pending_pricing', 'pending_quote'].includes(i.status));
  const longPending = pending.filter(i => {
    const days = (Date.now() - new Date(i.created_at).getTime()) / 86400000;
    return days > 3;
  });
  if (longPending.length > 0) {
    problems.push({
      type: 'urgent',
      category: 'inquiry_delay',
      title: `${longPending.length}条询价滞留超3天`,
      detail: longPending.slice(0, 5).map(i => `${i.serial_number} ${i.customer_name} ${i.external_model || ''} 滞留${Math.round((Date.now() - new Date(i.created_at).getTime()) / 86400000)}天`),
      severity: 'high',
      affected_ids: longPending.map(i => i.id)
    });
  }

  const lost = allInq.filter(i => i.status === 'lost');
  const recentLost = lost.filter(i => {
    const days = (Date.now() - new Date(i.updated_at || i.created_at).getTime()) / 86400000;
    return days <= 30;
  });
  if (recentLost.length > 0) {
    problems.push({
      type: 'risk',
      category: 'inquiry_lost',
      title: `近30天${recentLost.length}条询价流失`,
      detail: recentLost.slice(0, 5).map(i => `${i.serial_number} ${i.customer_name} ${i.external_model || ''}`),
      severity: 'high',
      affected_ids: recentLost.map(i => i.id)
    });
  }

  const pendingPricing = allPricing.filter(p => !p.total_cost);
  const oldPendingPricing = pendingPricing.filter(p => {
    const days = (Date.now() - new Date(p.created_at).getTime()) / 86400000;
    return days > 5;
  });
  if (oldPendingPricing.length > 0) {
    problems.push({
      type: 'warning',
      category: 'pricing_delay',
      title: `${oldPendingPricing.length}条核价超5天未完成`,
      detail: oldPendingPricing.slice(0, 5).map(p => `${p.model || ''} ${p.customer || ''}`),
      severity: 'medium',
      affected_ids: oldPendingPricing.map(p => p.id)
    });
  }

  const dormants = allCust.filter(c => c.customer_status === '未合作休眠客户');
  if (dormants.length > 3) {
    problems.push({
      type: 'warning',
      category: 'customer_dormant',
      title: `${dormants.length}个休眠客户待激活`,
      detail: dormants.slice(0, 5).map(c => `${c.name} ${c.contact_person || ''}`),
      severity: 'medium',
      affected_ids: dormants.map(c => c.id)
    });
  }

  const noSourceCust = allCust.filter(c => !c.source && !c.customer_source);
  if (noSourceCust.length > 0) {
    problems.push({
      type: 'insight',
      category: 'data_quality',
      title: `${noSourceCust.length}个客户缺少来源信息`,
      detail: noSourceCust.slice(0, 5).map(c => c.name),
      severity: 'low',
      affected_ids: noSourceCust.map(c => c.id)
    });
  }

  const noContactCust = allCust.filter(c => !c.phone && !c.email);
  if (noContactCust.length > 0) {
    problems.push({
      type: 'insight',
      category: 'data_quality',
      title: `${noContactCust.length}个客户缺少联系方式`,
      detail: noContactCust.slice(0, 5).map(c => c.name),
      severity: 'low',
      affected_ids: noContactCust.map(c => c.id)
    });
  }

  const total = allInq.length;
  const closed = allInq.filter(i => i.status === 'closed').length;
  if (total > 10 && closed / total < 0.15) {
    problems.push({
      type: 'risk',
      category: 'low_conversion',
      title: `询价转化率仅${Math.round(closed / total * 100)}%，低于15%警戒线`,
      detail: [`总询价${total}条，成交${closed}条`, `流失${lost.length}条`, `待处理${pending.length}条`],
      severity: 'high'
    });
  }

  const salesStats = {};
  allInq.forEach(i => {
    if (i.sales_person) {
      if (!salesStats[i.sales_person]) salesStats[i.sales_person] = { total: 0, pending: 0 };
      salesStats[i.sales_person].total++;
      if (['new', 'pending_pricing', 'pending_quote'].includes(i.status)) salesStats[i.sales_person].pending++;
    }
  });
  Object.entries(salesStats).forEach(([sales, stats]) => {
    if (stats.pending >= 5) {
      problems.push({
        type: 'warning',
        category: 'sales_overload',
        title: `${sales}有${stats.pending}条待处理询价（共${stats.total}条）`,
        detail: [],
        severity: 'medium'
      });
    }
  });

  const sourceStats = countBy(allInq.filter(i => i.customer_source), 'customer_source');
  const topSource = Object.entries(sourceStats).sort((a, b) => b[1] - a[1])[0];
  if (topSource && topSource[1] > allInq.length * 0.6) {
    problems.push({
      type: 'insight',
      category: 'source_concentration',
      title: `客户来源过度集中: ${topSource[0]}占${Math.round(topSource[1] / allInq.length * 100)}%`,
      detail: Object.entries(sourceStats).map(([k, v]) => `${k}: ${v}条`),
      severity: 'low'
    });
  }

  return problems;
}

async function autoLearnFromScan(problems, operator) {
  const learnTable = getTable('ai_learning_records');
  const learned = [];

  const categoryMap = {
    inquiry_delay: 'inquiry',
    inquiry_lost: 'inquiry',
    pricing_delay: 'pricing',
    customer_dormant: 'customer',
    data_quality: 'process',
    low_conversion: 'inquiry',
    sales_overload: 'process',
    source_concentration: 'customer'
  };

  const answerMap = {
    inquiry_delay: '询价滞留需及时处理，建议设定SLA：新询价2小时响应，3天内报价，超时自动升级',
    inquiry_lost: '流失客户需复盘分析原因，常见原因：报价偏高、响应慢、需求不匹配。建议建立流失客户挽回机制',
    pricing_delay: '核价超时影响报价速度，建议对标准产品建立价格模板，设定核价SLA：常规3天，加急1天',
    customer_dormant: '休眠客户需定期激活，建议30天未联系自动提醒，制定分批激活计划',
    data_quality: '数据不完整影响分析准确性，建议在录入时设置必填项校验，定期扫描补全',
    low_conversion: '转化率低需从多维度分析：响应速度、报价竞争力、客户匹配度、跟进频率',
    sales_overload: '销售人员待处理过多影响效率，建议合理分配询价，设定个人处理上限',
    source_concentration: '客户来源过度集中有风险，建议拓展多元化获客渠道'
  };

  problems.forEach(p => {
    const question = p.title;
    const answer = answerMap[p.category] || '需要进一步分析';
    const category = categoryMap[p.category] || 'general';

    const existing = learnTable.all().find(r =>
      r.question && r.question.trim() === question.trim()
    );

    if (existing) {
      learnTable.update(existing.id, {
        hit_count: (existing.hit_count || 0) + 1,
        answer: answer || existing.answer,
        updated_at: now()
      });
      learned.push({ question, status: 'updated', hit_count: (existing.hit_count || 0) + 1 });
    } else {
      learnTable.insert({
        user: operator,
        question,
        answer,
        category,
        tags: p.category + ',' + p.type,
        feedback: '',
        context_type: p.category,
        context_id: null,
        hit_count: 1,
        created_at: now(),
        updated_at: now()
      });
      learned.push({ question, status: 'created', hit_count: 1 });
    }
  });

  return learned;
}

async function autoGenerateSummary(operator) {
  const summaryTable = getTable('ai_summaries');
  const today = new Date().toISOString().substring(0, 10);
  const todayKey = today.replace(/-/g, '');

  const existing = summaryTable.all().find(s =>
    s.summary_type === 'daily' && (s.date_range_start || '').startsWith(today)
  );
  if (existing) {
    return { id: existing.id, title: existing.title, status: 'already_exists' };
  }

  const summary = generateBusinessSummary('daily', today, today, operator);
  let content = `📅 ${today} 业务日报\n\n`;

  (summary.sections || []).forEach(s => {
    content += `【${s.title}】\n`;
    const d = s.data || {};
    Object.entries(d).forEach(([k, v]) => {
      if (typeof v === 'object' && v !== null) {
        const entries = Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, 5);
        content += `  ${k}: ${entries.map(([ek, ev]) => `${ek}(${ev})`).join(', ')}\n`;
      } else {
        content += `  ${k}: ${v}\n`;
      }
    });
    content += '\n';
  });

  const record = {
    user: operator,
    title: `业务日报 ${today}`,
    content,
    summary_type: 'daily',
    source_type: 'auto',
    source_id: null,
    date_range_start: today,
    date_range_end: today,
    created_at: now(),
    updated_at: now()
  };
  const result = summaryTable.insert(record);
  return { id: result.lastID, title: record.title, status: 'created' };
}

async function autoGeneratePlans(problems, operator) {
  const planTable = getTable('ai_plans');
  const actionTable = getTable('ai_actions');
  const plans = [];

  const urgentProblems = problems.filter(p => p.severity === 'high');
  if (urgentProblems.length === 0) return plans;

  const existingActive = planTable.all().filter(p => p.status === 'active' && p.plan_type === 'auto');
  const today = new Date().toISOString().substring(0, 10);

  const planTitles = urgentProblems.map(p => p.title).join('；');
  const existingPlan = existingActive.find(p =>
    (p.created_at || '').startsWith(today)
  );

  if (existingPlan) {
    plans.push({ id: existingPlan.id, title: existingPlan.title, status: 'already_exists' });
    return plans;
  }

  const goals = urgentProblems.map(p => `解决: ${p.title}`);
  const milestones = urgentProblems.map((p, i) => ({
    step: i + 1,
    action: p.title,
    detail: (p.detail || []).slice(0, 3).join('; ')
  }));

  const record = {
    user: operator,
    title: `自动排期 ${today} - ${urgentProblems.length}个紧急问题`,
    plan_type: 'auto',
    content: `系统自动识别到${urgentProblems.length}个紧急问题，已自动生成处理计划`,
    goals: JSON.stringify(goals),
    milestones: JSON.stringify(milestones),
    start_date: today,
    end_date: new Date(Date.now() + 7 * 86400000).toISOString().substring(0, 10),
    priority: 'high',
    status: 'active',
    progress: 0,
    created_at: now(),
    updated_at: now()
  };
  const result = planTable.insert(record);
  plans.push({ id: result.lastID, title: record.title, status: 'created' });

  return plans;
}

async function autoGenerateActions(problems, plans, operator) {
  const actionTable = getTable('ai_actions');
  const actions = [];

  const today = new Date().toISOString().substring(0, 10);
  const existingToday = actionTable.all().filter(a =>
    a.source_type === 'auto' && (a.created_at || '').startsWith(today)
  );
  if (existingToday.length >= 20) {
    return actions.map(a => ({ content: a.content, status: 'skipped_limit' }));
  }

  problems.forEach(p => {
    if (p.severity === 'high') {
      const actionContent = `【紧急】${p.title}`;
      const exists = actionTable.all().find(a =>
        a.content === actionContent && a.status !== 'completed'
      );
      if (!exists) {
        actionTable.insert({
          user: operator,
          title: p.title,
          content: actionContent,
          assignee: '',
          priority: 'high',
          deadline: new Date(Date.now() + 3 * 86400000).toISOString().substring(0, 10),
          source_type: 'auto',
          source_id: null,
          related_plan_id: plans.length > 0 ? plans[0].id : null,
          related_solution_id: null,
          status: 'pending',
          result: '',
          created_at: now(),
          updated_at: now()
        });
        actions.push({ content: actionContent, priority: 'high', status: 'created' });
      } else {
        actions.push({ content: actionContent, priority: 'high', status: 'already_exists' });
      }
    }

    if (p.severity === 'medium') {
      const actionContent = `【改进】${p.title}`;
      const exists = actionTable.all().find(a =>
        a.content === actionContent && a.status !== 'completed'
      );
      if (!exists) {
        actionTable.insert({
          user: operator,
          title: p.title,
          content: actionContent,
          assignee: '',
          priority: 'medium',
          deadline: new Date(Date.now() + 7 * 86400000).toISOString().substring(0, 10),
          source_type: 'auto',
          source_id: null,
          related_plan_id: plans.length > 0 ? plans[0].id : null,
          related_solution_id: null,
          status: 'pending',
          result: '',
          created_at: now(),
          updated_at: now()
        });
        actions.push({ content: actionContent, priority: 'medium', status: 'created' });
      }
    }
  });

  return actions;
}

// ===== 模块智能诊断：选择模块→发现问题→提出解决方案→可自我解决 =====
const http = require('http');
const DIAG_PORT = parseInt(process.env.PORT) || 3010;
function diagHttp(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: '127.0.0.1', port: DIAG_PORT, path, method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, timeout: 20000 }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j; try { j = JSON.parse(b); } catch (e) { j = b; } resolve({ status: res.statusCode, data: j }); });
    });
    req.on('error', () => resolve({ status: 0, data: null, error: true }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null, error: true }); });
    if (data) req.write(data); req.end();
  });
}

const moduleDiagnosers = {
  material: async () => {
    const problems = [];
    const r = await diagHttp('GET', '/api/materials/quality-check');
    if (!r.error && r.data) {
      const d = r.data;
      if (d.by_severity) {
        if (d.by_severity.severe > 0) problems.push({ severity: '严重', desc: `${d.by_severity.severe}条物料有严重问题(编码为空/重复等)`, solution: '补全物料编码和名称，处理重复', auto_fixable: false, fix: '' });
        if (d.by_severity.warning > 0) problems.push({ severity: '警告', desc: `${d.by_severity.warning}条物料有警告(成本为0/未分类/库存不足等)`, solution: '运行自动分类+补全成本', auto_fixable: true, fix: 'material_autofix' });
      }
      if ((d.by_type || {}).no_classification > 0) problems.push({ severity: '警告', desc: `${d.by_type.no_classification}条物料未分类`, solution: '按自动分类标准执行分类', auto_fixable: true, fix: 'material_classify' });
      if ((d.by_type || {}).zero_cost > 0) problems.push({ severity: '警告', desc: `${d.by_type.zero_cost}条物料标准成本为0`, solution: '从BOM或采购补全成本', auto_fixable: false, fix: '' });
    }
    return { module: '物料库', total: (r.data && r.data.total) || 0, problems };
  },
  bom: async () => {
    const problems = [];
    const bomTable = getTable('bom_items'); bomTable._invalidate();
    const items = bomTable.all();
    const products = new Set(items.map(b => b.product_code));
    const matTable = getTable('materials'); matTable._invalidate();
    const matCodes = new Set(matTable.all().map(m => m.material_code));
    let unmatched = 0; items.forEach(b => { if (b.material_code && !matCodes.has(b.material_code)) unmatched++; });
    if (unmatched > 0) problems.push({ severity: '警告', desc: `${unmatched}条BOM物料未关联物料库`, solution: '将BOM物料同步到物料库', auto_fixable: true, fix: 'bom_sync_to_materials' });
    if (products.size === 0) problems.push({ severity: '提示', desc: 'BOM明细为空', solution: '导入BOM Excel', auto_fixable: false, fix: '' });
    problems.push({ severity: '提示', desc: `BOM覆盖${products.size}个产品，${items.length}条明细`, solution: '正常', auto_fixable: false, fix: '' });
    return { module: 'BOM管理', total: items.length, problems };
  },
  inquiry: async () => {
    const problems = [];
    const inqTable = getTable('inquiries'); inqTable._invalidate();
    const all = inqTable.all();
    const validStates = new Set(['new', 'cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'negotiating', 'sample', 'project', 'lost', 'closed']);
    let invalid = 0, noCustomer = 0;
    all.forEach(i => { if (!validStates.has(i.status)) invalid++; if (!i.customer_name) noCustomer++; });
    if (invalid > 0) problems.push({ severity: '严重', desc: `${invalid}条询价状态非法`, solution: '修正状态值', auto_fixable: false, fix: '' });
    if (noCustomer > 0) problems.push({ severity: '警告', desc: `${noCustomer}条询价缺少客户名称`, solution: '补全客户信息', auto_fixable: false, fix: '' });
    const pending = all.filter(i => ['pending_pricing', 'pending_quote'].includes(i.status)).length;
    if (pending > 0) problems.push({ severity: '提示', desc: `${pending}条询价待核价/报价`, solution: '跟进处理', auto_fixable: false, fix: '' });
    return { module: '询价管理', total: all.length, problems };
  },
  supplier: async () => {
    const problems = [];
    const matTable = getTable('materials'); matTable._invalidate();
    const mats = matTable.all();
    const noSupplier = mats.filter(m => !m.supplier).length;
    if (noSupplier > 0) problems.push({ severity: '警告', desc: `${noSupplier}条物料未关联供应商`, solution: '补全物料供应商字段', auto_fixable: false, fix: '' });
    const supTable = getTable('suppliers'); supTable._invalidate();
    const supCount = supTable.all().length;
    if (supCount === 0) problems.push({ severity: '提示', desc: '供应商库为空', solution: '从物料库提取供应商', auto_fixable: true, fix: 'supplier_extract' });
    return { module: '供应商管理', total: supCount, problems };
  },
  pricing: async () => {
    const problems = [];
    const pTable = getTable('bom_pricing'); pTable._invalidate();
    const all = pTable.all();
    const noPrice = all.filter(p => !p.price_rmb && !p.price_usd).length;
    if (noPrice > 0) problems.push({ severity: '警告', desc: `${noPrice}条核价记录缺少报价`, solution: '补全核价报价', auto_fixable: false, fix: '' });
    return { module: '核价表', total: all.length, problems };
  }
};

router.get('/modules', requirePerm('ai:view'), (req, res) => {
  res.json({ data: Object.keys(moduleDiagnosers).map(k => ({ code: k, name: moduleDiagnosers[k].toString().indexOf('material') >= 0 ? '物料库' : k })) });
});

router.post('/module-diagnose', requirePerm('ai:view'), async (req, res) => {
  const { module } = req.body;
  const fn = moduleDiagnosers[module];
  if (!fn) return res.status(400).json({ error: '未知模块: ' + module + '，可选: ' + Object.keys(moduleDiagnosers).join(',') });
  try {
    const result = await fn();
    const fixable = result.problems.filter(p => p.auto_fixable).length;
    result.summary = `${result.module}诊断完成：共${result.problems.length}个问题，其中${fixable}个可自动解决`;
    res.json(result);
  } catch (e) { res.status(500).json({ error: '诊断失败: ' + e.message }); }
});

router.post('/module-autofix', requirePerm('ai:view'), async (req, res) => {
  const { module } = req.body;
  const fixed = [];
  try {
    if (module === 'material') {
      const af = await diagHttp('POST', '/api/materials/quality-check/auto-fix', {});
      if (!af.error) fixed.push({ action: '自动纠正(未分类/类型不一致)', result: af.data });
      const cls = await diagHttp('POST', '/api/materials-ext/classification-rules/auto-classify', { apply: true });
      if (!cls.error) fixed.push({ action: '按分类标准执行分类', result: `更新${cls.data.updated || 0}条` });
    } else if (module === 'bom') {
      const sync = await diagHttp('POST', '/api/bom/sync-to-materials', {});
      if (!sync.error) fixed.push({ action: 'BOM物料同步到物料库', result: sync.data });
    } else if (module === 'supplier') {
      const ex = await diagHttp('POST', '/api/suppliers/extract-from-materials', {});
      if (!ex.error) fixed.push({ action: '从物料库提取供应商', result: ex.data });
    } else {
      return res.json({ message: '该模块无可自动执行的修复', fixed: [] });
    }
    res.json({ message: `${module}模块自动修复完成`, fixed });
  } catch (e) { res.status(500).json({ error: '修复失败: ' + e.message }); }
});

module.exports = router;
