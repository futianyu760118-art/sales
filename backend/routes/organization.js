const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm, getUserPermissions } = require('../auth-middleware');

['org_departments', 'org_positions', 'org_personnel', 'org_personnel_perms', 'org_position_perms', 'org_position_roles', 'org_employee_orgs'].forEach(name => ensureTable(name));

// ==================== 字典：工作角色（负责人 / 管理员 / 操作员） ====================
const WORK_ROLES = [
  { code: 'leader',   name: '负责人', color: '#e74c3c', order: 1, description: '本中心全面负责：审批 + 业务 + 管理' },
  { code: 'admin',    name: '管理员', color: '#f39c12', order: 2, description: '本中心数据与权限管理' },
  { code: 'operator', name: '操作员', color: '#3498db', order: 3, description: '日常业务操作' }
];
const WORK_ROLE_CODES = WORK_ROLES.map(r => r.code);

// ==================== 字典：四大中心（组织顶层） ====================
const CENTERS = [
  { code: 'mgmt',  name: '管理中心',   description: '行政/人事/财务/IT 等管理职能汇聚中心' },
  { code: 'sales', name: '销售中心',   description: '业务承接、询价/订单/客户/项目交付' },
  { code: 'rd',    name: '研发中心',   description: '产品/物料/BOM/核价/图纸/合规/测试' },
  { code: 'scm',   name: '供应链中心', description: '采购、供应商、生产、仓储' }
];

// 收集某个中心下的所有子部门 id（含自身）。按 code/name 匹配顶层中心。
function collectCenterDescendantIds(centerRecord, allDepartments) {
  let root = allDepartments.find(d => d.id === centerRecord.id);
  if (!root) {
    root = allDepartments.find(d =>
      String(d.code || '') === String(centerRecord.code || '') ||
      String(d.org_code || '') === String(centerRecord.org_code || '') ||
      String(d.name || '') === String(centerRecord.name || '')
    );
  }
  if (!root) return { root: null, ids: [] };
  const ids = new Set([root.id]);
  let added = true;
  while (added) {
    added = false;
    allDepartments.forEach(d => {
      if (d.parent_id && ids.has(d.parent_id) && !ids.has(d.id)) {
        ids.add(d.id);
        added = true;
      }
    });
  }
  return { root, ids: [...ids] };
}

// ==================== 四大中心 × 工作角色矩阵 ====================

const CENTER_NAMES_BY_CODE = Object.fromEntries(CENTERS.map(c => [c.code, c.name]));

// 自动识别部门树中的顶层中心（按名称匹配四大中心定义）
function detectCentersFromDepts(departments) {
  return CENTERS.map(c => {
    const matched = departments.find(d => d.name === c.name);
    return { ...c, department_id: matched ? matched.id : null, exists: !!matched, department: matched || null };
  });
}

router.get('/work-roles', requirePerm('org:view'), (req, res) => {
  res.json({ data: WORK_ROLES });
});

// 获取中心列表（含人员统计和角色分布）
router.get('/centers', requirePerm('org:view'), (req, res) => {
  const deptTable = getTable('org_departments');
  const personnelTable = getTable('org_personnel');
  const depts = deptTable.all();
  const personnel = personnelTable.all();
  const centers = detectCentersFromDepts(depts);
  const enriched = centers.map(c => {
    if (!c.department_id) return { ...c, descendant_department_ids: [], personnel_count: 0, work_role_stats: [] };
    const { ids } = collectCenterDescendantIds(c.department, depts);
    const centerPersonnel = personnel.filter(p => p.department_id && ids.includes(p.department_id));
    const wrStats = WORK_ROLES.map(wr => ({
      code: wr.code, name: wr.name, count: centerPersonnel.filter(p => (p.work_role || 'operator') === wr.code).length
    }));
    return { ...c, descendant_department_ids: ids, personnel_count: centerPersonnel.length, work_role_stats: wrStats };
  });
  res.json({ data: enriched, total: enriched.length });
});

// 中心×角色矩阵（详细数据，含人员明细）
router.get('/center-role-matrix', requirePerm('org:view'), (req, res) => {
  const deptTable = getTable('org_departments');
  const personnelTable = getTable('org_personnel');
  const positionsTable = getTable('org_positions');
  const depts = deptTable.all();
  const personnel = personnelTable.all();
  const positions = positionsTable.all();
  const centers = detectCentersFromDepts(depts);
  const rows = [];
  centers.forEach(c => {
    if (!c.department_id) return;
    const { ids } = collectCenterDescendantIds(c.department, depts);
    WORK_ROLES.forEach(wr => {
      const matched = personnel.filter(p =>
        p.department_id && ids.includes(p.department_id) && (p.work_role || 'operator') === wr.code
      );
      rows.push({
        center_code: c.code, center_name: c.name, center_department_id: c.department_id,
        role_code: wr.code, role_name: wr.name, role_color: wr.color, role_order: wr.order,
        count: matched.length,
        personnel: matched.map(p => ({
          ...p,
          work_role: p.work_role || 'operator',
          department_name: (depts.find(d => d.id === p.department_id) || {}).name || '',
          position_name: (positionsTable.all().find(x => x.id === p.position_id) || {}).name || ''
        }))
      });
    });
  });
  res.json({ data: rows, work_roles: WORK_ROLES, centers: CENTERS });
});

// 按中心（部门）查看人员列表，可按工作角色筛选
router.get('/centers/:departmentId/personnel', requirePerm('org:view'), (req, res) => {
  const deptTable = getTable('org_departments');
  const personnelTable = getTable('org_personnel');
  const positionsTable = getTable('org_positions');
  const { role_code, keyword, status } = req.query;
  const depts = deptTable.all();
  const department = depts.find(d => d.id === Number(req.params.departmentId));
  if (!department) return res.status(404).json({ error: '部门不存在' });
  const { ids } = collectCenterDescendantIds(department, depts);
  let list = personnelTable.all().filter(p => p.department_id && ids.includes(p.department_id));
  if (role_code) list = list.filter(p => (p.work_role || 'operator') === role_code);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter(p => (p.name || '').toLowerCase().includes(kw) || (p.emp_code || '').toLowerCase().includes(kw));
  }
  if (status) list = list.filter(p => p.status === status);
  const enriched = list.map(p => ({
    ...p,
    work_role: p.work_role || 'operator',
    department_name: (depts.find(d => d.id === p.department_id) || {}).name || '',
    position_name: (positionsTable.all().find(x => x.id === p.position_id) || {}).name || ''
  }));
  res.json({ data: enriched, total: enriched.length, work_roles: WORK_ROLES });
});

function normalizeWorkRole(v) {
  if (v === undefined || v === null || v === '') return 'operator';
  const s = String(v);
  return WORK_ROLE_CODES.includes(s) ? s : 'operator';
}

// ==================== 部门富集（人员 → 部门；部门 → 上下级/负责人/计数） ====================
//
// 这里统一封装"实时部门信息"，保证人员管理页与部门管理页看到的是同一份数据。
// 任意调用方修改了部门名称/编码/上级/负责人，personnel/department 接口在
// 下一次响应中都会带上最新值，无需前端手工 invalidate。
function _deptMap() {
  return new Map(getTable('org_departments').all().map(d => [Number(d.id), d]));
}
function _personnelMap() {
  return new Map(getTable('org_personnel').all().map(p => [Number(p.id), p]));
}

