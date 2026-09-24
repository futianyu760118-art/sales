// 视图级验收自检：以真实组件渲染验证 PAND-91（F13）的场景、边界与判定标准在 UI 上的呈现。
// 桩数据与后端 evaluateJudgment / sampleConsistency 的读模型同构（见 domain/judgment.js）。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const apiMock = vi.hoisted(() => ({
  getJudgment: vi.fn(),
  getJudgmentReferences: vi.fn(),
  getConsistency: vi.fn(),
  getJudgmentPeriods: vi.fn(),
  ingestConclusions: vi.fn(),
}));

vi.mock('../src/api/client.js', () => ({ api: apiMock }));

const JudgmentView = (await import('../src/views/JudgmentView.vue')).default;

const PERIOD = { type: 'month', value: '2026-08' };

function metric(code, name, { target = 100, actual = 90, deviationAbs = -10, deviationPct = -10, thresholdPct = 5, unit = '%', dataStatus = 'ok' } = {}) {
  const negative = dataStatus === 'ok' && deviationPct !== null && deviationPct < 0 && Math.abs(deviationPct) > thresholdPct;
  return {
    code,
    name,
    unit,
    target,
    actual,
    deviation_abs: deviationAbs,
    deviation_pct: deviationPct,
    threshold_pct: thresholdPct,
    effective_threshold_pct: thresholdPct,
    data_status: dataStatus,
    data_status_label: dataStatus === 'ok' ? '正常' : '无数据',
    deviation_available: deviationPct !== null,
    is_negative_deviation: negative,
  };
}

function domain(center, centerLabel, metrics, extra = {}) {
  const missing = extra.missing ?? false;
  const reasons = extra.reasons ?? [];
  return {
    center,
    center_label: centerLabel,
    reasons: missing ? [] : reasons,
    missing,
    missing_reason: extra.missing_reason ?? null,
    missing_reason_label: extra.missing_reason_label ?? null,
    missing_label: missing ? '该域数据缺失' : null,
    conclusion_id: extra.conclusion_id ?? `dc-${center}-202608`,
    version: extra.version ?? `v-${center}`,
    as_of: extra.as_of ?? '2026-09-05T00:00:00+08:00',
    data_cutoff: extra.data_cutoff ?? '2026-09-05T00:00:00+08:00',
    source_mode: 'api',
    metrics,
    metrics_ok_count: metrics.filter((m) => m.data_status === 'ok').length,
    negative_metric_count: metrics.filter((m) => m.is_negative_deviation).length,
    negative_metric_codes: metrics.filter((m) => m.is_negative_deviation).map((m) => m.code),
    reason_count: missing ? 0 : reasons.length,
    headline_metric: metrics[0] ?? null,
    negative_headline_metric: metrics.find((m) => m.is_negative_deviation) ?? null,
  };
}

// 场景 2 关键样本：中心上报偏差 -5%，若由 target/actual 反推应为 -20% —— EBMS 必须原样展示 -5%。
const SALES_METRIC_REPORTED = metric('revenue', '营业收入', {
  target: 100,
  actual: 80,
  deviationAbs: -20,
  deviationPct: -5, // 中心内部口径：虽有偏差但未超阈值
  unit: '万元',
});

