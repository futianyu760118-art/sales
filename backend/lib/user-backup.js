// 用户数据备份模块（最小可用存根）
// 被 server.js 引用以做"快照"，失败不影响主流程。
module.exports = {
  snapshot: async () => { /* no-op */ return { ok: false, reason: 'backup module disabled' }; },
  restore: async () => { return { ok: false, reason: 'backup module disabled' }; }
};