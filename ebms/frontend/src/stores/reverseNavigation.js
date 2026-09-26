/**
 * 反向链路查询视图状态。
 *
 * 展示口径（对应 AC）：
 *   - 空态：保留当前位置（锚点 + 面包屑原样留在界面上），不跳走、不回落原始表；
 *   - 场景 3：反向结果每一项都能解析出正向导航跳转目标。
 *
 * 纯函数与状态容器分开导出，便于直接对口径做单测。
 */

import { reactive } from 'vue';

export const ENTRY_MODES = Object.freeze([
  Object.freeze({
    key: 'evidence',
    label: '按证据反查',
    field: 'evidence_id',
    placeholder: 'EVD-BOM-001',
    hint: '从一条 Evidence 出发，查出其影响的原因项与最终结果指标',
    endpoint: (value) => `/trace/reverse/by-evidence/${encodeURIComponent(value)}`,
  }),
  Object.freeze({
    key: 'source_system',
    label: '按来源系统反查',
    field: 'source_system',
    placeholder: 'MES / ERP-PROC / FIN-SHARE',
    hint: '从一个来源系统取值出发，查出该来源下全部 Evidence、原因项与最终结果指标',
    endpoint: (value) => `/trace/reverse/by-source-system/${encodeURIComponent(value)}`,
  }),
]);

export function entryMode(key) {
  return ENTRY_MODES.find((mode) => mode.key === key) ?? ENTRY_MODES[0];
}

export function isEmptyState(result) {
  return Boolean(result) && result.state === 'EMPTY';
}

/** 当前位置：空态与有结果态都以响应里的 position 为准，保证「保留当前位置」。 */
export function positionOf(result) {
  if (!result || !result.position) return null;
  return {
    anchorType: result.position.anchorType,
    anchorId: result.position.anchorId,
    label: result.position.label,
    breadcrumb: result.position.breadcrumb ?? [],
  };
}

/** 场景 3：解析某一项跳往正向导航的落点。 */
export function resolveJump(item) {
  if (!item || !item.forwardTarget) return null;
  const target = item.forwardTarget;
  return {
    path: target.path,
    segment: target.segment,
    segmentKey: target.segmentKey,
    segmentLabel: target.segmentLabel,
    contract: target.contract,
    params: target.params,
  };
}

export function summarize(result) {
  if (!result) {
    return { state: 'IDLE', attributionCount: 0, resultCount: 0, evidenceCount: 0, exceptionBackedCount: 0, m03AnalysisCount: 0 };
  }
  const attributions = result.attributions ?? [];
  return {
    state: result.state,
    attributionCount: attributions.length,
    resultCount: (result.results ?? []).length,
    evidenceCount: (result.evidences ?? []).length,
    exceptionBackedCount: attributions.filter((item) => item.kind?.kind === 'exception').length,
    m03AnalysisCount: attributions.filter((item) => item.kind?.kind === 'm03_analysis').length,
  };
}

export function createReverseNavigationStore({ api }) {
  const state = reactive({
    mode: ENTRY_MODES[0].key,
    input: '',
    loading: false,
    error: null,
    result: null,
    // 当前位置：查询发起前与返回后都保持可见（空态亦不丢失）
    position: null,
    // 最近一次的正向跳转落点
    jump: null,
  });

  function setMode(key) {
    if (state.mode === key) return;
    state.mode = entryMode(key).key;
    state.result = null;
    state.error = null;
    state.jump = null;
    state.position = null;
  }

  function setInput(value) {
    state.input = value;
  }

  async function run() {
    const value = state.input.trim();
    const mode = entryMode(state.mode);
    if (!value) {
      state.error = { code: 'INPUT_REQUIRED', message: `请填写${mode.field}` };
      return null;
    }

    state.loading = true;
    state.error = null;
    try {
      const payload = await api.get(mode.endpoint(value));
      state.result = payload;
      // 空态与有结果态都锚定响应给出的 position —— 空态保留当前位置
      state.position = positionOf(payload);
      return payload;
    } catch (err) {
      state.error = {
        code: err?.code ?? 'QUERY_FAILED',
        message: err?.message ?? '反向查询失败',
      };
      state.result = null;
      state.position = null;
      return null;
    } finally {
      state.loading = false;
    }
  }

  function navigateForward(item) {
    const target = resolveJump(item);
    if (target) state.jump = target;
    return target;
  }

  function reset() {
    state.input = '';
    state.result = null;
    state.error = null;
    state.jump = null;
    state.position = null;
  }

  return { state, setMode, setInput, run, navigateForward, reset };
}
