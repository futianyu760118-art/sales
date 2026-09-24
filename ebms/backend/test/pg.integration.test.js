// PostgreSQL 落地验证：迁移文件、数据层约束（AC 判定标准在库层的可执行形式）、
// 以及走真实 SQL 的归因读写全链路 + 留痕；PAND-91（F13）追加跨域结论 / 跨域判断两表。
// 未配置 PG* 环境变量时自动跳过（保持无数据库环境下 npm test 常绿）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { createPgRepositories } from '../src/repositories/pg/pgRepositories.js';
import { createReasonService } from '../src/services/reasonService.js';
import { createJudgmentService } from '../src/services/judgmentService.js';
import { createIngestService } from '../src/services/ingestService.js';
import { createAdapters } from '../src/ingest/centerAdapters.js';
import { RULE_VERSION } from '../src/domain/judgment.js';

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = ['001_init.sql', '002_seed_dev.sql', '003_cross_domain.sql', '004_seed_cross_domain.sql'];

const PG_ENABLED = Boolean(process.env.PGDATABASE);
const skip = PG_ENABLED ? false : '未设置 PGDATABASE，跳过 PostgreSQL 集成验证';

let pool;
let service;
let judgmentService;
let ingestService;

// 接入用中心输出（2026-07，种子未覆盖该周期）：用于验证真实 SQL 的接入→判断全链路。
// 供应链域故意留空 → 落库为 missing（no_conclusion），验证「单域缺失不影响其余域判断」。
const CENTER_PAYLOADS_FOR_202607 = {
  sales: {
    center: 'sales',
    period: { type: 'month', value: '2026-07' },
    as_of: '2026-08-05T00:00:00+08:00',
    version: 'v2026-07.1',
    metrics: [
      { code: 'revenue', name: '营业收入', target: 1000, actual: 940, unit: '万元', deviation_abs: -60, deviation_pct: -6, threshold_pct: 5, data_status: 'ok' },
      { code: 'on_time_delivery', name: '订单交付率', target: 100, actual: 92, unit: '%', deviation_abs: -8, deviation_pct: -8, threshold_pct: 5, data_status: 'ok' },
    ],
    reasons: [{ metric_code: 'revenue', name: '渠道备货节奏放缓', direction: 'negative', contribution_pct: 100, owner: '销售中心' }],
  },
  production: {
    center: 'production',
    period: { type: 'month', value: '2026-07' },
    as_of: '2026-08-06T00:00:00+08:00',
    version: 'v2026-07.1',
    metrics: [
      { code: 'capacity_utilization', name: '产能利用率', target: 85, actual: 82, unit: '%', deviation_abs: -3, deviation_pct: -3.53, threshold_pct: 5, data_status: 'ok' },
    ],
    reasons: [],
  },
  finance: {
    center: 'finance',
    period: { type: 'month', value: '2026-07' },
    as_of: '2026-08-07T00:00:00+08:00',
    version: 'v2026-07.1',
    metrics: [
      { code: 'gross_margin', name: '毛利率', target: 32, actual: 29, unit: '%', deviation_abs: -3, deviation_pct: -9.38, threshold_pct: 5, data_status: 'ok' },
    ],
    reasons: [],
  },
};

async function runMigrations(client) {
  for (const file of MIGRATIONS) {
    const sql = await readFile(path.join(here, '..', 'migrations', file), 'utf8');
    await client.query(sql);
  }
}

