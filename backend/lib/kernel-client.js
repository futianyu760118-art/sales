/**
 * M03 EBMS 消费 M01 Kernel 的唯一通道（只读）。
 *
 * 红线（PAND-93）：角色 / 权限 / 数据范围一律消费 M01 Kernel；
 *   - 本客户端不提供任何 Kernel 侧写入口（角色 / 权限 / 数据范围的配置只能在 Kernel 完成）；
 *   - Kernel 不可用时抛 KernelUnavailableError，调用方必须给出明确提示并拒绝加载，
 *     不得回落到 EBMS 本地的角色 / 权限 / 数据范围配置。
 */
const kernel = require('./m01-kernel');

class KernelUnavailableError extends Error {
  constructor(reason) {
    super(reason || 'M01 Kernel 不可用');
    this.name = 'KernelUnavailableError';
    this.code = 'M01_KERNEL_UNAVAILABLE';
  }
}

function requireAvailable() {
  const h = kernel.health();
  if (!h.available) throw new KernelUnavailableError(h.reason);
  return h;
}

function getIdentity(userId) {
  requireAvailable();
  return kernel.getIdentity(userId);
}

function resolveDataScope(userId) {
  requireAvailable();
  return kernel.resolveDataScope(userId);
}

function listRoleDataScopes() {
  requireAvailable();
  return kernel.listRoleDataScopes();
}

module.exports = {
  KernelUnavailableError,
  health: () => kernel.health(),
  getIdentity,
  resolveDataScope,
  listRoleDataScopes,
  listRoles: () => { requireAvailable(); return kernel.listRoles(); }
};
