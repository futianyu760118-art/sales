const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const { loadRules, runChecksBatch } = require('../lib/material-check-runner');

const RULES_FILE = path.join(__dirname, '..', '..', 'database', 'material_check_rules.json');
const ISSUES_FILE = path.join(__dirname, '..', '..', 'database', 'material_check_issues.json');
const LAST_RUN_FILE = () => path.join(__dirname, '..', '..', 'database', 'material_check_lastrun.json');

// 自检问题表：100K+ 行起步，改用专属内存缓存
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
  fs.writeFileSync(ISSUES_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function getIssues() {
  if (!_issuesCache) _issuesCache = loadIssuesFromDisk();
  return _issuesCache;
}
function persistIssues() {
  if (_issuesCache) saveIssuesToDisk(_issuesCache);
  // 注意：不要清缓存，否则大表每次都从 15MB JSON 重新加载
}

// 索引已禁用 - 使用内存对象
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

// 执行自检并把 issue 写入数据库。新发现的 (open 状态未存在的) 才插入；已 resolved 的若再次触发会自动 reopen
// 使用分批异步版：每次只处理 500 条物料后 setImmediate 让出，避免长任务卡死服务
// body: { rule_ids?:string[], categories?:string[], exclude_rule_ids?:string[] }
//       任一参数缺省/空 时跑所有已启用规则
router.post('/run', requirePerm('material:view'), async (req, res) => {
  try {
    const rulesDoc = loadRules();
    const matTable = getTable('materials');
    const bomTable = getTable('product_bom');
    matTable._invalidate();
    bomTable._invalidate();
    const materials = matTable.all();
    const bomItems = bomTable.all();
    const select = {
      ruleIds: Array.isArray(req.body.rule_ids) ? req.body.rule_ids : undefined,
      categories: Array.isArray(req.body.categories) ? req.body.categories : undefined,
      excludeRuleIds: Array.isArray(req.body.exclude_rule_ids) ? req.body.exclude_rule_ids : undefined
    };

    const issues = await runChecksBatch(materials, bomItems, rulesDoc, 500, select);
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
    // 异步持久化，不阻塞响应
    await new Promise((resolve, reject) => {
      persistIssues();
      process.nextTick(resolve);
    });

    const report = {
      last_run: now(), trigger: 'manual',
      materials_scanned: materials.length, bom_scanned: bomItems.length,
      issues_found: deduped.length, issues_created: created, issues_reopened: reopened, issues_kept: kept,
      by_severity: deduped.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, {}),
      scope: {
        rule_ids: select.ruleIds || 'all',
        categories: select.categories || 'all',
        exclude_rule_ids: select.excludeRuleIds || []
      },
      rules_executed: dedupeByKey ? new Set(deduped.map(d=>d.rule_id)).size : 0
    };
    try { fs.writeFileSync(LAST_RUN_FILE(), JSON.stringify(report, null, 2)); } catch (e) {}
    res.json(Object.assign({ message: `自检完成：扫描 ${materials.length} 条物料 / ${bomItems.length} 行 BOM，新增 ${created} 个问题，重开 ${reopened} 个，更新 ${kept} 个` }, report));
  } catch (e) { res.status(500).json({ error: '自检执行失败: ' + e.message }); }
});

