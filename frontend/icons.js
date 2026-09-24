/*
 * EBMS local SVG icon registry.
 * No external font, CDN, or platform-dependent glyph is required.
 */
(function (root, factory) {
  const api = factory();
  if (root) root.EBMSIcons = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const tokens = Object.freeze({
    xs: '14px',
    sm: '16px',
    md: '20px',
    lg: '24px',
    xl: '40px'
  });

  const paths = Object.freeze({
    home: '<path d="M3.5 10.5 12 3l8.5 7.5v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/><path d="M9 20.5v-6h6v6"/>',
    business: '<rect x="3.5" y="5" width="17" height="15.5" rx="1.5"/><path d="M8 5V3.5h8V5M7.5 10h9M7.5 14h9M7.5 17h5"/>',
    sales: '<path d="M4 19.5h16M6 17v-3M10 17V9M14 17V6M18 17v-5"/><path d="m5 10 4-4 4 2 5-5"/>',
    rd: '<path d="M9 3.5h6M10 3.5v5l-5.5 9.2a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 8.5v-5"/><path d="M7.5 15h9"/>',
    flask: '<path d="M9 3.5h6M10 3.5v6l-5 8.2a2 2 0 0 0 1.7 2.8h10.6a2 2 0 0 0 1.7-2.8L14 9.5v-6"/><path d="M7.5 15h9"/>',
    supply: '<path d="M3.5 6.5h10v10h-10zM13.5 10h3l4 4v2.5h-7z"/><circle cx="7" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/>',
    production: '<path d="M3.5 20V8.5l5-3v3l5-3v3l5-3V20z"/><path d="M7 13h2M7 16h2M13 13h2M13 16h2"/>',
    quality: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.6 2.7L16.5 9"/>',
    report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    system: '<path d="M12 3.5 13.5 5l2.1-.3.8 1.9 1.9.8-.3 2.1 1.5 1.5-1.5 1.5.3 2.1-1.9.8-.8 1.9-2.1-.3-1.5 1.5-1.5-1.5-2.1.3-.8-1.9-1.9-.8.3-2.1L4.5 11l1.5-1.5-.3-2.1 1.9-.8.8-1.9 2.1.3z"/><circle cx="12" cy="11" r="2.8"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
    notification: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8.5h18C21 16 18 16 18 9ZM10 21h4"/>',
    ai: '<path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
    learning: '<path d="M4 5.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2z"/><path d="M8 8h7M8 12h7M8 16h4"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
    plus: '<path d="M12 4v16M4 12h16"/>',
    minus: '<path d="M4 12h16"/>',
    chat: '<path d="M4 5.5h16v10H9l-5 4v-14Z"/><path d="M8 9.5h8M8 12.5h5"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.4 3-5 7-5s6.3 1.6 7 5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="1.5"/><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17M7.5 13h3M13.5 13h3M7.5 17h3"/>',
    upload: '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M5 14v5h14v-5"/>',
    download: '<path d="M12 4v12M7.5 11.5 12 16l4.5-4.5M5 14v5h14v-5"/>',
    warning: '<path d="m12 3 9 17H3z"/><path d="M12 9v5M12 17.5v.1"/>',
    success: '<circle cx="12" cy="12" r="8.5"/><path d="m8 12 2.6 2.7L16.5 9"/>',
    empty: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h5M8 17h3"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevron: '<path d="m7 9 5 5 5-5"/>',
    expand: '<path d="m9 6 6 6-6 6"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/>',
    file: '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 16h6"/>',
    folder: '<path d="M3.5 6.5h6l1.5 2h9.5v10.5h-17z"/>',
    package: '<path d="m4 8 8-4 8 4-8 4zM4 8v8l8 4 8-4V8M12 12v8"/>',
    money: '<rect x="4" y="6" width="16" height="12" rx="1.5"/><circle cx="12" cy="12" r="2.5"/><path d="M7 9h.1M17 15h.1"/>',
    analytics: '<path d="M4 19.5V5M4 19.5h16"/><path d="m7 15 3-3 2 1 5-6"/>',
    filter: '<path d="M4 5h16l-6 7v6l-4 1v-7z"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4L4 9"/><path d="M4 5v4h4M4 13a8 8 0 0 0 14.5 4l1.5-2"/><path d="M20 19v-4h-4"/>',
    link: '<path d="m9.5 14.5 5-5M8 17H6.5a4 4 0 0 1 0-8H10M14 7h3.5a4 4 0 0 1 0 8H14"/>',
    pin: '<path d="m15 4 5 5-3 1-3 5-2-2-5 3 3-5-2-2 5-3zM12 15l-3 5"/>',
    mute: '<path d="M4 10v4h3l4 3V7l-4 3zM16 10l4 4M20 10l-4 4"/>',
    trash: '<path d="M5 7h14M10 4h4l1 3H9zM7 7l1 13h8l1-13M10 10v7M14 10v7"/>',
    send: '<path d="m3 4 18 8-18 8 3.5-8zM6.5 12H21"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    arrowRight: '<path d="M4 12h15M14 6l6 6-6 6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>'
    ,logout: '<path d="M14 5h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4M10 16l4-4-4-4M14 12H3"/>'
  });

  function escapeAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function normalizeSize(size) {
    return Object.prototype.hasOwnProperty.call(tokens, size) ? size : 'md';
  }

  const api = {
    tokens,
    names: Object.freeze(Object.keys(paths)),
    render(name, options) {
      const opts = options || {};
      const iconName = Object.prototype.hasOwnProperty.call(paths, name) ? name : 'empty';
      const size = normalizeSize(opts.size);
      const classes = ['ebms-icon', 'ebms-icon--' + size];
      if (opts.className) classes.push(String(opts.className).replace(/[^a-zA-Z0-9_ -]/g, ''));
      const label = opts.label || opts.title || '';
      const aria = label ? ' aria-label="' + escapeAttr(label) + '" role="img"' : ' aria-hidden="true"';
      const title = opts.title ? '<title>' + escapeAttr(opts.title) + '</title>' : '';
      return '<svg class="' + classes.join(' ') + '" data-icon="' + iconName + '" width="' + tokens[size] + '" height="' + tokens[size] + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" focusable="false"' + aria + '>' + title + paths[iconName] + '</svg>';
    },
    text(name, options) {
      return this.render(name, options);
    },
    mount(root) {
      if (typeof document === 'undefined') return 0;
      const scope = root || document;
      const nodes = scope.querySelectorAll ? scope.querySelectorAll('[data-icon]:not([data-icon-mounted]):not(svg)') : [];
      let count = 0;
      Array.from(nodes).forEach((node) => {
        const name = node.getAttribute('data-icon');
        const size = node.getAttribute('data-icon-size') || 'md';
        const label = node.getAttribute('aria-label') || node.getAttribute('title') || '';
        node.innerHTML = api.render(name, { size, label, title: node.getAttribute('title') || '' });
        node.setAttribute('data-icon-mounted', 'true');
        count += 1;
      });
      return count;
    }
  };
  if (typeof document !== 'undefined') {
    const mount = () => api.mount(document);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
    if (typeof MutationObserver !== 'undefined') {
      let mounting = false;
      new MutationObserver((records) => records.forEach((record) => Array.from(record.addedNodes).forEach((node) => {
        if (mounting) return;
        if (node.nodeType !== 1) return;
        const hasUnMountedIcon = (node.matches && node.matches('[data-icon]:not([data-icon-mounted]):not(svg)')) ||
          (node.querySelector && node.querySelector('[data-icon]:not([data-icon-mounted]):not(svg)'));
        if (hasUnMountedIcon) {
          mounting = true;
          try { api.mount(node); } finally { mounting = false; }
        }
      }))).observe(document.documentElement, { childList: true, subtree: true });
    }
  }
  return api;
});