const FULL = {
  judgment_id: 'jd-202608',
  period: PERIOD,
  level: 'critical',
  level_label: '严重',
  rule_version: 'cross-domain-v1',
  conclusion:
    '本期（2026-08）跨域经营判断为「严重」：参与判断 4 个域。销售中心 营业收入 -12%、财务中心 毛利率 -20%、生产/交付中心 产能利用率 -8.24%、供应链中心 采购到货及时率 -7.37% 存在超出阈值的负向偏差。跨域关联指标：订单交付率（销售中心 / 生产/交付中心），存在跨域传导可能，需结合归因层进一步核实。本结论基于各专业中心上报结论汇聚，未重算任何专业中心内部指标。',
  computation_scope: {
    recomputed: false,
    basis: 'center_reported_values_only',
    rule_version: 'cross-domain-v1',
    note: '展示值与引用值均取自专业中心上报结论快照，EBMS 不做任何中心内部指标的重新计算。',
  },
  domains: [
    domain('sales', '销售中心', [
      SALES_METRIC_REPORTED,
      metric('on_time_delivery', '订单交付率', { target: 100, actual: 87, deviationAbs: -13, deviationPct: -13 }),
    ], { reasons: [{ metric_code: 'revenue', name: '主力产品单价下调', direction: 'negative', contribution_pct: 45, owner: '销售中心' }] }),
    domain('production', '生产/交付中心', [
      metric('capacity_utilization', '产能利用率', { target: 85, actual: 78, deviationAbs: -7, deviationPct: -8.24 }),
    ], { reasons: [{ metric_code: 'capacity_utilization', name: '设备故障停机', direction: 'negative', contribution_pct: 40, owner: '生产交付中心' }] }),
    domain('finance', '财务中心', [
      metric('gross_margin', '毛利率', { target: 32, actual: 25.6, deviationAbs: -6.4, deviationPct: -20 }),
    ], { reasons: [] }),
    domain('supply_chain', '供应链中心', [
      metric('purchase_ontime_rate', '采购到货及时率', { target: 95, actual: 88, deviationAbs: -7, deviationPct: -7.37 }),
      // 中心未上报偏差字段：EBMS 不得代为反推
      metric('inventory_turnover_days', '库存周转天数', { target: 45, actual: 48, deviationAbs: null, deviationPct: null, unit: '天' }),
    ], { reasons: [{ metric_code: 'purchase_ontime_rate', name: '供应商交付延迟', direction: 'negative', contribution_pct: 70, owner: '供应链中心' }] }),
  ],
  present_domains: ['sales', 'production', 'finance', 'supply_chain'],
  missing_domains: [],
  missing_domain_labels: [],
  missing_domain_details: [],
  negative_domains: ['sales', 'production', 'finance', 'supply_chain'],
  coupled_metrics: [
    {
      metric_code: 'on_time_delivery',
      metric_name: '订单交付率',
      centers: ['sales', 'production'],
      center_labels: ['销售中心', '生产/交付中心'],
      reported_values: [],
    },
  ],
  references: ['sales', 'production', 'finance', 'supply_chain'].map((center, index) => ({
    conclusion_id: `dc-${center}-202608`,
    center,
    center_label: ['销售中心', '生产/交付中心', '财务中心', '供应链中心'][index],
    version: `v2026-08.${index + 1}`,
    as_of: '2026-09-05T00:00:00+08:00',
    data_cutoff: '2026-09-05T00:00:00+08:00',
    source_mode: 'api',
    missing: false,
    metrics_cited: [],
    reasons_cited: [],
    reasons_cited_count: 0,
  })),
  reference_count: 4,
  can_judge: true,
  min_present_domains: 2,
  generated_at: '2026-09-09T00:00:00Z',
};

const REFERENCES = {
  judgment_id: 'jd-202608',
  period: PERIOD,
  level: 'critical',
  conclusion: FULL.conclusion,
  rule_version: 'cross-domain-v1',
  reference_count: 4,
  present_reference_count: 4,
  references: FULL.references.map((ref, index) => ({
    ...ref,
    metrics_cited: [{ code: 'revenue', name: '营业收入', unit: '万元', actual: 880, target: 1000, deviation_abs: -120, deviation_pct: -12, data_status: 'ok' }],
    reasons_cited_count: index,
  })),
  missing_domains: [],
  traceability: {
    checked_conclusion_refs: 4,
    resolved_conclusion_refs: 4,
    unresolved_conclusion_ids: [],
    all_resolved: true,
    note: '每条引用均带 center / version / as_of / 数据截止时间，可按 conclusion_id 回查结论快照。',
  },
};

function sample(center, centerLabel, code, name, field, fieldLabel, value) {
  return {
    center,
    center_label: centerLabel,
    conclusion_id: `dc-${center}-202608`,
    version: 'v1',
    metric_code: code,
    metric_name: name,
    field,
    field_label: fieldLabel,
    unit: '%',
    center_value: String(value),
    ebms_value: String(value),
    consistent: true,
    note: null,
    skipped: false,
  };
}

