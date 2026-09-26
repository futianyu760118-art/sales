// 接入层验收自检：专业中心结论接入契约、HMAC 鉴权、缺失检测与「单域失败不阻断」。
// 使用本地 stub 中心（真实验签）+ 注入 fetch 的确定性失败路径，不依赖外部系统。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  CONCLUSIONS_ENDPOINT_CODE,
  createAdapters,
  createHttpAdapter,
  createManualAdapter,
  normalizeConclusionResponse,
} from '../src/ingest/centerAdapters.js';
import { canonicalQueryString, verifySignature } from '../src/ingest/hmac.js';
import { createIngestService } from '../src/services/ingestService.js';
import { createJudgmentService } from '../src/services/judgmentService.js';
import { createMemoryRepositories } from '../src/repositories/memory/memoryRepositories.js';

const SECRET = 'stub-center-secret-for-tests';
const PERIOD = { periodType: 'month', periodValue: '2026-08' };

const SALES_BODY = {
  center: 'sales',
  period: { type: 'month', value: '2026-08' },
  as_of: '2026-09-05T00:00:00+08:00',
  version: 'v2026-08.3',
  metrics: [{ code: 'revenue', name: '营业收入', target: 1000, actual: 880, unit: '万元', deviation_abs: -120, deviation_pct: -12, threshold_pct: 5, data_status: 'ok' }],
  reasons: [{ metric_code: 'revenue', name: '主力产品单价下调', direction: 'negative', contribution_pct: 45, owner: '销售中心' }],
};

