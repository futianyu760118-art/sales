// 接口客户端：与架构方案 3.2.2 对内 REST API 一一对应（F2 / F13 相关端点）
const BASE = '/api/v1';

function periodQuery({ periodType, periodValue } = {}) {
  const params = new URLSearchParams();
  if (periodType) params.set('period_type', periodType);
  if (periodValue) params.set('period_value', periodValue);
  return params.toString();
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = new Error(body?.error?.message ?? `请求失败（HTTP ${res.status}）`);
    error.status = res.status;
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    throw error;
  }
  return body;
}

export const api = {
  /** 场景 1：从任一结果指标的偏差打开原因列表 */
  getReasons(metricId, { maxDepth } = {}) {
    const query = maxDepth ? `?max_depth=${maxDepth}` : '';
    return request(`/results/${encodeURIComponent(metricId)}/reasons${query}`);
  },
  /** 场景 3：Reason 层多级展开（逐级下钻） */
  getReasonChildren(reasonId) {
    return request(`/reasons/${encodeURIComponent(reasonId)}/children`);
  },
  /** 边界「关联入口」：关联原因项 */
  linkReasons(metricId, payload) {
    return request(`/results/${encodeURIComponent(metricId)}/reasons`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  updateReason(reasonId, patch) {
    return request(`/reasons/${encodeURIComponent(reasonId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  unlinkReason(reasonId) {
    return request(`/reasons/${encodeURIComponent(reasonId)}`, { method: 'DELETE' });
  },

  /** F13 场景 1：跨域经营判断结论 + 引用的各专业中心结论 */
  getJudgment({ periodType, periodValue, refresh = false } = {}) {
    const query = periodQuery({ periodType, periodValue });
    const suffix = refresh ? `${query ? `${query}&` : ''}refresh=1` : query;
    return request(`/judgments?${suffix}`);
  },
  /** F13 判定标准：跨域结论引用的专业中心结论逐条可追溯 */
  getJudgmentReferences(judgmentId) {
    return request(`/judgments/${encodeURIComponent(judgmentId)}/references`);
  },
  /** F13 判定标准：抽样不少于 10 条比对，一致率 100% */
  getConsistency({ periodType, periodValue, sampleSize } = {}) {
    const params = new URLSearchParams(periodQuery({ periodType, periodValue }));
    if (sampleSize) params.set('sample_size', String(sampleSize));
    return request(`/judgments/consistency?${params.toString()}`);
  },
  /** 可供选择的判断周期 */
  getJudgmentPeriods() {
    return request('/judgments/periods');
  },
  /** 结论接入：触发四域拉取（缺失域以「该域数据缺失」落库） */
  ingestConclusions({ periodType, periodValue, centers } = {}) {
    return request('/conclusions/ingest', {
      method: 'POST',
      body: JSON.stringify({ period_type: periodType, period_value: periodValue, centers }),
    });
  },
};