const CONSISTENCY = {
  period: PERIOD,
  rule_version: 'cross-domain-v1',
  sample_size: 10,
  compared_count: 10,
  consistent_count: 10,
  inconsistent_count: 0,
  consistent_rate: 1,
  minimum_sample_size: 10,
  meets_minimum: true,
  unexplained_difference_count: 0,
  all_differences_explained: true,
  scope: { fields: ['actual', 'target', 'deviation_abs', 'deviation_pct'], note: '比对字段为各中心上报的指标取值。' },
  differences: [],
  notes: [],
  passed: true,
  verdict: '抽样 10 条比对，一致率 100%，无未解释差异。',
  samples: [
    ...Array.from({ length: 10 }, (_, i) =>
      sample('sales', '销售中心', i % 2 ? 'on_time_delivery' : 'revenue', i % 2 ? '订单交付率' : '营业收入', i % 2 ? 'deviation_pct' : 'actual', i % 2 ? '偏差百分比' : '实际值', 880 + i),
    ),
  ],
};

function mountView(overrides = {}) {
  const judgment = overrides.judgment ?? FULL;
  const references = overrides.references ?? REFERENCES;
  const consistency = overrides.consistency ?? CONSISTENCY;
  apiMock.getJudgment.mockResolvedValue(judgment);
  apiMock.getJudgmentReferences.mockResolvedValue(references);
  apiMock.getConsistency.mockResolvedValue(consistency);
  apiMock.getJudgmentPeriods.mockResolvedValue({
    count: 2,
    periods: [
      { period_type: 'month', period_value: '2026-08', center_count: 4, missing_center_count: 0 },
      { period_type: 'month', period_value: '2026-09', center_count: 4, missing_center_count: 1 },
    ],
  });
  return mount(JudgmentView, { props: { periodType: 'month', periodValue: '2026-08' } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('场景 1：展示跨域经营判断结论，并列出其引用的各专业中心结论', () => {
  it('渲染判断层级、结论文本与四个专业中心结论卡片', async () => {
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.find('[data-testid="judgment-level"]').text()).toBe('严重');
    const conclusion = wrapper.find('[data-testid="judgment-conclusion"]').text();
    expect(conclusion).toContain('跨域经营判断为「严重」');
    expect(conclusion).toContain('未重算任何专业中心内部指标');
    expect(conclusion).toContain('跨域关联指标');

    const cards = wrapper.findAll('[data-testid="domain-card"]');
    expect(cards.length).toBe(4);
    expect(cards.map((c) => c.find('.domain-card__title').text())).toEqual([
      '销售中心',
      '生产/交付中心',
      '财务中心',
      '供应链中心',
    ]);
    // 每张卡片列出该域上报指标与其取值
    expect(cards[0].findAll('[data-testid="metric-row"]').length).toBe(2);
    expect(cards[0].find('[data-testid="metric-actual"]').text()).toBe('80');
    // 该域上报的原因项一并列出
    expect(cards[0].find('[data-testid="domain-reasons"]').text()).toContain('主力产品单价下调');
  });

  it('引用明细逐条列出并可追溯（带结算快照 id 与结论版本/时间）', async () => {
    const wrapper = mountView();
    await flushPromises();

    const rows = wrapper.findAll('[data-testid="reference-row"]');
    expect(rows.length).toBe(4);
    expect(rows.map((r) => r.attributes('data-center'))).toEqual(['sales', 'production', 'finance', 'supply_chain']);
    for (const row of rows) {
      expect(row.find('[data-testid="reference-conclusion-id"]').text()).toMatch(/^dc-/);
    }
    expect(rows[0].text()).toContain('v2026-08.1');
    expect(wrapper.find('[data-testid="traceability-note"]').text()).toContain('conclusion_id');
  });
});

describe('场景 2：EBMS 不重算中心内部指标，展示值与专业中心输出值一致', () => {
  it('中心上报偏差与目标/实际不一致时，界面展示中心上报值（不反推）', async () => {
    const wrapper = mountView();
    await flushPromises();

    const row = wrapper.find('[data-metric-code="revenue"]');
    // target 100 / actual 80，若重算应为 -20%；展示的必须是中心上报的 -5%
    expect(row.find('[data-testid="metric-actual"]').text()).toBe('80');
    expect(row.find('[data-testid="metric-deviation-pct"]').text()).toBe('-5%');
    expect(row.find('[data-testid="metric-deviation-pct"]').text()).not.toContain('-20');
  });

  it('中心未上报偏差字段时显示「中心未上报」，不代为计算', async () => {
    const wrapper = mountView();
    await flushPromises();
    const row = wrapper.find('[data-metric-code="inventory_turnover_days"]');
    expect(row.find('[data-testid="metric-deviation-unavailable"]').text()).toBe('中心未上报');
  });

  it('显式展示判断口径声明（未重算任何中心内部指标）', async () => {
    const wrapper = mountView();
    await flushPromises();
    const scope = wrapper.find('[data-testid="computation-scope"]').text();
    expect(scope).toContain('EBMS 不做任何中心内部指标的重新计算');
    expect(scope).toContain('recomputed=false');
  });
});

describe('边界：某专业中心数据缺失时标注「该域数据缺失」，其余域仍可判断', () => {
  const missingJudgment = {
    ...FULL,
    judgment_id: 'jd-202609',
    level: 'critical',
    conclusion: '本期（2026-09）跨域经营判断为「严重」：参与判断 3 个域。数据缺失：供应链中心（该域数据缺失：拉取超时）。缺失域不参与本次判断，其余域判断正常输出。',
    domains: [
      FULL.domains[0],
      FULL.domains[1],
      FULL.domains[2],
      domain('supply_chain', '供应链中心', [], { missing: true, missing_reason: 'timeout', missing_reason_label: '拉取超时', conclusion_id: 'dc-supply-chain-202609' }),
    ],
    present_domains: ['sales', 'production', 'finance'],
    missing_domains: ['supply_chain'],
    missing_domain_labels: ['供应链中心'],
    missing_domain_details: [
      { center: 'supply_chain', center_label: '供应链中心', label: '该域数据缺失', reason: 'timeout', reason_label: '拉取超时' },
    ],
    reference_count: 3,
    references: FULL.references.slice(0, 3),
  };

  it('缺失域卡片标注「该域数据缺失」，其余域仍输出完整结论', async () => {
    const wrapper = mountView({ judgment: missingJudgment });
    await flushPromises();

    const missingCard = wrapper.find('[data-center="supply_chain"]');
    expect(missingCard.find('[data-testid="domain-missing-label"]').text()).toBe('该域数据缺失');
    expect(missingCard.find('[data-testid="domain-missing-notice"]').text()).toContain('拉取超时');
    // 缺失域不渲染指标表
    expect(missingCard.find('[data-testid="domain-metrics"]').exists()).toBe(false);

    // 其余域仍有指标与判断结论
    expect(wrapper.findAll('[data-testid="metric-row"]').length).toBeGreaterThan(0);
    expect(wrapper.find('[data-testid="judgment-level"]').text()).toBe('严重');
    expect(wrapper.find('[data-testid="missing-summary-item"]').text()).toContain('其余域判断正常输出');
  });
});

describe('前置条件：不足 2 个域产出结论时不输出判断', () => {
  it('展示数据不足提示，不输出「严重/警示」等层级结论', async () => {
    const wrapper = mountView({
      judgment: {
        ...FULL,
        level: 'insufficient_data',
        level_label: '数据不足',
        can_judge: false,
        conclusion: '本期（2026-08）仅 1 个域产出可用结论，未达到「至少 2 个域」的判断前置，暂不输出跨域判断。',
        present_domains: ['sales'],
        references: [],
        reference_count: 0,
      },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="insufficient-notice"]').text()).toContain('不足 2 个');
    expect(wrapper.find('[data-testid="judgment-level"]').text()).toBe('数据不足');
  });
});

describe('判定标准：抽样不少于 10 条比对，一致率 100%', () => {
  it('展示比对条数、一致率与通过判定，逐条列出中心输出值与 EBMS 展示值', async () => {
    const wrapper = mountView();
    await flushPromises();

    const counts = wrapper.find('[data-testid="consistency-counts"]').text();
    expect(counts).toContain('有效比对 10 条');
    expect(counts).toContain('不少于 10 条');
    expect(counts).toContain('一致率 100%');
    expect(wrapper.find('[data-testid="consistency-verdict"]').text()).toBe('判定通过');
    expect(wrapper.find('[data-testid="consistency-verdict-text"]').text()).toContain('一致率 100%');

    const samples = wrapper.findAll('[data-testid="consistency-sample"]');
    expect(samples.length).toBe(10);
    // 每条样本同时呈现中心输出值与 EBMS 展示值
    expect(samples[0].find('[data-testid="sample-center-value"]').exists()).toBe(true);
    expect(samples[0].find('[data-testid="sample-ebms-value"]').exists()).toBe(true);
  });

  it('有效样本不足 10 条时判定不成立，不静默通过', async () => {
    const wrapper = mountView({
      consistency: {
        ...CONSISTENCY,
        compared_count: 4,
        consistent_count: 4,
        sample_size: 4,
        meets_minimum: false,
        consistent_rate: 1,
        passed: false,
        verdict: '有效比对样本 4 条，少于判定要求的 10 条，判定不成立。',
        samples: CONSISTENCY.samples.slice(0, 4),
      },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="consistency-verdict"]').text()).toBe('判定不成立');
    expect(wrapper.find('[data-testid="consistency-insufficient"]').text()).toContain('少于判定要求');
  });

  it('缺失域样本以口径说明跳过，不计入一致率分母', async () => {
    const wrapper = mountView({
      consistency: {
        ...CONSISTENCY,
        samples: [
          ...CONSISTENCY.samples,
          {
            center: 'supply_chain',
            center_label: '供应链中心',
            conclusion_id: 'dc-supply-chain-202609',
            metric_code: null,
            metric_name: null,
            field: null,
            center_value: null,
            ebms_value: null,
            consistent: true,
            note: '该域数据缺失（拉取超时），无值可比对——缺失域不参与比对。',
            skipped: true,
          },
        ],
      },
    });
    await flushPromises();
    const skipped = wrapper.find('[data-testid="consistency-skipped"]');
    expect(skipped.exists()).toBe(true);
    expect(skipped.text()).toContain('该域数据缺失');
    expect(wrapper.findAll('[data-testid="consistency-sample"]').length).toBe(10);
  });
});

describe('异常处理', () => {
  it('判断接口失败时展示错误提示', async () => {
    apiMock.getJudgment.mockRejectedValue(new Error('周期类型仅限 day / week / month，收到 hour'));
    apiMock.getConsistency.mockRejectedValue(new Error('周期类型仅限 day / week / month，收到 hour'));
    apiMock.getJudgmentPeriods.mockResolvedValue({ count: 0, periods: [] });
    const wrapper = mount(JudgmentView, { props: { periodType: 'hour', periodValue: 'x' } });
    await flushPromises();
    expect(wrapper.find('[data-testid="judgment-error"]').text()).toContain('周期类型仅限');
  });

  it('拉取各中心结论后按最新快照刷新判断', async () => {
    const wrapper = mountView();
    await flushPromises();
    apiMock.ingestConclusions.mockResolvedValue({ ingested_count: 3, missing_count: 1 });
    await wrapper.find('[data-testid="ingest-now"]').trigger('click');
    await flushPromises();

    expect(apiMock.ingestConclusions).toHaveBeenCalledWith({ periodType: 'month', periodValue: '2026-08' });
    expect(wrapper.find('[data-testid="ingest-note"]').text()).toContain('3 个域');
    expect(wrapper.find('[data-testid="ingest-note"]').text()).toContain('1 个域数据缺失');
  });
});