function enrichDepartment(dept, deptMap, personnelMap, positionsTable, personnelTable) {
  if (!dept) return null;
  const dm = deptMap || _deptMap();
  const pm = personnelMap || _personnelMap();
  const parent = dept.parent_id ? dm.get(Number(dept.parent_id)) : null;
  const manager = dept.manager_id ? pm.get(Number(dept.manager_id)) : null;
  const childDepts = [...dm.values()].filter(d => Number(d.parent_id || 0) === Number(dept.id));
  const positionsAll = positionsTable ? positionsTable.all() : getTable('org_positions').all();
  const personnelAll = personnelTable ? personnelTable.all() : getTable('org_personnel').all();
  return {
    id: dept.id,
    name: dept.name || '',
    code: dept.code || '',
    org_code: dept.org_code || '',
    parent_id: dept.parent_id || null,
    parent_name: parent ? parent.name : '',
    parent_code: parent ? (parent.code || '') : '',
    manager_id: dept.manager_id || null,
    manager_name: manager ? manager.name : (dept.manager_name || ''),
    manager_emp_code: manager ? (manager.emp_code || '') : '',
    child_count: childDepts.length,
    child_names: childDepts.map(c => c.name),
    position_count: positionsAll.filter(p => Number(p.department_id) === Number(dept.id)).length,
    personnel_count: personnelAll.filter(p => Number(p.department_id) === Number(dept.id)).length,
    active_personnel_count: personnelAll.filter(p => Number(p.department_id) === Number(dept.id) && p.status === 'active').length,
    status: dept.status || 'active',
    sort: dept.sort || 0,
    description: dept.description || '',
    org_type: dept.org_type || ''
  };
}

function enrichPersonnelWithDepartment(p, deptMap, personnelMap) {
  const dm = deptMap || _deptMap();
  const pm = personnelMap || _personnelMap();
  const dept = p.department_id ? dm.get(Number(p.department_id)) : null;
  const info = enrichDepartment(dept, dm, pm);
  return {
    ...p,
    department_info: info,
    is_department_manager: !!(dept && dept.manager_id && Number(dept.manager_id) === Number(p.id))
  };
}

// ==================== 部门管理 ====================

router.get('/departments', requirePerm('org:view'), (req, res) => {
  const table = getTable('org_departments');
  const personnelTable = getTable('org_personnel');
  const positionsTable = getTable('org_positions');
  const { keyword, status, parent_id, flat } = req.query;
  let list = table.all();
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter(d => (d.name || '').toLowerCase().includes(kw) || (d.code || '').toLowerCase().includes(kw));
  }
  if (status) list = list.filter(d => d.status === status);
  if (parent_id !== undefined && parent_id !== '') {
    list = list.filter(d => String(d.parent_id || '') === String(parent_id));
  }
  list.sort((a, b) => (a.sort || 0) - (b.sort || 0) || (a.id - b.id));

  const personnelAll = personnelTable.all();
  const positionsAll = positionsTable.all();
  const enriched = list.map(d => ({
    ...d,
    personnel_count: personnelAll.filter(p => p.department_id === d.id).length,
    position_count: positionsAll.filter(p => p.department_id === d.id).length,
    manager_name: d.manager_id ? (personnelAll.find(p => p.id === d.manager_id) || {}).name || '' : '',
    parent_name: d.parent_id ? (list.find(x => x.id === d.parent_id) || {}).name || '' : ''
  }));

  if (flat === '1') return res.json({ data: enriched, total: enriched.length });

  const buildTree = (parentId) => enriched
    .filter(d => String(d.parent_id || '') === String(parentId || ''))
    .map(d => ({ ...d, children: buildTree(d.id) }));
  const tree = buildTree('');
  res.json({ data: tree, flat: enriched, total: enriched.length });
});

router.get('/departments/:id', requirePerm('org:view'), (req, res) => {
  const table = getTable('org_departments');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '部门不存在' });
  const positionsAll = getTable('org_positions').all();
  const personnelAll = getTable('org_personnel').all();
  const info = enrichDepartment(row, _deptMap(), _personnelMap(), null, null);
  res.json({
    ...row,
    ...info,
    personnel_list: personnelAll.filter(p => p.department_id === row.id).map(p => ({
      id: p.id, name: p.name, emp_code: p.emp_code || '',
      work_role: p.work_role || 'operator', status: p.status || 'active'
    })),
    position_list: positionsAll.filter(p => p.department_id === row.id).map(p => ({
      id: p.id, name: p.name, code: p.code || '',
      personnel_count: personnelAll.filter(x => x.position_id === p.id).length
    }))
  });
});

router.post('/departments', requirePerm('org:create'), async (req, res) => {
  const { name, code, parent_id, manager_id, sort, description, status } = req.body;
  if (!name) return res.status(400).json({ error: '部门名称为必填' });
  const table = getTable('org_departments');
  if (code) {
    const dup = table.all().find(d => d.code === code);
    if (dup) return res.status(400).json({ error: '部门编码已存在' });
  }
  const result = await table.insert({
    name, code: code || '',
    parent_id: parent_id ? Number(parent_id) : null,
    manager_id: manager_id ? Number(manager_id) : null,
    sort: sort || 0,
    description: description || '',
    status: status || 'active',
    created_at: now(), updated_at: now()
  });
  table._invalidate();
  res.json({ message: '部门创建成功', data: table.findById(result.lastID) });
});

router.put('/departments/:id', requirePerm('org:edit'), async (req, res) => {
  const table = getTable('org_departments');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '部门不存在' });
  const { name, code, parent_id, manager_id, sort, description, status } = req.body;
  if (code && code !== existing.code) {
    const dup = table.all().find(d => d.code === code && d.id !== Number(req.params.id));
    if (dup) return res.status(400).json({ error: '部门编码已存在' });
  }
  if (parent_id && Number(parent_id) === Number(req.params.id)) {
    return res.status(400).json({ error: '上级部门不能为自身' });
  }
  const updates = { updated_at: now() };
  if (name !== undefined) updates.name = name;
  if (code !== undefined) updates.code = code;
  if (parent_id !== undefined) updates.parent_id = parent_id ? Number(parent_id) : null;
  if (manager_id !== undefined) updates.manager_id = manager_id ? Number(manager_id) : null;
  if (sort !== undefined) updates.sort = sort;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  await table.update(req.params.id, updates);
  table._invalidate();
  res.json({ message: '部门更新成功', data: table.findById(req.params.id) });
});

router.delete('/departments/:id', requirePerm('org:delete'), async (req, res) => {
  const table = getTable('org_departments');
  const positionsTable = getTable('org_positions');
  const personnelTable = getTable('org_personnel');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '部门不存在' });
  const hasChildren = table.all().some(d => d.parent_id === Number(req.params.id));
  if (hasChildren) return res.status(400).json({ error: '存在下级部门，请先删除子部门' });
  const hasPositions = positionsTable.all().some(p => p.department_id === Number(req.params.id));
  if (hasPositions) return res.status(400).json({ error: '该部门下存在岗位，请先处理岗位' });
  const hasPersonnel = personnelTable.all().some(p => p.department_id === Number(req.params.id));
  if (hasPersonnel) return res.status(400).json({ error: '该部门下存在人员，请请先调整人员归属' });
  await table.delete(req.params.id);
  table._invalidate();
  res.json({ message: '部门删除成功' });
});

// ==================== 岗位管理 ====================

router.get('/positions', requirePerm('org:view'), (req, res) => {
  const positionsTable = getTable('org_positions');
  const departmentsTable = getTable('org_departments');
  const personnelTable = getTable('org_personnel');
  const positionPermsTable = getTable('org_position_perms');
  const positionRolesTable = getTable('org_position_roles');
  const permTable = getTable('permissions');
  const roleTable = getTable('roles');

  const { keyword, department_id, status } = req.query;
  let list = positionsTable.all();
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter(p => (p.name || '').toLowerCase().includes(kw) || (p.code || '').toLowerCase().includes(kw));
  }
  if (department_id) list = list.filter(p => String(p.department_id) === String(department_id));
  if (status) list = list.filter(p => p.status === status);
  list.sort((a, b) => (a.sort || 0) - (b.sort || 0) || (a.id - b.id));

  const allDepts = departmentsTable.all();
  const allPersonnel = personnelTable.all();
  const allPerms = permTable.all();
  const allRoles = roleTable.all();
  const allPosPerms = positionPermsTable.all();
  const allPosRoles = positionRolesTable.all();

  const result = list.map(p => {
    const permIds = allPosPerms.filter(pp => pp.position_id === p.id).map(pp => pp.permission_id);
    const roleIds = allPosRoles.filter(pr => pr.position_id === p.id).map(pr => pr.role_id);
    return {
      ...p,
      department_name: (allDepts.find(d => d.id === p.department_id) || {}).name || '',
      personnel_count: allPersonnel.filter(x => x.position_id === p.id).length,
      permission_count: permIds.length,
      role_count: roleIds.length,
      permission_codes: permIds.map(pid => (allPerms.find(x => x.id === pid) || {}).code).filter(Boolean),
      role_codes: roleIds.map(rid => (allRoles.find(x => x.id === rid) || {}).code).filter(Boolean)
    };
  });

  res.json({ data: result, total: result.length });
});

