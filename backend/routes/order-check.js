const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const { loadRules, runChecksBatch } = require('../lib/order-check-runner');

const RULES_FILE = path.join(__dirname, '..', '..', 'database', 'order_check_rules.json');
const ISSUES_FILE = path.join(__dirname, '..', '..', 'database', 'order_check_issues.json');
const LAST_RUN_FILE = () => path.join(__dirname, '..', '..', 'database', 'order_check_lastrun.json');

let _issuesCache = null;
function loadIssuesFromDisk() {
  try {
    const data = JSON.parse(fs.readFileSync(ISSUES_FILE, 'utf8'));
    const nextId = data.nextId || 1;
    return { records: data.records || [], nextId };
  } catch (e) {
    return { records: [], nextId: 1 };
  }
}
function saveIssuesToDisk(data) {
  fs.writeFileSync(ISSUES_FILE, JSON.stringify(data), 'utf8');
}
function getIssues() {
  if (!_issuesCache) _issuesCache = loadIssuesFromDisk();
  return _issuesCache;
}
function persistIssuesAsync() {
  if (!_issuesCache) return Promise.resolve();
  const data = _issuesCache;
  return fs.promises.writeFile(ISSUES_FILE, JSON.stringify(data), 'utf8').catch(e => {
    console.error('[order-check] persist error:', e.message);
  });
}
function persistIssues() {
  if (_issuesCache) saveIssuesToDisk(_issuesCache);
}
function pruneIssues(cap = 2000) {
  if (!_issuesCache) return;
  const keep = [];
  const closed = [];
  for (const r of _issuesCache.records) {
    if (r.status === 'open' || r.status === 'in_progress') keep.push(r);
    else closed.push(r);
  }
  closed.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  _issuesCache.records = [...keep, ...closed.slice(0, cap)];
}

function _dropCache(){ _issuesCache = null; }
function setIssueCache(data){ _issuesCache = data; }

function dedupeByKey(issues) {
  const map = new Map();
  for (const i of issues) {
    const key = `${i.rule_id}::${i.target_id || i.scope + ':' + (i.target_code || '')}`;
    const prev = map.get(key);
    if (!prev) map.set(key, i);
    else if (i.detected_at > prev.detected_at) map.set(key, i);
  }
  return [...map.values()];
}

router.post('/run', requirePerm('order-analysis:view'), async (req, res) => {
  try {
    const rulesDoc = loadRules();
    const orderTable = getTable('orders');
    const bomTable = getTable('order_bom_details');
    orderTable._invalidate();
    bomTable._invalidate();
    const orders = orderTable.all();
    const bomDetails = bomTable.all();
    const select = {
      ruleIds: Array.isArray(req.body.rule_ids) ? req.body.rule_ids : undefined,
      categories: Array.isArray(req.body.categories) ? req.body.categories : undefined,
      excludeRuleIds: Array.isArray(req.body.exclude_rule_ids) ? req.body.exclude_rule_ids : undefined
    };

    const issues = await runChecksBatch(orders, bomDetails, rulesDoc, 500, select);
    const deduped = dedupeByKey(issues);

    const issuesStore = getIssues();
    const existing = issuesStore.records;
    const existingMap = new Map();
    const indexKey = (it) => `${it.rule_id}::${it.target_id || (it.scope + ':' + (it.target_code || ''))}`;
    existing.forEach(e => existingMap.set(indexKey(e), e));

    let created = 0, reopened = 0, kept = 0;
    for (const issue of deduped) {
      const prev = existingMap.get(indexKey(issue));
      const payload = {
        rule_id: issue.rule_id, rule_name: issue.rule_name, severity: issue.severity,
        scope: issue.scope, target_id: issue.target_id, target_code: issue.target_code,
        description: issue.description, current_value: issue.current_value,
        suggested_action: issue.suggested_action, detected_at: issue.detected_at
      };
      if (!prev) {
        const id = issuesStore.nextId++;
        issuesStore.records.push(Object.assign({ id, status: 'open', assignee: '', due_date: '', created_at: issue.detected_at, updated_at: issue.detected_at }, payload));
        existingMap.set(indexKey(issue), issuesStore.records[issuesStore.records.length - 1]);
        created++;
      } else if (prev.status === 'resolved' || prev.status === 'ignored') {
        Object.assign(prev, { status: 'open', detected_at: issue.detected_at, description: issue.description, suggested_action: issue.suggested_action, updated_at: issue.detected_at });
        reopened++;
      } else {
        Object.assign(prev, { description: issue.description, suggested_action: issue.suggested_action, detected_at: issue.detected_at, updated_at: issue.detected_at });
        kept++;
      }
    }
    pruneIssues();
    persistIssuesAsync();

    const report = {
      last_run: now(), trigger: 'manual',
      orders_scanned: orders.length, bom_scanned: bomDetails.length,
      issues_found: deduped.length, issues_created: created, issues_reopened: reopened, issues_kept: kept,
      by_severity: deduped.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, {}),
      scope: {
        rule_ids: select.ruleIds || 'all',
        categories: select.categories || 'all',
        exclude_rule_ids: select.excludeRuleIds || []
      },
      rules_executed: new Set(deduped.map(d=>d.rule_id)).size
    };
    try { fs.writeFileSync(LAST_RUN_FILE(), JSON.stringify(report, null, 2)); } catch (e) {}
    res.json(Object.assign({ message: `自检完成：扫描 ${orders.length} 条订单 / ${bomDetails.length} 行BOM明细，新增 ${created} 个问题，重开 ${reopened} 个，更新 ${kept} 个` }, report));
  } catch (e) { res.status(500).json({ error: '自检执行失败: ' + e.message }); }
});

