/**
 * 反向查询领域逻辑（PAND-84）。
 *
 * 输入是已从链路读模型取出的切片，输出是可直接渲染/断言的读模型。
 * 本模块为纯函数：不触库、不写库 —— 反向链路的「只读」在领域层即已成立。
 */

import {
  ATTRIBUTION_KINDS,
  M03_ANALYSIS_LABEL,
  SOURCE_NOT_LABELLED,
  describeAttributionKind,
  navigationSegment,
} from './chain.js';

const DIRECTION_LABELS = Object.freeze({
  positive: '正向',
  negative: '负向',
  neutral: '中性',
});

const EVIDENCE_TYPE_LABELS = Object.freeze({
  document: '单据',
  contract: '合同',
  system_record: '系统记录',
  manual_note: '人工说明',
});

export const EMPTY_STATE = Object.freeze({
  CODE: 'NO_ATTRIBUTION',
  MESSAGE: '该对象未关联任何归因项',
  HINT: '可前往正向导航为该对象补录归因关联；系统不会回落到专业原始表查询。',
});

/** 正向导航跳转地址 —— 反向结果每一项据此回到正向对应位置（AC 场景 3）。 */
export function forwardTargetFor({ segmentKey, metricId = null, attributionId = null, evidenceId = null }) {
  const segment = navigationSegment(segmentKey);
  const params = { metricId, attributionId, evidenceId };
  const path = ['#/trace/forward', segmentKey, metricId, attributionId, evidenceId]
    .filter((part) => part !== null && part !== undefined)
    .join('/');
  return {
    view: 'forward',
    segment: segment.segment,
    segmentKey: segment.key,
    segmentLabel: segment.label,
    contract: segment.contract,
    path,
    params,
  };
}

function normalizeEvidence(evidence) {
  const labelled = Boolean(evidence.sourceSystem);
  return {
    evidenceId: evidence.evidenceId,
    id: evidence.id,
    type: evidence.type,
    typeLabel: EVIDENCE_TYPE_LABELS[evidence.type] ?? evidence.type,
    title: evidence.title,
    formedAt: evidence.formedAt,
    owner: evidence.owner,
    objectType: evidence.objectType,
    objectId: evidence.objectId,
    // 「来源」展示口径：取 Evidence 的 source_system 字段；为空显示「来源未标注」
    sourceSystem: evidence.sourceSystem,
    sourceLabel: labelled ? evidence.sourceSystem : SOURCE_NOT_LABELLED,
    sourceLabelled: labelled,
    forwardTarget: forwardTargetFor({ segmentKey: 'evidence', evidenceId: evidence.evidenceId }),
  };
}

function normalizeResult(metric) {
  return {
    metricId: metric.id,
    resultId: metric.resultId,
    code: metric.code,
    name: metric.name,
    sourceSystem: metric.sourceSystem,
    objectType: metric.objectType,
    objectId: metric.objectId,
    periodType: metric.periodType,
    periodValue: metric.periodValue,
    target: metric.target,
    actual: metric.actual,
    unit: metric.unit,
    calculationVersion: metric.calculationVersion,
    status: metric.status,
    forwardTarget: forwardTargetFor({ segmentKey: 'result', metricId: metric.id }),
  };
}

function depthOf(attribution, byId, seen = new Set()) {
  if (!attribution.parentId || seen.has(attribution.id)) return 0;
  seen.add(attribution.id);
  const parent = byId.get(attribution.parentId);
  if (!parent) return 0;
  return 1 + depthOf(parent, byId, seen);
}

function normalizeAttribution(attribution, byId) {
  const kind = describeAttributionKind(attribution);
  const usesException = kind.kind === 'exception';
  return {
    attributionId: attribution.id,
    metricId: attribution.metricId,
    parentId: attribution.parentId,
    depth: depthOf(attribution, byId),
    // 原因项名称：Exception 取 reason_code，M03 分析取分析名
    name: usesException ? kind.reasonCode : attribution.analysisName,
    kind,
    kindLabel: usesException ? `映射至 Exception（${kind.reasonCode}）` : M03_ANALYSIS_LABEL,
    reasonCode: kind.reasonCode,
    severity: kind.severity,
    direction: attribution.direction,
    directionLabel: DIRECTION_LABELS[attribution.direction] ?? attribution.direction,
    contributionPct: attribution.contributionPct,
    impactValue: attribution.impactValue,
    owner: attribution.owner,
    forwardTarget: forwardTargetFor({
      segmentKey: 'reason',
      metricId: attribution.metricId,
      attributionId: attribution.id,
    }),
  };
}

function uniqueResults(metrics) {
  const seen = new Map();
  for (const metric of metrics) {
    if (!seen.has(metric.id)) seen.set(metric.id, normalizeResult(metric));
  }
  return [...seen.values()];
}

