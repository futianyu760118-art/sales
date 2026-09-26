/**
 * M03 EBMS 主体功能入口客户端。
 *
 * 唯一职责：向 /api/m03/entry 询问「能否进入 + 默认落地哪个视图 + 可见指标范围」。
 * 结论全部由后端消费 M01 Kernel 得出；前端不缓存、不判断角色 / 权限 / 数据范围，
 * 也不在任何情况下回落本地角色配置。
 */
(function () {
  const API = window.location.origin + '/api/m03';

  function token() {
    try { return localStorage.getItem('authToken'); } catch (_) { return null; }
  }

  async function resolve() {
    const headers = {};
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    try {
      const res = await fetch(API + '/entry', { headers });
      const data = await res.json().catch(function () { return {}; });
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        data: { code: 'M03_ENTRY_UNREACHABLE', error: '无法连接 EBMS 入口服务，请稍后重试' }
      };
    }
  }

  function gateMessage(code) {
    switch (code) {
      case 'M01_KERNEL_UNAVAILABLE':
        return 'M01 Kernel 不可用，已拒绝加载 EBMS 主体功能（不会回落到本地角色 / 权限 / 数据范围配置）。请稍后重试或联系管理员。';
      case 'NO_KERNEL_IDENTITY':
        return 'M01 Kernel 中不存在该账号，无法进入 EBMS 主体功能。请联系管理员确认账号状态。';
      case 'NO_KERNEL_ROLE':
        return '您在 M01 Kernel 中尚未分配任何角色，无法进入 EBMS 主体功能。请联系管理员在 M01 Kernel 中配置角色与数据范围。';
      case 'NO_EBMS_ACCESS':
        return '当前 Kernel 角色未被授权访问 EBMS 主体功能。请联系管理员授予 M03 进入权限。';
      case 'UNAUTHORIZED':
        return '未登录或会话已过期，请重新登录。';
      default:
        return '无法进入 EBMS 主体功能，请联系管理员。';
    }
  }

  /** 在页面上给出明确提示，并阻止主体功能加载 */
  function renderGate(code, detail) {
    document.body.setAttribute('data-m03-blocked', '1');
    let overlay = document.getElementById('m03GateOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'm03GateOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.97);z-index:10000;' +
        'display:flex;align-items:center;justify-content:center;padding:24px;font-family:inherit;';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML =
      '<div style="max-width:520px;text-align:center;border:2px dashed #e74c3c;border-radius:14px;' +
      'padding:30px;background:#fff;">' +
        '<h2 style="margin:0 0 10px;color:#c0392b;font-size:20px;">无法进入 EBMS 主体功能</h2>' +
        '<p style="margin:0 0 8px;color:#555;font-size:14px;line-height:1.7;">' + gateMessage(code) + '</p>' +
        (detail ? '<p style="margin:0 0 14px;color:#999;font-size:12px;">原因代码：' + code + ' · ' + detail + '</p>'
                : '<p style="margin:0 0 14px;color:#999;font-size:12px;">原因代码：' + code + '</p>') +
        '<div style="display:flex;gap:8px;justify-content:center;">' +
          '<button onclick="window.globalLogout&&window.globalLogout()" style="padding:8px 18px;background:#667eea;' +
          'color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;">退出登录</button>' +
          '<button onclick="location.reload()" style="padding:8px 18px;background:#e0e0e0;color:#333;border:none;' +
          'border-radius:6px;cursor:pointer;font-size:13px;">重试</button>' +
        '</div>' +
      '</div>';
  }

  /**
   * 页面入口守卫：允许进入返回 entry 数据；不允许进入则渲染提示并返回 null。
   */
  async function ensureEntry() {
    const { ok, data } = await resolve();
    if (ok && data.entry_allowed !== false && data.gate && data.gate.allowed) return data;
    renderGate(data.code || 'M03_ENTRY_FAILED', '');
    return null;
  }

  window.M03Entry = { resolve, ensureEntry, renderGate, gateMessage };
})();
