/**
 * 反向链路口径的唯一真源。
 *
 * 2026-09-26 P0 边界重核（PAND-96）后的统一口径：
 *   - 正向四层 Result → Reason → Evidence → Source 仅作 M03 视图导航；
 *   - 反向查询沿契约链 Result ← Exception（归因）← Evidence ← source_system 实现，
 *     与 PAND-83 的正向导航段一一对应；
 *   - 反向不新增契约对象或层级：只有 Result / Exception / Evidence 三类契约对象，
 *     「来源」以 Evidence 的 source_system 字段承载。
 *
 * 本模块被冻结（Object.freeze），没有任何运行时入口可以增删层级或契约对象 ——
 * 这是「对象清点结果 = Result / Exception / Evidence + source_system 字段，无额外
 * 契约对象或层级」这条判定标准的结构性保证。
 */

/** 四段 M03 视图导航（正向）。反向查询沿同一序列倒序走。 */
const NAVIGATION_DEFINITION = [
  {
    segment: 1,
    key: 'result',
    label: '结果',
    contract: 'Result',
    detail: 'Result 契约',
    drillAction: '查看原因项',
  },
  {
    segment: 2,
    key: 'reason',
    label: '原因（归因）',
    contract: 'Exception',
    detail: 'Exception 契约（reason_code / severity），或标记为 M03 自有归因分析',
    drillAction: '查看证据',
  },
  {
    segment: 3,
    key: 'evidence',
    label: '证据',
    contract: 'Evidence',
    detail: 'Evidence 契约',
    drillAction: '查看来源',
  },
  {
    segment: 4,
    key: 'source',
    label: '来源',
    contract: 'Evidence.source_system',
    detail: 'Evidence 上的 source_system 字段（字段化，不是独立层级）',
    drillAction: null,
  },
];

export const NAVIGATION_SEGMENTS = Object.freeze(
  NAVIGATION_DEFINITION.map((segment) => Object.freeze(segment)),
);

export const NAVIGATION_SEGMENT_COUNT = NAVIGATION_SEGMENTS.length;

/** 跨域契约对象清点结果 —— 三类契约 + 一个字段，无其他。 */
export const CONTRACT_OBJECTS = Object.freeze(['Result', 'Exception', 'Evidence']);

/** 「来源」环节不是契约对象，而是 Evidence 上的字段。 */
export const SOURCE_FIELD = 'source_system';

/** 原因项的两种合法归属（PAND-80 口径）。 */
export const ATTRIBUTION_KINDS = Object.freeze(['exception', 'm03_analysis']);

export const M03_ANALYSIS_LABEL = 'M03 自有归因分析';

export const DIRECTIONS = Object.freeze(['positive', 'negative', 'neutral']);

export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

/** Evidence 未标注来源时的固定展示口径。 */
export const SOURCE_NOT_LABELLED = '来源未标注';

export function navigationSegment(key) {
  const segment = NAVIGATION_SEGMENTS.find((item) => item.key === key);
  if (!segment) {
    throw new RangeError(`未知导航段: ${key}`);
  }
  return segment;
}

/**
 * 契约对象清点接口。反向链路的对象清点结果必须恒等于
 * Result / Exception / Evidence + source_system 字段。
 */
export function describeContractObjects() {
  return {
    contractObjects: [...CONTRACT_OBJECTS],
    sourceField: SOURCE_FIELD,
    sourceIsContractObject: false,
    extraContractObjects: [],
    attributionKinds: [...ATTRIBUTION_KINDS],
    navigationSegmentCount: NAVIGATION_SEGMENT_COUNT,
    navigationSegments: NAVIGATION_SEGMENTS.map((segment) => ({ ...segment })),
  };
}

/**
 * 反向方向定义：从 Evidence 或 source_system 出发，沿契约链逆流而上。
 * 与正向导航段一一对应 —— 反向第 N 步落在正向第 (4-N+1) 段。
 */
export const REVERSE_ENTRY_POINTS = Object.freeze([
  Object.freeze({
    key: 'evidence',
    label: '证据',
    entryField: 'evidence_id',
    walk: 'attribution_evidences → attributions → result_metrics',
    forwardSegment: navigationSegment('evidence').segment,
  }),
  Object.freeze({
    key: 'source_system',
    label: '来源系统',
    entryField: SOURCE_FIELD,
    walk: 'evidences.source_system → attribution_evidences → attributions → result_metrics',
    forwardSegment: navigationSegment('source').segment,
  }),
]);

/** 原因项的展示判定：映射至 Exception，还是 M03 自有归因分析。 */
export function describeAttributionKind(attribution) {
  if (attribution.kind === 'exception') {
    return {
      kind: 'exception',
      label: '映射至 Exception',
      exceptionId: attribution.exceptionId ?? null,
      reasonCode: attribution.reasonCode ?? null,
      severity: attribution.severity ?? null,
    };
  }
  return {
    kind: 'm03_analysis',
    label: M03_ANALYSIS_LABEL,
    exceptionId: null,
    reasonCode: null,
    severity: null,
  };
}