test.before(async () => {
  if (!PG_ENABLED) return;
  pool = new Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 4,
  });
  const client = await pool.connect();
  try {
    // 安全闸：本用例会重置 schema，只允许在专用验证库上执行，
    // 避免误指向共享/生产库造成破坏。
    const { rows: dbInfo } = await client.query('SELECT current_database() AS name');
    const dbName = dbInfo[0].name;
    if (!/_verify$/.test(dbName) && process.env.EBMS_PG_TEST_ALLOW_RESET !== '1') {
      throw new Error(`拒绝在库 ${dbName} 上重置 schema：请使用以 _verify 结尾的专用验证库，或显式设置 EBMS_PG_TEST_ALLOW_RESET=1`);
    }
    // 仅重置本验证库的 schema（独立库，不影响其他库/其他任务的对象）
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await runMigrations(client);
  } finally {
    client.release();
  }
  const repos = createPgRepositories(pool);
  service = createReasonService(repos);
  judgmentService = createJudgmentService(repos);
  // 接入链路走真实 SQL；中心侧用人工录入 Adapter（三域接口未确认），验证「落库 → 判断物化 → 留痕」
  ingestService = createIngestService({
    conclusionRepository: repos.conclusionRepository,
    adapters: createAdapters({
      centerConfig: {
        sales: { mode: 'manual', manualPayload: CENTER_PAYLOADS_FOR_202607.sales },
        production: { mode: 'manual', manualPayload: CENTER_PAYLOADS_FOR_202607.production },
        finance: { mode: 'manual', manualPayload: CENTER_PAYLOADS_FOR_202607.finance },
        supply_chain: { mode: 'manual', manualPayload: null }, // 中心无本周期结论
      },
    }),
    onConclusionsIngested: ({ periodType, periodValue, actor }) =>
      judgmentService.materialize({ periodType, periodValue, actor }),
  });
});

test.after(async () => {
  if (pool) await pool.end();
});

test('迁移可执行：核心表、索引与归因汇总视图均已创建', { skip }, async () => {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const names = tables.rows.map((r) => r.table_name);
  for (const expected of ['result_metrics', 'result_reasons', 'audit_log', 'result_attribution_summary']) {
    assert.ok(names.includes(expected), `缺少 ${expected}`);
  }
  const indexes = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
  assert.ok(indexes.rows.some((r) => r.indexname === 'idx_result_reasons_metric'));
});

test('归因汇总视图：顶层贡献占比合计为 100（多级子项不重复计入）', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT root_contribution_pct, reason_count FROM result_attribution_summary WHERE metric_code = 'revenue'`,
  );
  assert.equal(Number(rows[0].root_contribution_pct), 100);
  // 种子数据：3 条顶层 + 4 条多级子项
  assert.equal(Number(rows[0].reason_count), 7);
});

test('库层约束：影响方向仅限 正向/负向/中性，非法值被 CHECK 拒绝', { skip }, async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO result_reasons (id, metric_id, name, direction, contribution_pct, owner)
         VALUES ('r-bad-direction', 'm-otd-202608', '方向非法', 'up', 10, '销售中心')`,
      ),
    (err) => err.code === '23514' && /direction/.test(err.constraint ?? ''),
  );
});

test('库层约束：影响量与贡献占比不得同时为空', { skip }, async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO result_reasons (id, metric_id, name, direction, owner)
         VALUES ('r-bad-empty', 'm-otd-202608', '无量化原因', 'negative', '销售中心')`,
      ),
    (err) => err.code === '23514',
  );
});

test('库层约束：contribution_pct 取值范围 (0, 100]', { skip }, async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO result_reasons (id, metric_id, name, direction, contribution_pct, owner)
         VALUES ('r-bad-range', 'm-otd-202608', '超范围占比', 'negative', 120, '销售中心')`,
      ),
    (err) => err.code === '23514',
  );
});

test('库层约束：父项删除级联回收子项', { skip }, async () => {
  await pool.query(
    `INSERT INTO result_reasons (id, metric_id, parent_id, name, direction, contribution_pct, owner)
     VALUES ('r-cascade-p', 'm-otd-202608', NULL, '父项', 'negative', 10, '销售中心'),
            ('r-cascade-c', 'm-otd-202608', 'r-cascade-p', '子项', 'negative', 10, '销售中心')`,
  );
  await pool.query(`DELETE FROM result_reasons WHERE id = 'r-cascade-p'`);
  const { rows } = await pool.query(`SELECT id FROM result_reasons WHERE id IN ('r-cascade-p', 'r-cascade-c')`);
  assert.equal(rows.length, 0);
});

test('真实 SQL 读链路：完全归因 + Reason 层三级展开', { skip }, async () => {
  const body = await service.listReasonsForMetric('m-revenue-202608');
  assert.equal(body.attribution.status, 'fully_attributed');
  assert.equal(body.attribution.status_label, '完全归因');
  assert.equal(body.attribution.total_contribution_pct, 100);
  assert.equal(body.attribution.sums_to_100_within_tolerance, true);
  assert.deepEqual(body.chain.layers, ['RESULT', 'REASON', 'EVIDENCE', 'SOURCE']);

  const l1 = body.reasons.find((r) => r.id === 'r-rev-2');
  const l2 = l1.children.find((c) => c.id === 'r-rev-2-1');
  const l3 = l2.children[0];
  assert.equal(l3.level, 3);
  assert.equal(l3.name, '竞品降价 8% 且账期延长 30 天');
  // 中文经真实 PostgreSQL 往返未被破坏
  assert.equal(l1.name, '华东区订单流失');
});

