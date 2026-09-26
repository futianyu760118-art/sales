/**
 * M01 AEOS Kernel HTTP 契约 —— 身份 / 组织 / 角色 / 权限 / 数据范围（data-scope）的唯一对外入口。
 *
 * 该路由是**角色 / 权限 / 数据范围的唯一配置入口**：
 *   - M03 EBMS 只读消费（lib/m03/kernel-client.js），不提供任何写入口；
 *   - data-scope 的变更只能经 PUT /api/kernel/roles/:id/data-scope（Kernel 侧）完成，
 *     变更后 EBMS 侧无需任何配置改动即同步生效。
 */
const express = require('express');
const router = express.Router();
const { requirePerm, requireAnyPerm } = require('../auth-middleware');
const kernel = require('../lib/m01-kernel');

// Kernel 健康状态（探活，免鉴权）
router.get('/health', (req, res) => res.json(kernel.health()));

// Kernel 不可用时，除 /health 外的全部契约端点一律拒绝，
// 避免消费方在 Kernel 停用期间仍能读到角色 / 数据范围而形成本地兜底数据源。
router.use((req, res, next) => {
  if (kernel.health().available) return next();
  res.status(503).json({
    code: 'M01_KERNEL_UNAVAILABLE',
    error: 'M01 Kernel 不可用，已拒绝提供角色 / 权限 / 数据范围',
    kernel: kernel.health()
  });
});

// 角色目录（Kernel 所有）
router.get('/roles', requireAnyPerm('system:permission', 'org:view'), (req, res) => {
  res.json({ source: 'M01_KERNEL', data: kernel.listRoles() });
});

// 权限目录（Kernel 所有）
router.get('/permissions', requireAnyPerm('system:permission', 'org:view'), (req, res) => {
  res.json({ source: 'M01_KERNEL', data: kernel.listPermissions() });
});

// 用户身份（角色 / 权限码）
router.get('/users/:id/identity', requireAnyPerm('system:permission', 'org:view'), (req, res) => {
  const identity = kernel.getIdentity(req.params.id);
  if (!identity) return res.status(404).json({ error: 'M01 Kernel 中不存在该用户', code: 'NO_KERNEL_IDENTITY' });
  res.json(identity);
});

// 用户生效数据范围（data-scope）
router.get('/users/:id/data-scope', requireAnyPerm('system:permission', 'org:view'), (req, res) => {
  res.json(kernel.resolveDataScope(req.params.id));
});

// 角色 → 数据范围绑定一览
router.get('/role-data-scopes', requireAnyPerm('system:permission', 'org:view'), (req, res) => {
  res.json({ source: 'M01_KERNEL', data: kernel.listRoleDataScopes() });
});

// 单个角色的数据范围定义
router.get('/roles/:id/data-scope', requireAnyPerm('system:permission', 'org:view'), (req, res) => {
  const scope = kernel.getRoleDataScope(req.params.id);
  if (!scope) return res.status(404).json({ error: '角色不存在', code: 'ROLE_NOT_FOUND' });
  res.json(scope);
});

// 变更角色数据范围（Kernel 侧唯一写入口）
router.put('/roles/:id/data-scope', requirePerm('system:permission'), (req, res) => {
  try {
    const scope = kernel.setRoleDataScope(req.params.id, req.body || {});
    res.json({ message: '数据范围已更新（M01 Kernel）', data: scope });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
