'use strict';

/**
 * Evidence 视图（PAND-88 / F10）纯规则：检索维度、枚举、分页、归一化。
 * 与 HTTP/存储解耦，便于按 AC 逐条做单元验证。
 */

// 契约版本：AEOS 统一契约族的 Evidence 成员
const CONTRACT_VERSION = 'AEOS.Evidence.V1';

// 证据类型枚举：业务方 2026-09-23 确认的最终口径（单据/合同/系统记录/人工说明）
const EVIDENCE_TYPES = Object.freeze(['单据', '合同', '系统记录', '人工说明']);

// 单页条数：默认 20 条，可配置；白名单外取值回退默认，超过上限收敛
const DEFAULT_PAGE_SIZE = 20;
const ALLOWED_PAGE_SIZES = Object.freeze([10, 20, 50, 100, 200]);
const MAX_PAGE_SIZE = 200;

const ALLOWED_SORT_FIELDS = Object.freeze([
  'id', 'evidence_code', 'title', 'evidence_type', 'occurred_at',
  'owner_name', 'source_system', 'source_data_time', 'created_at'
]);

// 契约字段单独处理，其余为领域字段
const CONTRACT_FIELDS = Object.freeze(['source_system', 'object_type', 'object_id', 'trace_id']);
const STR_FIELDS = Object.freeze([
  'evidence_code', 'title', 'evidence_type', 'content', 'occurred_at',
  'owner_id', 'owner_name', 'source_data_time', 'provider', 'status'
]);

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

// 单页条数解析：未传/非法回退默认 20；超上限收敛到 MAX_PAGE_SIZE
function parsePageSize(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PAGE_SIZE;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

function parsePage(raw) {
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? 1 : n;
}

// 关联结果/关联原因：接受数组或逗号/顿号分隔字符串，统一为去空字符串数组
function toCodeList(v) {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,，、]/);
  return arr.map(x => str(x)).filter(Boolean);
}

// 检索条件：AC 场景 1 的四个维度 + 跨结果/原因 + 关键字
function buildFilter(q) {
  const query = q || {};
  const dateFrom = str(query.date_from);
  const dateTo = str(query.date_to);
  const dataTimeFrom = str(query.data_time_from);
  const dataTimeTo = str(query.data_time_to);
  const evidenceType = str(query.evidence_type);
  const owner = str(query.owner);
  const sourceSystem = str(query.source_system);
  const resultCode = str(query.result_code);
  const reasonCode = str(query.reason_code);
  const keyword = str(query.keyword).toLowerCase();

  return (r) => {
    if (!r) return false;
    // 维度 1：时间范围（形成时间）
    if (dateFrom && str(r.occurred_at) < dateFrom) return false;
    if (dateTo && str(r.occurred_at) > dateTo) return false;
    // 维度 1b：来源数据时间范围
    if (dataTimeFrom && str(r.source_data_time) < dataTimeFrom) return false;
    if (dataTimeTo && str(r.source_data_time) > dataTimeTo) return false;
    // 维度 2：证据类型（精确匹配已确认枚举）
    if (evidenceType && r.evidence_type !== evidenceType) return false;
    // 维度 3：责任人（owner_name 或 owner_id 精确匹配）
    if (owner && str(r.owner_name) !== owner && str(r.owner_id) !== owner) return false;
    // 维度 4：来源系统
    if (sourceSystem && str(r.source_system) !== sourceSystem) return false;
    // 跨结果 / 跨原因检索：不依赖结果-原因上下文即可独立检索
    if (resultCode && toCodeList(r.result_codes).indexOf(resultCode) === -1) return false;
    if (reasonCode && toCodeList(r.reason_codes).indexOf(reasonCode) === -1) return false;
    if (keyword) {
      const hay = [
        r.evidence_code, r.title, r.content, r.object_id,
        r.provider, r.owner_name, r.source_system
      ].join(' ').toLowerCase();
      if (hay.indexOf(keyword) === -1) return false;
    }
    return true;
  };
}

/**
 * 记录归一化：契约字段 + 领域字段裁剪、枚举校验。
 * @returns {{record: object} | {error: string}}
 */
function normalizeEvidence(body, existing) {
  const input = body || {};
  const base = existing || {};
  const record = { contract_version: CONTRACT_VERSION, evidence_ids: [] };

  CONTRACT_FIELDS.forEach(k => {
    record[k] = input[k] !== undefined ? str(input[k]) : str(base[k]);
  });
  STR_FIELDS.forEach(k => {
    record[k] = input[k] !== undefined ? str(input[k]) : str(base[k]);
  });

  if (!record.evidence_type) {
    return { error: '证据类型必填，取值范围：' + EVIDENCE_TYPES.join('、') };
  }
  if (EVIDENCE_TYPES.indexOf(record.evidence_type) === -1) {
    return { error: '证据类型不在已确认枚举内：' + record.evidence_type + '（允许值：' + EVIDENCE_TYPES.join('、') + '）' };
  }
  if (!record.title) return { error: '证据标题必填' };
  if (!record.occurred_at) return { error: '形成时间必填' };

  record.result_codes = input.result_codes !== undefined ? toCodeList(input.result_codes) : toCodeList(base.result_codes);
  record.reason_codes = input.reason_codes !== undefined ? toCodeList(input.reason_codes) : toCodeList(base.reason_codes);
  if (!record.status) record.status = 'VERIFIED';
  return { record };
}

// 证据编码：EVD + 年月 + 4 位流水号（按同前缀已有编码递增）
function genEvidenceCode(records, periodYYYYMM) {
  const ym = str(periodYYYYMM).replace('-', '');
  const prefix = 'EVD' + ym;
  let maxSeq = 0;
  (records || []).forEach(r => {
    const code = str(r && r.evidence_code);
    if (code.startsWith(prefix + '-')) {
      const seq = parseInt(code.substring(prefix.length + 1), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return prefix + '-' + String(maxSeq + 1).padStart(4, '0');
}

// 分页切片：AC 场景 3「结果可分页，单页条数可配置（默认 20）」
function paginate(records, page, limit) {
  const list = records || [];
  const p = parsePage(page);
  const l = parsePageSize(limit);
  const pages = Math.max(1, Math.ceil(list.length / l));
  const start = (p - 1) * l;
  return { items: list.slice(start, start + l), total: list.length, page: p, limit: l, pages };
}

module.exports = {
  CONTRACT_VERSION,
  EVIDENCE_TYPES,
  DEFAULT_PAGE_SIZE,
  ALLOWED_PAGE_SIZES,
  MAX_PAGE_SIZE,
  ALLOWED_SORT_FIELDS,
  str,
  parsePageSize,
  parsePage,
  toCodeList,
  buildFilter,
  normalizeEvidence,
  genEvidenceCode,
  paginate
};
