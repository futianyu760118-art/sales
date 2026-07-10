const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

// 确保表存在
['roles', 'permissions', 'role_permissions', 'user_roles'].forEach(name => ensureTable(name));

// ===== 角色管理 =====

// 获取角色列表
router.get('/roles', requirePerm('system:permission'), (req, res) => {
  const table = getTable('roles');
  const roles = table.all();
  // 为每个角色附加权限数量和用户数量
  const rpTable = getTable('role_permissions');
  const urTable = getTable('user_roles');
  const result = roles.map(r => ({
    ...r,
    permission_count: rpTable.all().filter(rp => rp.role_id === r.id).length,
    user_count: urTable.all().filter(ur => ur.role_id === r.id).length
  }));
  res.json({ data: result, total: result.length });
});

// 创建角色
router.post('/roles', requirePerm('system:permission'), (req, res) => {
  const { name, code, description } = req.body;
  if (!name || !code) return res.status(400).json({ error: '角色名称和编码为必填项' });
  const table = getTable('roles');
  const existing = table.all().find(r => r.code === code);
  if (existing) return res.status(400).json({ error: '角色编码已存在' });
  const result = table.insert({ name, code, description: description || '', created_at: now(), updated_at: now() });
  const created = table.findById(result.lastID);
  res.json({ message: '角色创建成功', data: created });
});

// 更新角色
router.put('/roles/:id', requirePerm('system:permission'), (req, res) => {
  const { name, code, description } = req.body;
  const table = getTable('roles');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '角色不存在' });
  if (code && code !== existing.code) {
    const dup = table.all().find(r => r.code === code && r.id !== Number(req.params.id));
    if (dup) return res.status(400).json({ error: '角色编码已存在' });
  }
  table.update(req.params.id, { ...(name && { name }), ...(code && { code }), ...(description !== undefined && { description }), updated_at: now() });
  res.json({ message: '角色更新成功', data: table.findById(req.params.id) });
});

// 删除角色
router.delete('/roles/:id', requirePerm('system:permission'), (req, res) => {
  const table = getTable('roles');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '角色不存在' });
  if (existing.code === 'admin') return res.status(403).json({ error: '系统管理员角色不可删除' });
  // 删除关联的角色权限和用户角色
  const rpTable = getTable('role_permissions');
  const urTable = getTable('user_roles');
  rpTable.all().filter(rp => rp.role_id === Number(req.params.id)).forEach(rp => rpTable.delete(rp.id));
  urTable.all().filter(ur => ur.role_id === Number(req.params.id)).forEach(ur => urTable.delete(ur.id));
  table.delete(req.params.id);
  // 清除缓存确保数据一致性
  table._invalidate();
  rpTable._invalidate();
  urTable._invalidate();
  res.json({ message: '角色删除成功' });
});

// ===== 权限管理 =====

// 获取权限列表（按模块分组）
router.get('/permissions', requirePerm('system:permission'), (req, res) => {
  const table = getTable('permissions');
  const permissions = table.all();
  // 按模块分组
  const grouped = {};
  permissions.forEach(p => {
    if (!grouped[p.module]) grouped[p.module] = [];
    grouped[p.module].push(p);
  });
  res.json({ data: permissions, grouped, total: permissions.length });
});

// 创建权限
router.post('/permissions', requirePerm('system:permission'), (req, res) => {
  const { name, code, module, description } = req.body;
  if (!name || !code || !module) return res.status(400).json({ error: '权限名称、编码和模块为必填项' });
  const table = getTable('permissions');
  const existing = table.all().find(p => p.code === code);
  if (existing) return res.status(400).json({ error: '权限编码已存在' });
  const result = table.insert({ name, code, module, description: description || '', created_at: now() });
  const created = table.findById(result.lastID);
  res.json({ message: '权限创建成功', data: created });
});

// 更新权限
router.put('/permissions/:id', requirePerm('system:permission'), (req, res) => {
  const { name, code, module, description } = req.body;
  const table = getTable('permissions');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '权限不存在' });
  if (code && code !== existing.code) {
    const dup = table.all().find(p => p.code === code && p.id !== Number(req.params.id));
    if (dup) return res.status(400).json({ error: '权限编码已存在' });
  }
  table.update(req.params.id, { ...(name && { name }), ...(code && { code }), ...(module && { module }), ...(description !== undefined && { description }) });
  res.json({ message: '权限更新成功', data: table.findById(req.params.id) });
});

