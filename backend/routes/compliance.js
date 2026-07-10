const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('compliance_reports');
ensureTable('compliance_issues');

// ===== 合规自检规则定义 =====

const CHECK_DIMENSIONS = {
  flow: { name: '业务流程逻辑自检', desc: '校验询价全流程流转合规性' },
  database: { name: '基础数据库合规自检', desc: '校验物料库、核价库数据规范性与联动性' },
  permission: { name: '角色权限合规自检', desc: '校验各岗位权限配置合规性' },
  data: { name: '数据规范与日志自检', desc: '校验数据完整性、日志留痕合规性' }
};

const ISSUE_TYPES = ['流程异常', '数据异常', '权限异常', '日志异常', '配置异常'];
const ISSUE_LEVELS = ['一般问题', '警示问题', '严重问题'];
const ISSUE_STATUSES = ['待整改', '整改中', '待复核', '已闭环', '永久沉淀'];

// 问题关联页面映射
function getIssueLink(issue) {
  const { type, module, related, desc } = issue;

  // 优先解析related字段，定位到具体记录（精确到那一条）
  if (related) {
    const matMatch = related.match(/^MAT:(\d+)$/);
    if (matMatch) return 'material.html?focus=' + matMatch[1] + '&tab=quality';
    if (related.match(/^BOM:/)) return 'bom.html';
    if (related.match(/^QUOTE:/)) return 'quote.html';
    if (/^\d/.test(related) && related.length >= 4) return 'inquiry.html?sn=' + encodeURIComponent(related);
  }

  // 日志异常 - 关联询价单的操作日志，跳转到询价页面
  if (type === '日志异常') {
    const match = desc.match(/询价单([A-Za-z0-9_-]+)/);
    if (match) return 'inquiry.html?sn=' + encodeURIComponent(match[1]);
    return 'inquiry.html';
  }

  // 流程异常 - 根据描述定位到具体询价单
  if (type === '流程异常') {
    const match = desc.match(/询价单([A-Za-z0-9_-]+)/);
    if (match) return 'inquiry.html?sn=' + encodeURIComponent(match[1]);
    if (module === '核价库') return 'pricing.html';
    if (module === '报价库') return 'quote.html';
    return 'inquiry.html';
  }

  // 数据异常 - 根据模块定位
  if (type === '数据异常') {
    if (module === '物料库') return 'material.html';
    if (module === '核价库') return 'pricing.html';
    if (module === '报价库') return 'quote.html';
    if (module === '客户管理') return 'customer.html';
    if (module === '产品管理') return 'product.html';
    if (module === '询价模块') return 'inquiry.html';
  }

  // 权限异常
  if (type === '权限异常') return 'permission.html';

  // 配置异常
  if (type === '配置异常') {
    if (module === '报价库') return 'quote.html';
    return 'settings.html';
  }

  // 按模块映射
  if (module === '询价模块') return 'inquiry.html';
  if (module === '物料库') return 'material.html';
  if (module === '核价库') return 'pricing.html';
  if (module === '报价库') return 'quote.html';
  if (module === '权限管理') return 'permission.html';
  if (module === '客户管理') return 'customer.html';
  if (module === '产品管理') return 'product.html';
  if (module === '日志管理') return 'inquiry.html';
  if (module === '库表联动') return 'product.html';
  return '';
}

// 判断问题是否可自动修复
function isAutoFixable(issue) {
  if (issue.type === '权限异常' && issue.desc.includes('缺少应有权限')) return true;
  if (issue.type === '流程异常' && issue.desc.includes('缺少报价时间')) return true;
  if (issue.type === '配置异常' && issue.desc.includes('有效期配置异常')) return true;
  if (issue.type === '流程异常' && issue.desc.includes('关联询价单') && issue.desc.includes('不存在')) return true;
  if (issue.type === '流程异常' && issue.desc.includes('违规状态跳转')) return true;
  if (issue.type === '日志异常' && issue.desc.includes('缺少创建操作日志')) return true;
  if (issue.type === '权限异常' && issue.desc.includes('越权权限')) return true;
  if (issue.type === '权限异常' && issue.desc.includes('核价权限') && issue.desc.includes('销售')) return true;
  return false;
}

// ===== 合规自检执行引擎 =====

