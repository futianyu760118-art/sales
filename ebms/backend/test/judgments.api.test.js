// 接口级验收自检：以真实 HTTP 请求逐条验证 PAND-91（F13）的场景、边界与判定标准。
// 数据层走 repository 内存实现，结论快照取 004_seed_cross_domain.sql 同源种子。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory/memoryRepositories.js';
import { createAdapters } from '../src/ingest/centerAdapters.js';
import { CENTER_PAYLOADS, buildSeedConclusions } from '../src/dev/seedCrossDomain.js';

const FULL = 'period_type=month&period_value=2026-08'; // 四域齐全
const MISSING = 'period_type=month&period_value=2026-09'; // 供应链域缺失

function devAdapters() {
  const centerConfig = {};
  for (const center of ['sales', 'production', 'finance', 'supply_chain']) {
    centerConfig[center] = {
      mode: 'manual',
      loader: ({ center: c, periodValue }) => CENTER_PAYLOADS[`${c}|month|${periodValue}`] ?? null,
    };
  }
  return createAdapters({ centerConfig });
}

async function withServer(fn, { seeded = true } = {}) {
  const repos = createMemoryRepositories({
    conclusions: seeded ? buildSeedConclusions() : [],
  });
  const app = createApp({ ...repos, adapters: devAdapters(), logger: { error() {} } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    await fn({ base, repos });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(base, path, payload) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('场景 1：展示跨域经营判断结论，并列出其引用的各专业中心结论', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await get(base, `/judgments?${FULL}`);
    assert.equal(status, 200);
    assert.ok(body.judgment_id);
    assert.ok(body.conclusion.length > 0);
    assert.equal(body.can_judge, true);
    assert.equal(body.level, 'critical');
    assert.equal(body.level_label, '严重');
    // 引用的各专业中心结论均可列出
    assert.equal(body.reference_count, 4);
    const centers = body.references.map((r) => r.center);
    assert.deepEqual(centers, ['sales', 'production', 'finance', 'supply_chain']);
    for (const ref of body.references) {
      assert.ok(ref.center_label, '引用须标注中心名称');
      assert.ok(ref.version, '引用须标注结论版本');
      assert.ok(ref.as_of, '引用须标注结论时间');
      assert.ok(ref.data_cutoff, '引用须标注数据截止时间');
    }
  });
});

test('场景 2：EBMS 不重算专业中心内部指标——展示值与专业中心输出值逐字段一致', async () => {
  await withServer(async ({ base }) => {
    const { body } = await get(base, `/conclusions?${FULL}`);
    assert.equal(body.count, 4, '四个域的结论快照均可查');
    for (const conclusion of body.conclusions) {
      const centerOutput = CENTER_PAYLOADS[`${conclusion.center}|month|2026-08`];
      assert.ok(centerOutput, `缺少 ${conclusion.center} 的中心输出基准`);
      // 快照原样回传：与中心输出逐字段一致，EBMS 未做任何加工
      assert.deepEqual(conclusion.payload, centerOutput);
      for (const [index, metric] of conclusion.payload.metrics.entries()) {
        assert.equal(metric.actual, centerOutput.metrics[index].actual);
        assert.equal(metric.deviation_pct, centerOutput.metrics[index].deviation_pct);
      }
    }
    // 判断中引用的取值同样等于中心输出值
    const { body: judgment } = await get(base, `/judgments?${FULL}`);
    for (const ref of judgment.references) {
      const centerOutput = CENTER_PAYLOADS[`${ref.center}|month|2026-08`];
      for (const cited of ref.metrics_cited) {
        const source = centerOutput.metrics.find((m) => m.code === cited.code);
        assert.equal(cited.actual, source.actual, `${ref.center}/${cited.code} 实际值须与中心输出一致`);
        assert.equal(cited.deviation_pct, source.deviation_pct, `${ref.center}/${cited.code} 偏差须与中心输出一致`);
      }
    }
    assert.equal(judgment.computation_scope.recomputed, false);
    assert.equal(judgment.computation_scope.basis, 'center_reported_values_only');
  });
});

