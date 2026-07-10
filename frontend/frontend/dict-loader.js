/**
 * 数据字典加载工具
 * 从系统设置模块加载数据字典，动态填充下拉选项
 */
const DictLoader = {
  _cache: {},
  API: window.location.origin + '/api',

  /**
   * 加载指定分组的字典项
   * @param {string} groupCode 分组编码
   * @returns {Array} 字典项数组 [{code, value, sort, enabled, remark}]
   */
  async load(groupCode) {
    if (this._cache[groupCode]) return this._cache[groupCode];
    try {
      const res = await fetch(`${this.API}/settings/dictionary/${groupCode}`);
      const items = await res.json();
      this._cache[groupCode] = items;
      return items;
    } catch(e) {
      console.warn('字典加载失败:', groupCode, e);
      return [];
    }
  },

  /**
   * 填充select元素
   * @param {string|HTMLElement} selectEl select元素或其id
   * @param {string} groupCode 字典分组编码
   * @param {object} options 选项 {placeholder: '请选择', selectedValue: ''}
   */
  async fillSelect(selectEl, groupCode, options = {}) {
    const el = typeof selectEl === 'string' ? document.getElementById(selectEl) : selectEl;
    if (!el) return;

    const items = await this.load(groupCode);
    const enabledItems = items.filter(i => i.enabled);
    const { placeholder = '请选择', selectedValue = '' } = options;

    // 保留第一个placeholder选项
    const firstOpt = el.querySelector('option[value=""]');
    el.innerHTML = '';
    if (firstOpt || placeholder) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = placeholder;
      el.appendChild(opt);
    }

    enabledItems.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.value;
      if (item.value === selectedValue) opt.selected = true;
      el.appendChild(opt);
    });

    return enabledItems;
  },

  /**
   * 填充datalist元素（支持自由输入+下拉选择）
   * @param {string|HTMLElement} datalistEl datalist元素或其id
   * @param {string} groupCode 字典分组编码
   */
  async fillDatalist(datalistEl, groupCode) {
    const el = typeof datalistEl === 'string' ? document.getElementById(datalistEl) : datalistEl;
    if (!el) return;
    const items = await this.load(groupCode);
    el.innerHTML = '';
    items.filter(i => i.enabled).forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.value;
      el.appendChild(opt);
    });
    return items;
  },

  /**
   * 批量填充多个select
   * @param {Array} configs [{select: id|el, group: groupCode, placeholder, selectedValue}]
   */
  async fillAll(configs) {
    return Promise.all(configs.map(c => this.fillSelect(c.select, c.group, c)));
  },

  /** 清除缓存 */
  clearCache() { this._cache = {}; }
};
