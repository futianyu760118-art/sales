'use strict';

const { query } = require('../../db/pool');

// object_links 一行 = 一条「关联」，双向可达。因此取「另一端」时按对象所在侧择反：
// 唯一约束已保证不会出现自关联，故 CASE 分支不会歧义。
const OTHER_END = `
  CASE WHEN from_type = $1 AND from_id = $2 THEN to_type ELSE from_type END AS other_type,
  CASE WHEN from_type = $1 AND from_id = $2 THEN to_id   ELSE from_id END AS other_id
`;

const NEIGHBOR_WHERE = 'WHERE (from_type = $1 AND from_id = $2) OR (to_type = $1 AND to_id = $2)';

/**
 * 规范化配对键：取 "<type>:<id>" 字典序的小/大两端。
 * 同一对对象无论从哪端建立，得到的 (pair_a, pair_b) 唯一 → 关联幂等 + 双向可达。
 */
function canonicalPair(fromType, fromId, toType, toId) {
  const ends = [`${fromType}:${fromId}`, `${toType}:${toId}`].sort();
  return { pairA: ends[0], pairB: ends[1] };
}

/** 某对象关联到的全部「另一端」对象（不含已删除对象，由上层解析时过滤）。 */
async function listNeighbors(objectType, objectId) {
  const { rows } = await query(
    `SELECT ${OTHER_END}, relation_type, created_by, created_at
       FROM object_links
       ${NEIGHBOR_WHERE}
      ORDER BY created_at DESC, id DESC`,
    [objectType, objectId]
  );
  return rows.map((r) => ({
    otherType: r.other_type,
    otherId: r.other_id,
    relationType: r.relation_type,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/** 某对象关联到的指定类型对象（交叉跳转入口的数据源）。 */
async function listNeighborsByType(objectType, objectId, targetType) {
  const { rows } = await query(
    `SELECT ${OTHER_END}, relation_type, created_by, created_at
       FROM object_links
       ${NEIGHBOR_WHERE}
        AND (CASE WHEN from_type = $1 AND from_id = $2 THEN to_type ELSE from_type END) = $3
      ORDER BY created_at DESC, id DESC`,
    [objectType, objectId, targetType]
  );
  return rows.map((r) => ({
    otherType: r.other_type,
    otherId: r.other_id,
    relationType: r.relation_type,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/**
 * 建立关联（幂等）。同一对对象无论方向只保留一行：
 * 命中唯一索引即 DO NOTHING，再回读既有行，重复调用不产生第二条记录。
 * 返回 { link, created }，created=false 表示本次为幂等命中。
 */
async function insert(client, { fromType, fromId, toType, toId, relationType, createdBy }) {
  const { pairA, pairB } = canonicalPair(fromType, fromId, toType, toId);
  const inserted = await client.query(
    `INSERT INTO object_links (from_type, from_id, to_type, to_id, pair_a, pair_b, relation_type, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (pair_a, pair_b) DO NOTHING
     RETURNING id, from_type, from_id, to_type, to_id, relation_type, created_by, created_at`,
    [fromType, fromId, toType, toId, pairA, pairB, relationType, createdBy]
  );
  if (inserted.rows.length > 0) return { link: inserted.rows[0], created: true };

  const existing = await client.query(
    `SELECT id, from_type, from_id, to_type, to_id, relation_type, created_by, created_at
       FROM object_links
      WHERE (from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4)
         OR (from_type = $3 AND from_id = $4 AND to_type = $1 AND to_id = $2)`,
    [fromType, fromId, toType, toId]
  );
  return { link: existing.rows[0] || null, created: false };
}

/** 解除关联。按规范化配对删除，与建立时传入的方向无关。 */
async function remove(client, { fromType, fromId, toType, toId }) {
  const { rows } = await client.query(
    `DELETE FROM object_links
      WHERE (from_type = $1 AND from_id = $2 AND to_type = $3 AND to_id = $4)
         OR (from_type = $3 AND from_id = $4 AND to_type = $1 AND to_id = $2)
      RETURNING id, from_type, from_id, to_type, to_id, relation_type`,
    [fromType, fromId, toType, toId]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await query('SELECT * FROM object_links WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = { listNeighbors, listNeighborsByType, insert, remove, findById, canonicalPair };
