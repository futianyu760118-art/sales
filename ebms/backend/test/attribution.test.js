// 领域规则单测 —— 直接对应 PAND-80 的 AC 判定标准
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTRIBUTION_STATUS,
  CONTRIBUTION_TOLERANCE_PCT,
  DIRECTION_LABEL,
  DIRECTION_VALUES,
  buildReasonListResponse,
  buildReasonTree,
  classifyAttribution,
  roundPct,
  validateReasons,
} from '../src/domain/attribution.js';

const metric = {
  id: 'm-1',
  code: 'revenue',
  name: '营业收入',
  dimension: 'finance',
  unit: '万元',
  period_type: 'month',
  period_value: '2026-08',
  target: 1000,
  actual: 880,
  threshold_pct: 5,
  data_status: 'ok',
  as_of: '2026-09-05T00:00:00+08:00',
};

const reason = (over = {}) => ({
  id: 'r-1',
  metric_id: 'm-1',
  parent_id: null,
  name: '单价下调',
  direction: 'negative',
  contribution_pct: 100,
  impact_value: -120,
  owner: '销售中心',
  order_no: 1,
  ...over,
});

test('判定标准：影响方向取值仅限 正向/负向/中性', () => {
  assert.deepEqual(DIRECTION_VALUES, ['positive', 'negative', 'neutral']);
  assert.equal(DIRECTION_LABEL.positive, '正向');
  assert.equal(DIRECTION_LABEL.negative, '负向');
  assert.equal(DIRECTION_LABEL.neutral, '中性');

  const invalid = validateReasons([reason({ direction: 'up' })]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors[0].code, 'DIRECTION_INVALID');
  // 每个合法方向都必须通过方向校验
  for (const direction of DIRECTION_VALUES) {
    const res = validateReasons([reason({ direction })]);
    assert.equal(res.errors.some((e) => e.code === 'DIRECTION_INVALID'), false, `${direction} 应通过`);
  }
});

test('判定标准：影响量或贡献占比至少一项（AC 场景 1 字段完整性）', () => {
  const res = validateReasons([reason({ contribution_pct: null, impact_value: null })]);
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'CONTRIBUTION_REQUIRED');

  const onlyImpact = validateReasons([reason({ contribution_pct: null, impact_value: -120 })]);
  assert.equal(onlyImpact.ok, true);
});

test('场景 2：完全归因时贡献占比合计 = 100%（误差 ≤ 1%）', () => {
  const rows = [
    reason({ id: 'r-1', contribution_pct: 45 }),
    reason({ id: 'r-2', contribution_pct: 35 }),
    reason({ id: 'r-3', contribution_pct: 20 }),
  ];
  const { ok } = validateReasons(rows);
  assert.equal(ok, true);

  const result = buildReasonListResponse({ metric, rows });
  assert.equal(result.attribution.status, ATTRIBUTION_STATUS.FULLY);
  assert.equal(result.attribution.status_label, '完全归因');
  assert.equal(result.attribution.total_contribution_pct, 100);
  assert.equal(result.attribution.fully_attributed, true);
  assert.equal(result.attribution.sums_to_100_within_tolerance, true);
});

test('场景 2 边界：四舍五入误差 ≤ 1% 仍判定为完全归因', () => {
  // 33.33 × 3 = 99.99，误差 0.01% ≤ 1%
  const rows = [
    reason({ id: 'r-1', contribution_pct: 33.33 }),
    reason({ id: 'r-2', contribution_pct: 33.33 }),
    reason({ id: 'r-3', contribution_pct: 33.33 }),
  ];
  assert.equal(validateReasons(rows).ok, true);
  const result = buildReasonListResponse({ metric, rows });
  assert.equal(result.attribution.status, ATTRIBUTION_STATUS.FULLY);
  assert.equal(result.attribution.total_contribution_pct, 99.99);
  assert.equal(result.attribution.sums_to_100_within_tolerance, true);
  assert.ok(Math.abs(100 - result.attribution.total_contribution_pct) <= CONTRIBUTION_TOLERANCE_PCT);
});

