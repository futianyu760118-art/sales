const { getTable } = require('../db');

const TABLES = Object.freeze({
  decision: 'aeos_decisions',
  action: 'aeos_actions',
  result: 'aeos_results',
  evidence: 'aeos_evidence'
});

function createClosureRepository({ tableProvider = getTable } = {}) {
  const journalTable = () => tableProvider('aeos_operation_journal');
  const normalize = record => record && Object.fromEntries(
    Object.entries({ ...record, id: record.aeos_id || record.id })
      .filter(([key]) => key !== 'aeos_id' && !key.startsWith('_'))
  );
  const table = type => {
    if (!TABLES[type]) throw new Error('Unknown closure record type: ' + type);
    return tableProvider(TABLES[type]);
  };
  return {
    async findById(type, id) {
      const record = table(type).all().find(item => item.aeos_id === id || item.id === id);
      return normalize(record);
    },
    async findByIdempotencyKey(type, key) {
      const record = table(type).all().find(item => item.idempotency_key === key);
      return normalize(record);
    },
    async insert(type, record, context = {}) {
      const stored = {
        ...record,
        aeos_id: record.id,
        _audit: { actor_id: context.actorId || 'unknown', trace_id: context.traceId || 'unknown', recorded_at: context.occurredAt || new Date().toISOString() }
      };
      await table(type).insert(stored);
      return { ...record };
    },
    async update(type, id, fields) {
      const current = await this.findById(type, id);
      if (!current) return null;
      const stored = table(type).all().find(item => item.aeos_id === id || item.id === id);
      await table(type).update(stored.id, fields);
      return { ...current, ...fields };
    },
    async delete(type, id) {
      const stored = table(type).all().find(item => item.aeos_id === id || item.id === id);
      if (!stored) return false;
      await table(type).delete(stored.id);
      return true;
    },
    async beginOperation(operation) {
      await journalTable().insert({ ...operation, aeos_id: operation.id, status: 'PENDING' });
      return operation.id;
    },
    async commitOperation(id) {
      const stored = journalTable().all().find(item => item.aeos_id === id);
      if (stored) await journalTable().update(stored.id, { status: 'COMMITTED', finished_at: new Date().toISOString() });
    },
    async failOperation(id, message) {
      const stored = journalTable().all().find(item => item.aeos_id === id);
      if (stored) await journalTable().update(stored.id, { status: 'FAILED', error: String(message), finished_at: new Date().toISOString() });
    },
    async listPendingOperations() {
      return journalTable().all().filter(item => item.status === 'PENDING').map(normalize);
    },
    async getClosure(decisionId) {
      const decision = await this.findById('decision', decisionId);
      const actions = table('action').all().filter(record => record.decision_id === decisionId).map(normalize);
      const actionIds = new Set(actions.map(record => record.id));
      const results = table('result').all().filter(record => actionIds.has(record.object_id)).map(normalize);
      const evidenceIds = new Set(results.flatMap(record => record.evidence_ids || []));
      const evidence = table('evidence').all().map(normalize).filter(record => evidenceIds.has(record.id));
      return { decision, actions, results, evidence };
    }
  };
}

module.exports = { createClosureRepository, TABLES };
