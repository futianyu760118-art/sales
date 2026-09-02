/**
 * 权限检查 + 现代企业 ERP 双列导航
 * ------------------------------------------------------------------
 * 功能：
 *   1. 加载当前用户的权限（is_admin 或权限码集合）
 *   2. 渲染侧边栏，过滤"无权限项"，连空一级模块也隐藏
 *   3. 页面准入：<body data-page-perm="xxx:view">，无权限自动跳转并提示
 *   4. 区段准入：[data-section-perm="xxx"]（任意元素），无权限整段隐藏
 *   5. 元素级：[data-perm="xxx"]（按钮/链接/操作项），无权限隐藏
 *   6. 动态 DOM：MutationObserver 监听新增元素并自动过滤
 *   7. 全局 API：PermissionCheck.hideAll() / has(code) / onChange()
 * ------------------------------------------------------------------
 */

(function () {
  // 全局：拦截 fetch 自动注入登录 token（优先）与当前用户 id（兼容旧客户端）
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const uid = localStorage.getItem('currentUserId');
    const token = localStorage.getItem('authToken');
    if (uid || token) {
      init = init || {};
      let headers = {};
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach(function (v, k) { headers[k] = v; });
      } else if (h && typeof h === 'object' && !Array.isArray(h)) {
        Object.keys(h).forEach(function (k) { headers[k] = h[k]; });
      }
      // 服务端校验 token 作为身份来源；x-user-id 仅保留供老接口读取
      if (token && !headers['Authorization']) headers['Authorization'] = 'Bearer ' + token;
      if (uid && !headers['x-user-id']) headers['x-user-id'] = uid;
      init.headers = headers;
    }
    return _fetch.call(this, input, init);
  };
})();

// 一级导航：固定 9 个分组
const TOP_LEVEL_GROUPS = [
  { key: 'home',       label: '首页',         icon: '\u{1F3E0}' },
  { key: 'business',   label: '经营中心',     icon: '\u{1F4CA}' },
  { key: 'sales',      label: '销售中心',     icon: '\u{1F4B0}' },
  { key: 'rd',         label: '研发中心',     icon: '\u{1F4A1}' },
  { key: 'supply',     label: '供应链中心',   icon: '\u{1F69A}' },
  { key: 'production', label: '生产中心',     icon: '\u{1F3ED}' },
  { key: 'quality',    label: '品质中心',     icon: '\u2714\uFE0F' },
  { key: 'report',     label: '报表中心',     icon: '\u{1F4C8}' },
  { key: 'system',     label: '系统管理',     icon: '\u2699\uFE0F' }
];

