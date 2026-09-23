const test = require('node:test');
const assert = require('node:assert/strict');
const { validateContract } = require('../aeos/contract-validator');
const { validDecision, validResult } = require('./fixtures/valid-contracts');

test('accepts a complete AEOS.Decision.V1', () => {
  assert.deepEqual(validateContract('decision', validDecision), { valid: true, errors: [] });
});

test('rejects missing contract_version with a deterministic error', () => {
  const payload = { ...validDecision };
  delete payload.contract_version;
  const result = validateContract('decision', payload);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors[0], {
    code: 'REQUIRED_FIELD',
    path: 'contract_version',
    message: 'contract_version is required'
  });
});

test('rejects an unsupported contract version', () => {
  const result = validateContract('result', { ...validResult, contract_version: 'AEOS.Result.V2' });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'UNSUPPORTED_VERSION');
});

test('rejects unknown top-level fields', () => {
  const result = validateContract('decision', { ...validDecision, invented: true });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'UNKNOWN_FIELD');
});

test('rejects malformed timestamps and reversed periods', () => {
  const result = validateContract('decision', {
    ...validDecision,
    occurred_at: 'yesterday',
    period: { start: '2026-10-01', end: '2026-09-01' }
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'INVALID_TIMESTAMP'));
  assert.ok(result.errors.some(error => error.code === 'INVALID_PERIOD'));
});

test('rejects non-ISO timestamps, impossible dates and unknown period fields', () => {
  const result = validateContract('decision', {
    ...validDecision,
    occurred_at: '09/23/2026',
    period: { start: '2026-02-30', end: '2026-03-01', timezone: 'UTC' }
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.code === 'INVALID_TIMESTAMP'));
  assert.ok(result.errors.some(error => error.code === 'INVALID_PERIOD'));
});

test('rejects non-string evidence IDs', () => {
  const result = validateContract('result', { ...validResult, evidence_ids: [123] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.path === 'evidence_ids.0'));
});
