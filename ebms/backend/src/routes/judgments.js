// 应用/接口层：跨域经营判断 REST 路由（架构方案 3.2.2 · F13 / PAND-91）
import { Router } from 'express';

export function createJudgmentsRouter({ judgmentService, auth }) {
  const router = Router();

  // 固定路径先注册，避免被参数化路径吞掉
  router.get('/judgments/periods', auth, async (req, res, next) => {
    try {
      res.json(await judgmentService.listPeriods());
    } catch (err) {
      next(err);
    }
  });

  // 判定标准：抽样比对（EBMS 展示值 vs 专业中心输出值）
  router.get('/judgments/consistency', auth, async (req, res, next) => {
    try {
      const { period_type: periodType, period_value: periodValue, sample_size: sampleSize } = req.query;
      const size = sampleSize === undefined ? undefined : Number(sampleSize);
      res.json(await judgmentService.checkConsistency({ periodType, periodValue, sampleSize: size }));
    } catch (err) {
      next(err);
    }
  });

  // F13 主入口：跨域判断结论 + 引用明细
  router.get('/judgments', auth, async (req, res, next) => {
    try {
      const { period_type: periodType, period_value: periodValue, refresh } = req.query;
      const payload = await judgmentService.getJudgment({
        periodType,
        periodValue,
        refresh: refresh === '1' || refresh === 'true',
        actor: req.user?.id ?? 'anonymous',
      });
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  // 引用明细：跨域结论引用的各专业中心结论，逐条可追溯
  router.get('/judgments/:id/references', auth, async (req, res, next) => {
    try {
      res.json(await judgmentService.getReferences(req.params.id, { actor: req.user?.id ?? 'anonymous' }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/judgments/list', auth, async (req, res, next) => {
    try {
      const { period_type: periodType, period_value: periodValue } = req.query;
      res.json(await judgmentService.listJudgments({ periodType, periodValue }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
