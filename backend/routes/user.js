const express = require('express');
const router = express.Router();
const { getTable, now: dbNow } = require('../db');
const { requirePerm } = require('../auth-middleware');

// 登录
// GET /login is public - no auth
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码为必填项' });
  }
  const table = getTable('users');
  // [SECURITY] 当前为明文密码比对（c8 待办）。下一期：bcrypt(cost=12) + 迁移期兼容明文
  const user = table.all().find(u => u.username === username && u.password === password);
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  res.json({ message: '登录成功', user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// 获取用户列表
router.get('/', requirePerm('system:user'), (req, res) => {
  const table = getTable('users');
  const users = table.all().map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, created_at: u.created_at }));
  res.json(users);
});

// 获取单个用户
router.get('/:id', requirePerm('system:user'), (req, res) => {
  const table = getTable('users');
  const user = table.findById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role, created_at: user.created_at });
});

// 创建用户
router.post('/', requirePerm('system:user'), (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码为必填项' });
  }
  const table = getTable('users');
  const existing = table.all().find(u => u.username === username);
  if (existing) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  const now = dbNow();
  const result = table.insert({ username, password, name: name || username, role: role || 'sales', created_at: now });
  const user = table.findById(result.lastID);
  res.json({ message: '用户创建成功', data: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// 更新用户
router.put('/:id', requirePerm('system:user'), (req, res) => {
  const { username, password, name, role } = req.body;
  const table = getTable('users');
  const user = table.findById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const fields = {};
  if (username !== undefined) fields.username = username;
  if (password !== undefined) fields.password = password;
  if (name !== undefined) fields.name = name;
  if (role !== undefined) fields.role = role;
  table.update(req.params.id, fields);
  res.json({ message: '用户更新成功' });
});

// 删除用户
router.delete('/:id', requirePerm('system:user'), (req, res) => {
  const table = getTable('users');
  const result = table.delete(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
  res.json({ message: '用户删除成功' });
});

module.exports = router;
