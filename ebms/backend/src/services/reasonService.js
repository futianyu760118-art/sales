// 应用层：归因域用例。接口契约见架构方案 3.2.2
//   GET /api/v1/results/{id}/reasons → F2 归因列表 (PAND-80)
import { randomUUID } from 'node:crypto';
import {
  ATTRIBUTION_STATUS,
  CONTRIBUTION_TOLERANCE_PCT,
  MAX_DEPTH,
  DIRECTION_VALUES,
  buildReasonListResponse,
  classifyAttribution,
  findNode,
  flattenTree,
  buildReasonTree,
  roundPct,
  validateReasons,
} from '../domain/attribution.js';
import { HttpError } from '../domain/httpError.js';

export function createReasonService({ metricRepository, reasonRepository }) {
  function parseRequestError(rows) {
    const { errors } = validateReasons(rows);
    const directionErrors = errors.filter((e) => e.code === 'DIRECTION_INVALID');
    if (directionErrors.length > 0) {
      // AC 判定：影响方向取值仅限 正向/负向/中性 三者之一
      throw new HttpError(422, 'VALIDATION_FAILED', directionErrors[0].message, {
        allowed_direction: DIRECTION_VALUES,
        errors,
      });
    }
    if (errors.length > 0) {
      throw new HttpError(422, 'VALIDATION_FAILED', errors[0].message, { errors });
    }
  }

  return {
    /** 场景 1/2/3 + 边界「未归因」：指标偏差 → 原因列表 */
    async listReasonsForMetric(metricId, { maxDepth = MAX_DEPTH } = {}) {
      const metric = await metricRepository.findById(metricId);
      if (!metric) {
        throw new HttpError(404, 'METRIC_NOT_FOUND', `结果指标 ${metricId} 不存在`);
      }
      const rows = await reasonRepository.findByMetricId(metricId);
      return buildReasonListResponse({ metric, rows, maxDepth });
    },

    /** 场景 3：Reason 层多级展开（按需返回某节点的直接子项） */
    async listChildren(reasonId, { maxDepth = MAX_DEPTH } = {}) {
      const reason = await reasonRepository.findById(reasonId);
      if (!reason) {
        throw new HttpError(404, 'REASON_NOT_FOUND', `原因项 ${reasonId} 不存在`);
      }
      const rows = await reasonRepository.findByMetricId(reason.metric_id);
      const { tree } = buildReasonTree(rows, { maxDepth });
      const node = findNode(tree, reasonId);
      const children = node?.children ?? [];
      const childSum = roundPct(children.reduce((acc, c) => acc + (c.contribution_pct || 0), 0)) ?? 0;
      return {
        parent: {
          id: node.id,
          name: node.name,
          level: node.level,
          direction: node.direction,
          direction_label: node.direction_label,
          contribution_pct: node.contribution_pct,
          impact_value: node.impact_value,
          owner: node.owner,
          expandable: node.expandable,
          child_count: node.child_count,
        },
        reason_level: node.level + 1,
        // 固定四层链路中的 Reason 层内层级（L1→L2→L3…），非穿透链路层
        layer: 'REASON',
        children,
        decomposition: {
          parent_contribution_pct: node.contribution_pct,
          children_contribution_pct: childSum,
          undecomposed_pct: node.contribution_pct === null ? null : roundPct(node.contribution_pct - childSum),
          tolerance_pct: CONTRIBUTION_TOLERANCE_PCT,
        },
        empty_state:
          children.length === 0
            ? {
                code: 'NO_CHILD_REASON',
                title: '未细分',
                message: '该原因项尚未细分到下级原因。',
                action: {
                  label: '细分原因',
                  method: 'POST',
                  href: `/api/v1/results/${reason.metric_id}/reasons`,
                },
              }
            : null,
      };
    },

    /** 边界「关联入口」的落地：批量关联/整体替换原因项，写入前做全量口径校验 */
    async createReasons(metricId, payload, { actor = 'system' } = {}) {
      const metric = await metricRepository.findById(metricId);
      if (!metric) {
        throw new HttpError(404, 'METRIC_NOT_FOUND', `结果指标 ${metricId} 不存在`);
      }
      const items = Array.isArray(payload.reasons) ? payload.reasons : [payload];
      if (items.length === 0) {
        throw new HttpError(422, 'VALIDATION_FAILED', '至少需要 1 条原因项');
      }
      const existing = payload.mode === 'replace' ? [] : await reasonRepository.findByMetricId(metricId);
      const existingIds = new Set(existing.map((r) => r.id));

      const prepared = items.map((item, index) => ({
        id: item.id ?? randomUUID(),
        metric_id: metricId,
        parent_id: item.parent_id ?? null,
        name: item.name,
        direction: item.direction,
        contribution_pct: item.contribution_pct ?? null,
        impact_value: item.impact_value ?? null,
        owner: item.owner,
        owner_type: item.owner_type ?? 'center',
        order_no: item.order_no ?? index + 1,
        note: item.note ?? null,
      }));

      // 父项必须存在于「写入后的全量集合」中
      const allIds = new Set([...existingIds, ...prepared.map((r) => r.id)]);
      // id 为主键（全局唯一）：同指标重名与跨指标撞 id 都应被拦截，而非落库冲突报 500
      const replaceMode = payload.mode === 'replace';
      const conflicts = [];
      for (const row of prepared) {
        const taken = await reasonRepository.findById(row.id);
        // replace 模式会先清空本指标，故本指标内的既有 id 不算冲突
        if (taken && !(replaceMode && taken.metric_id === metricId)) {
          conflicts.push({ id: row.id, held_by_metric: taken.metric_id });
        }
      }
      if (conflicts.length > 0) {
        throw new HttpError(422, 'VALIDATION_FAILED', `原因项 ID 已被占用：${conflicts.map((c) => c.id).join(', ')}`, {
          code: 'DUPLICATE_REASON_ID',
          conflicts,
        });
      }
      for (const row of prepared) {
        if (row.parent_id && !allIds.has(row.parent_id)) {
          throw new HttpError(422, 'VALIDATION_FAILED', `父原因项 ${row.parent_id} 不存在`, {
            reason_id: row.id,
            code: 'PARENT_NOT_FOUND',
          });
        }
      }

      parseRequestError([...existing, ...prepared]);

      const saved = await reasonRepository.createMany(prepared, { actor, action: 'reason.create' }, { mode: payload.mode ?? 'append' });
      const rows = await reasonRepository.findByMetricId(metricId);
      const roots = rows.filter((r) => !r.parent_id);
      const attribution = classifyAttribution(
        roundPct(roots.reduce((acc, r) => acc + (Number(r.contribution_pct) || 0), 0)) ?? 0,
      );
      return {
        created: saved.map((r) => ({ id: r.id, name: r.name, level: 1 })),
        created_count: saved.length,
        attribution,
        result: await this.listReasonsForMetric(metricId),
      };
    },

    /** 修改原因项：同样以「修改后的全量集合」校验，避免合计被改坏 */
    async updateReason(reasonId, patch, { actor = 'system' } = {}) {
      const current = await reasonRepository.findById(reasonId);
      if (!current) {
        throw new HttpError(404, 'REASON_NOT_FOUND', `原因项 ${reasonId} 不存在`);
      }
      if (patch.metric_id && patch.metric_id !== current.metric_id) {
        throw new HttpError(422, 'VALIDATION_FAILED', '不允许跨指标搬迁原因项');
      }
      const allowed = {};
      for (const field of ['name', 'direction', 'contribution_pct', 'impact_value', 'owner', 'owner_type', 'order_no', 'note', 'parent_id']) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) allowed[field] = patch[field];
      }
      if (allowed.parent_id === reasonId) {
        throw new HttpError(422, 'VALIDATION_FAILED', '原因项不能作为自身的父项');
      }
      const rows = await reasonRepository.findByMetricId(current.metric_id);
      const projected = rows.map((r) => (r.id === reasonId ? { ...r, ...allowed } : r));
      parseRequestError(projected);

      const updated = await reasonRepository.update(reasonId, allowed, { actor, action: 'reason.update' });
      const roots = projected.filter((r) => !r.parent_id);
      return {
        reason: updated,
        attribution: classifyAttribution(
          roundPct(roots.reduce((acc, r) => acc + (Number(r.contribution_pct) || 0), 0)) ?? 0,
        ),
        result: await this.listReasonsForMetric(current.metric_id),
      };
    },

    /** 解除关联（含子项级联） */
    async deleteReason(reasonId, { actor = 'system' } = {}) {
      const current = await reasonRepository.findById(reasonId);
      if (!current) {
        throw new HttpError(404, 'REASON_NOT_FOUND', `原因项 ${reasonId} 不存在`);
      }
      await reasonRepository.remove(reasonId, { actor, action: 'reason.delete' });
      const result = await this.listReasonsForMetric(current.metric_id);
      return { deleted_id: reasonId, result };
    },

    /** 内部用：扁平化（供后续 F3/F5 复用链路遍历） */
    async listFlatReasons(metricId) {
      const rows = await reasonRepository.findByMetricId(metricId);
      return flattenTree(buildReasonTree(rows).tree);
    },
  };
}

export { ATTRIBUTION_STATUS, HttpError };
