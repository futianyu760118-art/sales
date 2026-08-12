/**
 * 数据权限（Data Scope）前端助手
 * ----------------------------------------------------------------
 *  - 读取 /api/data-scope/my-scope 并在所有销售页头部展示"我的客户 / 本部门客户 / 全部销售客户"
 *  - 暴露 PermissionCheck.dataScope 全局对象
 *  - 不参与权限判定（仅展示用），真实安全由后端保证
 *  - 销售员离职 / 客户转移：调用 /api/data-scope/customer/transfer
 */

(function () {
  const DataScope = {
    _scope: null,
    _loaded: false,

    label() {
      if (!this._scope) return '全部数据';
      return this._scope.label || '全部数据';
    },
    mode() {
      if (!this._scope) return 'all';
      return this._scope.mode || 'all';
    },

    async load(userId) {
      if (!userId) userId = localStorage.getItem('currentUserId');
      if (!userId) { this._scope = { mode: 'all', label: '全部数据' }; return this._scope; }
      try {
        const res = await fetch(`${window.location.origin}/api/data-scope/my-scope?user_id=${encodeURIComponent(userId)}`, {
          headers: { 'x-user-id': String(userId) }
        });
        const data = await res.json();
        this._scope = data || { mode: 'all', label: '全部数据' };
        this._loaded = true;
        return this._scope;
      } catch (e) {
        console.warn('加载数据范围失败:', e);
        this._scope = { mode: 'all', label: '全部数据' };
        return this._scope;
      }
    },

    /**
     * 在 .search-bar / 列表头插入 scope 横幅
     * 调用：DataScope.renderBanner('.search-bar') 或 DataScope.renderBanner('.toolbar')
     */
    renderBanner(selector) {
      const list = document.querySelectorAll(selector);
      if (!list || list.length === 0) return;
      const colorMap = {
        all:           { bg: '#e8f5e9', fg: '#1b5e20', icon: '✓' },
        self:          { bg: '#e3f2fd', fg: '#0d47a1', icon: '☻' },
        dept:          { bg: '#fff3e0', fg: '#e65100', icon: '◴' },
        dept_and_child:{ bg: '#fff3e0', fg: '#e65100', icon: '◴' },
        custom:        { bg: '#f3e5f5', fg: '#4a148c', icon: '◆' }
      };
      const c = colorMap[this.mode()] || colorMap.all;
      const html = `<div class="ds-banner" style="
        display: inline-flex; align-items: center; gap: 6px;
        background: ${c.bg}; color: ${c.fg};
        padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;
        margin-left: 8px;
      ">
        <span style="font-size: 14px;">${c.icon}</span>
        <span>数据范围：${this.label()}</span>
      </div>`;
      list.forEach(el => {
        if (el.querySelector('.ds-banner')) return;
        const wrap = document.createElement('span');
        wrap.innerHTML = html;
        el.appendChild(wrap.firstChild);
      });
    },

    /**
     * 客户转移：单客户或批量
     * @param {object} opts  { customerIds, toUserId, transferOrders, transferProjects, remark }
     * @returns {Promise<{transferred:number,...}>}
     */
    async transferCustomer(opts) {
      const { customerIds, toUserId, transferOrders = false, transferProjects = false, remark = '' } = opts || {};
      if (!customerIds || customerIds.length === 0) throw new Error('未选择客户');
      if (!toUserId) throw new Error('未指定新负责人');
      const userId = localStorage.getItem('currentUserId');
      const res = await fetch(`${window.location.origin}/api/data-scope/customer/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId || '' },
        body: JSON.stringify({
          customer_ids: customerIds, to_user_id: toUserId,
          transfer_orders: transferOrders, transfer_projects: transferProjects, remark,
          user_id: userId
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '转移失败');
      return data;
    },

    /**
     * 打开转移弹窗（在销售类页面使用）
     * @param {Array<number>} customerIds
     * @param {function} onDone 转移完成后的回调（重新加载列表等）
     */
    async openTransferDialog(customerIds, onDone) {
      if (!customerIds || customerIds.length === 0) {
        alert('请先选择客户'); return;
      }
      const userId = localStorage.getItem('currentUserId');
      let emps = [];
      try {
        const res = await fetch(`${window.location.origin}/api/data-scope/employees?user_id=${encodeURIComponent(userId)}`, {
          headers: { 'x-user-id': userId || '' }
        });
        const data = await res.json();
        emps = data.data || [];
      } catch (e) {
        alert('加载员工列表失败：' + e.message); return;
      }
      if (emps.length === 0) { alert('没有可选的员工'); return; }
      const opts = emps.map(e => `<option value="${e.id}">${e.name}（${e.department_name || '未关联部门'}）</option>`).join('');
      const html = `<div id="dsTransferModal" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999;display:flex;align-items:center;justify-content:center;">
        <div style="background:#fff;border-radius:8px;padding:20px;width:480px;max-width:90%;">
          <h3 style="margin-top:0;">客户转移</h3>
          <p>已选择 <b>${customerIds.length}</b> 个客户。转移给：</p>
          <select id="dsToUser" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;">${opts}</select>
          <div style="margin-top:10px;">
            <label><input type="checkbox" id="dsTransferOrders" checked> 同时转移这些客户的订单</label>
          </div>
          <div style="margin-top:6px;">
            <label><input type="checkbox" id="dsTransferProjects" checked> 同时转移这些客户的项目</label>
          </div>
          <div style="margin-top:10px;">
            <textarea id="dsTransferRemark" placeholder="备注（可选）" style="width:100%;height:60px;padding:8px;border:1px solid #ddd;border-radius:4px;"></textarea>
          </div>
          <div style="margin-top:14px;text-align:right;">
            <button id="dsCancel" style="padding:6px 14px;margin-right:8px;">取消</button>
            <button id="dsConfirm" style="padding:6px 14px;background:#667eea;color:#fff;border:none;border-radius:4px;cursor:pointer;">确认转移</button>
          </div>
        </div>
      </div>`;
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      document.body.appendChild(wrap);
      const close = () => document.body.removeChild(wrap);
      document.getElementById('dsCancel').onclick = close;
      document.getElementById('dsConfirm').onclick = async () => {
        const toUserId = Number(document.getElementById('dsToUser').value);
        const transferOrders = document.getElementById('dsTransferOrders').checked;
        const transferProjects = document.getElementById('dsTransferProjects').checked;
        const remark = document.getElementById('dsTransferRemark').value;
        try {
          const r = await this.transferCustomer({ customerIds, toUserId, transferOrders, transferProjects, remark });
          alert(`已转移 ${r.transferred} 个客户；订单 ${r.orders_transferred} 个；项目 ${r.projects_transferred} 个`);
          close();
          if (typeof onDone === 'function') onDone(r);
        } catch (e) {
          alert('转移失败：' + e.message);
        }
      };
    }
  };

  window.DataScope = DataScope;
  // 暴露给 PermissionCheck
  if (window.PermissionCheck) {
    window.PermissionCheck.dataScope = DataScope;
  }
})();