router.get('/positions/:id', requirePerm('org:view'), (req, res) => {
  const positionsTable = getTable('org_positions');
  const positionPermsTable = getTable('org_position_perms');
  const positionRolesTable = getTable('org_position_roles');
  const permTable = getTable('permissions');
  const roleTable = getTable('roles');
  const row = positionsTable.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '岗位不存在' });
  const permIds = positionPermsTable.all().filter(pp => pp.position_id === Number(req.params.id)).map(pp => pp.permission_id);
  const roleIds = positionRolesTable.all().filter(pr => pr.position_id === Number(req.params.id)).map(pr => pr.role_id);
  res.json({
    ...row,
    permissions: permIds.map(pid => permTable.findById(pid)).filter(Boolean),
    roles: roleIds.map(rid => roleTable.findById(rid)).filter(Boolean)
  });
});

router.post('/positions', requirePerm('org:position:manage'), async (req, res) => {
  const { name, code, department_id, level, sort, description, status, permission_ids, role_ids } = req.body;
  if (!name) return res.status(400).json({ error: '岗位名称为必填' });
  if (!department_id) return res.status(400).json({ error: '所属部门为必填' });
  const positionsTable = getTable('org_positions');
  const departmentsTable = getTable('org_departments');
  if (!departmentsTable.findById(department_id)) return res.status(400).json({ error: '部门不存在' });
  if (code) {
    const dup = positionsTable.all().find(p => p.code === code);
    if (dup) return res.status(400).json({ error: '岗位编码已存在' });
  }
  const result = await positionsTable.insert({
    name, code: code || '',
    department_id: Number(department_id),
    level: level || '',
    sort: sort || 0,
    description: description || '',
    status: status || 'active',
    created_at: now(), updated_at: now()
  });
  const positionId = result.lastID;

  if (Array.isArray(permission_ids)) {
    const ppTable = getTable('org_position_perms');
    await Promise.all(permission_ids.map(pid => ppTable.insert({ position_id: positionId, permission_id: Number(pid), granted_at: now() })));
    ppTable._invalidate();
  }
  if (Array.isArray(role_ids)) {
    const prTable = getTable('org_position_roles');
    await Promise.all(role_ids.map(rid => prTable.insert({ position_id: positionId, role_id: Number(rid), assigned_at: now() })));
    prTable._invalidate();
  }
  positionsTable._invalidate();
  res.json({ message: '岗位创建成功', data: positionsTable.findById(positionId) });
});

router.put('/positions/:id', requirePerm('org:position:manage'), async (req, res) => {
  const positionsTable = getTable('org_positions');
  const existing = positionsTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '岗位不存在' });
  const { name, code, department_id, level, sort, description, status, permission_ids, role_ids } = req.body;
  if (code && code !== existing.code) {
    const dup = positionsTable.all().find(p => p.code === code && p.id !== Number(req.params.id));
    if (dup) return res.status(400).json({ error: '岗位编码已存在' });
  }
  const updates = { updated_at: now() };
  if (name !== undefined) updates.name = name;
  if (code !== undefined) updates.code = code;
  if (department_id !== undefined) updates.department_id = Number(department_id);
  if (level !== undefined) updates.level = level;
  if (sort !== undefined) updates.sort = sort;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  await positionsTable.update(req.params.id, updates);
  positionsTable._invalidate();

  if (Array.isArray(permission_ids)) {
    const ppTable = getTable('org_position_perms');
    await Promise.all(ppTable.all().filter(pp => pp.position_id === Number(req.params.id)).map(pp => ppTable.delete(pp.id)));
    await Promise.all(permission_ids.map(pid => ppTable.insert({ position_id: Number(req.params.id), permission_id: Number(pid), granted_at: now() })));
    ppTable._invalidate();
  }
  if (Array.isArray(role_ids)) {
    const prTable = getTable('org_position_roles');
    await Promise.all(prTable.all().filter(pr => pr.position_id === Number(req.params.id)).map(pr => prTable.delete(pr.id)));
    await Promise.all(role_ids.map(rid => prTable.insert({ position_id: Number(req.params.id), role_id: Number(rid), assigned_at: now() })));
    prTable._invalidate();
  }
  res.json({ message: '岗位更新成功', data: positionsTable.findById(req.params.id) });
});

router.delete('/positions/:id', requirePerm('org:position:manage'), async (req, res) => {
  const positionsTable = getTable('org_positions');
  const personnelTable = getTable('org_personnel');
  const existing = positionsTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '岗位不存在' });
  const hasPersonnel = personnelTable.all().some(p => p.position_id === Number(req.params.id));
  if (hasPersonnel) return res.status(400).json({ error: '该岗位下存在人员，请先调整人员岗位' });
  await positionsTable.delete(req.params.id);
  positionsTable._invalidate();
  const ppTable = getTable('org_position_perms');
  const prTable = getTable('org_position_roles');
  await Promise.all(ppTable.all().filter(pp => pp.position_id === Number(req.params.id)).map(pp => ppTable.delete(pp.id)));
  await Promise.all(prTable.all().filter(pr => pr.position_id === Number(req.params.id)).map(pr => prTable.delete(pr.id)));
  ppTable._invalidate();
  prTable._invalidate();
  res.json({ message: '岗位删除成功' });
});

router.get('/positions/:id/permissions', requirePerm('org:view'), (req, res) => {
  const ppTable = getTable('org_position_perms');
  const permTable = getTable('permissions');
  const records = ppTable.all().filter(pp => pp.position_id === Number(req.params.id));
  const permissions = records.map(r => permTable.findById(r.permission_id)).filter(Boolean);
  res.json({ data: permissions });
});

router.put('/positions/:id/permissions', requirePerm('org:position:manage'), async (req, res) => {
  const { permission_ids } = req.body;
  if (!Array.isArray(permission_ids)) return res.status(400).json({ error: 'permission_ids必须为数组' });
  const ppTable = getTable('org_position_perms');
  await Promise.all(ppTable.all().filter(pp => pp.position_id === Number(req.params.id)).map(pp => ppTable.delete(pp.id)));
  await Promise.all(permission_ids.map(pid => ppTable.insert({ position_id: Number(req.params.id), permission_id: Number(pid), granted_at: now() })));
  ppTable._invalidate();
  res.json({ message: '岗位默认权限已更新', assigned: permission_ids.length });
});

router.get('/positions/:id/roles', requirePerm('org:view'), (req, res) => {
  const prTable = getTable('org_position_roles');
  const roleTable = getTable('roles');
  const records = prTable.all().filter(pr => pr.position_id === Number(req.params.id));
  const roles = records.map(r => roleTable.findById(r.role_id)).filter(Boolean);
  res.json({ data: roles });
});

router.put('/positions/:id/roles', requirePerm('org:position:manage'), async (req, res) => {
  const { role_ids } = req.body;
  if (!Array.isArray(role_ids)) return res.status(400).json({ error: 'role_ids必须为数组' });
  const prTable = getTable('org_position_roles');
  await Promise.all(prTable.all().filter(pr => pr.position_id === Number(req.params.id)).map(pr => prTable.delete(pr.id)));
  await Promise.all(role_ids.map(rid => prTable.insert({ position_id: Number(req.params.id), role_id: Number(rid), assigned_at: now() })));
  prTable._invalidate();
  res.json({ message: '岗位默认角色已更新', assigned: role_ids.length });
});