test('边界：某专业中心数据缺失时标注「该域数据缺失」，其余域仍可判断', async () => {
  await withServer(async ({ base }) => {
    const { body } = await get(base, `/judgments?${MISSING}`);
    assert.equal(body.can_judge, true, '缺失域不得阻断其余域判断');
    assert.deepEqual(body.present_domains, ['sales', 'production', 'finance']);
    assert.deepEqual(body.missing_domains, ['supply_chain']);
    assert.equal(body.missing_domain_details[0].label, '该域数据缺失');
    assert.equal(body.missing_domain_details[0].center_label, '供应链中心');
    assert.equal(body.missing_domain_details[0].reason, 'timeout');
    assert.match(body.conclusion, /该域数据缺失/);
    assert.match(body.conclusion, /其余域判断正常输出/);
    // 其余三域仍产出完整判断与引用
    assert.equal(body.reference_count, 3);
    assert.equal(body.level, 'critical');
  });
});

test('判定标准：抽样不少于 10 条比对，一致率 100%', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await get(base, `/judgments/consistency?${FULL}`);
    assert.equal(status, 200);
    assert.equal(body.meets_minimum, true);
    assert.ok(body.compared_count >= 10, `比对条数须不少于 10，实际 ${body.compared_count}`);
    assert.equal(body.consistent_rate, 1);
    assert.equal(body.inconsistent_count, 0);
    assert.equal(body.unexplained_difference_count, 0);
    assert.equal(body.passed, true);
    assert.match(body.verdict, /一致率 100%/);
    // 抽样覆盖四个域
    assert.equal(new Set(body.samples.filter((s) => !s.skipped).map((s) => s.center)).size, 4);
  });
});

test('判定标准：跨域结论引用的专业中心结论均可列出且可追溯', async () => {
  await withServer(async ({ base }) => {
    const { body: judgment } = await get(base, `/judgments?${FULL}`);
    const { status, body } = await get(base, `/judgments/${judgment.judgment_id}/references`);
    assert.equal(status, 200);
    assert.equal(body.judgment_id, judgment.judgment_id);
    assert.equal(body.reference_count, 4);
    assert.equal(body.traceability.all_resolved, true);
    assert.equal(body.traceability.unresolved_conclusion_ids.length, 0);
    assert.equal(body.traceability.resolved_conclusion_refs, 4);
    for (const ref of body.references) {
      assert.ok(ref.conclusion_id, '每条引用须带可回查的快照 id');
    }
  });
});

test('判定标准：对照差异（若有）须有口径说明——缺失域差异带说明且不计为未解释', async () => {
  await withServer(async ({ base }) => {
    const { body } = await get(base, `/judgments/consistency?${MISSING}`);
    const skipped = body.samples.filter((s) => s.skipped);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].note, /该域数据缺失/);
    assert.equal(body.all_differences_explained, true);
    assert.equal(body.passed, true);
  });
});

test('判定标准：有效样本不足 10 条时判定不成立，不静默通过', async () => {
  await withServer(async ({ base, repos }) => {
    // 仅保留一个域的一条指标 → 4 条样本 < 10
    await repos.conclusionRepository.upsertMany([
      {
        id: 'dc-sales-only',
        center: 'sales',
        period_type: 'month',
        period_value: '2026-07',
        version: 'v1',
        as_of: '2026-08-05T00:00:00+08:00',
        payload: { center: 'sales', as_of: '2026-08-05T00:00:00+08:00', version: 'v1', metrics: [{ code: 'revenue', name: '营业收入', target: 1000, actual: 980, unit: '万元', deviation_abs: -20, deviation_pct: -2, threshold_pct: 5, data_status: 'ok' }] },
        missing: false,
        missing_reason: null,
        source_mode: 'api',
        ingested_at: '2026-08-06T00:00:00Z',
      },
    ]);
    const { body } = await get(base, '/judgments/consistency?period_type=month&period_value=2026-07');
    assert.equal(body.meets_minimum, false);
    assert.equal(body.passed, false);
    assert.match(body.verdict, /少于判定要求/);
  });
});

