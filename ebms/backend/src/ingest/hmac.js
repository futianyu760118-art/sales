// 结论接入鉴权：HMAC-SHA256 签名（契约蓝本见架构方案 3.2.1，沿用 sales external-api 模式）。
// 密钥一律来自环境变量注入（见 config.js），不落库、不写死。
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADERS = Object.freeze({
  APP_KEY: 'x-app-key',
  TIMESTAMP: 'x-timestamp',
  SIGNATURE: 'x-signature',
});

/** 规范化查询串：参数名升序，与签名原文保持一致，避免两侧拼接顺序不同导致签名不符。 */
export function canonicalQueryString(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/** 签名原文口径：timestamp + app_key + endpoint_code + query_string（顺序固定，与中心侧约定一致）。 */
export function buildSignaturePayload({ timestamp, appKey, endpointCode, queryString = '' }) {
  return `${timestamp}${appKey}${endpointCode}${queryString}`;
}

export function signConclusionRequest({ secret, timestamp, appKey, endpointCode, queryString = '' }) {
  if (!secret) throw new Error('缺少签名密钥（secret 必须由环境变量注入）');
  return createHmac('sha256', secret)
    .update(buildSignaturePayload({ timestamp, appKey, endpointCode, queryString }))
    .digest('hex');
}

export function buildSignedHeaders({
  appKey,
  secret,
  endpointCode,
  queryString = '',
  timestamp = Math.floor(Date.now() / 1000),
}) {
  return {
    [SIGNATURE_HEADERS.APP_KEY]: appKey,
    [SIGNATURE_HEADERS.TIMESTAMP]: String(timestamp),
    [SIGNATURE_HEADERS.SIGNATURE]: signConclusionRequest({ secret, timestamp, appKey, endpointCode, queryString }),
  };
}

/** 供「本地模拟中心」与测试使用：常量时间比较，避免签名被逐字节试探。 */
export function verifySignature({ secret, headers, endpointCode, queryString = '' }) {
  const appKey = headers?.[SIGNATURE_HEADERS.APP_KEY];
  const timestamp = headers?.[SIGNATURE_HEADERS.TIMESTAMP];
  const provided = headers?.[SIGNATURE_HEADERS.SIGNATURE];
  if (!appKey || !timestamp || !provided) return false;
  const expected = signConclusionRequest({ secret, timestamp, appKey, endpointCode, queryString });
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