// ==================== 人员管理 ====================

router.get('/personnel', requirePerm('org:view'), (req, res) => {
  const personnelTable = getTable('org_personnel');
  const departmentsTable = getTable('org_departments');
  const positionsTable = getTable('org_positions');
  const { keyword, department_id, position_id, status, work_role, sync_exempt } = req.query;
  let list = personnelTable.all();
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    list = list.filter(p => (p.name || '').toLowerCase().includes(kw) || (p.emp_code || '').toLowerCase().includes(kw) || (p.phone || '').includes(kw));
  }
  if (department_id) list = list.filter(p => String(p.department_id) === String(department_id));
  if (position_id) list = list.filter(p => String(p.position_id) === String(position_id));
  if (status) list = list.filter(p => p.status === status);
  if (work_role) list = list.filter(p => String(p.work_role || 'operator') === String(work_role));
  if (sync_exempt === '1') list = list.filter(p => !!p.sync_exempt);
  else if (sync_exempt === '0') list = list.filter(p => !p.sync_exempt);
  list.sort((a, b) => (a.sort || 0) - (b.sort || 0) || (a.id - b.id));

  const allDepts = departmentsTable.all();
  const allPersonnel = personnelTable.all();
  const allPositions = positionsTable.all();
  const deptMap = new Map(allDepts.map(d => [Number(d.id), d]));
  const personnelMap = new Map(allPersonnel.map(p => [Number(p.id), p]));
  const roleMeta = Object.fromEntries(WORK_ROLES.map(r => [r.code, r]));
  const result = list.map(p => {
    const wr = normalizeWorkRole(p.work_role);
    const enriched = enrichPersonnelWithDepartment(p, deptMap, personnelMap);
    return {
      ...enriched,
      work_role: wr,
      work_role_name: (roleMeta[wr] || {}).name || '操作员',
      work_role_color: (roleMeta[wr] || {}).color || '#3498db',
      department_name: enriched.department_info ? enriched.department_info.name : '',
      position_name: (allPositions.find(x => x.id === p.position_id) || {}).name || '',
      position_code: (allPositions.find(x => x.id === p.position_id) || {}).code || ''
    };
  });
  res.json({ data: result, total: result.length, work_roles: WORK_ROLES });
});

router.get('/personnel/:id', requirePerm('org:view'), (req, res) => {
  const personnelTable = getTable('org_personnel');
  const row = personnelTable.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '人员不存在' });
  const departmentsTable = getTable('org_departments');
  const positionsTable = getTable('org_positions');
  const roleMeta = Object.fromEntries(WORK_ROLES.map(r => [r.code, r]));
  const wr = normalizeWorkRole(row.work_role);
  const enriched = enrichPersonnelWithDepartment(row);
  const out = {
    ...enriched,
    work_role: wr,
    work_role_name: (roleMeta[wr] || {}).name || '操作员',
    work_role_color: (roleMeta[wr] || {}).color || '#3498db',
    department_name: enriched.department_info ? enriched.department_info.name : '',
    position_name: (positionsTable.findById(row.position_id) || {}).name || '',
    position_code: (positionsTable.findById(row.position_id) || {}).code || ''
  };
  res.json(out);
});

router.post('/personnel', requirePerm('org:personnel:manage'), async (req, res) => {
  const { emp_code, name, department_id, position_id, phone, email, gender, sort, description, status, linked_user_id, work_role, sync_exempt } = req.body;
  if (!name) return res.status(400).json({ error: '人员姓名为必填' });
  const personnelTable = getTable('org_personnel');
  if (emp_code) {
    const dup = personnelTable.all().find(p => p.emp_code === emp_code);
    if (dup) return res.status(400).json({ error: '工号已存在' });
  }
  const result = await personnelTable.insert({
    emp_code: emp_code || '',
    name,
    department_id: department_id ? Number(department_id) : null,
    position_id: position_id ? Number(position_id) : null,
    phone: phone || '',
    email: email || '',
    gender: gender || '',
    sort: sort || 0,
    description: description || '',
    status: status || 'active',
    linked_user_id: linked_user_id ? Number(linked_user_id) : null,
    work_role: normalizeWorkRole(work_role),
    sync_exempt: !!sync_exempt,
    created_at: now(), updated_at: now()
  });
  personnelTable._invalidate();
  res.json({ message: '人员创建成功', data: personnelTable.findById(result.lastID) });
});

router.put('/personnel/:id', requirePerm('org:personnel:manage'), async (req, res) => {
  const personnelTable = getTable('org_personnel');
  const existing = personnelTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '人员不存在' });
  const { emp_code, name, department_id, position_id, phone, email, gender, sort, description, status, linked_user_id, work_role, sync_exempt } = req.body;
  if (emp_code && emp_code !== existing.emp_code) {
    const dup = personnelTable.all().find(p => p.emp_code === emp_code && p.id !== Number(req.params.id));
    if (dup) return res.status(400).json({ error: '工号已存在' });
  }
  const updates = { updated_at: now() };
  if (emp_code !== undefined) updates.emp_code = emp_code;
  if (name !== undefined) updates.name = name;
  if (department_id !== undefined) updates.department_id = department_id ? Number(department_id) : null;
  if (position_id !== undefined) updates.position_id = position_id ? Number(position_id) : null;
  if (phone !== undefined) updates.phone = phone;
  if (email !== undefined) updates.email = email;
  if (gender !== undefined) updates.gender = gender;
  if (sort !== undefined) updates.sort = sort;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (linked_user_id !== undefined) updates.linked_user_id = linked_user_id ? Number(linked_user_id) : null;
  if (work_role !== undefined) updates.work_role = normalizeWorkRole(work_role);
  if (sync_exempt !== undefined) updates.sync_exempt = !!sync_exempt;
  await personnelTable.update(req.params.id, updates);
  personnelTable._invalidate();
  res.json({ message: '人员更新成功', data: personnelTable.findById(req.params.id) });
});

router.delete('/personnel/:id', requirePerm('org:personnel:manage'), async (req, res) => {
  const personnelTable = getTable('org_personnel');
  const ppTable = getTable('org_personnel_perms');
  const existing = personnelTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '人员不存在' });
  await personnelTable.delete(req.params.id);
  personnelTable._invalidate();
  await Promise.all(ppTable.all().filter(pp => pp.personnel_id === Number(req.params.id)).map(pp => ppTable.delete(pp.id)));
  ppTable._invalidate();
  res.json({ message: '人员删除成功' });
});

