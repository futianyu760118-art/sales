'use strict';

const { verify } = require('../../lib/token');
const { unauthorized } = require('../errors');

/**
 * 从 Bearer token 解析操作人。所有写操作必须携带，用于「操作人」留痕。
 * 角色的数据范围（PAND-93）不在本切片范围。
 */
function requireActor(req, _res, next) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return next(unauthorized('AUTH_REQUIRED', '缺少 Bearer token，无法确定操作人'));
  }
  const payload = verify(match[1]);
  if (!payload) {
    return next(unauthorized('AUTH_INVALID', 'token 无效或已过期'));
  }
  req.actor = { id: payload.sub, username: payload.username, displayName: payload.name, role: payload.role };
  next();
}

module.exports = { requireActor };
