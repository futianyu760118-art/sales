const COMMON_REQUIRED = [
  'contract_version', 'id', 'source_system', 'source_object', 'object_id',
  'occurred_at', 'period', 'status', 'idempotency_key'
];

const commonFields = {
  contract_version: 'string', id: 'string', source_system: 'string',
  source_object: 'string', object_id: 'string', occurred_at: 'timestamp',
  period: 'period', status: 'string', idempotency_key: 'string'
};

const make = (version, fields = {}, required = [], statuses = ['ACTIVE']) => Object.freeze({
  version,
  fields: Object.freeze({ ...commonFields, ...fields }),
  required: Object.freeze([...COMMON_REQUIRED, ...required]),
  statuses: Object.freeze(statuses)
});

const CONTRACTS = Object.freeze({
  object: make('AEOS.Object.V1', { attributes: 'object' }, ['attributes'], ['ACTIVE', 'INACTIVE']),
  api: make('AEOS.API.V1', { operation: 'string', endpoint: 'string' }, ['operation', 'endpoint'], ['ACTIVE', 'DEPRECATED']),
  event: make('AEOS.Event.V1', { event_type: 'string', payload: 'object' }, ['event_type', 'payload'], ['OCCURRED', 'PROCESSED', 'REJECTED']),
  result: make('AEOS.Result.V1', { metric: 'object', calculation_version: 'string', evidence_ids: 'array' }, ['metric', 'calculation_version', 'evidence_ids'], ['UNVERIFIED', 'VERIFIED', 'REJECTED']),
  exception: make('AEOS.Exception.V1', { severity: 'string', summary: 'string' }, ['severity', 'summary'], ['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
  decision: make('AEOS.Decision.V1', { summary: 'string', owner_id: 'string', decision_at: 'timestamp' }, ['summary', 'owner_id', 'decision_at'], ['PROPOSED', 'APPROVED', 'REJECTED']),
  action: make('AEOS.Action.V1', { decision_id: 'string', owner_id: 'string', due_at: 'timestamp', acceptance_criteria: 'string' }, ['decision_id', 'owner_id', 'due_at', 'acceptance_criteria'], ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'FAILED']),
  evidence: make('AEOS.Evidence.V1', { uri: 'string', sha256: 'sha256', captured_at: 'timestamp' }, ['uri', 'sha256', 'captured_at'], ['CAPTURED', 'VERIFIED', 'REJECTED'])
});

const STATUSES = Object.freeze(Object.fromEntries(Object.entries(CONTRACTS).map(([type, definition]) => [type, definition.statuses])));
const requiredFields = type => CONTRACTS[type] ? [...CONTRACTS[type].required] : [];

module.exports = { COMMON_REQUIRED, CONTRACTS, STATUSES, requiredFields };