// 9.3.1 业务流程逻辑自检
async function checkFlow() {
  const issues = [];
  const inqTable = getTable('inquiries');
  const inquiries = inqTable.all();

  // 校验1：询价单状态流转合规性
  const validTransitions = {
    'new': ['cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'lost'],
    'cert_configured': ['config_generated', 'pending_pricing', 'new', 'lost'],
    'config_generated': ['pending_pricing', 'pending_quote', 'new', 'lost'],
    'pending_pricing': ['pending_quote', 'quoted', 'config_generated', 'lost'],
    'pending_quote': ['quoted', 'config_generated', 'lost'],
    'quoted': ['negotiating', 'sample', 'project', 'closed', 'lost'],
    'negotiating': ['sample', 'project', 'lost', 'quoted', 'closed'],
    'sample': ['project', 'closed', 'lost'],
    'project': ['closed', 'lost'],
    'closed': [],
    'lost': ['new']
  };

  const statusTable = getTable('inquiry_status_changes');
  for (const inq of inquiries) {
    // 校验关键字段完整性
    if (!inq.serial_number) {
      issues.push({ type: '流程异常', level: '严重问题', module: '询价模块', desc: `询价单ID=${inq.id}缺少单据编号`, standard: '所有询价单必须有唯一编号', related: `ID:${inq.id}` });
    }
    if (!inq.customer_name) {
      issues.push({ type: '流程异常', level: '警示问题', module: '询价模块', desc: `询价单${inq.serial_number || inq.id}缺少客户名称`, standard: '询价单必须关联客户', related: inq.serial_number });
    }
    if (!inq.external_model && !inq.internal_model) {
      issues.push({ type: '流程异常', level: '警示问题', module: '询价模块', desc: `询价单${inq.serial_number || inq.id}缺少产品型号`, standard: '询价单必须关联产品型号', related: inq.serial_number });
    }
    if (!inq.quantity || inq.quantity <= 0) {
      issues.push({ type: '数据异常', level: '一般问题', module: '询价模块', desc: `询价单${inq.serial_number || inq.id}数量异常: ${inq.quantity}`, standard: '询价数量必须大于0', related: inq.serial_number });
    }

    // 校验状态流转合规性
    const changes = statusTable.all().filter(c => c.inquiry_id === inq.id).sort((a, b) => a.id - b.id);
    for (let i = 1; i < changes.length; i++) {
      const prev = changes[i - 1].status;
      const curr = changes[i].status;
      const allowed = validTransitions[prev];
      if (allowed && !allowed.includes(curr)) {
        issues.push({ type: '流程异常', level: '严重问题', module: '询价模块', desc: `询价单${inq.serial_number}违规状态跳转: ${prev}→${curr}`, standard: `状态${prev}仅允许跳转至: ${allowed.join(',')}`, related: inq.serial_number });
      }
    }

    // 校验已报价单据是否有报价金额
    if (['quoted', 'negotiating'].includes(inq.status) && (!inq.final_price || inq.final_price <= 0)) {
      issues.push({ type: '流程异常', level: '警示问题', module: '询价模块', desc: `询价单${inq.serial_number}已报价但报价金额为空或0`, standard: '已报价状态必须有有效报价金额', related: inq.serial_number });
    }

    // 校验核价→报价流程完整性
    if (inq.status === 'quoted' && !inq.quoted_at) {
      issues.push({ type: '流程异常', level: '一般问题', module: '询价模块', desc: `询价单${inq.serial_number}已报价但缺少报价时间`, standard: '报价完成应记录报价时间', related: inq.serial_number });
    }
  }

  // 校验2：核价库→询价联动
  const bomTable = getTable('bom_pricing');
  const bomRecords = bomTable.all();
  const legacyInquiryPattern = /^\d{2}-\d{2,3}$/;
  for (const bom of bomRecords) {
    if (bom.inquiry_no) {
      const relatedInq = inquiries.find(i => i.serial_number === bom.inquiry_no);
      if (!relatedInq && !legacyInquiryPattern.test(bom.inquiry_no) && bom.inquiry_no !== '/') {
        issues.push({ type: '流程异常', level: '警示问题', module: '核价库', desc: `核价记录关联询价单${bom.inquiry_no}不存在`, standard: '核价记录应关联有效询价单', related: bom.inquiry_no });
      }
    }
    if (!bom.model) {
      issues.push({ type: '数据异常', level: '警示问题', module: '核价库', desc: `核价记录ID=${bom.id}缺少产品型号`, standard: '核价记录必须关联产品型号', related: `BOM:${bom.id}` });
    }
  }

  // 校验3：报价库→询价联动
  const quoteTable = getTable('quote_library');
  const quoteRecords = quoteTable.all();
  for (const q of quoteRecords) {
    if (q.source_inquiry_id) {
      const srcInq = inquiries.find(i => i.id == q.source_inquiry_id);
      if (!srcInq) {
        issues.push({ type: '流程异常', level: '一般问题', module: '报价库', desc: `报价库记录关联询价单ID=${q.source_inquiry_id}不存在`, standard: '报价库转入记录应关联有效询价单', related: `QUOTE:${q.id}` });
      }
    }
  }

  return issues;
}

// 9.3.2 基础数据库合规自检
async function checkDatabase() {
  const issues = [];

  // 物料库自检
  const matTable = getTable('materials');
  const materials = matTable.all();
  for (const m of materials) {
    const mName = m.material_name || m.name;
    if (!mName || mName === 'undefined') {
      issues.push({ type: '数据异常', level: '警示问题', module: '物料库', desc: `物料ID=${m.id}缺少名称`, standard: '物料必须有名称', related: `MAT:${m.id}` });
    }
    if (!m.category && !m.material_code) {
      issues.push({ type: '数据异常', level: '一般问题', module: '物料库', desc: `物料"${mName || m.id}"缺少分类`, standard: '物料应关联分类', related: `MAT:${m.id}` });
    }
  }

  // 物料重复检查
  const nameMap = {};
  for (const m of materials) {
    const mName = m.material_name || m.name;
    const mSpec = m.spec || m.material_code || '';
    const key = `${mName}_${mSpec}`;
    if (!mName || mName === 'undefined') continue;
    if (nameMap[key]) {
      issues.push({ type: '数据异常', level: '一般问题', module: '物料库', desc: `物料"${mName}"规格"${mSpec}"存在重复记录`, standard: '物料不应重复', related: `MAT:${m.id}` });
    }
    nameMap[key] = true;
  }

  // 核价库自检
  const bomTable = getTable('bom_pricing');
  const bomRecords = bomTable.all();
  for (const b of bomRecords) {
    // 价格缺失检查
    if (!b.price_rmb && !b.price_usd) {
      issues.push({ type: '数据异常', level: '警示问题', module: '核价库', desc: `核价记录型号${b.model}缺少单价(RMB和USD均为空)`, standard: '核价记录应有至少一种货币单价', related: `BOM:${b.id}` });
    }
    // 证书等级与价格匹配
    if (b.certificate_level && b.price_rmb && b.price_rmb <= 0) {
      issues.push({ type: '数据异常', level: '严重问题', module: '核价库', desc: `核价记录型号${b.model}证书${b.certificate_level}单价异常: ¥${b.price_rmb}`, standard: '单价金额必须大于0', related: `BOM:${b.id}` });
    }
    // 成本完整性
    if (b.total_cost === null || b.total_cost === undefined) {
      issues.push({ type: '数据异常', level: '一般问题', module: '核价库', desc: `核价记录型号${b.model}缺少合计成本`, standard: '核价记录应有成本合计', related: `BOM:${b.id}` });
    }
  }

  // 库表联动自检：物料库与核价库关联
  const prodTable = getTable('products');
  const products = prodTable.all();
  for (const p of products) {
    // 产品型号在核价库中是否有对应记录
    const hasBom = bomRecords.find(b => b.model === p.external_model || b.model === p.internal_model);
    if (!hasBom && p.created_at) {
      const daysSinceCreation = (Date.now() - new Date(p.created_at)) / (1000 * 60 * 60 * 24);
      if (daysSinceCreation > 7) {
        issues.push({ type: '数据异常', level: '一般问题', module: '库表联动', desc: `产品${p.external_model}创建超过7天但核价库无对应记录`, standard: '产品应在合理时间内完成核价', related: p.external_model });
      }
    }
  }

  // 校验：BOM成本计算规则符合性（多层级BOM成本应只算顶层，父件含子件不重复累加）
  try {
    const bomItemsTable = getTable('bom_items');
    bomItemsTable._invalidate();
    const bomAll = bomItemsTable.all();
    const grouped = {};
    bomAll.forEach(b => {
      const c = b.product_code; if (!c) return;
      if (!grouped[c]) grouped[c] = { total: 0, top: 0, levels: new Set(), ids: [] };
      grouped[c].total += Number(b.total) || Number(b.amount) || 0;
      grouped[c].levels.add(b.level);
      const depth = (String(b.level || '').match(/\./g) || []).length;
      if (depth <= 1) grouped[c].top += Number(b.total) || Number(b.amount) || 0;
    });
    Object.entries(grouped).forEach(([code, g]) => {
      // 多层级产品：如果顶层成本为0但有明细，说明成本未按顶层汇总（规则不符）
      if (g.levels.size > 1 && g.top === 0 && g.total > 0) {
        issues.push({ type: '流程异常', level: '警示问题', module: 'BOM管理', desc: `产品${code}多层级BOM但顶层成本为0，成本未按顶层汇总`, standard: 'BOM成本应按顶层(level_depth=1)汇总，父件含子件不重复累加', related: code });
      }
    });
  } catch (e) { /* bom_items 表可能不存在，忽略 */ }

  // 校验：物料分类标准符合性（实际分类是否符合自动分类规则）
  try {
    const ruleTbl = getTable('classification_rules');
    const matTbl = getTable('materials');
    ruleTbl._invalidate(); matTbl._invalidate();
    const rules = ruleTbl.all().filter(r => r.enabled !== 0).sort((a, b) => (a.priority || 999) - (b.priority || 999));
    const mats = matTbl.all();
    let mismatch = 0; const examples = [];
    mats.forEach(m => {
      let target = '';
      for (const rule of rules) {
        const val = String(m[rule.field] || '');
        let match = false;
        if (rule.operator === 'equals') match = val === rule.value;
        else if (rule.operator === 'contains') match = val.includes(rule.value);
        else if (rule.operator === 'startsWith') match = val.startsWith(rule.value);
        else if (rule.operator === 'gte') match = val !== '' && Number(val) >= Number(rule.value);
        if (match) { target = rule.result_category; break; }
      }
      if (!target) target = '专用物料';
      if (target !== (m.classification || '') && examples.length < 5) { mismatch++; examples.push((m.material_code || '#' + m.id) + ':' + (m.classification || '空') + '→应' + target); }
      else if (target !== (m.classification || '')) mismatch++;
    });
    if (mismatch > 0) {
      const rate = ((mats.length - mismatch) / mats.length * 100).toFixed(1);
      const level = parseFloat(rate) >= 90 ? '一般问题' : '警示问题';
      issues.push({ type: '数据异常', level, module: '物料库', desc: `${mismatch}条物料分类(${rate}%符合率)与自动分类标准不符，示例: ${examples.join('; ')}`, standard: '物料分类应符合自动分类规则(自制/委外→定制, 标准件→通用, 复用≥3→常用, 默认→专用)', related: '物料分类' });
    }
  } catch (e) { /* 忽略 */ }

  return issues;
}

// 9.3.3 角色权限合规自检
async function checkPermission() {
  const issues = [];

  const permTable = getTable('permissions');
  const permissions = permTable.all();

  // 定义标准权限矩阵
  const standardPerms = {
    'sales': {
      should_have: ['inquiry:view', 'inquiry:create', 'inquiry:edit', 'inquiry:price', 'product:view', 'customer:view', 'customer:create', 'material:view', 'feedback:create'],
      should_not_have: ['pricing:edit', 'pricing:delete', 'permission:manage', 'settings:manage', 'inquiry:delete']
    },
    'engineer': {
      should_have: ['inquiry:view', 'pricing:view', 'pricing:edit', 'product:view', 'material:view', 'material:edit'],
      should_not_have: ['inquiry:delete', 'permission:manage', 'settings:manage', 'customer:delete']
    },
    'admin': {
      should_have: ['inquiry:view', 'inquiry:create', 'inquiry:edit', 'inquiry:delete', 'inquiry:price', 'product:view', 'product:edit', 'pricing:view', 'pricing:edit', 'customer:view', 'customer:create', 'customer:edit', 'customer:delete', 'material:view', 'material:edit', 'permission:manage', 'settings:manage', 'feedback:view', 'feedback:create'],
      should_not_have: []
    }
  };

  // 按角色分组检查
  const roleMap = {};
  for (const p of permissions) {
    if (!roleMap[p.role]) roleMap[p.role] = [];
    roleMap[p.role].push(p.permission);
  }

  for (const [role, standard] of Object.entries(standardPerms)) {
    const actualPerms = roleMap[role] || [];

    // 检查缺失权限
    for (const perm of standard.should_have) {
      if (!actualPerms.includes(perm)) {
        issues.push({ type: '权限异常', level: '警示问题', module: '权限管理', desc: `角色"${role}"缺少应有权限: ${perm}`, standard: `角色"${role}"应具备权限${perm}`, related: `ROLE:${role}` });
      }
    }

    // 检查越权权限
    for (const perm of standard.should_not_have) {
      if (actualPerms.includes(perm)) {
        issues.push({ type: '权限异常', level: '严重问题', module: '权限管理', desc: `角色"${role}"存在越权权限: ${perm}`, standard: `角色"${role}"不应具备权限${perm}`, related: `ROLE:${role}` });
      }
    }
  }

  // 检查销售是否能看到成本
  const salesPerms = roleMap['sales'] || [];
  if (salesPerms.includes('pricing:view') || salesPerms.includes('pricing:edit')) {
    issues.push({ type: '权限异常', level: '严重问题', module: '权限管理', desc: '销售人员拥有核价权限，违反成本保密规则', standard: '销售人员不应看到成本信息', related: 'ROLE:sales' });
  }

  return issues;
}

// 9.3.4 数据规范与日志自检
async function checkDataSpec() {
  const issues = [];

  // 校验客户数据完整性
  const custTable = getTable('customers');
  const customers = custTable.all();
  for (const c of customers) {
    if (!c.name) {
      issues.push({ type: '数据异常', level: '警示问题', module: '客户管理', desc: `客户ID=${c.id}缺少名称`, standard: '客户必须有名称', related: `CUST:${c.id}` });
    }
  }

  // 校验产品数据完整性
  const prodTable = getTable('products');
  const products = prodTable.all();
  for (const p of products) {
    if (!p.external_model) {
      issues.push({ type: '数据异常', level: '警示问题', module: '产品管理', desc: `产品ID=${p.id}缺少外部型号`, standard: '产品必须有外部型号', related: `PROD:${p.id}` });
    }
  }

  // 校验操作日志留痕
  const logTable = getTable('operation_logs');
  const logs = logTable.all();

  // 检查询价单创建是否有日志
  const inqTable = getTable('inquiries');
  const inquiries = inqTable.all();
  for (const inq of inquiries) {
    const hasLog = logs.find(l => (l.target_id == inq.id || l.inquiry_id == inq.id || l.target_id === inq.serial_number) && l.action && l.action.includes('创建'));
    if (!hasLog && inquiries.indexOf(inq) < 50) { // 只检查最近50条
      issues.push({ type: '日志异常', level: '一般问题', module: '日志管理', desc: `询价单${inq.serial_number}缺少创建操作日志`, standard: '所有操作应有日志留痕', related: inq.serial_number });
    }
  }

  // 校验报价库数据规范
  const quoteTable = getTable('quote_library');
  const quotes = quoteTable.all();
  for (const q of quotes) {
    if (!q.external_model) {
      issues.push({ type: '数据异常', level: '警示问题', module: '报价库', desc: `报价库记录ID=${q.id}缺少产品型号`, standard: '报价记录必须关联产品型号', related: `QUOTE:${q.id}` });
    }
    if (!q.price_rmb && !q.price_usd) {
      issues.push({ type: '数据异常', level: '警示问题', module: '报价库', desc: `报价库记录${q.external_model}缺少单价金额`, standard: '报价记录必须有单价金额', related: `QUOTE:${q.id}` });
    }
    if (!q.validity_days || q.validity_days <= 0) {
      issues.push({ type: '配置异常', level: '一般问题', module: '报价库', desc: `报价库记录${q.external_model}有效期配置异常: ${q.validity_days}`, standard: '报价有效期应大于0天', related: `QUOTE:${q.id}` });
    }
  }

  return issues;
}

// ===== 执行全量自检 =====
async function runFullCheck() {
  const startTime = Date.now();
  const allIssues = [];

  const flowIssues = await checkFlow();
  const dbIssues = await checkDatabase();
  const permIssues = await checkPermission();
  const dataIssues = await checkDataSpec();

  allIssues.push(...flowIssues, ...dbIssues, ...permIssues, ...dataIssues);

  // 自动判定问题等级
  for (const issue of allIssues) {
    if (!issue.level) {
      if (issue.type === '流程异常' || issue.type === '权限异常') issue.level = '严重问题';
      else if (issue.type === '数据异常') issue.level = '警示问题';
      else issue.level = '一般问题';
    }
  }

  // 生成自检报告
  const report = {
    check_time: now(),
    duration_ms: Date.now() - startTime,
    total_checks: 4,
    total_issues: allIssues.length,
    severe_count: allIssues.filter(i => i.level === '严重问题').length,
    warning_count: allIssues.filter(i => i.level === '警示问题').length,
    normal_count: allIssues.filter(i => i.level === '一般问题').length,
    flow_issues: flowIssues.length,
    database_issues: dbIssues.length,
    permission_issues: permIssues.length,
    data_issues: dataIssues.length,
    compliance_rate: allIssues.length === 0 ? '100.0' : ((1 - allIssues.filter(i => i.level === '严重问题').length / Math.max(allIssues.length, 1)) * 100).toFixed(1),
    issues: allIssues
  };

  // 保存报告
  const reportTable = getTable('compliance_reports');
  const result = reportTable.insert({
    check_time: report.check_time,
    duration_ms: report.duration_ms,
    total_issues: report.total_issues,
    severe_count: report.severe_count,
    warning_count: report.warning_count,
    normal_count: report.normal_count,
    compliance_rate: report.compliance_rate,
    summary: JSON.stringify({
      flow: flowIssues.length,
      database: dbIssues.length,
      permission: permIssues.length,
      data: dataIssues.length
    }),
    created_at: now()
  });

  // 问题自动入库
  const issueTable = getTable('compliance_issues');
  for (const issue of allIssues) {
    // 检查是否已存在相同问题（避免重复入库）
    const existing = issueTable.all().find(e =>
      e.type === issue.type && e.desc === issue.desc && e.status !== '已闭环'
    );
    if (!existing) {
      const assignee = issue.type === '权限异常' ? '管理员' :
                       issue.type === '流程异常' ? '研发' :
                       issue.type === '数据异常' ? '运维' : '管理员';
      issueTable.insert({
        issue_no: `CMP${Date.now()}${Math.floor(Math.random() * 1000)}`,
        type: issue.type,
        level: issue.level,
        module: issue.module || '询价模块',
        desc: issue.desc,
        standard: issue.standard || '',
        reason: '',
        related: issue.related || '',
        link: getIssueLink(issue),
        auto_fixable: isAutoFixable(issue) ? 1 : 0,
        assignee: assignee,
        status: '待整改',
        report_id: result.lastID,
        found_at: now(),
        deadline: new Date(Date.now() + 8*3600000 + (issue.level === '严重问题' ? 3 : issue.level === '警示问题' ? 7 : 14) * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 10),
        fix_measures: '',
        fix_at: null,
        reviewer: '',
        closed_at: null,
        created_at: now(),
        updated_at: now()
      });
    } else {
      const correctLink = getIssueLink(issue);
      const correctAutoFixable = isAutoFixable(issue) ? 1 : 0;
      const updates = { updated_at: now() };
      if (correctLink && existing.link !== correctLink) updates.link = correctLink;
      if (existing.auto_fixable !== correctAutoFixable) updates.auto_fixable = correctAutoFixable;
      if (Object.keys(updates).length > 1) {
        issueTable.update(existing.id, updates);
      }
    }
  }

  return { report_id: result.lastID, ...report };
}

// ===== API接口 =====

// 获取自检维度
router.get('/dimensions', requirePerm('compliance:view'), (req, res) => {
  res.json(CHECK_DIMENSIONS);
});

// 执行全量自检
router.post('/run', requirePerm('compliance:run'), async (req, res) => {
  try {
    const report = await runFullCheck();
    res.json({ message: '合规自检完成', report });
  } catch (e) {
    res.status(500).json({ error: '自检执行失败: ' + e.message });
  }
});

// 执行单维度自检
router.post('/run/:dimension', requirePerm('compliance:run'), async (req, res) => {
  const dim = req.params.dimension;
  let issues = [];
  try {
    switch (dim) {
      case 'flow': issues = await checkFlow(); break;
      case 'database': issues = await checkDatabase(); break;
      case 'permission': issues = await checkPermission(); break;
      case 'data': issues = await checkDataSpec(); break;
      default: return res.status(400).json({ error: '无效的自检维度' });
    }
    res.json({ dimension: CHECK_DIMENSIONS[dim], issues, count: issues.length });
  } catch (e) {
    res.status(500).json({ error: '自检执行失败: ' + e.message });
  }
});

// 获取自检报告列表
router.get('/reports', requirePerm('compliance:view'), (req, res) => {
  const table = getTable('compliance_reports');
  const reports = table.all().sort((a, b) => b.id - a.id).slice(0, 20);
  res.json(reports);
});

// 获取自检报告详情
router.get('/reports/:id', requirePerm('compliance:view'), (req, res) => {
  const table = getTable('compliance_reports');
  const report = table.findById(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });

  // 获取关联问题
  const issueTable = getTable('compliance_issues');
  const issues = issueTable.all().filter(i => i.report_id == req.params.id);

  res.json({ ...report, issues });
});