// 二级菜单：每条带 group 字段
const sidebarItems = [
  { href: 'annual-plan.html',    label: '年度计划',     group: 'business', perm: 'annual-plan:view' },
  { href: 'amiba.html',          label: '阿米巴经营',   group: 'business', perm: 'amiba:view' },
  { href: 'expense.html',        label: '费用库',       group: 'business', perm: 'expense:view' },
  { href: 'labor.html',          label: '人工库',       group: 'business', perm: 'labor:view' },
  { href: 'product-labor-rate.html', label: '成品工价库', group: 'business', perm: 'labor-rate:view' },
  { href: 'order-analysis.html', label: '订单分析库',   group: 'business', perm: 'order-analysis:view' },
  { href: 'material-issue.html', label: '领料单',       group: 'business', perm: 'material-issue:view' },
  { href: 'sop.html', label: '产销协调会', group: 'business', perm: 'prod-coord:view' },
  { href: 'ai-assistant.html',   label: 'AI 经营助手',  group: 'business', perm: 'ai:view' },
  { href: 'customer.html',       label: '客户管理',     group: 'sales', perm: 'customer:view' },
  { href: 'inquiry.html',        label: '询价管理',     group: 'sales', perm: 'inquiry:view' },
  { href: 'quote.html',          label: '报价库',       group: 'sales', perm: 'quote:view' },
  { href: 'order.html',          label: '订单管理',     group: 'sales', perm: 'order:view' },
  { href: 'sample.html',         label: '样品管理',     group: 'sales', perm: 'sample:view' },
  { href: 'feedback.html',       label: '问题反馈',     group: 'sales', perm: 'feedback:create' },
  { href: 'product.html',        label: '产品管理',     group: 'rd', perm: 'product:view' },
  { href: 'project.html',        label: '项目管理',     group: 'rd', perm: 'project:view' },
  { href: 'config.html',         label: '产品配置表',   group: 'rd', perm: 'config:view' },
  { href: 'config-library.html', label: '配置表库',     group: 'rd', perm: 'config-lib:view' },
  { href: 'bom.html',            label: 'BOM 管理',     group: 'rd', perm: 'bom:view' },
  { href: 'bom-compare.html',    label: 'BOM 对比',     group: 'rd', perm: 'bom-compare:view' },
  { href: 'pricing.html',        label: '核价库',       group: 'rd', perm: 'pricing:view' },
  { href: 'tech-transfer.html',  label: '项目技转',     group: 'rd', perm: 'tech:view' },
  { href: 'spec-library.html',   label: '规格书库',     group: 'rd', perm: 'spec:view' },
  { href: 'material.html',       label: '物料库',       group: 'supply', perm: 'material:view' },
  { href: 'supplier.html',       label: '供应商管理',   group: 'supply', perm: 'supplier:view' },
  { href: 'procurement.html',    label: '采购管理',     group: 'supply', perm: 'material:view' },
  { href: 'data-clean.html',     label: '质量数据',     group: 'quality', perm: 'data-clean:view' },
  { href: 'compliance.html',     label: '合规自检',     group: 'quality', perm: 'compliance:view' },
  { href: 'report.html',         label: '数据报表',     group: 'report',  perm: 'report:view' },
  { href: 'organization.html',   label: '组织模块',     group: 'system', perm: 'org:view' },
  { href: 'permission.html',     label: '权限管理',     group: 'system', perm: 'system:permission' },
  { href: 'rules.html',          label: '流程规则',     group: 'system', perm: 'rules:view' },
  { href: 'test.html',           label: '自动测试',     group: 'system', perm: 'test:view' },
  { href: 'settings.html',       label: '系统设置',     group: 'system', perm: 'system:config' },
  { href: 'dashboard.html',      label: '仪表盘',       group: 'home', perm: null },
  { href: 'im.html',            label: '消息中心',     group: 'home', perm: 'im:view' }
];

function _escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 解析 perm 属性值，支持空格分隔的"任意一个"语义
//   "a:b a:c" 表示 user.has('a:b') || user.has('a:c')
function _parsePermList(v) {
  if (!v) return [];
  return String(v).trim().split(/\s+/).filter(Boolean);
}

