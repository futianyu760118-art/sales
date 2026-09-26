'use strict';

const { query } = require('../../db/pool');
const {
  VIEW_OBJECT_TYPES,
  isValidViewObjectType,
  landingHref,
} = require('./view-object-types');
const { labelOf: evidenceTypeLabel } = require('../evidence/evidence-types');

// 表名只来自本文件内的白名单（非用户输入），不存在注入面。
// 每个类型显式列出锚点列：交叉跳转只需要「能列出、能解析落点」的身份字段。
const SELECTS = Object.freeze({
  report: `SELECT id, code, title, conclusion AS subtitle, owner, period_type, period_value, domain FROM reports`,
  todo: `SELECT id, code, title, status AS subtitle, owner, source, due_at FROM todos`,
  decision: `SELECT id, code, title, conclusion AS subtitle, status, decider FROM decisions`,
  evidence: `SELECT id, type, title, owner AS subtitle, formed_at FROM evidences`,
});

// 列表与详情的统一排序：最新在前（evidence 以形成时间，其余以创建时间）。
const ORDERS = Object.freeze({
  report: 'ORDER BY created_at DESC, code ASC',
  todo: 'ORDER BY created_at DESC, code ASC',
  decision: 'ORDER BY created_at DESC, code ASC',
  evidence: 'ORDER BY formed_at DESC NULLS LAST, created_at DESC',
});

/** 把一行锚点记录归一化为交叉跳转统一对象形状。 */
function toViewObject(typeCode, row) {
  if (!row) return null;
  const type = VIEW_OBJECT_TYPES[typeCode];
  const badge =
    typeCode === 'evidence' ? evidenceTypeLabel(row.type) || row.type : type.label;
  return {
    type: typeCode,
    typeLabel: type.label,
    id: row.id,
    // evidence 无业务编码，用证据类型中文口径替代展示位
    code: row.code || null,
    badge,
    title: row.title,
    subtitle: row.subtitle || null,
    owner: row.owner || null,
    // 跳转落点：前端据此路由到对应视图页并渲染该对象
    landingHref: landingHref(typeCode, row.id),
  };
}

async function listByType(typeCode, { limit = 50 } = {}) {
  if (!isValidViewObjectType(typeCode)) return null;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await query(
    `${SELECTS[typeCode]} ${ORDERS[typeCode]} LIMIT $1`,
    [safeLimit]
  );
  return rows.map((row) => toViewObject(typeCode, row));
}

async function findByTypeAndId(typeCode, id) {
  if (!isValidViewObjectType(typeCode)) return null;
  const { rows } = await query(`${SELECTS[typeCode]} WHERE id = $1`, [id]);
  return toViewObject(typeCode, rows[0]);
}

/** 批量解析：交叉跳转的落点对象清单（按 id 集合取回身份信息）。 */
async function findByTypeAndIds(typeCode, ids) {
  if (!isValidViewObjectType(typeCode) || ids.length === 0) return [];
  const { rows } = await query(`${SELECTS[typeCode]} WHERE id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(rows.map((row) => [row.id, toViewObject(typeCode, row)]));
  // 保持传入顺序，且丢弃已被删除的对象（避免产生指向空对象的「落点」）
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

module.exports = { listByType, findByTypeAndId, findByTypeAndIds, toViewObject };
