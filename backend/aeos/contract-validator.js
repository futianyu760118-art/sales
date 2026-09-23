const { CONTRACTS } = require('./contract-definitions');

const error = (code, path, message) => ({ code, path, message });
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const isTimestamp = value => {
  if (!isNonEmptyString(value) || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};
const isDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

function validateTypedField(type, path, value) {
  if (type === 'string' && !isNonEmptyString(value)) return error('INVALID_TYPE', path, path + ' must be a non-empty string');
  if (type === 'timestamp' && !isTimestamp(value)) return error('INVALID_TIMESTAMP', path, path + ' must be an ISO timestamp');
  if (type === 'array' && !Array.isArray(value)) return error('INVALID_TYPE', path, path + ' must be an array');
  if (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return error('INVALID_TYPE', path, path + ' must be an object');
  if (type === 'sha256' && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) return error('INVALID_SHA256', path, path + ' must be 64 lowercase hexadecimal characters');
  if (type === 'period') {
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
    if (!value || typeof value !== 'object' || Array.isArray(value) || keys.length !== 2 || !keys.includes('start') || !keys.includes('end') || !isDate(value.start) || !isDate(value.end) || value.start > value.end) {
      return error('INVALID_PERIOD', path, path + ' must contain ordered YYYY-MM-DD start and end dates');
    }
  }
  return null;
}

function validateContract(type, payload) {
  const definition = CONTRACTS[type];
  if (!definition) return { valid: false, errors: [error('UNKNOWN_CONTRACT_TYPE', 'type', 'unsupported contract type')] };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: [error('INVALID_PAYLOAD', '', 'payload must be an object')] };
  }

  const errors = [];
  for (const field of definition.required) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      errors.push(error('REQUIRED_FIELD', field, field + ' is required'));
    }
  }
  if (payload.contract_version !== undefined && payload.contract_version !== definition.version) {
    errors.push(error('UNSUPPORTED_VERSION', 'contract_version', 'expected ' + definition.version));
  }
  for (const field of Object.keys(payload)) {
    if (!Object.hasOwn(definition.fields, field)) errors.push(error('UNKNOWN_FIELD', field, field + ' is not allowed'));
  }
  for (const [field, fieldType] of Object.entries(definition.fields)) {
    if (payload[field] === undefined || payload[field] === null) continue;
    const fieldError = validateTypedField(fieldType, field, payload[field]);
    if (fieldError) errors.push(fieldError);
    if (field === 'evidence_ids' && Array.isArray(payload[field])) {
      payload[field].forEach((value, index) => {
        if (!isNonEmptyString(value)) errors.push(error('INVALID_TYPE', field + '.' + index, field + ' items must be non-empty strings'));
      });
    }
  }
  if (payload.status !== undefined && !definition.statuses.includes(payload.status)) {
    errors.push(error('INVALID_STATUS', 'status', 'status is not allowed for ' + type));
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validateContract };
