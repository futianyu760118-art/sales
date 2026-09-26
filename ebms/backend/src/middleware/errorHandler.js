import { HttpError } from '../domain/httpError.js';

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `无此路由: ${req.method} ${req.originalUrl}` },
  });
}

// eslint-disable-next-line no-unused-vars -- Express 靠 4 个形参识别错误中间件
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, detail: err.detail ?? null },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
}
