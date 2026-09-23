const common = {
  source_system: 'M03',
  source_object: 'ManagementItem',
  object_id: 'OBJ-001',
  occurred_at: '2026-09-23T00:00:00.000Z',
  period: { start: '2026-09-01', end: '2026-09-30' },
  idempotency_key: 'M03-demo-001'
};

const validDecision = {
  ...common,
  contract_version: 'AEOS.Decision.V1',
  id: 'DEC-001',
  status: 'APPROVED',
  summary: 'Correct the delivery exception',
  owner_id: 'USER-001',
  decision_at: '2026-09-23T00:00:00.000Z'
};

const validResult = {
  ...common,
  contract_version: 'AEOS.Result.V1',
  id: 'RES-001',
  object_id: 'ACT-001',
  status: 'UNVERIFIED',
  metric: { name: 'on_time_delivery', value: 95, unit: 'percent' },
  calculation_version: 'DELIVERY-OTD-V1',
  evidence_ids: []
};

const validAction = {
  ...common,
  contract_version: 'AEOS.Action.V1',
  id: 'ACT-001',
  object_id: 'DEC-001',
  status: 'OPEN',
  idempotency_key: 'M03-action-001',
  decision_id: 'DEC-001',
  owner_id: 'USER-002',
  due_at: '2026-09-30T00:00:00.000Z',
  acceptance_criteria: 'Exception is closed with evidence'
};

const validEvidence = {
  ...common,
  contract_version: 'AEOS.Evidence.V1',
  id: 'EVD-001',
  object_id: 'RES-001',
  status: 'CAPTURED',
  idempotency_key: 'M02-evidence-001',
  uri: 'evidence://delivery/demo',
  sha256: '83736e503f6ddd9d693a3be7c6078f02c594d383f218ab0f20bc335404d3c2b8',
  captured_at: '2026-09-23T00:00:00.000Z'
};

module.exports = { common, validDecision, validAction, validResult, validEvidence };
