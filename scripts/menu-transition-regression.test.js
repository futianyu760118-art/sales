/**
 * PAND-90 回归：场景化视图迁移期间「原菜单入口保留、不阻断新入口」
 *
 * 覆盖 AC：
 *   场景 1  迁移完成前原菜单入口仍可访问，且不阻断 REPORT/TODO/Decision/Evidence 新入口
 *   场景 2  菜单功能被场景化视图替代后，保留不少于 1 个版本的过渡期
 *   边界    过渡期内新旧入口并存
 *   判定 1  过渡期内同一数据在新旧入口展示一致（同源，禁止第二事实源）
 *   判定 2  过渡期内任一入口不可用时，另一入口仍可用
 *
 * 运行：node scripts/menu-transition-regression.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const menu = require('../backend/lib/menu-transition');

const ROOT = path.join(__dirname, '..');
const ROUTES_INDEX = path.join(ROOT, 'backend', 'routes', 'index.js');
const NAV_ROUTE = path.join(ROOT, 'backend', 'routes', 'navigation.js');
const PERMISSION_CHECK = path.join(ROOT, 'frontend', 'permission-check.js');

/** 从挂载表还原真实 API 前缀，如 '/api/reports' */
function mountedApiPrefixes() {
  const source = fs.readFileSync(ROUTES_INDEX, 'utf8');
  const out = [];
  const re = /router\.use\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) out.push('/api' + m[1]);
  return out;
}

const mounted = mountedApiPrefixes();
const SCENARIO_HREFS = menu.SCENARIO_VIEWS.map(v => v.href);

// ---------------------------------------------------------------- 注册表结构
const registryErrors = menu.validateRegistry(mounted);
assert.deepEqual(registryErrors, [], '注册表结构校验必须通过：' + registryErrors.join('; '));

// 数据源必须真实挂载（防止臆造接口 / 第二事实源）
menu.SCENARIO_VIEWS.forEach(v => {
  v.dataSources.forEach(ds => {
    assert.ok(mounted.includes(ds), `场景化视图 ${v.key} 的数据源未挂载: ${ds}`);
  });
});
menu.LEGACY_TRANSITIONS.forEach(e => {
  assert.ok(mounted.includes(e.dataSource), `原入口 ${e.href} 的数据源未挂载: ${e.dataSource}`);
});

// 4 个新入口必须齐备
['REPORT', 'TODO', 'Decision', 'Evidence'].forEach(view => {
  assert.ok(
    menu.SCENARIO_VIEWS.some(v => v.view === view),
    `必须登记 ${view} 新入口`
  );
});

// ------------------------------------------------- 场景 1：替代视图上线前
{
  const m = menu.buildMenu({ release: menu.CURRENT_RELEASE, isAvailable: () => false });

  m.scenarioViews.forEach(v => {
    assert.equal(v.state, 'pending', `${v.label} 页面未落地时应为 pending`);
  });
  m.legacyTransitions.forEach(e => {
    assert.equal(e.state, 'active', `${e.href} 在替代入口可用前必须仍然可访问`);
  });
  // 新入口已登记，未被原入口阻断
  assert.equal(m.scenarioViews.length, SCENARIO_HREFS.length, '新入口必须全部登记');
}

// 当前发布版本上，迁移尚未开始：无 legacy、无 retired
{
  const m = menu.buildMenu({ release: menu.CURRENT_RELEASE, isAvailable: () => false });
  assert.ok(
    m.legacyTransitions.every(e => e.state === 'active'),
    '当前版本原菜单入口应全部可用'
  );
}

// ------------------------------- 场景 2 + 边界：替代视图上线后的过渡期并存
{
  const shipRelease = menu.scenarioByKey(menu.LEGACY_TRANSITIONS[0].replacedBy).shipRelease;
  const m = menu.buildMenu({ release: shipRelease, isAvailable: h => SCENARIO_HREFS.includes(h) });

  const deprecated = m.legacyTransitions.filter(e => e.state === 'legacy');
  const activeScenario = m.scenarioViews.filter(v => v.state === 'active');

  assert.ok(deprecated.length > 0, '过渡期内原菜单入口必须保留');
  assert.ok(activeScenario.length > 0, '过渡期内新入口必须可用');
  // 边界：新旧入口并存
  assert.ok(
    deprecated.length === m.legacyTransitions.length,
    '过渡期内所有被替代的原入口都应处于 legacy（仍可访问）'
  );
}

