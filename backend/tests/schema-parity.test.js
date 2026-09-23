const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CONTRACTS } = require('../aeos/contract-definitions');

for (const [type, definition] of Object.entries(CONTRACTS)) {
  test(type + ' published schema matches executable definition', () => {
    const schemaPath = path.join(__dirname, '..', '..', 'contracts', type, 'v1.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.equal(schema.properties.contract_version.const, definition.version);
    assert.deepEqual(new Set(schema.required), new Set(definition.required));
    assert.deepEqual(new Set(Object.keys(schema.properties)), new Set(Object.keys(definition.fields)));
    assert.deepEqual(new Set(schema.properties.status.enum), new Set(definition.statuses));
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.period.additionalProperties, false);
    for (const [field, fieldType] of Object.entries(definition.fields)) {
      if (fieldType === 'string' && schema.properties[field].const === undefined && schema.properties[field].enum === undefined) {
        assert.equal(schema.properties[field].minLength, 1, field + ' must reject empty strings');
      }
    }
  });
}
