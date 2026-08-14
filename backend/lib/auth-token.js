/**
 * 登录 token（自签 HMAC-SHA256）
 * ------------------------------------------------------------------
 * 与 HTTP 登录态一致：登录成功后由服务端签发，前端存 localStorage，
 * WebSocket 鉴权（im_auth / auth）用同一套 token 校验身份，不再信任客户端自报 user/user_id。
 *
 * 说明：不引入 jsonwebtoken 依赖，用 Node 内置 crypto 实现 base64url(payload).sig。
 * token 格式：base64url(JSON{uid,username,iat,exp}) . base64url(HMAC-SHA256(payload))
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 服务端密钥持久化到 database/.auth-secret（已被 .gitignore 忽略，不进入版本库），
// 保证服务重启后已签发 token 仍有效。
const SECRET_PATH = path.join(__dirname, '..', '..', 'database', '.auth-secret');
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天，避免频繁重新登录

let _cachedSecret = null;

function getSecret() {
  if (_cachedSecret) return _cachedSecret;
  try {
    const s = fs.readFileSync(SECRET_PATH, 'utf8').trim();
    if (s) {
      _cachedSecret = s;
      return s;
    }
  } catch (e) { /* 首次启动，尚无密钥文件 */ }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(SECRET_PATH, secret, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    // 写盘失败时退化为进程内密钥：重启后旧 token 失效，可接受（不阻断登录）
  }
  _cachedSecret = secret;
  return secret;
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/**
 * 为用户签发 token
 * @param {object} user - 至少含 id/uid 与 username 字段
 * @returns {string} token
 */
function issueToken(user) {
  const uid = user && (user.id !== undefined ? user.id : user.uid);
  if (uid === undefined || uid === null) {
    throw new Error('issueToken: 缺少用户 id');
  }
  const payload = Buffer.from(JSON.stringify({
    uid,
    username: user.username || '',
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS
  })).toString('base64url');
  return payload + '.' + sign(payload);
}

/**
 * 校验 token，返回 payload { uid, username, iat, exp }，无效/过期返回 null
 */
function verifyToken(token) {
  if (typeof token !== 'string' || token.length < 3) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || data.uid === undefined || data.uid === null) return null;
    if (typeof data.exp === 'number' && Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

module.exports = { issueToken, verifyToken };
