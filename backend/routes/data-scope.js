// 数据权限路由（最小可用实现）
// 提供 /my-scope、/employees、/customer/transfer 三个接口，避免前端 404。
const express = require('express');
const router = express.Router();
const { getTable } = require('../db');
const { getUserPermissions } = require('../auth-middleware');

// 安全取表
function safeAll(name) {
  try { return getTable(name).all(); } catch (_) { return []; }
}

// 当前用户的数据范围：仅用于头部横幅展示，真实安全由后端业务路由保证
router.get('/my-scope', (req, res) => {
  const userId = Number(req.query.user_id || req.headers['x-user-id']);
  if (!userId) return res.json({ mode: 'all', label: '全部数据' });
  try {
    const { isAdmin } = getUserPermissions(userId);
    if (isAdmin) return res.json({ mode: 'all', label: '全部数据' });
  } catch (_) { /* ignore */ }
  const orgs = safeAll('amiba_org').filter(o => o.status !== '停用');
  const mine = orgs.filter(o =>
    Number(o.charge_user_id) === userId || Number(o.charge_personnel_id) === userId
  );
  if (!mine.length) return res.json({ mode: 'all', label: '全部数据' });
  return res.json({ mode: 'custom', label: `我的责任单元（${mine.length}）` });
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
