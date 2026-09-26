'use strict';

const express = require('express');
const { query } = require('../../db/pool');
const { issue } = require('../../lib/token');
const config = require('../../config/env');
const { badRequest, unauthorized } = require('../errors');

const router = express.Router();

// 开发环境签发操作人 token，便于本地联调与自检。
// 生产环境的身份源（企业 SSO / 自建账号）为待确认项（架构方案 §6.3），届时替换此端点。
router.post('/auth/dev-login', async (req, res, next) => {
  try {
    if (config.nodeEnv === 'production') {
      return next(unauthorized('AUTH_DEV_LOGIN_DISABLED', '生产环境不提供开发登录'));
    }
    const username = req.body?.username;
    if (typeof username !== 'string' || username.trim() === '') {
      return next(badRequest('USERNAME_REQUIRED', 'username 不能为空'));
    }
    const { rows } = await query(
      'SELECT id, username, display_name, role FROM ebms_users WHERE username = $1',
      [username.trim()]
    );
    const user = rows[0];
    if (!user) return next(unauthorized('USER_NOT_FOUND', '用户不存在'));
    return res.json({
      ok: true,
      data: {
        token: issue({
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role,
        }),
        user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role },
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