// ==================== 人员批量修改 ====================
//
// 请求体：
//   {
//     personnel_ids: [1, 2, 3],            // 必填，至少 1 项
//     updates: {                           // 仅传需要改的字段（不传则不改）
//       department_id?: number | null,     // null 表示清空所属部门
//       position_id?:  number | null,
//       work_role?:    'leader'|'admin'|'operator'|'__clear__',  // '__clear__' 表示清空
//       status?:       'active'|'inactive',
//       linked_user_id?: number | null
//     }
//   }
// 限制：
//   - 单次最多 500 人
//   - emp_code / name / phone / email 等人员个性化字段不允许批量修改（防误操作）
//   - 至少传 1 个可改字段
router.post('/personnel/batch-update', requirePerm('org:personnel:manage'), async (req, res) => {
  const { personnel_ids, updates } = req.body || {};
  if (!Array.isArray(personnel_ids) || personnel_ids.length === 0) {
    return res.status(400).json({ error: 'personnel_ids 必须为非空数组' });
  }
  if (personnel_ids.length > 500) {
    return res.status(400).json({ error: '单次最多批量修改 500 人' });
  }
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'updates 必须为对象' });
  }

  const ALLOWED = ['department_id', 'position_id', 'work_role', 'status', 'linked_user_id', 'sync_exempt'];
  const patch = { updated_at: now() };
  let touched = 0;
  for (const k of ALLOWED) {
    if (!Object.prototype.hasOwnProperty.call(updates, k)) continue;
    touched++;
    if (k === 'work_role') {
      const v = updates.work_role;
      if (v === null || v === '__clear__') patch.work_role = null;
      else patch.work_role = normalizeWorkRole(v);
    } else if (k === 'status') {
      const v = updates.status;
      if (!['active', 'inactive'].includes(v)) {
        return res.status(400).json({ error: 'status 只能为 active/inactive' });
      }
      patch.status = v;
    } else if (k === 'sync_exempt') {
      patch.sync_exempt = !!updates.sync_exempt;
    } else if (k === 'department_id' || k === 'position_id' || k === 'linked_user_id') {
      const raw = updates[k];
      patch[k] = (raw === null || raw === '' || raw === undefined) ? null : Number(raw);
      // 校验外键存在
      const table = getTable(
        k === 'department_id' ? 'org_departments' :
        k === 'position_id'   ? 'org_positions'   :
                                'users'
      );
      if (patch[k] !== null && !table.findById(patch[k])) {
        return res.status(400).json({ error: `${k}=${patch[k]} 不存在` });
      }
    }
  }
  if (touched === 0) {
    return res.status(400).json({ error: `updates 至少包含一个字段，可选: ${ALLOWED.join('/')}` });
  }

  const personnelTable = getTable('org_personnel');
  const all = personnelTable.all();
  const idSet = new Set(personnel_ids.map(Number).filter(Boolean));
  const targets = all.filter(p => idSet.has(p.id));
  const missing = personnel_ids.filter(id => !idSet.has(Number(id)));

  await Promise.all(targets.map(p => personnelTable.update(p.id, { ...patch })));
  personnelTable._invalidate();

  res.json({
    message: '批量修改完成',
    requested: personnel_ids.length,
    updated: targets.length,
    missing,
    patch
  });
});

// ==================== 人员权限个性化调整 ====================

router.get('/personnel/:id/permissions', requirePerm('org:view'), (req, res) => {
  const personnelId = Number(req.params.id);
  const personnelTable = getTable('org_personnel');
  const positionsTable = getTable('org_positions');
  const ppTable = getTable('org_position_perms');
  const prTable = getTable('org_position_roles');
  const personPpTable = getTable('org_personnel_perms');
  const urTable = getTable('user_roles');
  const roleTable = getTable('roles');
  const rpTable = getTable('role_permissions');
  const permTable = getTable('permissions');

  const person = personnelTable.findById(personnelId);
  if (!person) return res.status(404).json({ error: '人员不存在' });

  // 1. 岗位默认权限（直接分配）
  const defaultPermIds = new Set();
  if (person.position_id) {
    ppTable.all().filter(pp => pp.position_id === person.position_id).forEach(pp => defaultPermIds.add(pp.permission_id));
  }
  // 2. 收集角色（岗位角色 + 关联用户角色）
  const roleIds = new Set();
  if (person.position_id) {
    prTable.all().filter(pr => pr.position_id === person.position_id).forEach(pr => roleIds.add(pr.role_id));
  }
  if (person.linked_user_id) {
    urTable.all().filter(ur => ur.user_id === person.linked_user_id).forEach(ur => roleIds.add(ur.role_id));
  }
  // 3. 角色展开为权限
  const rolePermIds = new Set();
  roleIds.forEach(rid => {
    const role = roleTable.findById(rid);
    if (role && role.code === 'admin') {
      permTable.all().forEach(p => rolePermIds.add(p.id));
    } else {
      rpTable.all().filter(rp => rp.role_id === rid).forEach(rp => rolePermIds.add(rp.permission_id));
    }
  });
  // 4. 个性化调整
  const overrides = personPpTable.all().filter(pp => pp.personnel_id === personnelId);
  const grantedIds = new Set();
  const deniedIds = new Set();
  overrides.forEach(o => {
    if (o.type === 'grant') grantedIds.add(o.permission_id);
    else if (o.type === 'deny') deniedIds.add(o.permission_id);
  });
  // 5. 最终有效权限 = 岗位默认 + 角色派生 + 个性化追加 - 个性化撤销
  const effectiveIds = new Set([...defaultPermIds, ...rolePermIds, ...grantedIds]);
  deniedIds.forEach(id => effectiveIds.delete(id));

  const allPerms = permTable.all();
  res.json({
    default_permission_ids: [...defaultPermIds],
    role_permission_ids: [...rolePermIds],
    granted_permission_ids: [...grantedIds],
    denied_permission_ids: [...deniedIds],
    effective_permission_ids: [...effectiveIds],
    effective_permissions: [...effectiveIds].map(id => allPerms.find(p => p.id === id)).filter(Boolean),
    default_permissions: [...defaultPermIds].map(id => allPerms.find(p => p.id === id)).filter(Boolean),
    role_permissions: [...rolePermIds].map(id => allPerms.find(p => p.id === id)).filter(Boolean)
  });
});

router.put('/personnel/:id/permissions', requirePerm('org:personnel:manage'), async (req, res) => {
  const { overrides } = req.body; // [{ permission_id, type: 'grant'|'deny' }]
  if (!Array.isArray(overrides)) return res.status(400).json({ error: 'overrides必须为数组' });
  const personnelId = Number(req.params.id);
  const personnelTable = getTable('org_personnel');
  if (!personnelTable.findById(personnelId)) return res.status(404).json({ error: '人员不存在' });
  const ppTable = getTable('org_personnel_perms');
  await Promise.all(ppTable.all().filter(pp => pp.personnel_id === personnelId).map(pp => ppTable.delete(pp.id)));
  const inserts = overrides
    .filter(o => o && o.permission_id && (o.type === 'grant' || o.type === 'deny'))
    .map(o => ppTable.insert({ personnel_id: personnelId, permission_id: Number(o.permission_id), type: o.type, updated_at: now() }));
  if (inserts.length) await Promise.all(inserts);
  ppTable._invalidate();
  res.json({ message: '人员权限个性化调整已更新', count: overrides.length });
});

// ==================== 综合接口：人员有效权限（含岗位+个性化） ====================

router.get('/personnel/:id/effective-permissions', (req, res) => {
  const personnelId = Number(req.params.id);
  const personnelTable = getTable('org_personnel');
  const positionsTable = getTable('org_positions');
  const ppTable = getTable('org_position_perms');
  const prTable = getTable('org_position_roles');
  const personPpTable = getTable('org_personnel_perms');
  const urTable = getTable('user_roles');
  const permTable = getTable('permissions');
  const roleTable = getTable('roles');
  const userTable = getTable('users');

  const person = personnelTable.findById(personnelId);
  if (!person) return res.status(404).json({ error: '人员不存在' });

  // 1. 岗位默认权限（直接分配的权限 + 岗位关联角色）
  const permIds = new Set();
  const roleIds = new Set();
  if (person.position_id) {
    ppTable.all().filter(pp => pp.position_id === person.position_id).forEach(pp => permIds.add(pp.permission_id));
    prTable.all().filter(pr => pr.position_id === person.position_id).forEach(pr => roleIds.add(pr.role_id));
  }
  // 2. 关联系统用户：通过 user_roles 收集额外角色
  if (person.linked_user_id) {
    urTable.all().filter(ur => ur.user_id === person.linked_user_id).forEach(ur => roleIds.add(ur.role_id));
  }
  // 3. 角色 → 展开为权限码（先展开 admin，再展开其他角色）
  roleIds.forEach(rid => {
    const role = roleTable.findById(rid);
    if (role && role.code === 'admin') {
      permTable.all().forEach(p => permIds.add(p.id));
    }
  });
  const rpTable = getTable('role_permissions');
  roleIds.forEach(rid => {
    rpTable.all().filter(rp => rp.role_id === rid).forEach(rp => permIds.add(rp.permission_id));
  });
  // 4. 个性化调整（在角色展开之后执行，确保 grant/deny 能正确覆盖角色权限）
  personPpTable.all().filter(pp => pp.personnel_id === personnelId).forEach(o => {
    if (o.type === 'grant') permIds.add(o.permission_id);
    else if (o.type === 'deny') permIds.delete(o.permission_id);
  });

  const permissions = [...permIds].map(pid => permTable.findById(pid)).filter(Boolean);
  const roles = [...roleIds].map(rid => roleTable.findById(rid)).filter(Boolean);
  const linkedUser = person.linked_user_id ? userTable.findById(person.linked_user_id) : null;

  res.json({
    personnel: { ...person, work_role: normalizeWorkRole(person.work_role), work_role_name: (Object.fromEntries(WORK_ROLES.map(r => [r.code, r]))[normalizeWorkRole(person.work_role)] || {}).name || '操作员' },
    linked_user: linkedUser ? { id: linkedUser.id, username: linkedUser.username, name: linkedUser.name } : null,
    effective_permissions: permissions,
    effective_roles: roles,
    source: {
      position_id: person.position_id,
      position_name: person.position_id ? (positionsTable.findById(person.position_id) || {}).name || '' : '',
      work_role: normalizeWorkRole(person.work_role),
      overrides_count: personPpTable.all().filter(pp => pp.personnel_id === personnelId).length
    }
  });
});