// 删除权限
router.delete('/permissions/:id', requirePerm('system:permission'), (req, res) => {
  const table = getTable('permissions');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '权限不存在' });
  // 删除关联的角色权限
  const rpTable = getTable('role_permissions');
  rpTable.all().filter(rp => rp.permission_id === Number(req.params.id)).forEach(rp => rpTable.delete(rp.id));
  table.delete(req.params.id);
  // 清除缓存确保数据一致性
  table._invalidate();
  rpTable._invalidate();
  res.json({ message: '权限删除成功' });
});

// ===== 角色权限分配 =====

// 获取角色的权限列表
router.get('/roles/:id/permissions', requirePerm('system:permission'), (req, res) => {
  const rpTable = getTable('role_permissions');
  const permTable = getTable('permissions');
  const rps = rpTable.all().filter(rp => rp.role_id === Number(req.params.id));
  const permissions = rps.map(rp => {
    const perm = permTable.findById(rp.permission_id);
    return perm ? { ...perm, granted: true } : null;
  }).filter(Boolean);
  res.json({ data: permissions });
});

// 设置角色权限（全量替换）
router.put('/roles/:id/permissions', (req, res) => {
  const { permission_ids } = req.body;
  if (!Array.isArray(permission_ids)) return res.status(400).json({ error: 'permission_ids必须为数组' });
  const rpTable = getTable('role_permissions');
  // 删除旧权限
  rpTable.all().filter(rp => rp.role_id === Number(req.params.id)).forEach(rp => rpTable.delete(rp.id));
  // 添加新权限
  permission_ids.forEach(pid => {
    rpTable.insert({ role_id: Number(req.params.id), permission_id: Number(pid), granted_at: now() });
  });
  res.json({ message: '权限分配成功', assigned: permission_ids.length });
});

// 添加单个权限到角色
router.post('/roles/:id/permissions/single', (req, res) => {
  const permission_id = req.body.permission_id || req.query.permission_id;
  if (!permission_id) return res.status(400).json({ error: 'permission_id 为必填' });
  const rpTable = getTable('role_permissions');
  rpTable._invalidate();
  const existing = rpTable.all().find(rp => rp.role_id === Number(req.params.id) && rp.permission_id === Number(permission_id));
  if (existing) return res.json({ message: '权限已存在' });
  rpTable.insert({ role_id: Number(req.params.id), permission_id: Number(permission_id), granted_at: now() });
  rpTable._invalidate();
  res.json({ message: '权限添加成功' });
});

// 删除角色中的单个权限
router.delete('/roles/:id/permissions/single', (req, res) => {
  const permission_id = req.body.permission_id || req.query.permission_id;
  if (!permission_id) return res.status(400).json({ error: 'permission_id 为必填' });
  const rpTable = getTable('role_permissions');
  rpTable._invalidate();
  const existing = rpTable.all().find(rp => rp.role_id === Number(req.params.id) && rp.permission_id === Number(permission_id));
  if (!existing) return res.json({ message: '权限不存在，无需删除' });
  rpTable.delete(existing.id);
  rpTable._invalidate();
  res.json({ message: '权限删除成功' });
});

// ===== 用户角色绑定 =====

// 获取用户的角色列表
router.get('/users/:id/roles', requirePerm('system:user'), (req, res) => {
  const urTable = getTable('user_roles');
  const roleTable = getTable('roles');
  const urs = urTable.all().filter(ur => ur.user_id === Number(req.params.id));
  const roles = urs.map(ur => {
    const role = roleTable.findById(ur.role_id);
    return role ? { ...role, assigned_at: ur.assigned_at } : null;
  }).filter(Boolean);
  res.json({ data: roles });
});

// 设置用户角色（全量替换）
router.put('/users/:id/roles', requirePerm('system:user'), (req, res) => {
  const { role_ids } = req.body;
  if (!Array.isArray(role_ids)) return res.status(400).json({ error: 'role_ids必须为数组' });
  const urTable = getTable('user_roles');
  // 删除旧角色
  urTable.all().filter(ur => ur.user_id === Number(req.params.id)).forEach(ur => urTable.delete(ur.id));
  // 添加新角色
  role_ids.forEach(rid => {
    urTable.insert({ user_id: Number(req.params.id), role_id: Number(rid), assigned_at: now() });
  });
  res.json({ message: '角色分配成功', assigned: role_ids.length });
});

// ===== 权限检查 =====