// 试运行自检：返回将生成的问题清单，但不写库
// body: { rule_ids?:string[], categories?:string[], exclude_rule_ids?:string[], limit?:number }
router.post('/preview', requirePerm('material:view'), async (req, res) => {
  try {
    const rulesDoc = loadRules();
    const matTable = getTable('materials');
    const bomTable = getTable('product_bom');
    matTable._invalidate(); bomTable._invalidate();
    const materials = matTable.all();
    const bomItems = bomTable.all();
    const select = {
      ruleIds: Array.isArray(req.body.rule_ids) ? req.body.rule_ids : undefined,
      categories: Array.isArray(req.body.categories) ? req.body.categories : undefined,
      excludeRuleIds: Array.isArray(req.body.exclude_rule_ids) ? req.body.exclude_rule_ids : undefined
    };
    const t0 = Date.now();
    const allIssues = await runChecksBatch(materials, bomItems, rulesDoc, 500, select);
    const deduped = dedupeByKey(allIssues);
    const limit = Math.min(parseInt(req.body.limit) || 200, 5000);
    const bySeverity = deduped.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, {});
    const byRule = {};
    for (const i of deduped) byRule[i.rule_id] = (byRule[i.rule_id] || 0) + 1;
    res.json({
      total: deduped.length,
      by_severity: bySeverity,
      by_rule: byRule,
      rules_executed: new Set(deduped.map(d => d.rule_id)).size,
      materials_scanned: materials.length,
      elapsed_ms: Date.now() - t0,
      preview: deduped.slice(0, limit)
    });
  } catch (e) { res.status(500).json({ error: '试运行失败: ' + e.message }); }
});

// 列出问题
router.get('/issues', requirePerm('material:view'), (req, res) => {
  const { status, severity, rule_id, scope, q } = req.query;
  const store = getIssues();
  let list = store.records;
  if (status) list = list.filter(i => i.status === status);
  if (severity) list = list.filter(i => i.severity === severity);
  if (rule_id) list = list.filter(i => i.rule_id === rule_id);
  if (scope) list = list.filter(i => i.scope === scope);
  if (q) {
    const k = String(q).toLowerCase();
    list = list.filter(i =>
      String(i.target_code || '').toLowerCase().includes(k) ||
      String(i.description || '').toLowerCase().includes(k) ||
      String(i.assignee || '').toLowerCase().includes(k)
    );
  }
  res.json({ total: list.length, data: list });
});

// 统计概览
router.get('/issues/stats', requirePerm('material:view'), (req, res) => {
  const all = getIssues().records;
  const byStatus = {};
  const bySeverity = {};
  const byRule = {};
  for (const i of all) {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
    byRule[i.rule_id] = byRule[i.rule_id] || { total: 0, open: 0 };
    byRule[i.rule_id].total++;
    if (i.status === 'open' || i.status === 'in_progress') byRule[i.rule_id].open++;
  }
  let lastRun = null;
  try { lastRun = JSON.parse(fs.readFileSync(LAST_RUN_FILE(), 'utf8')); } catch (e) {}
  res.json({ total: all.length, byStatus, bySeverity, byRule, lastRun });
});

// 更新问题（状态、指派人、备注等）
router.patch('/issues/:id', requirePerm('material:edit'), (req, res) => {
  const id = Number(req.params.id);
  const store = getIssues();
  const row = store.records.find(r => r.id === id);
  if (!row) return res.status(404).json({ error: '问题不存在' });
  ['status', 'assignee', 'due_date', 'resolution_notes'].forEach(k => {
    if (req.body[k] !== undefined) row[k] = req.body[k];
  });
  if (req.body.status === 'resolved') row.resolved_at = now();
  if (req.body.status && req.body.status !== 'resolved') row.resolved_at = '';
  row.updated_at = now();
  persistIssues();
  res.json({ message: '已更新', data: row });
});

// 批量更新（用于勾选多条批量标记等）
router.post('/issues/batch', requirePerm('material:edit'), (req, res) => {
  const { ids, status, assignee } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids 必须为非空数组' });
  const store = getIssues();
  const ts = now();
  let n = 0;
  for (const id of ids) {
    const row = store.records.find(r => r.id === Number(id));
    if (!row) continue;
    if (status) {
      row.status = status;
      row.resolved_at = status === 'resolved' ? ts : '';
    }
    if (assignee !== undefined) row.assignee = assignee;
    row.updated_at = ts;
    n++;
  }
  if (n) persistIssues();
  res.json({ message: `批量更新 ${n} 条`, updated: n });
});

// 列出规则定义
router.get('/rules', requirePerm('material:view'), (req, res) => {
  res.json(loadRules());
});

