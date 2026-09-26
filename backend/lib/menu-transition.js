/**
 * 菜单迁移过渡策略（PAND-90）
 * ------------------------------------------------------------------
 * 核心界面从「菜单驱动」逐步转为 REPORT + TODO + Decision + Evidence
 * （AEOS V7.2 EBMS Domain Boundary）。迁移期间约束：
 *   1. 原菜单入口继续可访问，且不阻断新入口；
 *   2. 被场景化视图替代的原入口，保留不少于 MIN_TRANSITION_RELEASES 个版本的过渡期；
 *   3. 过渡期内新旧入口并存；
 *   4. 新旧入口消费同一数据源（禁止第二事实源）；
 *   5. 任一入口不可用时，另一入口仍可用。
 *
 * 过渡期以「发布版本号」（整数，每次发布 +1）为单位，与 package.json 的
 * appVersion 解耦：release 判定过渡期，appVersion 仅用于展示与溯源。
 *
 * 原菜单入口只声明「被谁替代」，过渡期由替代入口的计划上线版本 shipRelease 推导，
 * 因此不存在「弃用版本与下线版本互相矛盾」的非法配置。
 *
 * 本模块为纯策略：不做 I/O，可用性由调用方以 isAvailable(href) 注入。
 */

const APP_VERSION = require('../package.json').version;

const CURRENT_RELEASE = 1;
const MIN_TRANSITION_RELEASES = 1;

/**
 * 场景化视图（新入口）。
 * href       约定的页面路径；页面未落地时状态为 pending（占位、不阻断原入口），
 *            页面落地后自动转为 active，无需再改菜单代码。
 * shipRelease 计划上线版本 —— 替代入口自该版本起可用，原入口自该版本起进入过渡期。
 * dataSources 该视图消费的 API 前缀，用于校验与所替代的原入口同源。
 */
const SCENARIO_VIEWS = [
  {
    key: 'scenario-report',
    view: 'REPORT',
    label: 'REPORT',
    href: 'report-view.html',
    group: 'workbench',
    perm: null,
    shipRelease: 2,
    dataSources: ['/api/reports', '/api/order-analysis', '/api/annual-plan'],
    replaces: ['dashboard.html', 'report.html', 'annual-plan.html', 'order-analysis.html']
  },
  {
    key: 'scenario-todo',
    view: 'TODO',
    label: 'TODO',
    href: 'todo.html',
    group: 'workbench',
    perm: null,
    shipRelease: 2,
    dataSources: ['/api/sop'],
    replaces: ['sop.html']
  },
  {
    key: 'scenario-decision',
    view: 'Decision',
    label: 'Decision',
    href: 'decision.html',
    group: 'workbench',
    perm: null,
    shipRelease: 2,
    dataSources: [],
    replaces: []
  },
  {
    key: 'scenario-evidence',
    view: 'Evidence',
    label: 'Evidence',
    href: 'evidence.html',
    group: 'workbench',
    perm: null,
    shipRelease: 2,
    dataSources: [],
    replaces: []
  }
];

/**
 * 被场景化视图替代的原菜单入口（其余原菜单入口不参与弃用，始终可访问）。
 * 过渡期起止由 replacedBy 视图的 shipRelease 推导，见 transitionWindow()。
 */
const LEGACY_TRANSITIONS = [
  { href: 'dashboard.html',      label: '仪表盘',     dataSource: '/api/order-analysis', replacedBy: 'scenario-report' },
  { href: 'report.html',         label: '数据报表',   dataSource: '/api/reports',        replacedBy: 'scenario-report' },
  { href: 'annual-plan.html',    label: '年度计划',   dataSource: '/api/annual-plan',    replacedBy: 'scenario-report' },
  { href: 'order-analysis.html', label: '订单分析库', dataSource: '/api/order-analysis', replacedBy: 'scenario-report' },
  { href: 'sop.html',            label: '产销协调会', dataSource: '/api/sop',            replacedBy: 'scenario-todo' }
];