// ==================== 统计 ====================

router.get('/stats/summary', requirePerm('org:view'), (req, res) => {
  const departmentsTable = getTable('org_departments');
  const positionsTable = getTable('org_positions');
  const personnelTable = getTable('org_personnel');
  const allPer = personnelTable.all();
  const workRoleStats = WORK_ROLES.map(r => ({
    code: r.code,
    name: r.name,
    count: allPer.filter(p => normalizeWorkRole(p.work_role) === r.code).length
  }));
  res.json({
    total_departments: departmentsTable.all().length,
    active_departments: departmentsTable.all().filter(d => d.status === 'active').length,
    total_positions: positionsTable.all().length,
    active_positions: positionsTable.all().filter(p => p.status === 'active').length,
    total_personnel: allPer.length,
    active_personnel: allPer.filter(p => p.status === 'active').length,
    work_role_stats: workRoleStats
  });
});

// ==================== 同步取数据（从已有 organizations/personnel 导入 + 联合查询） ====================
//
// 已有数据源：
//   organizations (从外部 organizations.list 同步进来) → 包含 org_code/org_name/parent_org_code/...
//   personnel     (从外部 employees.list    同步进来) → 包含 emp_code/name/org_code/position/...
//
// 本组接口：
//   GET  /sync/peek                → 仅取，不导入（用于预览）
//   POST /sync/import              → 真正写入 org_departments / org_personnel / org_employee_orgs
//   GET  /sync/all                 → 一次性返回四类数据：组织/岗位/员工/组织-员工关系

// 预览：源数据（不导入）
router.get('/sync/peek', requirePerm('org:view'), (req, res) => {
  const orgsTable = getTable('organizations');
  const personnelTable = getGetTable('personnel');
  const positionsTable = getGetTable('org_positions');
  orgsTable._invalidate();
  personnelTable._invalidate();
  positionsTable._invalidate();

  const orgs = orgsTable.all();
  const personnel = personnelTable.all();
  const positions = positionsTable.all();
  const relations = personnel.map(p => ({
    emp_code: p.emp_code,
    name: p.name,
    org_code: p.org_code || '',
    org_name: p.org_name || '',
    position_name: p.position || ''
  })).filter(r => r.org_code);

  res.json({
    source: { organizations: orgs.length, personnel: personnel.length, positions: positions.length },
    organizations: orgs,
    personnel,
    positions,
    org_employee_relations: relations
  });
});

function getGetTable(name) {
  return getTable(name);
}

