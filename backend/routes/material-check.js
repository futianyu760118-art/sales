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
  // 紧凑写入（不缩进），大幅减小文件体积（85MB→~55MB）
  fs.writeFileSync(ISSUES_FILE, JSON.stringify(data), 'utf8');
}
function getIssues() {
  if (!_issuesCache) _issuesCache = loadIssuesFromDisk();
  return _issuesCache;
}
// 异步持久化：不阻塞事件循环
function persistIssuesAsync() {
  if (!_issuesCache) return Promise.resolve();
  const data = _issuesCache;
  return fs.promises.writeFile(ISSUES_FILE, JSON.stringify(data), 'utf8').catch(e => {
    console.error('[material-check] persist error:', e.message);
  });
}
function persistIssues() {
  if (_issuesCache) saveIssuesToDisk(_issuesCache);
}
// 裁剪：保留全部 open/in_progress + 最近 N 条 resolved/ignored，避免无限膨胀
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
    // 裁剪 + 异步持久化，不阻塞响应
    pruneIssues();
    persistIssuesAsync();

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
  persistIssuesAsync();
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
  if (n) persistIssuesAsync();
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

// 新增规则
router.post('/rules', requirePerm('material:edit'), (req, res) => {
  const rules = loadRules();
  const body = req.body || {};
  if (!body.id || !body.name || !body.check_type) {
    return res.status(400).json({ error: 'id、name、check_type 为必填' });
  }
  if ((rules.rules || []).some(r => r.id === body.id)) {
    return res.status(400).json({ error: '规则ID已存在' });
  }
  const rule = {
    id: body.id,
    name: body.name,
    category: body.category || 'integrity',
    severity: body.severity || 'medium',
    check_type: body.check_type,
    field: body.field || '',
    scope: body.scope || 'material',
    enabled: body.enabled !== false,
    description: body.description || '',
    remediation: body.remediation || '',
    auto_fix: body.auto_fix || '',
    auto_fix_map: body.auto_fix_map || null,
    auto_fix_segment: body.auto_fix_segment || null,
    pattern: body.pattern || '',
    min: body.min || null,
    max: body.max || null,
    empty_ok: body.empty_ok !== false,
    forbidden: body.forbidden || [],
    forbidden_values: body.forbidden_values || [],
    allowed: body.allowed || [],
    expected_choices: body.expected_choices || [],
    field_value: body.field_value || null
  };
  rules.rules = rules.rules || [];
  rules.rules.push(rule);
  rules.updated_at = now();
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
  res.json({ message: '规则已创建', rule });
});

// 编辑规则（全量覆盖字段）
router.put('/rules/:id', requirePerm('material:edit'), (req, res) => {
  const rules = loadRules();
  const idx = (rules.rules || []).findIndex(r => r.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '规则不存在' });
  const body = req.body || {};
  const old = rules.rules[idx];
  const allowedKeys = ['name','category','severity','check_type','field','scope','enabled','description','remediation','auto_fix','auto_fix_map','auto_fix_segment','pattern','min','max','empty_ok','forbidden','forbidden_values','allowed','expected_choices','field_value'];
  const updated = { ...old };
  allowedKeys.forEach(k => { if (body[k] !== undefined) updated[k] = body[k]; });
  rules.rules[idx] = updated;
  rules.updated_at = now();
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
  res.json({ message: '规则已更新', rule: updated });
});

// 删除规则
router.delete('/rules/:id', requirePerm('material:edit'), (req, res) => {
  const rules = loadRules();
  const before = (rules.rules || []).length;
  rules.rules = (rules.rules || []).filter(r => r.id !== req.params.id);
  if (rules.rules.length === before) return res.status(404).json({ error: '规则不存在' });
  rules.updated_at = now();
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
  res.json({ message: '规则已删除' });
});

