// 应用/接口层：专业中心结论接入与快照查询路由（架构方案 3.2.1 · F13 / PAND-91）
//   契约：GET {center_base_url}/api/v1/external/conclusions（HMAC-SHA256 签名）
//   EBMS 侧：POST /api/v1/conclusions/ingest 触发拉取；GET /api/v1/conclusions 查快照
import { Router } from 'express';

export function createConclusionsRouter({ ingestService, auth }) {
  const router = Router();

  // 触发四域结论接入（按周期）。EBMS 主动拉取为主，缺失域以 missing 落库
  router.post('/conclusions/ingest', auth, async (req, res, next) => {
    try {
      const { period_type: periodType, period_value: periodValue, centers } = req.body ?? {};
      const report = await ingestService.ingestPeriod({
        periodType,
        periodValue,
        centers,
        actor: req.user?.id ?? 'anonymous',
      });
      res.status(201).json(report);
    } catch (err) {
      next(err);
    }
  });

  // 结论快照查询：核验展示值与中心输出值一致
  router.get('/conclusions', auth, async (req, res, next) => {
    try {
      const { period_type: periodType, period_value: periodValue, center } = req.query;
      res.json(await ingestService.listConclusions({ periodType, periodValue, center }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