const PermissionCheck = {
  userId: null,
  username: null,
  displayName: null,
  userRole: null,
  permissions: null,
  isAdmin: false,
  _itemsByGroup: null,
  _onChangeCallbacks: [],
  _filterObserver: null,

  async init(userId) {
    if (!userId) userId = localStorage.getItem('currentUserId');
    if (!userId) {
      window.location.href = 'index.html';
      return;
    }
    this.userId = userId;
    this._loadUserInfo();
    await this.loadPermissions();
    // 1. 渲染侧边栏（品牌栏含当前登录账号）
    this.renderSidebar();
    // 2. 应用页面 / 区段 / 元素级守卫
    this.applyToPage();
    // 3. 启动 DOM 变化监听，自动过滤动态插入的元素
    this._startFilterObserver();
  },

  _loadUserInfo() {
    try {
      const full = JSON.parse(localStorage.getItem('user') || '{}');
      const cur = localStorage.getItem('currentUser');
      let parsedCur = null;
      try { parsedCur = cur ? JSON.parse(cur) : null; } catch (_) { parsedCur = cur; }
      this.username = (full && (full.username || full.name)) || (parsedCur && (parsedCur.username || parsedCur.name)) || parsedCur || '';
      this.displayName = (full && full.name) || (full && full.username) || this.username || '';
      this.userRole = (full && full.role) || '';
    } catch (_) {
      this.username = localStorage.getItem('currentUser') || '';
      this.displayName = this.username;
      this.userRole = '';
    }
  },

  async loadPermissions() {
    try {
      const res = await fetch(`${window.location.origin}/api/permissions/users/${this.userId}/permissions`);
      const data = await res.json();
      this.isAdmin = data.is_admin || false;
      if (this.isAdmin) {
        this.permissions = null;
      } else {
        const perms = data.data || [];
        this.permissions = new Set(perms.map(p => p.code));
      }
    } catch (e) {
      console.error('加载权限失败:', e);
      this.permissions = new Set();
    }
  },

  has(code) {
    if (this.isAdmin) return true;
    if (!this.permissions) return false;
    return this.permissions.has(code);
  },

  hasAny(codes) {
    if (this.isAdmin) return true;
    if (!this.permissions || !codes || !codes.length) return false;
    for (const c of codes) if (this.permissions.has(c)) return true;
    return false;
  },

  _groupItems() {
    if (this._itemsByGroup) return this._itemsByGroup;
    const map = {};
    TOP_LEVEL_GROUPS.forEach(g => { map[g.key] = []; });
    for (const item of sidebarItems) {
      if (item.perm && !this.has(item.perm)) continue;
      if (!map[item.group]) map[item.group] = [];
      map[item.group].push(item);
    }
    this._itemsByGroup = map;
    return map;
  },

  // === 当前用户能看到的模块与菜单（供其它 JS 查询） ===
  getAccessibleModules() {
    const map = this._groupItems();
    const result = {};
    for (const g of TOP_LEVEL_GROUPS) result[g.key] = (map[g.key] || []).map(i => i.href);
    return result;
  },

  renderSidebar() {
    const sidebar = document.getElementById('sidebar') || document.querySelector('.sidebar');
    if (!sidebar) return;
    sidebar.id = 'sidebar';

    const currentPage = (window.location.pathname.split('/').pop() || 'dashboard.html').toLowerCase();
    const itemsByGroup = this._groupItems();

    // 判断当前页属于哪组（即便用户对该页无权限，也定位到正确分组以便后续跳转）
    let activeGroup = null;
    for (const item of sidebarItems) {
      if ((item.href || '').toLowerCase() === currentPage) {
        activeGroup = item.group;
        break;
      }
    }
    // 进一步：若当前用户对当前页无 perm 且能跳到该组内的其它页，则切到该组首个可见项
    if (activeGroup) {
      const groupList = itemsByGroup[activeGroup] || [];
      const inGroup = groupList.some(i => (i.href || '').toLowerCase() === currentPage);
      if (!inGroup) {
        const first = groupList[0];
        if (first) activeGroup = first.group || activeGroup;
      }
    }
    if (!activeGroup) activeGroup = localStorage.getItem('lms_active_group');
    if (!activeGroup || !TOP_LEVEL_GROUPS.find(g => g.key === activeGroup)) {
      activeGroup = TOP_LEVEL_GROUPS[0].key;
    }

    const brandName = (window.EBMS && typeof window.EBMS.fullName === 'function')
      ? window.EBMS.fullName()
      : '企业经营管理平台（EBMS）-HJ';

    // === 1. brand 栏：仅系统名 ===
    let html = '<div class="lms-brandbar">';
    html += '<div class="lms-brand-name">' + _escHtml(brandName) + '</div>';
    html += '</div>';

    // === 1.5  当前登录账号（紧凑条，位于一级导航轨上方） ===
    if (this.username) {
      html += this._renderUserStrip();
    }

    // === 2. body：只展示"有可见项"的一级模块 ===
    html += '<div class="lms-body">';
    html += '<nav class="lms-topnav" id="lmsTopnav" role="navigation" aria-label="一级导航">';
    const visibleGroups = TOP_LEVEL_GROUPS.filter(g => (itemsByGroup[g.key] || []).length > 0);
    if (visibleGroups.length === 0) {
      html += '<div class="lms-empty-all" style="padding:30px 12px;color:#bbb;font-size:12px;text-align:center;">无任何可见模块<br/>请联系管理员</div>';
    }
    // 若 activeGroup 不可见，回退到第一个可见组
    if (!visibleGroups.find(g => g.key === activeGroup)) {
      activeGroup = visibleGroups[0] ? visibleGroups[0].key : activeGroup;
    }
    visibleGroups.forEach(g => {
      const isActive = g.key === activeGroup;
      const cls = 'lms-group-item' + (isActive ? ' active' : '');
      html += '<button type="button" class="' + cls + '" data-group="' + _escHtml(g.key) + '"' +
              ' aria-current="' + (isActive ? 'true' : 'false') + '">' +
              '<span class="lms-group-icon">' + g.icon + '</span>' +
              '<span class="lms-group-label">' + _escHtml(g.label) + '</span>' +
              '</button>';
    });
    html += '</nav>';

    // 二级 panel
    const activeObj = TOP_LEVEL_GROUPS.find(g => g.key === activeGroup) || visibleGroups[0] || TOP_LEVEL_GROUPS[0];
    const list = itemsByGroup[activeGroup] || [];
    html += '<div class="lms-secondary" id="lmsSecondary">';
    html += '<div class="lms-secondary-header">' + _escHtml(activeObj ? activeObj.label : '') + '</div>';
    html += '<ul class="lms-secondary-list" role="menu">';
    if (list.length === 0) {
      html += '<li class="lms-empty">本模块暂无功能</li>';
    } else {
      list.forEach(item => {
        const isCurrent = (item.href || '').toLowerCase() === currentPage;
        html += '<li role="none"><a href="' + _escHtml(item.href) + '"' +
                ' class="lms-secondary-item' + (isCurrent ? ' active' : '') + '"' +
                ' role="menuitem">' + _escHtml(item.label) + '</a></li>';
      });
    }
    html += '</ul>';
    html += '</div>';
    html += '</div>'; // .lms-body

    sidebar.innerHTML = html;

    const topnav = document.getElementById('lmsTopnav');
    if (topnav) {
      topnav.addEventListener('click', (e) => {
        const btn = e.target.closest('.lms-group-item');
        if (!btn) return;
        const key = btn.getAttribute('data-group');
        if (key) this.switchGroup(key);
      });
    }

    localStorage.setItem('lms_active_group', activeGroup);
  },

  switchGroup(groupKey) {
    const obj = TOP_LEVEL_GROUPS.find(g => g.key === groupKey);
    if (!obj) return;
    const topnav = document.getElementById('lmsTopnav');
    if (topnav) {
      topnav.querySelectorAll('.lms-group-item').forEach(el => {
        const isActive = el.getAttribute('data-group') === groupKey;
        el.classList.toggle('active', isActive);
        el.setAttribute('aria-current', isActive ? 'true' : 'false');
      });
    }
    const sec = document.getElementById('lmsSecondary');
    if (!sec) return;
    const itemsByGroup = this._groupItems();
    const list = itemsByGroup[groupKey] || [];
    sec.classList.add('lms-fading');
    setTimeout(() => {
      let html = '<div class="lms-secondary-header">' + _escHtml(obj.label) + '</div>';
      html += '<ul class="lms-secondary-list" role="menu">';
      if (list.length === 0) {
        html += '<li class="lms-empty">本模块暂无功能</li>';
      } else {
        list.forEach(item => {
          html += '<li role="none"><a href="' + _escHtml(item.href) + '"' +
                  ' class="lms-secondary-item" role="menuitem">' + _escHtml(item.label) + '</a></li>';
        });
      }
      html += '</ul>';
      sec.innerHTML = html;
      sec.classList.remove('lms-fading');
    }, 100);
    localStorage.setItem('lms_active_group', groupKey);
  },

  /**
   * 渲染一级导航轨上方的"当前登录账号"紧凑条
   *   - 头像（姓名首字符圆形）+ 姓名 + 角色 + 退出按钮
   *   - 始终与品牌栏同色系（半透明白底叠加），保持视觉协调
   *   - 任何页面（包含无权访问遮罩）都能看到自己当前是哪个账号登录
   */
  _renderUserStrip() {
    const name = this.displayName || this.username;
    const initial = (name || '?').trim().charAt(0).toUpperCase();
    const roleLabel = this._roleLabel(this.userRole);
    const isAdmin = this.isAdmin || this.userRole === 'admin';
    const roleBadge = roleLabel
      ? '<span class="lms-brand-role' + (isAdmin ? ' admin' : '') + '">' + _escHtml(roleLabel) + '</span>'
      : '';
    return '<div class="lms-userstrip" title="当前登录账号：' + _escHtml(name) + ' @' + _escHtml(this.username) + '">' +
      '<div class="lms-brand-avatar" aria-hidden="true">' + _escHtml(initial) + '</div>' +
      '<div class="lms-brand-info">' +
        '<div class="lms-brand-uname">' + _escHtml(name) + '</div>' +
        '<div class="lms-brand-meta">' + roleBadge +
          '<span class="lms-brand-username">@' + _escHtml(this.username) + '</span>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="lms-brand-logout" onclick="window.globalLogout && window.globalLogout()" title="退出登录" aria-label="退出登录">' +
        '<span class="lms-brand-logout-icon">⏻</span>' +
      '</button>' +
    '</div>';
  },

  _roleLabel(role) {
    if (!role) return this.isAdmin ? '管理员' : '';
    const map = {
      admin: '管理员',
      manager: '经理',
      sales: '销售',
      rd: '研发',
      production: '生产',
      quality: '品质',
      finance: '财务',
      supply: '供应链',
      viewer: '访客'
    };
    return map[role] || role;
  },

  /**
   * 页面级守卫：<body data-page-perm="xxx">
   *   - 用户有权限 → 正常显示
   *   - 用户无权限 → 用遮罩盖住整个 main，并提示 + 提供"返回仪表盘"按钮
   */
  _enforcePageGuard() {
    const code = document.body && document.body.getAttribute('data-page-perm');
    if (!code) return;
    if (this.has(code)) return;
    // 无权限 → 隐藏主体内容，给个显眼提示
    document.body.setAttribute('data-no-access', '1');
    const main = document.querySelector('.main-content') || document.body;
    let overlay = document.getElementById('pageNoAccessOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pageNoAccessOverlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.96);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;font-family:inherit;';
      overlay.innerHTML = `
        <div style="text-align:center;max-width:480px;padding:30px;border:2px dashed #e74c3c;border-radius:14px;background:#fff;">
          <div style="font-size:56px;color:#e74c3c;line-height:1;">🔒</div>
          <h2 style="margin:14px 0 6px;color:#c0392b;font-size:20px;">无权访问此页面</h2>
          <p style="margin:0 0 6px;color:#555;font-size:13px;">当前账号没有 <code style="background:#fee;color:#c0392b;padding:2px 6px;border-radius:3px;">${_escHtml(code)}</code> 权限</p>
          <p style="margin:0 0 16px;color:#999;font-size:12px;">如需访问，请联系系统管理员分配权限</p>
          <div style="display:flex;gap:8px;justify-content:center;">
            <a href="dashboard.html" style="padding:8px 18px;background:#667eea;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;">← 返回仪表盘</a>
            <button onclick="history.length>1?history.back():(location.href='dashboard.html')" style="padding:8px 18px;background:#e0e0e0;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:13px;">返回上一页</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
  },

  /**
   * 应用权限过滤到页面：
   *   1. data-page-perm : 页面级守卫（无权限则整页遮罩）
   *   2. data-section-perm : 区段级（任意元素），整段隐藏并占位
   *   3. data-perm : 元素级（按钮/链接/操作），隐藏
   */
  applyToPage() {
    this._enforcePageGuard();
    // 区段级
    document.querySelectorAll('[data-section-perm]').forEach(el => {
      const code = el.getAttribute('data-section-perm');
      if (!code || !this.has(code)) {
        el.style.display = 'none';
      }
    });
    // 元素级
    document.querySelectorAll('[data-perm]').forEach(el => {
      const codes = _parsePermList(el.getAttribute('data-perm'));
      if (!codes.length) return;
      const allowed = codes.some(c => this.has(c));
      if (!allowed) el.style.display = 'none';
    });
  },

  /**
   * 监听 DOM 变化，对动态插入的元素即时过滤
   * （弹窗、表格动态行、内联组件等）
   */
  _startFilterObserver() {
    if (this._filterObserver || typeof MutationObserver === 'undefined') return;
    this._filterObserver = new MutationObserver(records => {
      let needsApply = false;
      for (const r of records) {
        r.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          if (n.matches && (n.matches('[data-perm]') || n.matches('[data-section-perm]'))) {
            needsApply = true;
          }
          if (n.querySelectorAll) {
            try {
              if (n.querySelectorAll('[data-perm],[data-section-perm]').length) needsApply = true;
            } catch (_) {}
          }
        });
      }
      if (needsApply) this.applyToPage();
    });
    this._filterObserver.observe(document.documentElement, { childList: true, subtree: true });
  },

  /** 重新拉取权限（用户切换、权限变更后） */
  async refresh() {
    this._itemsByGroup = null;
    this._loadUserInfo();
    await this.loadPermissions();
    this.renderSidebar();
    this.applyToPage();
    this._onChangeCallbacks.forEach(cb => { try { cb(); } catch (_) {} });
  },

  onChange(cb) { this._onChangeCallbacks.push(cb); }
};

window.PermissionCheck = PermissionCheck;

// 全局退出登录：所有页面右上角卡片 + 仪表盘原有按钮均调用此函数
window.globalLogout = function () {
  try {
    localStorage.removeItem('user');
    localStorage.removeItem('currentUserId');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('lms_active_group');
  } catch (_) {}
  window.location.href = 'index.html';
};

// 兼容旧调用：dashboard.html 内的 logout()
window.logout = window.globalLogout;

// 全局 API：scripts that load after PermissionCheck may need to trigger filter after they inject DOM
window.applyPermissionFilter = function () { PermissionCheck.applyToPage(); };