const { newId } = require('./id');

const SAFE_TRACE = /^[A-Za-z0-9._:-]{1,128}$/;

function createContext(req = {}) {
  const headers = req.headers || {};
  const suppliedTrace = headers['x-trace-id'];
  const traceId = typeof suppliedTrace === 'string' && SAFE_TRACE.test(suppliedTrace)
    ? suppliedTrace
    : newId('TRC');
  const actor = req.user || {};
  return {
    traceId,
    actorId: actor.id === undefined || actor.id === null ? 'anonymous' : String(actor.id),
    sourceSystem: 'M03',
    occurredAt: new Date().toISOString()
  };
}

module.exports = { createContext };