function scenarioByKey(key) {
  return SCENARIO_VIEWS.find(v => v.key === key) || null;
}

function scenarioByHref(href) {
  return SCENARIO_VIEWS.find(v => v.href === href) || null;
}

/**
 * 由替代入口的 shipRelease 推导过渡期：
 *   原入口自 shipRelease 起弃用，最早可在 shipRelease + MIN_TRANSITION_RELEASES 下线。
 */
function transitionWindow(replacement) {
  if (!replacement || !Number.isFinite(replacement.shipRelease)) return null;
  const shipRelease = replacement.shipRelease;
  return {
    shipRelease: shipRelease,
    removeAfterRelease: shipRelease + MIN_TRANSITION_RELEASES,
    transitionReleases: MIN_TRANSITION_RELEASES
  };
}

/**
 * 原菜单入口在给定版本下的状态：
 *   active  —— 无可用替代（或替代尚未到计划上线版本）：照常可用，不标记、不下线
 *   legacy  —— 替代可用且处于过渡期：仍可访问，标记「旧版」，新旧并存
 *   retired —— 替代可用且过渡期满：才允许下线
 * 替代入口不可用时，原入口任何版本都不会 retired —— 否则等于阻断。
 */
function resolveLegacyState(entry, release, replacement, replacementAvailable) {
  if (!entry.replacedBy) return 'active';
  if (!replacementAvailable) return 'active';
  const window = transitionWindow(replacement);
  if (!window) return 'active';
  if (release < window.shipRelease) return 'active';
  if (release < window.removeAfterRelease) return 'legacy';
  return 'retired';
}

/** 场景化视图状态：页面已落地为 active，未落地为 pending（占位、不可点击） */
function resolveScenarioState(view, pageAvailable) {
  return pageAvailable ? 'active' : 'pending';
}

/**
 * 组装菜单迁移视图。
 * @param {number}   release     当前发布版本号
 * @param {function} isAvailable (href) => boolean，判断入口是否可用
 */
function buildMenu(options) {
  const opts = options || {};
  const release = Number.isFinite(opts.release) ? opts.release : CURRENT_RELEASE;
  const isAvailable = typeof opts.isAvailable === 'function' ? opts.isAvailable : function () { return false; };

  const scenarioViews = SCENARIO_VIEWS.map(function (v) {
    return Object.assign({}, v, {
      state: resolveScenarioState(v, !!isAvailable(v.href))
    });
  });

  const byKey = {};
  scenarioViews.forEach(function (v) { byKey[v.key] = v; });

  const legacyTransitions = LEGACY_TRANSITIONS.map(function (e) {
    const replacement = byKey[e.replacedBy] || null;
    const replacementAvailable = !!(replacement && replacement.state === 'active');
    const window = transitionWindow(replacement);
    return Object.assign({}, e, {
      replacedByLabel: replacement ? replacement.label : null,
      replacementState: replacement ? replacement.state : null,
      shipRelease: window ? window.shipRelease : null,
      removeAfterRelease: window ? window.removeAfterRelease : null,
      transitionReleases: window ? window.transitionReleases : null,
      state: resolveLegacyState(e, release, replacement, replacementAvailable)
    });
  });

  return {
    appVersion: APP_VERSION,
    release: release,
    minTransitionReleases: MIN_TRANSITION_RELEASES,
    scenarioViews: scenarioViews,
    legacyTransitions: legacyTransitions
  };
}

/**
 * 结构性校验（供测试与启动自检使用）：
 *   - 替代关系双向一致，且原入口与替代入口同源（同一数据不得有两个事实源）；
 *   - 过渡期不少于 MIN_TRANSITION_RELEASES 个版本；
 *   - 键与 href 不重复；数据源真实挂载。
 * @param {string[]} mountedApiPrefixes 已挂载的 API 前缀（如 '/api/reports'）
 * @returns {string[]} 错误清单，空数组表示通过
 */
