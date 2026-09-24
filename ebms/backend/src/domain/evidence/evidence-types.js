'use strict';

// 证据类型预定义枚举 —— 业务方 2026-09-23 确认的最终口径，仅限四类。
// 该映射与数据库 evidence_type 枚举、evidence_type_dict 表保持一致。
const EVIDENCE_TYPES = Object.freeze({
  document: '单据',
  contract: '合同',
  system_record: '系统记录',
  manual_note: '人工说明',
});

const EVIDENCE_TYPE_CODES = Object.freeze(Object.keys(EVIDENCE_TYPES));

function isValidEvidenceType(code) {
  return Object.prototype.hasOwnProperty.call(EVIDENCE_TYPES, code);
}

function labelOf(code) {
  return EVIDENCE_TYPES[code] || null;
}

/** 供接口返回的枚举清单（前端下拉、测试判定均取自此）。 */
function listEvidenceTypes() {
  return EVIDENCE_TYPE_CODES.map((code) => ({ code, label: EVIDENCE_TYPES[code] }));
}

module.exports = { EVIDENCE_TYPES, EVIDENCE_TYPE_CODES, isValidEvidenceType, labelOf, listEvidenceTypes };
