// 领域层验收自检：跨域判断规则（PAND-91 / F13）的场景、边界与判定标准。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAIN_MISSING_LABEL,
  JUDGMENT_LEVEL,
  MIN_CONSISTENCY_SAMPLES,
  MIN_PRESENT_DOMAINS,
  RULE_VERSION,
  buildDomainViews,
  evaluateJudgment,
  sampleConsistency,
} from '../src/domain/judgment.js';

const PERIOD = { type: 'month', value: '2026-08' };

function conclusion(center, metrics, extra = {}) {
  return {
    id: `dc-${center}`,
    center,
    period_type: 'month',
    period_value: '2026-08',
    version: extra.version ?? `v-${center}`,
    as_of: extra.as_of ?? '2026-09-05T00:00:00+08:00',
    payload: { center, period: PERIOD, as_of: extra.as_of ?? '2026-09-05T00:00:00+08:00', version: extra.version ?? `v-${center}`, metrics, reasons: extra.reasons ?? [] },
    missing: extra.missing ?? false,
    missing_reason: extra.missing_reason ?? null,
    source_mode: 'api',
    ingested_at: extra.ingested_at ?? '2026-09-09T00:00:00Z',
  };
}

const metric = (code, actual, deviationPct, over = {}) => ({
  code,
  name: over.name ?? code,
  target: over.target ?? 100,
  actual,
  unit: over.unit ?? '%',
  deviation_abs: over.deviation_abs ?? actual - (over.target ?? 100),
  deviation_pct: deviationPct,
  threshold_pct: over.threshold_pct ?? 5,
  data_status: over.data_status ?? 'ok',
});

test('场景 2：EBMS 不重算中心指标——中心上报偏差与目标/实际不一致时，以中心上报值为准', () => {
  // 目标 100 / 实际 80 若由 EBMS 反推应为 -20%；中心上报 -5% 属其内部口径（如口径调整），EBMS 必须原样引用
  const rows = [
    conclusion('sales', [metric('revenue', 80, -5)]),
    conclusion('finance', [metric('gross_margin', 70, -30)]),
  ];
  const evaluation = evaluateJudgment({ conclusions: rows, period: PERIOD });
  const sales = evaluation.domains.find((d) => d.center === 'sales');
  assert.equal(sales.metrics[0].deviation_pct, -5, 'EBMS 不得由 target/actual 反推偏差');
  assert.equal(sales.metrics[0].actual, 80);
  assert.equal(sales.metrics[0].target, 100);
  // 因上报偏差 -5% 未超阈值 5%，销售域不计入负向偏差域
  assert.equal(sales.negative_metric_count, 0);
  assert.equal(evaluation.computation_scope.recomputed, false);
  assert.equal(evaluation.computation_scope.basis, 'center_reported_values_only');
});

test('场景 2：中心未上报偏差字段时标记 unavailable，EBMS 不代为计算', () => {
  const rows = [
    conclusion('sales', [{ code: 'revenue', name: '营业收入', target: 100, actual: 80, unit: '万元', data_status: 'ok' }]),
    conclusion('finance', [metric('gross_margin', 70, -30)]),
  ];
  const evaluation = evaluateJudgment({ conclusions: rows, period: PERIOD });
  const sales = evaluation.domains.find((d) => d.center === 'sales');
  assert.equal(sales.metrics[0].deviation_available, false);
  assert.equal(sales.metrics[0].deviation_pct, null, '未上报偏差应保持空值，不得反推 -20%');
  assert.equal(sales.metrics[0].is_negative_deviation, false);
});

test('场景 1：输出跨域判断结论并列出引用的各专业中心结论', () => {
  const rows = [
    conclusion('sales', [metric('revenue', 880, -12)]),
    conclusion('production', [metric('capacity_utilization', 78, -8.24)]),
  ];
  const evaluation = evaluateJudgment({ conclusions: rows, period: PERIOD });
  assert.equal(evaluation.can_judge, true);
  assert.equal(evaluation.level, JUDGMENT_LEVEL.WARNING);
  assert.equal(evaluation.level_label, '警示');
  assert.equal(evaluation.reference_count, 2);
  const centers = evaluation.references.map((r) => r.center);
  assert.deepEqual(centers, ['sales', 'production']);
  for (const ref of evaluation.references) {
    assert.ok(ref.center_label);
    assert.ok(ref.version, '引用须带结论版本');
    assert.ok(ref.as_of, '引用须带结论时间');
    assert.ok(ref.data_cutoff, '引用须带数据截止时间');
    assert.ok(ref.metrics_cited.length > 0);
  }
  assert.match(evaluation.conclusion, /未重算任何专业中心内部指标/);
});

