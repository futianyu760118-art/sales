/**
 * TableSortFilter - 通用表格排序筛选组件
 * 使用方式：
 * 1. <script src="table-sort-filter.js"></script>
 * 2. 在表格渲染完成后调用 TableSortFilter.init('tableId', options)
 * 3. options = { sortFields: {colIndex: '字段名'}, filterFields: {colIndex: '字段名'} }
 * 4. 也支持 th 上添加 data-sort="字段名" 自动识别排序列
 * 5. 也支持 th 上添加 data-filter="字段名" 自动识别筛选列
 */
const TableSortFilter = {
  instances: {},

  init(tableId, options = {}) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const instance = {
      table,
      sortFields: options.sortFields || {},
      filterFields: options.filterFields || {},
      sortState: {},
      filterState: {},
      originalData: null
    };
    // 自动检测 data-sort 和 data-filter 属性
    const ths = table.querySelectorAll('thead tr:first-child th');
    ths.forEach((th, idx) => {
      if (th.dataset.sort && !instance.sortFields[idx]) instance.sortFields[idx] = th.dataset.sort;
      if (th.dataset.filter && !instance.filterFields[idx]) instance.filterFields[idx] = th.dataset.filter;
    });
    this.instances[tableId] = instance;
    this._injectStyles();
    this._addSortHeaders(instance);
    this._addFilterRow(instance);
    this._updateSeqNumbers(instance);
    return instance;
  },

  _injectStyles() {
    if (document.getElementById('tsf-styles')) return;
    const style = document.createElement('style');
    style.id = 'tsf-styles';
    style.textContent = `
      .tsf-sortable { cursor: pointer; user-select: none; position: relative; padding-right: 18px !important; }
      .tsf-sortable::after { content: '⇅'; position: absolute; right: 4px; top: 50%; transform: translateY(-50%); font-size: 11px; color: #bbb; }
      .tsf-sort-asc::after { content: '↑'; color: #667eea; font-weight: bold; }
      .tsf-sort-desc::after { content: '↓'; color: #667eea; font-weight: bold; }
      .tsf-filter-row td { padding: 3px 4px !important; background: #f5f6fa !important; border-bottom: 2px solid #e0e3eb !important; }
      .tsf-filter-input { width: 100%; padding: 4px 6px; border: 1px solid #dcdfe6; border-radius: 3px; font-size: 12px; background: #fff; transition: border-color 0.2s; }
      .tsf-filter-input:focus { border-color: #667eea; outline: none; box-shadow: 0 0 0 2px rgba(102,126,234,0.15); }
      .tsf-filter-input::placeholder { color: #c0c4cc; font-size: 11px; }
      .tsf-filter-select { width: 100%; padding: 3px 4px; border: 1px solid #dcdfe6; border-radius: 3px; font-size: 12px; background: #fff; cursor: pointer; }
      .tsf-filter-select:focus { border-color: #667eea; outline: none; }
    `;
    document.head.appendChild(style);
  },

  _addSortHeaders(instance) {
    const thead = instance.table.querySelector('thead');
    if (!thead) return;
    const ths = thead.querySelectorAll('th');
    ths.forEach((th, idx) => {
      const field = instance.sortFields[idx];
      if (field) {
        th.classList.add('tsf-sortable');
        th.dataset.sortField = field;
        th.addEventListener('click', () => this._handleSort(instance, idx, field));
      }
    });
  },

  _addFilterRow(instance) {
    const thead = instance.table.querySelector('thead');
    if (!thead) return;
    // 移除旧的筛选行
    const oldFilterRow = thead.querySelector('.tsf-filter-row');
    if (oldFilterRow) oldFilterRow.remove();

    const ths = thead.querySelectorAll('th:first-child') ? thead.querySelector('tr').children : [];
    const colCount = ths.length;
    const filterRow = document.createElement('tr');
    filterRow.classList.add('tsf-filter-row');

    for (let i = 0; i < colCount; i++) {
      const td = document.createElement('td');
      const field = instance.filterFields[i];
      if (field) {
        // 收集该列的唯一值用于下拉筛选
        const values = this._getColumnValues(instance, i);
        if (values.length > 0 && values.length <= 50) {
          const select = document.createElement('select');
          select.classList.add('tsf-filter-select');
          select.innerHTML = `<option value="">全部</option>` + values.map(v =>
            `<option value="${this._escapeHtml(String(v))}">${this._escapeHtml(String(v))}</option>`
          ).join('');
          select.dataset.filterCol = i;
          select.addEventListener('change', () => this._handleFilter(instance));
          td.appendChild(select);
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.classList.add('tsf-filter-input');
          input.placeholder = '筛选...';
          input.dataset.filterCol = i;
          input.addEventListener('input', () => this._handleFilter(instance));
          td.appendChild(input);
        }
      }
      filterRow.appendChild(td);
    }
    thead.appendChild(filterRow);
  },

  _getColumnValues(instance, colIdx) {
    const tbody = instance.table.querySelector('tbody');
    if (!tbody) return [];
    const values = new Set();
    tbody.querySelectorAll('tr').forEach(tr => {
      const td = tr.children[colIdx];
      if (td) {
        const text = td.textContent.trim();
        if (text && text !== '-') values.add(text);
      }
    });
    return [...values].sort();
  },

  _handleSort(instance, colIdx, field) {
    const state = instance.sortState[field];
    // 循环: null -> asc -> desc -> null
    if (!state) instance.sortState[field] = 'asc';
    else if (state === 'asc') instance.sortState[field] = 'desc';
    else delete instance.sortState[field];

    // 更新表头样式
    const ths = instance.table.querySelectorAll('thead tr:first-child th');
    ths.forEach(th => th.classList.remove('tsf-sort-asc', 'tsf-sort-desc'));
    const currentTh = ths[colIdx];
    if (instance.sortState[field] === 'asc') currentTh.classList.add('tsf-sort-asc');
    else if (instance.sortState[field] === 'desc') currentTh.classList.add('tsf-sort-desc');

    this._applySortAndFilter(instance);
  },

  _handleFilter(instance) {
    this._applySortAndFilter(instance);
  },

  _applySortAndFilter(instance) {
    const tbody = instance.table.querySelector('tbody');
    if (!tbody) return;
    let rows = Array.from(tbody.querySelectorAll('tr'));

    // 筛选
    const filterInputs = instance.table.querySelectorAll('.tsf-filter-select, .tsf-filter-input');
    filterInputs.forEach(input => {
      const colIdx = parseInt(input.dataset.filterCol);
      const value = input.value.trim().toLowerCase();
      if (!value) return;
      rows = rows.filter(tr => {
        const td = tr.children[colIdx];
        if (!td) return true;
        return td.textContent.trim().toLowerCase().includes(value);
      });
    });

    // 排序
    const sortEntries = Object.entries(instance.sortState);
    if (sortEntries.length > 0) {
      rows.sort((a, b) => {
        for (const [field, dir] of sortEntries) {
          const colIdx = Object.entries(instance.sortFields).find(([i, f]) => f === field);
          if (!colIdx) continue;
          const idx = parseInt(colIdx[0]);
          const aTd = a.children[idx];
          const bTd = b.children[idx];
          let cmp = 0;
          if (aTd && bTd) {
            const aNumAttr = aTd.dataset.num;
            const bNumAttr = bTd.dataset.num;
            const aTimeAttr = aTd.dataset.time;
            const bTimeAttr = bTd.dataset.time;
            if (aNumAttr !== undefined && bNumAttr !== undefined) {
              cmp = parseFloat(aNumAttr) - parseFloat(bNumAttr);
            } else if (aTimeAttr !== undefined && bTimeAttr !== undefined) {
              cmp = aTimeAttr.localeCompare(bTimeAttr);
            } else {
              const aVal = aTd.textContent.trim();
              const bVal = bTd.textContent.trim();
              const aNum = parseFloat(aVal.replace(/[¥$,]/g, ''));
              const bNum = parseFloat(bVal.replace(/[¥$,]/g, ''));
              if (!isNaN(aNum) && !isNaN(bNum)) {
                cmp = aNum - bNum;
              } else {
                cmp = aVal.localeCompare(bVal, 'zh-CN');
              }
            }
          }
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }

    const allRows = Array.from(tbody.querySelectorAll('tr'));
    const visibleSet = new Set(rows);
    rows.forEach(tr => tbody.appendChild(tr));
    allRows.forEach(tr => {
      if (!visibleSet.has(tr)) {
        tr.style.display = 'none';
        tbody.appendChild(tr);
      } else {
        tr.style.display = '';
      }
    });

    this._updateSeqNumbers(instance);
  },

  _updateSeqNumbers(instance) {
    const tbody = instance.table.querySelector('tbody');
    if (!tbody) return;
    let seq = 0;
    Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
      if (tr.style.display === 'none') return;
      seq++;
      const seqTd = tr.querySelector('.seq-col');
      if (seqTd) seqTd.textContent = seq;
    });
  },

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  // 刷新筛选下拉选项（数据变化后调用）
  refresh(tableId) {
    const instance = this.instances[tableId];
    if (!instance) return;
    instance.sortState = {};
    instance.filterState = {};
    const ths = instance.table.querySelectorAll('thead tr:first-child th');
    ths.forEach(th => th.classList.remove('tsf-sort-asc', 'tsf-sort-desc'));
    const tbody = instance.table.querySelector('tbody');
    if (tbody) tbody.querySelectorAll('tr').forEach(tr => tr.style.display = '');
    this._addFilterRow(instance);
    this._updateSeqNumbers(instance);
  }
};
