const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyAdapter } = require('../aeos/legacy-adapter');

const context = { traceId: 'TRC-test' };

function tableProvider(name) {
  const records = name === 'orders' ? [{ id: 1, order_no: 'SO-001' }] : [];
  return { all: () => records };
}

test('rejects unregistered cross-domain reads', () => {
  const { readLegacy } = createLegacyAdapter({ tableProvider });
  assert.throws(
    () => readLegacy('secret_table', {}, context),
    error => error.code === 'UNREGISTERED_CROSS_DOMAIN_READ'
  );
});

test('returns provenance and unknown for absent allowed fields', () => {
  const { readLegacy } = createLegacyAdapter({ tableProvider });
  const result = readLegacy('orders', { fields: ['id', 'gross_margin'] }, context);
  assert.equal(result.provenance.sourceModule, 'M05');
  assert.equal(result.provenance.authoritative, false);
  assert.equal(result.records[0].gross_margin, 'unknown');
  assert.deepEqual(result.records[0].evidence_ids, []);
});

test('does not expose fields outside the allowlist', () => {
  const { readLegacy } = createLegacyAdapter({ tableProvider });
  assert.throws(
    () => readLegacy('orders', { fields: ['password'] }, context),
    error => error.code === 'FIELD_NOT_ALLOWED'
  );
});

test('finance legacy data is explicitly non-authoritative', () => {
  const { readLegacy } = createLegacyAdapter({ tableProvider });
  const result = readLegacy('material_costs', { fields: ['id', 'amount'] }, context);
  assert.equal(result.provenance.sourceModule, 'M09');
  assert.equal(result.provenance.authoritative, false);
  assert.match(result.provenance.purpose, /comparison/i);
});