router.post('/preview', requirePerm('order-analysis:view'), async (req, res) => {
  try {
    const rulesDoc = loadRules();
    const orderTable = getTable('orders');
    const bomTable = getTable('order_bom_details');
    orderTable._invalidate(); bomTable._invalidate();
    const orders = orderTable.all();
    const bomDetails = bomTable.all();
    const limit = Number(req.body.limit) || 100;
    const select = {
      ruleIds: Array.isArray(req.body.rule_ids) ? req.body.rule_ids : undefined,
      categories: Array.isArray(req.body.categories) ? req.body.categories : undefined,
      excludeRuleIds: Array.isArray(req.body.exclude_rule_ids) ? req.body.exclude_rule_ids : undefined
    };
    const issues = await runChecksBatch(orders, bomDetails, rulesDoc, 500, select);
    const deduped = dedupeByKey(issues).slice(0, limit);
    res.json({ issues: deduped, total_found: issues.length, orders_scanned: orders.length, bom_scanned: bomDetails.length });
  } catch (e) { res.status(500).json({ error: '试运行失败: ' + e.message }); }
});

router.get('/issues', requirePerm('order-analysis:view'), async (req, res) => {
  try {
    const store = getIssues();
    let items = store.records || [];
    const status = req.query.status || '';
    const severity = req.query.severity || '';
    const ruleId = req.query.rule_id || '';
    const q = (req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const ps = Math.min(9999, Math.max(10, Number(req.query.page_size) || 50));

    if (status) items = items.filter(i => i.status === status);
    if (severity) items = items.filter(i => i.severity === severity);
    if (ruleId) items = items.filter(i => i.rule_id === ruleId);
    if (q) items = items.filter(i => (i.target_code || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q));

    const total = items.length;
    items = items.slice((page - 1) * ps, page * ps);
    res.json({ issues: items, total, page, page_size: ps });
  } catch (e) { res.status(500).json({ error: '查询失败: ' + e.message }); }
});

router.get('/issues/:id', requirePerm('order-analysis:view'), async (req, res) => {
  try {
    const store = getIssues();
    const item = (store.records || []).find(i => i.id === Number(req.params.id));
    if (!item) return res.status(404).json({ error: '未找到' });
    res.json(item);
  } catch (e) { res.status(500).json({ error: '查询失败: ' + e.message }); }
});

router.put('/issues/:id', requirePerm('order-analysis:edit'), async (req, res) => {
  try {
    const store = getIssues();
    const item = (store.records || []).find(i => i.id === Number(req.params.id));
    if (!item) return res.status(404).json({ error: '未找到' });
    const updatable = ['status', 'assignee', 'due_date', 'comment', 'resolution'];
    updatable.forEach(k => {
      if (req.body[k] !== undefined) item[k] = req.body[k];
    });
    item.updated_at = now();
    persistIssues();
    res.json(item);
  } catch (e) { res.status(500).json({ error: '更新失败: ' + e.message }); }
});

router.delete('/issues/:id', requirePerm('order-analysis:edit'), async (req, res) => {
  try {
    const store = getIssues();
    const idx = (store.records || []).findIndex(i => i.id === Number(req.params.id));
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    store.records.splice(idx, 1);
    persistIssues();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: '删除失败: ' + e.message }); }
});

