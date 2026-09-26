/**
 * M01 AEOS Kernel —— 身份 / 组织 / 角色 / 权限 / 数据范围（data-scope）的唯一 Owner。
 *
 * 归属依据（AEOS V7.2 Data Ownership V1）：
 *   Identity / Org / Role / Permission → M01 Kernel，M03 EBMS 只 Consume。
 * 因此本模块是**角色 / 权限 / 数据范围的唯一配置与存储入口**；
 * M03 EBMS 不得自建第二套角色 / 权限 / 数据范围体系（PAND-93 红线）。
 *
 * 对外契约：routes/kernel.js 发布于 /api/kernel/*；M03 一律经 lib/m03/kernel-client.js 消费。
 */
const { getTable, ensureTable, now } = require('../../db');

const KERNEL_VERSION = 'M01-KERNEL/V1';

// Kernel 侧存储：角色 ↔ 数据范围（data-scope）绑定
const TABLE_ROLE_DATA_SCOPES = 'kernel_role_data_scopes';

// Kernel 权限目录中属于 M03 视图层的权限码（权限目录归 Kernel 所有，M03 只按码消费）
const M03_KERNEL_PERMISSIONS = [
  { code: 'm03:access', name: 'M03 经营管理系统 - 进入权限', module: 'M03' },
  { code: 'm03:view.decision-maker', name: 'M03 视图层 - 决策者（全企业口径）', module: 'M03' },
  { code: 'm03:view.management-owner', name: 'M03 视图层 - 管理责任人（责任域口径）', module: 'M03' }
];

// 决策者角色码：作为 Kernel 中的一个普通角色存在（不新增 Kernel 之外的角色实体）
const DECISION_MAKER_ROLE_CODE = 'decision_maker';
// 默认拥有企业级（全企业口径）数据范围的角色码
const ENTERPRISE_SCOPE_ROLE_CODES = ['admin', DECISION_MAKER_ROLE_CODE];

function fresh(name) {
  const t = ensureTable(name);
  try { t._invalidate(); } catch (_) {}
  return t;
}

// ---------------------------------------------------------------------------
// 可用性
// ---------------------------------------------------------------------------
function isAvailable() {
  if (process.env.M01_KERNEL_DISABLED === '1') return false;
  try {
    fresh('users');
    fresh('roles');
    return true;
  } catch (_) {
    return false;
  }
}

