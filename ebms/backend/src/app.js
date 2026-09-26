'use strict';

const express = require('express');
const evidenceRoutes = require('./http/routes/evidence-routes');
const objectRoutes = require('./http/routes/object-routes');
const authRoutes = require('./http/routes/auth-routes');
const { errorHandler, notFoundHandler } = require('./http/middleware/error-handler');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 前端（Vue 3 SPA dev server）跨端口访问；EBMS 内部 BFF，仅放行本地来源。
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const allowed = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || '');
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.get('/api/v1/health', (_req, res) => res.json({ ok: true, data: { status: 'up' } }));
  app.use('/api/v1', authRoutes);
  app.use('/api/v1', evidenceRoutes);
  app.use('/api/v1', objectRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
