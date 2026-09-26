// 接口级验收自检：以真实 HTTP 请求逐条验证 PAND-92 的场景、边界与判定标准
// ——「跨域判断中引用专业中心结论处，标注来源中心与结论时间 / 版本」。
// 数据层走 repository 内存实现，结论快照取 004_seed_cross_domain.sql 同源种子。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory/memoryRepositories.js';
import { createAdapters } from '../src/ingest/centerAdapters.js';
import { CENTER_PAYLOADS, buildSeedConclusions } from '../src/dev/seedCrossDomain.js';
import {
  CENTER_LABEL,
  SOURCE_UNAVAILABLE_LABEL,
  buildSourceCitations,
  verifySourceLabels,
} from '../src/domain/judgment.js';

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

test('场景 1：引用处标注来源中心名称（四域）与结论时间 / 版本', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await get(base, `/judgments?${FULL}`);
    assert.equal(status, 200);
    assert.equal(body.reference_count, 4);
    assert.equal(body.source_citations.length, 4);
    assert.equal(body.unavailable_source_count, 0);

    // 引用位置逐一给出非空来源标注，且中心名称取自已确认四域
    const expectedCenters = ['sales', 'production', 'finance', 'supply_chain'];
    assert.deepEqual(body.source_citations.map((c) => c.center), expectedCenters);
    for (const citation of body.source_citations) {
      const label = citation.source_label;
      assert.equal(label.available, true, `${citation.center} 来源应可用`);
      assert.ok(label.label, `${citation.center} 来源标注不得为空`);
      assert.ok(label.label.includes(CENTER_LABEL[citation.center]), '标注须含来源中心名称');
      assert.ok(
        label.conclusion_time || label.conclusion_version,
        '标注须含结论时间或版本',
      );
    }

    // 与中心输出逐字段一致：结论时间 / 版本取自快照，EBMS 不推算
    const sales = body.source_citations.find((c) => c.center === 'sales');
    const salesOutput = CENTER_PAYLOADS['sales|month|2026-08'];
    assert.equal(sales.source_label.conclusion_time, salesOutput.as_of);
    assert.equal(sales.source_label.conclusion_version, salesOutput.version);
    assert.equal(sales.source_label.label, `销售中心 · 2026-09-05 · 版本 ${salesOutput.version}`);

    // 引用明细同样逐条带来源标注（既有引用结构向上叠加，不移除原字段）
    for (const ref of body.references) {
      assert.ok(ref.source_label?.label, '引用明细每条须带来源标注');
      assert.ok(ref.version, '原结论版本字段保留');
      assert.ok(ref.as_of, '原结论时间字段保留');
    }
  });
});

test('判定标准：每条引用均有非空的来源标注（来源中心名称 + 结论时间 / 版本）', async () => {
  await withServer(async ({ base }) => {
    const { body: judgment } = await get(base, `/judgments?${FULL}`);
    const { status, body } = await get(base, `/judgments/${judgment.judgment_id}/source-labels`);
    assert.equal(status, 200);
    assert.equal(body.judgment_id, judgment.judgment_id);
    assert.equal(body.total, 4);
    assert.equal(body.labeled_count, 4);
    assert.equal(body.unlabeled_count, 0);
    assert.deepEqual(body.unlabeled, []);
    assert.equal(body.available_count, 4);
    assert.equal(body.unavailable_count, 0);
    assert.equal(body.incomplete_available_count, 0);
    assert.equal(body.all_labeled, true);
    assert.equal(body.passed, true);
    assert.match(body.verdict, /来源标注齐全/);
    // 抽取核对：标注同时含中心名称与结论时间 / 版本
    for (const citation of body.citations) {
      assert.ok(citation.source_label.center_label);
      assert.ok(citation.source_label.conclusion_time);
      assert.ok(citation.source_label.label.includes(citation.source_label.center_label));
    }
  });
});

test('边界：来源不可用时引用位置显示「来源不可用」，其余域标注正常', async () => {
  await withServer(async ({ base }) => {
    const { body: judgment } = await get(base, `/judgments?${MISSING}`);
    assert.equal(judgment.unavailable_source_count, 1);
    assert.equal(judgment.source_citations.length, 4);

    // 供应链域结论不可用 → 该引用位置标注「来源不可用」
    const supplyChain = judgment.source_citations.find((c) => c.center === 'supply_chain');
    assert.equal(supplyChain.source_label.available, false);
    assert.equal(supplyChain.source_label.label, SOURCE_UNAVAILABLE_LABEL);
    assert.equal(supplyChain.source_label.center_label, '供应链中心');
    assert.equal(supplyChain.source_label.unavailable_reason, 'source_missing');

    // 其余三域标注正常且非空
    const present = judgment.source_citations.filter((c) => c.center !== 'supply_chain');
    assert.equal(present.length, 3);
    for (const citation of present) {
      assert.equal(citation.source_label.available, true);
      assert.notEqual(citation.source_label.label, SOURCE_UNAVAILABLE_LABEL, '可用来源不得标注「来源不可用」');
    }
    const sales = judgment.source_citations.find((c) => c.center === 'sales');
    assert.match(sales.source_label.label, /销售中心/);
  });
});