/** 空态响应：显式保留当前位置，且声明不回落到专业原始表。 */
function emptyPayload({ entry, position, scope }) {
  return {
    entry,
    state: 'EMPTY',
    empty: {
      code: EMPTY_STATE.CODE,
      message: EMPTY_STATE.MESSAGE,
      hint: EMPTY_STATE.HINT,
    },
    keepPosition: true,
    position,
    scope,
    attributions: [],
    results: [],
    evidences: [],
    notices: [],
    readOnly: true,
    fallbackQueried: false,
    fallbackPolicy: 'none',
  };
}

function positionFor({ anchorType, anchorId, label, breadcrumb }) {
  return { anchorType, anchorId, label, breadcrumb };
}

/**
 * 场景 1：从某条 Evidence 出发，列出其关联的归因项（Exception）及最终结果指标（Result）。
 *
 * @param {{ evidence: object, attributions: object[], metrics: object[] }} input
 */
export function buildReverseFromEvidence({ evidence, attributions, metrics }) {
  const normalizedEvidence = normalizeEvidence(evidence);
  const entry = {
    type: 'evidence',
    anchorId: normalizedEvidence.evidenceId,
    label: normalizedEvidence.title,
    evidence: normalizedEvidence,
  };
  const position = positionFor({
    anchorType: 'evidence',
    anchorId: normalizedEvidence.evidenceId,
    label: normalizedEvidence.title,
    breadcrumb: [navigationSegment('evidence'), navigationSegment('reason'), navigationSegment('result')]
      .map((segment) => ({ segment: segment.segment, label: segment.label, contract: segment.contract })),
  });

  if (attributions.length === 0) {
    return emptyPayload({
      entry,
      position,
      scope: {
        kind: 'evidence',
        description: '该 Evidence 未挂载任何归因项',
        evidenceIds: [normalizedEvidence.evidenceId],
      },
    });
  }

  const byId = new Map(attributions.map((item) => [item.id, item]));
  const items = attributions.map((item) => normalizeAttribution(item, byId));

  return {
    entry,
    state: 'OK',
    empty: null,
    keepPosition: false,
    position,
    scope: {
      kind: 'evidence',
      description: `自 Evidence ${normalizedEvidence.evidenceId} 反向查询`,
      evidenceIds: [normalizedEvidence.evidenceId],
    },
    attributions: items,
    results: uniqueResults(metrics),
    evidences: [normalizedEvidence],
    notices: normalizedEvidence.sourceLabelled
      ? []
      : [
          {
            code: 'SOURCE_NOT_LABELLED',
            message: `${SOURCE_NOT_LABELLED}：该 Evidence 未填写 ${'source_system'} 字段。`,
          },
        ],
    readOnly: true,
    fallbackQueried: false,
    fallbackPolicy: 'none',
  };
}

/**
 * 场景 2：从某个 source_system 值出发，列出该来源系统下所有关联 Evidence、
 * 归因项及最终结果指标。
 *
 * @param {{ sourceSystem: string, evidences: object[], attributions: object[], metrics: object[] }} input
 */
export function buildReverseFromSourceSystem({ sourceSystem, evidences, attributions, metrics }) {
  const normalizedEvidences = evidences.map(normalizeEvidence);
  const entry = {
    type: 'source_system',
    anchorId: sourceSystem,
    label: sourceSystem,
    field: 'source_system',
  };
  const position = positionFor({
    anchorType: 'source_system',
    anchorId: sourceSystem,
    label: sourceSystem,
    breadcrumb: [
      navigationSegment('source'),
      navigationSegment('evidence'),
      navigationSegment('reason'),
      navigationSegment('result'),
    ].map((segment) => ({
      segment: segment.segment,
      label: segment.label,
      contract: segment.contract,
    })),
  });

  if (attributions.length === 0) {
    return emptyPayload({
      entry,
      position,
      scope: {
        kind: 'source_system',
        description: `来源系统 ${sourceSystem} 下无已关联归因项的 Evidence`,
        evidenceIds: normalizedEvidences.map((item) => item.evidenceId),
      },
    });
  }

  const byId = new Map(attributions.map((item) => [item.id, item]));
  const items = attributions.map((item) => ({
    ...normalizeAttribution(item, byId),
    viaEvidenceId: item.viaEvidenceId ?? null,
  }));

  return {
    entry,
    state: 'OK',
    empty: null,
    keepPosition: false,
    position,
    scope: {
      kind: 'source_system',
      description: `自来源系统 ${sourceSystem} 反向查询`,
      evidenceIds: normalizedEvidences.map((item) => item.evidenceId),
    },
    attributions: items,
    results: uniqueResults(metrics),
    evidences: normalizedEvidences,
    notices: normalizedEvidences
      .filter((item) => !item.sourceLabelled)
      .map((item) => ({
        code: 'SOURCE_NOT_LABELLED',
        message: `Evidence ${item.evidenceId} 未填写 source_system 字段。`,
      })),
    readOnly: true,
    fallbackQueried: false,
    fallbackPolicy: 'none',
  };
}

export { ATTRIBUTION_KINDS, DIRECTION_LABELS, EVIDENCE_TYPE_LABELS };
