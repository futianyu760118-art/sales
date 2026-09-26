/**
 * 正向导航领域逻辑（PAND-83 口径的读模型）。
 *
 * 本模块在 PAND-84 中承担「一致性基准」角色：PAND-84 的判定标准要求
 * 反向查询结果与正向导航的关联关系一致（抽样 ≥ 10 条比对，无差异）。
 * 正向与反向都从同一组关联表（attribution_evidences / attributions / result_metrics）
 * 推导，一致性因此是结构性的；本模块把正向路径显式化，供抽样比对取证。
 *
 * 纯函数：不触库、不写库。
 */

import { SOURCE_NOT_LABELLED, navigationSegment } from './chain.js';
import { forwardTargetFor } from './reverseQuery.js';

const DIRECTION_LABELS = Object.freeze({
  positive: '正向',
  negative: '负向',
  neutral: '中性',
});

function depthOf(attribution, byId, seen = new Set()) {
  if (!attribution.parentId || seen.has(attribution.id)) return 0;
  seen.add(attribution.id);
  const parent = byId.get(attribution.parentId);
  if (!parent) return 0;
  return 1 + depthOf(parent, byId, seen);
}

function reasonNode(attribution, byId) {
  const usesException = attribution.kind === 'exception';
  return {
    attributionId: attribution.id,
    metricId: attribution.metricId,
    parentId: attribution.parentId,
    depth: depthOf(attribution, byId),
    name: usesException ? attribution.reasonCode : attribution.analysisName,
    kind: attribution.kind,
    artifact: usesException ? 'Exception' : 'M03 自有归因分析',
    reasonCode: usesException ? attribution.reasonCode : null,
    severity: usesException ? attribution.severity : null,
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

/**
 * 正向导航：Result → Reason → Evidence → Source（四段，不增减）。
 *
 * @param {{ metric: object, attributions: object[], evidencesByAttribution: Map<string, object[]> }} input
 */
export function buildForwardNavigation({ metric, attributions, evidencesByAttribution }) {
  const byId = new Map(attributions.map((item) => [item.id, item]));
  const reasons = attributions.map((item) => reasonNode(item, byId));

  const evidenceMap = new Map();
  for (const reason of reasons) {
    for (const evidence of evidencesByAttribution.get(reason.attributionId) ?? []) {
      if (!evidenceMap.has(evidence.evidenceId)) {
        evidenceMap.set(evidence.evidenceId, {
          evidenceId: evidence.evidenceId,
          id: evidence.id,
          type: evidence.type,
          title: evidence.title,
          formedAt: evidence.formedAt,
          owner: evidence.owner,
          sourceSystem: evidence.sourceSystem,
          sourceLabel: evidence.sourceSystem ?? SOURCE_NOT_LABELLED,
          sourceLabelled: Boolean(evidence.sourceSystem),
          reachedFrom: [],
          forwardTarget: forwardTargetFor({
            segmentKey: 'evidence',
            evidenceId: evidence.evidenceId,
          }),
        });
      }
      const node = evidenceMap.get(evidence.evidenceId);
      if (!node.reachedFrom.includes(reason.attributionId)) {
        node.reachedFrom.push(reason.attributionId);
      }
    }
  }
  const evidences = [...evidenceMap.values()];

  const sourceMap = new Map();
  for (const evidence of evidences) {
    const key = evidence.sourceSystem ?? '__NOT_LABELLED__';
    if (!sourceMap.has(key)) {
      sourceMap.set(key, {
        sourceSystem: evidence.sourceSystem,
        label: evidence.sourceLabel,
        labelled: evidence.sourceLabelled,
        field: 'source_system',
        evidenceIds: [],
        forwardTarget: forwardTargetFor({
          segmentKey: 'source',
          evidenceId: evidence.evidenceId,
        }),
      });
    }
    sourceMap.get(key).evidenceIds.push(evidence.evidenceId);
  }
  const sources = [...sourceMap.values()];

  // 断点：某段缺失时给出补录入口提示，不阻断其余段查看（PAND-83 边界）
  const breakpoints = [];
  if (reasons.length === 0) {
    breakpoints.push({
      segment: 2,
      segmentKey: 'reason',
      code: 'REASON_MISSING',
      message: '该结果指标尚未归因',
      entry: '可前往归因入口补录原因项',
    });
  }
  for (const reason of reasons) {
    if ((evidencesByAttribution.get(reason.attributionId) ?? []).length === 0) {
      breakpoints.push({
        segment: 3,
        segmentKey: 'evidence',
        code: 'EVIDENCE_MISSING',
        message: `归因项 ${reason.attributionId} 尚无支撑证据`,
        entry: '可前往证据挂载入口补录',
        attributionId: reason.attributionId,
      });
    }
  }
  for (const evidence of evidences) {
    if (!evidence.sourceLabelled) {
      breakpoints.push({
        segment: 4,
        segmentKey: 'source',
        code: 'SOURCE_NOT_LABELLED',
        message: `Evidence ${evidence.evidenceId} 未标注来源`,
        entry: '可补录 source_system',
        evidenceId: evidence.evidenceId,
      });
    }
  }

  return {
    metric: {
      metricId: metric.id,
      resultId: metric.resultId,
      code: metric.code,
      name: metric.name,
      sourceSystem: metric.sourceSystem,
      periodType: metric.periodType,
      periodValue: metric.periodValue,
      target: metric.target,
      actual: metric.actual,
      unit: metric.unit,
      calculationVersion: metric.calculationVersion,
      forwardTarget: forwardTargetFor({ segmentKey: 'result', metricId: metric.id }),
    },
    segments: [
      { ...navigationSegment('result'), items: [metric.id] },
      { ...navigationSegment('reason'), items: reasons.map((item) => item.attributionId) },
      { ...navigationSegment('evidence'), items: evidences.map((item) => item.evidenceId) },
      { ...navigationSegment('source'), items: sources.map((item) => item.label) },
    ],
    segmentCount: 4,
    maxDrillSteps: 4,
    drillStepsToSource: 3,
    reasons,
    evidences,
    sources,
    breakpoints,
    reachableEvidenceIds: evidences.map((item) => item.evidenceId),
    readOnly: true,
  };
}

/**
 * 一致性抽样：对 (Evidence, Result) 关联对做双向比对。
 *
 * 对每对抽样：反向自 Evidence 出发必须能查到该 Result；正向自该 Result 出发
 * 必须能到达该 Evidence。任一不成立即记为差异。
 *
 * @param {{ links: {evidenceId: string, metricId: string}[], sample: number,
 *           reverseProbe: (evidenceId: string) => string[],
 *           forwardProbe: (metricId: string) => string[] }} input
 */
export function compareBidirectionalConsistency({ links, sample, reverseProbe, forwardProbe }) {
  const sampled = links.slice(0, sample);
  const reverseCache = new Map();
  const forwardCache = new Map();
  const mismatches = [];

  for (const link of sampled) {
    if (!reverseCache.has(link.evidenceId)) {
      reverseCache.set(link.evidenceId, new Set(reverseProbe(link.evidenceId)));
    }
    if (!forwardCache.has(link.metricId)) {
      forwardCache.set(link.metricId, new Set(forwardProbe(link.metricId)));
    }
    const reverseHit = reverseCache.get(link.evidenceId).has(link.metricId);
    const forwardHit = forwardCache.get(link.metricId).has(link.evidenceId);
    if (!reverseHit || !forwardHit) {
      mismatches.push({
        evidenceId: link.evidenceId,
        metricId: link.metricId,
        reverseHit,
        forwardHit,
      });
    }
  }

  return {
    requestedSample: sample,
    compared: sampled.length,
    availableLinks: links.length,
    mismatches,
    consistent: mismatches.length === 0,
    samples: sampled.map((link) => ({
      evidenceId: link.evidenceId,
      metricId: link.metricId,
      reverseContainsResult: reverseCache.get(link.evidenceId).has(link.metricId),
      forwardContainsEvidence: forwardCache.get(link.metricId).has(link.evidenceId),
    })),
  };
}
