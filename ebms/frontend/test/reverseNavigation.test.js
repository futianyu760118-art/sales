/**
 * 反向查询视图口径单测：空态保留当前位置、正向跳转解析、入口切换与错误处理。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ENTRY_MODES,
  createReverseNavigationStore,
  entryMode,
  isEmptyState,
  positionOf,
  resolveJump,
  summarize,
} from '../src/stores/reverseNavigation.js';

const OK_PAYLOAD = {
  entry: { type: 'evidence', anchorId: 'EVD-BOM-001', label: 'BOM 成本变更单' },
  state: 'OK',
  keepPosition: false,
  position: {
    anchorType: 'evidence',
    anchorId: 'EVD-BOM-001',
    label: 'BOM 成本变更单',
    breadcrumb: [
      { segment: 3, label: '证据', contract: 'Evidence' },
      { segment: 2, label: '原因（归因）', contract: 'Exception' },
      { segment: 1, label: '结果', contract: 'Result' },
    ],
  },
  attributions: [
    {
      attributionId: 'A-COST1',
      depth: 0,
      kind: { kind: 'exception' },
      forwardTarget: { segment: 2, segmentKey: 'reason', segmentLabel: '原因（归因）', contract: 'Exception', path: '#/trace/forward/reason/M-GM/A-COST1', params: { metricId: 'M-GM', attributionId: 'A-COST1' } },
    },
    {
      attributionId: 'A-COST1-1',
      depth: 1,
      kind: { kind: 'm03_analysis' },
      forwardTarget: { segment: 2, segmentKey: 'reason', segmentLabel: '原因（归因）', contract: 'Exception', path: '#/trace/forward/reason/M-GM/A-COST1-1', params: {} },
    },
  ],
  results: [
    {
      metricId: 'M-GM',
      code: 'gross_margin',
      forwardTarget: { segment: 1, segmentKey: 'result', segmentLabel: '结果', contract: 'Result', path: '#/trace/forward/result/M-GM', params: { metricId: 'M-GM' } },
    },
  ],
  evidences: [{ evidenceId: 'EVD-BOM-001', forwardTarget: { segment: 3, segmentKey: 'evidence', segmentLabel: '证据', contract: 'Evidence', path: '#/trace/forward/evidence/EVD-BOM-001', params: {} } }],
  readOnly: true,
  fallbackQueried: false,
};

const EMPTY_PAYLOAD = {
  entry: { type: 'evidence', anchorId: 'EVD-ORPHAN-001', label: '孤立凭证' },
  state: 'EMPTY',
  empty: { code: 'NO_ATTRIBUTION', message: '该对象未关联任何归因项', hint: '可前往正向导航补录' },
  keepPosition: true,
  position: {
    anchorType: 'evidence',
    anchorId: 'EVD-ORPHAN-001',
    label: '孤立凭证',
    breadcrumb: [
      { segment: 3, label: '证据', contract: 'Evidence' },
      { segment: 2, label: '原因（归因）', contract: 'Exception' },
      { segment: 1, label: '结果', contract: 'Result' },
    ],
  },
  attributions: [],
  results: [],
  evidences: [],
  readOnly: true,
  fallbackQueried: false,
};

describe('入口定义', () => {
  it('提供 Evidence 与 source_system 两个反向入口', () => {
    expect(ENTRY_MODES.map((mode) => mode.key)).toEqual(['evidence', 'source_system']);
    expect(entryMode('source_system').field).toBe('source_system');
    expect(entryMode('evidence').field).toBe('evidence_id');
  });

  it('入口取值编码进请求路径，避免注入', () => {
    expect(entryMode('source_system').endpoint('A/B C')).toBe('/trace/reverse/by-source-system/A%2FB%20C');
  });

  it('未知入口回落到第一个入口', () => {
    expect(entryMode('nope').key).toBe('evidence');
  });
});

describe('状态判定与位置保留', () => {
  it('识别空态', () => {
    expect(isEmptyState(EMPTY_PAYLOAD)).toBe(true);
    expect(isEmptyState(OK_PAYLOAD)).toBe(false);
    expect(isEmptyState(null)).toBe(false);
  });

  it('空态与有结果态都从响应取当前位置', () => {
    expect(positionOf(EMPTY_PAYLOAD).anchorId).toBe('EVD-ORPHAN-001');
    expect(positionOf(OK_PAYLOAD).anchorId).toBe('EVD-BOM-001');
    expect(positionOf(null)).toBeNull();
  });

  it('位置包含完整面包屑，供空态原样展示', () => {
    expect(positionOf(EMPTY_PAYLOAD).breadcrumb).toHaveLength(3);
    expect(positionOf(EMPTY_PAYLOAD).breadcrumb[0].contract).toBe('Evidence');
  });
});

describe('场景 3：正向跳转解析', () => {
  it('归因项解析到第 2 段（原因（归因）/ Exception）', () => {
    const jump = resolveJump(OK_PAYLOAD.attributions[0]);
    expect(jump.segment).toBe(2);
    expect(jump.segmentLabel).toBe('原因（归因）');
    expect(jump.contract).toBe('Exception');
    expect(jump.path).toBe('#/trace/forward/reason/M-GM/A-COST1');
  });

  it('结果指标解析到第 1 段（Result）', () => {
    const jump = resolveJump(OK_PAYLOAD.results[0]);
    expect(jump.segment).toBe(1);
    expect(jump.contract).toBe('Result');
  });

  it('证据解析到第 3 段（Evidence）', () => {
    expect(resolveJump(OK_PAYLOAD.evidences[0]).segment).toBe(3);
  });

  it('无跳转目标时返回 null', () => {
    expect(resolveJump(null)).toBeNull();
    expect(resolveJump({})).toBeNull();
  });
});

describe('汇总口径', () => {
  it('按归属类型拆分原因项', () => {
    const summary = summarize(OK_PAYLOAD);
    expect(summary.attributionCount).toBe(2);
    expect(summary.exceptionBackedCount).toBe(1);
    expect(summary.m03AnalysisCount).toBe(1);
    expect(summary.resultCount).toBe(1);
    expect(summary.evidenceCount).toBe(1);
  });

  it('未查询时返回 IDLE', () => {
    expect(summarize(null).state).toBe('IDLE');
  });
});

describe('状态容器', () => {
  it('证据入口查询成功后写入结果与当前位置', async () => {
    const api = { get: vi.fn().mockResolvedValue(OK_PAYLOAD) };
    const store = createReverseNavigationStore({ api });

    store.setInput('EVD-BOM-001');
    await store.run();

    expect(api.get).toHaveBeenCalledWith('/trace/reverse/by-evidence/EVD-BOM-001');
    expect(store.state.result.state).toBe('OK');
    expect(store.state.position.anchorId).toBe('EVD-BOM-001');
    expect(store.state.error).toBeNull();
  });

  it('来源系统入口命中对应端点', async () => {
    const api = { get: vi.fn().mockResolvedValue(OK_PAYLOAD) };
    const store = createReverseNavigationStore({ api });

    store.setMode('source_system');
    store.setInput('MES');
    await store.run();

    expect(api.get).toHaveBeenCalledWith('/trace/reverse/by-source-system/MES');
  });

  it('空态下保留当前位置，输入不被清空', async () => {
    const api = { get: vi.fn().mockResolvedValue(EMPTY_PAYLOAD) };
    const store = createReverseNavigationStore({ api });

    store.setInput('EVD-ORPHAN-001');
    await store.run();

    expect(store.state.result.state).toBe('EMPTY');
    expect(store.state.position.anchorId).toBe('EVD-ORPHAN-001');
    expect(store.state.position.breadcrumb).toHaveLength(3);
    expect(store.state.input).toBe('EVD-ORPHAN-001');
  });

  it('空输入不发请求并给出提示', async () => {
    const api = { get: vi.fn() };
    const store = createReverseNavigationStore({ api });

    store.setInput('   ');
    const payload = await store.run();

    expect(payload).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
    expect(store.state.error.code).toBe('INPUT_REQUIRED');
  });

  it('查询失败时保留错误码且不残留结果', async () => {
    const api = {
      get: vi.fn().mockRejectedValue(Object.assign(new Error('未找到 Evidence'), { code: 'EVIDENCE_NOT_FOUND' })),
    };
    const store = createReverseNavigationStore({ api });

    store.setInput('EVD-NOPE');
    await store.run();

    expect(store.state.error.code).toBe('EVIDENCE_NOT_FOUND');
    expect(store.state.result).toBeNull();
    expect(store.state.position).toBeNull();
  });

  it('切换入口清空上一次结果但与当前位置无关地重置', async () => {
    const api = { get: vi.fn().mockResolvedValue(OK_PAYLOAD) };
    const store = createReverseNavigationStore({ api });

    store.setInput('EVD-BOM-001');
    await store.run();
    store.setMode('source_system');

    expect(store.state.result).toBeNull();
    expect(store.state.position).toBeNull();
    expect(store.state.mode).toBe('source_system');
  });

  it('navigateForward 解析落点并落到 state.jump', () => {
    const api = { get: vi.fn() };
    const store = createReverseNavigationStore({ api });

    store.navigateForward(OK_PAYLOAD.results[0]);

    expect(store.state.jump.segment).toBe(1);
    expect(store.state.jump.contract).toBe('Result');
  });
});