test('判定标准：引用可追溯——每条引用均可回查结论快照 id', () => {
  const rows = [conclusion('sales', [metric('revenue', 880, -12)]), conclusion('finance', [metric('gross_margin', 70, -30)])];
  const evaluation = evaluateJudgment({ conclusions: rows, period: PERIOD });
  for (const ref of evaluation.references) {
    assert.ok(ref.conclusion_id, '引用须带结论快照 id 以支持追溯');
  }
});

test('边界：某域数据缺失时标注「该域数据缺失」，其余域仍可判断', () => {
  const rows = [
    conclusion('sales', [metric('revenue', 880, -12)]),
    conclusion('production', [metric('capacity_utilization', 78, -8.24)]),
    conclusion('finance', [metric('gross_margin', 70, -30)]),
    conclusion('supply_chain', [], { missing: true, missing_reason: 'timeout' }),
  ];
  const evaluation = evaluateJudgment({ conclusions: rows, period: PERIOD });
  assert.equal(evaluation.can_judge, true, '单域缺失不得影响其余域判断输出');
  assert.deepEqual(evaluation.present_domains, ['sales', 'production', 'finance']);
  assert.deepEqual(evaluation.missing_domains, ['supply_chain']);
  assert.deepEqual(evaluation.missing_domain_labels, ['供应链中心']);
  assert.equal(evaluation.missing_domain_details[0].label, DOMAIN_MISSING_LABEL);
  assert.equal(evaluation.missing_domain_details[0].reason, 'timeout');
  assert.match(evaluation.conclusion, /该域数据缺失/);
  // 缺失域不产生引用指标，也不进入负向偏差统计
  assert.equal(evaluation.negative_domains.includes('supply_chain'), false);
});

test('边界：完全没有快照的域同样按「该域数据缺失」处理（no_conclusion）', () => {
  const rows = [conclusion('sales', [metric('revenue', 880, -12)]), conclusion('finance', [metric('gross_margin', 70, -30)])];
  const evaluation = evaluateJudgment({ conclusions: rows, period: PERIOD });
  assert.deepEqual(evaluation.missing_domains, ['production', 'supply_chain']);
  assert.equal(evaluation.missing_domain_details[0].reason, 'no_conclusion');
});

test('边界：中心返回结论但全部指标无数据 → 视同该域数据缺失（no_data）', () => {
  const rows = [
    conclusion('sales', [metric('revenue', 880, -12)]),
    conclusion('finance', [metric('gross_margin', 70, -30)]),
    conclusion('production', [metric('capacity_utilization', null, null, { data_status: 'no_data' })]),
  ];
  const evaluation = evaluateJudgment({ conclusions: rows, period: PERIOD });
  const production = evaluation.domains.find((d) => d.center === 'production');
  assert.equal(production.missing, true);
  assert.equal(production.missing_reason, 'no_data');
  assert.deepEqual(evaluation.present_domains, ['sales', 'finance']);
});

test('前置条件：少于 2 个域产出结论时不输出判断（数据不足）', () => {
  const evaluation = evaluateJudgment({ conclusions: [conclusion('sales', [metric('revenue', 880, -12)])], period: PERIOD });
  assert.equal(evaluation.can_judge, false);
  assert.equal(evaluation.level, JUDGMENT_LEVEL.INSUFFICIENT);
  assert.equal(evaluation.min_present_domains, MIN_PRESENT_DOMAINS);
  assert.match(evaluation.conclusion, /未达到/);
});

test('判断层级按「存在负向偏差的域」计数分档', () => {
  const two = evaluateJudgment({
    conclusions: [conclusion('sales', [metric('revenue', 880, -12)]), conclusion('finance', [metric('gross_margin', 70, -30)])],
    period: PERIOD,
  });
  assert.equal(two.level, JUDGMENT_LEVEL.WARNING);

  const none = evaluateJudgment({
    conclusions: [conclusion('sales', [metric('revenue', 1010, 1)]), conclusion('finance', [metric('gross_margin', 33, 3)])],
    period: PERIOD,
  });
  assert.equal(none.level, JUDGMENT_LEVEL.STABLE);

  const three = evaluateJudgment({
    conclusions: [
      conclusion('sales', [metric('revenue', 880, -12)]),
      conclusion('finance', [metric('gross_margin', 70, -30)]),
      conclusion('production', [metric('capacity_utilization', 78, -8.24)]),
    ],
    period: PERIOD,
  });
  assert.equal(three.level, JUDGMENT_LEVEL.CRITICAL);
});

test('正向偏差不构成「负向偏差域」——仅按上报符号与阈值判定', () => {
  const evaluation = evaluateJudgment({
    conclusions: [
      conclusion('sales', [metric('revenue', 1080, 8)]),
      conclusion('supply_chain', [metric('purchase_price_index', 108, 8)]),
    ],
    period: PERIOD,
  });
  assert.equal(evaluation.negative_domains.length, 0);
  assert.equal(evaluation.level, JUDGMENT_LEVEL.STABLE);
});

