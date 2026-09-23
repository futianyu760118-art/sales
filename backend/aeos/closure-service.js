const { validateContract } = require('./contract-validator');
const { createClosureRepository } = require('./closure-repository');
const { isDeepStrictEqual } = require('node:util');
const { newId } = require('./id');

class AeosError extends Error {
  constructor(code, message, details = [], httpStatus = 400) {
    super(message);
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function assertValid(type, payload) {
  const validation = validateContract(type, payload);
  if (!validation.valid) throw new AeosError('CONTRACT_VALIDATION_FAILED', 'Invalid ' + type + ' contract', validation.errors, 422);
}

function decorated(record, created) {
  const copy = { ...record };
  Object.defineProperty(copy, '_created', { value: created, enumerable: false });
  return copy;
}

function publicContract(record) {
  return Object.fromEntries(Object.entries(record || {}).filter(([key]) => key !== 'aeos_id' && !key.startsWith('_')));
}

function comparableContract(type, record) {
  const copy = publicContract(record);
  if (type === 'action') delete copy.status;
  if (type === 'result') { delete copy.status; delete copy.evidence_ids; }
  return copy;
}

function createClosureService({ repository = createClosureRepository() } = {}) {
  let mutationTail = Promise.resolve();
  function withMutation(operation) {
    const run = mutationTail.then(operation, operation);
    mutationTail = run.catch(() => undefined);
    return run;
  }

  async function createUnsafe(type, payload, context) {
    assertValid(type, payload);
    const duplicate = await repository.findByIdempotencyKey(type, payload.idempotency_key);
    if (duplicate) {
      if (!isDeepStrictEqual(comparableContract(type, duplicate), comparableContract(type, payload))) {
        throw new AeosError('IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to another payload', [], 409);
      }
      return decorated(duplicate, false);
    }
    const sameId = await repository.findById(type, payload.id);
    if (sameId) throw new AeosError('CONTRACT_ID_CONFLICT', 'Contract ID already exists', [], 409);
    return decorated(await repository.insert(type, payload, context), true);
  }

  async function withJournal(type, parentId, context, operation) {
    const entry = {
      id: newId('OP'), type, parent_id: parentId,
      trace_id: context && context.traceId ? context.traceId : 'unknown',
      actor_id: context && context.actorId ? context.actorId : 'unknown',
      started_at: new Date().toISOString()
    };
    if (repository.beginOperation) await repository.beginOperation(entry);
    try {
      const result = await operation();
      if (repository.commitOperation) await repository.commitOperation(entry.id);
      return result;
    } catch (error) {
      if (repository.failOperation) await repository.failOperation(entry.id, error.message);
      throw error;
    }
  }

  return {
    async createDecision(payload, context) {
      assertValid('decision', payload);
      return withMutation(() => createUnsafe('decision', payload, context));
    },
    async createAction(payload, context) {
      assertValid('action', payload);
      return withMutation(async () => {
        if (!await repository.findById('decision', payload.decision_id)) {
          throw new AeosError('DECISION_NOT_FOUND', 'Decision does not exist', [], 404);
        }
        return createUnsafe('action', payload, context);
      });
    },
    async completeAction(actionId, payload, context) {
      assertValid('result', payload);
      if (payload.object_id !== actionId) throw new AeosError('RELATIONSHIP_MISMATCH', 'Result object_id must equal action ID', [], 409);
      if (payload.status !== 'UNVERIFIED' || payload.evidence_ids.length !== 0) {
        throw new AeosError('RESULT_MUST_START_UNVERIFIED', 'Completed action result must start UNVERIFIED without evidence', [], 409);
      }
      return withMutation(async () => {
        return withJournal('COMPLETE_ACTION', actionId, context, async () => {
          const action = await repository.findById('action', actionId);
          if (!action) throw new AeosError('ACTION_NOT_FOUND', 'Action does not exist', [], 404);
          const result = await createUnsafe('result', payload, context);
          if (!result._created) return result;
          try {
            await repository.update('action', actionId, { status: 'COMPLETED' });
          } catch (error) {
            if (repository.delete) await repository.delete('result', result.id);
            throw error;
          }
          return result;
        });
      });
    },
    async attachEvidence(resultId, payload, context) {
      assertValid('evidence', payload);
      if (payload.object_id !== resultId) throw new AeosError('RELATIONSHIP_MISMATCH', 'Evidence object_id must equal result ID', [], 409);
      return withMutation(async () => {
        return withJournal('ATTACH_EVIDENCE', resultId, context, async () => {
          const result = await repository.findById('result', resultId);
          if (!result) throw new AeosError('RESULT_NOT_FOUND', 'Result does not exist', [], 404);
          const evidence = await createUnsafe('evidence', payload, context);
          if (!evidence._created) return evidence;
          const evidenceIds = [...new Set([...(result.evidence_ids || []), evidence.id])];
          try {
            await repository.update('result', resultId, { evidence_ids: evidenceIds, status: 'UNVERIFIED' });
          } catch (error) {
            if (repository.delete) await repository.delete('evidence', evidence.id);
            throw error;
          }
          return evidence;
        });
      });
    },
    async verifyResult(resultId) {
      return withMutation(async () => {
        const result = await repository.findById('result', resultId);
        if (!result) throw new AeosError('RESULT_NOT_FOUND', 'Result does not exist', [], 404);
        if (!Array.isArray(result.evidence_ids) || result.evidence_ids.length === 0) {
          throw new AeosError('EVIDENCE_REQUIRED', 'Result requires evidence before verification', [], 409);
        }
        for (const evidenceId of result.evidence_ids) {
          const evidence = await repository.findById('evidence', evidenceId);
          if (!evidence) throw new AeosError('EVIDENCE_NOT_FOUND', 'Linked evidence does not exist', [{ evidence_id: evidenceId }], 409);
          if (evidence.object_id !== resultId || !['CAPTURED', 'VERIFIED'].includes(evidence.status)) {
            throw new AeosError('EVIDENCE_NOT_ELIGIBLE', 'Linked evidence is rejected or belongs to another result', [{ evidence_id: evidenceId }], 409);
          }
        }
        return repository.update('result', resultId, { status: 'VERIFIED' });
      });
    },
    async getClosure(decisionId) {
      const closure = await repository.getClosure(decisionId);
      if (!closure.decision) throw new AeosError('DECISION_NOT_FOUND', 'Decision does not exist', [], 404);
      return closure;
    }
  };
}

module.exports = { createClosureService, AeosError };
