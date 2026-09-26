/**
 * 接口层：链路查询路由（PAND-84 反向查询契约）。
 *
 * 全部端点为只读 GET。反向查询不存在任何写端点 —— 与 AC 边界
 * 「反向只读：反向查询过程不产生新的跨域写操作」一致。
 */

import { Router } from 'express';
import { DEFAULT_CONSISTENCY_SAMPLE } from '../services/traceService.js';

export function createTraceRouter({ traceService, actor }) {
  const router = Router();

  // 反向入口 1：Evidence → 归因项 → 最终结果指标（AC 场景 1）
  router.get('/trace/reverse/by-evidence/:evidenceId', actor, (req, res, next) => {
    try {
      res.json(traceService.reverseByEvidence(req.params.evidenceId));
    } catch (err) {
      next(err);
    }
  });

  // 反向入口 2：source_system → Evidence / 归因项 / 最终结果指标（AC 场景 2）
  router.get('/trace/reverse/by-source-system/:sourceSystem', actor, (req, res, next) => {
    try {
      res.json(traceService.reverseBySourceSystem(req.params.sourceSystem));
    } catch (err) {
      next(err);
    }
  });

  // 反查结果每项均可跳转正向导航对应位置（AC 场景 3）由各项 forwardTarget 承载；
  // 本端点给出正向导航读模型本体，用于比对与跳转落地。
  router.get('/trace/forward/by-result/:metricId', actor, (req, res, next) => {
    try {
      res.json(traceService.forwardByMetric(req.params.metricId));
    } catch (err) {
      next(err);
    }
  });

  // 自证：反向结果与正向导航的关联关系逐对一致（AC 判定标准 1）
  router.get('/trace/reverse/consistency', actor, (req, res, next) => {
    try {
      const raw = Number(req.query.sample);
      const sample = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_CONSISTENCY_SAMPLE;
      res.json(traceService.consistencySample(sample));
    } catch (err) {
      next(err);
    }
  });

  // 自证：归因项 100% 符合 PAND-80 口径（AC 判定标准 2）
  router.get('/trace/reverse/attribution-compliance', actor, (req, res, next) => {
    try {
      res.json(traceService.attributionCompliance());
    } catch (err) {
      next(err);
    }
  });

  // 自证：对象清点 = Result / Exception / Evidence + source_system 字段（AC 判定标准 3）
  router.get('/trace/contract-objects', actor, (req, res, next) => {
    try {
      res.json(traceService.contractObjects());
    } catch (err) {
      next(err);
    }
  });

  // 可用来源系统取值（供反向入口 2 的筛选器）
  router.get('/trace/source-systems', actor, async (req, res, next) => {
    try {
      res.json({ sourceSystems: await traceService.listSourceSystems() });
    } catch (err) {
      next(err);
    }
  });

  // 只读自检：反向查询前后各表行数与 audit_log 水位
  router.get('/trace/read-only-check', actor, (req, res, next) => {
    try {
      res.json(traceService.readOnlyAudit());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