// 真正导入
router.post('/sync/import', requirePerm('org:create'), async (req, res) => {
  const {
    import_organizations = true,
    import_positions = true,
    import_personnel = true,
    build_relations = true,
    sync_position_default_role = false,  // 是否把外部岗位名尝试关联到系统角色（按角色 code/name 模糊匹配）
    reset = false  // 是否在导入前清空 org_departments / org_positions / org_personnel / org_employee_orgs
  } = req.body || {};

  const orgsTable = getTable('organizations');
  const extPersonnelTable = getTable('personnel');
  const extPositionsTable = getTable('org_positions');
  const departmentsTable = getTable('org_departments');
  const positionsTable = getTable('org_positions');
  const personnelTable = getTable('org_personnel');
  const relationsTable = getTable('org_employee_orgs');
  const roleTable = getTable('roles');

  orgsTable._invalidate();
  extPersonnelTable._invalidate();
  extPositionsTable._invalidate();
  departmentsTable._invalidate();
  positionsTable._invalidate();
  personnelTable._invalidate();
  relationsTable._invalidate();
  roleTable._invalidate();

  // reset 模式：仅清空本次同步产生的目标表数据
  // 注意：不要清空 org_positions（它既是同步源也是组织模块管理的目标）
  if (reset) {
    const allRels = relationsTable.all();
    allRels.forEach(r => relationsTable.delete(r.id));
    relationsTable._invalidate();
    personnelTable.all().forEach(p => personnelTable.delete(p.id));
    personnelTable._invalidate();
    departmentsTable.all().forEach(d => departmentsTable.delete(d.id));
    departmentsTable._invalidate();
  }

  // 索引：org_code → 部门；emp_code → 人员；position code → 岗位
  const deptByOrgCode = new Map();
  const personnelByEmpCode = new Map();
  const positionByCode = new Map();
  const positionByName = new Map();

  departmentsTable.all().forEach(d => { if (d.code) deptByOrgCode.set(String(d.code), d); });
  personnelTable.all().forEach(p => { if (p.emp_code) personnelByEmpCode.set(String(p.emp_code), p); });
  positionsTable.all().forEach(p => {
    if (p.code) positionByCode.set(String(p.code), p);
    positionByName.set(String(p.name), p);
  });

  const roleByCode = new Map();
  roleTable.all().forEach(r => roleByCode.set(String(r.code || ''), r));

  let org_created = 0, org_updated = 0, org_skipped = 0;
  let pos_created = 0, pos_updated = 0, pos_skipped = 0;
  let per_created = 0, per_updated = 0, per_skipped = 0, per_exempt_skipped = 0;
  let rel_created = 0, rel_skipped = 0;

  // ---------- 1. 导入组织 → org_departments ----------
  if (import_organizations) {
    const orgs = orgsTable.all();
    // 先建立 code → 记录的快速索引
    const codeToId = new Map();
    departmentsTable.all().forEach(d => { if (d.code) codeToId.set(String(d.code), d); });

    // 第一遍：先创建没有 parent 的部门（根级）
    const remaining = [];
    orgs.forEach(o => {
      if (!o.org_code) { org_skipped++; return; }
      const code = String(o.org_code);
      const existing = codeToId.get(code);
      const fields = {
        name: o.org_name || o.org_code,
        code,
        org_code: o.org_code,
        org_name: o.org_name || '',
        parent_id: null, // 后面再解析
        parent_org_code: o.parent_org_code || '',
        manager_name: o.manager || '',
        org_type: o.org_type || '',
        sort: 0,
        description: '',
        status: (o.status === 'inactive' || o.status === '0' || o.status === 0) ? 'inactive' : 'active',
        updated_at: now()
      };
      if (existing) {
        departmentsTable.update(existing.id, fields);
        codeToId.set(code, { ...existing, ...fields });
        org_updated++;
      } else {
        fields.created_at = now();
        const r = departmentsTable.insert(fields);
        codeToId.set(code, departmentsTable.findById(r.lastID));
        org_created++;
      }
    });

    // 第二遍：解析 parent_id（基于 parent_org_code）
    const all = departmentsTable.all();
    let resolved = 0;
    for (let pass = 0; pass < 4; pass++) {
      let any = false;
      all.forEach(d => {
        if (!d.parent_org_code) return;
        if (d.parent_id) return;
        const p = codeToId.get(String(d.parent_org_code));
        if (p) {
          departmentsTable.update(d.id, { parent_id: p.id, updated_at: now() });
          d.parent_id = p.id;
          resolved++;
          any = true;
        }
      });
      if (!any) break;
    }
  }

  // 重新载入部门索引
  departmentsTable._invalidate();
  const newDeptByOrgCode = new Map();
  departmentsTable.all().forEach(d => {
    if (d.code) newDeptByOrgCode.set(String(d.code), d);
    if (d.org_code) newDeptByOrgCode.set(String(d.org_code), d);
  });

  // ---------- 2. 导入岗位 → org_positions ----------
  if (import_positions) {
    const positions = extPositionsTable.all();
    positions.forEach(p => {
      const code = p.code ? String(p.code) : '';
      const name = p.name || '';
      if (!code && !name) { pos_skipped++; return; }
      const dept = p.department_id ? departmentsTable.findById(p.department_id) : null;
      let existing = code ? positionByCode.get(code) : null;
      if (!existing && name) existing = positionByName.get(String(name));

      const fields = {
        name,
        code: code || '',
        department_id: dept ? dept.id : null,
        level: p.level || '',
        sort: Number(p.sort || 0),
        description: p.description || '',
        status: p.status || 'active',
        updated_at: now()
      };
      if (existing) {
        positionsTable.update(existing.id, fields);
        positionByCode.set(code, { ...existing, ...fields });
        positionByName.set(String(name), { ...existing, ...fields });
        pos_updated++;
      } else {
        fields.created_at = now();
        const r = positionsTable.insert(fields);
        positionByCode.set(code, positionsTable.findById(r.lastID));
        positionByName.set(String(name), positionsTable.findById(r.lastID));
        pos_created++;
      }
    });
  }

  // 重新载入岗位索引
  positionsTable._invalidate();
  const newPositionByName = new Map();
  const newPositionByCode = new Map();
  positionsTable.all().forEach(p => {
    if (p.name) newPositionByName.set(String(p.name), p);
    if (p.code) newPositionByCode.set(String(p.code), p);
  });

  // ---------- 3. 导入员工 → org_personnel ----------
  if (import_personnel) {
    const personnel = extPersonnelTable.all();
    // 部门名 → 部门 的索引（用于 org_code 缺失时按 org_name 匹配）
    const deptByName = new Map();
    departmentsTable.all().forEach(d => { if (d.name) deptByName.set(String(d.name), d); });

    for (const p of personnel) {
      const empCode = p.emp_code ? String(p.emp_code) : '';
      if (!empCode) { per_skipped++; continue; }
      const orgCode = p.org_code ? String(p.org_code) : '';
      const orgName = p.org_name ? String(p.org_name) : '';
      // 1) 按 org_code 匹配  2) 按 org_name 匹配  3) 都不匹配则 null
      let dept = orgCode ? newDeptByOrgCode.get(orgCode) : null;
      if (!dept && orgName) dept = deptByName.get(orgName);
      const posName = (p.position || '').trim();
      const pos = posName ? newPositionByName.get(posName) : null;

      const existing = personnelByEmpCode.get(empCode);
      // 已有人员且标记为"免同步"：保留手工编辑，不覆盖
      if (existing && existing.sync_exempt) {
        per_exempt_skipped++;
        per_skipped++;
        personnelByEmpCode.set(empCode, { ...existing, _sync_exempt_skip: true });
        continue;
      }
      const fields = {
        emp_code: empCode,
        name: p.name || '',
        department_id: dept ? dept.id : null,
        department_name: dept ? dept.name : (p.org_name || ''),
        position_id: pos ? pos.id : null,
        position_name: pos ? pos.name : posName,
        phone: p.phone || '',
        email: p.email || '',
        gender: p.gender || '',
        sort: existing ? (existing.sort || 0) : 0,
        description: existing ? (existing.description || '') : '',
        status: (p.status === 'inactive' || p.status === '0' || p.status === 0) ? 'inactive' : 'active',
        sync_exempt: existing ? !!existing.sync_exempt : false,
        updated_at: now()
      };
      if (existing) {
        await personnelTable.update(existing.id, fields);
        personnelByEmpCode.set(empCode, { ...existing, ...fields });
        per_updated++;
      } else {
        fields.created_at = now();
        const r = await personnelTable.insert(fields);
        personnelByEmpCode.set(empCode, personnelTable.findById(r.lastID));
        per_created++;
      }
    }
  }

  // ---------- 4. 建立 组织↔员工 关系 ----------
  if (build_relations) {
    personnelTable._invalidate();
    departmentsTable._invalidate();
    const personnelAll = personnelTable.all();
    const departmentsAll = departmentsTable.all();
    const orgCodeToDept = new Map();
    departmentsAll.forEach(d => {
      if (d.code) orgCodeToDept.set(String(d.code), d);
      if (d.org_code) orgCodeToDept.set(String(d.org_code), d);
    });
    const existingRels = new Set(
      relationsTable.all().map(r => `${r.personnel_id || r.emp_code}::${r.department_id || r.org_code}::${r.relation_type || 'primary'}`)
    );

    personnelAll.forEach(p => {
      const empKey = String(p.emp_code || p.id);
      // 主归属：personnel.department_id
      if (p.department_id) {
        const k = `${empKey}::${p.department_id}::primary`;
        if (!existingRels.has(k)) {
          relationsTable.insert({
            personnel_id: p.id, emp_code: p.emp_code,
            department_id: p.department_id, org_code: '',
            relation_type: 'primary',
            remark: '同步自 personnel.department_id',
            created_at: now()
          });
          existingRels.add(k);
          rel_created++;
        }
      } else if (p.department_name) {
        // 没有 department_id 但有 department_name：通过 org_name 找到部门
        const matched = departmentsAll.find(d => d.name === p.department_name);
        if (matched) {
          const k = `${empKey}::${matched.id}::primary`;
          if (!existingRels.has(k)) {
            relationsTable.insert({
              personnel_id: p.id, emp_code: p.emp_code,
              department_id: matched.id, org_code: '',
              relation_type: 'primary',
              remark: '按部门名匹配',
              created_at: now()
            });
            existingRels.add(k);
            rel_created++;
          }
        } else {
          rel_skipped++;
        }
      } else {
        rel_skipped++;
      }
    });
  }

  // ---------- 5. 可选：把岗位名尝试匹配系统角色（仅建立"岗位→角色"关联） ----------
  let pos_role_linked = 0;
  if (sync_position_default_role) {
    const prTable = getTable('org_position_roles');
    positionsTable._invalidate();
    prTable._invalidate();
    positionsTable.all().forEach(p => {
      const name = String(p.name || '');
      const code = String(p.code || '');
      // 角色 code 候选：position.code / position.name / 去除"员"后缀
      const candidates = [code, name, name.replace(/员$/, ''), name.replace(/工程师$/, ''), name.replace(/经理$/, '_manager')];
      let matched = null;
      for (const c of candidates) {
        if (!c) continue;
        if (roleByCode.has(c)) { matched = roleByCode.get(c); break; }
      }
      if (!matched) return;
      const exists = prTable.all().some(r => r.position_id === p.id && r.role_id === matched.id);
      if (exists) return;
      prTable.insert({ position_id: p.id, role_id: matched.id, assigned_at: now() });
      pos_role_linked++;
    });
    prTable._invalidate();
  }

  // 收尾失效缓存
  orgsTable._invalidate();
  extPersonnelTable._invalidate();
  departmentsTable._invalidate();
  positionsTable._invalidate();
  personnelTable._invalidate();
  relationsTable._invalidate();

  res.json({
    message: '同步完成',
    organizations: { created: org_created, updated: org_updated, skipped: org_skipped },
    positions: { created: pos_created, updated: pos_updated, skipped: pos_skipped, role_linked: pos_role_linked },
    personnel: {
      created: per_created,
      updated: per_updated,
      skipped: per_skipped,
      sync_exempt_skipped: per_exempt_skipped
    },
    relations: { created: rel_created, skipped: rel_skipped }
  });
});