function health() {
  if (process.env.M01_KERNEL_DISABLED === '1') {
    return { available: false, version: KERNEL_VERSION, reason: 'M01 Kernel 已被显式停用（M01_KERNEL_DISABLED=1）' };
  }
  try {
    fresh('users').all();
    fresh('roles').all();
    return { available: true, version: KERNEL_VERSION, source: 'M01_KERNEL' };
  } catch (e) {
    return { available: false, version: KERNEL_VERSION, reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// 身份 / 角色 / 权限
// ---------------------------------------------------------------------------
function findUser(userId) {
  if (userId === undefined || userId === null || userId === '') return null;
  const table = fresh('users');
  const byId = table.findById(Number(userId));
  if (byId) return byId;
  return table.all().find(u => String(u.username) === String(userId)) || null;
}

function roleIdsOf(user) {
  const ids = new Set();
  const ur = fresh('user_roles').all().filter(r => Number(r.user_id) === Number(user.id));
  ur.forEach(r => ids.add(Number(r.role_id)));
  if (user.role) {
    const direct = fresh('roles').all().find(r => r.code === user.role);
    if (direct) ids.add(Number(direct.id));
  }
  return [...ids].filter(Number.isFinite);
}

function rolesOf(user) {
  const roleTable = fresh('roles');
  return roleIdsOf(user)
    .map(id => roleTable.findById(id))
    .filter(Boolean)
    .map(r => ({ id: r.id, code: r.code, name: r.name }));
}

function permissionCodesOf(user) {
  const roles = rolesOf(user);
  const permTable = fresh('permissions');
  if (roles.some(r => r.code === 'admin')) {
    return new Set(permTable.all().map(p => p.code));
  }
  const rp = fresh('role_permissions').all();
  const roleIds = new Set(roles.map(r => Number(r.id)));
  const codes = new Set();
  rp.filter(x => roleIds.has(Number(x.role_id)))
    .forEach(x => {
      const p = permTable.findById(x.permission_id);
      if (p) codes.add(p.code);
    });
  return codes;
}

/**
 * Kernel 身份解析：EBMS 侧唯一可用的身份来源。
 * @returns {null|{user_id, username, name, roles, role_codes, permission_codes, is_admin}}
 */
function getIdentity(userId) {
  const user = findUser(userId);
  if (!user) return null;
  const roles = rolesOf(user);
  const permissionCodes = permissionCodesOf(user);
  return {
    user_id: user.id,
    username: user.username,
    name: user.name || user.username,
    roles,
    role_codes: roles.map(r => r.code),
    permission_codes: [...permissionCodes],
    is_admin: roles.some(r => r.code === 'admin')
  };
}

// ---------------------------------------------------------------------------
// 数据范围（data-scope）
// ---------------------------------------------------------------------------
// 责任域（domain_key）关键字表：与 M03 指标注册表的口径维度对齐。
// 中文关键字用于组织 / 责任单元名称，英文关键字用于 Kernel 角色 code。
const DOMAIN_KEYWORDS = [
  { key: 'sales', re: /销售|营销|商务|客户|sales|market|crm/i },
  { key: 'rd', re: /研发|技术|开发|设计|工程|r&d|rd_manager|engineer|design|tech_/i },
  { key: 'production', re: /生产|制造|车间|组装|项目|交付|计划|production|manufactur|project|delivery/i },
  { key: 'supply', re: /供应|采购|物流|仓储|品质|质量|supply|purchase|procure|logistic|warehouse|quality/i },
  { key: 'finance', re: /财务|财经|成本|会计|finance|account|cost/i }
];

function domainKeyOf(text) {
  const s = String(text || '');
  const hit = DOMAIN_KEYWORDS.find(d => d.re.test(s));
  return hit ? hit.key : 'general';
}

function isRealDomain(key) {
  return !!key && key !== 'general';
}

/**
 * 按用户解析其责任域（Kernel Org 责任部门 / 责任单元）——数据范围中 self_responsibility 口径的取值来源。
 * 全部取自 Kernel 自有数据，M03 只消费：
 *   1) Kernel 组织架构：org_personnel.linked_user_id → org_departments；org_departments.manager_id = 用户
 *   2) Kernel 责任单元：amiba_org 责任人绑定（charge_user_id / charge_personnel_id / charge_user_name）
 *   3) Kernel 角色语义：角色 code / name 所属专业域（组织与责任单元均未落地时的确定性来源，避免依赖时序）
 */
function resolveResponsibilityDomain(userId) {
  const user = findUser(userId);
  const resourceIds = new Set(); // 责任部门 id（Kernel Org）
  const unitIds = new Set();     // 责任单元 id（Kernel 责任单元）
  const unitNames = new Set();
  const domainKeys = new Set();

  let departments = [];
  try {
    departments = fresh('org_departments').all();
  } catch (_) {
    departments = [];
  }
  const byId = new Map(departments.map(d => [Number(d.id), d]));

  const addDept = (id) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    resourceIds.add(n);
    const d = byId.get(n);
    if (d) {
      const k = domainKeyOf(d.name);
      if (isRealDomain(k)) domainKeys.add(k);
    }
  };

  const addUnit = (unit) => {
    const n = Number(unit.id);
    if (Number.isFinite(n)) unitIds.add(n);
    if (unit.amiba_name) unitNames.add(unit.amiba_name);
    ['amiba_type', 'amiba_name', 'department'].forEach(f => {
      const k = domainKeyOf(unit[f]);
      if (isRealDomain(k)) domainKeys.add(k);
    });
    if (unit.department) {
      const d = departments.find(x => x.name && String(x.name).includes(String(unit.department)));
      if (d) addDept(d.id);
    }
  };

  // 1) 组织绑定
  if (user) {
    try {
      const people = fresh('org_personnel').all()
        .filter(p => Number(p.linked_user_id) === Number(user.id) && p.status !== '停用');
      people.forEach(p => addDept(p.department_id));
      const personIds = new Set(people.map(p => Number(p.id)));
      departments.forEach(d => { if (personIds.has(Number(d.manager_id))) addDept(d.id); });
    } catch (_) { /* Kernel 组织表未落地 */ }
  }

  // 2) 责任单元责任绑定（只读消费 Kernel Org 数据）
  try {
    const name = user ? String(user.name || '') : '';
    fresh('amiba_org').all()
      .filter(o => o.status !== '停用')
      .filter(o => !!user && (
        Number(o.charge_user_id) === Number(user.id) ||
        Number(o.charge_personnel_id) === Number(user.id) ||
        (!!name && !!o.charge_user_name &&
          (name === String(o.charge_user_name) || name.includes(String(o.charge_user_name))))
      ))
      .forEach(addUnit);
  } catch (_) { /* 责任单元表未落地 */ }

  // 3) Kernel 角色语义
  if (user) {
    rolesOf(user).forEach(r => {
      [r.code, r.name].forEach(t => {
        const k = domainKeyOf(t);
        if (isRealDomain(k)) domainKeys.add(k);
      });
    });
  }

  return {
    resource_ids: [...resourceIds].sort((a, b) => a - b),
    unit_ids: [...unitIds].sort((a, b) => a - b),
    unit_names: [...unitNames],
    domain_keys: [...domainKeys]
  };
}

function roleDataScopeRow(roleId) {
  return fresh(TABLE_ROLE_DATA_SCOPES).all().find(r => Number(r.role_id) === Number(roleId)) || null;
}

/**
 * 角色默认数据范围：企业级角色 → all，其余 → self_responsibility。
 * 作为「未显式配置」时的确定性缺省，避免依赖播种时序。
 */
function defaultScopeTypeFor(roleCode) {
  return ENTERPRISE_SCOPE_ROLE_CODES.includes(String(roleCode || '')) ? 'all' : 'self_responsibility';
}

function normalizeScopeType(v) {
  const s = String(v || '').trim();
  if (s === 'all' || s === 'custom' || s === 'self_responsibility') return s;
  if (s === 'none') return 'none';
  throw new Error('非法 scope_type: ' + v);
}

function getRoleDataScope(roleId) {
  const role = fresh('roles').findById(roleId);
  if (!role) return null;
  const row = roleDataScopeRow(roleId);
  return {
    role_id: role.id,
    role_code: role.code,
    role_name: role.name,
    scope_type: row ? row.scope_type : defaultScopeTypeFor(role.code),
    resource_ids: row && Array.isArray(row.resource_ids) ? row.resource_ids : [],
    dimension: row ? row.dimension || 'responsibility_domain' : 'responsibility_domain',
    updated_at: row ? row.updated_at || null : null,
    configured: !!row,
    source: 'M01_KERNEL'
  };
}

/**
 * Kernel 侧写入口：调整某角色的 data-scope。
 * M03 EBMS 无此入口（红线：EBMS 不得有独立于 Kernel 的数据范围配置入口）。
 */
function setRoleDataScope(roleId, def) {
  const role = fresh('roles').findById(roleId);
  if (!role) throw new Error('角色不存在: ' + roleId);
  const scopeType = normalizeScopeType(def && def.scope_type);
  let resourceIds = [];
  if (scopeType === 'custom') {
    resourceIds = Array.isArray(def.resource_ids)
      ? def.resource_ids.map(Number).filter(Number.isFinite)
      : [];
    if (!resourceIds.length) throw new Error('scope_type=custom 时必须提供 resource_ids');
  }
  const table = ensureTable(TABLE_ROLE_DATA_SCOPES);
  table._invalidate();
  const exists = table.all().find(r => Number(r.role_id) === Number(role.id));
  const fields = {
    role_id: role.id,
    scope_type: scopeType,
    resource_ids: resourceIds,
    dimension: (def && def.dimension) || 'responsibility_domain',
    updated_at: now()
  };
  if (exists) table.update(exists.id, fields);
  else table.insert(fields);
  // 读己之写：落盘为异步，回读可能取到旧值，故直接返回刚写入的状态
  return {
    role_id: role.id,
    role_code: role.code,
    role_name: role.name,
    scope_type: fields.scope_type,
    resource_ids: fields.resource_ids,
    dimension: fields.dimension,
    updated_at: fields.updated_at,
    configured: true,
    source: 'M01_KERNEL'
  };
}

function listRoleDataScopes() {
  return fresh('roles').all().map(r => getRoleDataScope(r.id));
}

/**
 * 用户生效数据范围：合并其全部角色的 data-scope。
 * all 优先；否则合并 self_responsibility / custom 的责任域资源。
 * @returns {{source:string, scope_type:string, resource_ids:number[], domain_keys:string[], scope_label:string}}
 */
function resolveDataScope(userId) {
  const user = findUser(userId);
  const empty = {
    source: 'M01_KERNEL',
    scope_type: 'none',
    resource_ids: [],
    domain_keys: [],
    scope_label: '无可见范围'
  };
  if (!user) return empty;

  const scopes = rolesOf(user)
    .map(r => getRoleDataScope(r.id))
    .filter(Boolean);
  if (!scopes.length) return empty;

  if (scopes.some(s => s.scope_type === 'all')) {
    return {
      source: 'M01_KERNEL',
      scope_type: 'all',
      resource_ids: [],
      domain_keys: ['*'],
      scope_label: '全企业口径'
    };
  }

  let dynamic = false;
  const explicit = new Set();
  scopes.forEach(s => {
    if (s.scope_type === 'self_responsibility') dynamic = true;
    if (s.scope_type === 'custom') s.resource_ids.forEach(id => explicit.add(Number(id)));
  });
  if (!dynamic && !explicit.size) return empty;

  const dynamicPart = dynamic ? resolveResponsibilityDomain(user.id) : { resource_ids: [], domain_keys: [] };
  const departmentTable = fresh('org_departments');
  const domainKeys = new Set(dynamicPart.domain_keys);
  explicit.forEach(id => {
    const d = departmentTable.findById(id);
    domainKeys.add(d ? domainKeyOf(d.name) : 'general');
  });

  return {
    source: 'M01_KERNEL',
    scope_type: dynamic && explicit.size ? 'self_responsibility' : (dynamic ? 'self_responsibility' : 'custom'),
    resource_ids: [...new Set([...dynamicPart.resource_ids, ...explicit])].sort((a, b) => a - b),
    domain_keys: [...domainKeys],
    scope_label: '责任域口径'
  };
}

// ---------------------------------------------------------------------------
// 种子：Kernel 自有目录的角色 / 权限 / 数据范围（幂等，兼容既有库）
// ---------------------------------------------------------------------------
function ensureSeed() {
  // Kernel 不可用时不做任何写入，避免在停用状态下产生第二份配置来源
  if (process.env.M01_KERNEL_DISABLED === '1') return;

  const roleTable = ensureTable('roles');
  roleTable._invalidate();
  const permTable = ensureTable('permissions');
  permTable._invalidate();
  const rpTable = ensureTable('role_permissions');
  rpTable._invalidate();
  const scopeTable = ensureTable(TABLE_ROLE_DATA_SCOPES);
  scopeTable._invalidate();

  // 1) Kernel 权限目录中补齐 M03 视图层权限码
  const permByCode = new Map(permTable.all().map(p => [p.code, p]));
  M03_KERNEL_PERMISSIONS.forEach(p => {
    if (permByCode.has(p.code)) return;
    const r = permTable.insert({ code: p.code, name: p.name, module: p.module, created_at: now() });
    permByCode.set(p.code, permTable.findById(r.lastID));
  });

  // 2) Kernel 角色目录中补齐「决策者」角色（作为普通 Kernel 角色，不新增实体体系）
  if (!roleTable.all().some(r => r.code === DECISION_MAKER_ROLE_CODE)) {
    roleTable.insert({
      name: '决策者',
      code: DECISION_MAKER_ROLE_CODE,
      description: 'M03 经营视图层概念「决策者」在 M01 Kernel 中的角色映射，数据范围为企业级',
      created_at: now(),
      updated_at: now()
    });
    roleTable._invalidate();
  }

  // 3) 角色 → 数据范围：默认企业级 / 责任域（幂等，补齐缺失角色）
  const roles = roleTable.all();
  const haveScope = new Set(scopeTable.all().map(s => Number(s.role_id)));
  roles.filter(r => !haveScope.has(Number(r.id))).forEach(r => {
    scopeTable.insert({
      role_id: r.id,
      scope_type: defaultScopeTypeFor(r.code),
      resource_ids: [],
      dimension: 'responsibility_domain',
      updated_at: now()
    });
    haveScope.add(Number(r.id));
  });

  // 4) 权限授予：决策者 → 决策者视图；管理类角色 → 管理责任人视图
  const granted = new Set(rpTable.all().map(x => Number(x.role_id) + ':' + Number(x.permission_id)));
  const grant = (role, code) => {
    const p = permByCode.get(code);
    if (!role || !p) return;
    const key = Number(role.id) + ':' + Number(p.id);
    if (granted.has(key)) return;
    rpTable.insert({ role_id: role.id, permission_id: p.id, granted_at: now() });
    granted.add(key);
  };

  const adminRole = roles.find(r => r.code === 'admin');
  const decisionRole = roles.find(r => r.code === DECISION_MAKER_ROLE_CODE);
  roles.forEach(role => {
    if (ENGLISH_MANAGER_ROLE(role.code)) {
      grant(role, 'm03:view.management-owner');
      grant(role, 'm03:access');
    }
    if (role.code === DECISION_MAKER_ROLE_CODE) {
      grant(role, 'm03:view.decision-maker');
      grant(role, 'm03:access');
    }
  });
  // admin 拥有全部权限（Kernel 既有约定）
  const allPerms = permTable.all();
  [adminRole, decisionRole].filter(Boolean).forEach(role => {
    allPerms.forEach(p => {
      const key = Number(role.id) + ':' + Number(p.id);
      if (granted.has(key)) return;
      rpTable.insert({ role_id: role.id, permission_id: p.id, granted_at: now() });
      granted.add(key);
    });
  });
}

function ENGLISH_MANAGER_ROLE(code) {
  return /_manager$|^manager$|_director$/.test(String(code || ''));
}

module.exports = {
  KERNEL_VERSION,
  TABLE_ROLE_DATA_SCOPES,
  DECISION_MAKER_ROLE_CODE,
  M03_KERNEL_PERMISSIONS,
  isAvailable,
  health,
  getIdentity,
  listRoles: () => fresh('roles').all().map(r => ({ id: r.id, code: r.code, name: r.name, description: r.description || '' })),
  listPermissions: () => fresh('permissions').all().map(p => ({ id: p.id, code: p.code, name: p.name, module: p.module || '' })),
  getRoleDataScope,
  setRoleDataScope,
  listRoleDataScopes,
  resolveDataScope,
  ensureSeed
};