// 启停规则
router.patch('/rules/:id', requirePerm('material:edit'), (req, res) => {
  const rules = loadRules();
  const rule = (rules.rules || []).find(r => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: '规则不存在' });
  if (typeof req.body.enabled === 'boolean') rule.enabled = req.body.enabled;
  rules.updated_at = now();
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
  res.json({ message: '已更新', rule });
});

// 一次性自动修复（执行规则上声明的 auto_fix）
router.post('/auto-fix', requirePerm('material:edit'), (req, res) => {
  const rulesDoc = loadRules();
  const rule = (rulesDoc.rules || []).find(r => r.id === req.body.rule_id);
  if (!rule || !rule.auto_fix) return res.status(400).json({ error: '该规则无可自动修复' });

  const matTable = getTable('materials');
  matTable._invalidate();
  const materials = matTable.all();
  const ts = now();
  let updated = 0;

  if (rule.auto_fix === 'unify_unit') {
    // 加载 unit_unify 映射
    const us = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'material_unit_standards.json'), 'utf8'));
    const unify = us.unit_unify || {};
    for (const m of materials) {
      const u = (m.unit || '').trim();
      if (!u) continue;
      const target = unify[u];
      if (target && target !== u) {
        Object.assign(m, { unit: target, updated_at: ts });
        updated++;
      }
    }
  } else if (rule.auto_fix === 'infer_from_code_segment' || rule.auto_fix === 'infer_from_code') {
    // 按编码第 N 段反推
    const seg = rule.auto_fix_segment || 1;
    const map = rule.auto_fix_map || { '1': '外购', '2': '自制', '3': '委外加工', '4': '辅料' };
    for (const m of materials) {
      const code = m.material_code || '';
      const parts = code.split('.');
      const k = parts[seg - 1];
      const target = map[k];
      if (target) {
        const field = rule.field || (rule.auto_fix === 'infer_from_code' ? 'classification' : 'material_type');
        if ((m[field] || '') !== target) {
          Object.assign(m, { [field]: target, updated_at: ts });
          updated++;
        }
      }
    }
  } else if (rule.auto_fix === 'sync_cost_from_bom') {
    // 从 BOM 反推标准成本
    const bomTable = getTable('bom_items');
    bomTable._invalidate();
    const costMap = {};
    for (const b of bomTable.all()) {
      const c = (b.material_code || '').trim();
      const p = Number(b.unit_price) || 0;
      if (!c || p <= 0) continue;
      if (!costMap[c] || p > costMap[c]) costMap[c] = p;
    }
    for (const m of materials) {
      const code = (m.material_code || '').trim();
      const c = costMap[code];
      if (c && Number(m.standard_cost || 0) === 0) {
        Object.assign(m, { standard_cost: Math.round(c * 10000) / 10000, updated_at: ts });
        updated++;
      }
    }
  } else if (rule.auto_fix === 'rename_by_rule') {
    // 短码批量重命名（按规则 CODE-001 检测到的物料代码）
    const re = /^[1-4]\.\d+\.\d+\.[A-Za-z0-9]+-[A-Za-z0-9\-]+$/;
    const shortMap = { 'IC': '1.6.1.IC', 'CAP': '1.6.1.CAP', 'TF': '1.6.4.TF', 'HS': '2.6.3.HS', 'MCU': '1.6.1.MCU', 'COM': '1.6.6.COM', 'SNS': '1.6.1.SNS', 'PCB': '1.6.4.PCB', 'IO': '1.6.1.IO', 'RLY': '1.6.1.RLY', 'PLC': '1.6.1.PLC' };
    for (const m of materials) {
      const code = m.material_code || '';
      if (re.test(code)) continue;
      const m1 = code.match(/^([A-Z]+)-?(.+)$/);
      if (m1 && shortMap[m1[1]]) {
        const newCode = shortMap[m1[1]] + '-' + m1[2];
        if (!materials.some(x => x !== m && x.material_code === newCode)) {
          Object.assign(m, { material_code: newCode, updated_at: ts });
          updated++;
        }
      }
    }
  }

  matTable.saveNow();
  matTable._invalidate();
  res.json({ message: `自动修复完成：${updated} 条`, updated });
});

module.exports = router;
