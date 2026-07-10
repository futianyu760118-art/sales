/**
 * 权限校验中间件
 * 检查请求发起者是否有指定权限码
 * 
 * 使用方式：
 *   const { requirePerm } = require('../auth-middleware');
 *   router.post('/', requirePerm('supplier:create'), (req, res) => { ... });
 *
 * 用户识别优先级：
 *   1. req.body.user_id / req.body.userId
 *   2. req.query.user_id / req.query.userId
 *   3. req.headers['x-user'] / req.headers['x-user-id']
 */
const { getTable } = require('./db');

function getUserPermissions(userId) {
  if (!userId) return { isAdmin: false, perms: new Set() };

  const userTable = getTable('users');
  userTable._invalidate();
  const user = userTable.findById(Number(userId));
  if (!user) {
    const byName = userTable.all().find(u => String(u.username) === String(userId));
    if (!byName) return { isAdmin: false, perms: new Set() };
    return getUserPermissions(byName.id);
  }

  if (user.role === 'admin') return { isAdmin: true, perms: null };

  const urTable = getTable('user_roles');
  const rpTable = getTable('role_permissions');
  const permTable = getTable('permissions');
  const roleTable = getTable('roles');
  urTable._invalidate();
  rpTable._invalidate();
  permTable._invalidate();
  roleTable._invalidate();

  const roleIdSet = new Set(
    urTable.all().filter(ur => ur.user_id === user.id).map(ur => ur.role_id)
  );
  if (user.role) {
    const directRole = roleTable.all().find(r => r.code === user.role);
    if (directRole) roleIdSet.add(directRole.id);
  }
  const userRoleIds = [...roleIdSet];

  const hasAdminRole = userRoleIds.some(rid => {
    const role = roleTable.findById(rid);
    return role && role.code === 'admin';
  });
  if (hasAdminRole) return { isAdmin: true, perms: null };

  const permIds = new Set();
  userRoleIds.forEach(rid => {
    rpTable.all().filter(rp => rp.role_id === rid).forEach(rp => permIds.add(rp.permission_id));
  });
  const perms = new Set();
  permIds.forEach(pid => {
    const p = permTable.findById(pid);
    if (p) perms.add(p.code);
  });
  return { isAdmin: false, perms };
}

function extractUserId(req) {
  return req.body.user_id || req.body.userId ||
         req.query.user_id || req.query.userId ||
         req.headers['x-user'] || req.headers['x-user-id'];
}

function requirePerm(code) {
  return (req, res, next) => {
    const userId = extractUserId(req);

    if (!userId) {
      return next();
    }

    const { isAdmin, perms } = getUserPermissions(userId);

    if (isAdmin) return next();
    if (perms && perms.has(code)) return next();

    return res.status(403).json({ error: `无权限：${code}`, code: 'PERMISSION_DENIED' });
  };
}

function requireAnyPerm(...codes) {
  return (req, res, next) => {
    const userId = extractUserId(req);

    if (!userId) {
      return next();
    }

    const { isAdmin, perms } = getUserPermissions(userId);

    if (isAdmin) return next();
    if (perms && codes.some(c => perms.has(c))) return next();

    return res.status(403).json({ error: `无权限，需要以下权限之一：${codes.join(', ')}`, code: 'PERMISSION_DENIED' });
  };
}

module.exports = { requirePerm, requireAnyPerm, getUserPermissions, extractUserId };
