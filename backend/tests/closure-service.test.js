const test = require('node:test');
const assert = require('node:assert/strict');
const { createClosureService } = require('../aeos/closure-service');
const { createClosureRepository } = require('../aeos/closure-repository');
const { validDecision, validAction, validResult, validEvidence } = require('./fixtures/valid-contracts');

function memoryRepository() {
  const data = { decision: [], action: [], result: [], evidence: [], journal: [] };
  return {
    data,
    async findById(type, id) { return data[type].find(record => record.id === id) || null; },
    async findByIdempotencyKey(type, key) { return data[type].find(record => record.idempotency_key === key) || null; },
    async insert(type, record) { data[type].push(structuredClone(record)); return structuredClone(record); },
    async update(type, id, fields) {
      const record = data[type].find(item => item.id === id);
      if (!record) return null;
      Object.assign(record, structuredClone(fields));
      return structuredClone(record);
    },
    async delete(type, id) {
      const index = data[type].findIndex(item => item.id === id);
      if (index >= 0) data[type].splice(index, 1);
    },
    async beginOperation(operation) { data.journal.push({ ...operation, status: 'PENDING' }); return operation.id; },
    async commitOperation(id) { data.journal.find(item => item.id === id).status = 'COMMITTED'; },
    async failOperation(id, message) { const item = data.journal.find(entry => entry.id === id); item.status = 'FAILED'; item.error = message; },
    async getClosure(decisionId) {
      const decision = await this.findById('decision', decisionId);
      const actions = data.action.filter(item => item.decision_id === decisionId);
      const results = data.result.filter(item => actions.some(action => action.id === item.object_id));
      const evidence = data.evidence.filter(item => results.some(result => result.evidence_ids.includes(item.id)));
      return { decision, actions, results, evidence };
    }
  };
}

const context = { traceId: 'TRC-test', actorId: '7', sourceSystem: 'M03', occurredAt: '2026-09-23T00:00:00.000Z' };

test('JSON repository preserves the AEOS contract ID when the table assigns a numeric row ID', async () => {
  const rows = [];
  const table = {
    all: () => rows,
    async insert(record) { record.id = 1; rows.push(record); return { lastID: 1 }; },
    async update() { return { changes: 1 }; }
  };
  const repository = createClosureRepository({ tableProvider: () => table });
  await repository.insert('decision', validDecision);
  const stored = await repository.findById('decision', validDecision.id);
  assert.equal(stored.id, validDecision.id);
  assert.equal(Object.hasOwn(stored, 'aeos_id'), false);
  assert.deepEqual(require('../aeos/contract-validator').validateContract('decision', stored), { valid: true, errors: [] });
});

test('returns the first action for a duplicate idempotency key', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  const first = await service.createAction(validAction, context);
  const second = await service.createAction(validAction, context);
  assert.equal(second.id, first.id);
  assert.equal(repository.data.action.length, 1);
});

test('keeps a result without evidence UNVERIFIED', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  const result = await service.completeAction(validAction.id, validResult, context);
  assert.equal(result.status, 'UNVERIFIED');
});

test('rejects evidence for an unknown result', async () => {
  const service = createClosureService({ repository: memoryRepository() });
  await assert.rejects(
    () => service.attachEvidence('RES-missing', { ...validEvidence, object_id: 'RES-missing' }, context),
    error => error.code === 'RESULT_NOT_FOUND'
  );
});

test('does not persist an invalid decision', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await assert.rejects(() => service.createDecision({}, context));
  assert.equal(repository.data.decision.length, 0);
});

test('requires evidence before explicit result verification', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  const result = await service.completeAction(validAction.id, validResult, context);
  await assert.rejects(() => service.verifyResult(result.id, context), error => error.code === 'EVIDENCE_REQUIRED');
  await service.attachEvidence(result.id, validEvidence, context);
  const verified = await service.verifyResult(result.id, context);
  assert.equal(verified.status, 'VERIFIED');
});

test('returns a fully linked management closure', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  await service.completeAction(validAction.id, validResult, context);
  await service.attachEvidence(validResult.id, validEvidence, context);
  await service.verifyResult(validResult.id, context);
  const closure = await service.getClosure(validDecision.id);
  assert.equal(closure.decision.id, validDecision.id);
  assert.equal(closure.actions.length, 1);
  assert.equal(closure.results.length, 1);
  assert.equal(closure.evidence.length, 1);
});

test('never accepts VERIFIED completion without verified relationships', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  await assert.rejects(
    () => service.completeAction(validAction.id, { ...validResult, object_id: validAction.id, status: 'VERIFIED', evidence_ids: ['EVD-missing'] }, context),
    error => error.code === 'RESULT_MUST_START_UNVERIFIED'
  );
  assert.equal(repository.data.result.length, 0);
});

