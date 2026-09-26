const BASE = '/api/v1';

let token = sessionStorage.getItem('ebms_token') || '';

export function getToken() {
  return token;
}

export function setToken(next) {
  token = next;
  if (next) sessionStorage.setItem('ebms_token', next);
  else sessionStorage.removeItem('ebms_token');
}

async function request(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok || (payload && payload.ok === false)) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${res.status}）`);
    error.code = payload?.error?.code || 'HTTP_ERROR';
    error.details = payload?.error?.details;
    throw error;
  }
  return payload.data;
}

export const api = {
  devLogin: (username) => request('/auth/dev-login', { method: 'POST', body: { username } }),
  evidenceTypes: () => request('/evidence-types'),
  reasons: () => request('/reasons'),
  reasonEvidences: (reasonId) => request(`/reasons/${reasonId}/evidences`),
  evidenceCandidates: (reasonId, q) =>
    request(`/evidences?unlinkedToReason=${encodeURIComponent(reasonId)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  evidenceDetail: (evidenceId) => request(`/evidences/${evidenceId}`),
  createEvidence: (input) => request('/evidences', { method: 'POST', body: input, auth: true }),
  linkEvidence: (reasonId, evidenceId) =>
    request(`/reasons/${reasonId}/evidences`, { method: 'POST', body: { evidenceId }, auth: true }),
  unlinkEvidence: (reasonId, evidenceId) =>
    request(`/reasons/${reasonId}/evidences/${evidenceId}`, { method: 'DELETE', auth: true }),

  // F11（PAND-89）四视图对象交叉跳转
  viewObjectTypes: () => request('/view-object-types'),
  viewObjects: (type) => request(`/objects/${type}`),
  viewObject: (type, id) => request(`/objects/${type}/${id}`),
  viewNavigation: (type, id) => request(`/objects/${type}/${id}/links`),
};
