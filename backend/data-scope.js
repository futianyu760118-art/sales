// 数据权限隔离（最小可用存根）
// 统一返回 { enabled, ids } 形状，避免路由层 scopeLegacy.enabled 在 null 上崩溃。
// 当识别到非管理员且绑定了阿米巴责任单元时，按责任单元 id 做软过滤；否则不隔离。
const _allAmibaIds = (orgs) => (orgs || []).map(o => o.id);

// 返回 { enabled: boolean, ids: number[] }，永不返回 null
function resolveDataScope(req, opts) {
  const empty = { enabled: false, ids: [] };
  const userId = (req && (req.body?.user_id || req.query?.user_id || req.headers?.['x-user-id'])) || null;
  if (!userId) return empty; // 无识别用户 → 不做隔离
  try {
    const { getUserPermissions } = require('./auth-middleware');
    const { isAdmin } = getUserPermissions(userId);
    if (isAdmin) return empty;
  } catch (_) { return empty; }
  // 非管理员：尝试按巴长/部门关联过滤；无绑定则不隔离
  try {
    const { getTable } = require('./db');
    const orgs = getTable('amiba_org').all().filter(o => o.status !== '停用');
    const mine = orgs
      .filter(o => Number(o.charge_user_id) === Number(userId) || Number(o.charge_personnel_id) === Number(userId))
      .map(o => Number(o.id))
      .filter(id => Number.isFinite(id));
    return { enabled: mine.length > 0, ids: mine };
  } catch (_) { return empty; }
}

// 兼容两种调用方式：
//   isInScope(scope, id)                              —— 旧式：id 直接是数字
//   isInScope(scope, record, { ownerField })          —— 新式：按 record[ownerField] 取值匹配
// scope 可为：null / undefined / { enabled, ids } / number[]
function isInScope(scope, recordOrId, opts) {
  if (!scope || (scope.enabled === false)) return true;
  let ids;
  if (Array.isArray(scope)) ids = scope;
  else if (Array.isArray(scope.ids)) ids = scope.ids;
  else return true;
  if (!ids.length) return true;

  if (opts && typeof opts === 'object' && recordOrId && typeof recordOrId === 'object') {
    const ownerField = opts.ownerField || 'owner';
    const v = Number(recordOrId[ownerField]);
    return Number.isFinite(v) && ids.includes(v);
  }
  const v = Number(recordOrId);
  return Number.isFinite(v) && ids.includes(v);
}

function filterByOwner(scope, records, fromKey, toKey) {
  if (!scope || (scope.enabled === false)) return records || [];
  let ids;
  if (Array.isArray(scope)) ids = scope;
  else if (Array.isArray(scope.ids)) ids = scope.ids;
  else return records || [];
  if (!ids.length) return records || [];
  return (records || []).filter(r => {
    const f = fromKey ? Number(r[fromKey]) : 0;
    const t = toKey ? Number(r[toKey]) : 0;
    return ids.includes(f) || ids.includes(t);
  });
}

module.exports = { resolveDataScope, isInScope, filterByOwner };