// 过渡期不少于 1 个版本
{
  assert.ok(menu.MIN_TRANSITION_RELEASES >= 1, '最小过渡期不得少于 1 个版本');
  const m = menu.buildMenu({ release: menu.CURRENT_RELEASE, isAvailable: () => false });
  m.legacyTransitions.forEach(e => {
    assert.ok(
      Number.isFinite(e.removeAfterRelease) && Number.isFinite(e.shipRelease),
      `${e.href} 必须能推导出过渡期起止版本`
    );
    assert.ok(
      e.removeAfterRelease - e.shipRelease >= menu.MIN_TRANSITION_RELEASES,
      `${e.href} 过渡期不足 ${menu.MIN_TRANSITION_RELEASES} 个版本`
    );
  });
}

// 过渡期满前一律不得下线
{
  menu.LEGACY_TRANSITIONS.forEach(e => {
    const replacement = menu.scenarioByKey(e.replacedBy);
    const window = menu.transitionWindow(replacement);
    for (let r = window.shipRelease; r < window.removeAfterRelease; r++) {
      assert.equal(
        menu.resolveLegacyState(e, r, replacement, true),
        'legacy',
        `${e.href} 在版本 ${r} 仍处过渡期，不得下线`
      );
    }
    assert.equal(
      menu.resolveLegacyState(e, window.removeAfterRelease, replacement, true),
      'retired',
      `${e.href} 过渡期满且替代入口可用后方可下线`
    );
    // 替代入口早于计划上线：不提前标记旧版
    assert.equal(
      menu.resolveLegacyState(e, window.shipRelease - 1, replacement, true),
      'active',
      `${e.href} 在替代入口计划上线版本之前不应被标记为旧版`
    );
  });
}

// 替代入口缺失时，原入口不打「旧版」标记（此时并不存在可用替代）
{
  const m = menu.buildMenu({ release: 2, isAvailable: () => false });
  m.legacyTransitions.forEach(e => {
    assert.equal(e.state, 'active', `${e.href} 无可用替代时应照常可用且不标记旧版`);
  });
}

// 计划上线版本与实际落地的一致性提示（防止过渡期被静默压缩）
{
  assert.deepEqual(
    menu.checkShipConsistency(menu.CURRENT_RELEASE, () => false),
    [],
    '尚未到计划上线版本时不应告警'
  );
  assert.ok(
    menu.checkShipConsistency(2, () => false).length > 0,
    '已到计划上线版本但页面缺失必须告警'
  );
  assert.ok(
    menu.checkShipConsistency(1, () => true).length > 0,
    '页面提前落地应提示确认注册表'
  );
}

// --------------------------------- 判定 1：同一数据在新旧入口同源（一致展示）
{
  menu.SCENARIO_VIEWS.forEach(v => {
    v.replaces.forEach(href => {
      const legacy = menu.LEGACY_TRANSITIONS.find(e => e.href === href);
      assert.ok(legacy, `${v.key} 声明的替代对象 ${href} 未在注册表中登记`);
      assert.equal(legacy.replacedBy, v.key, `${href} 与 ${v.key} 的替代关系应双向一致`);
      assert.ok(
        v.dataSources.includes(legacy.dataSource),
        `${href}(${legacy.dataSource}) 与替代入口 ${v.key} 不同源，展示可能不一致`
      );
    });
  });
}

// ------------------------------------- 判定 2：任一入口不可用时另一入口仍可用
{
  // (a) 新入口不可用 → 原入口仍可用（即使已远超计划下线版本）
  menu.LEGACY_TRANSITIONS.forEach(e => {
    const replacement = menu.scenarioByKey(e.replacedBy);
    const state = menu.resolveLegacyState(e, menu.transitionWindow(replacement).removeAfterRelease + 5, replacement, false);
    assert.notEqual(state, 'retired', `${e.href} 的替代入口不可用时不得下线`);
    assert.equal(state, 'active', `${e.href} 的替代入口不可用时仍应可访问`);
  });

  // (b) 原入口不可用 → 新入口仍可用（新入口可用性不依赖原入口）
  const m = menu.buildMenu({ release: 99, isAvailable: h => SCENARIO_HREFS.includes(h) });
  m.scenarioViews.forEach(v => {
    assert.equal(v.state, 'active', `${v.label} 不应因原菜单入口不可用而受影响`);
  });

  // (c) 全量版本区间内，never-retired-while-replacement-missing 恒成立
  for (let r = 1; r <= 10; r++) {
    menu.buildMenu({ release: r, isAvailable: () => false }).legacyTransitions.forEach(e => {
      assert.notEqual(e.state, 'retired', `版本 ${r}：替代入口缺失时 ${e.href} 不得下线`);
    });
  }
}

