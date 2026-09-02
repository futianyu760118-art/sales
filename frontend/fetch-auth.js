/**
 * 早期 fetch 拦截器（在 <head> 引入）
 * ------------------------------------------------------------------
 * 确保业务脚本发起的任何请求（含页面初始同步加载）都带当前用户标识，
 * 让后端数据权限 resolveDataScopeV2 能识别用户并按业务员/部门岗位过滤。
 *
 * 放在 <head> 是为了在 body 内联业务脚本（含页面初始 loadXxx() 调用）
 * 执行之前就把 window.fetch 包裹好。
 */
(function () {
  if (window.__fetchAuthInstalled) return;
  window.__fetchAuthInstalled = true;
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    var uid = localStorage.getItem('currentUserId');
    var token = localStorage.getItem('authToken');
    init = init || {};
    var h = init.headers;
    // 归一化为普通对象，避免 Headers / 数组 / 无 headers 的分支差异
    var headers = {};
    if (h instanceof Headers) {
      h.forEach(function (v, k) { headers[k] = v; });
    } else if (h && typeof h === 'object' && !Array.isArray(h)) {
      Object.keys(h).forEach(function (k) { headers[k] = h[k]; });
    }
    // 优先使用登录签发的 token（服务端校验，不可伪造）；x-user-id 仅作兼容旧客户端保留
    if (token && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + token;
    if (uid && !headers['x-user-id']) headers['x-user-id'] = uid;
    init.headers = headers;
    return _fetch.call(this, input, init);
  };
})();
