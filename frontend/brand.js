/**
 * 品牌配置模块 - 动态注入系统名称到标题栏和侧边栏
 * 系统名称格式：${system_name}${company_code ? '-' + company_code : ''}
 * 默认：企业经营管理平台（EBMS）-HJ，可通过系统设置修改 company_code 切换为不同公司
 */
(function () {
  const DEFAULT_SYSTEM_NAME = '企业经营管理平台（EBMS）';
  const DEFAULT_COMPANY_CODE = 'HJ';

  const Brand = {
    systemName: DEFAULT_SYSTEM_NAME,
    companyCode: DEFAULT_COMPANY_CODE,
    _loaded: false,
    _loadingPromise: null,

    load() {
      if (this._loaded) return Promise.resolve(this);
      if (this._loadingPromise) return this._loadingPromise;
      const self = this;
      this._loadingPromise = fetch(window.location.origin + '/api/settings/config')
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (cfg) {
          self.systemName = (cfg && cfg.system_name) || DEFAULT_SYSTEM_NAME;
          self.companyCode = (cfg && cfg.company_code) || DEFAULT_COMPANY_CODE;
          self._loaded = true;
          self._apply();
          return self;
        })
        .catch(function () {
          self._loaded = true;
          self._apply();
          return self;
        });
      return this._loadingPromise;
    },

    fullName() {
      let name = this.systemName || DEFAULT_SYSTEM_NAME;
      const code = (this.companyCode || '').trim();
      if (code) name += '-' + code;
      return name;
    },

    shortName() {
      return this.systemName || DEFAULT_SYSTEM_NAME;
    },

    _apply() {
      const pageTitle = document.body && document.body.getAttribute('data-page-title');
      const baseTitle = pageTitle ? this.fullName() + ' - ' + pageTitle : this.fullName();
      document.title = baseTitle;
      if (document.body && document.body.getAttribute('data-brand-injected') !== '1') {
        document.body.setAttribute('data-brand-injected', '1');
      }
    },

    setTitle(pageLabel) {
      const baseName = this.fullName();
      document.title = pageLabel ? (baseName + ' - ' + pageLabel) : baseName;
    }
  };

  window.EBMS = Brand;
  document.addEventListener('DOMContentLoaded', function () {
    Brand.load();
  });
})();