// ---------------------------------------------------------- 接口与前端接线
{
  const indexSource = fs.readFileSync(ROUTES_INDEX, 'utf8');
  assert.match(indexSource, /router\.use\('\/navigation'/, '导航迁移接口必须挂载');
  assert.ok(mounted.includes('/api/navigation'), '挂载表应包含 /api/navigation');

  const navSource = fs.readFileSync(NAV_ROUTE, 'utf8');
  assert.match(navSource, /router\.get\('\/menu'/, '必须提供 GET /api/navigation/menu');
  assert.match(navSource, /menuTransition\.buildMenu/, '接口必须由注册表驱动');

  const feSource = fs.readFileSync(PERMISSION_CHECK, 'utf8');
  assert.match(feSource, /key: 'workbench'/, '必须新增场景化视图一级分组');
  assert.match(feSource, /loadNavTransition/, '前端必须加载迁移状态');
  assert.match(feSource, /_renderItemHtml/, '菜单项渲染必须逐项隔离，避免一个入口拖垮其余入口');
  assert.match(feSource, /lms-item-badge legacy/, '过渡期内的原入口必须有可见标记');
  assert.match(feSource, /lms-item-badge pending/, '未上线的新入口必须有占位标记');
  // 迁移状态取不到时不得阻断原菜单入口
  assert.match(
    feSource,
    /console\.warn\('加载场景化视图迁移状态失败，原菜单入口照常显示:', e\)/,
    '迁移状态获取失败必须降级为原菜单入口照常显示'
  );
}

// --------------------------------- 前端渲染实测：新旧入口并存与逐项故障隔离
// 用 vm 沙箱加载 permission-check.js，直接驱动其菜单组装/渲染逻辑，
// 验证真实行为而非源码特征。
{
  const vm = require('node:vm');
  const store = new Map();
  let sidebarHtml = '';
  const sidebar = {
    id: '',
    set innerHTML(v) { sidebarHtml = v; },
    get innerHTML() { return sidebarHtml; },
    addEventListener() {}
  };
  const sandbox = {
    console: console,
    window: { location: { origin: 'http://localhost:3010', pathname: '/dashboard.html' } },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    document: {
      getElementById: id => (id === 'sidebar' ? sidebar : null),
      querySelector: sel => (sel === '.sidebar' ? sidebar : null)
    },
    EBMSIcons: { render: () => '<svg></svg>' }
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PERMISSION_CHECK, 'utf8'), sandbox, { filename: 'permission-check.js' });

  const PC = sandbox.window.PermissionCheck;
  assert.ok(PC, 'permission-check.js 必须导出 PermissionCheck');
  PC.isAdmin = true; // 绕过权限过滤，聚焦迁移逻辑
  PC.permissions = null;

  const allItems = map => Object.values(map).reduce((acc, list) => acc.concat(list), []);
  const findItem = (map, href) => allItems(map).find(i => i.href === href) || null;
  const groupItemsWith = transition => {
    PC.navTransition = transition;
    PC._itemsByGroup = null;
    return PC._groupItems();
  };

  const TRANSITION_HREFS = menu.LEGACY_TRANSITIONS.map(e => e.href);

  // 场景 1：迁移状态缺失（接口不可用）→ 原菜单入口全部照常渲染为可点击入口
  {
    const map = groupItemsWith(null);
    TRANSITION_HREFS.forEach(href => {
      const item = findItem(map, href);
      assert.ok(item, `${href} 在迁移状态缺失时仍必须渲染`);
      assert.match(
        PC._renderItemHtml(item, 'dashboard.html'),
        /<a href="/,
        `${href} 在迁移状态缺失时必须仍是可点击入口`
      );
    });
  }

  // 边界：过渡期内新旧入口并存，且两边都可点击
  {
    const map = groupItemsWith(menu.buildMenu({ release: 2, isAvailable: h => SCENARIO_HREFS.includes(h) }));
    SCENARIO_HREFS.forEach(href => {
      const item = findItem(map, href);
      assert.ok(item, `新入口 ${href} 必须出现在菜单中`);
      assert.equal(item.transitionState, 'active');
      assert.match(PC._renderItemHtml(item, 'dashboard.html'), /<a href="/, `新入口 ${href} 应可点击`);
    });
    const legacy = findItem(map, 'sop.html');
    assert.ok(legacy, '过渡期内原入口 sop.html 必须保留');
    const html = PC._renderItemHtml(legacy, 'dashboard.html');
    assert.match(html, /<a href="sop\.html"/, '过渡期内原入口必须仍可点击');
    assert.match(html, /lms-item-badge legacy/, '过渡期内原入口必须带旧版标记');
  }

  // 场景 1：替代视图尚未上线 → 新入口占位不可点击，原入口照常可点击
  {
    const map = groupItemsWith(menu.buildMenu({ release: 2, isAvailable: () => false }));
    SCENARIO_HREFS.forEach(href => {
      const html = PC._renderItemHtml(findItem(map, href), 'dashboard.html');
      assert.doesNotMatch(html, /<a href=/, `未上线的 ${href} 不得渲染成死链`);
      assert.match(html, /is-pending/, `未上线的 ${href} 必须显示占位状态`);
    });
    const legacy = findItem(map, 'sop.html');
    assert.equal(legacy.transitionState, 'active', '替代视图未上线时原入口应完全不受影响');
    assert.match(PC._renderItemHtml(legacy, 'dashboard.html'), /<a href="sop\.html"/);
  }

  // 场景 2 收口：过渡期满后原入口下线，新入口保留
  {
    const map = groupItemsWith(menu.buildMenu({ release: 3, isAvailable: h => SCENARIO_HREFS.includes(h) }));
    assert.equal(findItem(map, 'sop.html'), null, '过渡期满后原入口应下线');
    assert.ok(findItem(map, 'todo.html'), '过渡期满后新入口必须保留');
  }

  // 判定 2：单个入口异常只丢该条目，其余入口不受影响
  {
    const map = groupItemsWith(menu.buildMenu({ release: 2, isAvailable: h => SCENARIO_HREFS.includes(h) }));
    const broken = {
      href: 'broken.html',
      get label() { throw new Error('渲染异常'); },
      transitionState: 'active'
    };
    assert.equal(PC._renderItemHtml(broken, 'dashboard.html'), '', '异常条目应被逐项隔离');
    assert.match(
      PC._renderItemHtml(findItem(map, 'dashboard.html'), 'dashboard.html'),
      /<a href="dashboard\.html"/,
      '单个入口异常不得影响其余入口渲染'
    );
  }

  // 整条侧边栏渲染：新入口分组可点击 + 过渡期原入口带旧版标记
  {
    groupItemsWith(menu.buildMenu({ release: 2, isAvailable: h => SCENARIO_HREFS.includes(h) }));

    sandbox.window.location.pathname = '/report-view.html';
    store.set('lms_active_group', 'workbench');
    PC.renderSidebar();
    assert.match(sidebarHtml, /data-group="workbench"/, '侧边栏必须含场景化视图一级分组');
    SCENARIO_HREFS.forEach(href => {
      assert.ok(sidebarHtml.includes('href="' + href + '"'), `侧边栏必须含可点击的新入口 ${href}`);
    });

    sandbox.window.location.pathname = '/sop.html';
    PC.renderSidebar();
    assert.match(
      sidebarHtml,
      /<a href="sop\.html"[^>]*>[^<]*产销协调会/,
      '过渡期内原入口必须仍渲染为可点击链接'
    );
    assert.match(sidebarHtml, /lms-item-badge legacy/, '过渡期内原入口必须带旧版标记');
  }

  // 迁移状态缺失（接口不可用）时，整条侧边栏仍渲染全部原菜单入口
  {
    groupItemsWith(null);
    sandbox.window.location.pathname = '/sop.html';
    PC.renderSidebar();
    assert.match(sidebarHtml, /<a href="sop\.html"/, '迁移状态缺失时原入口必须照常渲染');
    assert.doesNotMatch(sidebarHtml, /lms-item-badge/, '迁移状态缺失时不应出现任何过渡标记');
  }
}

console.log('Menu transition regression checks passed');