test('场景 2 反例：合计超出 100% + 容差 时写入被拒绝', () => {
  const rows = [
    reason({ id: 'r-1', contribution_pct: 70 }),
    reason({ id: 'r-2', contribution_pct: 40 }),
  ];
  const res = validateReasons(rows);
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'CONTRIBUTION_OVER_100');

  // 恰好在容差内（101%）不拦截
  const withinTolerance = validateReasons([
    reason({ id: 'r-1', contribution_pct: 70 }),
    reason({ id: 'r-2', contribution_pct: 31 }),
  ]);
  assert.equal(withinTolerance.ok, true);
});

test('部分归因：顶层合计 < 100% 时如实暴露未归因余量，不伪造 100%', () => {
  const rows = [
    reason({ id: 'r-1', contribution_pct: 40 }),
    reason({ id: 'r-2', contribution_pct: 30 }),
  ];
  const result = buildReasonListResponse({ metric, rows });
  assert.equal(result.attribution.status, ATTRIBUTION_STATUS.PARTIAL);
  assert.equal(result.attribution.status_label, '部分归因');
  assert.equal(result.attribution.total_contribution_pct, 70);
  assert.equal(result.attribution.unattributed_pct, 30);
  assert.equal(result.attribution.fully_attributed, false);
});

test('场景 3：Reason 层位于固定四层链路且允许多级展开', () => {
  const rows = [
    reason({ id: 'r-1', contribution_pct: 45 }),
    reason({ id: 'r-2', contribution_pct: 35 }),
    reason({ id: 'r-2-1', parent_id: 'r-2', contribution_pct: 20 }),
    reason({ id: 'r-2-2', parent_id: 'r-2', contribution_pct: 15 }),
    reason({ id: 'r-2-1-1', parent_id: 'r-2-1', contribution_pct: 12, direction: 'neutral' }),
    reason({ id: 'r-2-1-2', parent_id: 'r-2-1', contribution_pct: 8 }),
    reason({ id: 'r-3', contribution_pct: 20 }),
  ];
  const result = buildReasonListResponse({ metric, rows });
  assert.deepEqual(result.chain.layers, ['RESULT', 'REASON', 'EVIDENCE', 'SOURCE']);
  assert.equal(result.chain.current, 'REASON');
  assert.equal(result.chain.reason_expandable, true);

  // 多级展开：L1 → L2 → L3
  const roots = result.reasons;
  assert.equal(roots.length, 3, '顶层原因 3 条');
  const rev2 = roots.find((r) => r.id === 'r-2');
  assert.equal(rev2.level, 1);
  assert.equal(rev2.expandable, true);
  assert.equal(rev2.child_count, 2);

  const child = rev2.children.find((c) => c.id === 'r-2-1');
  assert.equal(child.level, 2);
  assert.equal(child.path.join('>'), 'r-2>r-2-1');
  assert.equal(child.children.length, 2);
  assert.equal(child.children[0].level, 3);
  assert.equal(child.children[0].path.join('>'), 'r-2>r-2-1>r-2-1-1');
  assert.equal(child.children[0].direction_label, '中性');

  // 多级细分不重复计入顶层合计：合计仍为 45+35+20 = 100%
  assert.equal(result.attribution.total_contribution_pct, 100);
  assert.equal(result.attribution.status, ATTRIBUTION_STATUS.FULLY);
  // 父项已细分比例
  assert.equal(rev2.decomposed_pct, 35);
  assert.equal(rev2.undecomposed_pct, 0);
});

test('多级展开：子项合计超出父项时写入被拒绝', () => {
  const rows = [
    reason({ id: 'r-1', contribution_pct: 50 }),
    reason({ id: 'r-1-1', parent_id: 'r-1', contribution_pct: 40 }),
    reason({ id: 'r-1-2', parent_id: 'r-1', contribution_pct: 30 }),
  ];
  const res = validateReasons(rows);
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'CHILD_CONTRIBUTION_OVER_PARENT');
});

test('校验：父项不存在与环引用被拦截', () => {
  const orphan = validateReasons([reason({ id: 'r-x', parent_id: 'nope', contribution_pct: 100 })]);
  assert.equal(orphan.errors[0].code, 'PARENT_NOT_FOUND');

  const cyclic = validateReasons([
    reason({ id: 'a', parent_id: 'b', contribution_pct: 50 }),
    reason({ id: 'b', parent_id: 'a', contribution_pct: 50 }),
  ]);
  assert.equal(cyclic.ok, false);
  assert.ok(cyclic.errors.some((e) => e.code === 'PARENT_CYCLE' || e.code === 'PARENT_NOT_FOUND'));
});

