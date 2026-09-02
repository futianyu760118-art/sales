// 物料库自检调度器（分批 + 让出事件循环，防止长任务卡死服务）
// - 服务启动后首次延迟（默认 5 分钟）执行
// - 此后每 N 小时自动跑一次（默认 6 小时）
// - 环境变量：
//     MATERIAL_CHECK_INTERVAL_HOURS  间隔小时数（默认 6）
//     MATERIAL_CHECK_FIRST_DELAY_MS   首次延迟毫秒数（默认 300000 = 5分钟）
const fs = require('fs');
const logger = require('./logger');
const path = require('path');
const { loadRules, runChecksBatch } = require('./material-check-runner');

const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_FIRST_DELAY_MS = 5 * 60 * 1000;

function startScheduler() {
  const hours = parseFloat(process.env.MATERIAL_CHECK_INTERVAL_HOURS) || DEFAULT_INTERVAL_HOURS;
  const firstDelay = parseInt(process.env.MATERIAL_CHECK_FIRST_DELAY_MS) || DEFAULT_FIRST_DELAY_MS;
  const period = Math.max(1, hours) * 3600 * 1000;
  logger.info(`[material-check] 自检调度器已启动：首次 ${(firstDelay / 1000)}s 后，此后每 ${hours}h 执行一次（批量让出事件循环）`);

  const trigger = async (label) => {
    try {
      const t0 = Date.now();
      const r = await runOnce(label);
      logger.info(`[material-check] (${label}) 完成：扫描 ${r.materials_scanned} 物料 / ${r.bom_scanned} 行 BOM，新增 ${r.issues_created} 问题，重开 ${r.issues_reopened} 个，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      logger.error('[material-check] (' + label + ') 异常:', e.message);
    }
  };

  setTimeout(() => {
    trigger('startup');
    setInterval(() => trigger('interval'), period);
  }, firstDelay);
}

async function loadTableData(tableName) {
  // 直接读 JSON 文件，避免经过 db.js 的 invalidate 路径
  // 因为读取 15MB 大表会显著影响其他请求响应
  const file = path.join(__dirname, '..', '..', 'database', tableName + '.json');
  try {
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return { records: data.records || [], nextId: data.nextId || 1 };
  } catch (e) {
    return { records: [], nextId: 1 };
  }
}

async function persistIssues(store) {
  // 紧凑写入（不缩进）+ 裁剪：只保留 open + 最近 2000 条已关闭
  const keep = [];
  const closed = [];
  for (const r of store.records) {
    if (r.status === 'open' || r.status === 'in_progress') keep.push(r);
    else closed.push(r);
  }
  closed.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const pruned = { records: [...keep, ...closed.slice(0, 2000)], nextId: store.nextId };
  const file = path.join(__dirname, '..', '..', 'database', 'material_check_issues.json');
  await fs.promises.writeFile(file, JSON.stringify(pruned));
}

async function persistLastRun(report) {
  const file = path.join(__dirname, '..', '..', 'database', 'material_check_lastrun.json');
  try { await fs.promises.writeFile(file, JSON.stringify(report, null, 2)); } catch (e) {}
}

async function runOnce(trigger) {
  const { getTable, now } = require('../db');
  const rulesDoc = loadRules();
  const matTable = getTable('materials');
  const bomTable = getTable('product_bom');
  matTable._invalidate();
  bomTable._invalidate();
  const materials = matTable.all();
  const bomItems = bomTable.all();

  // 1. 分批自检（每 500 条物料让出事件循环）
  const issues = await runChecksBatch(materials, bomItems, rulesDoc, 500);

  // 2. 去重
  const map = new Map();
  for (const i of issues) {
    const k = `${i.rule_id}::${i.target_id || i.scope + ':' + (i.target_code || '')}`;
    const p = map.get(k);
    if (!p || i.detected_at > p.detected_at) map.set(k, i);
  }
  const deduped = [...map.values()];

  // 3. 直接读写 issues 文件，不经过 db.js（避免 15MB 文件全表复制）
  const issuesFile = path.join(__dirname, '..', '..', 'database', 'material_check_issues.json');
  const issuesData = await loadTableData('material_check_issues');
  const existing = issuesData.records;
  const existingMap = new Map(existing.map(e => [`${e.rule_id}::${e.target_id || e.scope + ':' + (e.target_code || '')}`, e]));
  const indexKey = it => `${it.rule_id}::${it.target_id || (it.scope + ':' + (it.target_code || ''))}`;

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
      const id = issuesData.nextId++;
      existing.push(Object.assign({ id, status: 'open', assignee: '', due_date: '', created_at: issue.detected_at, updated_at: issue.detected_at }, payload));
      existingMap.set(indexKey(issue), existing[existing.length - 1]);
      created++;
    } else if (prev.status === 'resolved' || prev.status === 'ignored') {
      Object.assign(prev, { status: 'open', detected_at: issue.detected_at, description: issue.description, suggested_action: issue.suggested_action, updated_at: issue.detected_at });
      reopened++;
    } else {
      Object.assign(prev, { description: issue.description, suggested_action: issue.suggested_action, detected_at: issue.detected_at, updated_at: issue.detected_at });
      kept++;
    }
  }

  // 4. 异步持久化
  await persistIssues({ records: issuesData.records, nextId: issuesData.nextId });
  const report = {
    last_run: now(), trigger,
    materials_scanned: materials.length, bom_scanned: bomItems.length,
    issues_found: deduped.length, issues_created: created,
    issues_reopened: reopened, issues_kept: kept,
    by_severity: deduped.reduce((acc, i) => { acc[i.severity] = (acc[i.severity] || 0) + 1; return acc; }, {})
  };
  await persistLastRun(report);
  return report;
}

module.exports = { startScheduler, runOnce };
