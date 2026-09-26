// 视图级验收自检：以真实组件渲染验证 PAND-80 的场景与边界在 UI 上的呈现。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const apiMock = vi.hoisted(() => ({
  getReasons: vi.fn(),
  getReasonChildren: vi.fn(),
  linkReasons: vi.fn(),
  updateReason: vi.fn(),
  unlinkReason: vi.fn(),
}));

vi.mock('../src/api/client.js', () => ({ api: apiMock }));

const ReasonListView = (await import('../src/views/ReasonListView.vue')).default;

const CHAIN = { layers: ['RESULT', 'REASON', 'EVIDENCE', 'SOURCE'], current: 'REASON', reason_expandable: true };

const metric = {
  id: 'm-revenue-202608',
  name: '营业收入',
  unit: '万元',
  period: { type: 'month', value: '2026-08' },
  target: 1000,
  actual: 880,
  deviation_abs: -120,
  deviation_pct: -12,
  threshold_pct: 5,
  is_deviated: true,
  data_status: 'ok',
  as_of: '2026-09-05T00:00:00+08:00',
};

const fullyAttributed = {
  chain: CHAIN,
  result: metric,
  attribution: {
    status: 'fully_attributed',
    status_label: '完全归因',
    total_contribution_pct: 100,
    unattributed_pct: 0,
    reason_count: 4,
    root_reason_count: 2,
    tolerance_pct: 1,
    fully_attributed: true,
    sums_to_100_within_tolerance: true,
  },
  reasons: [
    {
      id: 'r-1',
      name: '主力产品单价下调',
      direction: 'negative',
      direction_label: '负向',
      contribution_pct: 60,
      impact_value: -72,
      owner: '销售中心',
      level: 1,
      expandable: false,
      children: [],
    },
    {
      id: 'r-2',
      name: '华东区订单流失',
      direction: 'neutral',
      direction_label: '中性',
      contribution_pct: 40,
      impact_value: -48,
      owner: '销售中心-华东大区',
      level: 1,
      expandable: true,
      child_count: 2,
      decomposed_pct: 40,
      undecomposed_pct: 0,
      children: [
        {
          id: 'r-2-1',
          name: '大客户 A 转投竞品',
          direction: 'negative',
          direction_label: '负向',
          contribution_pct: 25,
          impact_value: -30,
          owner: '销售中心-华东大区',
          level: 2,
          expandable: true,
          child_count: 1,
          decomposed_pct: 25,
          undecomposed_pct: 0,
          children: [
            {
              id: 'r-2-1-1',
              name: '竞品降价 8%',
              direction: 'negative',
              direction_label: '负向',
              contribution_pct: 25,
              impact_value: -30,
              owner: '销售中心-华东大区',
              level: 3,
              expandable: false,
              children: [],
            },
          ],
        },
        {
          id: 'r-2-2',
          name: '渠道库存积压',
          direction: 'positive',
          direction_label: '正向',
          contribution_pct: 15,
          impact_value: -18,
          owner: '生产交付中心',
          level: 2,
          expandable: false,
          children: [],
        },
      ],
    },
  ],
  empty_state: null,
  integrity: { orphan_reason_ids: [], over_attributed: false },
};

const unattributed = {
  chain: CHAIN,
  result: metric,
  attribution: {
    status: 'unattributed',
    status_label: '未归因',
    total_contribution_pct: 0,
    unattributed_pct: 100,
    reason_count: 0,
    root_reason_count: 0,
    tolerance_pct: 1,
    fully_attributed: false,
    sums_to_100_within_tolerance: false,
  },
  reasons: [],
  empty_state: {
    code: 'UNATTRIBUTED',
    title: '未归因',
    message: '该指标本期尚未关联任何原因项，无法完成偏差归因。',
    action: { label: '关联原因', method: 'POST', href: '/api/v1/results/m-revenue-202608/reasons' },
  },
  integrity: { orphan_reason_ids: [], over_attributed: false },
};

