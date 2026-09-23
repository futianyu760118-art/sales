const { getTable } = require('../db');
const { getRegistration } = require('./cross-domain-registry');

class LegacyReadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function createLegacyAdapter({ tableProvider = getTable, clock = () => new Date().toISOString() } = {}) {
  function readLegacy(dataset, options = {}, context = {}) {
    const registration = getRegistration(dataset, options.consumer || 'M03');
    if (!registration) throw new LegacyReadError('UNREGISTERED_CROSS_DOMAIN_READ', 'Cross-domain read is not registered: ' + dataset);
    const fields = options.fields || registration.allowedFields;
    const forbidden = fields.filter(field => !registration.allowedFields.includes(field));
    if (forbidden.length) throw new LegacyReadError('FIELD_NOT_ALLOWED', 'Fields are not allowed: ' + forbidden.join(', '));
    const records = tableProvider(dataset).all().map(source => {
      const record = {};
      for (const field of fields) record[field] = source[field] === undefined || source[field] === null ? 'unknown' : source[field];
      record.evidence_ids = Array.isArray(source.evidence_ids) ? [...source.evidence_ids] : [];
      return record;
    });
    return {
      records,
      provenance: {
        sourceModule: registration.sourceModule,
        dataset,
        contractVersion: registration.contractVersion,
        purpose: registration.purpose,
        owner: registration.owner,
        deprecationCondition: registration.deprecationCondition,
        readAt: clock(),
        traceId: context.traceId || 'unknown',
        authoritative: registration.authoritative
      }
    };
  }
  return { readLegacy };
}

const defaultAdapter = createLegacyAdapter();
module.exports = { createLegacyAdapter, readLegacy: defaultAdapter.readLegacy, LegacyReadError };
