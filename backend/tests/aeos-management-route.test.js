const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAeosManagementRouter } = require('../routes/aeos-management');
const { AeosError } = require('../aeos/closure-service');
const { validDecision, validAction } = require('./fixtures/valid-contracts');

async function withServer(service, fn, authorize = () => (req, res, next) => next()) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7 }; next(); });
  app.use('/api/aeos/management', createAeosManagementRouter({ service, authorize }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/aeos/management`;
  try { await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('returns 422 with deterministic contract errors and a trace ID', async () => {
  const service = { async createDecision() { throw new AeosError('CONTRACT_VALIDATION_FAILED', 'Invalid decision contract', [{ path: 'contract_version' }], 422); } };
  await withServer(service, async base => {
    const response = await request(base, '/decisions', { method: 'POST', body: {} });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, 'CONTRACT_VALIDATION_FAILED');
    assert.match(response.body.trace_id, /^TRC-/);
  });
});

test('uses authenticated actor rather than a client supplied actor header', async () => {
  const service = { async createDecision(payload, context) { return { ...payload, actor_id: context.actorId, _created: true }; } };
  await withServer(service, async base => {
    const response = await request(base, '/decisions', { method: 'POST', headers: { 'x-actor-id': '999' }, body: validDecision });
    assert.equal(response.status, 201);
    assert.equal(response.body.data.actor_id, '7');
  });
});

test('maps first creation to 201 and duplicate idempotency to 200', async () => {
  let created = false;
  const service = { async createAction() { const record = { ...validAction }; Object.defineProperty(record, '_created', { value: !created }); created = true; return record; } };
  await withServer(service, async base => {
    const first = await request(base, '/actions', { method: 'POST', body: validAction });
    const second = await request(base, '/actions', { method: 'POST', body: validAction });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
  });
});

test('does not expose stack traces for unknown errors', async () => {
  const service = { async getClosure() { throw new Error('database path /secret'); } };
  await withServer(service, async base => {
    const response = await request(base, '/closures/DEC-001');
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(response.body).includes('/secret'), false);
  });
});

test('returns a traceable 403 when permission policy denies access', async () => {
  const service = { async getClosure() { throw new Error('must not run'); } };
  const deny = () => (req, res) => res.status(403).json({ error: { code: 'PERMISSION_DENIED' }, trace_id: req.aeosContext.traceId });
  await withServer(service, async base => {
    const response = await request(base, '/closures/DEC-001');
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'PERMISSION_DENIED');
    assert.match(response.body.trace_id, /^TRC-/);
  }, deny);
});