test('rejects missing and conflicting relationship fields before writes', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  const missing = { ...validResult };
  delete missing.object_id;
  await assert.rejects(() => service.completeAction(validAction.id, missing, context), error => error.code === 'CONTRACT_VALIDATION_FAILED');
  await assert.rejects(() => service.completeAction(validAction.id, { ...validResult, object_id: 'ACT-other' }, context), error => error.code === 'RELATIONSHIP_MISMATCH');
  assert.equal(repository.data.result.length, 0);
});

test('serializes concurrent duplicate decisions', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  const [first, second] = await Promise.all([
    service.createDecision(validDecision, context),
    service.createDecision(validDecision, context)
  ]);
  assert.equal(first.id, second.id);
  assert.equal(repository.data.decision.length, 1);
});

test('preserves both concurrent evidence links', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  await service.completeAction(validAction.id, { ...validResult, object_id: validAction.id }, context);
  const secondEvidence = { ...validEvidence, id: 'EVD-002', idempotency_key: 'M02-evidence-002', object_id: validResult.id, sha256: 'b'.repeat(64) };
  await Promise.all([
    service.attachEvidence(validResult.id, validEvidence, context),
    service.attachEvidence(validResult.id, secondEvidence, context)
  ]);
  const stored = await repository.findById('result', validResult.id);
  assert.deepEqual(new Set(stored.evidence_ids), new Set(['EVD-001', 'EVD-002']));
});

test('rejects contract ID reuse with another idempotency key', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await assert.rejects(
    () => service.createDecision({ ...validDecision, idempotency_key: 'different-key' }, context),
    error => error.code === 'CONTRACT_ID_CONFLICT'
  );
  assert.equal(repository.data.decision.length, 1);
});

test('conflicting result replay does not complete another action', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  const otherAction = { ...validAction, id: 'ACT-002', object_id: validDecision.id, idempotency_key: 'action-002' };
  await service.createAction(otherAction, context);
  await service.completeAction(validAction.id, { ...validResult, object_id: validAction.id }, context);
  await assert.rejects(
    () => service.completeAction(otherAction.id, { ...validResult, object_id: otherAction.id }, context),
    error => error.code === 'IDEMPOTENCY_CONFLICT'
  );
  assert.equal((await repository.findById('action', otherAction.id)).status, 'OPEN');
});

test('exact evidence retry is side-effect-free after verification', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  await service.completeAction(validAction.id, { ...validResult, object_id: validAction.id }, context);
  await service.attachEvidence(validResult.id, validEvidence, context);
  await service.verifyResult(validResult.id, context);
  await service.attachEvidence(validResult.id, validEvidence, context);
  assert.equal((await repository.findById('result', validResult.id)).status, 'VERIFIED');
});

test('rejects verification when linked evidence is REJECTED', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  await service.completeAction(validAction.id, { ...validResult, object_id: validAction.id }, context);
  await service.attachEvidence(validResult.id, { ...validEvidence, status: 'REJECTED' }, context);
  await assert.rejects(() => service.verifyResult(validResult.id, context), error => error.code === 'EVIDENCE_NOT_ELIGIBLE');
});

test('rolls back a newly inserted result when action update fails', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  const originalUpdate = repository.update;
  repository.update = async (type, id, fields) => {
    if (type === 'action') throw new Error('disk failure');
    return originalUpdate.call(repository, type, id, fields);
  };
  await assert.rejects(() => service.completeAction(validAction.id, { ...validResult, object_id: validAction.id }, context), /disk failure/);
  assert.equal(repository.data.result.length, 0);
  assert.equal(repository.data.action[0].status, 'OPEN');
  assert.equal(repository.data.journal.at(-1).status, 'FAILED');
});

test('commits a recoverable operation journal for multi-record completion', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  await service.completeAction(validAction.id, { ...validResult, object_id: validAction.id }, context);
  const operation = repository.data.journal.find(item => item.type === 'COMPLETE_ACTION');
  assert.equal(operation.status, 'COMMITTED');
  assert.equal(operation.parent_id, validAction.id);
});

test('action creation replay remains idempotent after server-side completion status change', async () => {
  const repository = memoryRepository();
  const service = createClosureService({ repository });
  await service.createDecision(validDecision, context);
  await service.createAction(validAction, context);
  await service.completeAction(validAction.id, { ...validResult, object_id: validAction.id }, context);
  const replay = await service.createAction(validAction, context);
  assert.equal(replay.id, validAction.id);
  assert.equal(replay.status, 'COMPLETED');
  assert.equal(repository.data.action.length, 1);
});
