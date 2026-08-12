// 外部系统 Bearer token 管理：内部业务端点需要 OAuth2 密码登录获取 token 后调用。
// token 默认内存缓存（带过期自动刷新），凭证存 system_settings 的 external_bearer_auth。
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { getTable, now } = require('../db');

const CRED_KEY = 'external_bearer_auth';

// 默认凭证（baseUrl 复用 external_sync_config；用户名密码首次启动写入 system_settings）
function _defaultCred() {
  return {
    baseUrl: 'http://192.168.0.127:18085',
    username: 'admin',
    password: 'admin123',
    loginPath: '/api/v1/basicdata/auth/login'
  };
}
function _readCredRow() {
  const t = getTable('system_settings');
  const row = t.all().find(r => r.key === CRED_KEY);
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch (e) { return null; }
}
function getBearerCredentials() {
  return Object.assign(_defaultCred(), _readCredRow() || {});
}
function setBearerCredentials(patch) {
  const cur = getBearerCredentials();
  const next = Object.assign({}, cur, patch || {});
  const t = getTable('system_settings');
  const val = JSON.stringify(next);
  const existing = t.all().find(r => r.key === CRED_KEY);
  if (existing) t.update(existing.id, { value: val, updated_at: now() });
  else t.insert({ key: CRED_KEY, value: val, created_at: now(), updated_at: now() });
  t._invalidate();
  // 凭证变化即清缓存
  _memCache.token = null;
  _memCache.exp = 0;
  return next;
}

// 内存缓存 { token, exp, ts }
const _memCache = { token: null, exp: 0 };

// 从 JWT exp 字段提取过期时间（秒）
function _jwtExp(token) {
  try {
    const part = token.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return Number(obj.exp) || 0;
  } catch (e) { return 0; }
}

function _login(cred) {
  return new Promise((resolve, reject) => {
    const u = new URL(cred.baseUrl + cred.loginPath);
    const body = `username=${encodeURIComponent(cred.username)}&password=${encodeURIComponent(cred.password)}&grant_type=password`;
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, timeout: 15000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`登录失败 HTTP ${res.statusCode}: ${b.substring(0, 200)}`));
        }
        try {
          const j = JSON.parse(b);
          const tok = (j.data && j.data.access_token) || j.access_token;
          if (!tok) return reject(new Error('登录响应无 access_token: ' + b.substring(0, 200)));
          resolve(tok);
        } catch (e) { reject(new Error('登录响应解析失败: ' + b.substring(0, 200))); }
      });
    });
    req.on('error', e => reject(new Error('登录网络错误: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('登录超时')); });
    req.write(body); req.end();
  });
}

// 获取可用 token（缓存有效则复用，否则重登）
async function getBearerToken(forceRefresh) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!forceRefresh && _memCache.token && _memCache.exp > nowSec + 60) {
    return _memCache.token;
  }
  const cred = getBearerCredentials();
  const tok = await _login(cred);
  const exp = _jwtExp(tok) || (nowSec + 3600);
  _memCache.token = tok;
  _memCache.exp = exp;
  return tok;
}

// 用 Bearer 调用外部内部端点（GET）
function fetchWithBearer(path, params = {}, opts = {}) {
  return new Promise(async (resolve, reject) => {
    let token;
    try { token = await getBearerToken(); }
    catch (e) { return reject(e); }
    const cred = getBearerCredentials();
    const parts = [];
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null) parts.push(`${k}=${encodeURIComponent(v)}`);
    });
    const qs = parts.join('&');
    const fullPath = path + (qs ? '?' + qs : '');
    const u = new URL(cred.baseUrl + fullPath);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: opts.method || 'GET',
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      timeout: 30000,
      headers: Object.assign({ 'Authorization': 'Bearer ' + token }, opts.headers || {})
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        // 401 时尝试重登一次
        if (res.statusCode === 401 && !opts._retried) {
          return fetchWithBearer(path, params, Object.assign({}, opts, { _retried: true }))
            .then(resolve, reject);
        }
        let json = null;
        try { json = JSON.parse(b); } catch (e) {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(json || { raw: b });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${b.substring(0, 300)}`));
        }
      });
    });
    req.on('error', e => reject(new Error('网络错误: ' + e.message)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

module.exports = {
  getBearerCredentials, setBearerCredentials, getBearerToken, fetchWithBearer,
  _defaultCred
};