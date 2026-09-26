/**
 * 反向链路接口客户端。
 *
 * 平台请求封装（鉴权头由 M01 Kernel 下发的 token 提供，前端不自建身份体系）。
 */

const BASE = import.meta.env?.VITE_API_BASE ?? '/api/v1';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = new Error(body?.error?.message ?? `请求失败 (${res.status})`);
    error.code = body?.error?.code ?? `HTTP_${res.status}`;
    throw error;
  }
  return body;
}

export const api = {
  get: (path) => request(path, { method: 'GET' }),
};

export function createApi(overrides = {}) {
  return { ...api, ...overrides };
}