// 检查用户是否拥有指定权限
// check is public, no auth required
router.get('/check', (req, res) => {
  const { user_id, permission_code } = req.query;
  if (!user_id || !permission_code) return res.status(400).json({ error: '缺少参数' });

  const userTable = getTable('users');
  const user = userTable.findById(Number(user_id));
  if (!user) return res.json({ has_permission: false, reason: '用户不存在' });

  // admin角色拥有所有权限
  if (user.role === 'admin') return res.json({ has_permission: true });

  const urTable = getTable('user_roles');
  const rpTable = getTable('role_permissions');
  const permTable = getTable('permissions');
  const roleTable = getTable('roles');

  // 查找用户的所有角色
  const userRoleIds = urTable.all().filter(ur => ur.user_id === Number(user_id)).map(ur => ur.role_id);

  // 检查是否有admin角色
  const hasAdminRole = userRoleIds.some(rid => {
    const role = roleTable.findById(rid);
    return role && role.code === 'admin';
  });
  if (hasAdminRole) return res.json({ has_permission: true });

  // 查找权限
  const permission = permTable.all().find(p => p.code === permission_code);
  if (!permission) return res.json({ has_permission: false, reason: '权限不存在' });

  // 检查用户角色是否拥有该权限
  const hasPermission = userRoleIds.some(rid => {
    return rpTable.all().some(rp => rp.role_id === rid && rp.permission_id === permission.id);
  });

  res.json({ has_permission: hasPermission });
});

// 获取用户的所有权限（合并所有角色的权限）
router.get('/users/:id/permissions', (req, res) => {
  const userTable = getTable('users');
  const user = userTable.findById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const urTable = getTable('user_roles');
  const rpTable = getTable('role_permissions');
  const permTable = getTable('permissions');
  const roleTable = getTable('roles');

  // admin用户拥有所有权限
  if (user.role === 'admin') {
    return res.json({ data: permTable.all(), is_admin: true });
  }

  const userRoleIds = urTable.all().filter(ur => ur.user_id === Number(req.params.id)).map(ur => ur.role_id);

  // 检查admin角色
  const hasAdminRole = userRoleIds.some(rid => {
    const role = roleTable.findById(rid);
    return role && role.code === 'admin';
  });
  if (hasAdminRole) return res.json({ data: permTable.all(), is_admin: true });

  // 收集所有权限ID
  const permIds = new Set();
  userRoleIds.forEach(rid => {
    rpTable.all().filter(rp => rp.role_id === rid).forEach(rp => permIds.add(rp.permission_id));
  });

  const permissions = [...permIds].map(pid => permTable.findById(pid)).filter(Boolean);
  res.json({ data: permissions, is_admin: false });
});

// ===== 用户管理 =====

// 获取用户列表
router.get('/users', requirePerm('system:user'), (req, res) => {
  const userTable = getTable('users');
  userTable._invalidate();
  const { keyword } = req.query;
  let users = userTable.all().map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, email: u.email, created_at: u.created_at }));
  if (keyword) {
    const kw = keyword.toLowerCase();
    users = users.filter(u => (u.name || '').toLowerCase().includes(kw) || (u.username || '').toLowerCase().includes(kw));
  }
  res.json({ data: users, total: users.length });
});

// 获取单个用户
router.get('/users/:id', requirePerm('system:user'), (req, res) => {
  const userTable = getTable('users');
  userTable._invalidate();
  const user = userTable.findById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role, email: user.email, created_at: user.created_at });
});

// 创建用户
router.post('/users', requirePerm('system:user'), (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: '用户名、密码和姓名为必填项' });
  const userTable = getTable('users');
  const existing = userTable.all().find(u => u.username === username);
  if (existing) return res.status(400).json({ error: '用户名已存在' });
  const result = userTable.insert({ username, password, name, role: role || 'viewer', created_at: now() });
  const created = userTable.findById(result.lastID);
  // 自动绑定默认角色
  if (role) {
    const roleTable = getTable('roles');
    const urTable = getTable('user_roles');
    const defaultRole = roleTable.all().find(r => r.code === role);
    if (defaultRole) {
      urTable.insert({ user_id: created.id, role_id: defaultRole.id, assigned_at: now() });
      urTable._invalidate();
    }
  }
  res.json({ message: '用户创建成功', data: created });
});

// 更新用户
router.put('/users/:id', requirePerm('system:user'), (req, res) => {
  const { username, password, name, role } = req.body;
  const userTable = getTable('users');
  const existing = userTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '用户不存在' });
  if (username && username !== existing.username) {
    const dup = userTable.all().find(u => u.username === username && u.id !== Number(req.params.id));
    if (dup) return res.status(400).json({ error: '用户名已存在' });
  }
  const updates = { updated_at: now() };
  if (username) updates.username = username;
  if (password) updates.password = password;
  if (name) updates.name = name;
  if (role) updates.role = role;
  userTable.update(req.params.id, updates);
  // 如果角色变更，同步更新用户角色关联
  if (role && role !== existing.role) {
    const roleTable = getTable('roles');
    const urTable = getTable('user_roles');
    const newRole = roleTable.all().find(r => r.code === role);
    if (newRole) {
      // 清除旧角色关联
      urTable.all().filter(ur => ur.user_id === Number(req.params.id)).forEach(ur => urTable.delete(ur.id));
      urTable.insert({ user_id: Number(req.params.id), role_id: newRole.id, assigned_at: now() });
      urTable._invalidate();
    }
  }
  res.json({ message: '用户更新成功', data: userTable.findById(req.params.id) });
});

