/**
 * 权限检查模块 - 各页面引入此脚本即可控制按钮可见性和侧边栏菜单
 * 使用方式：
 * 1. <script src="permission-check.js"></script>
 * 2. 在按钮上添加 data-perm="权限编码" 属性，如 data-perm="inquiry:create"
 * 3. 页面加载后调用 PermissionCheck.init(userId) 初始化
 * 4. 也可以手动调用 PermissionCheck.has('inquiry:create') 检查权限
 * 5. 侧边栏自动根据权限渲染，无需手动处理
 */

// 全局拦截 fetch，自动注入当前登录用户标识，后端据此进行权限校验
(function () {
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const uid = localStorage.getItem('currentUserId');
    if (uid) {
      init = init || {};
      let headers = init.headers;
      if (headers instanceof Headers) {
        if (!headers.has('x-user-id')) headers.set('x-user-id', uid);
      } else if (headers && typeof headers === 'object') {
        if (!headers['x-user-id']) headers['x-user-id'] = uid;
      } else {
        headers = { 'x-user-id': uid };
      }
      init.headers = headers;
    }
    return _fetch.call(this, input, init);
  };
})();

const PermissionCheck = {
  userId: null,
  permissions: null, // null=未加载, Set=已加载
  isAdmin: false,

  sidebarItems: [
    { href: 'dashboard.html', label: '仪表盘', perm: null },
    { href: 'inquiry.html', label: '询价管理', perm: 'inquiry:view' },
    { href: 'customer.html', label: '客户管理', perm: 'customer:view' },
    { href: 'product.html', label: '产品管理', perm: 'product:view' },
    { href: 'material.html', label: '物料库', perm: 'material:view' },
    { href: 'procurement.html', label: '采购管理', perm: 'material:view' },
    { href: 'supplier.html', label: '供应商管理', perm: 'supplier:view' },
    { href: 'bom.html', label: 'BOM管理', perm: 'bom:view' },
    { href: 'order.html', label: '订单管理', perm: 'order:view' },
    { href: 'sample.html', label: '样品管理', perm: 'sample:view' },
    { href: 'project.html', label: '项目管理', perm: 'project:view' },
    { href: 'tech-transfer.html', label: '项目技转', perm: 'tech:view' },
    { href: 'bom-compare.html', label: 'BOM对比', perm: 'bom-compare:view' },
    { href: 'pricing.html', label: '核价表', perm: 'pricing:view' },
    { href: 'quote.html', label: '报价库', perm: 'quote:view' },
    { href: 'config.html', label: '产品配置表', perm: 'config:view' },
    { href: 'spec-library.html', label: '规格书库', perm: 'spec:view' },
    { href: 'config-library.html', label: '配置表库', perm: 'config-lib:view' },
    { href: 'report.html', label: '数据报表', perm: 'report:view' },
    { href: 'permission.html', label: '权限管理', perm: 'system:permission' },
    { href: 'organization.html', label: '组织模块', perm: 'org:view' },
    { href: 'feedback.html', label: '问题反馈', perm: 'feedback:create' },
    { href: 'settings.html', label: '系统设置', perm: 'system:config' },
    { href: 'rules.html', label: '流程规则', perm: 'rules:view' },
    { href: 'compliance.html', label: '合规自检', perm: 'compliance:view' },
    { href: 'data-clean.html', label: '数据清洗', perm: 'data-clean:view' },
    { href: 'ai-assistant.html', label: '智能助手', perm: 'ai:view' },
    { href: 'test.html', label: '自动测试', perm: 'test:view' }
  ],

  async init(userId) {
    if (!userId) {
      userId = localStorage.getItem('currentUserId');
    }
    if (!userId) {
      // 未登录，跳转登录页（登录需输入用户名和密码）
      window.location.href = 'index.html';
      return;
    }
    this.userId = userId;
    await this.loadPermissions();
    this.renderSidebar();
    this.applyToPage();
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

  renderSidebar() {
    const sidebar = document.getElementById('sidebar') || document.querySelector('.sidebar');
    if (!sidebar) return;
    sidebar.id = 'sidebar';

    const currentPage = window.location.pathname.split('/').pop() || 'dashboard.html';

    let html = '<h1>销售快捷服务系统</h1><ul>';
    for (const item of this.sidebarItems) {
      if (item.perm && !this.has(item.perm)) continue;
      const active = currentPage === item.href ? ' class="active"' : '';
      html += `<li><a href="${item.href}"${active}>${item.label}</a></li>`;
    }
    html += '</ul>';
    sidebar.innerHTML = html;
  },

  applyToPage() {
    document.querySelectorAll('[data-perm]').forEach(el => {
      const code = el.getAttribute('data-perm');
      if (!this.has(code)) {
        el.style.display = 'none';
      }
    });
  }
};