test('跨域耦合：多个域上报同一指标 code 时提示跨域关联，附各域上报值', () => {
  const rows = [
    conclusion('sales', [metric('on_time_delivery', 87, -13)]),
    conclusion('production', [metric('on_time_delivery', 87, -13)]),
  ];
  const evaluation = evaluateJudgment({ conclusions: rows, period: PERIOD });
  assert.equal(evaluation.coupled_metrics.length, 1);
  const coupled = evaluation.coupled_metrics[0];
  assert.equal(coupled.metric_code, 'on_time_delivery');
  assert.deepEqual(coupled.centers, ['sales', 'production']);
  assert.equal(coupled.reported_values.length, 2);
  assert.match(evaluation.conclusion, /跨域关联指标/);
});

test('域视图：缺失域占位在固定四域中，顺序稳定且不丢域', () => {
  const views = buildDomainViews([conclusion('finance', [metric('gross_margin', 70, -30)])]);
  assert.deepEqual(views.map((v) => v.center), ['sales', 'production', 'finance', 'supply_chain']);
  assert.equal(views.filter((v) => v.missing).length, 3);
});

test('判定标准：抽样不少于 10 条比对且一致率 100%', () => {
  const rows = [
    conclusion('sales', [metric('revenue', 880, -12), metric('on_time_delivery', 87, -13)]),
    conclusion('production', [metric('capacity_utilization', 78, -8.24), metric('on_time_delivery', 87, -13)]),
    conclusion('finance', [metric('gross_margin', 70, -30), metric('expense_ratio', 17.2, -4.44)]),
  ];
  const report = sampleConsistency({ conclusions: rows, period: PERIOD });
  assert.ok(
    report.compared_count >= MIN_CONSISTENCY_SAMPLES,
    `有效比对样本须不少于 ${MIN_CONSISTENCY_SAMPLES} 条，实际 ${report.compared_count}`,
  );
  assert.equal(report.meets_minimum, true);
  assert.equal(report.consistent_rate, 1);
  assert.equal(report.unexplained_difference_count, 0);
  assert.equal(report.all_differences_explained, true);
});

test('判定标准：抽样覆盖多个域，而非集中在首个域', () => {
  const rows = [
    conclusion('sales', [metric('revenue', 880, -12), metric('on_time_delivery', 87, -13)]),
    conclusion('production', [metric('capacity_utilization', 78, -8.24), metric('on_time_delivery', 87, -13)]),
    conclusion('finance', [metric('gross_margin', 70, -30), metric('expense_ratio', 17.2, -4.44)]),
    conclusion('supply_chain', [metric('purchase_ontime_rate', 88, -7.37), metric('purchase_price_index', 108, 8)]),
  ];
  const report = sampleConsistency({ conclusions: rows, period: PERIOD, sampleSize: 12 });
  const sampledCenters = new Set(report.samples.filter((s) => !s.skipped).map((s) => s.center));
  assert.equal(sampledCenters.size, 4, '抽样须覆盖全部参与域');
});

test('判定标准：有效样本不足 10 条时判定不成立（不静默通过）', () => {
  const rows = [
    conclusion('sales', [metric('revenue', 880, -12)]),
    conclusion('finance', [metric('gross_margin', 70, -30)]),
  ];
  const report = sampleConsistency({ conclusions: rows, period: PERIOD });
  assert.ok(report.compared_count < MIN_CONSISTENCY_SAMPLES);
  assert.equal(report.meets_minimum, false);
});

test('判定标准：缺失域样本不计入一致率分母，并给出缺失说明', () => {
  const rows = [
    conclusion('sales', [metric('revenue', 880, -12), metric('on_time_delivery', 87, -13), metric('new_order_amount', 1260, 5)]),
    conclusion('production', [metric('capacity_utilization', 78, -8.24)]),
    conclusion('finance', [metric('gross_margin', 70, -30)]),
    conclusion('supply_chain', [], { missing: true, missing_reason: 'timeout' }),
  ];
  const report = sampleConsistency({ conclusions: rows, period: PERIOD, sampleSize: 10 });
  const skipped = report.samples.filter((s) => s.skipped);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].center, 'supply_chain');
  assert.match(skipped[0].note, /该域数据缺失/);
  assert.equal(report.inconsistent_count, 0);
  assert.equal(report.compared_count, report.samples.length - 1, '缺失域不计入一致率分母');
});

test('规则版本与口径声明随判断输出，便于审计与引用追溯', () => {
  const evaluation = evaluateJudgment({
    conclusions: [conclusion('sales', [metric('revenue', 880, -12)]), conclusion('finance', [metric('gross_margin', 70, -30)])],
    period: PERIOD,
  });
  assert.equal(evaluation.rule_version, RULE_VERSION);
  assert.equal(evaluation.computation_scope.rule_version, RULE_VERSION);
  assert.match(evaluation.computation_scope.note, /不做什么|不做任何/);
});
