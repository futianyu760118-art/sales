'use strict';

const crypto = require('crypto');
const config = require('../config/env');

// 轻量 HMAC-SHA256 签名 token（沿用销售系统 external-api.js / auth-token.js 的签名思路）。
// 结构：base64url(payloadJson) + '.' + base64url(hmac)
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  const body = base64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', config.auth.secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', config.auth.secret).update(body).digest('base64url');
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  // 定长比较，避免时序侧信道
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function issue({ id, username, displayName, role }) {
  return sign({
    sub: id,
    username,
    name: displayName,
    role,
    exp: Math.floor(Date.now() / 1000) + config.auth.tokenTtlSeconds,
  });
}

module.exports = { issue, verify };
