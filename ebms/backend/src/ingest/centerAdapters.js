// 接入层：专业中心结论接入 Adapter ×4（架构方案 3.2.1 / 3.1 接入层）。
// 模式：EBMS 主动拉取为主（按指标周期），中心亦可 push 补录；
// 生产/交付、财务、供应链三域接口未确认 → 以「人工录入 / 文件导入」兜底
// （Source 口径已含「人工录入」，架构方案 3.2.1 关键约定）。
//
// 本层只负责「取回原样结论」，不做任何指标计算；缺失/超时/不可达一律转为 missing 标记，
// 交由跨域判断域输出「该域数据缺失」，从而不阻断其余域判断。
import { randomUUID } from 'node:crypto';
import { buildSignedHeaders, canonicalQueryString } from './hmac.js';
import { CENTER_CODES, MISSING_REASON } from '../domain/judgment.js';

export const CONCLUSIONS_ENDPOINT_CODE = 'external.conclusions';

/** 中心返回体 → 结论快照行。payload 原样保存，保证「展示值与中心输出值一致」。 */
export function normalizeConclusionResponse({
  center,
  body,
  periodType,
  periodValue,
  sourceMode = 'api',
  missing = false,
  missingReason = null,
  now = () => new Date().toISOString(),
}) {
  const payload = body && typeof body === 'object' ? body : null;
  if (!missing) {
    if (!payload) {
      return {
        row: buildMissingRow({ center, periodType, periodValue, sourceMode, missingReason: MISSING_REASON.UNREACHABLE, now }),
        error: { code: 'EMPTY_BODY', message: `中心 ${center} 返回空响应体` },
      };
    }
    if (payload.center && payload.center !== center) {
      return {
        row: buildMissingRow({ center, periodType, periodValue, sourceMode, missingReason: MISSING_REASON.UNREACHABLE, now }),
        error: { code: 'CENTER_MISMATCH', message: `中心返回体标识 ${payload.center} 与请求域 ${center} 不一致` },
      };
    }
    if (!Array.isArray(payload.metrics)) {
      return {
        row: buildMissingRow({ center, periodType, periodValue, sourceMode, missingReason: MISSING_REASON.UNREACHABLE, now }),
        error: { code: 'METRICS_REQUIRED', message: `中心 ${center} 返回体缺少 metrics 数组` },
      };
    }
  }
  return {
    row: {
      id: randomUUID(),
      center,
      period_type: periodType,
      period_value: periodValue,
      // 无结论时 version/as_of 置空，避免伪造批次信息
      version: missing ? null : (payload.version ?? null),
      as_of: missing ? null : (payload.as_of ?? null),
      payload,
      missing,
      missing_reason: missing ? (missingReason ?? MISSING_REASON.NO_CONCLUSION) : null,
      source_mode: sourceMode,
      ingested_at: now(),
    },
    error: null,
  };
}

function buildMissingRow({ center, periodType, periodValue, sourceMode, missingReason, now }) {
  return {
    id: randomUUID(),
    center,
    period_type: periodType,
    period_value: periodValue,
    version: null,
    as_of: null,
    payload: null,
    missing: true,
    missing_reason: missingReason,
    source_mode: sourceMode,
    ingested_at: now(),
  };
}

/**
 * HTTP 拉取型 Adapter：HMAC-SHA256 签名请求 GET {baseUrl}/api/v1/external/conclusions。
 * 不可达 / 超时 / 非 2xx 均不抛错，转为 missing 行，由调用方统一落库。
 */
export function createHttpAdapter({
  center,
  baseUrl,
  appKey,
  secret,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  clock = () => Math.floor(Date.now() / 1000),
}) {
  return {
    center,
    mode: 'api',
    async fetchConclusions({ periodType, periodValue }) {
      const query = canonicalQueryString({ period_type: periodType, period_value: periodValue });
      if (!baseUrl) {
        return normalizeConclusionResponse({
          center,
          body: null,
          periodType,
          periodValue,
          sourceMode: 'api',
          missing: true,
          missingReason: MISSING_REASON.NO_CONCLUSION,
          now,
        });
      }
      const headers = buildSignedHeaders({
        appKey,
        secret,
        endpointCode: CONCLUSIONS_ENDPOINT_CODE,
        queryString: query,
        timestamp: clock(),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/api/v1/external/conclusions?${query}`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        if (!res.ok) {
          const reason = res.status === 404 ? MISSING_REASON.NO_CONCLUSION : MISSING_REASON.UNREACHABLE;
          return normalizeConclusionResponse({
            center,
            body: null,
            periodType,
            periodValue,
            sourceMode: 'api',
            missing: true,
            missingReason: reason,
            now,
          });
        }
        const body = await res.json();
        return normalizeConclusionResponse({ center, body, periodType, periodValue, sourceMode: 'api', now });
      } catch (err) {
        const reason = err?.name === 'AbortError' ? MISSING_REASON.TIMEOUT : MISSING_REASON.UNREACHABLE;
        return normalizeConclusionResponse({
          center,
          body: null,
          periodType,
          periodValue,
          sourceMode: 'api',
          missing: true,
          missingReason: reason,
          now,
          // 附带错误摘要，便于运维定位；不落密钥
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 人工录入 / 文件导入型 Adapter（三域接口未确认期间的兜底口径）。
 * loader 返回该域本周期结论体；返回 null/抛错 → 该域标记缺失。
 */
export function createManualAdapter({ center, loader, now = () => new Date().toISOString() }) {
  return {
    center,
    mode: 'manual',
    async fetchConclusions({ periodType, periodValue }) {
      try {
        const body = await loader({ center, periodType, periodValue });
        if (!body) {
          return normalizeConclusionResponse({
            center,
            body: null,
            periodType,
            periodValue,
            sourceMode: 'manual',
            missing: true,
            missingReason: MISSING_REASON.NO_CONCLUSION,
            now,
          });
        }
        return normalizeConclusionResponse({ center, body, periodType, periodValue, sourceMode: 'manual', now });
      } catch {
        return normalizeConclusionResponse({
          center,
          body: null,
          periodType,
          periodValue,
          sourceMode: 'manual',
          missing: true,
          missingReason: MISSING_REASON.IMPORT_FAILED,
          now,
        });
      }
    },
  };
}

/**
 * 按配置装配四域 adapter。centerConfig: { sales: {mode, baseUrl, appKey, secret}, ... }
 * mode='http' → HTTP Adapter；mode='manual' 或无 baseUrl → 人工/导入兜底。
 */
export function createAdapters({ centerConfig = {}, secrets = {}, fetchImpl, now } = {}) {
  const adapters = new Map();
  for (const center of CENTER_CODES) {
    const cfg = centerConfig[center] ?? {};
    const mode = cfg.mode ?? (cfg.baseUrl ? 'http' : 'manual');
    if (mode === 'http' && cfg.baseUrl) {
      adapters.set(
        center,
        createHttpAdapter({
          center,
          baseUrl: cfg.baseUrl,
          appKey: cfg.appKey ?? `${center}-readonly`,
          secret: cfg.secret ?? secrets[center],
          timeoutMs: cfg.timeoutMs,
          fetchImpl,
          now,
        }),
      );
    } else {
      adapters.set(
        center,
        createManualAdapter({
          center,
          // loader 可依赖周期取值；未提供时退回固定 manualPayload
          loader: cfg.loader ?? (() => cfg.manualPayload ?? null),
          now,
        }),
      );
    }
  }
  return adapters;
}