// 获取问题库列表
router.get('/issues', requirePerm('compliance:view'), (req, res) => {
  const table = getTable('compliance_issues');
  let issues = table.all().sort((a, b) => b.id - a.id);

  // 支持按状态筛选
  if (req.query.status) {
    issues = issues.filter(i => i.status === req.query.status);
  }
  // 支持按等级筛选
  if (req.query.level) {
    issues = issues.filter(i => i.level === req.query.level);
  }
  // 支持按类型筛选
  if (req.query.type) {
    issues = issues.filter(i => i.type === req.query.type);
  }

  res.json(issues);
});

// 获取问题详情
router.get('/issues/:id', requirePerm('compliance:view'), (req, res) => {
  const table = getTable('compliance_issues');
  const issue = table.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '问题不存在' });
  res.json(issue);
});

// 更新问题状态（整改闭环）
router.put('/issues/:id', requirePerm('compliance:run'), (req, res) => {
  const table = getTable('compliance_issues');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '问题不存在' });

  const { status, fix_measures, reviewer } = req.body;

  // 校验状态流转
  const validStatusFlow = {
    '待整改': ['整改中'],
    '整改中': ['待复核'],
    '待复核': ['已闭环', '整改中'],
    '已闭环': ['永久沉淀'],
    '永久沉淀': []
  };

  if (status && !validStatusFlow[existing.status]?.includes(status)) {
    return res.status(400).json({ error: `问题状态不允许从"${existing.status}"变更为"${status}"` });
  }

  const updates = { updated_at: now() };
  if (status) updates.status = status;
  if (fix_measures) updates.fix_measures = fix_measures;
  if (reviewer) updates.reviewer = reviewer;

  if (status === '整改中') updates.fix_at = null;
  if (status === '待复核') updates.fix_at = now();
  if (status === '已闭环') updates.closed_at = now();

  table.update(req.params.id, updates);
  res.json({ message: '问题状态更新成功', data: table.findById(req.params.id) });
});

