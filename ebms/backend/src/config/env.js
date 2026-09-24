'use strict';

const path = require('path');

// .env 由部署环境提供；不在代码中写入任何密钥。
function loadDotEnv() {
  const fs = require('fs');
  const envPath = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    process.env[key] = line.slice(eq + 1).trim();
  }
}

loadDotEnv();

const config = {
  port: Number(process.env.PORT || 3020),
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.EBMS_DB_HOST || '127.0.0.1',
    port: Number(process.env.EBMS_DB_PORT || 5433),
    database: process.env.EBMS_DB_NAME || 'ebms',
    user: process.env.EBMS_DB_USER || 'ebms',
    password: process.env.EBMS_DB_PASSWORD || '',
  },
  auth: {
    secret: process.env.EBMS_AUTH_SECRET || '',
    tokenTtlSeconds: Number(process.env.EBMS_TOKEN_TTL_SECONDS || 28800),
  },
  uploadDir: path.resolve(__dirname, '../../', process.env.EBMS_UPLOAD_DIR || './var/uploads'),
};

if (!config.auth.secret) {
  throw new Error(
    'EBMS_AUTH_SECRET 未配置：请在 ebms/backend/.env 中注入签名密钥后再启动（参考 .env.example）。'
  );
}

module.exports = config;
