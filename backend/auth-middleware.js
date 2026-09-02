/**
 * 权限校验中间件
 * 检查请求发起者是否有指定权限码
 *
 * 使用方式：
 *   const { requirePerm } = require('../auth-middleware');
 *   router.post('/', requirePerm('supplier:create'), (req, res) => { ... });
 *
 * 用户识别优先级：
 *   1. Authorization: Bearer <token>（登录签发，服务端校验，不可伪造）——优先
 *   2. 兼容旧客户端：req.body.user_id / req.query.user_id / x-user / x-user-id
 *
 * 未携带任何有效身份时，不再放行（此前无 userId 直接 next()，导致未认证即可访问全部接口）。
 */
const { getTable } = require('./db');
const { verifyToken } = require('./lib/auth-token');

/**
 * 合并组织模块权限到运行时权限集合
 * 将 org_position_perms（岗位默认权限）、org_position_roles（岗位角色）、
 * org_personnel_perms（人员个性化 grant/deny）合并到 permIds 中。
 * @param {number} userId - 系统用户 ID
 * @param {Set<number>} permIds - 已有的权限 ID 集合（会被原地修改）
 * @returns {Set<number>} 合并后的权限 ID 集合
 */
function mergeOrgPermissions(userId, permIds) {
  if (!userId) return permIds;
  try {
    const personnelTable = getTable('org_personnel');
    const posPermsTable = getTable('org_position_perms');
    const posRolesTable = getTable('org_position_roles');
    const perPermsTable = getTable('org_personnel_perms');
    const rpTable = getTable('role_permissions');
    const roleTable = getTable('roles');
    const permTable = getTable('permissions');
    [personnelTable, posPermsTable, posRolesTable, perPermsTable, rpTable, roleTable, permTable]
      .forEach(t => { try { t._invalidate(); } catch(e) {} });

    // 通过 linked_user_id 找到对应的组织人员
    const person = personnelTable.all().find(p => Number(p.linked_user_id) === Number(userId));
    if (!person) return permIds;

    const orgRoleIds = new Set();
    // 1. 岗位默认权限 + 岗位角色
    if (person.position_id) {
      posPermsTable.all().filter(pp => pp.position_id === person.position_id)
        .forEach(pp => permIds.add(pp.permission_id));
      posRolesTable.all().filter(pr => pr.position_id === person.position_id)
        .forEach(pr => orgRoleIds.add(pr.role_id));
    }
    // 2. 角色展开（admin 拥有全部权限）
    orgRoleIds.forEach(rid => {
      const role = roleTable.findById(rid);
      if (role && role.code === 'admin') {
        permTable.all().forEach(p => permIds.add(p.id));
      }
    });
    orgRoleIds.forEach(rid => {
      rpTable.all().filter(rp => rp.role_id === rid).forEach(rp => permIds.add(rp.permission_id));
    });
    // 3. 人员个性化调整（在角色展开之后，确保 deny 能覆盖角色权限）
    perPermsTable.all().filter(pp => pp.personnel_id === person.id).forEach(o => {
      if (o.type === 'grant') permIds.add(o.permission_id);
      else if (o.type === 'deny') permIds.delete(o.permission_id);
    });
  } catch (e) {
    // 组织模块表可能未初始化，静默忽略
  }
  return permIds;
}

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
  // 合并组织模块权限（岗位默认 + 岗位角色 + 人员个性化 grant/deny）
  mergeOrgPermissions(user.id, permIds);
  const perms = new Set();
  permIds.forEach(pid => {
    const p = permTable.findById(pid);
    if (p) perms.add(p.code);
  });
  return { isAdmin: false, perms };
}

function extractUserId(req) {
  // 1. 优先：Authorization: Bearer <token>（登录签发，服务端校验，不可伪造）
  const authz = req.headers['authorization'] || '';
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const payload = verifyToken(m[1].trim());
    if (payload && payload.uid !== undefined && payload.uid !== null) {
      return Number(payload.uid);
    }
  }
  // 2. 兼容旧客户端：仍信任自报身份（迁移期保留；前端全量带上 token 后可移除）
  return req.body.user_id || req.body.userId ||
         req.query.user_id || req.query.userId ||
         req.headers['x-user'] || req.headers['x-user-id'];
}

function requirePerm(code) {
  return (req, res, next) => {
    const userId = extractUserId(req);

    // 未携带有效身份 → 401（不再放行，堵住未认证访问漏洞）
    if (!userId) {
      return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
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

    // 未携带有效身份 → 401（不再放行，堵住未认证访问漏洞）
    if (!userId) {
      return res.status(401).json({ error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
    }

    const { isAdmin, perms } = getUserPermissions(userId);

    if (isAdmin) return next();
    if (perms && codes.some(c => perms.has(c))) return next();

    return res.status(403).json({ error: `无权限，需要以下权限之一：${codes.join(', ')}`, code: 'PERMISSION_DENIED' });
  };
}

module.exports = { requirePerm, requireAnyPerm, getUserPermissions, extractUserId, mergeOrgPermissions };
