/**
 * M03 EBMS 视图层配置（M03 自有，仅「视图」不含身份 / 权限 / 数据范围）。
 *
 * 「决策者」「管理责任人」是 M03 视图层的经营角色概念，映射到 M01 Kernel 中已有的
 * 角色 / 权限定义；本文件只声明「哪个 Kernel 权限码 → 哪个默认落地视图」，
 * 不新增角色实体、不存储权限、不定义可见范围。
 * 可见范围一律取自 M01 Kernel 的 data-scope（见 kernel-client + metric-catalog）。
 */

// 四视图（REPORT = Result / TODO = Action / Decision / Evidence）
const VIEWS = {
  report: { id: 'report', label: 'REPORT 视图', url: 'm03-view.html?view=report' },
  todo: { id: 'todo', label: 'TODO 视图', url: 'm03-view.html?view=todo' },
  decision: { id: 'decision', label: 'Decision 视图', url: 'm03-view.html?view=decision' },
  evidence: { id: 'evidence', label: 'Evidence 视图', url: 'm03-view.html?view=evidence' }
};

// 经营角色概念 → Kernel 权限码（映射目标为 Kernel 权限目录中的码，不是新角色实体）
const VIEW_CONCEPTS = [
  {
    concept: 'decision_maker',
    label: '决策者',
    kernel_permissions: ['m03:view.decision-maker'],
    landing_view: 'report',
    scope_expectation: '全企业口径'
  },
  {
    concept: 'management_owner',
    label: '管理责任人',
    kernel_permissions: ['m03:view.management-owner'],
    landing_view: 'todo',
    secondary_views: ['report'],
    scope_expectation: '责任域口径'
  }
];

// 进入 EBMS 主体功能所需的 Kernel 权限码
const ENTRY_PERMISSION = 'm03:access';

function conceptOfPermission(code) {
  return VIEW_CONCEPTS.find(c => c.kernel_permissions.includes(code)) || null;
}

/**
 * 依据 M01 Kernel 身份解析 M03 视图层结论。
 * @param {{permission_codes:string[], role_codes:string[], is_admin:boolean}} identity Kernel 身份
 */
function resolveViewLayer(identity) {
  const perms = new Set(identity.permission_codes || []);
  const concepts = VIEW_CONCEPTS
    .filter(c => c.kernel_permissions.some(p => perms.has(p)))
    .map(c => ({ concept: c.concept, label: c.label, landing_view: c.landing_view }));

  const authorized = identity.is_admin || perms.has(ENTRY_PERMISSION) || concepts.length > 0;
  if (!authorized) {
    return { authorized: false, reason: 'NO_EBMS_ACCESS', concepts: [], landing: null };
  }

  // 默认落地视图：决策者概念优先（企业级视角），否则管理责任人 → 责任域相关 TODO
  const primary = concepts.find(c => c.concept === 'decision_maker')
    || concepts.find(c => c.concept === 'management_owner')
    || null;
  const viewId = primary ? primary.landing_view : 'report';
  const view = VIEWS[viewId] || VIEWS.report;

  return {
    authorized: true,
    concepts,
    landing: {
      view: view.id,
      label: view.label,
      url: view.url,
      reason: primary
        ? `经营角色概念「${primary.label}」默认落地 ${view.label}`
        : '未匹配经营角色概念，按 EBMS 默认视图落地'
    }
  };
}

module.exports = { VIEWS, VIEW_CONCEPTS, ENTRY_PERMISSION, conceptOfPermission, resolveViewLayer };
