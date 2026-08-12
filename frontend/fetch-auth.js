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
    if (uid) {
      init = init || {};
      var h = init.headers;
      if (h instanceof Headers) {
        if (!h.has('x-user-id')) h.set('x-user-id', uid);
      } else if (h && typeof h === 'object') {
        if (!h['x-user-id']) h['x-user-id'] = uid;
      } else {
        init.headers = Object.assign({}, h || {}, { 'x-user-id': uid });
      }
    }
    return _fetch.call(this, input, init);
  };
})();
