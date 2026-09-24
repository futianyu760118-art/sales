// 应用/接口层：结果指标与归因域 REST 路由（架构方案 3.2.2）
import { Router } from 'express';
import { MAX_DEPTH } from '../domain/attribution.js';

export function createResultsRouter({ reasonService, auth }) {
  const router = Router();

  const readDepth = (req) => {
    const raw = Number(req.query.max_depth ?? req.query.depth);
    if (!Number.isInteger(raw) || raw < 1) return MAX_DEPTH;
    return Math.min(raw, MAX_DEPTH);
  };

  // F2 主入口：从任一结果指标的偏差穿透到原因项
  router.get('/results/:id/reasons', auth, async (req, res, next) => {
    try {
      const payload = await reasonService.listReasonsForMetric(req.params.id, { maxDepth: readDepth(req) });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  // Reason 层多级展开（逐级下钻）
  router.get('/reasons/:id/children', auth, async (req, res, next) => {
    try {
      const payload = await reasonService.listChildren(req.params.id, { maxDepth: readDepth(req) });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  // 边界「关联入口」落地：关联原因项；mode=replace 时以本次集合整体替换并校验合计口径
  router.post('/results/:id/reasons', auth, async (req, res, next) => {
    try {
      const payload = await reasonService.createReasons(req.params.id, req.body ?? {}, {
        actor: req.user?.id ?? 'anonymous',
      });
      res.status(201).json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/reasons/:id', auth, async (req, res, next) => {
    try {
      const payload = await reasonService.updateReason(req.params.id, req.body ?? {}, {
        actor: req.user?.id ?? 'anonymous',
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/reasons/:id', auth, async (req, res, next) => {
    try {
      const payload = await reasonService.deleteReason(req.params.id, {
        actor: req.user?.id ?? 'anonymous',
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
