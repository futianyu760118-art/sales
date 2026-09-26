/**
 * 留痕仓储（只读视图）。
 *
 * 反向链路为只读：本仓储不暴露任何写方法，反向查询链路因此无法产生留痕。
 * 自检用 countAll()/listRecent() 取证「反向查询前后 audit_log 无新增」。
 */

export function createAuditRepository(db) {
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);

  return {
    countAll() {
      return one('SELECT COUNT(*) AS n FROM audit_log').n;
    },

    listRecent(limit = 20) {
      return all(
        'SELECT id, actor, action, entity_type, entity_id, at FROM audit_log ORDER BY id DESC LIMIT ?',
        limit,
      );
    },

    maxId() {
      return one('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').n;
    },
  };
}
