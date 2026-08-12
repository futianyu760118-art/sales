// 数据权限 v2
// 统一返回 { enabled, mode, ids } 形状，避免路由层 scope.enabled 在 null 上崩溃。
const dataScope = require('./data-scope');

// 表 → 可能承载权限范围的字段候选（buildScopeFilter 在 scope.enabled 时使用）
const TABLE_FIELDS = {
  inquiries:  ['amiba_id', 'from_amiba_id', 'to_amiba_id', 'department_id', 'sales_person_id', 'owner_id'],
  orders:     ['amiba_id', 'from_amiba_id', 'to_amiba_id', 'department_id', 'sales_person_id', 'owner_id'],
  customers:  ['amiba_id', 'from_amiba_id', 'to_amiba_id', 'department_id', 'sales_person_id', 'owner_id'],
  projects:   ['amiba_id', 'from_amiba_id', 'to_amiba_id', 'department_id', 'owner_id'],
  samples:    ['amiba_id', 'from_amiba_id', 'to_amiba_id', 'department_id', 'owner_id']
};

// 返回标准化 scope 对象，永不返回 null
function resolveDataScopeV2(req, opts) {
  const legacy = dataScope.resolveDataScope(req, opts);
  if (legacy && Array.isArray(legacy.ids) && legacy.ids.length) {
    return { enabled: true, mode: 'custom', ids: legacy.ids.slice() };
  }
  return { enabled: false, mode: 'none', ids: [] };
}

// buildScopeFilter(scope, table) -> (record) => boolean
function buildScopeFilter(scope, table) {
  if (!scope || !scope.enabled || !Array.isArray(scope.ids) || !scope.ids.length) {
    return () => true;
  }
  const ids = scope.ids;
  const fields = (typeof table === 'string' && TABLE_FIELDS[table]) || TABLE_FIELDS.inquiries;
  return (record) => {
    if (!record) return false;
    for (const f of fields) {
      const v = Number(record[f]);
      if (Number.isFinite(v) && ids.includes(v)) return true;
    }
    return false;
  };
}

function combineFilter(...filters) {
  return (record) => filters.every(fn => { try { return !!fn(record); } catch (_) { return true; } });
}

function logDataPermission(req, action, ok) {
  // 静默（生产可改写日志）
}

module.exports = { resolveDataScopeV2, buildScopeFilter, combineFilter, logDataPermission };
