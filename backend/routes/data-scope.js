// 数据权限路由
// 提供 /my-scope、/employees、/customer/transfer 三个接口，避免前端 404。
// 数据范围来源：M01 Kernel 的 data-scope（本模块不再本地推导）。
const express = require('express');
const router = express.Router();
const { getTable } = require('../db');
const { extractUserId } = require('../auth-middleware');
const kernelClient = require('../lib/kernel-client');

// 安全取表
function safeAll(name) {
  try { return getTable(name).all(); } catch (_) { return []; }
}

// 当前用户的数据范围：仅用于头部横幅展示，真实安全由后端业务路由保证
router.get('/my-scope', (req, res) => {
  const userId = extractUserId(req)
    || Number(req.query.user_id || req.headers['x-user-id'])
    || null;
  if (!userId) return res.json({ mode: 'all', label: '全部数据', source: 'M01_KERNEL' });

  let scope;
  try {
    scope = kernelClient.resolveDataScope(userId);
  } catch (e) {
    // M01 Kernel 不可用：明确提示，不回落本地角色 / 数据范围配置
    return res.status(503).json({
      mode: 'none',
      label: 'M01 Kernel 不可用，数据范围不可用',
      source: 'M01_KERNEL',
      code: 'M01_KERNEL_UNAVAILABLE',
      error: 'M01 Kernel 不可用，已拒绝按本地配置回退数据范围'
    });
  }

  if (scope.scope_type === 'all') {
    return res.json({ mode: 'all', label: scope.scope_label || '全企业口径', source: 'M01_KERNEL', scope_type: 'all' });
  }
  const domains = (scope.domain_keys || []).filter(k => k !== '*');
  if (scope.scope_type === 'none' || (!scope.resource_ids.length && !domains.length)) {
    return res.json({ mode: 'none', label: '无可见范围', source: 'M01_KERNEL', scope_type: scope.scope_type });
  }
  return res.json({
    mode: 'custom',
    label: `${scope.scope_label || '责任域口径'}${domains.length ? '（' + domains.join('/') + '）' : ''}`,
    ids: scope.resource_ids,
    unit_ids: scope.unit_ids || [],
    domain_keys: scope.domain_keys,
    source: 'M01_KERNEL',
    scope_type: scope.scope_type
  });
});

// 可转移目标员工列表（排除自己与停用账号）
router.get('/employees', (req, res) => {
  const currentId = Number(req.query.user_id || req.headers['x-user-id']);
  const users = safeAll('users').filter(u =>
    u.id !== currentId && u.status !== '停用' && u.status !== 'disabled'
  );
  const data = users.map(u => ({
    id: u.id,
    name: u.name || u.username || u.real_name,
    department_name: u.department_name || u.department || ''
  }));
  return res.json({ data });
});

// 客户转移：把指定客户（可选连带订单/项目）的负责人改为新员工
router.post('/customer/transfer', (req, res) => {
  const { customer_ids = [], to_user_id, transfer_orders = false, transfer_projects = false } = req.body || {};
  if (!Array.isArray(customer_ids) || customer_ids.length === 0) {
    return res.status(400).json({ error: '未选择客户' });
  }
  if (!to_user_id) return res.status(400).json({ error: '未指定新负责人' });

  let transferred = 0;
  let ordersTransferred = 0;
  let projectsTransferred = 0;
  const now = new Date().toISOString();

  try {
    const custTable = getTable('customers');
    for (const id of customer_ids) {
      const row = custTable.findById(id);
      if (!row) continue;
      custTable.update(id, {
        sales_person_id: to_user_id,
        owner_id: to_user_id,
        updated_at: now
      });
      transferred++;
    }

    if (transfer_orders) {
      const orderTable = getTable('orders');
      safeAll('orders').forEach(o => {
        if (customer_ids.includes(Number(o.customer_id))) {
          orderTable.update(o.id, { sales_person_id: to_user_id, owner_id: to_user_id, updated_at: now });
          ordersTransferred++;
        }
      });
    }

    if (transfer_projects) {
      const projTable = getTable('projects');
      safeAll('projects').forEach(p => {
        if (customer_ids.includes(Number(p.customer_id))) {
          projTable.update(p.id, { owner_id: to_user_id, updated_at: now });
          projectsTransferred++;
        }
      });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  return res.json({
    transferred,
    orders_transferred: ordersTransferred,
    projects_transferred: projectsTransferred
  });
});

router.get('/', (req, res) => res.json({ message: '数据权限模块（最小实现）', rules: [] }));

module.exports = router;
