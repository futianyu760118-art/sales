/**
 * 应用层：链路查询编排。
 *
 * PAND-84 交付面：反向查询（Evidence / source_system → 归因项 → 最终结果指标）。
 * 正向导航读模型仅作为 PAND-84 判定标准所需的「一致性基准」被显式化，
 * 由 PAND-83 负责其界面导航体验。
 *
 * 全部方法为读路径：只调用仓储的 SELECT 方法。
 */

import { describeContractObjects, SOURCE_FIELD } from '../domain/chain.js';
import { buildReverseFromEvidence, buildReverseFromSourceSystem } from '../domain/reverseQuery.js';
import { buildForwardNavigation, compareBidirectionalConsistency } from '../domain/forwardQuery.js';
import { HttpError } from '../domain/httpError.js';

export const DEFAULT_CONSISTENCY_SAMPLE = 10;

export function createTraceService({ chainRepository, auditRepository }) {
  const repo = chainRepository;

  /** 反向：Evidence → 归因项 → 最终结果指标（AC 场景 1）。 */
  function reverseByEvidence(evidenceId) {
    const evidence = repo.getEvidence(evidenceId);
    if (!evidence) {
      throw HttpError.notFound('EVIDENCE_NOT_FOUND', `未找到 Evidence: ${evidenceId}`);
    }
    const attributions = repo.listAttributionsByEvidence(evidence.id);
    const metrics = repo.getMetricByIds([...new Set(attributions.map((item) => item.metricId))]);
    return buildReverseFromEvidence({ evidence, attributions, metrics });
  }

  /** 反向：source_system → 该来源下全部 Evidence、归因项与最终结果指标（AC 场景 2）。 */
  function reverseBySourceSystem(sourceSystem) {
    const value = typeof sourceSystem === 'string' ? sourceSystem.trim() : '';
    if (!value) {
      throw HttpError.badRequest('SOURCE_SYSTEM_REQUIRED', `${SOURCE_FIELD} 取值不能为空`);
    }
    const evidences = repo.listEvidencesBySourceSystem(value);
    const attributions = repo.listAttributionsByEvidenceIds(evidences.map((item) => item.id));
    const metrics = repo.getMetricByIds([...new Set(attributions.map((item) => item.metricId))]);
    return buildReverseFromSourceSystem({ sourceSystem: value, evidences, attributions, metrics });
  }

  /** 正向基准：Result → Reason → Evidence → Source 四段导航读模型。 */
  function forwardByMetric(metricId) {
    const metric = repo.getMetric(metricId) ?? repo.getMetricByCode(metricId);
    if (!metric) {
      throw HttpError.notFound('METRIC_NOT_FOUND', `未找到结果指标: ${metricId}`);
    }
    const attributions = repo.listAttributionsByMetric(metric.id);
    const evidencesByAttribution = new Map(
      attributions.map((item) => [item.id, repo.listEvidencesByAttribution(item.id)]),
    );
    return buildForwardNavigation({ metric, attributions, evidencesByAttribution });
  }

  /** 契约对象清点：固定为 Result / Exception / Evidence + source_system 字段。 */
  function contractObjects() {
    const footprint = repo.rowCounts();
    return {
      ...describeContractObjects(),
      footprint: {
        result: footprint.result_metrics,
        exception: footprint.exceptions,
        evidence: footprint.evidences,
        attributionMetadata: footprint.attributions,
        attributionEvidenceLinks: footprint.attribution_evidences,
      },
      // 「来源」不是契约对象：仅以 Evidence 的字段承载，不存在独立来源表
      sourceTables: [],
    };
  }

  /**
   * 归因口径合规抽检：100% 的归因项或映射至 Exception（含 reason_code + severity），
   * 或显式标记为 M03 自有归因分析。
   */
  function attributionCompliance() {
    const rows = repo.listAttributionCompliance();
    const violations = rows.filter((row) => !row.compliant);
    const exceptionBacked = rows.filter((row) => row.kind === 'exception');
    const m03Backed = rows.filter((row) => row.kind === 'm03_analysis');
    return {
      total: rows.length,
      compliant: rows.length - violations.length,
      compliantPct: rows.length === 0 ? 100 : ((rows.length - violations.length) / rows.length) * 100,
      exceptionBackedCount: exceptionBacked.length,
      m03AnalysisCount: m03Backed.length,
      // 映射至 Exception 的条目 100% 带 reason_code + severity
      exceptionWithReasonCodeAndSeverity: exceptionBacked.filter(
        (row) => row.reasonCode && row.severity,
      ).length,
      violations,
      rows,
    };
  }

  /**
   * 一致性抽样：反向结果与正向导航的关联关系逐对比对。
   * @param {number} sample 抽样条数（AC 要求不少于 10 条）
   */
  function consistencySample(sample = DEFAULT_CONSISTENCY_SAMPLE) {
    const links = repo.listEvidenceMetricLinks();
    const result = compareBidirectionalConsistency({
      links,
      sample,
      reverseProbe: (evidenceId) =>
        reverseByEvidence(evidenceId).results.map((item) => item.metricId),
      forwardProbe: (metricId) => forwardByMetric(metricId).reachableEvidenceIds,
    });
    return {
      ...result,
      meetsAcMinimum: result.compared >= DEFAULT_CONSISTENCY_SAMPLE,
      criteria: `抽样不少于 ${DEFAULT_CONSISTENCY_SAMPLE} 条比对，无差异`,
    };
  }

  /** 可用来源系统取值（反向入口 2 的筛选器数据源）。 */
  function listSourceSystems() {
    return repo.listSourceSystems();
  }

  /** 只读自检：反向查询不得产生任何写操作。 */
  function readOnlyAudit() {
    return {
      auditCount: auditRepository.countAll(),
      auditMaxId: auditRepository.maxId(),
      rowCounts: repo.rowCounts(),
    };
  }

  return {
    reverseByEvidence,
    reverseBySourceSystem,
    forwardByMetric,
    contractObjects,
    attributionCompliance,
    consistencySample,
    listSourceSystems,
    readOnlyAudit,
  };
}
