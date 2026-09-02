/**
 * 密码哈希：Node 内置 scrypt（无需外部依赖）
 * 格式：$scrypt$<salt-hex>$<hash-hex>
 * verifyPassword 兼容历史明文密码（迁移期）：明文比对通过后建议尽快改为哈希。
 */
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return '$scrypt$' + salt + '$' + hash;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (typeof stored === 'string' && stored.startsWith('$scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 4 || !parts[2] || !parts[3]) return false;
    const hash = crypto.scryptSync(String(password), parts[2], 64);
    const a = Buffer.from(hash.toString('hex'));
    const b = Buffer.from(parts[3]);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  // 兼容历史明文密码（迁移期）
  return stored === password;
}

module.exports = { hashPassword, verifyPassword };
