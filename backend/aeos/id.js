const crypto = require('crypto');

function newId(prefix) {
  return String(prefix).toUpperCase() + '-' + crypto.randomUUID();
}

function stableIdempotencyKey(parts) {
  const normalized = (Array.isArray(parts) ? parts : [parts]).map(value => String(value)).join('\u001f');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = { newId, stableIdempotencyKey };
