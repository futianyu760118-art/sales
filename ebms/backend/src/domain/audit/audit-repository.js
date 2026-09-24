'use strict';

const { query } = require('../../db/pool');

/**
 * 通用留痕写入。与业务写入同事务时传入 client，保证「操作生效」与「留痕」原子。
 */
async function record(client, { actor, actorName, action, entityType, entityId, reasonId = null, before = null, after = null }) {
  const runner = client || { query };
  const { rows } = await runner.query(
    `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id, reason_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, actor, actor_name, action, entity_type, entity_id, reason_id, at`,
    [actor, actorName, action, entityType, entityId, reasonId, before, after]
  );
  return rows[0];
}

/** 按原因项读取留痕，用于证据列表页展示操作记录。 */
async function listByReason(reasonId, { limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT id, actor, actor_name, action, entity_type, entity_id, reason_id,
            before, after, at
       FROM audit_log
      WHERE reason_id = $1
      ORDER BY at DESC, id DESC
      LIMIT $2`,
    [reasonId, limit]
  );
  return rows;
}

/** 按实体读取留痕（时间正序），用于回读某次操作产生的完整留痕。 */
async function listByEntity(entityType, entityId) {
  const { rows } = await query(
    `SELECT id, actor, actor_name, action, entity_type, entity_id, reason_id,
            before, after, at
       FROM audit_log
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY at, id`,
    [entityType, entityId]
  );
  return rows;
}

module.exports = { record, listByReason, listByEntity };