// 一次性自动修复（执行规则上声明的 auto_fix）
router.post('/auto-fix', requirePerm('material:edit'), async (req, res) => {
  try {
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
    // seg=1 取第 1 段 (1/2/3/4)；seg=2 取前 2 段 (1.6/1.7 等)；seg=3 取前 3 段
    const seg = rule.auto_fix_segment || 1;
    const map = rule.auto_fix_map || { '1': '外购', '2': '自制', '3': '委外加工', '4': '辅料' };
    const fallback = rule.auto_fix_fallback || map.default || null;
    for (const m of materials) {
      const code = m.material_code || '';
      const parts = code.split('.');
      let k;
      if (seg === 1) k = parts[0];
      else if (seg === 2) k = parts[0] + '.' + parts[1];
      else k = parts.slice(0, seg).join('.');
      let target = map[k];
      if (!target && fallback) target = fallback;
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
  } else if (rule.auto_fix === 'fill_from_bom') {
    // 从 BOM 补充缺失字段（供应商、规格、分类等）
    const bomTable = getTable('product_bom');
    bomTable._invalidate();
    const bomByCode = {};
    for (const b of bomTable.all()) {
      const c = (b.material_code || '').trim();
      if (!c) continue;
      if (!bomByCode[c]) bomByCode[c] = b;
    }
    const fillFields = rule.auto_fix_fields || ['supplier', 'specs'];
    for (const m of materials) {
      const code = (m.material_code || '').trim();
      const b = bomByCode[code];
      if (!b) continue;
      let changed = false;
      const patch = { updated_at: ts };
      for (const f of fillFields) {
        if ((!m[f] || m[f] === '') && b[f]) {
          patch[f] = b[f];
          changed = true;
        }
      }
      if (changed) { Object.assign(m, patch); updated++; }
    }
  } else if (rule.auto_fix === 'infer_classification') {
    // 根据物料名称关键词推断分类
    const rules = {
      '结构类物料': ['外壳', '支架', '底座', '面板', '灯罩', '透镜', '散热器', '框架', '盖板', '螺丝', '螺母', '垫片'],
      '电子类物料': ['LED', '芯片', '电阻', '电容', '电感', '二极管', '三极管', 'MOS', 'IC', 'PCB', '驱动', '电源', '电池', '太阳能板'],
      '包材类物料': ['包装盒', '纸箱', '泡沫', '标签', '说明书', '保修卡', '彩盒', '珍珠棉', '胶带'],
      '附件类物料': ['遥控器', '适配器', '数据线', '连接线', '插头', '插座', '开关', '按钮'],
      '通用物料': ['螺丝', '螺母', '垫圈', '弹簧', '密封圈', 'O型圈']
    };
    for (const m of materials) {
      if (m.classification && m.classaction !== '') continue;
      const name = (m.material_name || '').toLowerCase();
      let matched = '';
      for (const [cls, keywords] of Object.entries(rules)) {
        if (keywords.some(kw => name.includes(kw.toLowerCase()))) { matched = cls; break; }
      }
      if (matched) { Object.assign(m, { classification: matched, updated_at: ts }); updated++; }
    }
  } else if (rule.auto_fix === 'fill_default_unit') {
    // 根据分类设置默认单位
    const us = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'material_unit_standards.json'), 'utf8'));
    const catRules = us.category_rules || {};
    const defaultUnit = us.default_unit || 'PCS';
    for (const m of materials) {
      if (m.unit && m.unit !== '') continue;
      const cat = m.category || m.classification || '';
      const target = catRules[cat] || defaultUnit;
      if (target) { Object.assign(m, { unit: target, updated_at: ts }); updated++; }
    }
  } else if (rule.auto_fix === 'auto_complete_name') {
    // 根据编码模式补充/修正物料名称
    const codingRules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'material_coding_rules.json'), 'utf8'));
    const segments = codingRules.segments || [];
    for (const m of materials) {
      const name = (m.material_name || '').trim();
      if (name && name.length >= 3 && !['未确认', '待定', 'TBD', 'TODO', '占位', '未知'].some(w => name.includes(w))) continue;
      const code = (m.material_code || '').trim();
      if (!code) continue;
      // 尝试从编码段推断名称
      const parts = code.split('.');
      let inferred = '';
      for (let si = 0; si < parts.length && si < segments.length; si++) {
        const seg = segments[si];
        if (seg && seg.mapping && seg.mapping[parts[si]]) {
          inferred = seg.mapping[parts[si]];
          break;
        }
      }
      if (inferred && inferred !== name) {
        Object.assign(m, { material_name: inferred, updated_at: ts });
        updated++;
      }
    }
  }

  // 异步写盘（13MB materials.json 用 sync 写会阻塞事件循环约 10 秒）
  // 但这里的 _cache 是经过 _invalidate 的，写盘后再 read 才能保证一致。
  // 解决：先等同步写完成（必须），然后强制 _invalidate 重建缓存
  const fsPromises = require('fs').promises;
  const filePath = matTable.filePath;
  const tmp = filePath + '.tmp';
  const content = JSON.stringify(matTable._cache, null, 2);
  await fsPromises.writeFile(tmp, content, 'utf8');
  await fsPromises.rename(tmp, filePath);
  matTable._invalidate();

  // === 同步关闭已不满足规则的问题（issues 状态化）===
  // 智能修复后，物料数据已变；旧 issue 中那些字段已被修好的，需要标为 resolved
  const issuesStore = getIssues();
  const existingIssues = issuesStore.records;
  // 用同一条规则轻量判定：检查修复后的字段是否在白名单
  const runner = require('../lib/material-check-runner');
  const rulesDoc2 = runner.loadRules();
  const singleRule = rulesDoc2.rules.find(r => r.id === rule.id);
  if (singleRule) {
    const stillOffending = new Set();
    for (const m of materials) {
      if (!m.id) continue;
      const f = singleRule.field;
      const v = m[f];
      if (singleRule.check_type === 'field_present') {
        if (!v || v === '' || (singleRule.expected_choices && !singleRule.expected_choices.includes(v))) stillOffending.add(m.id);
      } else if (singleRule.check_type === 'enum') {
        if (singleRule.empty_ok === false && (!v || v === '')) stillOffending.add(m.id);
        else if (v && !(singleRule.allowed || []).includes(v)) stillOffending.add(m.id);
      } else if (singleRule.check_type === 'numeric_gt') {
        if (!(Number(v) > (singleRule.field_value || 0))) stillOffending.add(m.id);
      } else if (singleRule.check_type === 'forbidden_value') {
        if (v && (singleRule.forbidden_values || []).includes(String(v))) stillOffending.add(m.id);
      } else if (singleRule.check_type === 'length_range') {
        const len = String(v || '').length;
        if (len < (singleRule.min || 0) || len > (singleRule.max || 9999)) stillOffending.add(m.id);
      }
    }
    let closed = 0;
    for (const iss of existingIssues) {
      if (iss.rule_id !== rule.id) continue;
      if (iss.status !== 'open' && iss.status !== 'in_progress') continue;
      if (iss.target_id && !stillOffending.has(iss.target_id)) {
        iss.status = 'resolved';
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
        iss.resolved_at = now;
        iss.updated_at = now;
        iss.resolution_notes = (iss.resolution_notes || '') + '\n[auto-fix] 字段已修正，自动关闭';
        closed++;
      }
    }
    if (closed > 0) {
      try {
        const f = require('fs').promises;
        const issueFile = require('path').join(__dirname, '..', '..', 'database', 'material_check_issues.json');
        await f.writeFile(issueFile, JSON.stringify({ records: existingIssues, nextId: issuesStore.nextId, updated_at: new Date().toISOString().replace('T', ' ').substring(0, 19) }));
      } catch (e) {}
    }
    console.log('[auto-fix] ' + rule.id + ': 关闭了 ' + closed + ' 条已修复的 issue');
  }

  res.json({ message: `自动修复完成：${updated} 条物料（同时关闭已修复的 issue）`, updated });
  } catch (e) {
    console.error('[auto-fix] 异常:', e.message);
    res.status(500).json({ error: '自动修复失败: ' + e.message });
  }
});

module.exports = router;
