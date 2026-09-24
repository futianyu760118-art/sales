// 应用层：专业中心结论接入用例（架构方案 3.2.1 / 3.2.2）。
// 职责：按周期从四域 Adapter 取回结论 → 原样落库（domain_conclusions）→ 触发跨域判断聚合。
// 任一域失败不影响其余域落库（Promise.allSettled），缺失域以 missing 标记落库，
// 从而支撑「单域数据缺失不影响其余域判断输出」。
import { CENTER_CODES, MISSING_REASON_LABEL, CENTER_LABEL } from '../domain/judgment.js';
import { HttpError } from '../domain/httpError.js';

export const PERIOD_TYPES = Object.freeze(['day', 'week', 'month']);

export function assertPeriod({ periodType, periodValue }) {
  if (!PERIOD_TYPES.includes(periodType)) {
    throw new HttpError(422, 'VALIDATION_FAILED', `周期类型仅限 ${PERIOD_TYPES.join(' / ')}，收到 ${periodType ?? '空'}`, {
      allowed_period_types: PERIOD_TYPES,
    });
  }
  if (!periodValue || !String(periodValue).trim()) {
    throw new HttpError(422, 'VALIDATION_FAILED', '周期值（period_value）不能为空');
  }
}

export function createIngestService({
  conclusionRepository,
  adapters,
  onConclusionsIngested = async () => null,
  now = () => new Date().toISOString(),
}) {
  function resolveTargets(centers) {
    if (!centers) return [...CENTER_CODES];
    const list = Array.isArray(centers) ? centers : [centers];
    const unknown = list.filter((c) => !CENTER_CODES.includes(c));
    if (unknown.length > 0) {
      throw new HttpError(422, 'VALIDATION_FAILED', `未知的专业中心：${unknown.join(', ')}`, {
        allowed_centers: [...CENTER_CODES],
      });
    }
    return list;
  }

  return {
    /** 拉取并落库指定周期的结论；返回接入报告（含逐域缺失原因） */
    async ingestPeriod({ periodType, periodValue, centers, actor = 'system' } = {}) {
      assertPeriod({ periodType, periodValue });
      const targets = resolveTargets(centers);

      const results = await Promise.allSettled(
        targets.map(async (center) => {
          const adapter = adapters.get(center);
          if (!adapter) {
            // 未配置 adapter 按「中心未返回本周期结论」处理，不阻断其余域
            return {
              center,
              adapter_mode: 'unconfigured',
              missing: true,
              missing_reason: 'no_conclusion',
            };
          }
          const { row, error } = await adapter.fetchConclusions({ periodType, periodValue });
          return { ...row, adapter_mode: adapter.mode, error };
        }),
      );

      const rows = results.map((r, index) =>
        r.status === 'fulfilled'
          ? r.value
          : {
              // 适配器本身抛出异常时兜底为缺失，保证单域失败不阻断整批
              id: undefined,
              center: targets[index],
              period_type: periodType,
              period_value: periodValue,
              version: null,
              as_of: null,
              payload: null,
              missing: true,
              missing_reason: 'unreachable',
              source_mode: 'api',
              ingested_at: now(),
            },
      );

      const normalized = rows.map((row) => ({
        id: row.id ?? `${row.center}-${periodType}-${periodValue}`,
        ingested_at: row.ingested_at ?? now(),
        ...row,
      }));

      const saved = await conclusionRepository.upsertMany(normalized, {
        actor,
        action: 'conclusion.ingest',
        periodType,
        periodValue,
      });

      const byCenter = new Map(saved.map((s) => [s.center, s]));
      const report = targets.map((center) => {
        const row = byCenter.get(center);
        const payload = row?.payload ?? null;
        return {
          center,
          center_label: CENTER_LABEL[center] ?? center,
          source_mode: row?.source_mode ?? null,
          missing: row?.missing === true,
          missing_reason: row?.missing_reason ?? null,
          missing_reason_label: row?.missing_reason ? (MISSING_REASON_LABEL[row.missing_reason] ?? null) : null,
          version: row?.version ?? null,
          as_of: row?.as_of ?? null,
          data_cutoff: payload?.as_of ?? row?.as_of ?? null,
          metric_count: Array.isArray(payload?.metrics) ? payload.metrics.length : 0,
          reason_count: Array.isArray(payload?.reasons) ? payload.reasons.length : 0,
          conclusion_id: row?.id ?? null,
        };
      });

      const ingested = report.filter((r) => !r.missing);
      const missing = report.filter((r) => r.missing);

      // 事件 conclusion.ingested → 触发跨域判断聚合（架构方案 3.2.3）
      const judgment = await onConclusionsIngested({ periodType, periodValue, actor });

      return {
        period: { type: periodType, value: periodValue },
        requested_centers: targets,
        ingested_count: ingested.length,
        missing_count: missing.length,
        domains: report,
        ingested,
        missing,
        judgment_generated: Boolean(judgment),
        judgment_id: judgment?.id ?? null,
        judgment_level: judgment?.level ?? null,
        ingested_at: now(),
      };
    },

    /** 结论快照查询：用于核验「展示值与专业中心输出值一致」 */
    async listConclusions({ periodType, periodValue, center } = {}) {
      if (periodType) assertPeriod({ periodType, periodValue });
      const rows = await conclusionRepository.list({ periodType, periodValue, center });
      return {
        period: periodType ? { type: periodType, value: periodValue } : null,
        count: rows.length,
        conclusions: rows.map((row) => ({
          id: row.id,
          center: row.center,
          center_label: CENTER_LABEL[row.center] ?? row.center,
          period: { type: row.period_type, value: row.period_value },
          version: row.version,
          as_of: row.as_of,
          data_cutoff: row.payload?.as_of ?? row.as_of ?? null,
          missing: row.missing === true,
          missing_reason: row.missing_reason,
          source_mode: row.source_mode,
          ingested_at: row.ingested_at,
          metric_count: Array.isArray(row.payload?.metrics) ? row.payload.metrics.length : 0,
          // 原样回传中心结论体：展示值即中心输出值（EBMS 不加工）
          payload: row.payload,
        })),
      };
    },
  };
}
