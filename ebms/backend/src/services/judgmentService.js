// 应用层：跨域经营判断用例。接口契约见架构方案 3.2.2
//   GET /api/v1/judgments?period_type=&period_value=          → F13 跨域判断 (PAND-91)
//   GET /api/v1/judgments/{id}/references                     → 引用明细（可追溯）
//   GET /api/v1/judgments/consistency?period_type=&period_value= → 抽样比对（判定标准）
import { randomUUID } from 'node:crypto';
import {
  MIN_CONSISTENCY_SAMPLES,
  RULE_VERSION,
  evaluateJudgment,
  sampleConsistency,
} from '../domain/judgment.js';
import { HttpError } from '../domain/httpError.js';
import { assertPeriod } from './ingestService.js';

export function createJudgmentService({
  conclusionRepository,
  judgmentRepository,
  now = () => new Date().toISOString(),
}) {
  async function loadConclusions(periodType, periodValue) {
    return conclusionRepository.list({ periodType, periodValue });
  }

  /** 判断表读模型：detail 存完整评估结果，摘要列供查询/审计。 */
  function toReadModel(row) {
    const detail = row.detail ?? {};
    return {
      judgment_id: row.id,
      ...detail,
      period: { type: row.period_type, value: row.period_value },
      rule_version: row.rule_version,
      level: row.level ?? detail.level,
      conclusion: row.conclusion ?? detail.conclusion,
      can_judge: row.can_judge ?? detail.can_judge,
      generated_at: row.generated_at ?? null,
    };
  }

  return {
    /** 依据当前结论快照生成（或刷新）跨域判断并落库 */
    async materialize({ periodType, periodValue, actor = 'system' } = {}) {
      assertPeriod({ periodType, periodValue });
      const conclusions = await loadConclusions(periodType, periodValue);
      const evaluation = evaluateJudgment({
        conclusions,
        period: { type: periodType, value: periodValue },
      });
      const row = {
        id: randomUUID(),
        period_type: periodType,
        period_value: periodValue,
        rule_version: evaluation.rule_version,
        level: evaluation.level,
        conclusion: evaluation.conclusion,
        present_domains: evaluation.present_domains,
        missing_domains: evaluation.missing_domains,
        // 引用快照 id 列表：跨域结论 → 专业中心结论的可追溯锚点
        referenced_conclusion_ids: evaluation.references.map((r) => r.conclusion_id).filter(Boolean),
        can_judge: evaluation.can_judge,
        detail: evaluation,
        generated_at: now(),
      };
      const saved = await judgmentRepository.upsert(row, { actor, action: 'judgment.generate' });
      return saved;
    },

    /** F13 主入口：展示跨域经营判断结论 + 引用的各专业中心结论 */
    async getJudgment({ periodType, periodValue, refresh = false, actor = 'system' } = {}) {
      assertPeriod({ periodType, periodValue });
      if (!refresh) {
        const stored = await judgmentRepository.findByPeriod({
          periodType,
          periodValue,
          ruleVersion: RULE_VERSION,
        });
        if (stored) return toReadModel(stored);
      }
      const saved = await this.materialize({ periodType, periodValue, actor });
      return toReadModel(saved);
    },

    async listJudgments({ periodType, periodValue } = {}) {
      if (periodType) assertPeriod({ periodType, periodValue });
      const rows = await judgmentRepository.list({ periodType, periodValue });
      return {
        count: rows.length,
        judgments: rows.map((row) => ({
          judgment_id: row.id,
          period: { type: row.period_type, value: row.period_value },
          level: row.level,
          conclusion: row.conclusion,
          can_judge: row.can_judge,
          present_domains: row.present_domains,
          missing_domains: row.missing_domains,
          reference_count: (row.referenced_conclusion_ids ?? []).length,
          generated_at: row.generated_at,
        })),
      };
    },

    /** 引用明细 + 可追溯性核验：每条引用的中心结论都能被列出并回查到快照 */
    async getReferences(judgmentId, { actor = 'system' } = {}) {
      const row = await judgmentRepository.findById(judgmentId);
      if (!row) {
        throw new HttpError(404, 'JUDGMENT_NOT_FOUND', `跨域判断 ${judgmentId} 不存在`);
      }
      const detail = row.detail ?? {};
      const references = detail.references ?? [];

      const unresolved = [];
      let checked = 0;
      for (const ref of references) {
        if (!ref.conclusion_id) {
          // 缺失域没有快照可引用，属「该域数据缺失」的既定口径，不计为不可追溯
          continue;
        }
        checked += 1;
        const found = await conclusionRepository.findById(ref.conclusion_id);
        if (!found) unresolved.push(ref.conclusion_id);
      }

      return {
        judgment_id: row.id,
        period: { type: row.period_type, value: row.period_value },
        level: row.level,
        conclusion: row.conclusion,
        rule_version: row.rule_version,
        reference_count: references.length,
        present_reference_count: references.filter((r) => !r.missing).length,
        references,
        missing_domains: detail.missing_domain_details ?? [],
        traceability: {
          checked_conclusion_refs: checked,
          resolved_conclusion_refs: checked - unresolved.length,
          unresolved_conclusion_ids: unresolved,
          all_resolved: unresolved.length === 0,
          note: '每条引用均带 center / version / as_of / 数据截止时间，可按 conclusion_id 回查结论快照。',
        },
      };
    },

    /**
     * 判定标准落地：抽样不少于 10 条比对「EBMS 展示值」与「专业中心输出值」，
     * 一致率须 100%；若存在差异，差异须有明确口径说明。
     */
    async checkConsistency({ periodType, periodValue, sampleSize = MIN_CONSISTENCY_SAMPLES } = {}) {
      assertPeriod({ periodType, periodValue });
      const size = Number.isInteger(sampleSize) && sampleSize > 0 ? sampleSize : MIN_CONSISTENCY_SAMPLES;
      const conclusions = await loadConclusions(periodType, periodValue);
      const report = sampleConsistency({
        conclusions,
        period: { type: periodType, value: periodValue },
        sampleSize: Math.max(size, MIN_CONSISTENCY_SAMPLES),
      });
      const passed =
        report.consistent_rate === 1 && report.unexplained_difference_count === 0 && report.meets_minimum;
      return {
        ...report,
        passed,
        verdict: passed
          ? `抽样 ${report.compared_count} 条比对，一致率 100%，无未解释差异。`
          : report.meets_minimum
            ? `抽样 ${report.compared_count} 条比对，一致率 ${report.consistent_rate}，存在未解释差异 ${report.unexplained_difference_count} 条。`
            : `有效比对样本 ${report.compared_count} 条，少于判定要求的 ${report.minimum_sample_size} 条，判定不成立。`,
      };
    },

    /** 供前端选择周期：列出结论快照中出现过的周期 */
    async listPeriods() {
      const rows = await conclusionRepository.list({});
      const seen = new Map();
      for (const row of rows) {
        const key = `${row.period_type}|${row.period_value}`;
        if (!seen.has(key)) {
          seen.set(key, {
            period_type: row.period_type,
            period_value: row.period_value,
            center_count: 0,
            missing_center_count: 0,
          });
        }
        const entry = seen.get(key);
        entry.center_count += 1;
        if (row.missing === true) entry.missing_center_count += 1;
      }
      const periods = [...seen.values()].sort((a, b) =>
        `${b.period_value}${b.period_type}`.localeCompare(`${a.period_value}${a.period_type}`),
      );
      return { count: periods.length, periods };
    },
  };
}