// 删除用户
router.delete('/users/:id', requirePerm('system:user'), (req, res) => {
  const userTable = getTable('users');
  const existing = userTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '用户不存在' });
  if (existing.username === 'admin') return res.status(403).json({ error: '管理员账户不可删除' });
  // 删除关联的用户角色
  const urTable = getTable('user_roles');
  urTable.all().filter(ur => ur.user_id === Number(req.params.id)).forEach(ur => urTable.delete(ur.id));
  userTable.delete(req.params.id);
  userTable._invalidate();
  urTable._invalidate();
  res.json({ message: '用户删除成功' });
});

// ===== 权限迁移/补齐（全量） =====
// 补齐缺失的权限定义 + 自动分配角色权限
router.post('/migrate-permissions', requirePerm('system:permission'), (req, res) => {
  const roleTable = getTable('roles');
  const rpTable = getTable('role_permissions');
  const permTable = getTable('permissions');
  const now = () => new Date().toISOString().replace('T', ' ').split('.')[0];

  roleTable._invalidate();
  rpTable._invalidate();
  permTable._invalidate();

  // 完整的权限定义
  const allPermDefs = [
    // 询价管理
    { name: '查看询价', code: 'inquiry:view', module: '询价管理', description: '查看询价列表和详情' },
    { name: '创建询价', code: 'inquiry:create', module: '询价管理', description: '新建询价单' },
    { name: '编辑询价', code: 'inquiry:edit', module: '询价管理', description: '修改询价信息' },
    { name: '删除询价', code: 'inquiry:delete', module: '询价管理', description: '删除询价单' },
    { name: '核价报价', code: 'inquiry:price', module: '询价管理', description: '对询价单进行核价和报价' },
    { name: '变更状态', code: 'inquiry:status', module: '询价管理', description: '变更询价单状态' },
    { name: '批量导入', code: 'inquiry:import', module: '询价管理', description: '批量导入询价单' },
    { name: '批量导出', code: 'inquiry:export', module: '询价管理', description: '批量导出询价单' },
    // 产品管理
    { name: '查看产品', code: 'product:view', module: '产品管理', description: '查看产品列表和详情' },
    { name: '创建产品', code: 'product:create', module: '产品管理', description: '新增产品' },
    { name: '编辑产品', code: 'product:edit', module: '产品管理', description: '修改产品信息' },
    { name: '删除产品', code: 'product:delete', module: '产品管理', description: '删除产品' },
    // 客户管理
    { name: '查看客户', code: 'customer:view', module: '客户管理', description: '查看客户列表和详情' },
    { name: '创建客户', code: 'customer:create', module: '客户管理', description: '新增客户' },
    { name: '编辑客户', code: 'customer:edit', module: '客户管理', description: '修改客户信息' },
    { name: '删除客户', code: 'customer:delete', module: '客户管理', description: '删除客户' },
    // 物料管理
    { name: '查看物料', code: 'material:view', module: '物料管理', description: '查看物料BOM列表' },
    { name: '创建物料', code: 'material:create', module: '物料管理', description: '新增物料' },
    { name: '编辑物料', code: 'material:edit', module: '物料管理', description: '修改物料信息' },
    { name: '删除物料', code: 'material:delete', module: '物料管理', description: '删除物料' },
    { name: '图纸预览', code: 'drawing:preview', module: '物料管理', description: '预览图纸文件' },
    { name: '图纸审批', code: 'drawing:approve', module: '物料管理', description: '审批图纸文件' },
    { name: '图纸上传', code: 'drawing:upload', module: '物料管理', description: '上传图纸文件' },
    { name: '图纸删除', code: 'drawing:delete', module: '物料管理', description: '删除图纸文件' },
    // 核价管理
    { name: '查看核价', code: 'pricing:view', module: '核价管理', description: '查看核价表和详情' },
    { name: '创建核价', code: 'pricing:create', module: '核价管理', description: '新增核价记录' },
    { name: '编辑核价', code: 'pricing:edit', module: '核价管理', description: '修改核价信息' },
    { name: '删除核价', code: 'pricing:delete', module: '核价管理', description: '删除核价记录' },
    // 供应商管理
    { name: '查看供应商', code: 'supplier:view', module: '供应商管理', description: '查看供应商列表和详情' },
    { name: '创建供应商', code: 'supplier:create', module: '供应商管理', description: '新增供应商' },
    { name: '编辑供应商', code: 'supplier:edit', module: '供应商管理', description: '修改供应商信息' },
    { name: '删除供应商', code: 'supplier:delete', module: '供应商管理', description: '删除供应商' },
    // BOM管理
    { name: '查看BOM', code: 'bom:view', module: 'BOM管理', description: '查看BOM列表和详情' },
    { name: '创建BOM', code: 'bom:create', module: 'BOM管理', description: '新增BOM' },
    { name: '编辑BOM', code: 'bom:edit', module: 'BOM管理', description: '修改BOM信息' },
    { name: '删除BOM', code: 'bom:delete', module: 'BOM管理', description: '删除BOM' },
    // 订单管理
    { name: '查看订单', code: 'order:view', module: '订单管理', description: '查看订单列表和详情' },
    { name: '创建订单', code: 'order:create', module: '订单管理', description: '新增订单' },
    { name: '编辑订单', code: 'order:edit', module: '订单管理', description: '修改订单信息' },
    { name: '删除订单', code: 'order:delete', module: '订单管理', description: '删除订单' },
    // 样品管理
    { name: '查看样品', code: 'sample:view', module: '样品管理', description: '查看样品列表和详情' },
    { name: '创建样品', code: 'sample:create', module: '样品管理', description: '新增样品' },
    { name: '编辑样品', code: 'sample:edit', module: '样品管理', description: '修改样品信息' },
    { name: '删除样品', code: 'sample:delete', module: '样品管理', description: '删除样品' },
    // 项目管理
    { name: '查看项目', code: 'project:view', module: '项目管理', description: '查看项目列表和详情' },
    { name: '创建项目', code: 'project:create', module: '项目管理', description: '新增项目' },
    { name: '编辑项目', code: 'project:edit', module: '项目管理', description: '修改项目信息' },
    { name: '删除项目', code: 'project:delete', module: '项目管理', description: '删除项目' },
    // BOM对比
    { name: '查看BOM对比', code: 'bom-compare:view', module: 'BOM对比', description: '查看BOM对比分析' },
    // 报价库
    { name: '查看报价库', code: 'quote:view', module: '报价库', description: '查看报价库列表' },
    { name: '管理报价库', code: 'quote:manage', module: '报价库', description: '管理报价库（创建/编辑）' },
    { name: '删除报价库', code: 'quote:delete', module: '报价库', description: '删除报价库记录' },
    // 产品配置表
    { name: '查看配置表', code: 'config:view', module: '产品配置表', description: '查看配置表列表和详情' },
    { name: '创建配置表', code: 'config:create', module: '产品配置表', description: '新增配置表' },
    { name: '编辑配置表', code: 'config:edit', module: '产品配置表', description: '修改配置表' },
    { name: '删除配置表', code: 'config:delete', module: '产品配置表', description: '删除配置表' },
    // 规格书库
    { name: '查看规格书', code: 'spec:view', module: '规格书库', description: '查看规格书列表' },
    { name: '管理规格书', code: 'spec:manage', module: '规格书库', description: '管理规格书（创建/编辑）' },
    { name: '删除规格书', code: 'spec:delete', module: '规格书库', description: '删除规格书' },
    // 配置表库
    { name: '查看配置表库', code: 'config-lib:view', module: '配置表库', description: '查看配置表库' },
    { name: '管理配置表库', code: 'config-lib:manage', module: '配置表库', description: '管理配置表库（创建/编辑）' },
    { name: '删除配置表库', code: 'config-lib:delete', module: '配置表库', description: '删除配置表库记录' },
    // 数据报表
    { name: '查看报表', code: 'report:view', module: '数据报表', description: '查看数据报表和统计' },
    // 智能助手
    { name: '使用智能助手', code: 'ai:view', module: '智能助手', description: '使用智能助手功能' },
    { name: '删除助手数据', code: 'ai:delete', module: '智能助手', description: '删除学习记录、计划、方案、行动' },
    // 流程规则
    { name: '查看流程规则', code: 'rules:view', module: '流程规则', description: '查看业务流程规则' },
    { name: '管理流程规则', code: 'rules:manage', module: '流程规则', description: '管理业务流程规则（创建/编辑）' },
    { name: '删除流程规则', code: 'rules:delete', module: '流程规则', description: '删除业务流程规则' },
    // 合规自检
    { name: '查看合规自检', code: 'compliance:view', module: '合规自检', description: '查看合规自检结果' },
    { name: '运行合规自检', code: 'compliance:run', module: '合规自检', description: '运行合规检查' },
    // 数据清洗
    { name: '查看数据清洗', code: 'data-clean:view', module: '数据清洗', description: '查看数据清洗功能' },
    { name: '执行数据清洗', code: 'data-clean:execute', module: '数据清洗', description: '执行数据清洗操作' },
    { name: '删除清洗规则', code: 'data-clean:delete', module: '数据清洗', description: '删除数据清洗规则' },
    // 自动测试
    { name: '查看自动测试', code: 'test:view', module: '自动测试', description: '查看自动测试功能' },
    { name: '运行自动测试', code: 'test:run', module: '自动测试', description: '运行自动测试' },
    // 系统管理
    { name: '权限管理', code: 'system:permission', module: '系统管理', description: '管理角色和权限' },
    { name: '用户管理', code: 'system:user', module: '系统管理', description: '管理系统用户' },
    { name: '系统配置', code: 'system:config', module: '系统管理', description: '修改系统配置' },
    // 问题反馈
    { name: '提交反馈', code: 'feedback:create', module: '问题反馈', description: '提交问题反馈' },
    { name: '处理反馈', code: 'feedback:handle', module: '问题反馈', description: '处理和关闭反馈' },
    { name: '删除反馈', code: 'feedback:delete', module: '问题反馈', description: '删除问题反馈记录' },
    // 项目技转
    { name: '查看技转资料', code: 'tech:view', module: '项目技转', description: '查看通用技术资料与技转记录' },
    { name: '上传技转资料', code: 'tech:create', module: '项目技转', description: '上传/创建技术资料' },
    { name: '编辑技转资料', code: 'tech:edit', module: '项目技转', description: '编辑/迭代技术资料' },
    { name: '删除技转资料', code: 'tech:delete', module: '项目技转', description: '删除/作废技术资料' },
    { name: '资料归档审核', code: 'tech:audit', module: '项目技转', description: '审核资料归档/作废状态' },
    { name: '部门经理审核', code: 'tech:approve:dept', module: '项目技转', description: '部门经理审核技术资料（一级）' },
    { name: '总经理批准', code: 'tech:approve:gm', module: '项目技转', description: '总经理批准技术资料并署名（二级终审）' },
    { name: '下载核心资料', code: 'tech:download', module: '项目技转', description: '下载核心技术资料' },
    { name: '下载涉密资料', code: 'tech:download:secret', module: '项目技转', description: '下载涉密技术资料（仅超管）' },
    { name: '预览核心资料', code: 'tech:preview:core', module: '项目技转', description: '预览核心/涉密技术资料' },
    { name: '转发技转资料', code: 'tech:forward', module: '项目技转', description: '转发技术资料给他人' },
    { name: '复用技转资料', code: 'tech:reuse', module: '项目技转', description: '复用历史资料至新项目' },
    { name: '管理技转流转', code: 'tech:transfer', module: '项目技转', description: '管理四段式技转交底与流转' },
    { name: '管理技术变更', code: 'tech:change', module: '项目技转', description: '发起/审核/执行技术变更' },
    { name: '管理技术复盘', code: 'tech:review', module: '项目技转', description: '管理技术复盘记录' },
    { name: '管理技术案例库', code: 'tech:case:manage', module: '项目技转', description: '管理技术案例库沉淀' },
    { name: '技转模块全域管控', code: 'tech:admin', module: '项目技转', description: '分级标准/权限矩阵/审计日志管控' },
    // 组织模块
    { name: '查看组织', code: 'org:view', module: '组织模块', description: '查看部门、岗位、人员及权限' },
    { name: '创建部门', code: 'org:create', module: '组织模块', description: '新增组织部门' },
    { name: '编辑部门', code: 'org:edit', module: '组织模块', description: '修改组织部门' },
    { name: '删除部门', code: 'org:delete', module: '组织模块', description: '删除组织部门' },
    { name: '岗位管理', code: 'org:position:manage', module: '组织模块', description: '管理岗位及其默认权限/角色' },
    { name: '人员管理', code: 'org:personnel:manage', module: '组织模块', description: '管理组织人员及权限个性化调整' }
  ];

  const existingPerms = permTable.all();
  const existingCodes = new Set(existingPerms.map(p => p.code));

  // 1. 添加缺失的权限定义
  let permsAdded = 0;
  allPermDefs.forEach(def => {
    if (!existingCodes.has(def.code)) {
      permTable.insert({ ...def, created_at: now() });
      permsAdded++;
    }
  });
  permTable._invalidate();

  // 2. 重新获取全部权限
  const allPerms = permTable.all();

  // 3. 角色权限配置（按全域权限矩阵：✅完全 / 👁只读 / ❌无）
  const rolePermMap = {
    'sales_manager': [
      'inquiry:view','inquiry:status','inquiry:import','inquiry:export',
      'customer:view','customer:create','customer:edit','customer:delete',
      'product:view','material:view','supplier:view',
      'bom:view','bom-compare:view','pricing:view',
      'quote:view','quote:manage','quote:delete',
      'order:view','order:create','order:edit',
      'sample:view','sample:create','sample:edit',
      'project:view','project:create','project:edit',
      'config:view','spec:view','config-lib:view',
      'report:view','ai:view','ai:delete',
      'system:permission',
      'feedback:create','feedback:handle','feedback:delete',
      'compliance:view','test:view','rules:view',
      'data-clean:view','drawing:preview',
      'tech:view','tech:audit','tech:approve:dept','tech:download','tech:preview:core','tech:reuse','tech:transfer','tech:change','tech:review','tech:case:manage',
      'org:view','org:create','org:edit','org:position:manage','org:personnel:manage'
    ],
    'sales': [
      'inquiry:view','inquiry:create','inquiry:edit','inquiry:price','inquiry:status','inquiry:import','inquiry:export',
      'customer:view','customer:create','customer:edit','customer:delete',
      'product:view','material:view',
      'bom:view','bom-compare:view',
      'order:view','order:create','order:edit',
      'sample:view','sample:create','sample:edit',
      'project:view','quote:view','quote:manage','quote:delete',
      'config:view','spec:view','config-lib:view',
      'report:view','ai:view','ai:delete',
      'compliance:view','test:view','rules:view',
      'feedback:create','data-clean:view','drawing:preview',
      'tech:view',
      'org:view'
    ],
    'engineer': [
      'inquiry:view','inquiry:price',
      'product:view','product:create','product:edit','product:delete',
      'material:view','material:create','material:edit','material:delete',
      'supplier:view',
      'bom:view','bom:create','bom:edit','bom:delete','bom-compare:view',
      'pricing:view','pricing:create','pricing:edit','pricing:delete',
      'config:view','config:create','config:edit','config:delete',
      'spec:view','spec:manage','spec:delete','config-lib:view','config-lib:manage','config-lib:delete',
      'quote:view','quote:manage','quote:delete',
      'sample:view','order:view',
      'project:view','project:create','project:edit',
      'report:view','ai:view','ai:delete',
      'compliance:view','compliance:run',
      'test:view','test:run',
      'rules:view','feedback:create',
      'data-clean:view','data-clean:execute','data-clean:delete',
      'drawing:preview','drawing:approve','drawing:upload','drawing:delete',
      'tech:view','tech:create','tech:edit','tech:delete','tech:audit','tech:download','tech:preview:core','tech:forward','tech:reuse','tech:transfer','tech:change','tech:review','tech:case:manage',
      'org:view','org:position:manage','org:personnel:manage'
    ],
    'purchase': [
      'inquiry:view','product:view',
      'material:view','material:create','material:edit','material:delete',
      'supplier:view','supplier:create','supplier:edit','supplier:delete',
      'bom:view','bom:create','bom:edit','bom-compare:view',
      'order:view','order:create','order:edit',
      'sample:view','project:view',
      'config:view','spec:view','config-lib:view',
      'report:view','ai:view','ai:delete',
      'compliance:view','test:view','rules:view',
      'feedback:create','data-clean:view',
      'drawing:preview','drawing:upload',
      'tech:view',
      'org:view'
    ],
    'finance': [
      'inquiry:view','product:view','customer:view','material:view',
      'pricing:view','supplier:view',
      'bom:view','bom-compare:view',
      'order:view','sample:view','project:view',
      'quote:view','config:view','spec:view','config-lib:view',
      'report:view','ai:view','ai:delete',
      'compliance:view','test:view','rules:view',
      'data-clean:view','drawing:preview',
      'tech:view',
      'org:view'
    ],
    'viewer': [
      'inquiry:view','product:view','customer:view','material:view',
      'pricing:view','supplier:view','bom:view','order:view',
      'sample:view','project:view','bom-compare:view',
      'quote:view','config:view','spec:view','config-lib:view',
      'report:view','ai:view','ai:delete','rules:view','compliance:view',
      'test:view','data-clean:view',
      'system:permission','system:config',
      'drawing:preview',
      'tech:view',
      'org:view'
    ],
    'project_manager': [
      'inquiry:view','inquiry:status','inquiry:export',
      'customer:view',
      'product:view','material:view','supplier:view',
      'bom:view','bom-compare:view','pricing:view',
      'quote:view',
      'order:view','order:create','order:edit',
      'sample:view','sample:create','sample:edit','sample:delete',
      'project:view','project:create','project:edit','project:delete',
      'config:view','spec:view','config-lib:view',
      'report:view','ai:view','ai:delete',
      'system:permission',
      'feedback:create','feedback:handle','feedback:delete',
      'compliance:view','compliance:run','test:view','rules:view',
      'data-clean:view','drawing:preview',
      'tech:view','tech:audit','tech:preview:core','tech:transfer','tech:change','tech:review',
      'org:view','org:create','org:edit','org:position:manage','org:personnel:manage'
    ],
    'rd_manager': [
      'inquiry:view','inquiry:price','inquiry:status',
      'product:view','product:create','product:edit','product:delete',
      'material:view','material:create','material:edit','material:delete',
      'supplier:view',
      'bom:view','bom:create','bom:edit','bom:delete','bom-compare:view',
      'pricing:view','pricing:create','pricing:edit','pricing:delete',
      'config:view','config:create','config:edit','config:delete',
      'spec:view','spec:manage','spec:delete',
      'config-lib:view','config-lib:manage','config-lib:delete',
      'quote:view','quote:manage','quote:delete',
      'sample:view','sample:create','sample:edit','sample:delete',
      'order:view',
      'project:view','project:create','project:edit','project:delete',
      'report:view','ai:view','ai:delete',
      'compliance:view','compliance:run',
      'test:view','test:run',
      'rules:view','rules:manage','rules:delete',
      'feedback:create',
      'data-clean:view','data-clean:execute','data-clean:delete',
      'drawing:preview','drawing:approve','drawing:upload','drawing:delete',
      'tech:view','tech:create','tech:edit','tech:delete','tech:audit','tech:approve:dept','tech:download','tech:preview:core','tech:forward','tech:reuse','tech:transfer','tech:change','tech:review','tech:case:manage',
      'org:view','org:create','org:edit','org:delete','org:position:manage','org:personnel:manage'
    ]
  };

  // 补建缺失的角色（项目经理、研发经理）
  const REQUIRED_ROLES = [
    { name: '项目经理', code: 'project_manager', description: '项目全流程管理：立项、进度、样品、订单与交付跟踪' },
    { name: '研发经理', code: 'rd_manager', description: '研发管理：产品/物料/BOM/核价/图纸/合规/测试全权管理' }
  ];
  let rolesAdded = 0;
  REQUIRED_ROLES.forEach(def => {
    if (!roleTable.all().find(r => r.code === def.code)) {
      roleTable.insert(Object.assign({}, def, { created_at: now(), updated_at: now() }));
      rolesAdded++;
    }
  });
  if (rolesAdded) roleTable._invalidate();

  const roles = roleTable.all();
  let rpAdded = 0;

  roles.forEach(role => {
    if (role.code === 'admin') {
      // admin 拥有所有权限
      const existingRps = new Set(rpTable.all().filter(rp => rp.role_id === role.id).map(rp => rp.permission_id));
      allPerms.forEach(p => {
        if (!existingRps.has(p.id)) {
          rpTable.insert({ role_id: role.id, permission_id: p.id, granted_at: now() });
          rpAdded++;
        }
      });
    } else if (rolePermMap[role.code]) {
      const permCodes = rolePermMap[role.code];
      const existingRps = new Set(rpTable.all().filter(rp => rp.role_id === role.id).map(rp => rp.permission_id));
      permCodes.forEach(code => {
        const p = allPerms.find(pm => pm.code === code);
        if (p && !existingRps.has(p.id)) {
          rpTable.insert({ role_id: role.id, permission_id: p.id, granted_at: now() });
          rpAdded++;
        }
      });
    }
  });

  rpTable._invalidate();

  res.json({
    message: `权限迁移完成`,
    permissions_added: permsAdded,
    roles_added: rolesAdded,
    role_permissions_added: rpAdded,
    total_permissions: allPerms.length
  });
});

// ===== 补齐管理员权限（兼容旧版） =====
router.post('/fix-admin-permissions', requirePerm('system:permission'), (req, res) => {
  const roleTable = getTable('roles');
  const rpTable = getTable('role_permissions');
  const permTable = getTable('permissions');

  roleTable._invalidate();
  rpTable._invalidate();
  permTable._invalidate();

  const adminRole = roleTable.all().find(r => r.code === 'admin');
  if (!adminRole) return res.status(404).json({ error: '管理员角色不存在' });

  const allPerms = permTable.all().filter(p => p.code);
  const existingRps = rpTable.all().filter(rp => rp.role_id === adminRole.id);
  const existingPermIds = new Set(existingRps.map(rp => rp.permission_id));

  let added = 0;
  allPerms.forEach(p => {
    if (!existingPermIds.has(p.id)) {
      rpTable.insert({ role_id: adminRole.id, permission_id: p.id, granted_at: now() });
      added++;
    }
  });

  res.json({
    message: `管理员权限补齐完成，新增${added}项`,
    total: allPerms.length,
    added
  });
});

module.exports = router;
