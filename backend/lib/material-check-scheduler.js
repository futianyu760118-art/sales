// 物料库自检调度器
// - 服务启动后延迟 30 秒首次执行
// - 此后每 6 小时自动跑一次自检
// - 通过环境变量 MATERIAL_CHECK_INTERVAL_HOURS 可覆盖
const { runChecks } = require('./material-check-runner');

const DEFAULT_INTERVAL_HOURS = 6;
const FIRST_DELAY_MS = 30 * 1000;

function startScheduler() {
  const hours = parseFloat(process.env.MATERIAL_CHECK_INTERVAL_HOURS) || DEFAULT_INTERVAL_HOURS;
  const period = Math.max(1, hours) * 3600 * 1000;
  console.log(`[material-check] 自检调度器已启动：首次 ${FIRST_DELAY_MS / 1000}s 后，此后每 ${hours}h 执行一次`);
  setTimeout(async () => {
    await runOnce('startup');
    setInterval(async () => {
      await runOnce('interval');
    }, period);
  }, FIRST_DELAY_MS);
}

async function runOnce(trigger) {
  try {
    const { getTable, now } = require('../db');
    const fs = require('fs');
    const path = require('path');
    const RULES_FILE = path.join(__dirname, '..', '..', 'database', 'material_check_rules.json');
    const LAST_RUN_FILE = path.join(__dirname, '..', '..', 'database', 'material_check_lastrun.json');
    const rulesDoc = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    const matTable = getTable('materials');
    const bomTable = getTable('product_bom');
    matTable._invalidate(); bomTable._invalidate();
    const materials = matTable.all();
    const bomItems = bomTable.all();
    const issues = runChecks(materials, bomItems, rulesDoc);
    const map = new Map();
    for (const i of issues) {
      const k = `${i.rule_id}::${i.target_id || i.scope + ':' + (i.target_code || '')}`;
      const p = map.get(k);
      if (!p || i.detected_at > p.detected_at) map.set(k, i);
    }
    const deduped = [...map.values()];
    const issTable = getTable('material_check_issues');
    const existing = issTable.all();
    const existingMap = new Map(existing.map(e => [`${e.rule_id}::${e.target_id || e.scope + ':' + (e.target_code || '')}`, e]));
    let created = 0, reopened = 0, kept = 0;
    for (const issue of deduped) {
      const key = `${issue.rule_id}::${issue.target_id || issue.scope + ':' + (issue.target_code || '')}`;
      const prev = existingMap.get(key);
      const payload = {
        rule_id: issue.rule_id,
        rule_name: issue.rule_name,
        severity: issue.severity,
        scope: issue.scope,
        target_id: issue.target_id,
        target_code: issue.target_code,
        description: issue.description,
        current_value: issue.current_value,
        suggested_action: issue.suggested_action,
        detected_at: issue.detected_at
      };
      if (!prev) {
        issTable.insert(Object.assign({ status: 'open', assignee: '', due_date: '', created_at: issue.detected_at, updated_at: issue.detected_at }, payload));
        created++;
      } else if (prev.status === 'resolved' || prev.status === 'ignored') {
        prev.status = 'open';
        prev.detected_at = issue.detected_at;
        prev.description = issue.description;
        prev.suggested_action = issue.suggested_action;
        prev.updated_at = issue.detected_at;
        issTable.update(prev.id, prev);
        reopened++;
      } else {
        prev.description = issue.description;
        prev.detected_action = issue.suggested_action;
        prev.detected_at = issue.detected_at;
        prev.updated_at = issue.detected_at;
        issTable.update(prev.id, prev);
        kept++;
      }
    }
    issTable.saveNow();
    issTable._invalidate();
    const report = { last_run: now(), trigger, materials_scanned: materials.length, bom_scanned: bomItems.length, issues_found: deduped.length, issues_created: created, issues_reopened: reopened, issues_kept: kept };
    fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(report, null, 2));
    console.log(`[material-check] (${trigger}) 扫描 ${materials.length} 条 / BOM ${bomItems.length} 行，新增 ${created} 个问题，重开 ${reopened} 个`);
  } catch (e) {
    console.error('[material-check] 自检异常:', e.message);
  }
}

module.exports = { startScheduler, runOnce };
