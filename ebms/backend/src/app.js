// 接入层/装配：createApp 注入 repository，便于 pg/内存两种实现互换与验收自检。
import express from 'express';
import { createReasonService } from './services/reasonService.js';
import { createIngestService } from './services/ingestService.js';
import { createJudgmentService } from './services/judgmentService.js';
import { createResultsRouter } from './routes/results.js';
import { createConclusionsRouter } from './routes/conclusions.js';
import { createJudgmentsRouter } from './routes/judgments.js';

/** 鉴权占位：接 RBAC + 数据范围（架构方案 3.4）；本 issue 不涉及角色区隔（见 PAND-93）。 */
export function createAuthMiddleware({ enforce = false } = {}) {
  return (req, _res, next) => {
    if (!enforce) {
      req.user = { id: 'dev-user', roles: ['decider'] };
      return next();
    }
    const header = req.get('authorization') || '';
    if (!/^Bearer\s+.+$/i.test(header)) {
      return next(Object.assign(new Error('未认证'), { status: 401, code: 'UNAUTHORIZED' }));
    }
    req.user = { id: 'token-user', roles: ['decider'] };
    next();
  };
}

export function createApp({
  metricRepository,
  reasonRepository,
  conclusionRepository,
  judgmentRepository,
  adapters = new Map(),
  enforceAuth = false,
  logger = console,
}) {
  if (!metricRepository || !reasonRepository || !conclusionRepository || !judgmentRepository) {
    throw new Error('createApp 需要 metricRepository、reasonRepository、conclusionRepository 与 judgmentRepository');
  }
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const auth = createAuthMiddleware({ enforce: enforceAuth });
  const reasonService = createReasonService({ metricRepository, reasonRepository });
  const judgmentService = createJudgmentService({ conclusionRepository, judgmentRepository });
  // 事件 conclusion.ingested → 触发跨域判断聚合（架构方案 3.2.3）
  const ingestService = createIngestService({
    conclusionRepository,
    adapters,
    onConclusionsIngested: ({ periodType, periodValue, actor }) =>
      judgmentService.materialize({ periodType, periodValue, actor }),
  });

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'ebms-backend' }));
  app.use('/api/v1', createResultsRouter({ reasonService, auth }));
  app.use('/api/v1', createConclusionsRouter({ ingestService, auth }));
  app.use('/api/v1', createJudgmentsRouter({ judgmentService, auth }));

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `未找到路由 ${req.method} ${req.originalUrl}` } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) logger.error('[ebms] unhandled error', err);
    res.status(status).json({
      error: {
        code: err.code ?? 'INTERNAL_ERROR',
        message: status >= 500 ? '服务内部错误' : err.message,
        details: err.details ?? undefined,
      },
    });
  });

  app.locals.reasonService = reasonService;
  app.locals.ingestService = ingestService;
  app.locals.judgmentService = judgmentService;
  return app;
}
