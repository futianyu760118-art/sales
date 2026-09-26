'use strict';

const { query } = require('../../db/pool');

async function findById(id) {
  const { rows } = await query(
    `SELECT id, metric_id, parent_id, name, direction, contribution_pct, owner, order_no
       FROM result_reasons
      WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * 原因项清单（导航用）。完整的归因穿透与贡献占比由 F2（PAND-80）交付，
 * 此处仅为进入 F3 证据页提供只读锚点。
 */
async function listAll() {
  const { rows } = await query(
    `SELECT r.id, r.name, r.direction, r.contribution_pct, r.owner, r.order_no,
            count(re.evidence_id)::int AS evidence_count
       FROM result_reasons r
       LEFT JOIN reason_evidences re ON re.reason_id = r.id
      GROUP BY r.id
      ORDER BY r.order_no, r.created_at`
  );
  return rows;
}

module.exports = { findById, listAll };