test('接入：POST 触发四域拉取并即时刷新跨域判断', async () => {
  await withServer(
    async ({ base }) => {
      const { status, body } = await post(base, '/conclusions/ingest', { period_type: 'month', period_value: '2026-08' });
      assert.equal(status, 201);
      assert.equal(body.ingested_count, 4);
      assert.equal(body.missing_count, 0);
      assert.equal(body.judgment_generated, true);
      assert.equal(body.judgment_level, 'critical');
      assert.equal(body.domains.length, 4);

      const { body: judgment } = await get(base, `/judgments?${FULL}`);
      assert.equal(judgment.reference_count, 4);
      assert.equal(judgment.can_judge, true);
    },
    { seeded: false },
  );
});

test('接入：周期列表可用于前端选择判断周期', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await get(base, '/judgments/periods');
    assert.equal(status, 200);
    const values = body.periods.map((p) => p.period_value).sort();
    assert.deepEqual(values, ['2026-08', '2026-09']);
    const sep = body.periods.find((p) => p.period_value === '2026-09');
    assert.equal(sep.missing_center_count, 1);
  });
});

test('追溯性：引用明细对不存在的判断返回 404', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await get(base, '/judgments/does-not-exist/references');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'JUDGMENT_NOT_FOUND');
  });
});

test('参数校验：非法周期返回 422 并回传允许值；未知字段不导致 500', async () => {
  await withServer(async ({ base }) => {
    const bad = await get(base, '/judgments?period_type=hour&period_value=x');
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
    assert.deepEqual(bad.body.error.details.allowed_period_types, ['day', 'week', 'month']);

    const empty = await get(base, '/judgments?period_type=month&period_value=');
    assert.equal(empty.status, 422);

    const missingPeriod = await get(base, '/judgments');
    assert.equal(missingPeriod.status, 422);
  });
});

test('中文内容端到端往返一致（中心名与指标名不被编码破坏）', async () => {
  await withServer(async ({ base }) => {
    const { body } = await get(base, `/judgments?${FULL}`);
    const supplyChain = body.domains.find((d) => d.center === 'supply_chain');
    assert.equal(supplyChain.center_label, '供应链中心');
    assert.equal(supplyChain.metrics.find((m) => m.code === 'purchase_ontime_rate').name, '采购到货及时率');
    assert.match(body.conclusion, /供应链中心/);
    assert.match(body.conclusion, /未重算任何专业中心内部指标/);
  });
});

test('接口契约：路径与字段命名与架构方案 3.2.2 一致', async () => {
  await withServer(async ({ base, repos }) => {
    // 路径契约：/judgments、/judgments/{id}/references、/conclusions、/conclusions/ingest
    const judgment = await get(base, `/judgments?${FULL}`);
    assert.equal(judgment.status, 200);
    const ingested = await post(base, '/conclusions/ingest', { period_type: 'month', period_value: '2026-08' });
    assert.equal(ingested.status, 201);
    // 判断落库：粒度 = 周期 + 规则版本
    const stored = await repos.judgmentRepository.findByPeriod({
      periodType: 'month',
      periodValue: '2026-08',
      ruleVersion: judgment.body.rule_version,
    });
    assert.ok(stored, '判断须按 (周期, 规则版本) 落库');
    assert.deepEqual(stored.missing_domains, []);
    assert.equal(stored.referenced_conclusion_ids.length, 4);
    // 留痕：接入与判断生成均写审计
    const audits = await repos.reasonRepository.listAudits();
    assert.ok(audits.some((a) => a.action === 'conclusion.ingest'));
    assert.ok(audits.some((a) => a.action === 'judgment.generate'));
  });
});