test('真实 SQL 读链路：未关联原因返回「未归因」+ 关联入口', { skip }, async () => {
  const body = await service.listReasonsForMetric('m-otd-202608');
  assert.equal(body.attribution.status, 'unattributed');
  assert.equal(body.attribution.status_label, '未归因');
  assert.equal(body.empty_state.title, '未归因');
  assert.equal(body.empty_state.action.href, '/api/v1/results/m-otd-202608/reasons');
});

test('真实 SQL 写链路：关联 → 校验拦截 → 修正 → 留痕可查', { skip }, async () => {
  // 1) 关联 60% → 部分归因
  const first = await service.createReasons(
    'm-otd-202608',
    { reasons: [{ name: '产能不足导致延期', direction: 'negative', contribution_pct: 60, owner: '生产交付中心' }] },
    { actor: 'qa-agent' },
  );
  assert.equal(first.attribution.status, 'partially_attributed');
  assert.equal(first.attribution.unattributed_pct, 40);

  // 2) 再关联 60% → 合计 120%，事务内校验拦截（AC 判定标准）
  await assert.rejects(
    () =>
      service.createReasons(
        'm-otd-202608',
        { reasons: [{ name: '重复归因', direction: 'negative', contribution_pct: 60, owner: '销售中心' }] },
        { actor: 'qa-agent' },
      ),
    (err) => err.status === 422 && err.details.errors[0].code === 'CONTRIBUTION_OVER_100',
  );
  // 被拒后数据未被写坏
  const afterReject = await service.listReasonsForMetric('m-otd-202608');
  assert.equal(afterReject.attribution.total_contribution_pct, 60);
  assert.equal(afterReject.attribution.reason_count, 1);

  // 3) 补齐至 100% → 完全归因
  const second = await service.createReasons(
    'm-otd-202608',
    { reasons: [{ name: '来料质量波动', direction: 'negative', contribution_pct: 40, owner: '供应链中心' }] },
    { actor: 'qa-agent' },
  );
  assert.equal(second.result.attribution.status, 'fully_attributed');
  assert.equal(second.result.attribution.total_contribution_pct, 100);

  // 4) 留痕：写入均落 audit_log
  const audits = await pool.query(
    `SELECT action, entity_id FROM audit_log WHERE actor = 'qa-agent' ORDER BY id`,
  );
  assert.ok(audits.rows.length >= 2);
  assert.ok(audits.rows.every((r) => r.action === 'reason.create'));

  // 5) 解除关联
  const target = second.result.reasons.find((r) => r.name === '来料质量波动');
  const deleted = await service.deleteReason(target.id, { actor: 'qa-agent' });
  assert.equal(deleted.result.attribution.total_contribution_pct, 60);
  const deleteAudit = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'reason.delete' AND actor = 'qa-agent'`);
  assert.equal(deleteAudit.rowCount, 1);

  // 复位：清理本次写入，保持种子数据可重复验证
  await pool.query(`DELETE FROM result_reasons WHERE metric_id = 'm-otd-202608'`);
});

test('真实 SQL：多级原因写入与父项合计校验', { skip }, async () => {
  const created = await service.createReasons(
    'm-gross-margin-202608',
    {
      mode: 'replace',
      reasons: [
        { id: 'v-p', name: '采购价上涨', direction: 'negative', contribution_pct: 100, owner: '供应链中心' },
        { id: 'v-c1', parent_id: 'v-p', name: '钢材涨价', direction: 'negative', contribution_pct: 60, owner: '供应链中心' },
        { id: 'v-c2', parent_id: 'v-p', name: '运费上涨', direction: 'negative', contribution_pct: 40, owner: '供应链中心' },
      ],
    },
    { actor: 'qa-agent' },
  );
  const parent = created.result.reasons.find((r) => r.id === 'v-p');
  assert.equal(parent.expandable, true);
  assert.equal(parent.decomposed_pct, 100);
  assert.equal(parent.undecomposed_pct, 0);
  assert.equal(created.result.attribution.status, 'fully_attributed');

  // 子项合计超出父项 → 拦截
  await assert.rejects(
    () =>
      service.createReasons(
        'm-gross-margin-202608',
        { reasons: [{ id: 'v-c3', parent_id: 'v-p', name: '超额子项', direction: 'negative', contribution_pct: 30, owner: '供应链中心' }] },
        { actor: 'qa-agent' },
      ),
    (err) => err.status === 422 && err.details.errors[0].code === 'CHILD_CONTRIBUTION_OVER_PARENT',
  );

  // 本文件开头会重置 schema 并重跑种子，故此处无需还原
});

// ───────────────────────── PAND-91 / F13 跨域判断域 ─────────────────────────

test('迁移可执行：跨域结论与跨域判断表、索引均已创建', { skip }, async () => {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
  );
  const names = tables.rows.map((r) => r.table_name);
  for (const expected of ['domain_conclusions', 'cross_domain_judgments']) {
    assert.ok(names.includes(expected), `缺少 ${expected}`);
  }
  const indexes = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
  const indexNames = indexes.rows.map((r) => r.indexname);
  assert.ok(indexNames.includes('idx_domain_conclusions_period'));
  assert.ok(indexNames.includes('idx_cross_domain_judgments_period'));
});

test('库层约束：专业中心域仅限四域，非法域被 CHECK 拒绝', { skip }, async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO domain_conclusions (id, center, period_type, period_value, payload)
         VALUES ('dc-bad-center', 'marketing', 'month', '2026-08', '{"center":"marketing"}'::jsonb)`,
      ),
    (err) => err.code === '23514' && /center/.test(err.constraint ?? ''),
  );
  // 周期类型同样受约束
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO domain_conclusions (id, center, period_type, period_value, payload)
         VALUES ('dc-bad-period', 'sales', 'hour', '2026-08-01T00', '{"center":"sales"}'::jsonb)`,
      ),
    (err) => err.code === '23514',
  );
});

test('库层约束：有结论必须有 payload；缺失域必须给出缺失原因（两者成对）', { skip }, async () => {
  // 未标 missing 却无 payload → 拒绝
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO domain_conclusions (id, center, period_type, period_value, payload, missing)
         VALUES ('dc-no-payload', 'sales', 'week', '2026-W32', NULL, false)`,
      ),
    (err) => err.code === '23514' && /payload_present/.test(err.constraint ?? ''),
  );
  // 标了 missing 却不给原因 → 拒绝
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO domain_conclusions (id, center, period_type, period_value, payload, missing, missing_reason)
         VALUES ('dc-no-reason', 'sales', 'week', '2026-W33', NULL, true, NULL)`,
      ),
    (err) => err.code === '23514' && /missing_reason/.test(err.constraint ?? ''),
  );
  // 非缺失域带缺失原因 → 同样拒绝
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO domain_conclusions (id, center, period_type, period_value, payload, missing, missing_reason)
         VALUES ('dc-superfluous-reason', 'sales', 'week', '2026-W34', '{"center":"sales"}'::jsonb, false, 'timeout')`,
      ),
    (err) => err.code === '23514',
  );
});