test('边界：指标无关联原因时返回「未归因」+ 关联入口，不返回空列表', () => {
  const result = buildReasonListResponse({ metric, rows: [] });
  assert.equal(result.attribution.status, ATTRIBUTION_STATUS.UNATTRIBUTED);
  assert.equal(result.attribution.status_label, '未归因');
  assert.equal(result.attribution.reason_count, 0);
  assert.deepEqual(result.reasons, []);

  assert.ok(result.empty_state, '必须提供未归因状态，不得仅返回空列表');
  assert.equal(result.empty_state.code, 'UNATTRIBUTED');
  assert.equal(result.empty_state.title, '未归因');
  assert.equal(result.empty_state.action.label, '关联原因');
  assert.equal(result.empty_state.action.href, '/api/v1/results/m-1/reasons');
});

test('场景 1：每条原因含名称、影响方向、影响量/贡献占比、责任方', () => {
  const result = buildReasonListResponse({
    metric,
    rows: [reason({ id: 'r-1', name: '汇率折算影响', direction: 'positive', contribution_pct: 100, impact_value: 12.5, owner: '财务中心' })],
  });
  const [item] = result.reasons;
  assert.equal(item.name, '汇率折算影响');
  assert.equal(item.direction, 'positive');
  assert.equal(item.direction_label, '正向');
  assert.equal(item.contribution_pct, 100);
  assert.equal(item.impact_value, 12.5);
  assert.equal(item.owner, '财务中心');
});

test('读取上下文：偏差与阈值标记随指标返回', () => {
  const result = buildReasonListResponse({ metric, rows: [reason()] });
  assert.equal(result.result.deviation_abs, -120);
  assert.equal(result.result.deviation_pct, -12);
  assert.equal(result.result.is_deviated, true);
  assert.equal(result.result.as_of, '2026-09-05T00:00:00+08:00');

  const steady = buildReasonListResponse({ metric: { ...metric, actual: 1010 }, rows: [] });
  assert.equal(steady.result.deviation_pct, 1);
  assert.equal(steady.result.is_deviated, false);
});

test('多级树：order_no 决定同级顺序，父项缺失的原因项被标记为孤儿而非静默丢弃', () => {
  const rows = [
    reason({ id: 'r-2', order_no: 2 }),
    reason({ id: 'r-1', order_no: 1 }),
    reason({ id: 'r-orphan', parent_id: 'r-missing', order_no: 3, contribution_pct: 10 }),
  ];
  const { tree, orphans } = buildReasonTree(rows);
  assert.deepEqual(tree.map((r) => r.id), ['r-1', 'r-2']);
  assert.deepEqual(orphans, ['r-orphan']);
});

test('取整策略统一：roundPct 保留 2 位小数且合计可复现', () => {
  assert.equal(roundPct(33.333333), 33.33);
  assert.equal(roundPct(66.666666), 66.67);
  assert.equal(roundPct(0.005), 0.01);
  const total = roundPct(roundPct(33.33) + roundPct(33.33) + roundPct(33.34));
  assert.equal(total, 100);
});

test('归因状态由顶层合计决定，与子项数量无关', () => {
  assert.equal(classifyAttribution(100).status, ATTRIBUTION_STATUS.FULLY);
  assert.equal(classifyAttribution(99.2).status, ATTRIBUTION_STATUS.FULLY);
  // 容差 ±1% 含端点：99% 与 101% 均落在「误差 ≤ 1%」内，判为完全归因
  assert.equal(classifyAttribution(99).status, ATTRIBUTION_STATUS.FULLY);
  assert.equal(classifyAttribution(101).status, ATTRIBUTION_STATUS.FULLY);
  // 超出容差才算部分归因
  assert.equal(classifyAttribution(98.9).status, ATTRIBUTION_STATUS.PARTIAL);
  assert.equal(classifyAttribution(0).status, ATTRIBUTION_STATUS.UNATTRIBUTED);
});
