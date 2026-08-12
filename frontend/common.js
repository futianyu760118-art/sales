/**
 * common.js - 全局通用工具
 * 提供 esc() HTML 转义、XSS 防护、可搜索下拉 (SSelect) 等
 */
(function(window){
  // HTML 转义（防 XSS）
  function esc(s){
    if(s==null)return'';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  // 截断
  function trunc(s,n){
    s=String(s==null?'':s);
    return s.length>n?s.slice(0,n)+'…':s;
  }
  // 安全 URL（仅 http/https）
  function safeUrl(url){
    if(!url)return'';
    var s=String(url).trim();
    if(/^https?:\/\//i.test(s))return s;
    return'';
  }
  // CSV 公式注入防护
  function csvSafe(s){
    if(s==null)return'';
    s=String(s);
    if(s.length>0&&/^[=+\-@\t\r]/.test(s))return"'"+s;
    return s;
  }
  window.esc=esc;window.trunc=trunc;window.safeUrl=safeUrl;window.csvSafe=csvSafe;
  // 兼容已有 escHtml 别名
  window.escHtml=esc;

  // ============================================================
  // 可搜索下拉 SSelect
  // ------------------------------------------------------------
  // 用法：给 <select> 加 data-searchable="1"，页面加载后调用
  //     SSelect.upgradeAll() 即可批量升级。
  // 也可单独调用 SSelect.upgrade(el) 升级一个元素。
  // 保持原生 <select> 在 DOM 中（隐藏），保留所有表单能力；
  // 当 JS 代码用 innerHTML 重写 select 的 options 后，调用
  // SSelect.refresh(selectEl) 同步下拉面板。
  // ============================================================
  var SSelectInstances = new WeakMap();
  var SSelect = {
    upgrade: function(selectEl){
      if(!selectEl || selectEl.dataset.ssUpgraded === '1') return SSelectInstances.get(selectEl);
      selectEl.dataset.ssUpgraded = '1';
      selectEl.classList.add('ss-hidden');

      var wrap = document.createElement('div');
      wrap.className = 'ss-wrap';
      var display = document.createElement('div');
      display.className = 'ss-display';
      display.tabIndex = 0;
      var dropdown = document.createElement('div');
      dropdown.className = 'ss-dropdown';
      dropdown.style.display = 'none';
      dropdown.innerHTML = '<input type="text" class="ss-search" placeholder="输入关键字过滤…"><ul class="ss-list"></ul><div class="ss-empty" style="display:none;">无匹配项</div><div class="ss-footer"><span class="ss-count">0 条</span><span><kbd>↑↓</kbd> 选择 <kbd>Enter</kbd> 确认 <kbd>Esc</kbd> 关闭</span></div>';
      wrap.appendChild(display);
      wrap.appendChild(dropdown);
      selectEl.parentNode.insertBefore(wrap, selectEl);
      wrap.appendChild(selectEl);

      var searchInput = dropdown.querySelector('.ss-search');
      var listEl = dropdown.querySelector('.ss-list');
      var emptyEl = dropdown.querySelector('.ss-empty');
      var countEl = dropdown.querySelector('.ss-count');

      function refresh(){
        var kw = (searchInput.value || '').toLowerCase().trim();
        listEl.innerHTML = '';
        var total = 0, shown = 0;
        var frag = document.createDocumentFragment();
        Array.from(selectEl.options).forEach(function(opt){
          total++;
          var text = opt.textContent || '';
          var val = opt.value;
          if (kw && text.toLowerCase().indexOf(kw) === -1 && String(val).toLowerCase().indexOf(kw) === -1) return;
          shown++;
          var li = document.createElement('li');
          li.className = 'ss-item';
          li.dataset.value = val;
          if (val === selectEl.value) li.classList.add('selected');
          if (kw) {
            var t = text.toLowerCase();
            var i = t.indexOf(kw);
            if (i >= 0) {
              li.innerHTML = esc(text.substring(0, i)) + '<mark>' + esc(text.substring(i, i + kw.length)) + '</mark>' + esc(text.substring(i + kw.length));
            } else {
              li.textContent = text;
            }
          } else {
            li.textContent = text;
          }
          li.addEventListener('click', function(){
            selectEl.value = val;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            updateDisplay();
            close();
          });
          frag.appendChild(li);
        });
        listEl.appendChild(frag);
        emptyEl.style.display = shown === 0 ? 'block' : 'none';
        countEl.textContent = total ? (kw ? (shown + ' / ' + total) : (total + ' 条')) : '0 条';
        updateDisplay();
      }

      function updateDisplay(){
        var opt = selectEl.options[selectEl.selectedIndex];
        if (opt) {
          display.textContent = opt.textContent || '';
          display.classList.remove('placeholder');
          display.classList.toggle('disabled', !!opt.disabled || !!selectEl.disabled);
        } else {
          display.textContent = display.dataset.placeholder || '';
          display.classList.add('placeholder');
        }
        display.classList.toggle('disabled', !!selectEl.disabled);
      }

      function open(){
        document.querySelectorAll('.ss-dropdown').forEach(function(d){ if (d !== dropdown) d.style.display = 'none'; });
        dropdown.style.display = 'flex';
        searchInput.value = '';
        refresh();
        // 自动滚动到当前选中
        var sel = listEl.querySelector('.ss-item.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
        setTimeout(function(){ searchInput.focus(); searchInput.select(); }, 0);
      }
      function close(){ dropdown.style.display = 'none'; }

      function selectActive(delta){
        var items = Array.from(listEl.querySelectorAll('.ss-item'));
        if (!items.length) return;
        var idx = items.findIndex(function(li){ return li.classList.contains('active'); });
        items.forEach(function(li){ li.classList.remove('active'); });
        if (idx < 0) idx = 0;
        else idx = (idx + delta + items.length) % items.length;
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      }

      display.addEventListener('click', function(){
        if (selectEl.disabled) return;
        if (dropdown.style.display === 'none') open(); else close();
      });
      display.addEventListener('keydown', function(e){
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); open(); }
      });
      searchInput.addEventListener('input', refresh);
      searchInput.addEventListener('keydown', function(e){
        if (e.key === 'Escape') { close(); display.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); selectActive(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); selectActive(-1); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          var active = listEl.querySelector('.ss-item.active') || listEl.querySelector('.ss-item');
          if (active) active.click();
        }
        else if (e.key === 'Tab') { close(); }
      });
      document.addEventListener('click', function(e){
        if (!wrap.contains(e.target)) close();
      });

      // 当原生 select 的 value 被代码改动时同步显示
      var observer = new MutationObserver(function(){
        refresh();
      });
      observer.observe(selectEl, { childList: true, subtree: true, attributes: true });

      // 占位提示：取第一个 option（如果值为空）
      var firstOpt = selectEl.options[0];
      if (firstOpt && !firstOpt.value) {
        display.dataset.placeholder = firstOpt.textContent || '请选择';
      }

      var instance = { refresh: refresh, updateDisplay: updateDisplay, open: open, close: close, wrap: wrap };
      SSelectInstances.set(selectEl, instance);
      refresh();
      return instance;
    },
    refresh: function(selectEl){
      var inst = SSelectInstances.get(selectEl);
      if (inst) inst.refresh();
    },
    upgradeAll: function(scope){
      scope = scope || document;
      var sels = scope.querySelectorAll('select[data-searchable="1"]');
      sels.forEach(function(s){ SSelect.upgrade(s); });
      return sels.length;
    }
  };
  window.SSelect = SSelect;

  // ============================================================
  // fillSelect 兼容性钩子：如果页面已经有 fillSelect 函数，
  // 包一层，调用后对 data-searchable 的下拉自动 refresh。
  // ============================================================
  function _wrapFillSelect(){
    if (typeof window.fillSelect !== 'function' || window.fillSelect.__ssWrapped) return;
    var orig = window.fillSelect;
    var wrapped = function(id, items, defaultLabel, includeEmpty){
      orig(id, items, defaultLabel, includeEmpty);
      var el = document.getElementById(id);
      if (el && el.dataset && el.dataset.ssUpgraded === '1') {
        SSelect.refresh(el);
      }
    };
    wrapped.__ssWrapped = true;
    window.fillSelect = wrapped;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wrapFillSelect);
  } else {
    _wrapFillSelect();
  }

  // ============================================================
  // 自动升级：监听 DOM 新出现的 data-searchable 下拉并自动包装。
  // 适配 DictLoader.fillAll 等异步填充场景。
  // ============================================================
  function _startAutoUpgrade(){
    if (window.__ssAutoUpgrade) return;
    window.__ssAutoUpgrade = true;
    // 先升级 DOMContentLoaded 时的现有节点（处理同步 HTML）
    var upgradeExisting = function(){
      var existing = document.querySelectorAll('select[data-searchable="1"]:not([data-ss-upgraded="1"])');
      existing.forEach(function(s){ SSelect.upgrade(s); });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', upgradeExisting);
    } else {
      upgradeExisting();
    }
    // 再用 MutationObserver 处理后续新增的节点
    var mo = new MutationObserver(function(records){
      records.forEach(function(r){
        r.addedNodes.forEach(function(n){
          if (n.nodeType !== 1) return;
          if (n.tagName === 'SELECT' && n.dataset && n.dataset.searchable === '1') {
            SSelect.upgrade(n);
          }
          if (n.querySelectorAll) {
            var subs = n.querySelectorAll('select[data-searchable="1"]:not([data-ss-upgraded="1"])');
            subs.forEach(function(s){ SSelect.upgrade(s); });
          }
        });
      });
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _startAutoUpgrade);
  } else {
    _startAutoUpgrade();
  }


  // 每页显示行数工具
  window._pageSize = window._pageSize || 10;
  function pageSizeSelect(opts) {
    opts = opts || {};
    var def = opts.default || window._pageSize || 10;
    var choices = opts.choices || [10, 20, 50, 100, 200];
    var html = '<select id="pageSizeSel" style="padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;margin-left:auto" title="每页显示行数">' +
      choices.map(function(n){return '<option value="'+n+'"'+(n===def?' selected':'')+'>'+n+' 条/页</option>'}).join('') + '</select>';
    return html;
  }
  function bindPageSizeSelect(onChange) {
    var el = document.getElementById('pageSizeSel');
    if (el) el.addEventListener('change', function(){ window._pageSize = parseInt(this.value); if (onChange) onChange(); });
  }
})(window);