test('库层约束：结论快照粒度 = (中心, 周期类型, 周期值)，重复快照被唯一键拒绝', { skip }, async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO domain_conclusions (id, center, period_type, period_value, payload)
         VALUES ('dc-dup-sales-202608', 'sales', 'month', '2026-08', '{"center":"sales"}'::jsonb)`,
      ),
    (err) => err.code === '23505' && /center|period/.test(err.constraint ?? ''),
  );
});

test('库层约束：判断层级仅限五档，非法层级被 CHECK 拒绝', { skip }, async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO cross_domain_judgments (id, period_type, period_value, rule_version, level, conclusion)
         VALUES ('jd-bad-level', 'month', '2026-08', 'v-bad', 'urgent', '非法层级')`,
      ),
    (err) => err.code === '23514' && /level/.test(err.constraint ?? ''),
  );
});

test('种子数据：2026-08 四域结论齐全，payload 经真实 SQL 往返与中心输出一致（EBMS 未加工）', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT center, payload, missing FROM domain_conclusions
     WHERE period_type = 'month' AND period_value = '2026-08' ORDER BY center`,
  );
  assert.deepEqual(rows.map((r) => r.center), ['finance', 'production', 'sales', 'supply_chain']);
  assert.ok(rows.every((r) => r.missing === false));

  const sales = rows.find((r) => r.center === 'sales');
  // JSONB 回读对象与中心上报体逐字段一致（键序由 jsonb 归一，deepEqual 不比较键序）
  assert.deepEqual(sales.payload.metrics[0], {
    code: 'revenue',
    name: '营业收入',
    target: 1000,
    actual: 880,
    unit: '万元',
    deviation_abs: -120,
    deviation_pct: -12,
    threshold_pct: 5,
    data_status: 'ok',
  });
  // 中文经真实 PostgreSQL 往返未被破坏
  assert.equal(sales.payload.metrics[1].name, '订单交付率');
  assert.equal(sales.payload.reasons[2].owner, '财务中心');
});

test('种子数据：2026-09 供应链域为缺失快照（无 payload + 缺失原因 timeout）', { skip }, async () => {
  const { rows } = await pool.query(
    `SELECT center, payload, missing, missing_reason FROM domain_conclusions
     WHERE period_type = 'month' AND period_value = '2026-09' ORDER BY center`,
  );
  assert.deepEqual(rows.map((r) => r.center), ['finance', 'production', 'sales', 'supply_chain']);
  const supplyChain = rows.find((r) => r.center === 'supply_chain');
  assert.equal(supplyChain.missing, true);
  assert.equal(supplyChain.payload, null);
  assert.equal(supplyChain.missing_reason, 'timeout');
});

test('真实 SQL 判断物化：四域齐全 → critical，引用四个快照 id 且可回查', { skip }, async () => {
  const stored = await judgmentService.materialize({ periodType: 'month', periodValue: '2026-08', actor: 'qa-agent' });
  assert.equal(stored.level, 'critical');
  assert.equal(stored.can_judge, true);
  assert.deepEqual(stored.present_domains, ['sales', 'production', 'finance', 'supply_chain']);
  assert.deepEqual(stored.missing_domains, []);
  assert.equal(stored.referenced_conclusion_ids.length, 4);
  // detail 完整评估结果落库：域视图、引用明细、耦合指标均在
  assert.equal(stored.detail.references.length, 4);
  assert.equal(stored.detail.computation_scope.recomputed, false);
  assert.equal(stored.detail.coupled_metrics.length, 1);

  // 引用 id 全部能在结论快照表中回查（可追溯）
  const { rows } = await pool.query(
    `SELECT id FROM domain_conclusions WHERE id = ANY($1::text[])`,
    [stored.referenced_conclusion_ids],
  );
  assert.equal(rows.length, 4);

  // 引用明细 + 可追溯核验
  const refs = await judgmentService.getReferences(stored.id);
  assert.equal(refs.reference_count, 4);
  assert.equal(refs.traceability.all_resolved, true);
  for (const ref of refs.references) assert.ok(ref.conclusion_id, '每条引用须带可回查的快照 id');

  // 粒度 = (周期, 规则版本)：再次物化覆盖同一行而非新增
  const again = await judgmentService.materialize({ periodType: 'month', periodValue: '2026-08', actor: 'qa-agent' });
  const { rows: count } = await pool.query(
    `SELECT count(*)::int AS n FROM cross_domain_judgments WHERE period_type = 'month' AND period_value = '2026-08'`,
  );
  assert.equal(count[0].n, 1, '同周期同规则版本只能有一行判断');
  assert.equal(again.period_type, 'month');
});

test('真实 SQL 判断物化：单域缺失标注「该域数据缺失」，其余三域仍输出判断', { skip }, async () => {
  const stored = await judgmentService.materialize({ periodType: 'month', periodValue: '2026-09', actor: 'qa-agent' });
  assert.equal(stored.can_judge, true, '缺失域不得阻断其余域判断');
  assert.deepEqual(stored.present_domains, ['sales', 'production', 'finance']);
  assert.deepEqual(stored.missing_domains, ['supply_chain']);
  assert.equal(stored.referenced_conclusion_ids.length, 3);
  assert.equal(stored.detail.missing_domain_details[0].label, '该域数据缺失');
  assert.equal(stored.detail.missing_domain_details[0].reason, 'timeout');
  assert.match(stored.conclusion, /该域数据缺失/);
  // TEXT[] 经真实 SQL 往返未被破坏
  const { rows } = await pool.query(
    `SELECT missing_domains FROM cross_domain_judgments WHERE period_type = 'month' AND period_value = '2026-09'`,
  );
  assert.deepEqual(rows[0].missing_domains, ['supply_chain']);
});

test('真实 SQL 抽样比对：四域样本，一致率 100%（判定标准）', { skip }, async () => {
  const report = await judgmentService.checkConsistency({ periodType: 'month', periodValue: '2026-08' });
  assert.equal(report.meets_minimum, true);
  assert.equal(report.compared_count, 10, '默认抽样 10 条（四域各有 12 条可比对样本，共 48 条可选）');
  assert.equal(report.differences.length, 0);
  assert.equal(report.consistent_rate, 1);
  assert.equal(report.unexplained_difference_count, 0);
  assert.equal(report.passed, true);
  assert.equal(new Set(report.samples.filter((s) => !s.skipped).map((s) => s.center)).size, 4, '抽样须覆盖四个域');

  // 缺失域：样本以「缺失说明」跳过，不计入一致率分母，其余域仍通过
  const sep = await judgmentService.checkConsistency({ periodType: 'month', periodValue: '2026-09' });
  const skipped = sep.samples.filter((s) => s.skipped);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].note, /该域数据缺失/);
  assert.equal(sep.compared_count, sep.samples.length - 1);
  assert.equal(sep.passed, true);
});

test('真实 SQL 接入全链路：拉取 → 原样落库 → 判断物化 → 留痕可查', { skip }, async () => {
  const report = await ingestService.ingestPeriod({ periodType: 'month', periodValue: '2026-07', actor: 'qa-agent' });
  assert.equal(report.ingested_count, 3);
  assert.equal(report.missing_count, 1);
  assert.equal(report.missing[0].center, 'supply_chain');
  assert.equal(report.missing[0].missing_reason, 'no_conclusion');
  assert.equal(report.judgment_generated, true);

  // 落库快照原样（与中心输出逐字段一致）
  const { conclusions } = await ingestService.listConclusions({ periodType: 'month', periodValue: '2026-07' });
  assert.equal(conclusions.length, 4);
  const sales = conclusions.find((c) => c.center === 'sales');
  assert.deepEqual(sales.payload, CENTER_PAYLOADS_FOR_202607.sales);
  assert.equal(sales.version, 'v2026-07.1');

  // 判断落库且缺失域不影响其余域
  const stored = await judgmentRepositoryRow('2026-07');
  assert.ok(stored, '接入后判断须落库');
  assert.deepEqual(stored.missing_domains, ['supply_chain']);
  assert.equal(stored.rule_version, RULE_VERSION);
  assert.equal(stored.can_judge, true);

  // 重报同周期：以最新批次覆盖（仍只保留一条快照）
  await ingestService.ingestPeriod({ periodType: 'month', periodValue: '2026-07', centers: ['sales'], actor: 'qa-agent' });
  const { rows: snapCount } = await pool.query(
    `SELECT count(*)::int AS n FROM domain_conclusions WHERE period_type = 'month' AND period_value = '2026-07'`,
  );
  assert.equal(snapCount[0].n, 4, '同域同周期只保留一条最新快照');

  // 留痕：接入与判断生成均落 audit_log
  const audits = await pool.query(
    `SELECT action, count(*)::int AS n FROM audit_log WHERE actor = 'qa-agent' GROUP BY action ORDER BY action`,
  );
  const byAction = Object.fromEntries(audits.rows.map((r) => [r.action, r.n]));
  assert.ok(byAction['conclusion.ingest'] >= 2, '接入须留痕');
  assert.ok(byAction['judgment.generate'] >= 4, '判断物化须留痕（含覆盖重算）');
  const audited = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'domain_conclusions'`,
  );
  assert.ok(audited.rows[0].n >= 2);
});

async function judgmentRepositoryRow(periodValue) {
  const { rows } = await pool.query(
    `SELECT period_type, period_value, rule_version, level, can_judge, missing_domains, referenced_conclusion_ids
     FROM cross_domain_judgments WHERE period_type = 'month' AND period_value = $1 AND rule_version = $2`,
    [periodValue, RULE_VERSION],
  );
  return rows[0] ?? null;
}