// 获取问题统计
router.get('/stats', requirePerm('compliance:view'), (req, res) => {
  const table = getTable('compliance_issues');
  const issues = table.all();

  const stats = {
    total: issues.length,
    by_status: {},
    by_level: {},
    by_type: {},
    by_module: {}
  };

  for (const issue of issues) {
    stats.by_status[issue.status] = (stats.by_status[issue.status] || 0) + 1;
    stats.by_level[issue.level] = (stats.by_level[issue.level] || 0) + 1;
    stats.by_type[issue.type] = (stats.by_type[issue.type] || 0) + 1;
    stats.by_module[issue.module] = (stats.by_module[issue.module] || 0) + 1;
  }

  res.json(stats);
});

// ===== 自动处理 =====

// 自动处理单个问题
router.post('/issues/:id/auto-fix', requirePerm('compliance:run'), (req, res) => {
  const table = getTable('compliance_issues');
  const issue = table.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '问题不存在' });
  if (issue.status === '已闭环' || issue.status === '永久沉淀') {
    return res.status(400).json({ error: '该问题已闭环，无需处理' });
  }

  let fixed = false;
  let fixDetail = '';

  // 1. 权限缺失 → 自动补齐权限
  if (issue.type === '权限异常' && issue.desc.includes('缺少应有权限')) {
    const match = issue.desc.match(/角色"(\w+)"缺少应有权限:\s*(\S+)/);
    if (match) {
      const role = match[1];
      const perm = match[2];
      const permTable = getTable('permissions');
      const existing = permTable.all().find(p => p.role === role && p.permission === perm);
      if (!existing) {
        permTable.insert({ role, permission: perm, created_at: now() });
        fixed = true;
        fixDetail = `已自动为角色"${role}"添加权限"${perm}"`;
      }
    }
  }

  // 2. 越权权限 → 自动移除
  if (issue.type === '权限异常' && issue.desc.includes('越权权限')) {
    const match = issue.desc.match(/角色"(\w+)"存在越权权限:\s*(\S+)/);
    if (match) {
      const role = match[1];
      const perm = match[2];
      const permTable = getTable('permissions');
      const existing = permTable.all().find(p => p.role === role && p.permission === perm);
      if (existing) {
        permTable.delete(existing.id);
        fixed = true;
        fixDetail = `已自动移除角色"${role}"的越权权限"${perm}"`;
      }
    }
  }

  // 3. 销售越权核价 → 自动移除
  if (issue.type === '权限异常' && issue.desc.includes('核价权限') && issue.desc.includes('销售')) {
    const permTable = getTable('permissions');
    const salesPerms = permTable.all().filter(p => p.role === 'sales' && (p.permission === 'pricing:view' || p.permission === 'pricing:edit'));
    for (const sp of salesPerms) {
      permTable.delete(sp.id);
      fixed = true;
      fixDetail = `已自动移除销售人员的核价权限(${salesPerms.length}项)`;
    }
  }

  // 4. 报价时间缺失 → 自动补填
  if (issue.type === '流程异常' && issue.desc.includes('缺少报价时间')) {
    const match = issue.desc.match(/询价单(\S+)已报价但缺少报价时间/);
    if (match) {
      const sn = match[1];
      const inqTable = getTable('inquiries');
      const inq = inqTable.all().find(i => i.serial_number === sn);
      if (inq) {
        inqTable.update(inq.id, { quoted_at: inq.updated_at || now(), updated_at: now() });
        fixed = true;
        fixDetail = `已自动补填询价单${sn}的报价时间为${inq.updated_at || now()}`;
      }
    }
  }

  // 5. 报价库有效期异常 → 自动修复为30天
  if (issue.type === '配置异常' && issue.desc.includes('有效期配置异常')) {
    const match = issue.desc.match(/报价库记录(\S+)有效期/);
    if (match) {
      const model = match[1];
      const quoteTable = getTable('quote_library');
      const quote = quoteTable.all().find(q => q.external_model === model);
      if (quote) {
        quoteTable.update(quote.id, { validity_days: 30, updated_at: now() });
        fixed = true;
        fixDetail = `已自动修复报价库记录${model}有效期为30天`;
      }
    }
  }

  // 6. 核价记录关联询价单不存在 → 清理孤立核价记录的inquiry_no
  if (issue.type === '流程异常' && issue.desc.includes('关联询价单') && issue.desc.includes('不存在')) {
    const bomMatch = issue.desc.match(/核价记录关联询价单([A-Za-z0-9_-]+)不存在/);
    if (bomMatch) {
      const inqNo = bomMatch[1];
      const legacyInquiryPattern = /^\d{2}-\d{2,3}$/;
      if (legacyInquiryPattern.test(inqNo) || inqNo === '/') {
        fixed = true;
        fixDetail = `询价单${inqNo}为历史数据编号格式，已自动沉淀`;
      } else {
        const inqTable = getTable('inquiries');
        const inq = inqTable.all().find(i => i.serial_number === inqNo);
        if (inq) {
          fixed = true;
          fixDetail = `询价单${inqNo}已存在，问题已自动解决`;
        } else {
          const bomTable = getTable('bom_pricing');
          const orphans = bomTable.all().filter(b => b.inquiry_no === inqNo);
          if (orphans.length > 0) {
            orphans.forEach(b => {
              bomTable.update(b.id, { inquiry_no: '/', updated_at: now() });
            });
            fixed = true;
            fixDetail = `已清理${orphans.length}条关联询价单${inqNo}的孤立核价记录，inquiry_no置为"/"`;
          }
        }
      }
    }
    const quoteMatch = issue.desc.match(/报价库记录关联询价单ID=(\d+)不存在/);
    if (quoteMatch) {
      const inqId = parseInt(quoteMatch[1]);
      const inqTable = getTable('inquiries');
      const inq = inqTable.all().find(i => i.id === inqId);
      if (inq) {
        fixed = true;
        fixDetail = `询价单ID=${inqId}已存在，问题已自动解决`;
      } else {
        const quoteTable = getTable('quote_library');
        const orphans = quoteTable.all().filter(q => q.source_inquiry_id == inqId);
        if (orphans.length > 0) {
          orphans.forEach(q => { quoteTable.update(q.id, { source_inquiry_id: null, updated_at: now() }); });
          fixed = true;
          fixDetail = `清理${orphans.length}条关联询价单ID=${inqId}的孤立报价库记录`;
        }
      }
    }
  }

  // 7. 违规状态跳转 → 清理非法状态变更记录
  if (issue.type === '流程异常' && issue.desc.includes('违规状态跳转')) {
    const match = issue.desc.match(/询价单([A-Za-z0-9_-]+)违规状态跳转:\s*(\S+)→(\S+)/);
    if (match) {
      const sn = match[1];
      const fromStatus = match[2];
      const toStatus = match[3];
      const inqTable = getTable('inquiries');
      const inq = inqTable.all().find(i => i.serial_number === sn);
      if (inq) {
        const statusTable = getTable('inquiry_status_changes');
        const changes = statusTable.all().filter(c => c.inquiry_id === inq.id).sort((a, b) => a.id - b.id);
        const validTransitions = {
          'new': ['cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'lost'],
          'cert_configured': ['config_generated', 'pending_pricing', 'new', 'lost'],
          'config_generated': ['pending_pricing', 'cert_configured', 'new', 'lost'],
          'pending_pricing': ['pending_quote', 'quoted', 'config_generated', 'lost'],
          'pending_quote': ['quoted', 'config_generated', 'lost'],
          'quoted': ['negotiating', 'sample', 'project', 'closed', 'lost'],
          'negotiating': ['sample', 'project', 'lost', 'quoted', 'closed'],
          'sample': ['project', 'closed', 'lost'],
          'project': ['closed', 'lost'],
          'lost': ['new'],
          'closed': []
        };
        let deletedCount = 0;
        for (let i = 1; i < changes.length; i++) {
          const prev = changes[i - 1].status;
          const curr = changes[i].status;
          if (prev === curr || (validTransitions[prev] && !validTransitions[prev].includes(curr))) {
            statusTable.delete(changes[i].id);
            deletedCount++;
          }
        }
        if (deletedCount > 0) {
          fixed = true;
          fixDetail = `已清理询价单${sn}的${deletedCount}条非法状态变更记录`;
        }
      }
    }
  }

  // 8. 缺少创建操作日志 → 自动补录
  if (issue.type === '日志异常' && issue.desc.includes('缺少创建操作日志')) {
    const match = issue.desc.match(/询价单([A-Za-z0-9_-]+)缺少创建操作日志/);
    if (match) {
      const sn = match[1];
      const inqTable = getTable('inquiries');
      const inq = inqTable.all().find(i => i.serial_number === sn);
      if (inq) {
        const logTable = getTable('operation_logs');
        const existing = logTable.all().find(l =>
          (l.inquiry_id === inq.id || l.target_id === sn) &&
          l.action && l.action.includes('创建')
        );
        if (!existing) {
          logTable.insert({
            action: '创建询价',
            operator: inq.sales_person || 'system',
            detail: `补录: 询价单 ${sn} [${inq.status}]`,
            inquiry_id: inq.id,
            target_id: sn,
            created_at: inq.created_at || now()
          });
          fixed = true;
          fixDetail = `已为询价单${sn}补录创建操作日志`;
        }
      }
    }
  }

  if (fixed) {
    table.update(req.params.id, {
      status: '已闭环',
      fix_measures: `[自动处理] ${fixDetail}`,
      fix_at: now(),
      closed_at: now(),
      updated_at: now()
    });
    res.json({ message: '自动处理成功', detail: fixDetail, data: table.findById(req.params.id) });
  } else {
    res.json({ message: '该问题无法自动处理，需手动修复', auto_fixable: false });
  }
});

