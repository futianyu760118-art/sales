// 数据范围消费层（原「最小可用存根」）。
//
// 归属变更（PAND-93 红线）：角色 / 权限 / **数据范围一律归 M01 Kernel**。
// 本模块不再自行推导数据范围（此前按 amiba_org.charge_user_id 本地推导），
// 改为只读消费 M01 Kernel 的 data-scope；Kernel 不可用时**不回落到本地配置**，
// 而是按最小可见（fail-closed）处理。
//
// 统一返回 { enabled, ids } 形状，避免路由层 scope.enabled 在 null 上崩溃。
const kernelClient = require('./lib/kernel-client');

/**
 * 解析请求发起者的数据范围。
 * @returns {{enabled:boolean, ids:number[], source:string, scope_type:string,
 *            domain_keys:string[], kernel_available:boolean, degraded?:boolean}}
 */
function resolveDataScope(req, opts) {
  const deny = () => ({
    enabled: true, ids: [], source: 'M01_KERNEL', scope_type: 'none',
    domain_keys: [], kernel_available: false, degraded: true
  });

  // 身份优先取服务端签发的 token；仅在无 token 时兼容旧的客户端自报字段
  let userId = null;
  try {
    const { extractUserId } = require('./auth-middleware');
    userId = extractUserId(req);
  } catch (_) { /* 忽略 */ }
  if (userId === undefined || userId === null) {
    userId = (req && (req.body?.user_id || req.query?.user_id || req.headers?.['x-user-id'])) || null;
  }
  if (!userId) return { enabled: false, ids: [], source: 'M01_KERNEL', scope_type: 'all', domain_keys: [], kernel_available: true };

  let scope;
  try {
    scope = kernelClient.resolveDataScope(userId);
  } catch (_) {
    // M01 Kernel 不可用：不回落本地配置，按最小可见处理
    return deny();
  }

  const ids = Array.isArray(scope.resource_ids) ? scope.resource_ids.filter(Number.isFinite) : [];
  const base = {
    source: 'M01_KERNEL',
    scope_type: scope.scope_type,
    domain_keys: scope.domain_keys || [],
    kernel_available: true
  };
  if (scope.scope_type === 'all') return { enabled: false, ids: [], ...base };
  if (!ids.length) {
    // 无可见范围，或责任域口径但 Kernel 尚未绑定到部门级资源：
    // 只能按最小可见处理。此处不得返回 enabled:false —— 那在 isInScope / filterByOwner
    // 与 data-scope-v2 的 buildScopeFilter 中一律表示「不限制」，会变成 fail-open。
    return { enabled: true, ids: [], deny_all: true, ...base };
  }
  return { enabled: true, ids, ...base };
}

// 兼容两种调用方式：
//   isInScope(scope, id)                              —— 旧式：id 直接是数字
//   isInScope(scope, record, { ownerField })          —— 新式：按 record[ownerField] 取值匹配
// scope 可为：null / undefined / { enabled, ids } / number[]
function isInScope(scope, recordOrId, opts) {
  if (!scope) return true;
  if (scope.degraded || scope.deny_all) return false; // Kernel 不可用 / 无可见范围 → 最小可见
  if (scope.enabled === false) return true;
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
  if (!scope) return records || [];
  if (scope.degraded || scope.deny_all) return [];
  if (scope.enabled === false) return records || [];
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