/** 本地 stub 中心：验签通过才返回结论，用于验证 EBMS 侧签名契约。 */
async function startStubCenter({ body = SALES_BODY, status = 200, delayMs = 0 } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const queryString = canonicalQueryString({
      period_type: url.searchParams.get('period_type'),
      period_value: url.searchParams.get('period_value'),
    });
    received.push({
      path: url.pathname,
      queryString,
      signatureValid: verifySignature({
        secret: SECRET,
        headers: req.headers,
        endpointCode: CONCLUSIONS_ENDPOINT_CODE,
        queryString,
      }),
      appKey: req.headers['x-app-key'],
      timestamp: req.headers['x-timestamp'],
    });
    const respond = () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('HTTP Adapter：按契约签名请求，中心验签通过并原样取回结论', async () => {
  const stub = await startStubCenter();
  try {
    const adapter = createHttpAdapter({ center: 'sales', baseUrl: stub.baseUrl, appKey: 'ebms-readonly', secret: SECRET });
    const { row, error } = await adapter.fetchConclusions(PERIOD);
    assert.equal(error, null);
    assert.equal(row.missing, false);
    assert.equal(row.center, 'sales');
    assert.equal(row.version, 'v2026-08.3');
    assert.equal(row.as_of, '2026-09-05T00:00:00+08:00');
    assert.equal(row.source_mode, 'api');
    // payload 原样落库：与中心输出逐字段一致
    assert.deepEqual(row.payload, SALES_BODY);

    const seen = stub.received[0];
    assert.equal(seen.path, '/api/v1/external/conclusions');
    assert.equal(seen.queryString, 'period_type=month&period_value=2026-08');
    assert.equal(seen.signatureValid, true, '中心侧验签须通过');
    assert.equal(seen.appKey, 'ebms-readonly');
  } finally {
    await stub.close();
  }
});

test('HTTP Adapter 缺失检测：404 → no_conclusion', async () => {
  const stub = await startStubCenter({ status: 404, body: { message: 'not found' } });
  try {
    const adapter = createHttpAdapter({ center: 'finance', baseUrl: stub.baseUrl, appKey: 'k', secret: SECRET });
    const { row } = await adapter.fetchConclusions(PERIOD);
    assert.equal(row.missing, true);
    assert.equal(row.missing_reason, 'no_conclusion');
    assert.equal(row.payload, null);
  } finally {
    await stub.close();
  }
});

test('HTTP Adapter 缺失检测：中心不可达 → unreachable（不抛出，转为缺失标记）', async () => {
  const failingFetch = async () => {
    throw new TypeError('fetch failed');
  };
  const adapter = createHttpAdapter({ center: 'finance', baseUrl: 'http://127.0.0.1:1', appKey: 'k', secret: SECRET, fetchImpl: failingFetch });
  const { row } = await adapter.fetchConclusions(PERIOD);
  assert.equal(row.missing, true);
  assert.equal(row.missing_reason, 'unreachable');
});

test('HTTP Adapter 缺失检测：拉取超时 → timeout（AbortController 生效）', async () => {
  const stub = await startStubCenter({ delayMs: 400 });
  try {
    const adapter = createHttpAdapter({ center: 'production', baseUrl: stub.baseUrl, appKey: 'k', secret: SECRET, timeoutMs: 60 });
    const { row } = await adapter.fetchConclusions(PERIOD);
    assert.equal(row.missing, true);
    assert.equal(row.missing_reason, 'timeout');
  } finally {
    await stub.close();
  }
});

test('响应体校验：域标识不匹配 / 缺少 metrics 均按缺失处理并给出错误', () => {
  const mismatch = normalizeConclusionResponse({ center: 'sales', body: { ...SALES_BODY, center: 'finance' }, ...PERIOD });
  assert.equal(mismatch.row.missing, true);
  assert.equal(mismatch.error.code, 'CENTER_MISMATCH');

  const noMetrics = normalizeConclusionResponse({ center: 'sales', body: { center: 'sales', version: 'v1' }, ...PERIOD });
  assert.equal(noMetrics.row.missing, true);
  assert.equal(noMetrics.error.code, 'METRICS_REQUIRED');
});

test('人工录入 Adapter：无数据 → no_conclusion；导入异常 → import_failed', async () => {
  const empty = createManualAdapter({ center: 'supply_chain', loader: () => null });
  assert.equal((await empty.fetchConclusions(PERIOD)).row.missing_reason, 'no_conclusion');

  const broken = createManualAdapter({
    center: 'supply_chain',
    loader: () => {
      throw new Error('读取导入文件失败');
    },
  });
  const { row } = await broken.fetchConclusions(PERIOD);
  assert.equal(row.missing, true);
  assert.equal(row.missing_reason, 'import_failed');
  assert.equal(row.source_mode, 'manual');
});

test('接入编排：单域失败不阻断其余域落库，且缺失域触发「该域数据缺失」判断', async () => {
  const repos = createMemoryRepositories();
  const judgmentService = createJudgmentService(repos);
  const adapters = createAdapters({
    centerConfig: {
      sales: { mode: 'manual', manualPayload: SALES_BODY },
      production: { mode: 'manual', manualPayload: { center: 'production', version: 'v-p', as_of: '2026-09-06T00:00:00+08:00', metrics: [{ code: 'capacity_utilization', name: '产能利用率', target: 85, actual: 78, unit: '%', deviation_abs: -7, deviation_pct: -8.24, threshold_pct: 5, data_status: 'ok' }], reasons: [] } },
      finance: { mode: 'http', baseUrl: 'http://127.0.0.1:1' },
      supply_chain: { mode: 'manual', manualPayload: null },
    },
  });
  const ingestService = createIngestService({
    conclusionRepository: repos.conclusionRepository,
    adapters,
    onConclusionsIngested: ({ periodType, periodValue, actor }) => judgmentService.materialize({ periodType, periodValue, actor }),
  });

  const report = await ingestService.ingestPeriod({ ...PERIOD, actor: 'tester' });
  assert.equal(report.ingested_count, 2);
  assert.equal(report.missing_count, 2);
  assert.equal(report.judgment_generated, true);

  const missingCenters = report.missing.map((m) => m.center).sort();
  assert.deepEqual(missingCenters, ['finance', 'supply_chain']);
  assert.equal(report.missing.find((m) => m.center === 'finance').missing_reason, 'unreachable');
  assert.equal(report.missing.find((m) => m.center === 'supply_chain').missing_reason, 'no_conclusion');

  // 缺失域不影响其余域判断输出
  const judgment = await judgmentService.getJudgment({ ...PERIOD });
  assert.equal(judgment.can_judge, true);
  assert.deepEqual(judgment.present_domains, ['sales', 'production']);
  assert.deepEqual(judgment.missing_domains, ['finance', 'supply_chain']);
  assert.match(judgment.conclusion, /该域数据缺失/);
});

test('接入编排：重报同周期以最新批次覆盖快照（版本随快照更新）', async () => {
  const repos = createMemoryRepositories();
  const ingestService = createIngestService({
    conclusionRepository: repos.conclusionRepository,
    adapters: createAdapters({ centerConfig: { sales: { mode: 'manual', manualPayload: SALES_BODY } } }),
  });
  await ingestService.ingestPeriod({ ...PERIOD });
  await ingestService.ingestPeriod({
    ...PERIOD,
    centers: ['sales'],
  });
  const { conclusions } = await ingestService.listConclusions({ ...PERIOD, center: 'sales' });
  assert.equal(conclusions.length, 1, '同周期同域只保留一条最新快照');
  assert.equal(conclusions[0].version, 'v2026-08.3');
});

test('接入编排：未知专业中心被 422 拒绝并回传允许值', async () => {
  const repos = createMemoryRepositories();
  const ingestService = createIngestService({ conclusionRepository: repos.conclusionRepository, adapters: createAdapters({}) });
  await assert.rejects(
    () => ingestService.ingestPeriod({ ...PERIOD, centers: ['marketing'] }),
    (err) => {
      assert.equal(err.status, 422);
      assert.deepEqual(err.details.allowed_centers, ['sales', 'production', 'finance', 'supply_chain']);
      return true;
    },
  );
});

test('接入编排：非法周期被 422 拒绝', async () => {
  const repos = createMemoryRepositories();
  const ingestService = createIngestService({ conclusionRepository: repos.conclusionRepository, adapters: createAdapters({}) });
  await assert.rejects(
    () => ingestService.ingestPeriod({ periodType: 'hour', periodValue: '2026-08-01T00' }),
    (err) => err.status === 422,
  );
  await assert.rejects(() => ingestService.ingestPeriod({ periodType: 'month', periodValue: '' }), (err) => err.status === 422);
});