test('边界：结论快照缺结论时间与版本时，来源标注显示「来源不可用」而非空白占位', async () => {
  await withServer(async ({ base, repos }) => {
    // 快照存在、指标可用，但 version 与 as_of 均为空 → 来源标注无从构成
    await repos.conclusionRepository.upsertMany([
      {
        id: 'dc-sales-unattributed',
        center: 'sales',
        period_type: 'month',
        period_value: '2026-07',
        version: null,
        as_of: null,
        payload: {
          center: 'sales',
          metrics: [
            { code: 'revenue', name: '营业收入', target: 1000, actual: 980, unit: '万元', deviation_abs: -20, deviation_pct: -2, threshold_pct: 5, data_status: 'ok' },
          ],
        },
        missing: false,
        missing_reason: null,
        source_mode: 'api',
        ingested_at: '2026-08-06T00:00:00Z',
      },
    ]);
    const { body: judgment } = await get(base, '/judgments?period_type=month&period_value=2026-07');
    const sales = judgment.source_citations.find((c) => c.center === 'sales');
    assert.equal(sales.source_label.available, false);
    assert.equal(sales.source_label.label, SOURCE_UNAVAILABLE_LABEL);
    assert.equal(sales.source_label.unavailable_reason, 'no_time_or_version');
    // 不得以 '—' / 空串之类占位符充当来源标注
    assert.notEqual(sales.source_label.label, '—');
    assert.notEqual(sales.source_label.label.trim(), '');

    // 该判断的来源标注核验仍然通过：不可用位置标注齐全，不存在空标注引用
    const { body: report } = await get(base, `/judgments/${judgment.judgment_id}/source-labels`);
    assert.equal(report.unlabeled_count, 0);
    assert.equal(report.available_count, 0);
    assert.equal(report.unavailable_count, 4, '四域引用位置均标注「来源不可用」');
    assert.equal(report.passed, true);
  });
});

test('判定标准：存在空来源标注时判定不通过，不静默通过', async () => {
  // 领域层不变量直接核验：构造「引用存在但来源标注为空」的越界数据
  const citations = [
    ...buildSourceCitations([
      { center: 'sales', center_label: '销售中心', conclusion_id: 'dc-1', missing: false, version: 'v1', as_of: '2026-09-05T00:00:00+08:00' },
    ]),
    {
      center: 'finance',
      center_label: '财务中心',
      conclusion_id: null,
      missing: false,
      source_label: { available: false, label: '   ', center_label: '财务中心', conclusion_time: null, conclusion_version: null },
    },
  ];
  const report = verifySourceLabels(citations);
  assert.equal(report.total, 2);
  assert.equal(report.unlabeled_count, 1);
  assert.equal(report.all_labeled, false);
  assert.equal(report.passed, false);
  assert.equal(report.unlabeled[0].center, 'finance');

  // 可用来源缺少中心名称或结论时间 / 版本同样不通过
  const incomplete = verifySourceLabels([
    {
      center: 'sales',
      center_label: '销售中心',
      source_label: { available: true, label: '销售中心 · v1', center_label: '销售中心', conclusion_time: null, conclusion_version: 'v1' },
    },
  ]);
  assert.equal(incomplete.passed, true, '含中心名称 + 版本即满足判定');

  const broken = verifySourceLabels([
    {
      center: 'sales',
      center_label: '销售中心',
      source_label: { available: true, label: '销售中心', center_label: '销售中心', conclusion_time: null, conclusion_version: null },
    },
  ]);
  assert.equal(broken.passed, false);
  assert.equal(broken.incomplete_available_count, 1);
});

test('PAND-92 不改变既有引用与判断口径：reference_count / 缺失域语义保持不变', async () => {
  await withServer(async ({ base }) => {
    const { body } = await get(base, `/judgments?${MISSING}`);
    // 缺失域仍不进引用明细（PAND-91 口径），来源标注位置单列于 source_citations
    assert.equal(body.reference_count, 3);
    assert.deepEqual(body.missing_domains, ['supply_chain']);
    assert.equal(body.missing_domain_details[0].label, '该域数据缺失');
    assert.equal(body.computation_scope.recomputed, false);
    assert.equal(body.references.every((r) => r.missing === false), true);
  });
});

test('异常处理：对不存在的判断核验来源标注返回 404', async () => {
  await withServer(async ({ base }) => {
    const { status, body } = await get(base, '/judgments/does-not-exist/source-labels');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'JUDGMENT_NOT_FOUND');
  });
});