function mountView(payload) {
  apiMock.getReasons.mockResolvedValue(payload);
  return mount(ReasonListView, { props: { metricId: 'm-revenue-202608' } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('场景 1：从指标打开原因列表，字段含名称/影响方向/贡献占比/责任方', () => {
  it('渲染每条原因的名称、影响方向、贡献占比、影响量与责任方', async () => {
    const wrapper = mountView(fullyAttributed);
    await flushPromises();

    expect(wrapper.find('[data-testid="reason-list"]').exists()).toBe(true);
    // 顶层原因 2 条（L1 默认展开，片段内的 L2 不计入顶层）
    const nodes = wrapper.findAll('[data-testid="reason-list"] > li');
    expect(nodes.length).toBe(2);

    const first = nodes[0];
    expect(first.find('[data-testid="reason-name"]').text()).toBe('主力产品单价下调');
    expect(first.find('[data-testid="reason-direction"]').text()).toContain('负向');
    expect(first.find('[data-testid="reason-contribution"]').text()).toContain('60');
    expect(first.find('[data-testid="reason-impact"]').text()).toContain('-72');
    expect(first.find('[data-testid="reason-owner"]').text()).toContain('销售中心');

    // 影响方向以「图标 + 文字」表达，不只依赖颜色
    expect(first.find('[data-testid="reason-direction"]').text()).toMatch(/[▼▲■]/);
  });

  it('展示指标的偏差与数据截止时间作为穿透上下文', async () => {
    const wrapper = mountView(fullyAttributed);
    await flushPromises();
    const header = wrapper.find('.metric-header').text();
    expect(header).toContain('营业收入');
    expect(header).toContain('-120');
    expect(header).toContain('-12');
    expect(header).toContain('超阈值 5%');
    expect(header).toContain('2026-09-05T00:00:00+08:00');
  });
});

describe('场景 2：完全归因时贡献占比合计 100%', () => {
  it('展示完全归因状态与 100% 合计及容差', async () => {
    const wrapper = mountView(fullyAttributed);
    await flushPromises();

    expect(wrapper.find('[data-testid="attribution-status"]').text()).toBe('完全归因');
    const total = wrapper.find('[data-testid="attribution-total"]').text();
    expect(total).toContain('100');
    expect(total).toContain('±1');
  });

  it('部分归因时展示未归因余量（不伪造 100%）', async () => {
    const partial = {
      ...fullyAttributed,
      attribution: {
        ...fullyAttributed.attribution,
        status: 'partially_attributed',
        status_label: '部分归因',
        total_contribution_pct: 70,
        unattributed_pct: 30,
        fully_attributed: false,
        sums_to_100_within_tolerance: false,
      },
    };
    const wrapper = mountView(partial);
    await flushPromises();
    expect(wrapper.find('[data-testid="attribution-status"]').text()).toBe('部分归因');
    expect(wrapper.find('[data-testid="attribution-total"]').text()).toContain('未归因余量 30%');
  });
});

describe('场景 3：Reason 层位于固定四层链路且可多级展开', () => {
  it('面包屑展示四层链路且当前为 Reason 层', async () => {
    const wrapper = mountView(fullyAttributed);
    await flushPromises();
    const chain = wrapper.find('.chain__list').text();
    expect(chain).toContain('结果 Result');
    expect(chain).toContain('原因 Reason');
    expect(chain).toContain('证据 Evidence');
    expect(chain).toContain('来源 Source');
    expect(wrapper.find('.chain__item--current').text()).toContain('原因 Reason');
  });

  it('L1 默认展开显示 L2，点击后逐级展开 L3', async () => {
    const wrapper = mountView(fullyAttributed);
    await flushPromises();

    // L1 已展开 → L2 可见
    expect(wrapper.find('[data-reason-id="r-2-1"]').exists()).toBe(true);
    // L2 默认折叠 → L3 不可见
    expect(wrapper.find('[data-reason-id="r-2-1-1"]').exists()).toBe(false);

    const toggle = wrapper.find('[data-reason-id="r-2-1"] .reason__toggle');
    await toggle.trigger('click');
    await flushPromises();

    const l3 = wrapper.find('[data-reason-id="r-2-1-1"]');
    expect(l3.exists()).toBe(true);
    expect(l3.text()).toContain('Reason L3');
    expect(l3.text()).toContain('竞品降价 8%');

    // 收起后 L3 消失
    await wrapper.find('[data-reason-id="r-2-1"] .reason__toggle').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-reason-id="r-2-1-1"]').exists()).toBe(false);
  });
});

describe('边界：指标无关联原因时显示「未归因」并提供关联入口', () => {
  it('显示未归因空态而非空列表', async () => {
    const wrapper = mountView(unattributed);
    await flushPromises();

    const empty = wrapper.find('[data-testid="unattributed-state"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('未归因');
    expect(empty.find('[data-testid="link-entry"]').text()).toContain('关联原因');

    // 不得显示空列表
    expect(wrapper.find('[data-testid="reason-list"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="attribution-status"]').text()).toBe('未归因');
  });

  it('点击关联入口打开表单，提交后以接口返回值刷新归因结果', async () => {
    const wrapper = mountView(unattributed);
    await flushPromises();

    await wrapper.find('[data-testid="link-entry"]').trigger('click');
    await flushPromises();
    const dialog = wrapper.find('[data-testid="link-dialog"]');
    expect(dialog.exists()).toBe(true);

    // 影响方向选项仅限 正向/负向/中性
    const options = dialog.findAll('[data-testid="field-direction"] option').map((o) => o.text());
    expect(options).toEqual(['负向', '正向', '中性']);

    apiMock.linkReasons.mockResolvedValue({ created_count: 1, result: fullyAttributed });
    await dialog.find('[data-testid="field-name"]').setValue('产能不足');
    await dialog.find('[data-testid="field-owner"]').setValue('生产交付中心');
    await dialog.find('form').trigger('submit');
    await flushPromises();

    expect(apiMock.linkReasons).toHaveBeenCalledWith('m-revenue-202608', {
      reasons: [
        expect.objectContaining({ name: '产能不足', direction: 'negative', owner: '生产交付中心' }),
      ],
    });
    // 关联成功后空态消失，原因列表出现
    expect(wrapper.find('[data-testid="unattributed-state"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="reason-list"]').exists()).toBe(true);
  });

  it('后端校验失败（如影响方向非法）时错误如实回显且不关闭表单', async () => {
    const wrapper = mountView(unattributed);
    await flushPromises();
    await wrapper.find('[data-testid="link-entry"]').trigger('click');
    await flushPromises();

    apiMock.linkReasons.mockRejectedValue(new Error('影响方向仅限 正向/负向/中性，收到 up'));
    const dialog = wrapper.find('[data-testid="link-dialog"]');
    await dialog.find('[data-testid="field-name"]').setValue('非法方向');
    await dialog.find('[data-testid="field-owner"]').setValue('销售中心');
    await dialog.find('form').trigger('submit');
    await flushPromises();

    expect(wrapper.find('[data-testid="dialog-error"]').text()).toContain('影响方向仅限');
    expect(wrapper.find('[data-testid="link-dialog"]').exists()).toBe(true);
  });
});

describe('异常处理', () => {
  it('接口失败时展示错误提示', async () => {
    apiMock.getReasons.mockRejectedValue(new Error('结果指标 m-x 不存在'));
    const wrapper = mount(ReasonListView, { props: { metricId: 'm-x' } });
    await flushPromises();
    expect(wrapper.find('.error').text()).toContain('结果指标 m-x 不存在');
  });

  it('存在父项缺失的原因项时给出完整性提示', async () => {
    const wrapper = mountView({
      ...fullyAttributed,
      integrity: { orphan_reason_ids: ['r-orphan'], over_attributed: false },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="integrity-warn"]').text()).toContain('父项缺失');
  });
});
