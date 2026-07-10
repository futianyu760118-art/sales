/**
 * 功能门控模块 - 根据流程规则控制页面功能开关
 * 使用方式：
 * 1. <script src="feature-gate.js"></script>
 * 2. 在元素上添加 data-feature="功能名" 属性，如 data-feature="inline_edit"
 * 3. 模块名通过 data-module 在容器上指定，或自动从 URL 推断
 * 4. 页面加载后调用 FeatureGate.init() 初始化
 *
 * 支持的功能名：
 *   inline_edit, sort, filter, import, export, batch, dashboard, ocr, email, sync,
 *   kpi_cards, charts, quick_actions, activity
 */
const FeatureGate = {
  features: {},
  module: null,
  loaded: false,

  async init(moduleName) {
    this.module = moduleName || this.detectModule();
    await this.loadFeatures();
    this.applyFeatures();
    this.loaded = true;
  },

  detectModule() {
    const container = document.querySelector('[data-module]');
    if (container) return container.getAttribute('data-module');
    const page = window.location.pathname.split('/').pop().replace('.html', '');
    const map = {
      'dashboard': 'dashboard',
      'inquiry': 'inquiry',
      'customer': 'customer',
      'product': 'product',
      'material': 'material',
      'supplier': 'supplier',
      'bom': 'bom',
      'bom-compare': 'bom',
      'order': 'order',
      'sample': 'sample',
      'project': 'project',
      'pricing': 'pricing',
      'quote': 'quote',
      'config': 'config',
      'config-library': 'config',
      'spec-library': 'config',
      'report': 'report'
    };
    return map[page] || page;
  },

  async loadFeatures() {
    try {
      const res = await fetch(`${window.location.origin}/api/rules/features/${this.module}`);
      const data = await res.json();
      this.features = data.features || {};
    } catch (e) {
      console.warn('加载功能规则失败，使用默认全部启用:', e);
      this.features = {};
    }
  },

  isEnabled(featureName) {
    if (!this.loaded) return true;
    if (!(featureName in this.features)) return true;
    return this.features[featureName].enabled !== false;
  },

  applyFeatures() {
    document.querySelectorAll('[data-feature]').forEach(el => {
      const featureName = el.getAttribute('data-feature');
      if (!this.isEnabled(featureName)) {
        el.style.display = 'none';
      }
    });

    document.querySelectorAll('[data-feature-hide]').forEach(el => {
      const featureName = el.getAttribute('data-feature-hide');
      if (this.isEnabled(featureName)) {
        el.style.display = 'none';
      }
    });
  }
};