// 一次性取四类数据
router.get('/sync/all', requirePerm('org:view'), (req, res) => {
  const departmentsTable = getTable('org_departments');
  const positionsTable = getTable('org_positions');
  const personnelTable = getTable('org_personnel');
  const relationsTable = getTable('org_employee_orgs');
  const ppTable = getTable('org_personnel_perms');
  const posPermsTable = getTable('org_position_perms');
  const posRolesTable = getTable('org_position_roles');

  departmentsTable._invalidate();
  positionsTable._invalidate();
  personnelTable._invalidate();
  relationsTable._invalidate();
  ppTable._invalidate();
  posPermsTable._invalidate();
  posRolesTable._invalidate();

  const departments = departmentsTable.all();
  const positions = positionsTable.all();
  const personnel = personnelTable.all();
  const relations = relationsTable.all();

  const enrichPosition = (p) => ({
    ...p,
    department_name: (departments.find(d => d.id === p.department_id) || {}).name || '',
    permission_count: posPermsTable.all().filter(pp => pp.position_id === p.id).length,
    role_count: posRolesTable.all().filter(pr => pr.position_id === p.id).length,
    personnel_count: personnel.filter(x => x.position_id === p.id).length
  });

  const enrichPersonnel = (p) => ({
    ...p,
    department_name: (departments.find(d => d.id === p.department_id) || {}).name || '',
    position_name: (positions.find(x => x.id === p.position_id) || {}).name || p.position_name || '',
    override_count: ppTable.all().filter(pp => pp.personnel_id === p.id).length
  });

  const enrichRelation = (r) => ({
    ...r,
    personnel_name: (personnel.find(p => p.id === r.personnel_id) || {}).name || '',
    emp_code: (personnel.find(p => p.id === r.personnel_id) || {}).emp_code || r.emp_code || '',
    department_name: (departments.find(d => d.id === r.department_id) || {}).name || '',
    org_code: (departments.find(d => d.id === r.department_id) || {}).code || r.org_code || ''
  });

  res.json({
    summary: {
      total_organizations: departments.length,
      active_organizations: departments.filter(d => d.status === 'active').length,
      total_positions: positions.length,
      active_positions: positions.filter(p => p.status === 'active').length,
      total_employees: personnel.length,
      active_employees: personnel.filter(p => p.status === 'active').length,
      total_relations: relations.length
    },
    organizations: departments,
    positions: positions.map(enrichPosition),
    employees: personnel.map(enrichPersonnel),
    org_employee_relations: relations.map(enrichRelation),
    generated_at: now()
  });
});

// 按组织取员工（多对多视图：含主归属 + 辅助关系）
router.get('/sync/org-employees', requirePerm('org:view'), (req, res) => {
  const { department_id, org_code, relation_type, include_inactive } = req.query;
  const departmentsTable = getTable('org_departments');
  const personnelTable = getTable('org_personnel');
  const relationsTable = getTable('org_employee_orgs');
  const positionsTable = getTable('org_positions');
  departmentsTable._invalidate();
  personnelTable._invalidate();
  relationsTable._invalidate();
  positionsTable._invalidate();

  const depts = departmentsTable.all();
  let targetDept = null;
  if (department_id) targetDept = depts.find(d => d.id === Number(department_id));
  if (!targetDept && org_code) targetDept = depts.find(d => String(d.code) === String(org_code) || String(d.org_code) === String(org_code));
  if (!targetDept) return res.status(400).json({ error: '请提供 department_id 或 org_code' });

  // 包含子部门
  const all = depts;
  const collectDescendants = (id) => {
    const out = [id];
    let added = true;
    while (added) {
      added = false;
      all.forEach(d => { if (d.parent_id && out.includes(d.parent_id) && !out.includes(d.id)) { out.push(d.id); added = true; } });
    }
    return out;
  };
  const deptIds = new Set(collectDescendants(targetDept.id));

  const allPersonnel = personnelTable.all();
  const allRelations = relationsTable.all();
  const allPositions = positionsTable.all();

  // 主归属人员
  const primary = allPersonnel
    .filter(p => p.department_id && deptIds.has(p.department_id))
    .filter(p => include_inactive === '1' || p.status === 'active')
    .map(p => ({
      ...p,
      relation_type: 'primary',
      department_name: (depts.find(d => d.id === p.department_id) || {}).name || '',
      position_name: (allPositions.find(x => x.id === p.position_id) || {}).name || p.position_name || ''
    }));

  // 通过关系表查（辅关系）
  const secondary = [];
  if (relation_type === undefined || relation_type === '' || relation_type === 'all' || relation_type === 'secondary') {
    allRelations
      .filter(r => r.department_id && deptIds.has(r.department_id) && r.relation_type !== 'primary')
      .filter(r => {
        if (relation_type && relation_type !== 'all' && r.relation_type !== relation_type) return false;
        return true;
      })
      .forEach(r => {
        const p = allPersonnel.find(x => x.id === r.personnel_id);
        if (!p) return;
        if (include_inactive !== '1' && p.status !== 'active') return;
        secondary.push({
          ...p,
          relation_type: r.relation_type || 'secondary',
          relation_remark: r.remark || '',
          department_name: (depts.find(d => d.id === r.department_id) || {}).name || '',
          position_name: (allPositions.find(x => x.id === p.position_id) || {}).name || p.position_name || ''
        });
      });
  }

  // 合并去重
  const map = new Map();
  primary.forEach(p => map.set(`${p.id}::primary`, p));
  secondary.forEach(p => map.set(`${p.id}::${p.relation_type}`, p));

  res.json({
    department: targetDept,
    department_ids: [...deptIds],
    total: map.size,
    primary_count: primary.length,
    secondary_count: secondary.length,
    employees: [...map.values()].sort((a, b) => (a.sort || 0) - (b.sort || 0))
  });
});

// 维护组织-员工关系（增/删/改）
router.post('/sync/relations', requirePerm('org:personnel:manage'), (req, res) => {
  const { personnel_id, department_id, org_code, relation_type, remark } = req.body;
  if (!personnel_id || (!department_id && !org_code)) {
    return res.status(400).json({ error: 'personnel_id 与 (department_id 或 org_code) 为必填' });
  }
  const relationsTable = getTable('org_employee_orgs');
  const departmentsTable = getTable('org_departments');
  const personnelTable = getTable('org_personnel');
  relationsTable._invalidate();
  departmentsTable._invalidate();
  personnelTable._invalidate();

  let dept = null;
  if (department_id) dept = departmentsTable.findById(department_id);
  if (!dept && org_code) dept = departmentsTable.all().find(d => String(d.code) === String(org_code) || String(d.org_code) === String(org_code));
  if (!dept) return res.status(404).json({ error: '部门不存在' });

  const person = personnelTable.findById(personnel_id);
  if (!person) return res.status(404).json({ error: '人员不存在' });

  const finalType = relation_type || 'secondary';
  const existing = relationsTable.all().find(r => r.personnel_id === Number(personnel_id) && r.department_id === dept.id && r.relation_type === finalType);
  if (existing) {
    relationsTable.update(existing.id, { remark: remark || '', updated_at: now() });
    return res.json({ message: '关系已更新', data: relationsTable.findById(existing.id) });
  }
  const r = relationsTable.insert({
    personnel_id: Number(personnel_id),
    emp_code: person.emp_code || '',
    department_id: dept.id,
    org_code: dept.code || '',
    relation_type: finalType,
    remark: remark || '',
    created_at: now()
  });
  relationsTable._invalidate();
  res.json({ message: '关系已创建', data: relationsTable.findById(r.lastID) });
});

router.delete('/sync/relations/:id', requirePerm('org:personnel:manage'), (req, res) => {
  const relationsTable = getTable('org_employee_orgs');
  const existing = relationsTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '关系不存在' });
  relationsTable.delete(req.params.id);
  relationsTable._invalidate();
  res.json({ message: '关系已删除' });
});

module.exports = router;