router.post('/issues/batch', requirePerm('order-analysis:edit'), async (req, res) => {
  try {
    const store = getIssues();
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const updatable = ['status', 'assignee'];
    let cnt = 0;
    for (const id of ids) {
      const item = (store.records || []).find(i => i.id === Number(id));
      if (!item) continue;
      updatable.forEach(k => {
        if (req.body[k] !== undefined) item[k] = req.body[k];
      });
      item.updated_at = now();
      cnt++;
    }
    persistIssues();
    res.json({ updated: cnt });
  } catch (e) { res.status(500).json({ error: '批量更新失败: ' + e.message }); }
});

router.get('/rules', requirePerm('order-analysis:view'), async (req, res) => {
  try {
    const doc = loadRules();
    res.json(doc);
  } catch (e) { res.status(500).json({ error: '加载规则失败: ' + e.message }); }
});

router.put('/rules/:id', requirePerm('order-analysis:edit'), async (req, res) => {
  try {
    const doc = loadRules();
    const rule = (doc.rules || []).find(r => r.id === req.params.id);
    if (!rule) return res.status(404).json({ error: '未找到规则' });
    const updatable = ['enabled', 'severity', 'name', 'description', 'remediation'];
    updatable.forEach(k => {
      if (req.body[k] !== undefined) rule[k] = req.body[k];
    });
    doc.updated_at = now();
    fs.writeFileSync(RULES_FILE, JSON.stringify(doc, null, 2), 'utf8');
    res.json(rule);
  } catch (e) { res.status(500).json({ error: '更新规则失败: ' + e.message }); }
});

router.get('/stats', requirePerm('order-analysis:view'), async (req, res) => {
  try {
    const store = getIssues();
    const items = store.records || [];
    const stats = {
      total: items.length,
      by_status: { open: 0, in_progress: 0, resolved: 0, ignored: 0, wont_fix: 0 },
      by_severity: { critical: 0, high: 0, medium: 0, low: 0 }
    };
    for (const i of items) {
      stats.by_status[i.status] = (stats.by_status[i.status] || 0) + 1;
      stats.by_severity[i.severity] = (stats.by_severity[i.severity] || 0) + 1;
    }
    let lastRun = null;
    try { lastRun = JSON.parse(fs.readFileSync(LAST_RUN_FILE(), 'utf8')); } catch (e) {}
    res.json(Object.assign(stats, { last_run: lastRun }));
  } catch (e) { res.status(500).json({ error: '统计失败: ' + e.message }); }
});

router.post('/fix/:id', requirePerm('order-analysis:edit'), async (req, res) => {
  try {
    const store = getIssues();
    const issue = (store.records || []).find(i => i.id === Number(req.params.id));
    if (!issue) return res.status(404).json({ error: '未找到问题' });
    
    const rulesDoc = loadRules();
    const rule = (rulesDoc.rules || []).find(r => r.id === issue.rule_id);
    if (!rule || !rule.auto_fix) return res.status(400).json({ error: '该规则不支持自动修复' });

    const result = await applyFix(rule, issue, rulesDoc);
    if (result.success) {
      issue.status = 'resolved';
      issue.resolution = result.message;
      issue.updated_at = now();
      persistIssues();
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: '修复失败: ' + e.message }); }
});

async function applyFix(rule, issue, rulesDoc) {
  if (rule.auto_fix === 'set_default_cost') {
    const bomTable = getTable('order_bom_details');
    bomTable._invalidate();
    const row = bomTable.findById(issue.target_id);
    if (!row) return { success: false, message: '未找到BOM明细行' };
    if (!row.purchase_confirm_cost && row.material_amount) {
      row.purchase_confirm_cost = row.material_amount;
      bomTable.save();
      return { success: true, message: `采购确认成本已设为物料成本 ${row.material_amount}` };
    }
    return { success: false, message: '采购确认成本已有值或物料成本为空' };
  }
  return { success: false, message: '不支持的修复类型' };
}

module.exports = router;