// 批量自动处理所有可自动修复的问题
router.post('/auto-fix-all', requirePerm('compliance:run'), (req, res) => {
  const table = getTable('compliance_issues');
  const issues = table.all().filter(i => i.auto_fixable == 1 && i.status === '待整改');

  let fixedCount = 0;
  let failedCount = 0;
  const details = [];

  for (const issue of issues) {
    // 复用单条自动处理逻辑
    let fixed = false;
    let fixDetail = '';

    if (issue.type === '权限异常' && issue.desc.includes('缺少应有权限')) {
      const match = issue.desc.match(/角色"(\w+)"缺少应有权限:\s*(\S+)/);
      if (match) {
        const permTable = getTable('permissions');
        const existing = permTable.all().find(p => p.role === match[1] && p.permission === match[2]);
        if (!existing) {
          permTable.insert({ role: match[1], permission: match[2], created_at: now() });
          fixed = true;
          fixDetail = `角色"${match[1]}"添加权限"${match[2]}"`;
        }
      }
    }

    if (issue.type === '权限异常' && issue.desc.includes('越权权限')) {
      const match = issue.desc.match(/角色"(\w+)"存在越权权限:\s*(\S+)/);
      if (match) {
        const permTable = getTable('permissions');
        const existing = permTable.all().find(p => p.role === match[1] && p.permission === match[2]);
        if (existing) {
          permTable.delete(existing.id);
          fixed = true;
          fixDetail = `移除角色"${match[1]}"越权权限"${match[2]}"`;
        }
      }
    }

    if (issue.type === '权限异常' && issue.desc.includes('核价权限') && issue.desc.includes('销售')) {
      const permTable = getTable('permissions');
      const salesPerms = permTable.all().filter(p => p.role === 'sales' && (p.permission === 'pricing:view' || p.permission === 'pricing:edit'));
      for (const sp of salesPerms) { permTable.delete(sp.id); fixed = true; }
      if (fixed) fixDetail = `移除销售人员核价权限(${salesPerms.length}项)`;
    }

    if (issue.type === '流程异常' && issue.desc.includes('缺少报价时间')) {
      const match = issue.desc.match(/询价单(\S+)已报价但缺少报价时间/);
      if (match) {
        const inqTable = getTable('inquiries');
        const inq = inqTable.all().find(i => i.serial_number === match[1]);
        if (inq) {
          inqTable.update(inq.id, { quoted_at: inq.updated_at || now(), updated_at: now() });
          fixed = true;
          fixDetail = `补填询价单${match[1]}报价时间`;
        }
      }
    }

    if (issue.type === '配置异常' && issue.desc.includes('有效期配置异常')) {
      const match = issue.desc.match(/报价库记录(\S+)有效期/);
      if (match) {
        const quoteTable = getTable('quote_library');
        const quote = quoteTable.all().find(q => q.external_model === match[1]);
        if (quote) {
          quoteTable.update(quote.id, { validity_days: 30, updated_at: now() });
          fixed = true;
          fixDetail = `修复报价库${match[1]}有效期`;
        }
      }
    }

    if (issue.type === '流程异常' && issue.desc.includes('关联询价单') && issue.desc.includes('不存在')) {
      const bomMatch = issue.desc.match(/核价记录关联询价单([A-Za-z0-9_-]+)不存在/);
      if (bomMatch) {
        const inqNo = bomMatch[1];
        const legacyInquiryPattern = /^\d{2}-\d{2,3}$/;
        if (legacyInquiryPattern.test(inqNo) || inqNo === '/') {
          fixed = true;
          fixDetail = `询价单${inqNo}为历史数据编号格式，已自动沉淀`;
        } else {
          const inqTable = getTable('inquiries');
          const inq = inqTable.all().find(i => i.serial_number === inqNo);
          if (inq) {
            fixed = true;
            fixDetail = `询价单${inqNo}已存在，问题已自动解决`;
          } else {
            const bomTable = getTable('bom_pricing');
            const orphans = bomTable.all().filter(b => b.inquiry_no === inqNo);
            if (orphans.length > 0) {
              orphans.forEach(b => { bomTable.update(b.id, { inquiry_no: '/', updated_at: now() }); });
              fixed = true;
              fixDetail = `清理${orphans.length}条关联询价单${inqNo}的孤立核价记录`;
            }
          }
        }
      }
      const quoteMatch = issue.desc.match(/报价库记录关联询价单ID=(\d+)不存在/);
      if (quoteMatch) {
        const inqId = parseInt(quoteMatch[1]);
        const inqTable = getTable('inquiries');
        const inq = inqTable.all().find(i => i.id === inqId);
        if (inq) {
          fixed = true;
          fixDetail = `询价单ID=${inqId}已存在，问题已自动解决`;
        } else {
          const quoteTable = getTable('quote_library');
          const orphans = quoteTable.all().filter(q => q.source_inquiry_id == inqId);
          if (orphans.length > 0) {
            orphans.forEach(q => { quoteTable.update(q.id, { source_inquiry_id: null, updated_at: now() }); });
            fixed = true;
            fixDetail = `清理${orphans.length}条关联询价单ID=${inqId}的孤立报价库记录`;
          }
        }
      }
    }

    if (issue.type === '流程异常' && issue.desc.includes('违规状态跳转')) {
      const match = issue.desc.match(/询价单([A-Za-z0-9_-]+)违规状态跳转:\s*(\S+)→(\S+)/);
      if (match) {
        const sn = match[1];
        const inqTable = getTable('inquiries');
        const inq = inqTable.all().find(i => i.serial_number === sn);
        if (inq) {
          const statusTable = getTable('inquiry_status_changes');
          const changes = statusTable.all().filter(c => c.inquiry_id === inq.id).sort((a, b) => a.id - b.id);
          const validTransitions = {
            'new': ['cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'lost'],
            'cert_configured': ['config_generated', 'pending_pricing', 'new', 'lost'],
            'config_generated': ['pending_pricing', 'cert_configured', 'new', 'lost'],
            'pending_pricing': ['pending_quote', 'quoted', 'config_generated', 'lost'],
            'pending_quote': ['quoted', 'config_generated', 'lost'],
            'quoted': ['negotiating', 'sample', 'project', 'closed', 'lost'],
            'negotiating': ['sample', 'project', 'lost', 'quoted', 'closed'],
            'sample': ['project', 'closed', 'lost'],
            'project': ['closed', 'lost'],
            'lost': ['new'],
            'closed': []
          };
          let deletedCount = 0;
          for (let i = 1; i < changes.length; i++) {
            const prev = changes[i - 1].status;
            const curr = changes[i].status;
            if (prev === curr || (validTransitions[prev] && !validTransitions[prev].includes(curr))) {
              statusTable.delete(changes[i].id);
              deletedCount++;
            }
          }
          if (deletedCount > 0) {
            fixed = true;
            fixDetail = `清理询价单${sn}的${deletedCount}条非法状态变更记录`;
          }
        }
      }
    }

    if (issue.type === '日志异常' && issue.desc.includes('缺少创建操作日志')) {
      const match = issue.desc.match(/询价单([A-Za-z0-9_-]+)缺少创建操作日志/);
      if (match) {
        const sn = match[1];
        const inqTable = getTable('inquiries');
        const inq = inqTable.all().find(i => i.serial_number === sn);
        if (inq) {
          const logTable = getTable('operation_logs');
          const existing = logTable.all().find(l =>
            (l.inquiry_id === inq.id || l.target_id === sn) &&
            l.action && l.action.includes('创建')
          );
          if (!existing) {
            logTable.insert({
              action: '创建询价',
              operator: inq.sales_person || 'system',
              detail: `补录: 询价单 ${sn} [${inq.status}]`,
              inquiry_id: inq.id,
              target_id: sn,
              created_at: inq.created_at || now()
            });
            fixed = true;
            fixDetail = `为询价单${sn}补录创建操作日志`;
          }
        }
      }
    }

    if (fixed) {
      table.update(issue.id, {
        status: '已闭环',
        fix_measures: `[自动处理] ${fixDetail}`,
        fix_at: now(),
        closed_at: now(),
        updated_at: now()
      });
      fixedCount++;
      details.push({ id: issue.id, desc: issue.desc, result: fixDetail });
    } else {
      failedCount++;
    }
  }

  res.json({
    message: `批量自动处理完成：成功${fixedCount}条，无法自动处理${failedCount}条`,
    fixed_count: fixedCount,
    failed_count: failedCount,
    total: issues.length,
    details
  });
});

// ===== 源头校验：检查问题源头是否已删除或处理 =====

// 校验单个问题的源头是否已消除
function checkIssueSourceResolved(issue) {
  const { type, desc, module, related } = issue;

  // 1. 权限异常 - 缺少应有权限 → 检查权限是否已存在
  if (type === '权限异常' && desc.includes('缺少应有权限')) {
    const match = desc.match(/角色"(\w+)"缺少应有权限:\s*(\S+)/);
    if (match) {
      const permTable = getTable('permissions');
      const exists = permTable.all().find(p => p.role === match[1] && p.permission === match[2]);
      if (exists) return { resolved: true, reason: `角色"${match[1]}"已有权限"${match[2]}"` };
    }
  }

  // 2. 权限异常 - 越权权限 → 检查越权权限是否已移除
  if (type === '权限异常' && desc.includes('越权权限')) {
    const match = desc.match(/角色"(\w+)"存在越权权限:\s*(\S+)/);
    if (match) {
      const permTable = getTable('permissions');
      const exists = permTable.all().find(p => p.role === match[1] && p.permission === match[2]);
      if (!exists) return { resolved: true, reason: `角色"${match[1]}"的越权权限"${match[2]}"已移除` };
    }
  }

  // 3. 权限异常 - 销售核价越权 → 检查是否已移除
  if (type === '权限异常' && desc.includes('核价权限') && desc.includes('销售')) {
    const permTable = getTable('permissions');
    const salesPricing = permTable.all().filter(p => p.role === 'sales' && (p.permission === 'pricing:view' || p.permission === 'pricing:edit'));
    if (salesPricing.length === 0) return { resolved: true, reason: '销售人员核价权限已移除' };
  }

  // 4. 流程异常 - 缺少报价时间 → 检查是否已补填
  if (type === '流程异常' && desc.includes('缺少报价时间')) {
    const match = desc.match(/询价单([A-Za-z0-9_-]+)已报价但缺少报价时间/);
    if (match) {
      const inqTable = getTable('inquiries');
      const inq = inqTable.all().find(i => i.serial_number === match[1]);
      if (inq && inq.quoted_at) return { resolved: true, reason: `询价单${match[1]}报价时间已补填` };
      // 询价单本身已删除
      if (!inq) return { resolved: true, reason: `询价单${match[1]}已删除，问题源头不存在` };
    }
  }

  // 5. 配置异常 - 有效期配置异常 → 检查是否已修复
  if (type === '配置异常' && desc.includes('有效期配置异常')) {
    const match = desc.match(/报价库记录(\S+)有效期/);
    if (match) {
      const quoteTable = getTable('quote_library');
      const quote = quoteTable.all().find(q => q.external_model === match[1]);
      if (quote && quote.validity_days && quote.validity_days > 0) return { resolved: true, reason: `报价库${match[1]}有效期已修复为${quote.validity_days}天` };
      if (!quote) return { resolved: true, reason: `报价库记录${match[1]}已删除，问题源头不存在` };
    }
  }

  // 6. 流程异常 - 违规状态跳转 → 检查询价单当前状态是否已修正
  if (type === '流程异常' && desc.includes('违规状态跳转')) {
    const match = desc.match(/询价单([A-Za-z0-9_-]+)违规状态跳转/);
    if (match) {
      const inqTable = getTable('inquiries');
      const inq = inqTable.all().find(i => i.serial_number === match[1]);
      if (!inq) return { resolved: true, reason: `询价单${match[1]}已删除，问题源头不存在` };
      // 检查当前状态是否已不再是违规状态
      const match2 = desc.match(/状态(\S+)仅允许跳转至:\s*(\S+)/);
      if (match2) {
        const fromStatus = match2[1];
        if (inq.status !== fromStatus) return { resolved: true, reason: `询价单${match[1]}状态已从${fromStatus}变更为${inq.status}` };
      }
    }
  }

  // 7. 流程异常 - 核价记录关联询价单不存在 → 检查询价单是否已创建或核价记录已删除
  if (type === '流程异常' && desc.includes('关联询价单') && desc.includes('不存在')) {
    const match = desc.match(/关联询价单([A-Za-z0-9_-]+)/);
    if (match) {
      const legacyInquiryPattern = /^\d{2}-\d{2,3}$/;
      if (legacyInquiryPattern.test(match[1]) || match[1] === '/') {
        return { resolved: true, reason: `询价单${match[1]}为历史数据编号格式，已自动沉淀` };
      }
      const inqTable = getTable('inquiries');
      const inq = inqTable.all().find(i => i.serial_number === match[1]);
      if (inq) return { resolved: true, reason: `询价单${match[1]}已创建` };
      // 检查核价记录是否已删除
      const bomTable = getTable('bom_pricing');
      const bom = bomTable.all().find(b => b.inquiry_no === match[1]);
      if (!bom) return { resolved: true, reason: `关联核价记录已删除，问题源头不存在` };
    }
  }

  // 8. 数据异常 - 物料缺少分类/名称 → 检查物料是否已补全或删除
  if (type === '数据异常' && desc.includes('物料') && (desc.includes('缺少分类') || desc.includes('缺少名称'))) {
    const match = desc.match(/物料ID=(\d+)缺少(分类|名称)/) || desc.match(/物料"(\d+)"缺少(分类|名称)/);
    if (match) {
      const matTable = getTable('materials');
      const mat = matTable.findById(parseInt(match[1]));
      if (!mat) return { resolved: true, reason: `物料ID=${match[1]}已删除，问题源头不存在` };
      const mName = mat.material_name || mat.name;
      if (match[2] === '分类' && (mat.category || mat.material_code)) return { resolved: true, reason: `物料ID=${match[1]}已补充分类` };
      if (match[2] === '名称' && mName && mName !== 'undefined') return { resolved: true, reason: `物料ID=${match[1]}已补充名称` };
    }
  }

  // 9. 日志异常 - 缺少操作日志 → 检查日志是否已补录或单据已删除
  if (type === '日志异常' && desc.includes('缺少') && desc.includes('操作日志')) {
    const match = desc.match(/询价单([A-Za-z0-9_-]+)缺少创建操作日志/);
    if (match) {
      const inqTable = getTable('inquiries');
      const inq = inqTable.all().find(i => i.serial_number === match[1]);
      if (!inq) return { resolved: true, reason: `询价单${match[1]}已删除，问题源头不存在` };
      // 检查日志是否已补录（兼容多种字段名和action值）
      const logTable = getTable('operation_logs');
      if (logTable) {
        const log = logTable.all().find(l =>
          (l.inquiry_id === inq.id || l.target_id === match[1]) &&
          (l.action === 'create' || l.action === '新增' || l.action === '创建询价' || l.action.includes('创建'))
        );
        if (log) return { resolved: true, reason: `询价单${match[1]}操作日志已补录` };
      }
    }
  }

  // 10. 数据异常 - 客户/产品数据缺失 → 检查是否已补全或删除
  if (type === '数据异常' && module === '客户管理' && desc.includes('缺少')) {
    const match = desc.match(/客户"(\S+)"缺少/);
    if (match) {
      const custTable = getTable('customers');
      const cust = custTable.all().find(c => c.name === match[1]);
      if (!cust) return { resolved: true, reason: `客户"${match[1]}"已删除，问题源头不存在` };
    }
  }

  // 11. 通用 - related字段关联的记录已删除
  if (related) {
    const idMatch = related.match(/ID:(\d+)/) || related.match(/BOM:(\d+)/) || related.match(/MAT:(\d+)/) || related.match(/QUOTE:(\d+)/);
    if (idMatch) {
      const tableMap = {
        '询价模块': 'inquiries',
        '物料库': 'materials',
        '核价库': 'bom_pricing',
        '报价库': 'quote_library',
        '客户管理': 'customers',
        '产品管理': 'products'
      };
      const tableName = tableMap[module];
      if (tableName) {
        try {
          const sourceTable = getTable(tableName);
          const record = sourceTable.findById(parseInt(idMatch[1]));
          if (!record) return { resolved: true, reason: `${module}中ID=${idMatch[1]}的记录已删除，问题源头不存在` };
          if (module === '核价库' && desc.includes('缺少单价') && (record.price_rmb || record.price_usd)) {
            return { resolved: true, reason: `核价记录ID=${idMatch[1]}已补充单价` };
          }
          if (module === '核价库' && desc.includes('缺少合计成本') && record.total_cost) {
            return { resolved: true, reason: `核价记录ID=${idMatch[1]}已补充合计成本` };
          }
        } catch(e) { /* 表不存在则跳过 */ }
      }
    }
  }

  return { resolved: false, reason: '' };
}

// 单条源头校验API
router.post('/issues/:id/check-source', requirePerm('compliance:run'), (req, res) => {
  const table = getTable('compliance_issues');
  const issue = table.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '问题不存在' });
  if (issue.status === '已闭环' || issue.status === '永久沉淀') {
    return res.json({ resolved: false, reason: '问题已闭环' });
  }

  const result = checkIssueSourceResolved(issue);
  if (result.resolved) {
    table.update(req.params.id, {
      status: '已闭环',
      fix_measures: `[源头已消除] ${result.reason}`,
      fix_at: now(),
      closed_at: now(),
      updated_at: now()
    });
    res.json({ resolved: true, reason: result.reason, message: '问题源头已消除，自动关闭', data: table.findById(req.params.id) });
  } else {
    res.json({ resolved: false, reason: '问题源头仍存在，需继续整改' });
  }
});

