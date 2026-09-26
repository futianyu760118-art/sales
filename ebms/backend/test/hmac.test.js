// 结论接入鉴权契约验证（架构方案 3.2.1：HMAC-SHA256 + X-App-Key / X-Timestamp / X-Signature）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  SIGNATURE_HEADERS,
  buildSignaturePayload,
  buildSignedHeaders,
  canonicalQueryString,
  signConclusionRequest,
  verifySignature,
} from '../src/ingest/hmac.js';

const SECRET = 'test-secret-not-a-real-credential';

test('签名原文口径固定为 timestamp + app_key + endpoint_code + query_string', () => {
  const payload = buildSignaturePayload({
    timestamp: 1758585600,
    appKey: 'ebms-readonly',
    endpointCode: 'external.conclusions',
    queryString: 'period_type=month&period_value=2026-08',
  });
  assert.equal(payload, '1758585600ebms-readonlyexternal.conclusionsperiod_type=month&period_value=2026-08');
});

test('签名可复现：相同输入产生相同 HMAC，且与独立计算一致', () => {
  const args = {
    secret: SECRET,
    timestamp: 1758585600,
    appKey: 'ebms-readonly',
    endpointCode: 'external.conclusions',
    queryString: 'period_type=month&period_value=2026-08',
  };
  const sig = signConclusionRequest(args);
  assert.equal(sig, signConclusionRequest(args));
  const expected = createHmac('sha256', SECRET)
    .update('1758585600ebms-readonlyexternal.conclusionsperiod_type=month&period_value=2026-08')
    .digest('hex');
  assert.equal(sig, expected);
});

test('缺少密钥时拒绝签名（密钥只能由环境变量注入，不得内置）', () => {
  assert.throws(
    () => signConclusionRequest({ secret: '', timestamp: 1, appKey: 'k', endpointCode: 'e' }),
    /密钥/,
  );
});

test('查询串规范化：参数名升序且按 URL 编码，两侧拼接顺序一致', () => {
  assert.equal(canonicalQueryString({ period_value: '2026-08', period_type: 'month' }), 'period_type=month&period_value=2026-08');
  assert.equal(canonicalQueryString({ b: 2, a: 1, c: '' }), 'a=1&b=2');
  assert.equal(canonicalQueryString({ keyword: '华东 区' }), 'keyword=%E5%8D%8E%E4%B8%9C%20%E5%8C%BA');
});

test('verifySignature：正确签名通过，篡改查询串 / 错误密钥被拒', () => {
  const base = { appKey: 'ebms-readonly', endpointCode: 'external.conclusions', queryString: 'period_type=month', timestamp: 1758585600 };
  const headers = buildSignedHeaders({ ...base, secret: SECRET });
  assert.equal(headers[SIGNATURE_HEADERS.APP_KEY], 'ebms-readonly');
  assert.equal(headers[SIGNATURE_HEADERS.TIMESTAMP], '1758585600');
  assert.equal(verifySignature({ secret: SECRET, headers, endpointCode: base.endpointCode, queryString: base.queryString }), true);
  // 篡改查询串（签名覆盖查询串，防止换周期重放）
  assert.equal(verifySignature({ secret: SECRET, headers, endpointCode: base.endpointCode, queryString: 'period_type=week' }), false);
  // 错误密钥（模拟伪造来源）
  assert.equal(verifySignature({ secret: 'wrong-secret', headers, endpointCode: base.endpointCode, queryString: base.queryString }), false);
  // 缺少任一签名头
  assert.equal(verifySignature({ secret: SECRET, headers: { [SIGNATURE_HEADERS.APP_KEY]: 'ebms-readonly' }, endpointCode: base.endpointCode, queryString: base.queryString }), false);
});

test('签名头不含密钥本体，仅含 app key 与签名值', () => {
  const headers = buildSignedHeaders({ secret: SECRET, appKey: 'ebms-readonly', endpointCode: 'external.conclusions', queryString: '' });
  const serialized = JSON.stringify(headers);
  assert.equal(serialized.includes(SECRET), false, '签名头不得回带密钥');
  assert.equal(Object.keys(headers).length, 3);
});
