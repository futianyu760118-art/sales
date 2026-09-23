const test = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('../aeos/context');
const { newId, stableIdempotencyKey } = require('../aeos/id');

test('uses the authenticated actor and ignores client actor headers', () => {
  const req = { user: { id: 7, username: 'owner' }, headers: { 'x-actor-id': '999', 'x-trace-id': 'TRACE-client' } };
  const context = createContext(req);
  assert.equal(context.actorId, '7');
  assert.equal(context.traceId, 'TRACE-client');
  assert.equal(context.sourceSystem, 'M03');
});

test('replaces an unsafe trace header', () => {
  const context = createContext({ user: { id: 7 }, headers: { 'x-trace-id': 'bad\ntrace' } });
  assert.match(context.traceId, /^TRC-[0-9a-f-]+$/);
});

test('creates deterministic idempotency keys', () => {
  const first = stableIdempotencyKey(['M03', 'decision', '42']);
  const second = stableIdempotencyKey(['M03', 'decision', '42']);
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('creates prefixed unique IDs', () => {
  const first = newId('DEC');
  const second = newId('DEC');
  assert.match(first, /^DEC-[0-9a-f-]+$/);
  assert.notEqual(first, second);
});
