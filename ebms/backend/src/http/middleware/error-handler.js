'use strict';

const { AppError } = require('../errors');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      ok: false,
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  console.error('[ebms] unhandled error:', err);
  return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } });
}

function notFoundHandler(_req, res) {
  res.status(404).json({ ok: false, error: { code: 'ROUTE_NOT_FOUND', message: '接口不存在' } });
}

module.exports = { errorHandler, notFoundHandler };