// 批量源头校验API - 检查所有未闭环问题
router.post('/check-sources', requirePerm('compliance:run'), (req, res) => {
  const table = getTable('compliance_issues');
  const issues = table.all().filter(i => i.status !== '已闭环' && i.status !== '永久沉淀');

  let closedCount = 0;
  let openCount = 0;
  const details = [];

  for (const issue of issues) {
    const result = checkIssueSourceResolved(issue);
    if (result.resolved) {
      table.update(issue.id, {
        status: '已闭环',
        fix_measures: `[源头已消除] ${result.reason}`,
        fix_at: now(),
        closed_at: now(),
        updated_at: now()
      });
      closedCount++;
      details.push({ id: issue.id, desc: issue.desc.substring(0, 50), result: result.reason });
    } else {
      openCount++;
    }
  }

  res.json({
    message: `源头校验完成：自动关闭${closedCount}条（源头已消除），仍需整改${openCount}条`,
    closed_count: closedCount,
    open_count: openCount,
    total: issues.length,
    details
  });
});

// ===== 修复问题链接 =====
router.post('/fix-links', requirePerm('compliance:run'), (req, res) => {
  const table = getTable('compliance_issues');
  table._invalidate();
  const issues = table.all();
  let fixed = 0;
  issues.forEach(issue => {
    const correctLink = getIssueLink(issue);
    if (correctLink && issue.link !== correctLink) {
      table.update(issue.id, { link: correctLink, updated_at: now() });
      fixed++;
    }
  });
  res.json({
    message: `链接修复完成，修正${fixed}条问题链接`,
    fixed,
    total: issues.length
  });
});

module.exports = router;