function validateRegistry(mountedApiPrefixes) {
  const errors = [];
  const prefixes = Array.isArray(mountedApiPrefixes) ? mountedApiPrefixes : null;

  const keys = new Set();
  const hrefs = new Set();
  SCENARIO_VIEWS.forEach(function (v) {
    if (keys.has(v.key)) errors.push('场景化视图 key 重复: ' + v.key);
    keys.add(v.key);
    if (hrefs.has(v.href)) errors.push('入口 href 重复: ' + v.href);
    hrefs.add(v.href);
    if (!Number.isFinite(v.shipRelease) || v.shipRelease < 1) {
      errors.push(v.key + ' 的 shipRelease 必须为 >= 1 的整数');
    }
  });

  LEGACY_TRANSITIONS.forEach(function (e) {
    if (hrefs.has(e.href)) errors.push('原入口 href 与场景化视图重复: ' + e.href);
    hrefs.add(e.href);

    const replacement = scenarioByKey(e.replacedBy);
    if (!replacement) {
      errors.push(e.href + ' 的 replacedBy 指向不存在的场景化视图: ' + e.replacedBy);
      return;
    }
    if (!replacement.replaces.includes(e.href)) {
      errors.push(e.href + ' 与 ' + e.replacedBy + ' 的 replaces 声明不一致');
    }
    const window = transitionWindow(replacement);
    if (!window || window.transitionReleases < MIN_TRANSITION_RELEASES) {
      errors.push(e.href + ' 的过渡期不足 ' + MIN_TRANSITION_RELEASES + ' 个版本');
    }
    if (!replacement.dataSources.includes(e.dataSource)) {
      errors.push(e.href + ' 与替代入口 ' + e.replacedBy + ' 不同源: ' + e.dataSource);
    }
    if (prefixes && !prefixes.includes(e.dataSource)) {
      errors.push(e.href + ' 声明的数据源未挂载: ' + e.dataSource);
    }
  });

  if (prefixes) {
    SCENARIO_VIEWS.forEach(function (v) {
      v.dataSources.forEach(function (ds) {
        if (!prefixes.includes(ds)) errors.push(v.key + ' 声明的数据源未挂载: ' + ds);
      });
    });
  }

  return errors;
}

/**
 * 计划版本与实际落地情况的一致性提示：替代页面已具备 / 尚缺失，
 * 与 shipRelease 计划是否吻合。不吻合时说明需要更新注册表，避免
 * 「替代入口晚上线 → 过渡期被静默压缩」。
 * @returns {string[]} 提示清单
 */
function checkShipConsistency(release, isAvailable) {
  const warnings = [];
  const check = typeof isAvailable === 'function' ? isAvailable : function () { return false; };
  const current = Number.isFinite(release) ? release : CURRENT_RELEASE;
  SCENARIO_VIEWS.forEach(function (v) {
    const landed = !!check(v.href);
    if (landed && current < v.shipRelease) {
      warnings.push(v.key + ' 页面已落地但计划上线版本为 ' + v.shipRelease + '，请确认注册表是否需要更新');
    }
    if (!landed && current >= v.shipRelease) {
      warnings.push(v.key + ' 计划于版本 ' + v.shipRelease + ' 上线但页面缺失，过渡期可能被压缩');
    }
  });
  return warnings;
}

module.exports = {
  APP_VERSION: APP_VERSION,
  CURRENT_RELEASE: CURRENT_RELEASE,
  MIN_TRANSITION_RELEASES: MIN_TRANSITION_RELEASES,
  SCENARIO_VIEWS: SCENARIO_VIEWS,
  LEGACY_TRANSITIONS: LEGACY_TRANSITIONS,
  scenarioByKey: scenarioByKey,
  scenarioByHref: scenarioByHref,
  transitionWindow: transitionWindow,
  resolveLegacyState: resolveLegacyState,
  resolveScenarioState: resolveScenarioState,
  buildMenu: buildMenu,
  validateRegistry: validateRegistry,
  checkShipConsistency: checkShipConsistency
};
