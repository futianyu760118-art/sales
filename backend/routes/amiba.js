/**
 * 阿米巴经营管理模块（降本攻坚）
 * --------------------------------------------------
 * 业务来源：《降本攻坚阿米巴委员会推行组织方案》1:1 数字化落地
 * 模块：组织巴架构 / 目标与责任状 / 经营会计核算 / 内部定价 / 争议仲裁
 *       降本改善与先锋试点 / 培训激励绩效 / 月度月报 / 可视化看板
 *
 * 相关经营数据（收入、成本）直接从系统 orders / inquiries / materials / projects
 * 按 department_id / sales_id 自动归集，实现“系统中获取”。
 *
 * 数据权限：巴长（charge_user_id）仅可见自己所属巴；管理员/无绑定账号可见全部。
 */
const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');

// 内部交易明细导入：内存存储，支持 xlsx/xls/csv
const tradeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv', '.tsv'].includes(ext)) cb(null, true);
    else cb(new Error('仅支持 xlsx/xls/csv 文件'));
  }
});

const PERM_VIEW = 'amiba:view';
const PERM_CREATE = 'amiba:create';
const PERM_EDIT = 'amiba:edit';
const PERM_DELETE = 'amiba:delete';
const PERM_AUDIT = 'amiba:audit';
const PERM_CALC = 'amiba:calc';
const PERM_EXPORT = 'amiba:export';

// ---------- 通用工具 ----------
function n(v, def) { const x = Number(v); return Number.isFinite(x) ? x : (def || 0); }
function s(v, def) { if (v === undefined || v === null) return def || ''; return String(v).trim(); }
function num(v, def) { return n(v, def); }
function str(v, def) { return s(v, def); }
function round(v, d) { const p = Math.pow(10, d || 2); return Math.round((n(v)) * p) / p; }
function pct(actual, target) { if (!target) return 0; return round((n(actual) / n(target)) * 100, 1); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function currentYear() { return new Date().getFullYear(); }
function currentMonth() { return new Date().getMonth() + 1; }
function firstValue(body, existing, keys, def) {
  for (const k of keys) if (body && Object.prototype.hasOwnProperty.call(body, k)) return body[k];
  for (const k of keys) if (existing && Object.prototype.hasOwnProperty.call(existing, k)) return existing[k];
  return def;
}
function readAll(name) { const t = getTable(name); t._invalidate(); return t.all(); }
function paginate(records, req, defLimit) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || (defLimit || 20)));
  const start = (page - 1) * limit;
  return { data: records.slice(start, start + limit), total: records.length, page, limit };
}
function inYM(dateStr, year, month) {
  if (!dateStr) return false;
  const m = String(dateStr).match(/^(\d{4})[-/](\d{1,2})/);
  if (!m) return false;
  if (Number(m[1]) !== Number(year)) return false;
  if (month && Number(m[2]) !== Number(month)) return false;
  return true;
}

// ---------- 枚举 / 字典 ----------
const AMIBA_TYPES = ['生产', '研发', '营销', '采购', '品质', '综合'];
const IMPROVE_TYPES = ['能耗', '损耗', '费用', '工艺', '人工', '材料'];
const DISPUTE_TYPES = ['定价', '成本', '责任', '结算'];
const PRICE_STATUS = ['待审核', '已生效', '已驳回', '已失效'];
const AUDIT_STATUS = ['待审核', '审核中', '已通过', '已驳回'];
const PROJECT_STATUS = ['立项', '执行中', '已完成', '已归档', '已终止'];
const REPORT_STATUS = ['草稿', '已发布', '已归档'];

// ---------- 数据权限：巴单元隔离 ----------
function scopeAmibaIds(req) {
  const userId = req.body.user_id || req.body.userId || req.query.user_id || req.query.userId
    || req.headers['x-user'] || req.headers['x-user-id'];
  if (!userId) return null; // 未识别用户 → 不做隔离（兼容旧逻辑）
  try {
    const { isAdmin } = require('../auth-middleware').getUserPermissions(userId);
    if (isAdmin) return null; // 管理员看全部
  } catch (e) { return null; }
  const orgs = readAll('amiba_org');
  const mine = orgs.filter(o => Number(o.charge_user_id) === Number(userId)).map(o => o.id);
  return mine.length ? mine : null; // 未绑定巴 → 看全部（避免锁死管理层）
}

// ---------- 组织树 ----------
function buildTree(list) {
  const map = {};
  list.forEach(o => { map[o.id] = Object.assign({}, o, { children: [] }); });
  const roots = [];
  Object.values(map).forEach(node => {
    if (node.parent_id && map[node.parent_id]) map[node.parent_id].children.push(node);
    else roots.push(node);
  });
  const sortRec = arr => { arr.sort((a, b) => (a.sort || 0) - (b.sort || 0)); arr.forEach(n => sortRec(n.children)); };
  sortRec(roots);
  return roots;
}

function orgName(id) {
  const o = getTable('amiba_org').findById(id);
  return o ? o.amiba_name : '';
}

// 按名称/ID解析巴单元（导入交易明细时用）
function resolveAmiba(val) {
  if (!val) return { id: 0, name: '' };
  const id = Number(val);
  if (id && getTable('amiba_org').findById(id)) {
    const o = getTable('amiba_org').findById(id);
    return { id: o.id, name: o.amiba_name };
  }
  const byName = readAll('amiba_org').find(o => o.amiba_name === String(val).trim());
  if (byName) return { id: byName.id, name: byName.amiba_name };
  return { id: 0, name: String(val).trim() };
}

// 自动创建缺失的巴单元（导入工作簿时按定价清单/交易明细中的巴名补建）
async function ensureAmibaByName(name, defType) {
  const nm = s(name);
  if (!nm) return { id: 0, name: '' };
  const exist = readAll('amiba_org').find(o => o.amiba_name === nm);
  if (exist) return { id: exist.id, name: exist.amiba_name };
  const table = getTable('amiba_org');
  const maxSort = readAll('amiba_org').reduce((m, o) => Math.max(m, n(o.sort, 0)), 0);
  const result = await table.insert({
    parent_id: 0, amiba_level: 1, amiba_name: nm,
    amiba_type: defType || '综合', charge_user_name: '', department_id: 0, department: '',
    status: '启用', sort: maxSort + 1, created_at: now(), updated_at: now()
  });
  table._invalidate();
  return { id: result.lastID, name: nm };
}

// Excel 日期序列号 → 'YYYY-MM-DD'（兼容纯数字日期、字符串日期、Serial）
function excelDate(v) {
  if (v === undefined || v === null || v === '') return '';
  const str = String(v).trim();
  // 已是日期字符串：YYYY-MM-DD / YYYY/MM/DD
  const m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  // 纯数字：Excel 序列号（自1899-12-30起算）
  const serial = Number(str);
  if (Number.isFinite(serial) && serial > 30000 && serial < 80000) {
    const d = new Date(Math.round((serial - 25569) * 86400 * 1000)); // 25569 = 1970-01-01 的 Excel 序列
    if (!isNaN(d.getTime())) return d.toISOString().substring(0, 10);
  }
  return str;
}

// 解析系统原有架构人员（org_personnel）
function resolvePersonnel(val) {
  if (!val) return null;
  let table;
  try { table = getTable('org_personnel'); table._invalidate(); } catch (e) { return null; }
  const all = table.all();
  return all.find(p => p.id === Number(val)) || all.find(p => p.name === String(val).trim()) || null;
}
// 解析系统原有部门（org_departments）
function resolveDepartment(val) {
  if (!val) return null;
  let table;
  try { table = getTable('org_departments'); table._invalidate(); } catch (e) { return null; }
  const all = table.all();
  return all.find(d => d.id === Number(val)) || all.find(d => d.name === String(val).trim()) || null;
}

// ============================================================
// 元数据
// ============================================================
router.get('/meta', requirePerm(PERM_VIEW), (req, res) => {
  const orgs = readAll('amiba_org').filter(o => o.status !== '停用');
  res.json({
    amiba_types: AMIBA_TYPES,
    improve_types: IMPROVE_TYPES,
    dispute_types: DISPUTE_TYPES,
    price_status: PRICE_STATUS,
    audit_status: AUDIT_STATUS,
    project_status: PROJECT_STATUS,
    report_status: REPORT_STATUS,
    standard_directions: STANDARD_DIRECTIONS,
    standard_status: STANDARD_STATUS,
    amibas: orgs.map(o => ({ id: o.id, name: o.amiba_name, level: o.amiba_level, type: o.amiba_type }))
  });
});

// ============================================================
// 物料库检索：供「内部定价 / 部门收支标准」取物料代码/名称/单位/单价（定价基数）
// 内部交易价 = 物料库单价（基数）× 系数
// ============================================================
router.get('/materials/search', requirePerm(PERM_VIEW), (req, res) => {
  const kw = s(req.query.keyword).toLowerCase().trim();
  const limit = Math.min(200, Math.max(1, n(req.query.limit, 30)));
  let list = [];
  try {
    const t = getTable('materials'); t._invalidate();
    list = t.all().filter(m => m.status !== 'inactive');
  } catch (e) { return res.json({ data: [], total: 0 }); }
  if (kw) {
    list = list.filter(m => [m.material_code, m.material_name, m.classification, m.material_type, m.category, m.specs]
      .filter(Boolean).join(' ').toLowerCase().includes(kw));
  }
  const data = list.slice(0, limit).map(m => ({
    material_id: m.id,
    material_code: s(m.material_code),
    material_name: s(m.material_name),
    unit: s(m.unit) || '个',
    unit_price: n(m.unit_price, 0),
    classification: s(m.classification),
    material_type: s(m.material_type)
  }));
  res.json({ data, total: list.length });
});

// 取单个物料（定价基数）
router.get('/materials/:id', requirePerm(PERM_VIEW), (req, res) => {
  let m = null;
  try { const t = getTable('materials'); t._invalidate(); m = t.findById(req.params.id); } catch (e) {}
  if (!m) return res.status(404).json({ error: '物料不存在' });
  res.json({
    material_id: m.id, material_code: s(m.material_code), material_name: s(m.material_name),
    unit: s(m.unit) || '个', unit_price: n(m.unit_price, 0),
    classification: s(m.classification), material_type: s(m.material_type)
  });
});

// ============================================================
// 模块1：阿米巴组织架构
// ============================================================
router.get('/org/tree', requirePerm(PERM_VIEW), (req, res) => {
  let list = readAll('amiba_org');
  res.json(buildTree(list));
});

router.get('/org/list', requirePerm(PERM_VIEW), (req, res) => {
  let list = readAll('amiba_org');
  const kw = s(req.query.keyword).toLowerCase();
  if (kw) list = list.filter(o => [o.amiba_name, o.amiba_type, o.charge_user_name].join(' ').toLowerCase().includes(kw));
  res.json(paginate(list.sort((a, b) => (a.sort || 0) - (b.sort || 0)), req, 200));
});

// 系统原有架构：部门 + 人员（供阿米巴组织架构选用，不再手填）
router.get('/org-options', requirePerm(PERM_VIEW), (req, res) => {
  let departments = [], personnel = [];
  try {
    const dt = getTable('org_departments'); dt._invalidate();
    departments = dt.all().filter(d => d.status !== '停用' && d.status !== 'inactive')
      .map(d => ({ id: d.id, name: d.name, parent_id: d.parent_id || 0, manager_name: d.manager_name || '' }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  } catch (e) {}
  try {
    const pt = getTable('org_personnel'); pt._invalidate();
    personnel = pt.all().filter(p => p.status !== '停用' && p.status !== 'inactive')
      .map(p => ({
        id: p.id, name: p.name,
        department_id: p.department_id || 0, department_name: p.department_name || '',
        position_name: p.position_name || '', linked_user_id: p.linked_user_id || 0, work_role: p.work_role || 'operator'
      }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
  } catch (e) {}
  res.json({ departments, personnel });
});

function orgPayload(body, existing) {
  // 巴长：优先按系统人员ID解析（采用系统原有架构人员）
  let chargeUserId = n(firstValue(body, existing, ['charge_user_id', 'chargeUserId'], 0));
  let chargeUserName = s(firstValue(body, existing, ['charge_user_name', 'chargeUserName'], ''));
  let chargePersonnelId = n(firstValue(body, existing, ['charge_personnel_id', 'chargePersonnelId'], 0));
  if (Object.prototype.hasOwnProperty.call(body || {}, 'charge_personnel_id') && body.charge_personnel_id) {
    const person = resolvePersonnel(body.charge_personnel_id);
    if (person) {
      chargePersonnelId = person.id;
      chargeUserName = person.name;
      chargeUserId = person.linked_user_id || 0;
    } else if (String(body.charge_personnel_id).trim() === '') {
      chargePersonnelId = 0; chargeUserName = ''; chargeUserId = 0;
    }
  } else if (Object.prototype.hasOwnProperty.call(body || {}, 'charge_user_name')) {
    // 兼容直接传姓名：尝试匹配系统人员
    const person = resolvePersonnel(body.charge_user_name);
    if (person) { chargePersonnelId = person.id; chargeUserId = person.linked_user_id || 0; }
  }
  // 部门：优先按系统部门ID解析
  let departmentId = n(firstValue(body, existing, ['department_id', 'departmentId'], 0));
  let department = s(firstValue(body, existing, ['department', 'departmentName'], ''));
  if (Object.prototype.hasOwnProperty.call(body || {}, 'department_id') && body.department_id) {
    const dept = resolveDepartment(body.department_id);
    if (dept) { departmentId = dept.id; department = dept.name; }
  }
  return {
    parent_id: n(firstValue(body, existing, ['parent_id', 'parentId'], 0)),
    amiba_level: n(firstValue(body, existing, ['amiba_level', 'level'], 1)),
    amiba_name: s(firstValue(body, existing, ['amiba_name', 'name'], '')),
    amiba_type: s(firstValue(body, existing, ['amiba_type', 'type'], '生产')),
    charge_personnel_id: chargePersonnelId,
    charge_user_id: chargeUserId,
    charge_user_name: chargeUserName,
    department_id: departmentId,
    department: department,
    sales_person: s(firstValue(body, existing, ['sales_person', 'salesPerson'], '')),
    product_category: s(firstValue(body, existing, ['product_category', 'productCategory'], '')),
    status: s(firstValue(body, existing, ['status'], '启用')),
    sort: n(firstValue(body, existing, ['sort'], 0))
  };
}

router.post('/org', requirePerm(PERM_CREATE), async (req, res) => {
  try {
    const data = orgPayload(req.body || {}, null);
    if (!data.amiba_name) return res.status(400).json({ error: '巴名称必填' });
    const table = getTable('amiba_org');
    const result = await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
    res.json({ message: '创建成功', data: table.findById(result.lastID) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/org/:id', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_org');
    const existing = table.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: '巴单元不存在' });
    const data = orgPayload(req.body || {}, existing);
    await table.update(req.params.id, Object.assign(data, { updated_at: now() }));
    res.json({ message: '更新成功', data: table.findById(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/org/:id', requirePerm(PERM_DELETE), async (req, res) => {
  try {
    const table = getTable('amiba_org');
    if (!table.findById(req.params.id)) return res.status(404).json({ error: '巴单元不存在' });
    // 防止删除有子巴的节点
    const hasChild = readAll('amiba_org').some(o => Number(o.parent_id) === Number(req.params.id));
    if (hasChild) return res.status(400).json({ error: '该巴下还有子巴，请先删除子巴' });
    await table.delete(req.params.id);
    res.json({ message: '删除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/org/:id/bindUser', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_org');
    const existing = table.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: '巴单元不存在' });
    const fields = { updated_at: now() };
    if (req.body.charge_personnel_id) {
      const person = resolvePersonnel(req.body.charge_personnel_id);
      if (person) {
        fields.charge_personnel_id = person.id;
        fields.charge_user_name = person.name;
        fields.charge_user_id = person.linked_user_id || 0;
      }
    } else if (req.body.charge_user_name !== undefined) {
      fields.charge_user_name = s(req.body.charge_user_name);
      fields.charge_user_id = n(req.body.charge_user_id);
      const person = resolvePersonnel(req.body.charge_user_name);
      if (person) { fields.charge_personnel_id = person.id; fields.charge_user_id = person.linked_user_id || 0; }
    }
    await table.update(req.params.id, fields);
    res.json({ message: '巴长绑定成功', data: table.findById(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 同步系统组织架构：从 org_departments 拉取部门，智能匹配/补建阿米巴巴单元
// 匹配规则：1) department_id 已关联  2) 名称去后缀(巴/部/中心/车间/组)后相同  3) 名称包含关系
// 未匹配的活跃部门自动创建巴单元，并绑定部门ID + 部门负责人
router.post('/org/sync', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const orgTable = getTable('amiba_org');
    let departments = [];
    try {
      const dt = getTable('org_departments'); dt._invalidate();
      departments = dt.all().filter(d => d.status !== 'inactive' && d.status !== '停用');
    } catch (e) { return res.status(400).json({ error: '系统组织模块数据不可用：' + e.message }); }

    // 推断巴类型
    const inferType = (name) => {
      const n = s(name);
      if (/销售|营销|商务/.test(n)) return '营销';
      if (/研发|开发|技术/.test(n)) return '研发';
      if (/采购|供应链|供应商/.test(n)) return '采购';
      if (/品质|质检|品管|质量/.test(n)) return '品质';
      if (/生产|车间|组装|装配|包装|精益|光电|前道|压铸|喷塑|五金|仓库|仓储/.test(n)) return '生产';
      return '综合';
    };
    // 名称归一化：去掉常见后缀
    const normName = (name) => s(name).replace(/巴$|部$|中心$|车间$|组$|科$|室$|课$/g, '').trim();

    const amibas = readAll('amiba_org');
    let created = 0, updated = 0, skipped = 0;
    const details = [];

    for (const dept of departments) {
      const deptName = s(dept.name);
      const deptId = n(dept.id);
      const normDept = normName(deptName);
      // 1) 已通过 department_id 关联
      let matched = amibas.find(o => Number(o.department_id) === deptId);
      // 2) 名称归一化匹配
      if (!matched) matched = amibas.find(o => normName(o.amiba_name) === normDept && normDept);
      // 3) 名称包含关系（双向）
      if (!matched) {
        matched = amibas.find(o => {
          const normAmiba = normName(o.amiba_name);
          return normAmiba && normDept && (normAmiba.includes(normDept) || normDept.includes(normAmiba)) && Math.min(normAmiba.length, normDept.length) >= 2;
        });
      }

      // 查找部门负责人
      let managerPersonnelId = 0, managerName = s(dept.manager_name);
      if (managerName) {
        const person = resolvePersonnel(managerName);
        if (person) { managerPersonnelId = person.id; managerName = person.name; }
      }

      if (matched) {
        // 更新关联：补充 department_id / department / 巴长
        const updates = {};
        if (!matched.department_id || Number(matched.department_id) !== deptId) updates.department_id = deptId;
        if (s(matched.department) !== deptName) updates.department = deptName;
        if (managerName && !matched.charge_user_name) {
          updates.charge_user_name = managerName;
          if (managerPersonnelId) updates.charge_personnel_id = managerPersonnelId;
        }
        // 层级：有 parent 的是二级巴
        const hasParent = departments.some(d2 => Number(d2.id) === Number(dept.parent_id));
        const expectedLevel = hasParent ? 2 : 1;
        if (Number(matched.amiba_level) !== expectedLevel) updates.amiba_level = expectedLevel;
        if (Object.keys(updates).length) {
          updates.updated_at = now();
          await orgTable.update(matched.id, updates);
          updated++;
          details.push({ action: '更新', amiba: matched.amiba_name, dept: deptName, changes: Object.keys(updates).filter(k => k !== 'updated_at') });
        } else { skipped++; }
      } else {
        // 新建巴单元
        const hasParent = departments.some(d2 => Number(d2.id) === Number(dept.parent_id));
        const amibaName = deptName.endsWith('巴') ? deptName : deptName;
        const payload = {
          parent_id: 0, amiba_level: hasParent ? 2 : 1,
          amiba_name: amibaName, amiba_type: inferType(deptName),
          charge_personnel_id: managerPersonnelId, charge_user_name: managerName, charge_user_id: 0,
          department_id: deptId, department: deptName,
          sales_person: '', product_category: '', status: '启用',
          sort: n(dept.sort, 0), created_at: now(), updated_at: now()
        };
        const r = await orgTable.insert(payload);
        amibas.push(Object.assign({ id: r.lastID }, payload));
        created++;
        details.push({ action: '新建', amiba: amibaName, dept: deptName, type: payload.amiba_type, level: payload.amiba_level });
      }
    }
    orgTable._invalidate();
    res.json({
      message: `同步完成：新建 ${created} 个、更新 ${updated} 个、无变化 ${skipped} 个（共 ${departments.length} 个系统部门）`,
      created, updated, skipped, total_departments: departments.length, details: details.slice(0, 50)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 模块2：降本目标 & 责任状
// ============================================================
// 公司总目标（按年度单条 upsert）
router.get('/target/company', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const row = readAll('amiba_cost_target_company').find(r => Number(r.year) === year);
  res.json(row || { year, total_cost_target: 0, material_reduce_target: 0, energy_reduce_target: 0, fee_reduce_target: 0, loss_reduce_target: 0, status: '草稿' });
});

router.post('/target/company', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_cost_target_company');
    const year = n(req.body.year, currentYear());
    const payload = {
      year,
      total_cost_target: n(req.body.total_cost_target),
      material_reduce_target: n(req.body.material_reduce_target),
      energy_reduce_target: n(req.body.energy_reduce_target),
      fee_reduce_target: n(req.body.fee_reduce_target),
      loss_reduce_target: n(req.body.loss_reduce_target),
      status: s(req.body.status, '草稿'),
      updated_at: now()
    };
    const existing = readAll('amiba_cost_target_company').find(r => Number(r.year) === year);
    if (existing) {
      await table.update(existing.id, payload);
      res.json({ message: '保存成功', data: table.findById(existing.id) });
    } else {
      const result = await table.insert(Object.assign(payload, { created_at: now() }));
      res.json({ message: '保存成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 一键拆解：公司目标 → 各一级巴目标（按权重）
router.post('/target/amiba/decompose', requirePerm(PERM_CALC), async (req, res) => {
  try {
    const year = n(req.body.year, currentYear());
    const month = n(req.body.month, 0); // 0=全年
    const company = readAll('amiba_cost_target_company').find(r => Number(r.year) === year);
    if (!company) return res.status(400).json({ error: '请先维护公司年度降本总目标' });
    const weights = req.body.weights || {}; // { amibaId: weight }
    const firstLevel = readAll('amiba_org').filter(o => Number(o.amiba_level) === 1 && o.status !== '停用');
    const totalWeight = firstLevel.reduce((sum, o) => sum + n(weights[o.id], 0), 0) || firstLevel.length;
    const targetTable = getTable('amiba_cost_target');
    let created = 0;
    for (const o of firstLevel) {
      const w = n(weights[o.id], 0) || 1;
      const targetAmount = round(company.total_cost_target * w / totalWeight, 2);
      const existing = readAll('amiba_cost_target').find(t =>
        Number(t.amiba_id) === Number(o.id) && Number(t.year) === year && Number(t.month) === month);
      const payload = {
        amiba_id: o.id, amiba_name: o.amiba_name, year, month,
        target_amount: targetAmount, target_rate: round((w / totalWeight) * 100, 1),
        real_amount: existing ? existing.real_amount : 0,
        completion_rate: existing ? existing.completion_rate : 0,
        status: '待签', duty_user_id: o.charge_user_id, duty_user_name: o.charge_user_name,
        updated_at: now()
      };
      if (existing) { await targetTable.update(existing.id, payload); }
      else { await targetTable.insert(Object.assign(payload, { created_at: now() })); }
      created++;
    }
    res.json({ message: '拆解完成', created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 目标达成列表（real_amount 从系统改善项目节约额自动汇总）
function targetWithReal(t) {
  const save = readAll('amiba_cost_improve')
    .filter(p => Number(p.amiba_id) === Number(t.amiba_id) && Number(p.year) === Number(t.year) &&
      (Number(t.month) === 0 || Number(p.month) === Number(t.month)) && p.status === '已完成')
    .reduce((s2, p) => s2 + n(p.save_amount), 0);
  const real = t.real_amount ? n(t.real_amount) : save;
  return Object.assign({}, t, {
    real_amount: round(real, 2),
    completion_rate: pct(real, t.target_amount),
    warn: t.target_amount && real < t.target_amount * 0.8
  });
}

router.get('/target/list', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const month = req.query.month !== undefined ? n(req.query.month) : null;
  const scope = scopeAmibaIds(req);
  let list = readAll('amiba_cost_target').filter(t => Number(t.year) === year);
  if (month !== null) list = list.filter(t => Number(t.month) === month);
  if (scope) list = list.filter(t => scope.includes(Number(t.amiba_id)));
  list = list.map(targetWithReal).sort((a, b) => b.completion_rate - a.completion_rate);
  res.json(paginate(list, req, 200));
});

router.post('/target', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_cost_target');
    const id = req.body.id;
    const payload = {
      amiba_id: n(req.body.amiba_id),
      amiba_name: s(req.body.amiba_name || orgName(req.body.amiba_id)),
      year: n(req.body.year, currentYear()),
      month: n(req.body.month, 0),
      target_amount: n(req.body.target_amount),
      real_amount: n(req.body.real_amount),
      target_rate: n(req.body.target_rate),
      status: s(req.body.status, '待签'),
      duty_user_id: n(req.body.duty_user_id),
      duty_user_name: s(req.body.duty_user_name),
      sign_status: s(req.body.sign_status, ''),
      sign_time: s(req.body.sign_time, ''),
      updated_at: now()
    };
    if (id) {
      const existing = table.findById(id);
      if (!existing) return res.status(404).json({ error: '目标不存在' });
      await table.update(id, payload);
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      const result = await table.insert(Object.assign(payload, { completion_rate: 0, created_at: now() }));
      res.json({ message: '保存成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 电子签署责任状
router.post('/target/:id/sign', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_cost_target');
    const existing = table.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: '目标不存在' });
    await table.update(req.params.id, { sign_status: '已签署', sign_time: now(), status: '执行中', updated_at: now() });
    await logAudit('target_sign', existing.id, req);
    res.json({ message: '责任状签署成功', data: table.findById(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 模块3：内部交易定价 + 经营会计核算
// ============================================================
function pricePayload(body, existing) {
  // 物料库联动：定价基数 = 物料库单价，内部交易价 = 基数 × 系数
  const materialId = n(firstValue(body, existing, ['material_id', 'materialId'], 0));
  let basePrice = n(firstValue(body, existing, ['base_price', 'basePrice'], 0));
  let materialCode = s(firstValue(body, existing, ['material_code', 'materialCode', 'product_code'], ''));
  let materialName = s(firstValue(body, existing, ['material_name', 'materialName', 'product_name'], ''));
  let unit = s(firstValue(body, existing, ['unit'], '元'));
  // 选择了物料库 → 以物料库单价作为基数，回填代码/名称/单位
  if (materialId) {
    let m = null;
    try { const t = getTable('materials'); t._invalidate(); m = t.findById(materialId); } catch (e) {}
    if (m) {
      materialCode = s(m.material_code) || materialCode;
      materialName = s(m.material_name) || materialName;
      unit = s(m.unit) || unit || '个';
      basePrice = n(m.unit_price, basePrice);
    }
  }
  const coefficient = n(firstValue(body, existing, ['coefficient'], 0));
  let tradePrice = n(firstValue(body, existing, ['trade_price', 'tradePrice'], 0));
  // 有基数+系数 → 自动计算内部单价（基数×系数），未给系数时默认 1
  if (basePrice > 0) {
    const coef = coefficient || (tradePrice && basePrice ? round(tradePrice / basePrice, 4) : 1);
    tradePrice = round(basePrice * coef, 4);
  }
  return {
    material_id: materialId,
    material_code: materialCode,
    material_name: materialName,
    product_name: materialName || s(firstValue(body, existing, ['product_name', 'productName'], '')),
    product_code: materialCode || s(firstValue(body, existing, ['product_code', 'productCode'], '')),
    base_price: round(basePrice, 4),
    coefficient: coefficient || (basePrice && tradePrice ? round(tradePrice / basePrice, 4) : 0),
    from_amiba_id: n(firstValue(body, existing, ['from_amiba_id', 'fromAmibaId'], 0)),
    from_amiba_name: s(firstValue(body, existing, ['from_amiba_name'], '')) || orgName(firstValue(body, existing, ['from_amiba_id'], 0)),
    to_amiba_id: n(firstValue(body, existing, ['to_amiba_id', 'toAmibaId'], 0)),
    to_amiba_name: s(firstValue(body, existing, ['to_amiba_name'], '')) || orgName(firstValue(body, existing, ['to_amiba_id'], 0)),
    trade_price: round(tradePrice, 4),
    unit: unit,
    price_status: s(firstValue(body, existing, ['price_status', 'priceStatus'], '待审核')),
    audit_status: s(firstValue(body, existing, ['audit_status', 'auditStatus'], '待审核')),
    effect_time: s(firstValue(body, existing, ['effect_time', 'effectTime'], '')),
    expire_time: s(firstValue(body, existing, ['expire_time', 'expireTime'], ''))
  };
}

router.get('/price', requirePerm(PERM_VIEW), (req, res) => {
  const kw = s(req.query.keyword).toLowerCase();
  const status = s(req.query.status);
  let list = readAll('amiba_trade_price');
  if (status) list = list.filter(p => p.price_status === status);
  if (kw) list = list.filter(p => [p.product_name, p.product_code, p.from_amiba_name, p.to_amiba_name].join(' ').toLowerCase().includes(kw));
  res.json(paginate(list.sort((a, b) => b.id - a.id), req, 200));
});

router.post('/price', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_trade_price');
    const id = req.body.id;
    const data = pricePayload(req.body || {}, id ? table.findById(id) : null);
    if (!data.product_name && !data.product_code) return res.status(400).json({ error: '请填写产品名称或编码' });
    if (id) {
      await table.update(id, Object.assign(data, { updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      const result = await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/price/:id/audit', requirePerm(PERM_AUDIT), async (req, res) => {
  try {
    const table = getTable('amiba_trade_price');
    const existing = table.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: '定价不存在' });
    const result = s(req.body.audit_result, '通过');
    const priceStatus = result === '通过' ? '已生效' : '已驳回';
    await table.update(req.params.id, { audit_status: result === '通过' ? '已通过' : '已驳回', price_status: priceStatus, audit_user: s(req.body.audit_user), audit_time: now(), updated_at: now() });
    await logAudit('price_audit', existing.id, req);
    res.json({ message: '审批完成', data: table.findById(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/price/:id', requirePerm(PERM_DELETE), async (req, res) => {
  try {
    const table = getTable('amiba_trade_price');
    if (!table.findById(req.params.id)) return res.status(404).json({ error: '定价不存在' });
    await table.delete(req.params.id);
    res.json({ message: '删除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 模块3.5：部门收支标准（制定各部门收入和支出标准）
// 业务：内部定价基数采用物料库价格（物料代码/名称/单位/单价）+ 系数，
//       标准价 = 物料库单价（基数）× 系数；按部门（巴）+ 方向（收入/支出）登记。
// ============================================================
const STANDARD_DIRECTIONS = ['收入', '支出']; // 收入标准 / 支出标准
const STANDARD_STATUS = ['启用', '停用'];

function deptStandardPayload(body, existing) {
  const amibaId = n(firstValue(body, existing, ['amiba_id'], 0));
  const materialId = n(firstValue(body, existing, ['material_id', 'materialId'], 0));
  let basePrice = n(firstValue(body, existing, ['base_price', 'basePrice'], 0));
  let materialCode = s(firstValue(body, existing, ['material_code', 'materialCode'], ''));
  let materialName = s(firstValue(body, existing, ['material_name', 'materialName'], ''));
  let unit = s(firstValue(body, existing, ['unit'], '个'));
  // 联动物料库：以物料库单价为基数
  if (materialId) {
    let m = null;
    try { const t = getTable('materials'); t._invalidate(); m = t.findById(materialId); } catch (e) {}
    if (m) {
      materialCode = s(m.material_code) || materialCode;
      materialName = s(m.material_name) || materialName;
      unit = s(m.unit) || unit || '个';
      basePrice = n(m.unit_price, basePrice);
    }
  }
  const coefficient = n(firstValue(body, existing, ['coefficient'], 0));
  let standardPrice = n(firstValue(body, existing, ['standard_price', 'standardPrice'], 0));
  // 标准价 = 基数 × 系数（系数缺省 1）
  if (basePrice > 0) {
    const coef = coefficient || (standardPrice && basePrice ? round(standardPrice / basePrice, 4) : 1);
    standardPrice = round(basePrice * coef, 4);
  }
  const direction = s(firstValue(body, existing, ['direction'], '支出'));
  return {
    amiba_id: amibaId,
    amiba_name: s(firstValue(body, existing, ['amiba_name'], '')) || orgName(amibaId),
    direction: STANDARD_DIRECTIONS.includes(direction) ? direction : '支出',
    material_id: materialId,
    material_code: materialCode,
    material_name: materialName,
    item_name: s(firstValue(body, existing, ['item_name', 'itemName'], '')) || materialName,
    unit: unit,
    base_price: round(basePrice, 4),
    coefficient: coefficient || (basePrice && standardPrice ? round(standardPrice / basePrice, 4) : 0),
    standard_price: round(standardPrice, 4),
    year: n(firstValue(body, existing, ['year'], currentYear())),
    quantity_std: n(firstValue(body, existing, ['quantity_std', 'quantityStd'], 0)),
    amount_std: round(n(firstValue(body, existing, ['amount_std', 'amountStd'], 0)) || (standardPrice * n(firstValue(body, existing, ['quantity_std', 'quantityStd'], 0))), 2),
    remarks: s(firstValue(body, existing, ['remarks'], '')),
    status: s(firstValue(body, existing, ['status'], '启用'))
  };
}

// 列表（含筛选 + 汇总）
router.get('/dept-standard', requirePerm(PERM_VIEW), (req, res) => {
  const scope = scopeAmibaIds(req);
  const amibaId = req.query.amiba_id ? Number(req.query.amiba_id) : null;
  const direction = s(req.query.direction);
  const status = s(req.query.status, '');
  const year = req.query.year ? Number(req.query.year) : null;
  const kw = s(req.query.keyword).toLowerCase();
  let list = readAll('amiba_dept_standard');
  if (scope) list = list.filter(r => scope.includes(Number(r.amiba_id)));
  if (amibaId) list = list.filter(r => Number(r.amiba_id) === amibaId);
  if (direction) list = list.filter(r => r.direction === direction);
  if (status) list = list.filter(r => r.status === status);
  if (year !== null) list = list.filter(r => Number(r.year) === year || Number(r.year) === 0);
  if (kw) list = list.filter(r => [r.material_code, r.material_name, r.item_name, r.amiba_name, r.remarks].join(' ').toLowerCase().includes(kw));
  list = list.sort((a, b) => (b.id - a.id));
  const summary = {
    count: list.length,
    income_count: list.filter(r => r.direction === '收入').length,
    expense_count: list.filter(r => r.direction === '支出').length,
    income_amount: round(list.filter(r => r.direction === '收入' && r.status === '启用').reduce((s2, r) => s2 + n(r.amount_std), 0), 2),
    expense_amount: round(list.filter(r => r.direction === '支出' && r.status === '启用').reduce((s2, r) => s2 + n(r.amount_std), 0), 2)
  };
  res.json(Object.assign({ data: list }, paginate(list, req, 500), { summary }));
});

// 按部门汇总（各部门收入/支出标准合计）
router.get('/dept-standard/by-amiba', requirePerm(PERM_VIEW), (req, res) => {
  const scope = scopeAmibaIds(req);
  const year = req.query.year ? Number(req.query.year) : null;
  let list = readAll('amiba_dept_standard').filter(r => r.status === '启用');
  if (scope) list = list.filter(r => scope.includes(Number(r.amiba_id)));
  if (year !== null) list = list.filter(r => Number(r.year) === year || Number(r.year) === 0);
  const byAmiba = {};
  list.forEach(r => {
    const key = r.amiba_id;
    if (!byAmiba[key]) byAmiba[key] = { amiba_id: r.amiba_id, amiba_name: r.amiba_name, income: 0, expense: 0, income_items: 0, expense_items: 0 };
    if (r.direction === '收入') { byAmiba[key].income += n(r.amount_std); byAmiba[key].income_items++; }
    else { byAmiba[key].expense += n(r.amount_std); byAmiba[key].expense_items++; }
  });
  const rows = Object.values(byAmiba).map(x => Object.assign(x, {
    income: round(x.income, 2), expense: round(x.expense, 2),
    net: round(x.income - x.expense, 2)
  })).sort((a, b) => b.income - a.income);
  res.json({ data: rows });
});

router.post('/dept-standard', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_dept_standard');
    const id = req.body.id;
    const data = deptStandardPayload(req.body || {}, id ? table.findById(id) : null);
    if (!data.amiba_id) return res.status(400).json({ error: '请选择部门（巴单元）' });
    if (!data.material_name && !data.item_name) return res.status(400).json({ error: '请选择物料或填写项目名称' });
    if (id) {
      await table.update(id, Object.assign(data, { updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      const result = await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/dept-standard/:id', requirePerm(PERM_DELETE), async (req, res) => {
  try {
    const table = getTable('amiba_dept_standard');
    if (!table.findById(req.params.id)) return res.status(404).json({ error: '收支标准不存在' });
    await table.delete(req.params.id);
    res.json({ message: '删除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量按物料库生成收支标准（选物料 + 部门 + 方向 + 系数，一次性生成多条）
router.post('/dept-standard/batch', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const amibaId = n(req.body.amiba_id);
    const direction = s(req.body.direction, '支出');
    const coefficient = n(req.body.coefficient, 1);
    const materialIds = Array.isArray(req.body.material_ids) ? req.body.material_ids : [];
    if (!amibaId) return res.status(400).json({ error: '请选择部门（巴单元）' });
    if (!materialIds.length) return res.status(400).json({ error: '请选择物料' });
    const table = getTable('amiba_dept_standard');
    let matTable = null;
    try { matTable = getTable('materials'); matTable._invalidate(); } catch (e) {}
    let created = 0;
    for (const mid of materialIds) {
      const m = matTable ? matTable.findById(mid) : null;
      if (!m) continue;
      const basePrice = n(m.unit_price, 0);
      const data = {
        amiba_id: amibaId,
        amiba_name: orgName(amibaId),
        direction: STANDARD_DIRECTIONS.includes(direction) ? direction : '支出',
        material_id: m.id,
        material_code: s(m.material_code),
        material_name: s(m.material_name),
        item_name: s(m.material_name),
        unit: s(m.unit) || '个',
        base_price: round(basePrice, 4),
        coefficient: coefficient,
        standard_price: round(basePrice * coefficient, 4),
        year: n(req.body.year, currentYear()),
        quantity_std: 0, amount_std: 0,
        remarks: s(req.body.remarks, ''),
        status: '启用',
        created_at: now(), updated_at: now()
      };
      table.insert(data); created++;
    }
    table._invalidate();
    res.json({ message: `批量生成 ${created} 条收支标准`, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 内部交易明细（核算表模板：交易编号/交易日期/提供方巴/接收方巴/服务编号/数量/单价/总金额/结算状态/备注）
// 直接驱动经营核算的内部交易收入与成本归集。
// ============================================================
const TRADE_DETAIL_HEADERS = ['交易编号', '交易日期', '提供方巴', '接收方巴', '服务编号', '服务名称', '单位', '数量', '单价', '总金额', '结算状态', '经办人', '备注'];
const SETTLE_STATUSES = ['未结算', '已结算', '已确认', '已撤销'];

function normalizeHeader(h) {
  return String(h == null ? '' : h).replace(/\r/g, '').replace(/\s+/g, '')
    .replace(/^\uFEFF/, '').replace(/\u200B/g, '').toLowerCase();
}
// 中文表头 → 字段
const TRADE_HEADER_MAP = {
  '交易编号': 'trade_no', '单号': 'trade_no', '编号': 'trade_no',
  '交易日期': 'trade_date', '日期': 'trade_date',
  '提供方巴': 'from_amiba', '提供方': 'from_amiba', '供方': 'from_amiba',
  '接收方巴': 'to_amiba', '接收方': 'to_amiba', '需方': 'to_amiba',
  '服务编号': 'service_no', '服务': 'service_no', '产品编号': 'service_no', '产品': 'service_no', '物料编号': 'service_no',
  '服务名称': 'product_name', '产品名称': 'product_name', '物料名称': 'product_name', '名称': 'product_name',
  '单位': 'unit', '计量单位': 'unit',
  '数量': 'quantity',
  '单价': 'unit_price', '价格': 'unit_price',
  '总金额': 'total_amount', '金额': 'total_amount', '总价': 'total_amount',
  '结算状态': 'settle_status', '状态': 'settle_status',
  '经办人': 'creator_person', '创造人': 'creator_person', '操作员': 'creator_person', '负责人': 'creator_person',
  '备注': 'remarks'
};
// 归一化表头→字段映射（模块级，供交易明细导入/工作簿导入复用）
const TRADE_NORM_MAP = {};
Object.keys(TRADE_HEADER_MAP).forEach(cn => { TRADE_NORM_MAP[normalizeHeader(cn)] = TRADE_HEADER_MAP[cn]; });

function tradeDetailPayload(body, existing) {
  const from = resolveAmiba(firstValue(body, existing, ['from_amiba', 'from_amiba_name'], ''));
  const to = resolveAmiba(firstValue(body, existing, ['to_amiba', 'to_amiba_name'], ''));
  const qty = n(firstValue(body, existing, ['quantity'], 0));
  const price = n(firstValue(body, existing, ['unit_price'], 0));
  const totalIn = firstValue(body, null, ['total_amount'], undefined);
  // 经办人/创造人：关联系统人员架构（用于个人创造价值核算）
  let creatorPersonnelId = n(firstValue(body, existing, ['creator_personnel_id', 'creatorPersonnelId'], 0));
  let creatorPerson = s(firstValue(body, existing, ['creator_person', 'creatorPerson'], ''));
  if (Object.prototype.hasOwnProperty.call(body || {}, 'creator_personnel_id') && body.creator_personnel_id) {
    const person = resolvePersonnel(body.creator_personnel_id);
    if (person) { creatorPersonnelId = person.id; creatorPerson = person.name; }
  } else if (Object.prototype.hasOwnProperty.call(body || {}, 'creator_person')) {
    const person = resolvePersonnel(body.creator_person);
    if (person) { creatorPersonnelId = person.id; creatorPerson = person.name; }
  }
  return {
    trade_no: s(firstValue(body, existing, ['trade_no'], '')),
    trade_date: s(firstValue(body, existing, ['trade_date'], '')),
    from_amiba: from.name, from_amiba_id: from.id,
    to_amiba: to.name, to_amiba_id: to.id,
    service_no: s(firstValue(body, existing, ['service_no'], '')),
    product_name: s(firstValue(body, existing, ['product_name', 'serviceName', '服务名称'], '')),
    unit: s(firstValue(body, existing, ['unit'], '')),
    price_id: n(firstValue(body, existing, ['price_id', 'priceId'], 0)),
    quantity: qty,
    unit_price: price,
    total_amount: totalIn !== undefined && totalIn !== '' ? n(totalIn) : round(qty * price, 2),
    settle_status: s(firstValue(body, existing, ['settle_status'], '未结算')),
    creator_personnel_id: creatorPersonnelId,
    creator_person: creatorPerson,
    remarks: s(firstValue(body, existing, ['remarks'], ''))
  };
}

// 列表（含筛选 + 汇总）
router.get('/trade-detail', requirePerm(PERM_VIEW), (req, res) => {
  const scope = scopeAmibaIds(req);
  const fromAmiba = s(req.query.from_amiba);
  const toAmiba = s(req.query.to_amiba);
  const status = s(req.query.status);
  const year = req.query.year ? Number(req.query.year) : null;
  const month = req.query.month ? Number(req.query.month) : null;
  const kw = s(req.query.keyword).toLowerCase();
  let list = readAll('amiba_trade_detail');
  if (scope) list = list.filter(d => scope.includes(Number(d.from_amiba_id)) || scope.includes(Number(d.to_amiba_id)));
  if (fromAmiba) list = list.filter(d => d.from_amiba === fromAmiba || Number(d.from_amiba_id) === Number(fromAmiba));
  if (toAmiba) list = list.filter(d => d.to_amiba === toAmiba || Number(d.to_amiba_id) === Number(toAmiba));
  if (status) list = list.filter(d => d.settle_status === status);
  if (year) list = list.filter(d => /^\d{4}/.test(d.trade_date || '') && Number((d.trade_date || '').substring(0, 4)) === year);
  if (month) list = list.filter(d => Number((d.trade_date || '').substring(5, 7)) === month);
  if (kw) list = list.filter(d => [d.trade_no, d.service_no, d.from_amiba, d.to_amiba, d.remarks].join(' ').toLowerCase().includes(kw));
  list = list.sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
  const summary = {
    count: list.length,
    total_amount: round(list.reduce((s2, d) => s2 + n(d.total_amount), 0), 2),
    settled_amount: round(list.filter(d => ['已结算', '已确认', '已完成'].includes(d.settle_status)).reduce((s2, d) => s2 + n(d.total_amount), 0), 2),
    unsettled_count: list.filter(d => !['已结算', '已确认', '已完成', '已撤销'].includes(d.settle_status)).length
  };
  res.json(Object.assign({ data: list }, paginate(list, req, 500), { summary }));
});

// 定价查询：根据「提供方巴+接收方巴+服务编号/产品编码」自动匹配生效内部单价（供交易明细带价）
router.get('/price/lookup', requirePerm(PERM_VIEW), (req, res) => {
  const fromId = n(req.query.from_amiba_id);
  const toId = n(req.query.to_amiba_id);
  const code = s(req.query.service_no || req.query.product_code).trim();
  const prices = readAll('amiba_trade_price').filter(p => p.price_status === '已生效');
  let matched = null;
  if (code) {
    // 精确匹配：方+方+编码
    matched = prices.find(p => (!fromId || Number(p.from_amiba_id) === fromId) && (!toId || Number(p.to_amiba_id) === toId) && (p.product_code === code || p.material_code === code));
    // 退而求其次：仅匹配编码
    if (!matched) matched = prices.find(p => (p.product_code === code || p.material_code === code));
  }
  // 再退：仅匹配方+方
  if (!matched && fromId && toId) matched = prices.find(p => Number(p.from_amiba_id) === fromId && Number(p.to_amiba_id) === toId);
  res.json({
    matched: !!matched,
    price: matched ? {
      price_id: matched.id,
      product_code: matched.material_code || matched.product_code,
      product_name: matched.material_name || matched.product_name,
      unit_price: n(matched.trade_price),
      unit: matched.unit,
      base_price: n(matched.base_price),
      coefficient: n(matched.coefficient)
    } : null,
    candidates: code ? prices.filter(p => (p.product_code || p.material_code || '').includes(code)).slice(0, 10).map(p => ({
      price_id: p.id, product_code: p.material_code || p.product_code, product_name: p.material_name || p.product_name,
      unit_price: n(p.trade_price), unit: p.unit, from_amiba_name: p.from_amiba_name, to_amiba_name: p.to_amiba_name
    })) : []
  });
});

// 汇总总表：所有交易明细 → 各部门/各经办人创造价值
// 价值定义：作为「提供方」的交易总金额 = 该部门/经办人创造的价值（收入）；作为「接收方」= 占用成本
router.get('/trade-detail/master-summary', requirePerm(PERM_VIEW), (req, res) => {
  const scope = scopeAmibaIds(req);
  const year = req.query.year ? Number(req.query.year) : null;
  const month = req.query.month ? Number(req.query.month) : null;
  const onlySettled = s(req.query.settled) === '1';
  let list = readAll('amiba_trade_detail');
  if (scope) list = list.filter(d => scope.includes(Number(d.from_amiba_id)) || scope.includes(Number(d.to_amiba_id)));
  if (year) list = list.filter(d => /^\d{4}/.test(d.trade_date || '') && Number((d.trade_date || '').substring(0, 4)) === year);
  if (month) list = list.filter(d => Number((d.trade_date || '').substring(5, 7)) === month);
  if (onlySettled) list = list.filter(d => ['已结算', '已确认', '已完成'].includes(s(d.settle_status)));
  // ---- 部门维度 ----
  const byDept = {};
  const touch = (id, name) => { if (!byDept[id]) byDept[id] = { amiba_id: id, amiba_name: name, provide_value: 0, receive_value: 0, provide_count: 0, receive_count: 0 }; };
  list.forEach(d => {
    const amt = n(d.total_amount);
    if (d.from_amiba_id) { touch(d.from_amiba_id, d.from_amiba); byDept[d.from_amiba_id].provide_value += amt; byDept[d.from_amiba_id].provide_count++; }
    if (d.to_amiba_id) { touch(d.to_amiba_id, d.to_amiba); byDept[d.to_amiba_id].receive_value += amt; byDept[d.to_amiba_id].receive_count++; }
  });
  const deptRows = Object.values(byDept).map(x => Object.assign(x, {
    provide_value: round(x.provide_value, 2), receive_value: round(x.receive_value, 2),
    net_value: round(x.provide_value - x.receive_value, 2)
  })).sort((a, b) => b.net_value - a.net_value);
  // ---- 经办人维度（个人创造价值 = 其经办的「作为提供方」交易金额）----
  const byPerson = {};
  list.forEach(d => {
    const person = s(d.creator_person);
    if (!person) return;
    const amt = n(d.total_amount);
    if (!byPerson[person]) byPerson[person] = { creator_person: person, amiba_name: d.from_amiba || '', create_value: 0, handle_value: 0, count: 0 };
    // 作为提供方经办 → 创造价值；作为接收方经办 → 处理价值
    if (d.from_amiba_id) { byPerson[person].create_value += amt; byPerson[person].amiba_name = byPerson[person].amiba_name || d.from_amiba; }
    else { byPerson[person].handle_value += amt; }
    byPerson[person].count++;
  });
  const personRows = Object.values(byPerson).map(x => Object.assign(x, {
    create_value: round(x.create_value, 2), handle_value: round(x.handle_value, 2)
  })).sort((a, b) => b.create_value - a.create_value);
  // ---- 总览 ----
  const overview = {
    total_trades: list.length,
    total_value: round(list.reduce((s2, d) => s2 + n(d.total_amount), 0), 2),
    settled_value: round(list.filter(d => ['已结算', '已确认', '已完成'].includes(s(d.settle_status))).reduce((s2, d) => s2 + n(d.total_amount), 0), 2),
    dept_count: deptRows.length, person_count: personRows.length,
    top_dept: deptRows[0] ? deptRows[0].amiba_name : '',
    top_dept_value: deptRows[0] ? deptRows[0].net_value : 0,
    top_person: personRows[0] ? personRows[0].creator_person : '',
    top_person_value: personRows[0] ? personRows[0].create_value : 0
  };
  res.json({ overview, dept_rows: deptRows, person_rows: personRows });
});

// 新增 / 更新
router.post('/trade-detail', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_trade_detail');
    const id = req.body.id;
    const data = tradeDetailPayload(req.body || {}, id ? table.findById(id) : null);
    if (!data.from_amiba && !data.to_amiba) return res.status(400).json({ error: '请填写提供方巴/接收方巴' });
    if (!data.trade_no) {
      const seq = String(Date.now()).slice(-6);
      data.trade_no = 'PZ' + seq;
    }
    if (!data.trade_date) data.trade_date = now().substring(0, 10);
    if (id) {
      const existing = table.findById(id);
      if (!existing) return res.status(404).json({ error: '交易明细不存在' });
      await table.update(id, Object.assign(data, { updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      const result = await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/trade-detail/:id', requirePerm(PERM_DELETE), async (req, res) => {
  try {
    const table = getTable('amiba_trade_detail');
    if (!table.findById(req.params.id)) return res.status(404).json({ error: '交易明细不存在' });
    await table.delete(req.params.id);
    res.json({ message: '删除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量结算状态变更
router.post('/trade-detail/batch-settle', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_trade_detail');
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const status = s(req.body.settle_status, '已结算');
    let updated = 0;
    for (const id of ids) {
      if (table.findById(id)) { await table.update(id, { settle_status: status, updated_at: now() }); updated++; }
    }
    res.json({ message: '批量更新成功', updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 下载模板（与官方核算表表头一致）
router.get('/trade-detail/template', requirePerm(PERM_VIEW), (req, res) => {
  const orgs = readAll('amiba_org').filter(o => o.status !== '停用').map(o => o.amiba_name);
  const fromName = orgs[0] || '生产制造巴';
  const toName = orgs[2] || '营销销售巴';
  const rows = [
    TRADE_DETAIL_HEADERS,
    ['PZ001', now().substring(0, 10), fromName, toName, 'LED-MOD-01', 'LED光源模组', '个', 100, 28, 2800, '已结算', '张三', '示例：选服务编号自动带价'],
    ['PZ002', now().substring(0, 10), fromName, toName, 'DRV-50W', '驱动电源', '个', 50, 45, 2250, '未结算', '李四', ''],
    ['PZ003', now().substring(0, 10), toName, fromName, 'SVC-003', '工艺支持', '次', 20, 15, 300, '已结算', '王五', ''],
    ['PZ004', '', '', '', '', '', '', '', '', '', '', '', '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '交易明细');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="amiba_trade_detail_template.xlsx"`);
  res.send(buf);
});

// 导出（与模板同表头）
router.get('/trade-detail/export', requirePerm(PERM_VIEW), (req, res) => {
  const scope = scopeAmibaIds(req);
  let list = readAll('amiba_trade_detail');
  if (scope) list = list.filter(d => scope.includes(Number(d.from_amiba_id)) || scope.includes(Number(d.to_amiba_id)));
  if (req.query.year) list = list.filter(d => Number((d.trade_date || '').substring(0, 4)) === Number(req.query.year));
  if (req.query.month) list = list.filter(d => Number((d.trade_date || '').substring(5, 7)) === Number(req.query.month));
  if (req.query.amiba_id) list = list.filter(d => Number(d.from_amiba_id) === Number(req.query.amiba_id) || Number(d.to_amiba_id) === Number(req.query.amiba_id));
  list = list.sort((a, b) => (a.trade_no || '').localeCompare(b.trade_no || ''));
  const rows = [TRADE_DETAIL_HEADERS].concat(list.map(d => [
    d.trade_no, d.trade_date, d.from_amiba, d.to_amiba, d.service_no, d.product_name, d.unit,
    d.quantity, d.unit_price, d.total_amount, d.settle_status, d.creator_person, d.remarks
  ]));
  // 合计行
  const totalCol = 9; // 总金额所在列索引（0-based）
  const sumRow = new Array(TRADE_DETAIL_HEADERS.length).fill('');
  sumRow[0] = '合计'; sumRow[totalCol] = round(list.reduce((s2, d) => s2 + n(d.total_amount), 0), 2);
  rows.push(sumRow);
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '交易明细');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const amibaSuffix = req.query.amiba_id ? '_' + encodeURIComponent((getTable('amiba_org').findById(req.query.amiba_id)||{}).amiba_name || '') : '';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="amiba_trade_detail${amibaSuffix}_${now().substring(0, 10)}.xlsx"`);
  res.send(buf);
});

// 导入：严格按模板表头解析（兼容换行/全角/列序变化）
router.post('/trade-detail/import', tradeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    let workbook;
    if (ext === '.csv' || ext === '.tsv') {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer', raw: true, FS: ext === '.tsv' ? '\t' : ',', codepage: 65001 });
    } else {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (!rawRows.length) return res.status(400).json({ error: '文件中没有数据' });

    // 建立列名→字段映射（按表头归一化匹配）
    const headerToField = {};
    Object.keys(rawRows[0]).forEach(h => {
      const f = TRADE_NORM_MAP[normalizeHeader(h)];
      if (f) headerToField[h] = f;
    });

    const table = getTable('amiba_trade_detail');
    let imported = 0, skipped = 0;
    const errors = [];
    rawRows.forEach((raw, idx) => {
      const row = {};
      Object.keys(headerToField).forEach(h => { row[headerToField[h]] = raw[h]; });
      // 跳过完全空行
      const vals = Object.values(row).map(v => s(v)).join('');
      if (!vals) { skipped++; return; }
      const payload = tradeDetailPayload(row, null);
      if (!payload.from_amiba && !payload.to_amiba) { skipped++; errors.push({ row: idx + 2, errors: ['提供方巴/接收方巴均为空'] }); return; }
      if (!payload.trade_no) payload.trade_no = 'PZ' + String(Date.now()).slice(-6) + idx;
      if (!payload.trade_date) payload.trade_date = now().substring(0, 10);
      try {
        table.insert(Object.assign(payload, { created_at: now(), updated_at: now() }));
        imported++;
      } catch (e) { skipped++; errors.push({ row: idx + 2, errors: ['插入失败: ' + e.message] }); }
    });
    table._invalidate();
    res.json({ message: `导入完成：成功 ${imported} 条，跳过 ${skipped} 条`, imported, skipped, total: rawRows.length, errors: errors.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: '导入失败: ' + e.message }); }
});

// ============================================================
// 核算表工作簿一键导入：定价清单 + 各巴交易明细子表（按子表名称识别巴单元）
// 工作簿结构：[定价清单] / [交易明细-XXX巴] / [交易明细-所有巴] / [巴级核算] / [总表校验]
// 子表名称中横线后的部分 = 巴单元名称（如「交易明细-品质巴」→ 品质巴），缺失自动补建。
// ============================================================
// 从「单价」单元格抽取数值（兼容 "5"、"100元/次"、"成本价格的1.2作为定价"）
function extractPrice(v) {
  if (v === undefined || v === null || v === '') return 0;
  const num = Number(v);
  if (Number.isFinite(num) && num > 0) return num;
  const m = String(v).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

router.post('/workbook/import', tradeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传 xlsx 工作簿文件' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const result = { pricing_imported: 0, pricing_skipped: 0, trade_imported: 0, trade_skipped: 0, amibas_created: [], sheets: [], errors: [] };
    const initialAmibaNames = new Set(readAll('amiba_org').map(o => o.amiba_name));

    // 定价清单表头中文→字段
    const PRICE_HEADER_MAP = {
      '编号': 'product_code', '代码': 'product_code', '服务编号': 'product_code',
      '服务/产品': 'product_name', '服务产品': 'product_name', '产品': 'product_name', '服务名称': 'product_name', '名称': 'product_name',
      '提供方巴': 'from_amiba', '提供方': 'from_amiba', '供方': 'from_amiba',
      '支付方巴': 'to_amiba', '支付方': 'to_amiba', '接收方巴': 'to_amiba', '接收方': 'to_amiba', '需方': 'to_amiba',
      '定价方式': 'price_method', '方式': 'price_method',
      '单价(元)': 'price_text', '单价': 'price_text', '价格': 'price_text',
      '单位': 'unit', '计量单位': 'unit',
      '结算条件': 'settle_condition', '条件': 'settle_condition'
    };
    const normPriceMap = {};
    Object.keys(PRICE_HEADER_MAP).forEach(cn => { normPriceMap[normalizeHeader(cn)] = PRICE_HEADER_MAP[cn]; });

    const priceTable = getTable('amiba_trade_price');
    const tradeTable = getTable('amiba_trade_detail');

    // 预读现有数据用于去重
    const existingPriceKeys = new Set(readAll('amiba_trade_price').map(p => (p.product_code || '') + '|' + (p.from_amiba_id || 0) + '|' + (p.to_amiba_id || 0)));
    const existingTradeNos = new Set(readAll('amiba_trade_detail').map(d => d.trade_no));

    // 缓存已导入的定价（服务编号→单价），供交易明细自动带价
    const priceCache = {};
    readAll('amiba_trade_price').forEach(p => {
      if (p.product_code && p.price_status === '已生效') priceCache[p.product_code] = p;
    });

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (!rows.length) continue;
      const header = rows[0].map(h => normalizeHeader(h));
      const isPriceSheet = /定价/.test(sheetName) || (header.some(h => h.includes('定价方式')) && !header.some(h => h.includes('交易编号')));
      const isTradeSheet = /交易明细/.test(sheetName) || header.some(h => h.includes('交易编号'));

      if (!isPriceSheet && !isTradeSheet) { result.sheets.push({ name: sheetName, type: '未识别', skipped: rows.length }); continue; }

      // 子表名称识别巴单元（交易明细-品质巴 → 品质巴）
      const sheetAmiba = sheetName.includes('-') ? s(sheetName.split('-').slice(1).join('-').replace(/子表|明细/g, '')) : '';

      if (isPriceSheet) {
        // 建列索引
        const colIdx = {};
        header.forEach((h, i) => { const f = normPriceMap[h]; if (f && colIdx[f] === undefined) colIdx[f] = i; });
        let imp = 0, skip = 0;
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          const get = k => colIdx[k] !== undefined ? s(r[colIdx[k]]) : '';
          const code = get('product_code');
          const pname = get('product_name');
          const fromName = get('from_amiba');
          const toName = get('to_amiba');
          const priceText = get('price_text');
          const unit = get('unit') || '次';
          const priceNum = extractPrice(priceText);
          // 跳过完全空行
          if (!code && !pname && !fromName && !priceText) { if (r.some(c => s(c))) skip++; continue; }
          // 无编号行不视为定价条目（避免误入空白分隔行）
          if (!code) { skip++; continue; }
          // 自动建巴：含分隔符的复合支付方（如"装配/精益/研发"）视为分组字符串不建巴
          const isCompoundOrExternal = (v) => !v || /[\/（）()]/.test(v) || /^(公司|各巴|用人巴|参训巴)$/.test(v);
          const from = (!isCompoundOrExternal(fromName)) ? await ensureAmibaByName(fromName) : { id: 0, name: fromName };
          const to = (!isCompoundOrExternal(toName)) ? await ensureAmibaByName(toName) : { id: 0, name: toName };
          const dedupeKey = code + '|' + from.id + '|' + to.id + '|' + (fromName||'') + '|' + (toName||'');
          if (code && existingPriceKeys.has(dedupeKey)) { skip++; continue; }
          // 名称兜底：分类标题行（如 S01+空名）用"服务项目-{编号}-{提供方巴}"作为占位名
          const finalName = pname || (fromName ? `${fromName}-${code}服务` : `服务项目-${code}`);
          const payload = {
            material_id: 0, material_code: code, product_code: code,
            material_name: finalName, product_name: finalName,
            from_amiba_id: from.id, from_amiba_name: from.name || fromName,
            to_amiba_id: to.id, to_amiba_name: to.name || toName,
            base_price: round(priceNum, 4), coefficient: priceNum ? 1 : 0,
            trade_price: round(priceNum, 4), unit,
            price_method: get('price_method'), settle_condition: get('settle_condition'),
            price_status: priceNum > 0 ? '已生效' : '待审核',
            audit_status: priceNum > 0 ? '已通过' : '待审核',
            effect_time: now().substring(0, 10),
            remarks: priceText && priceText !== String(priceNum) ? priceText : ''
          };
          try {
            const ins = await priceTable.insert(Object.assign(payload, { created_at: now(), updated_at: now() }));
            if (code) { priceCache[code] = Object.assign({ id: ins.lastID }, payload); existingPriceKeys.add(dedupeKey); }
            imp++;
          } catch (e) { result.errors.push({ sheet: sheetName, row: i + 1, error: e.message }); skip++; }
        }
        result.pricing_imported += imp; result.pricing_skipped += skip;
        result.sheets.push({ name: sheetName, type: '定价清单', imported: imp, skipped: skip });
        priceTable._invalidate();
        continue;
      }

      // 交易明细子表
      if (isTradeSheet) {
        const colIdx = {};
        header.forEach((h, i) => { const f = TRADE_NORM_MAP[h]; if (f && colIdx[f] === undefined) colIdx[f] = i; });
        // 兜底：按中文表头位置识别（标准模板顺序）
        const stdOrder = ['trade_no', 'trade_date', 'from_amiba', 'to_amiba', 'service_no', 'product_name', 'unit', 'quantity', 'unit_price', 'total_amount', 'settle_status', 'creator_person', 'remarks'];
        if (Object.keys(colIdx).length < 3) {
          // 未识别到字段名时按标准模板列序兜底
          rows[0].forEach((h, i) => { if (i < stdOrder.length && colIdx[stdOrder[i]] === undefined) colIdx[stdOrder[i]] = i; });
        }
        let imp = 0, skip = 0;
        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          const get = (k, def) => colIdx[k] !== undefined && r[colIdx[k]] !== '' && r[colIdx[k]] !== undefined ? r[colIdx[k]] : def;
          const tradeNo = s(get('trade_no'));
          if (!tradeNo && !r.some(c => s(c))) { skip++; continue; } // 完全空行
          const fromName = s(get('from_amiba', sheetAmiba));
          const toName = s(get('to_amiba'));
          if (!fromName && !toName) { skip++; continue; }
          // 去重（交易编号）—— 在建巴之前判断，避免为重复/跳过行误建巴
          if (tradeNo && existingTradeNos.has(tradeNo)) { skip++; continue; }
          const from = await ensureAmibaByName(fromName);
          const to = await ensureAmibaByName(toName);
          const svcNo = s(get('service_no'));
          const qty = n(get('quantity', 0));
          let unitPrice = n(get('unit_price', 0));
          // 关联定价清单自动带价：交易明细无单价时按服务编号查定价
          if (!unitPrice && svcNo && priceCache[svcNo]) {
            unitPrice = n(priceCache[svcNo].trade_price);
          }
          const totalIn = get('total_amount');
          const total = (totalIn !== '' && totalIn !== undefined) ? n(totalIn) : round(qty * unitPrice, 2);
          const payload = {
            trade_no: tradeNo || ('PZ' + String(Date.now()).slice(-6) + i),
            trade_date: excelDate(get('trade_date')) || now().substring(0, 10),
            from_amiba: from.name, from_amiba_id: from.id,
            to_amiba: to.name, to_amiba_id: to.id,
            service_no: svcNo,
            product_name: s(get('product_name')) || (svcNo && priceCache[svcNo] ? priceCache[svcNo].product_name : ''),
            unit: s(get('unit')) || (svcNo && priceCache[svcNo] ? priceCache[svcNo].unit : '') || '次',
            price_id: svcNo && priceCache[svcNo] ? n(priceCache[svcNo].id) : 0,
            quantity: qty, unit_price: unitPrice, total_amount: total,
            settle_status: s(get('settle_status', '未结算')) || '未结算',
            creator_person: s(get('creator_person')),
            remarks: s(get('remarks')),
            created_at: now(), updated_at: now()
          };
          existingTradeNos.add(payload.trade_no);
          try { await tradeTable.insert(payload); imp++; } catch (e) { result.errors.push({ sheet: sheetName, row: i + 1, error: e.message }); skip++; }
        }
        result.trade_imported += imp; result.trade_skipped += skip;
        result.sheets.push({ name: sheetName, type: '交易明细', imported: imp, skipped: skip, amiba: sheetAmiba });
        tradeTable._invalidate();
      }
    }
    priceTable._invalidate(); tradeTable._invalidate();
    getTable('amiba_org')._invalidate();
    result.amibas_created = readAll('amiba_org').filter(o => !initialAmibaNames.has(o.amiba_name)).map(o => o.amiba_name);
    result.amibas = readAll('amiba_org').filter(o => o.status !== '停用').map(o => o.amiba_name);
    const tot = result.pricing_imported + result.trade_imported;
    res.json({ message: `工作簿导入完成：定价 ${result.pricing_imported} 条、交易明细 ${result.trade_imported} 条${result.amibas_created.length ? '、新建巴 ' + result.amibas_created.length + ' 个' : ''}`, total: tot, result });
  } catch (e) { res.status(500).json({ error: '工作簿导入失败: ' + e.message }); }
});

// ---- 系统数据归集：从 orders/inquiries/materials/projects 取数 ----
function collectFromSystem(amiba, year, month) {
  const deptId = Number(amiba.department_id) || 0;
  const sales = s(amiba.sales_person);
  const cat = s(amiba.product_category);
  const matchOrder = (r) => {
    if (!inYM(r.promised_date || r.created_at, year, month)) return false;
    if (deptId && Number(r.department_id) === deptId) return true;
    if (sales && s(r.create_by) === sales) return true;
    return false;
  };
  const matchCost = (r) => {
    if (!inYM(r.inquiry_time || r.created_at, year, month)) return false;
    if (deptId && Number(r.department_id) === deptId) return true;
    if (sales && s(r.sales_person) === sales) return true;
    if (cat && s(r.product_category) === cat) return true;
    return false;
  };
  let income = 0;
  try { income = readAll('orders').filter(matchOrder).reduce((s2, o) => s2 + n(o.order_amount || o.total_amount), 0); } catch (e) {}
  let material = 0, process = 0, accessory = 0;
  try {
    readAll('inquiries').filter(matchCost).forEach(q => {
      material += n(q.material_cost);
      process += n(q.process_cost);
      accessory += n(q.accessory_cost);
    });
  } catch (e) {}
  // 内部交易成本：优先取本巴作为接收方的「已结算」交易明细（按交易日期匹配年月）
  let internalTrade = 0;
  try {
    internalTrade = readAll('amiba_trade_detail')
      .filter(d => (Number(d.to_amiba_id) === Number(amiba.id) || (d.to_amiba && d.to_amiba === amiba.amiba_name))
        && ['已结算', '已确认', '已完成'].includes(s(d.settle_status))
        && inYM(d.trade_date, year, month))
      .reduce((s2, d) => s2 + n(d.total_amount), 0);
  } catch (e) {}
  // 兜底：无交易明细时按生效内部定价计入
  if (!internalTrade) {
    try {
      internalTrade = readAll('amiba_trade_price')
        .filter(p => Number(p.to_amiba_id) === Number(amiba.id) && p.price_status === '已生效')
        .reduce((s2, p) => s2 + n(p.trade_price), 0);
    } catch (e) {}
  }
  // 本巴作为提供方的收入（内部交易卖出）
  let internalIncome = 0;
  try {
    internalIncome = readAll('amiba_trade_detail')
      .filter(d => (Number(d.from_amiba_id) === Number(amiba.id) || (d.from_amiba && d.from_amiba === amiba.amiba_name))
        && ['已结算', '已确认', '已完成'].includes(s(d.settle_status))
        && inYM(d.trade_date, year, month))
      .reduce((s2, d) => s2 + n(d.total_amount), 0);
  } catch (e) {}
  // 应收(AR) → 按应收确认收入（权责发生制）
  // 当本巴存在应收单据时，以应收 amount 作为已确认收入，覆盖订单推算值
  let arIncome = 0;
  try {
    arIncome = readAll('amiba_ar')
      .filter(r => Number(r.amiba_id) === Number(amiba.id)
        && inYM(r.trade_date, year, month))
      .reduce((s2, r) => s2 + n(r.amount), 0);
  } catch (e) {}
  // 应付(AP) → 按应付确认成本
  // 当本巴存在应付单据时，以应付 amount 作为已确认材料成本，覆盖询价推算值
  let apMaterial = 0;
  try {
    apMaterial = readAll('amiba_ap')
      .filter(r => Number(r.amiba_id) === Number(amiba.id)
        && inYM(r.trade_date, year, month))
      .reduce((s2, r) => s2 + n(r.amount), 0);
  } catch (e) {}
  return {
    // 收入：优先采用应收确认值，无应收时回退到订单推算
    income_total: round((arIncome > 0 ? arIncome : income) + internalIncome, 2),
    // 材料成本：优先采用应付确认值，无应付时回退到询价推算
    material_cost: round(apMaterial > 0 ? apMaterial : material, 2),
    energy_cost: 0,
    labor_cost: 0,
    manage_fee: 0,
    internal_trade_cost: round(internalTrade, 2),
    other_cost: round(process + accessory, 2),
    _source: {
      orders: income > 0 && arIncome === 0,
      inquiries: material > 0 && apMaterial === 0,
      ar: arIncome > 0,
      ap: apMaterial > 0,
      materials: false
    }
  };
}

// 经营核算利润计算（硬编码规则）
function calcProfit(d) {
  const cost = n(d.material_cost) + n(d.energy_cost) + n(d.labor_cost) + n(d.manage_fee) + n(d.internal_trade_cost) + n(d.other_cost);
  const profit = n(d.income_total) - cost;
  return Object.assign({}, d, {
    total_cost: round(cost, 2),
    profit: round(profit, 2),
    profit_rate: n(d.income_total) ? round(profit / n(d.income_total) * 100, 1) : 0
  });
}

// 月度自动核算：归集系统数据并生成/更新核算明细
router.post('/account/calc', requirePerm(PERM_CALC), async (req, res) => {
  try {
    const year = n(req.body.year, currentYear());
    const month = n(req.body.month, currentMonth());
    const scope = scopeAmibaIds(req);
    let orgs = readAll('amiba_org').filter(o => o.status !== '停用');
    if (scope) orgs = orgs.filter(o => scope.includes(o.id));
    const onlyId = n(req.body.amiba_id, 0);
    if (onlyId) orgs = orgs.filter(o => Number(o.id) === onlyId);
    const table = getTable('amiba_account_detail');
    let processed = 0;
    for (const o of orgs) {
      const sys = collectFromSystem(o, year, month);
      const existing = readAll('amiba_account_detail').find(d =>
        Number(d.amiba_id) === Number(o.id) && Number(d.year) === year && Number(d.month) === month);
      // 已手工录入的成本项予以保留（系统仅填充空值）
      const merged = {
        amiba_id: o.id, amiba_name: o.amiba_name, year, month,
        income_total: existing && existing.income_locked ? existing.income_total : sys.income_total,
        material_cost: existing && existing.material_cost ? existing.material_cost : sys.material_cost,
        energy_cost: existing && existing.energy_cost ? existing.energy_cost : sys.energy_cost,
        labor_cost: existing && existing.labor_cost ? existing.labor_cost : sys.labor_cost,
        manage_fee: existing && existing.manage_fee ? existing.manage_fee : sys.manage_fee,
        internal_trade_cost: existing && existing.internal_trade_cost ? existing.internal_trade_cost : sys.internal_trade_cost,
        other_cost: existing && existing.other_cost ? existing.other_cost : sys.other_cost,
        source: '系统归集', updated_at: now()
      };
      const withProfit = calcProfit(merged);
      if (existing) { await table.update(existing.id, withProfit); }
      else { await table.insert(Object.assign(withProfit, { created_at: now() })); }
      processed++;
    }
    res.json({ message: '核算完成', processed, year, month });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 应收(AR)列表 — 按巴归集（用于经营核算展示）
router.get('/ar', requirePerm(PERM_VIEW), (req, res) => {
  const scope = scopeAmibaIds(req);
  const year = req.query.year ? Number(req.query.year) : null;
  const month = req.query.month ? Number(req.query.month) : null;
  let list = readAll('amiba_ar');
  if (scope) list = list.filter(r => scope.includes(Number(r.amiba_id)));
  if (year) list = list.filter(r => /^\d{4}/.test(r.trade_date || '') && Number((r.trade_date || '').substring(0, 4)) === year);
  if (month) list = list.filter(r => Number((r.trade_date || '').substring(5, 7)) === month);
  list = list.sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
  const summary = {
    count: list.length,
    total_amount: round(list.reduce((s2, r) => s2 + n(r.amount), 0), 2),
    outstanding: round(list.reduce((s2, r) => s2 + Math.max(0, n(r.amount) - n(r.paid_amount)), 0), 2),
    closed: list.filter(r => r.status === 'closed').length,
    open: list.filter(r => r.status === 'open').length
  };
  res.json(Object.assign({ data: list }, paginate(list, req, 200), { summary }));
});

// 应付(AP)列表 — 按巴归集
router.get('/ap', requirePerm(PERM_VIEW), (req, res) => {
  const scope = scopeAmibaIds(req);
  const year = req.query.year ? Number(req.query.year) : null;
  const month = req.query.month ? Number(req.query.month) : null;
  let list = readAll('amiba_ap');
  if (scope) list = list.filter(r => scope.includes(Number(r.amiba_id)));
  if (year) list = list.filter(r => /^\d{4}/.test(r.trade_date || '') && Number((r.trade_date || '').substring(0, 4)) === year);
  if (month) list = list.filter(r => Number((r.trade_date || '').substring(5, 7)) === month);
  list = list.sort((a, b) => (b.trade_date || '').localeCompare(a.trade_date || ''));
  const summary = {
    count: list.length,
    total_amount: round(list.reduce((s2, r) => s2 + n(r.amount), 0), 2),
    outstanding: round(list.reduce((s2, r) => s2 + Math.max(0, n(r.amount) - n(r.paid_amount)), 0), 2),
    closed: list.filter(r => r.status === 'closed').length,
    open: list.filter(r => r.status === 'open').length
  };
  res.json(Object.assign({ data: list }, paginate(list, req, 200), { summary }));
});

// 损益数据列表（含上期单位成本对比，算降本节约额）
router.get('/account/profitList', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const month = req.query.month !== undefined ? n(req.query.month) : null;
  const scope = scopeAmibaIds(req);
  let list = readAll('amiba_account_detail').filter(d => Number(d.year) === year);
  if (month !== null) list = list.filter(d => Number(d.month) === month);
  if (scope) list = list.filter(d => scope.includes(Number(d.amiba_id)));
  list = list.map(d => {
    const prev = readAll('amiba_account_detail').find(p =>
      Number(p.amiba_id) === Number(d.amiba_id) && Number(p.year) === year &&
      Number(p.month) === (Number(d.month) - 1 || 12));
    const prevUnit = prev && prev.income_total ? n(prev.total_cost) / n(prev.income_total) : 0;
    const curUnit = d.income_total ? n(d.total_cost) / n(d.income_total) : 0;
    const save = prevUnit ? round((prevUnit - curUnit) * n(d.income_total), 2) : 0;
    return calcProfit(Object.assign({}, d, { prev_unit_cost: round(prevUnit, 4), unit_cost: round(curUnit, 4), save_amount: save }));
  }).sort((a, b) => b.profit - a.profit);
  res.json(paginate(list, req, 200));
});

// 手工保存/调整核算明细
router.post('/account', requirePerm(PERM_CALC), async (req, res) => {
  try {
    const table = getTable('amiba_account_detail');
    const id = req.body.id;
    const base = {
      amiba_id: n(req.body.amiba_id),
      amiba_name: s(req.body.amiba_name || orgName(req.body.amiba_id)),
      year: n(req.body.year, currentYear()),
      month: n(req.body.month, currentMonth()),
      income_total: n(req.body.income_total),
      material_cost: n(req.body.material_cost),
      energy_cost: n(req.body.energy_cost),
      labor_cost: n(req.body.labor_cost),
      manage_fee: n(req.body.manage_fee),
      internal_trade_cost: n(req.body.internal_trade_cost),
      other_cost: n(req.body.other_cost),
      income_locked: !!req.body.income_locked,
      source: '手工录入', updated_at: now()
    };
    const withProfit = calcProfit(base);
    if (id) {
      const existing = table.findById(id);
      if (!existing) return res.status(404).json({ error: '核算记录不存在' });
      await table.update(id, withProfit);
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      const dup = readAll('amiba_account_detail').find(d =>
        Number(d.amiba_id) === base.amiba_id && Number(d.year) === base.year && Number(d.month) === base.month);
      if (dup) { await table.update(dup.id, withProfit); return res.json({ message: '保存成功', data: table.findById(dup.id) }); }
      const result = await table.insert(Object.assign(withProfit, { created_at: now() }));
      res.json({ message: '保存成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 争议仲裁
// ============================================================
function disputePayload(body, existing) {
  return {
    from_amiba_id: n(firstValue(body, existing, ['from_amiba_id'], 0)),
    from_amiba_name: s(firstValue(body, existing, ['from_amiba_name'], '')) || orgName(firstValue(body, existing, ['from_amiba_id'], 0)),
    to_amiba_id: n(firstValue(body, existing, ['to_amiba_id'], 0)),
    to_amiba_name: s(firstValue(body, existing, ['to_amiba_name'], '')) || orgName(firstValue(body, existing, ['to_amiba_id'], 0)),
    dispute_type: s(firstValue(body, existing, ['dispute_type', 'type'], '定价')),
    dispute_desc: s(firstValue(body, existing, ['dispute_desc', 'desc'], '')),
    amount: n(firstValue(body, existing, ['amount'], 0)),
    apply_user: s(firstValue(body, existing, ['apply_user'], '')),
    apply_time: s(firstValue(body, existing, ['apply_time'], now())),
    audit_result: s(firstValue(body, existing, ['audit_result'], '待初审')),
    audit_opinion: s(firstValue(body, existing, ['audit_opinion'], '')),
    audit_user: s(firstValue(body, existing, ['audit_user'], '')),
    finish_time: s(firstValue(body, existing, ['finish_time'], '')),
    status: s(firstValue(body, existing, ['status'], '待处理'))
  };
}

router.get('/dispute', requirePerm(PERM_VIEW), (req, res) => {
  const status = s(req.query.status);
  const scope = scopeAmibaIds(req);
  let list = readAll('amiba_dispute');
  if (status) list = list.filter(d => d.status === status);
  if (scope) list = list.filter(d => scope.includes(Number(d.from_amiba_id)) || scope.includes(Number(d.to_amiba_id)));
  res.json(paginate(list.sort((a, b) => b.id - a.id), req, 200));
});

router.post('/dispute', requirePerm(PERM_CREATE), async (req, res) => {
  try {
    const table = getTable('amiba_dispute');
    const id = req.body.id;
    const data = disputePayload(req.body || {}, id ? table.findById(id) : null);
    if (!data.dispute_desc) return res.status(400).json({ error: '请填写争议描述' });
    if (id) {
      await table.update(id, Object.assign(data, { updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      const result = await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
      await logAudit('dispute_apply', result.lastID, req);
      res.json({ message: '提交成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 仲裁审批：推行办初审 → 委员会终审
router.post('/dispute/:id/audit', requirePerm(PERM_AUDIT), async (req, res) => {
  try {
    const table = getTable('amiba_dispute');
    const existing = table.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: '争议不存在' });
    const action = s(req.body.action, '初审'); // 初审 / 终审
    const pass = req.body.pass !== false;
    let auditResult = existing.audit_result;
    let status = existing.status;
    if (action === '初审') { auditResult = pass ? '初审通过' : '初审驳回'; status = pass ? '待终审' : '已驳回'; }
    else { auditResult = pass ? '终审通过' : '终审驳回'; status = pass ? '已裁决' : '已驳回'; }
    await table.update(req.params.id, {
      audit_result: auditResult, status,
      audit_opinion: s(req.body.audit_opinion, existing.audit_opinion),
      audit_user: s(req.body.audit_user, existing.audit_user),
      finish_time: pass && action === '终审' ? now() : existing.finish_time,
      updated_at: now()
    });
    await logAudit('dispute_audit', existing.id, req);
    res.json({ message: '审批完成', data: table.findById(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 模块4：降本改善 & 先锋试点巴
// ============================================================
// 成本测绘分析：按巴汇总成本，识别高成本单元（潜力测绘）
router.get('/cost-map/analysis', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const month = req.query.month !== undefined ? n(req.query.month) : null;
  const scope = scopeAmibaIds(req);
  let details = readAll('amiba_account_detail').filter(d => Number(d.year) === year);
  if (month !== null) details = details.filter(d => Number(d.month) === month);
  if (scope) details = details.filter(d => scope.includes(Number(d.amiba_id)));
  const byAmiba = {};
  details.forEach(d => {
    const key = d.amiba_id;
    if (!byAmiba[key]) byAmiba[key] = { amiba_id: d.amiba_id, amiba_name: d.amiba_name, total_cost: 0, income: 0, records: 0 };
    byAmiba[key].total_cost += n(d.total_cost);
    byAmiba[key].income += n(d.income_total);
    byAmiba[key].records++;
  });
  const ranks = Object.values(byAmiba).map(x => {
    const unit = x.income ? x.total_cost / x.income : 0;
    return Object.assign(x, { total_cost: round(x.total_cost, 2), unit_cost: round(unit, 4), heat: clamp(Math.round(unit * 100), 0, 100) });
  }).sort((a, b) => b.unit_cost - a.unit_cost);
  const pioneers = readAll('amiba_pioneer').map(p => Object.assign({}, p, { amiba_name: orgName(p.amiba_id) }));
  res.json({
    ranks,
    pioneer_amiba_ids: readAll('amiba_pioneer').map(p => p.amiba_id),
    pioneers,
    suggestion: ranks.length && ranks[0].unit_cost > 0
      ? `${ranks[0].amiba_name} 单位成本最高（${ranks[0].unit_cost}），建议列为先锋试点巴重点突破。`
      : '暂无足够核算数据，请先执行月度核算。'
  });
});

// 先锋试点巴
router.get('/pioneer', requirePerm(PERM_VIEW), (req, res) => {
  res.json(paginate(readAll('amiba_pioneer').map(p => Object.assign({}, p, { amiba_name: orgName(p.amiba_id) })).sort((a, b) => b.id - a.id), req, 200));
});

router.post('/pioneer/set', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_pioneer');
    const amibaId = n(req.body.amiba_id);
    if (!amibaId) return res.status(400).json({ error: '请选择巴单元' });
    const existing = readAll('amiba_pioneer').find(p => Number(p.amiba_id) === amibaId);
    const data = {
      amiba_id: amibaId,
      pioneer_status: s(req.body.pioneer_status, existing ? existing.pioneer_status : '试点中'),
      start_time: s(req.body.start_time, existing ? existing.start_time : now().substring(0, 10)),
      end_time: s(req.body.end_time, existing ? existing.end_time : ''),
      target_desc: s(req.body.target_desc, existing ? existing.target_desc : ''),
      before_cost: n(req.body.before_cost, existing ? existing.before_cost : 0),
      after_cost: n(req.body.after_cost, existing ? existing.after_cost : 0),
      total_save: n(req.body.total_save, existing ? existing.total_save : 0),
      updated_at: now()
    };
    data.total_save = n(data.before_cost) - n(data.after_cost);
    if (existing) {
      await table.update(existing.id, data);
      res.json({ message: '设置成功', data: table.findById(existing.id) });
    } else {
      const result = await table.insert(Object.assign(data, { created_at: now() }));
      res.json({ message: '设置成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/pioneer/:id', requirePerm(PERM_DELETE), async (req, res) => {
  try {
    const table = getTable('amiba_pioneer');
    if (!table.findById(req.params.id)) return res.status(404).json({ error: '试点巴不存在' });
    await table.delete(req.params.id);
    res.json({ message: '已取消试点' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 降本改善项目
function improvePayload(body, existing) {
  return {
    amiba_id: n(firstValue(body, existing, ['amiba_id'], 0)),
    amiba_name: s(firstValue(body, existing, ['amiba_name'], '')) || orgName(firstValue(body, existing, ['amiba_id'], 0)),
    project_name: s(firstValue(body, existing, ['project_name', 'name'], '')),
    improve_type: s(firstValue(body, existing, ['improve_type', 'type'], '费用')),
    year: n(firstValue(body, existing, ['year'], currentYear())),
    month: n(firstValue(body, existing, ['month'], 0)),
    target_value: n(firstValue(body, existing, ['target_value'], 0)),
    real_value: n(firstValue(body, existing, ['real_value'], 0)),
    save_amount: n(firstValue(body, existing, ['save_amount'], 0)),
    apply_user: s(firstValue(body, existing, ['apply_user'], '')),
    owner: s(firstValue(body, existing, ['owner'], '')),
    status: s(firstValue(body, existing, ['status'], '立项')),
    audit_status: s(firstValue(body, existing, ['audit_status'], '待审核')),
    finish_time: s(firstValue(body, existing, ['finish_time'], '')),
    is_case: !!firstValue(body, existing, ['is_case'], false)
  };
}

router.get('/improve', requirePerm(PERM_VIEW), (req, res) => {
  const status = s(req.query.status);
  const scope = scopeAmibaIds(req);
  let list = readAll('amiba_cost_improve');
  if (status) list = list.filter(p => p.status === status);
  if (scope) list = list.filter(p => scope.includes(Number(p.amiba_id)));
  res.json(paginate(list.sort((a, b) => b.id - a.id), req, 200));
});

router.post('/improve', requirePerm(PERM_CREATE), async (req, res) => {
  try {
    const table = getTable('amiba_cost_improve');
    const id = req.body.id;
    const data = improvePayload(req.body || {}, id ? table.findById(id) : null);
    if (!data.project_name) return res.status(400).json({ error: '请填写项目名称' });
    if (id) {
      await table.update(id, Object.assign(data, { updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      const result = await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
      res.json({ message: '提交成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 结项核算节约金额 + 案例归档
router.post('/improve/:id/finish', requirePerm(PERM_CALC), async (req, res) => {
  try {
    const table = getTable('amiba_cost_improve');
    const existing = table.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: '改善项目不存在' });
    const save = n(req.body.save_amount, existing.target_value - existing.real_value);
    await table.update(req.params.id, {
      real_value: n(req.body.real_value, existing.real_value),
      save_amount: save,
      status: '已完成',
      finish_time: now(),
      is_case: req.body.is_case !== false,
      updated_at: now()
    });
    res.json({ message: '结项成功，节约 ' + save + ' 元', data: table.findById(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 模块5：培训激励 + 绩效联动
// ============================================================
router.get('/train', requirePerm(PERM_VIEW), (req, res) => {
  res.json(paginate(readAll('amiba_train').sort((a, b) => b.id - a.id), req, 200));
});

router.post('/train', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_train');
    const id = req.body.id;
    const data = {
      train_name: s(req.body.train_name),
      train_content: s(req.body.train_content),
      train_type: s(req.body.train_type, '阿米巴经营'),
      train_time: s(req.body.train_time, now().substring(0, 10)),
      participant_num: n(req.body.participant_num),
      finish_num: n(req.body.finish_num),
      create_user: s(req.body.create_user)
    };
    if (id) {
      const existing = table.findById(id);
      if (!existing) return res.status(404).json({ error: '培训记录不存在' });
      await table.update(id, Object.assign(data, { updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      if (!data.train_name) return res.status(400).json({ error: '请填写培训主题' });
      const result = await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/train/:id', requirePerm(PERM_DELETE), async (req, res) => {
  try {
    const table = getTable('amiba_train');
    if (!table.findById(req.params.id)) return res.status(404).json({ error: '培训记录不存在' });
    await table.delete(req.params.id);
    res.json({ message: '删除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 激励奖金测算：节约额 × 提奖比例（默认 20%），按巴汇总
router.get('/bonus/calc', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const rate = n(req.query.rate, 0.2);
  const scope = scopeAmibaIds(req);
  const projects = readAll('amiba_cost_improve').filter(p => Number(p.year) === year && p.status === '已完成');
  const byAmiba = {};
  projects.forEach(p => {
    if (scope && !scope.includes(Number(p.amiba_id))) return;
    if (!byAmiba[p.amiba_id]) byAmiba[p.amiba_id] = { amiba_id: p.amiba_id, amiba_name: p.amiba_name || orgName(p.amiba_id), save: 0, count: 0 };
    byAmiba[p.amiba_id].save += n(p.save_amount);
    byAmiba[p.amiba_id].count++;
  });
  const list = Object.values(byAmiba).map(x => ({
    amiba_id: x.amiba_id, amiba_name: x.amiba_name,
    total_save: round(x.save, 2), project_count: x.count,
    bonus: round(x.save * rate, 2), rate
  })).sort((a, b) => b.bonus - a.bonus);
  res.json({ year, rate, total_save: round(list.reduce((s2, x) => s2 + x.total_save, 0), 2), total_bonus: round(list.reduce((s2, x) => s2 + x.bonus, 0), 2), list });
});

// 绩效 KPI 同步：巴长经营评分 = 目标达成率 × 0.5 + 利润率达成 × 0.3 + 改善贡献 × 0.2
router.get('/kpi/sync', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const orgs = readAll('amiba_org').filter(o => o.status !== '停用');
  const scope = scopeAmibaIds(req);
  const list = orgs.filter(o => !scope || scope.includes(o.id)).map(o => {
    const target = readAll('amiba_cost_target').find(t => Number(t.amiba_id) === o.id && Number(t.year) === year && Number(t.month) === 0);
    const targetRate = target ? targetWithReal(target).completion_rate : 0;
    const acc = readAll('amiba_account_detail').filter(d => Number(d.amiba_id) === o.id && Number(d.year) === year);
    const profit = acc.reduce((s2, d) => s2 + n(d.profit), 0);
    const income = acc.reduce((s2, d) => s2 + n(d.income_total), 0);
    const profitRate = income ? round(profit / income * 100, 1) : 0;
    const improveCount = readAll('amiba_cost_improve').filter(p => Number(p.amiba_id) === o.id && Number(p.year) === year && p.status === '已完成').length;
    const improveScore = clamp(improveCount * 10, 0, 100);
    const score = clamp(round(targetRate * 0.5 + clamp(profitRate, 0, 100) * 0.3 + improveScore * 0.2, 1), 0, 100);
    return {
      amiba_id: o.id, amiba_name: o.amiba_name,
      chief: o.charge_user_name,
      target_rate: round(targetRate, 1),
      profit_rate: profitRate,
      improve_count: improveCount,
      kpi_score: score,
      grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'D'
    };
  }).sort((a, b) => b.kpi_score - a.kpi_score);
  res.json({ year, list });
});

// ============================================================
// 月度月报
// ============================================================
router.get('/report', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  res.json(paginate(readAll('amiba_month_report').filter(r => Number(r.year) === year).sort((a, b) => b.id - a.id), req, 200));
});

router.post('/report', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const table = getTable('amiba_month_report');
    const id = req.body.id;
    const data = {
      year: n(req.body.year, currentYear()),
      month: n(req.body.month, currentMonth()),
      report_content: s(req.body.report_content),
      file_url: s(req.body.file_url),
      publish_status: s(req.body.publish_status, '草稿')
    };
    if (id) {
      const existing = table.findById(id);
      if (!existing) return res.status(404).json({ error: '月报不存在' });
      await table.update(id, Object.assign(data, { updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(id) });
    } else {
      const result = await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(result.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 一键生成月报内容
router.post('/report/generate', requirePerm(PERM_CALC), async (req, res) => {
  try {
    const year = n(req.body.year, currentYear());
    const month = n(req.body.month, currentMonth());
    const details = readAll('amiba_account_detail').filter(d => Number(d.year) === year && Number(d.month) === month);
    const income = details.reduce((s2, d) => s2 + n(d.income_total), 0);
    const cost = details.reduce((s2, d) => s2 + n(d.total_cost), 0);
    const profit = income - cost;
    const improveSave = readAll('amiba_cost_improve').filter(p => Number(p.year) === year && Number(p.month) === month && p.status === '已完成').reduce((s2, p) => s2 + n(p.save_amount), 0);
    const content = [
      `【${year}年${month}月 阿米巴经营月报】`,
      `一、经营概览：全公司总收入 ${round(income, 2)} 元，总成本 ${round(cost, 2)} 元，经营利润 ${round(profit, 2)} 元，利润率 ${income ? round(profit / income * 100, 1) : 0}%。`,
      `二、降本成果：本月改善项目累计节约 ${round(improveSave, 2)} 元。`,
      `三、巴单元排名（按利润）：`,
      details.map(d => calcProfit(d)).sort((a, b) => b.profit - a.profit).slice(0, 5)
        .map((d, i) => `  ${i + 1}. ${d.amiba_name}：利润 ${round(d.profit, 2)} 元（利润率 ${d.profit_rate}%）`).join('\n'),
      `四、下月重点：持续推进先锋试点巴专项降本，落实责任状目标。`
    ].join('\n');
    res.json({ year, month, report_content: content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 审批流日志
// ============================================================
async function logAudit(flowType, businessId, req) {
  try {
    const userId = req.body.user_id || req.body.userId || req.headers['x-user'] || '';
    const userTable = getTable('users');
    let userName = s(req.body.audit_user || req.body.apply_user);
    if (!userName && userId) { const u = userTable.findById(Number(userId)); if (u) userName = u.name || u.username; }
    await getTable('amiba_audit_flow').insert({
      flow_type: flowType, business_id: businessId,
      apply_user: userName, audit_user: userName,
      audit_status: s(req.body.audit_result || req.body.action || '提交'),
      audit_opinion: s(req.body.audit_opinion), created_at: now()
    });
  } catch (e) { /* 审批日志失败不影响主流程 */ }
}

router.get('/audit-flow', requirePerm(PERM_VIEW), (req, res) => {
  const type = s(req.query.flow_type);
  let list = readAll('amiba_audit_flow');
  if (type) list = list.filter(r => r.flow_type === type);
  res.json(paginate(list.sort((a, b) => b.id - a.id), req, 50));
});

// ============================================================
// 可视化看板（驾驶舱/大屏数据）
// ============================================================
router.get('/dashboard', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const scope = scopeAmibaIds(req);
  const orgs = readAll('amiba_org');
  const scopedOrgs = scope ? orgs.filter(o => scope.includes(o.id)) : orgs;
  const details = readAll('amiba_account_detail').filter(d => Number(d.year) === year && (scope ? scope.includes(Number(d.amiba_id)) : true));

  // 1. 公司总降本达成率
  const company = readAll('amiba_cost_target_company').find(r => Number(r.year) === year);
  const totalTarget = company ? n(company.total_cost_target) : 0;
  const totalSave = readAll('amiba_cost_improve').filter(p => Number(p.year) === year && p.status === '已完成' && (scope ? scope.includes(Number(p.amiba_id)) : true)).reduce((s2, p) => s2 + n(p.save_amount), 0);
  const achievement = totalTarget ? clamp(round(totalSave / totalTarget * 100, 1), 0, 150) : 0;

  // 2. 各阿米巴利润排行
  const profitByAmiba = {};
  details.forEach(d => {
    const p = calcProfit(d);
    if (!profitByAmiba[d.amiba_id]) profitByAmiba[d.amiba_id] = { amiba_id: d.amiba_id, amiba_name: d.amiba_name, profit: 0, income: 0 };
    profitByAmiba[d.amiba_id].profit += n(p.profit);
    profitByAmiba[d.amiba_id].income += n(p.income_total);
  });
  const profitRank = Object.values(profitByAmiba).map(x => ({ name: x.amiba_name, value: round(x.profit, 2) })).sort((a, b) => b.value - a.value).slice(0, 12);

  // 3. 月度成本趋势
  const trend = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, cost: 0, income: 0, profit: 0 }));
  details.forEach(d => {
    const m = clamp(Number(d.month) || 1, 1, 12);
    const p = calcProfit(d);
    trend[m - 1].cost += n(p.total_cost); trend[m - 1].income += n(p.income_total); trend[m - 1].profit += n(p.profit);
  });
  trend.forEach(t => { t.cost = round(t.cost, 2); t.income = round(t.income, 2); t.profit = round(t.profit, 2); });

  // 4. 成本结构占比
  const structure = { material_cost: 0, energy_cost: 0, labor_cost: 0, manage_fee: 0, internal_trade_cost: 0, other_cost: 0 };
  details.forEach(d => Object.keys(structure).forEach(k => { structure[k] += n(d[k]); }));
  Object.keys(structure).forEach(k => { structure[k] = round(structure[k], 2); });

  // 5. 降本改善成果累计
  const improveCumulative = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, save: 0 }));
  readAll('amiba_cost_improve').filter(p => Number(p.year) === year && p.status === '已完成' && (scope ? scope.includes(Number(p.amiba_id)) : true)).forEach(p => {
    const m = clamp(Number(p.month) || 1, 1, 12); improveCumulative[m - 1].save += n(p.save_amount);
  });
  let cum = 0;
  improveCumulative.forEach(t => { cum += t.save; t.save = round(cum, 2); });

  // 概览数字
  const overview = {
    amiba_count: scopedOrgs.filter(o => o.status !== '停用').length,
    pioneer_count: readAll('amiba_pioneer').filter(p => p.pioneer_status === '试点中').length,
    improve_count: readAll('amiba_cost_improve').filter(p => Number(p.year) === year).length,
    finished_improve: readAll('amiba_cost_improve').filter(p => Number(p.year) === year && p.status === '已完成').length,
    dispute_open: readAll('amiba_dispute').filter(d => d.status !== '已裁决' && d.status !== '已驳回').length,
    total_save: round(totalSave, 2),
    total_target: round(totalTarget, 2),
    achievement
  };

  res.json({
    overview,
    achievement_gauge: { value: achievement, target: totalTarget, real: totalSave },
    profit_rank: profitRank,
    cost_trend: trend,
    cost_structure: [
      { name: '材料成本', value: structure.material_cost },
      { name: '能耗成本', value: structure.energy_cost },
      { name: '人工成本', value: structure.labor_cost },
      { name: '管理费用', value: structure.manage_fee },
      { name: '内部交易', value: structure.internal_trade_cost },
      { name: '其他成本', value: structure.other_cost }
    ].filter(x => x.value > 0),
    improve_cumulative: improveCumulative
  });
});

// ============================================================
// 模块6：阿米巴核算表（经营会计报表 · 9 区块 22 行标准格式）
// 业务来源：企业《XXX部阿米巴核算表》1:1 数字化落地
// 全链路打通：
//   收入行 ← 定价清单(amiba_trade_price) + 交易明细(amiba_trade_detail) 自动归集
//   费用行 ← 手工录入 / 收支标准 / 物料库 / 改善项目
//   总工时 ← 组织架构人员(org_personnel)
//   计算：附加值=收入-费用；单位时间附加值=附加值/工时；净利润率；阶梯奖励；奖金池
// ============================================================
// 标准费用项模板（所有巴通用，CSV 第 8-14 行）
const EXPENSE_TEMPLATE = [
  { line_no: 8, item_name: '人工成本', formula: '员工工资、社保等总额' },
  { line_no: 9, item_name: '办公用品及耗材', formula: '纸、笔、墨盒等' },
  { line_no: 10, item_name: '通讯费', formula: '固定电话、手机、网络等' },
  { line_no: 11, item_name: '差旅费', formula: '出差、办事相关费用' },
  { line_no: 12, item_name: '招聘费', formula: '招聘平台年费、猎头费、招聘广告费等' },
  { line_no: 13, item_name: '培训费', formula: '课程版权费、讲师费等' },
  { line_no: 14, item_name: '其他费用', formula: '其他费用' }
];
// 阶梯奖励比例（CSV 第 21 行）：利润率 <10% →10%；10-20% →15%；≥20% →20%
function calcBonusRate(margin) {
  if (margin < 10) return 10;
  if (margin < 20) return 15;
  return 20;
}
function bonusRateDesc(rate) {
  return rate === 10 ? '利润率 <10% → 10%' : rate === 15 ? '10% ≤ 利润率 <20% → 15%' : '利润率 ≥20% → 20%';
}

// 从交易明细 + 定价清单自动归集收入行（按服务编号分组）
function buildRevenueLines(amibaId, year, month) {
  // 按定价编码升序（H01→H06 / SVC-001→SVC-00N），保证核算表收入行顺序与官方模板一致
  const prices = readAll('amiba_trade_price')
    .filter(p => Number(p.from_amiba_id) === amibaId)
    .slice()
    .sort((a, b) => String(a.product_code || a.material_code || '').localeCompare(String(b.product_code || b.material_code || ''), 'zh'));
  const trades = readAll('amiba_trade_detail').filter(d =>
    Number(d.from_amiba_id) === amibaId &&
    inYM(d.trade_date, year, month) &&
    ['已结算', '已确认', '已完成', '满7天', '培训完成', '操作完成', '服务完成', '交付确认', '检验完成', '验货通过', '资料提交', '验收通过'].includes(s(d.settle_status))
  );
  // 按服务编号分组
  const bySvc = {};
  trades.forEach(d => {
    const key = s(d.service_no) || '_其他';
    if (!bySvc[key]) bySvc[key] = { service_no: key, amount: 0, qty: 0, count: 0 };
    bySvc[key].amount += n(d.total_amount);
    bySvc[key].qty += n(d.quantity);
    bySvc[key].count++;
  });
  // 匹配定价清单名称
  prices.forEach(p => {
    const code = s(p.product_code || p.material_code);
    if (code && bySvc[code]) bySvc[code].name = p.product_name || p.material_name;
  });
  // 构造收入行（按定价清单顺序遍历，确保顺序与 CSV 模板一致：有交易的无交易的同序）
  let lineNo = 1;
  const lines = [];
  const usedCodes = new Set();
  // 第一遍：有交易的收入行
  prices.forEach(p => {
    const code = s(p.product_code || p.material_code);
    const b = code ? bySvc[code] : null;
    if (!b || !(b.amount > 0 || b.count > 0)) return;
    usedCodes.add(code);
    const method = s(p.price_method);
    const calcDesc = `${code}：${b.qty} ${p.unit || '次'} × 单价`;
    lines.push({
      section: '收入', line_no: lineNo++,
      item_name: p.product_name || p.material_name || code,
      formula: method ? (method + '  |  ' + calcDesc) : calcDesc,
      amount: round(b.amount, 2), service_no: code,
      quantity: b.qty, trade_count: b.count
    });
  });
  // 兜底：未匹配定价项的其他交易（service_no 不在定价清单）
  Object.values(bySvc).forEach(b => {
    if (usedCodes.has(b.service_no)) return;
    if (!(b.amount > 0 || b.count > 0)) return;
    usedCodes.add(b.service_no);
    lines.push({
      section: '收入', line_no: lineNo++,
      item_name: b.service_no === '_其他' ? '其他收入' : (b.name || b.service_no),
      formula: '交易明细汇总',
      amount: round(b.amount, 2), service_no: b.service_no === '_其他' ? '' : b.service_no,
      quantity: b.qty, trade_count: b.count
    });
  });
  // 第二遍：无交易的定价项作为空模板（formula 用 price_method，让用户看到计算说明）
  prices.forEach(p => {
    const code = s(p.product_code || p.material_code);
    if (code && !usedCodes.has(code)) {
      const method = s(p.price_method);
      lines.push({
        section: '收入', line_no: lineNo++,
        item_name: p.product_name || p.material_name || code,
        formula: method || (code + '（暂无交易）'),
        amount: 0, service_no: code, quantity: 0, trade_count: 0
      });
    }
  });
  return lines;
}

// 构造完整核算表（22 行标准格式）
function buildStatement(amibaId, year, month, existing) {
  const amiba = getTable('amiba_org').findById(amibaId);
  const amibaName = amiba ? amiba.amiba_name : '';
  // 收入行（自动归集，可被 existing 覆盖）
  const autoRev = buildRevenueLines(amibaId, year, month);
  let revLines;
  if (existing && existing.lines) {
    // 保留用户编辑过的收入金额，但更新交易笔数信息
    const existMap = {}; existing.lines.filter(l => l.section === '收入').forEach(l => { if (l.service_no) existMap[l.service_no] = l; });
    revLines = autoRev.map(r => existMap[r.service_no] && existMap[r.service_no].amount != null ? Object.assign(r, { amount: n(existMap[r.service_no].amount) }) : r);
  } else {
    revLines = autoRev;
  }
  const totalRevenue = round(revLines.reduce((s2, l) => s2 + n(l.amount), 0), 2);
  // 费用行（标准模板，可被 existing 覆盖）
  let expLines;
  if (existing && existing.lines) {
    const existExp = existing.lines.filter(l => l.section === '费用');
    if (existExp.length) {
      expLines = existExp.map((l, i) => ({ section: '费用', line_no: 8 + i, item_name: l.item_name, formula: l.formula || '', amount: n(l.amount) }));
    } else expLines = EXPENSE_TEMPLATE.map(t => Object.assign({}, t, { section: '费用', amount: 0 }));
  } else {
    expLines = EXPENSE_TEMPLATE.map(t => Object.assign({}, t, { section: '费用', amount: 0 }));
  }
  const totalExpense = round(expLines.reduce((s2, l) => s2 + n(l.amount), 0), 2);
  // 计算（CSV 第 16-22 行）
  const valueAdded = round(totalRevenue - totalExpense, 2);            // 三、经营附加值 = 7 - 15
  const totalHours = existing ? n(existing.total_hours) : 0;           // 四、总工时
  const valuePerHour = totalHours > 0 ? round(valueAdded / totalHours, 2) : 0; // 五、单位时间附加值
  const netProfit = valueAdded;                                        // 六、月度净利润 = 附加值
  const profitMargin = totalRevenue > 0 ? round(netProfit / totalRevenue * 100, 1) : 0; // 七、净利润率%
  const bonusRate = calcBonusRate(profitMargin);                       // 八、阶梯奖励比例（百分比：10/15/20）
  const bonusPool = netProfit > 0 ? round(netProfit * bonusRate / 100, 2) : 0; // 九、团队奖金池（亏损时为0）
  // 组装 22 行
  const lines = [];
  lines.push({ section: '标题', line_no: 0, item_name: '一、总收入', formula: '', amount: '', is_header: true });
  revLines.forEach(l => lines.push(l));
  lines.push({ section: '小计', line_no: 7, item_name: '总收入合计', formula: '= ' + revLines.map(l => l.line_no).join(' + '), amount: totalRevenue, is_subtotal: true });
  lines.push({ section: '标题', line_no: 0, item_name: '二、总费用', formula: '', amount: '', is_header: true });
  expLines.forEach(l => lines.push(l));
  lines.push({ section: '小计', line_no: 15, item_name: '总费用合计', formula: '= ' + expLines.map(l => l.line_no).join(' + '), amount: totalExpense, is_subtotal: true });
  lines.push({ section: '计算', line_no: 16, item_name: '三、经营附加值', formula: '= 总收入合计(7) - 总费用合计(15)', amount: valueAdded, is_calc: true });
  lines.push({ section: '计算', line_no: 17, item_name: '四、总工时（小时）', formula: '研发/工作所有员工当月工作总时长', amount: totalHours, is_input: true, field: 'total_hours' });
  lines.push({ section: '计算', line_no: 18, item_name: '五、单位时间附加值', formula: '= 经营附加值(16) / 总工时(17)', amount: valuePerHour, is_calc: true });
  lines.push({ section: '计算', line_no: 19, item_name: '六、月度净利润', formula: '= 经营附加值(16)', amount: netProfit, is_calc: true });
  lines.push({ section: '计算', line_no: 20, item_name: '七、净利润率', formula: '= 月度净利润(19) / 总收入合计(7)', amount: profitMargin, is_rate: true });
  lines.push({ section: '计算', line_no: 21, item_name: '八、阶梯奖励比例', formula: bonusRateDesc(bonusRate), amount: bonusRate, is_rate: true });
  lines.push({ section: '计算', line_no: 22, item_name: '九、团队奖金池', formula: '= 月度净利润(19) × 阶梯奖励比例(21)', amount: bonusPool, is_calc: true });
  return { amiba_id: amibaId, amiba_name: amibaName, year, month, lines, total_revenue: totalRevenue, total_expense: totalExpense, value_added: valueAdded, total_hours: totalHours, value_per_hour: valuePerHour, net_profit: netProfit, profit_margin: profitMargin, bonus_rate: bonusRate, bonus_pool: bonusPool };
}

// 核算表列表（汇总，不含行明细）
router.get('/statement', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const month = req.query.month ? Number(req.query.month) : null;
  const scope = scopeAmibaIds(req);
  let list = readAll('amiba_statement').filter(s => Number(s.year) === year);
  if (month !== null) list = list.filter(s => Number(s.month) === month);
  if (scope) list = list.filter(s => scope.includes(Number(s.amiba_id)));
  list = list.map(s => ({ id: s.id, amiba_id: s.amiba_id, amiba_name: s.amiba_name, year: s.year, month: s.month, total_revenue: s.total_revenue, total_expense: s.total_expense, value_added: s.value_added, total_hours: s.total_hours, value_per_hour: s.value_per_hour, net_profit: s.net_profit, profit_margin: s.profit_margin, bonus_rate: s.bonus_rate, bonus_pool: s.bonus_pool, status: s.status, source: s.source }))
    .sort((a, b) => (b.value_added || 0) - (a.value_added || 0));
  const summary = {
    count: list.length,
    total_revenue: round(list.reduce((s2, x) => s2 + n(x.total_revenue), 0), 2),
    total_expense: round(list.reduce((s2, x) => s2 + n(x.total_expense), 0), 2),
    total_value_added: round(list.reduce((s2, x) => s2 + n(x.value_added), 0), 2),
    total_bonus: round(list.reduce((s2, x) => s2 + n(x.bonus_pool), 0), 2),
    avg_margin: list.length ? round(list.reduce((s2, x) => s2 + n(x.profit_margin), 0) / list.length, 1) : 0
  };
  res.json(Object.assign({ data: list }, paginate(list, req, 200), { summary }));
});

// 核算报表树形汇总：按组织架构树状结构聚合（一级巴显示下级汇总；点击下钻二级巴）
function collectAmibaDescendants(rootId, allAmibas) {
  const out = [];
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    allAmibas.filter(a => Number(a.parent_id) === Number(cur)).forEach(child => {
      out.push(child);
      queue.push(child.id);
    });
  }
  return out;
}

function aggregateStatements(statements) {
  if (!statements || !statements.length) {
    return {
      count: 0, total_revenue: 0, total_expense: 0, value_added: 0,
      total_hours: 0, value_per_hour: 0, net_profit: 0, profit_margin: 0,
      bonus_pool: 0
    };
  }
  const total_revenue = round(statements.reduce((s2, x) => s2 + n(x.total_revenue), 0), 2);
  const total_expense = round(statements.reduce((s2, x) => s2 + n(x.total_expense), 0), 2);
  const value_added = round(statements.reduce((s2, x) => s2 + n(x.value_added), 0), 2);
  const total_hours = round(statements.reduce((s2, x) => s2 + n(x.total_hours), 0), 1);
  const net_profit = round(statements.reduce((s2, x) => s2 + n(x.net_profit), 0), 2);
  const bonus_pool = round(statements.reduce((s2, x) => s2 + n(x.bonus_pool), 0), 2);
  const value_per_hour = total_hours ? round(value_added / total_hours, 2) : 0;
  const profit_margin = total_revenue ? round(net_profit / total_revenue * 100, 1) : 0;
  return { count: statements.length, total_revenue, total_expense, value_added, total_hours, value_per_hour, net_profit, profit_margin, bonus_pool };
}

router.get('/statement/tree', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const month = req.query.month ? Number(req.query.month) : null;
  const rootId = n(req.query.amiba_id, 0); // 指定时：返回该节点及其下级；未指定：返回所有一级巴
  const scope = scopeAmibaIds(req);
  const allAmibas = readAll('amiba_org').filter(a => a.status !== '停用');
  const allStatements = readAll('amiba_statement').filter(s => Number(s.year) === year && (month === null || Number(s.month) === month));
  if (scope) {
    allAmibas = allAmibas.filter(a => scope.includes(Number(a.id)) || scope.includes(Number(a.parent_id)));
  }

  // 决定根节点集合
  let roots;
  if (rootId) {
    const root = allAmibas.find(a => Number(a.id) === rootId);
    if (!root) return res.status(404).json({ error: '巴单元不存在' });
    roots = [root];
  } else {
    roots = allAmibas.filter(a => Number(a.amiba_level) === 1).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  }

  function buildNode(node) {
    const descendants = collectAmibaDescendants(node.id, allAmibas);
    // 自身 + 所有下级的声明
    const selfAndDescIds = [node.id, ...descendants.map(d => d.id)];
    const relatedStatements = allStatements.filter(s => selfAndDescIds.includes(Number(s.amiba_id)));
    const agg = aggregateStatements(relatedStatements);
    const children = descendants.map(buildNode);
    return {
      id: node.id,
      amiba_id: node.id,
      amiba_name: node.amiba_name,
      amiba_type: node.amiba_type,
      amiba_level: node.amiba_level,
      charge_user_name: node.charge_user_name,
      department: node.department,
      status: node.status,
      // 自身独立核算（仅本节点 amiba_statement 记录）
      self: allStatements.find(s => Number(s.amiba_id) === Number(node.id)) || null,
      // 包含自身的树汇总
      aggregate: agg,
      child_count: descendants.length,
      has_children: descendants.length > 0,
      children
    };
  }

  const tree = roots.map(buildNode);
  const flatList = [];
  (function flatten(nodes, depth) {
    nodes.forEach(n => {
      flatList.push(Object.assign({}, n, { _depth: depth, _id_path: n.amiba_name }));
      if (n.children && n.children.length) flatten(n.children, depth + 1);
    });
  })(tree, 0);

  // 整体汇总（所有可见节点聚合）
  const grand = aggregateStatements(allStatements.filter(s => flatList.some(n => n.id === Number(s.amiba_id))));

  res.json({
    code: 0,
    year, month,
    summary: grand,
    roots: tree,
    flat: flatList
  });
});

// 核算表明细（含 22 行）
router.get('/statement/detail', requirePerm(PERM_VIEW), (req, res) => {
  const amibaId = n(req.query.amiba_id);
  const year = n(req.query.year, currentYear());
  const month = n(req.query.month, currentMonth());
  if (!amibaId) return res.status(400).json({ error: '请选择巴单元' });
  const existing = readAll('amiba_statement').find(s => Number(s.amiba_id) === amibaId && Number(s.year) === year && Number(s.month) === month);
  // 如果已保存则返回保存版本（但重新计算交易笔数），否则实时生成
  const stmt = buildStatement(amibaId, year, month, existing);
  if (existing) { stmt.id = existing.id; stmt.status = existing.status; stmt.source = existing.source; }
  else { stmt.status = '草稿'; stmt.source = '实时生成'; }
  res.json(stmt);
});

// 年度总表（22行×12月，对标Excel「人事行政-总表」格式）
router.get('/statement/yearly', requirePerm(PERM_VIEW), (req, res) => {
  const amibaId = n(req.query.amiba_id);
  const year = n(req.query.year, currentYear());
  if (!amibaId) return res.status(400).json({ error: '请选择巴单元' });
  // 12个月数据
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const existing = readAll('amiba_statement').find(s => Number(s.amiba_id) === amibaId && Number(s.year) === year && Number(s.month) === m);
    months.push(buildStatement(amibaId, year, m, existing));
  }
  // 以第一个月lines为模板构建22行×12月矩阵
  const template = months[0].lines;
  const rows = template.map((line, idx) => {
    const row = {
      item_name: line.item_name, line_no: line.line_no, formula: line.formula,
      section: line.section, is_header: line.is_header, is_subtotal: line.is_subtotal,
      is_calc: line.is_calc, is_rate: line.is_rate, is_input: line.is_input, field: line.field,
      total: 0, months: []
    };
    if (line.is_header) {
      row.total = '';
      months.forEach(() => row.months.push(''));
    } else if (line.is_rate) {
      // 比率行：合计取加权平均
      let sum = 0, cnt = 0;
      months.forEach(stmt => {
        const v = stmt.lines[idx] ? n(stmt.lines[idx].amount) : 0;
        row.months.push(v);
        if (v > 0) { sum += v; cnt++; }
      });
      row.total = cnt > 0 ? round(sum / cnt, 1) : 0;
    } else {
      let sum = 0;
      months.forEach(stmt => {
        const v = stmt.lines[idx] ? n(stmt.lines[idx].amount) : 0;
        row.months.push(round(v, 2));
        sum += v;
      });
      row.total = round(sum, 2);
    }
    return row;
  });
  res.json({ amiba_id: amibaId, amiba_name: months[0].amiba_name, year, rows, month_columns: [1,2,3,4,5,6,7,8,9,10,11,12] });
});

// 月度表（22行×31日，对标Excel「人事行政-X月」格式）
router.get('/statement/monthly', requirePerm(PERM_VIEW), (req, res) => {
  const amibaId = n(req.query.amiba_id);
  const year = n(req.query.year, currentYear());
  const month = n(req.query.month, currentMonth());
  if (!amibaId) return res.status(400).json({ error: '请选择巴单元' });
  const existing = readAll('amiba_statement').find(s => Number(s.amiba_id) === amibaId && Number(s.year) === year && Number(s.month) === month);
  const stmt = buildStatement(amibaId, year, month, existing);
  // 按天归集交易明细收入
  const trades = readAll('amiba_trade_detail').filter(d =>
    Number(d.from_amiba_id) === amibaId &&
    inYM(d.trade_date, year, month) &&
    ['已结算','已确认','已完成','满7天','培训完成','操作完成','服务完成','交付确认','检验完成','验货通过','资料提交','验收通过'].includes(s(d.settle_status))
  );
  const byDay = {};
  trades.forEach(d => {
    const day = Number(String(d.trade_date || '').substring(8, 10));
    if (!day) return;
    if (!byDay[day]) byDay[day] = {};
    const svc = s(d.service_no) || '_其他';
    byDay[day][svc] = (byDay[day][svc] || 0) + n(d.total_amount);
  });
  const daysInMonth = new Date(year, month, 0).getDate();
  const rows = stmt.lines.map((line) => {
    const row = {
      item_name: line.item_name, line_no: line.line_no, formula: line.formula,
      section: line.section, is_header: line.is_header, is_subtotal: line.is_subtotal,
      is_calc: line.is_calc, is_rate: line.is_rate, is_input: line.is_input, field: line.field,
      total: line.amount, days: []
    };
    if (line.is_header) {
      for (let d = 1; d <= 31; d++) row.days.push('');
    } else if (line.section === '收入' && line.service_no) {
      for (let d = 1; d <= 31; d++) {
        const v = (byDay[d] && byDay[d][line.service_no]) || 0;
        row.days.push(v > 0 ? round(v, 2) : '');
      }
    } else {
      for (let d = 1; d <= 31; d++) row.days.push('');
    }
    return row;
  });
  res.json({ amiba_id: amibaId, amiba_name: stmt.amiba_name, year, month, rows, day_columns: Array.from({length:31},(_,i)=>i+1), days_in_month: daysInMonth });
});

// 数据穿透：查询某巴某月/某日/某服务编号的交易明细
router.get('/statement/drill', requirePerm(PERM_VIEW), (req, res) => {
  const amibaId = n(req.query.amiba_id);
  const year = n(req.query.year);
  const month = n(req.query.month);
  const day = req.query.day ? n(req.query.day) : 0;
  const serviceNo = s(req.query.service_no);
  if (!amibaId) return res.status(400).json({ error: '请选择巴单元' });
  let trades = readAll('amiba_trade_detail').filter(d =>
    Number(d.from_amiba_id) === amibaId &&
    inYM(d.trade_date, year, month) &&
    ['已结算','已确认','已完成','满7天','培训完成','操作完成','服务完成','交付确认','检验完成','验货通过','资料提交','验收通过'].includes(s(d.settle_status))
  );
  if (day) trades = trades.filter(d => Number(String(d.trade_date || '').substring(8, 10)) === day);
  if (serviceNo) trades = trades.filter(d => s(d.service_no) === serviceNo);
  trades.sort((a, b) => String(a.trade_date || '').localeCompare(String(b.trade_date || '')) || String(a.trade_no || '').localeCompare(String(b.trade_no || '')));
  const summary = {
    count: trades.length,
    total_amount: round(trades.reduce((s, d) => s + n(d.total_amount), 0), 2),
    total_qty: round(trades.reduce((s, d) => s + n(d.quantity), 0), 2)
  };
  res.json({
    amiba_id: amibaId, year, month, day, service_no: serviceNo,
    summary,
    data: trades.map(d => ({
      trade_no: d.trade_no, trade_date: d.trade_date,
      from_amiba: d.from_amiba, to_amiba: d.to_amiba,
      service_no: d.service_no, product_name: d.product_name,
      quantity: d.quantity, unit: d.unit, unit_price: d.unit_price,
      total_amount: d.total_amount, settle_status: d.settle_status,
      creator_person: d.creator_person, remarks: d.remarks
    }))
  });
});

// 保存核算表（手工调整费用/工时后保存）
router.post('/statement', requirePerm(PERM_EDIT), async (req, res) => {
  try {
    const amibaId = n(req.body.amiba_id);
    const year = n(req.body.year, currentYear());
    const month = n(req.body.month, currentMonth());
    if (!amibaId) return res.status(400).json({ error: '请选择巴单元' });
    const table = getTable('amiba_statement');
    const existing = readAll('amiba_statement').find(s => Number(s.amiba_id) === amibaId && Number(s.year) === year && Number(s.month) === month);
    // 以传入的 lines 为准重新计算
    const stmt = buildStatement(amibaId, year, month, { lines: req.body.lines, total_hours: n(req.body.total_hours) });
    stmt.status = s(req.body.status, existing ? existing.status : '草稿');
    stmt.source = '手工确认';
    if (existing) {
      await table.update(existing.id, Object.assign(stmt, { updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(existing.id) });
    } else {
      const r = await table.insert(Object.assign(stmt, { created_at: now(), updated_at: now() }));
      res.json({ message: '保存成功', data: table.findById(r.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 一键生成某巴核算表（从交易明细+定价清单自动归集收入）
router.post('/statement/generate', requirePerm(PERM_CALC), async (req, res) => {
  try {
    const amibaId = n(req.body.amiba_id);
    const year = n(req.body.year, currentYear());
    const month = n(req.body.month, currentMonth());
    if (!amibaId) return res.status(400).json({ error: '请选择巴单元' });
    const table = getTable('amiba_statement');
    const existing = readAll('amiba_statement').find(s => Number(s.amiba_id) === amibaId && Number(s.year) === year && Number(s.month) === month);
    // 保留已有的费用/工时数据
    const keep = existing ? { lines: existing.lines, total_hours: existing.total_hours } : null;
    const stmt = buildStatement(amibaId, year, month, keep);
    stmt.status = existing ? existing.status : '草稿';
    stmt.source = '自动生成';
    if (existing) {
      await table.update(existing.id, Object.assign(stmt, { updated_at: now() }));
      res.json({ message: '生成完成', data: table.findById(existing.id) });
    } else {
      const r = await table.insert(Object.assign(stmt, { created_at: now(), updated_at: now() }));
      res.json({ message: '生成完成', data: table.findById(r.lastID) });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 一键生成所有巴的核算表
router.post('/statement/generate-all', requirePerm(PERM_CALC), async (req, res) => {
  try {
    const year = n(req.body.year, currentYear());
    const month = n(req.body.month, currentMonth());
    const scope = scopeAmibaIds(req);
    let orgs = readAll('amiba_org').filter(o => o.status !== '停用');
    if (scope) orgs = orgs.filter(o => scope.includes(o.id));
    const table = getTable('amiba_statement');
    let created = 0;
    for (const o of orgs) {
      const existing = readAll('amiba_statement').find(s => Number(s.amiba_id) === o.id && Number(s.year) === year && Number(s.month) === month);
      const keep = existing ? { lines: existing.lines, total_hours: existing.total_hours } : null;
      const stmt = buildStatement(o.id, year, month, keep);
      stmt.status = existing ? existing.status : '草稿';
      stmt.source = '自动生成';
      if (existing) { await table.update(existing.id, Object.assign(stmt, { updated_at: now() })); }
      else { await table.insert(Object.assign(stmt, { created_at: now(), updated_at: now() })); }
      created++;
    }
    res.json({ message: `已生成 ${created} 个巴的核算表（${year}年${month}月）`, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 核算表导出（多 Sheet：每巴一个 Sheet，标准 9 区块 22 行格式）
router.get('/statement/export', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const month = req.query.month ? Number(req.query.month) : null;
  const scope = scopeAmibaIds(req);
  let orgs = readAll('amiba_org').filter(o => o.status !== '停用');
  if (scope) orgs = orgs.filter(o => scope.includes(o.id));
  const wb = XLSX.utils.book_new();
  let sheetCount = 0;
  for (const o of orgs) {
    const existing = readAll('amiba_statement').find(s => Number(s.amiba_id) === o.id && Number(s.year) === year && (month === null || Number(s.month) === month));
    const stmt = buildStatement(o.id, year, month || currentMonth(), existing);
    // 组装 AOA：项目/行次/计算公式/金额
    const rows = [
      [`${o.amiba_name}阿米巴核算表`, '', `${year}年${month || currentMonth()}月`],
      ['项目', '行次', '计算公式/说明', '金额']
    ];
    stmt.lines.forEach(l => {
      const indent = l.section === '收入' || l.section === '费用' ? '  ' : '';
      const amt = l.is_rate ? (l.amount !== '' && l.amount != null ? (Number(l.amount) + '%') : '') : (l.amount !== '' && l.amount != null ? n(l.amount) : '');
      rows.push([indent + (l.item_name || ''), l.line_no || '', l.formula || '', amt]);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 28 }, { wch: 6 }, { wch: 40 }, { wch: 14 }];
    // Sheet 名最多 31 字符，去掉"巴"
    let sn = o.amiba_name.replace(/巴$/, '').substring(0, 28);
    XLSX.utils.book_append_sheet(wb, ws, sn);
    sheetCount++;
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent('阿米巴核算表_' + year + (month ? '_' + month + '月' : '') + '.xlsx')}"`);
  res.send(buf);
});

// ============================================================
// 通用表格导出 / 模板 / 导入
// 每个模块均提供：导出Excel / 下载模板 / (可导入模块)批量导入
// ============================================================
function buildXlsx(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers].concat(rows));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function sendXlsx(res, headers, rows, filename) {
  const buf = buildXlsx(headers, rows);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(buf);
}
function sendXlsxTemplate(res, headers, exampleRows, filename) {
  const rows = exampleRows && exampleRows.length ? [headers].concat(exampleRows) : [headers];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // 空行预留 5 行便于填写
  for (let i = 0; i < 5; i++) ws.addRow ? ws.addRow([]) : XLSX.utils.sheet_add_aoa(ws, [[]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(buf);
}
function parseSheetRows(fileBuffer, ext) {
  const wb = ext === '.csv' || ext === '.tsv'
    ? XLSX.read(fileBuffer, { type: 'buffer', raw: true, FS: ext === '.tsv' ? '\t' : ',', codepage: 65001 })
    : XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

// ---- 1. 降本目标：导出 + 模板 + 导入 ----
router.get('/target/export', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const list = readAll('amiba_cost_target').filter(t => Number(t.year) === year)
    .sort((a, b) => (Number(a.month) || 0) - (Number(b.month) || 0) || String(a.amiba_name).localeCompare(String(b.amiba_name), 'zh'));
  const headers = ['巴单元', '月份', '目标额', '实际节约', '达成率%', '权重%', '责任人', '责任状', '状态'];
  const rows = list.map(t => {
    const save = readAll('amiba_cost_improve').filter(p => Number(p.amiba_id) === Number(t.amiba_id) && Number(p.year) === Number(t.year) && (Number(t.month) === 0 || Number(p.month) === Number(t.month)) && p.status === '已完成').reduce((s, p) => s + n(p.save_amount), 0);
    const real = n(t.real_amount) || save;
    return [t.amiba_name, t.month, n(t.target_amount), round(real, 2), round(real && t.target_amount ? real / t.target_amount * 100 : 0, 1), n(t.target_rate), t.duty_user_name || '', t.sign_status || '', t.status || ''];
  });
  // 合计行
  const sumT = rows.reduce((s, r) => s + (Number(r[2]) || 0), 0);
  const sumR = rows.reduce((s, r) => s + (Number(r[3]) || 0), 0);
  rows.push(['合计', '', round(sumT, 2), round(sumR, 2), sumT ? round(sumR / sumT * 100, 1) : 0, '', '', '', '']);
  sendXlsx(res, headers, rows, `阿米巴降本目标_${year}.xlsx`);
});

router.get('/target/template', requirePerm(PERM_VIEW), (req, res) => {
  const headers = ['巴单元', '月份', '目标额', '实际节约', '权重%', '责任人', '状态'];
  const examples = [
    ['生产制造巴', 1, 50000, 0, 30, '生产总监', '待签'],
    ['研发技术巴', 1, 30000, 0, 20, '研发经理', '待签'],
    ['', 0, 0, 0, 0, '', '待签']
  ];
  sendXlsxTemplate(res, headers, examples, `阿米巴降本目标模板.xlsx`);
});

router.post('/target/import', tradeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const rawRows = parseSheetRows(req.file.buffer, ext);
    if (!rawRows.length) return res.status(400).json({ error: '文件无数据' });
    const fieldMap = { '巴单元': 'amiba_name', '巴名称': 'amiba_name', '部门': 'amiba_name', '月份': 'month', '目标额': 'target_amount', '目标': 'target_amount', '实际节约': 'real_amount', '实际': 'real_amount', '权重': 'target_rate', '权重%': 'target_rate', '责任人': 'duty_user_name', '责任状': 'sign_status', '状态': 'status' };
    const normMap = {}; Object.keys(fieldMap).forEach(k => { normMap[normalizeHeader(k)] = fieldMap[k]; });
    const table = getTable('amiba_cost_target');
    const existing = readAll('amiba_cost_target');
    let imp = 0, skip = 0; const errs = [];
    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i]; const row = {}; Object.keys(raw).forEach(h => { const f = normMap[normalizeHeader(h)]; if (f) row[f] = raw[h]; });
      if (!Object.values(row).some(v => s(v))) { skip++; continue; }
      const amibaName = s(row.amiba_name); if (!amibaName) { skip++; errs.push({ row: i + 2, errors: ['巴单元为空'] }); continue; }
      const amiba = ensureAmibaByName(amibaName);
      const year = n(req.body.year, currentYear());
      const month = Number(row.month) || 0;
      const dup = existing.find(t => Number(t.amiba_id) === amiba.id && Number(t.year) === year && Number(t.month) === month);
      const payload = { amiba_id: amiba.id, amiba_name: amiba.name, year, month, target_amount: n(row.target_amount), real_amount: n(row.real_amount), target_rate: n(row.target_rate), duty_user_name: s(row.duty_user_name), sign_status: s(row.sign_status, ''), status: s(row.status, '待签'), updated_at: now() };
      if (dup) { await table.update(dup.id, payload); } else { await table.insert(Object.assign(payload, { created_at: now() })); }
      imp++;
    }
    table._invalidate();
    res.json({ message: `目标导入完成：成功 ${imp} 条，跳过 ${skip} 条`, imported: imp, skipped: skip, errors: errs.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: '导入失败: ' + e.message }); }
});

// ---- 2. 经营核算：导出 ----
router.get('/account/export', requirePerm(PERM_VIEW), (req, res) => {
  const year = n(req.query.year, currentYear());
  const month = req.query.month ? Number(req.query.month) : null;
  let list = readAll('amiba_account_detail').filter(d => Number(d.year) === year);
  if (month !== null) list = list.filter(d => Number(d.month) === month);
  list = list.sort((a, b) => Number(a.month) - Number(b.month) || String(a.amiba_name).localeCompare(String(b.amiba_name), 'zh'));
  const headers = ['巴单元', '月份', '收入', '材料成本', '能耗成本', '人工成本', '管理费用', '内部交易成本', '其他成本', '总成本', '利润', '利润率%', '单位成本', '本期节约', '来源'];
  const rows = list.map(d => [d.amiba_name, d.month, n(d.income_total), n(d.material_cost), n(d.energy_cost), n(d.labor_cost), n(d.manage_fee), n(d.internal_trade_cost), n(d.other_cost), n(d.total_cost), n(d.profit), n(d.profit_rate), n(d.unit_cost), n(d.save_amount), d.source || '']);
  // 合计
  const tot = (i) => round(rows.reduce((s, r) => s + (Number(r[i]) || 0), 0), 2);
  rows.push(['合计', '', tot(2), tot(3), tot(4), tot(5), tot(6), tot(7), tot(8), tot(9), tot(10), '', '', tot(13), '']);
  sendXlsx(res, headers, rows, `阿米巴经营核算_${year}${month ? '_' + month + '月' : ''}.xlsx`);
});

// ---- 3. 内部定价：导出 + 模板 + 导入 ----
router.get('/price/export', requirePerm(PERM_VIEW), (req, res) => {
  const list = readAll('amiba_trade_price').sort((a, b) => String(a.product_code || '').localeCompare(String(b.product_code || '')));
  const headers = ['编号', '服务/产品名称', '提供方巴', '接收方巴', '基数(物料单价)', '系数', '内部单价', '单位', '定价方式', '结算条件', '状态', '审批', '生效日期'];
  const rows = list.map(p => [p.material_code || p.product_code, p.material_name || p.product_name, p.from_amiba_name, p.to_amiba_name, n(p.base_price), n(p.coefficient), n(p.trade_price), p.unit || '', p.price_method || '', p.settle_condition || '', p.price_status || '', p.audit_status || '', p.effect_time || '']);
  sendXlsx(res, headers, rows, `阿米巴内部定价_${now().substring(0,10)}.xlsx`);
});
router.get('/price/template', requirePerm(PERM_VIEW), (req, res) => {
  const headers = ['编号', '服务/产品名称', '提供方巴', '接收方巴', '基数', '系数', '单位', '定价方式', '结算条件'];
  const examples = [
    ['Q01', '来料检验收入', '品质巴', '采购', 5, 1, '批次', '按批次', '检验完成'],
    ['R03', '询价收入', '研发巴', '销售巴', 100, 1, '次', '固定费', '交付确认']
  ];
  sendXlsxTemplate(res, headers, examples, `阿米巴内部定价模板.xlsx`);
});

// 内部定价导入：按 编号+提供方+接收方 唯一键去重；自动建巴；自动计算 trade_price = base × 系数
router.post('/price/import', tradeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const rawRows = parseSheetRows(req.file.buffer, ext);
    if (!rawRows.length) return res.status(400).json({ error: '文件无数据' });
    const fieldMap = {
      '编号': 'product_code', '代码': 'product_code', '服务编号': 'product_code', '物料编号': 'product_code',
      '服务/产品名称': 'product_name', '服务产品': 'product_name', '产品名称': 'product_name', '物料名称': 'product_name', '名称': 'product_name',
      '提供方巴': 'from_amiba', '提供方': 'from_amiba', '供方': 'from_amiba',
      '接收方巴': 'to_amiba', '支付方巴': 'to_amiba', '接收方': 'to_amiba', '需方': 'to_amiba',
      '基数': 'base_price', '物料单价': 'base_price', '基数(物料单价)': 'base_price',
      '系数': 'coefficient', '单位': 'unit', '计量单位': 'unit',
      '定价方式': 'price_method', '方式': 'price_method',
      '结算条件': 'settle_condition', '条件': 'settle_condition',
      '状态': 'price_status', '审批': 'audit_status', '生效日期': 'effect_time'
    };
    const normMap = {};
    Object.keys(fieldMap).forEach(k => { normMap[normalizeHeader(k)] = fieldMap[k]; });
    const table = getTable('amiba_trade_price');
    const existing = readAll('amiba_trade_price');
    const dupKey = (code, fromId, toId, fromName, toName) =>
      code + '|' + (fromId || 0) + '|' + (toId || 0) + '|' + (fromName || '') + '|' + (toName || '');
    const existingKeys = new Set(existing.map(p => dupKey(p.product_code, p.from_amiba_id, p.to_amiba_id, p.from_amiba_name, p.to_amiba_name)));
    let imp = 0, upd = 0, skip = 0;
    const errs = [];
    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i];
      const row = {};
      Object.keys(raw).forEach(h => { const f = normMap[normalizeHeader(h)]; if (f) row[f] = raw[h]; });
      // 跳过完全空行
      if (!Object.values(row).some(v => s(v))) { skip++; continue; }
      const code = s(row.product_code);
      const pname = s(row.product_name);
      const fromName = s(row.from_amiba);
      const toName = s(row.to_amiba);
      // 必须有编号或名称之一
      if (!code && !pname) { skip++; errs.push({ row: i + 2, errors: ['编号和服务名称均为空'] }); continue; }
      // 自动建巴（含 / 的复合支付方/外部对象视为分组字符串不建巴）
      const isCompound = (v) => !v || /[\/（）()]/.test(v) || /^(公司|各巴|用人巴|参训巴|采购)$/.test(v);
      const from = !isCompound(fromName) ? await ensureAmibaByName(fromName) : { id: 0, name: fromName };
      const to = !isCompound(toName) ? await ensureAmibaByName(toName) : { id: 0, name: toName };
      const basePrice = n(row.base_price);
      const coefficient = n(row.coefficient);
      // 计算内部单价：base × 系数
      let tradePrice = 0;
      if (basePrice > 0) tradePrice = round(basePrice * (coefficient || 1), 4);
      const priceNum = tradePrice || basePrice;
      // 去重：编号 + 提供方 + 接收方
      const key = dupKey(code, from.id, to.id, from.name, toName);
      const payload = {
        material_id: 0, material_code: code, product_code: code,
        material_name: pname, product_name: pname,
        from_amiba_id: from.id, from_amiba_name: from.name || fromName,
        to_amiba_id: to.id, to_amiba_name: to.name || toName,
        base_price: round(basePrice, 4),
        coefficient: coefficient || (basePrice && tradePrice ? round(tradePrice / basePrice, 4) : 0),
        trade_price: round(tradePrice || basePrice, 4),
        unit: s(row.unit) || '次',
        price_method: s(row.price_method),
        settle_condition: s(row.settle_condition),
        price_status: s(row.price_status) || (priceNum > 0 ? '已生效' : '待审核'),
        audit_status: s(row.audit_status) || (priceNum > 0 ? '已通过' : '待审核'),
        effect_time: excelDate(row.effect_time) || now().substring(0, 10),
        updated_at: now()
      };
      // 已有同 编号+方→方 记录：更新；否则新增
      const exist = existing.find(p => dupKey(p.product_code, p.from_amiba_id, p.to_amiba_id, p.from_amiba_name, p.to_amiba_name) === key);
      try {
        if (exist) { await table.update(exist.id, payload); upd++; }
        else { await table.insert(Object.assign(payload, { created_at: now() })); existingKeys.add(key); imp++; }
      } catch (e) { skip++; errs.push({ row: i + 2, errors: [e.message] }); }
    }
    table._invalidate();
    res.json({ message: `内部定价导入完成：新增 ${imp} 条，更新 ${upd} 条，跳过 ${skip} 条`, imported: imp, updated: upd, skipped: skip, errors: errs.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: '导入失败: ' + e.message }); }
});

// ---- 4. 部门收支标准：导出 + 模板 + 导入 ----
router.get('/standard/export', requirePerm(PERM_VIEW), (req, res) => {
  const year = req.query.year ? Number(req.query.year) : null;
  let list = readAll('amiba_dept_standard');
  if (year !== null) list = list.filter(r => Number(r.year) === year || Number(r.year) === 0);
  list = list.sort((a, b) => String(a.amiba_name).localeCompare(String(b.amiba_name), 'zh') || (a.direction || '').localeCompare(b.direction || ''));
  const headers = ['部门(巴)', '方向', '物料代码', '物料/项目名称', '单位', '基数(物料单价)', '系数', '标准价', '年度', '标准数量', '标准金额', '状态', '备注'];
  const rows = list.map(r => [r.amiba_name, r.direction, r.material_code, r.material_name || r.item_name, r.unit, n(r.base_price), n(r.coefficient), n(r.standard_price), r.year, n(r.quantity_std), n(r.amount_std), r.status || '', r.remarks || '']);
  const sum = (i) => round(rows.reduce((s, r) => s + (Number(r[i]) || 0), 0), 2);
  rows.push(['合计', '', '', '', '', '', '', '', '', '', sum(10), '', '']);
  sendXlsx(res, headers, rows, `阿米巴部门收支标准_${year || '全部'}.xlsx`);
});
router.get('/standard/template', requirePerm(PERM_VIEW), (req, res) => {
  const headers = ['部门(巴)', '方向', '物料代码', '物料/项目名称', '单位', '基数', '系数', '年度', '标准数量', '状态', '备注'];
  const examples = [
    ['生产制造巴', '支出', 'LED-MOD-01', 'LED光源模组', '个', 22, 1.27, currentYear(), 1000, '启用', '基数取物料库单价'],
    ['LED光源研发巴', '收入', 'LED-MOD-01', 'LED光源模组供货', '个', 22, 1.27, currentYear(), 1000, '启用', '标准价=基数×系数']
  ];
  sendXlsxTemplate(res, headers, examples, `阿米巴部门收支标准模板.xlsx`);
});
router.post('/standard/import', tradeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const rawRows = parseSheetRows(req.file.buffer, ext);
    if (!rawRows.length) return res.status(400).json({ error: '文件无数据' });
    const fieldMap = { '部门': 'amiba_name', '巴': 'amiba_name', '巴单元': 'amiba_name', '方向': 'direction', '物料代码': 'material_code', '代码': 'material_code', '物料': 'material_name', '物料名称': 'material_name', '项目': 'item_name', '项目名称': 'item_name', '单位': 'unit', '基数': 'base_price', '物料单价': 'base_price', '系数': 'coefficient', '标准价': 'standard_price', '年度': 'year', '年份': 'year', '标准数量': 'quantity_std', '数量': 'quantity_std', '标准金额': 'amount_std', '金额': 'amount_std', '状态': 'status', '备注': 'remarks' };
    const normMap = {}; Object.keys(fieldMap).forEach(k => { normMap[normalizeHeader(k)] = fieldMap[k]; });
    const table = getTable('amiba_dept_standard');
    let imp = 0, skip = 0; const errs = [];
    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i]; const row = {}; Object.keys(raw).forEach(h => { const f = normMap[normalizeHeader(h)]; if (f) row[f] = raw[h]; });
      if (!Object.values(row).some(v => s(v))) { skip++; continue; }
      const amibaName = s(row.amiba_name); if (!amibaName) { skip++; errs.push({ row: i + 2, errors: ['部门为空'] }); continue; }
      const amiba = await ensureAmibaByName(amibaName);
      const direction = ['收入', '支出'].includes(s(row.direction)) ? s(row.direction) : '支出';
      const data = deptStandardPayload(Object.assign({}, row, { amiba_id: amiba.id, amiba_name: amiba.name, direction }), null);
      await table.insert(Object.assign(data, { created_at: now(), updated_at: now() }));
      imp++;
    }
    table._invalidate();
    res.json({ message: `收支标准导入完成：成功 ${imp} 条，跳过 ${skip} 条`, imported: imp, skipped: skip, errors: errs.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: '导入失败: ' + e.message }); }
});

// ---- 5. 价值总表：导出(部门+个人双 Sheet) ----
router.get('/value/export', requirePerm(PERM_VIEW), async (req, res) => {
  const year = n(req.query.year, currentYear());
  const month = req.query.month ? Number(req.query.month) : null;
  const settled = s(req.query.settled) === '1';
  let list = readAll('amiba_trade_detail');
  if (year) list = list.filter(d => /^\d{4}/.test(d.trade_date || '') && Number((d.trade_date || '').substring(0, 4)) === year);
  if (month) list = list.filter(d => Number((d.trade_date || '').substring(5, 7)) === month);
  if (settled) list = list.filter(d => ['已结算', '已确认', '已完成'].includes(s(d.settle_status)));
  const byDept = {}; const byPerson = {};
  list.forEach(d => {
    const amt = n(d.total_amount);
    if (d.from_amiba_id) { const k = d.from_amiba_id; byDept[k] = byDept[k] || { amiba_id: k, amiba_name: d.from_amiba, provide: 0, receive: 0, pc: 0, rc: 0 }; byDept[k].provide += amt; byDept[k].pc++; }
    if (d.to_amiba_id) { const k = d.to_amiba_id; byDept[k] = byDept[k] || { amiba_id: k, amiba_name: d.to_amiba, provide: 0, receive: 0, pc: 0, rc: 0 }; byDept[k].receive += amt; byDept[k].rc++; }
    const person = s(d.creator_person);
    if (person) { byPerson[person] = byPerson[person] || { creator_person: person, amiba_name: d.from_amiba || '', create: 0, handle: 0, count: 0 }; if (d.from_amiba_id) byPerson[person].create += amt; else byPerson[person].handle += amt; byPerson[person].count++; }
  });
  const deptHeaders = ['部门(巴)', '提供价值(创造)', '提供笔数', '接收价值(占用)', '接收笔数', '净创造价值'];
  const deptRows = Object.values(byDept).map(x => [x.amiba_name, round(x.provide, 2), x.pc, round(x.receive, 2), x.rc, round(x.provide - x.receive, 2)]).sort((a, b) => (b[5] || 0) - (a[5] || 0));
  const personHeaders = ['经办人', '所属巴', '创造价值', '处理价值', '交易笔数'];
  const personRows = Object.values(byPerson).map(x => [x.creator_person, x.amiba_name, round(x.create, 2), round(x.handle, 2), x.count]).sort((a, b) => (b[2] || 0) - (a[2] || 0));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([deptHeaders].concat(deptRows)), '部门价值');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([personHeaders].concat(personRows)), '个人价值');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent('阿米巴价值总表_' + year + (month ? '_' + month + '月' : '') + '.xlsx')}"`);
  res.send(buf);
});

// ---- 6. 改善项目：导出 + 模板 + 导入 ----
router.get('/improve/export', requirePerm(PERM_VIEW), (req, res) => {
  const year = req.query.year ? Number(req.query.year) : null;
  let list = readAll('amiba_cost_improve');
  if (year !== null) list = list.filter(p => Number(p.year) === year);
  list = list.sort((a, b) => String(a.amiba_name).localeCompare(String(b.amiba_name), 'zh') || (Number(a.year) || 0) - (Number(b.year) || 0));
  const headers = ['项目名称', '巴单元', '改善类型', '年度', '月份', '目标节约', '实际节约', '核算节约额', '状态', '提报人', '负责人', '标杆案例', '结项时间'];
  const rows = list.map(p => [p.project_name, p.amiba_name, p.improve_type, p.year, p.month, n(p.target_value), n(p.real_value), n(p.save_amount), p.status, p.apply_user, p.owner, p.is_case ? '是' : '', p.finish_time || '']);
  sendXlsx(res, headers, rows, `阿米巴改善项目_${year || '全部'}.xlsx`);
});
router.get('/improve/template', requirePerm(PERM_VIEW), (req, res) => {
  const headers = ['项目名称', '巴单元', '改善类型', '年度', '月份', '目标节约', '实际节约', '核算节约额', '状态', '提报人', '负责人', '标杆案例'];
  const examples = [
    ['优化SMT贴片工艺', '生产制造巴', '工艺', currentYear(), 1, 50000, 0, 0, '立项', '生产总监', '组装组长', '否'],
    ['车间照明能耗改造', '生产制造巴', '能耗', currentYear(), 2, 30000, 0, 0, '立项', '组装组长', '设备员', '否']
  ];
  sendXlsxTemplate(res, headers, examples, `阿米巴改善项目模板.xlsx`);
});
router.post('/improve/import', tradeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const rawRows = parseSheetRows(req.file.buffer, ext);
    if (!rawRows.length) return res.status(400).json({ error: '文件无数据' });
    const fieldMap = { '项目名称': 'project_name', '项目': 'project_name', '巴单元': 'amiba_name', '部门': 'amiba_name', '改善类型': 'improve_type', '类型': 'improve_type', '年度': 'year', '年份': 'year', '月份': 'month', '目标节约': 'target_value', '目标': 'target_value', '实际节约': 'real_value', '实际': 'real_value', '核算节约额': 'save_amount', '节约额': 'save_amount', '状态': 'status', '提报人': 'apply_user', '负责人': 'owner', '标杆案例': 'is_case' };
    const normMap = {}; Object.keys(fieldMap).forEach(k => { normMap[normalizeHeader(k)] = fieldMap[k]; });
    const table = getTable('amiba_cost_improve');
    let imp = 0, skip = 0; const errs = [];
    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i]; const row = {}; Object.keys(raw).forEach(h => { const f = normMap[normalizeHeader(h)]; if (f) row[f] = raw[h]; });
      if (!Object.values(row).some(v => s(v))) { skip++; continue; }
      const pname = s(row.project_name); if (!pname) { skip++; errs.push({ row: i + 2, errors: ['项目名称为空'] }); continue; }
      const amibaName = s(row.amiba_name);
      const amiba = amibaName ? await ensureAmibaByName(amibaName) : { id: 0, name: '' };
      const isCase = /是|1|true/i.test(String(row.is_case));
      const payload = { project_name: pname, amiba_id: amiba.id, amiba_name: amiba.name, improve_type: s(row.improve_type, '费用'), year: Number(row.year) || currentYear(), month: Number(row.month) || 0, target_value: n(row.target_value), real_value: n(row.real_value), save_amount: n(row.save_amount), status: s(row.status, '立项'), apply_user: s(row.apply_user), owner: s(row.owner), is_case: isCase, audit_status: '待审核', updated_at: now() };
      await table.insert(Object.assign(payload, { created_at: now() })); imp++;
    }
    table._invalidate();
    res.json({ message: `改善项目导入完成：成功 ${imp} 条，跳过 ${skip} 条`, imported: imp, skipped: skip, errors: errs.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: '导入失败: ' + e.message }); }
});

// ---- 7. 争议仲裁：导出 ----
router.get('/dispute/export', requirePerm(PERM_VIEW), (req, res) => {
  const list = readAll('amiba_dispute').sort((a, b) => b.id - a.id);
  const headers = ['发起方', '对方', '争议类型', '争议描述', '争议金额', '提报人', '初审意见', '终审意见', '审批结果', '状态', '提报时间', '完结时间'];
  const rows = list.map(d => [d.from_amiba_name, d.to_amiba_name, d.dispute_type, d.dispute_desc, n(d.amount), d.apply_user, d.audit_opinion, '', d.audit_result, d.status, d.apply_time, d.finish_time || '']);
  sendXlsx(res, headers, rows, `阿米巴争议仲裁_${now().substring(0,10)}.xlsx`);
});

// ---- 8. 培训激励：导出 + 模板 + 导入 ----
router.get('/train/export', requirePerm(PERM_VIEW), (req, res) => {
  const list = readAll('amiba_train').sort((a, b) => (b.train_time || '').localeCompare(a.train_time || ''));
  const headers = ['培训主题', '培训类型', '培训内容', '培训时间', '参加人数', '完成人数', '创建人'];
  const rows = list.map(t => [t.train_name, t.train_type, t.train_content, t.train_time, n(t.participant_num), n(t.finish_num), t.create_user || '']);
  sendXlsx(res, headers, rows, `阿米巴培训记录_${now().substring(0,10)}.xlsx`);
});
router.get('/train/template', requirePerm(PERM_VIEW), (req, res) => {
  const headers = ['培训主题', '培训类型', '培训内容', '培训时间', '参加人数', '完成人数'];
  const examples = [
    ['阿米巴经营基础', '阿米巴经营', '阿米巴单位制定、定价、核算基础', now().substring(0,10), 30, 0],
    ['降本改善方法论', '精益改善', 'IE七大手法、PDCA循环', now().substring(0,10), 25, 0]
  ];
  sendXlsxTemplate(res, headers, examples, `阿米巴培训记录模板.xlsx`);
});
router.post('/train/import', tradeUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const rawRows = parseSheetRows(req.file.buffer, ext);
    if (!rawRows.length) return res.status(400).json({ error: '文件无数据' });
    const fieldMap = { '培训主题': 'train_name', '主题': 'train_name', '培训类型': 'train_type', '类型': 'train_type', '培训内容': 'train_content', '内容': 'train_content', '培训时间': 'train_time', '时间': 'train_time', '参加人数': 'participant_num', '参训人数': 'participant_num', '完成人数': 'finish_num', '结业人数': 'finish_num' };
    const normMap = {}; Object.keys(fieldMap).forEach(k => { normMap[normalizeHeader(k)] = fieldMap[k]; });
    const table = getTable('amiba_train');
    let imp = 0, skip = 0; const errs = [];
    for (let i = 0; i < rawRows.length; i++) {
      const raw = rawRows[i]; const row = {}; Object.keys(raw).forEach(h => { const f = normMap[normalizeHeader(h)]; if (f) row[f] = raw[h]; });
      if (!Object.values(row).some(v => s(v))) { skip++; continue; }
      const name = s(row.train_name); if (!name) { skip++; errs.push({ row: i + 2, errors: ['培训主题为空'] }); continue; }
      const payload = { train_name: name, train_type: s(row.train_type), train_content: s(row.train_content), train_time: excelDate(row.train_time) || now().substring(0, 10), participant_num: n(row.participant_num), finish_num: n(row.finish_num), updated_at: now() };
      await table.insert(Object.assign(payload, { created_at: now() })); imp++;
    }
    table._invalidate();
    res.json({ message: `培训记录导入完成：成功 ${imp} 条，跳过 ${skip} 条`, imported: imp, skipped: skip, errors: errs.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: '导入失败: ' + e.message }); }
});

// ---- 9. 月度月报：导出 ----
router.get('/report/export', requirePerm(PERM_VIEW), (req, res) => {
  const year = req.query.year ? Number(req.query.year) : currentYear();
  const list = readAll('amiba_month_report').filter(r => Number(r.year) === year).sort((a, b) => Number(a.month) - Number(b.month));
  const headers = ['年月', '状态', '附件', '生成时间', '月报内容'];
  const rows = list.map(r => [`${r.year}-${String(r.month).padStart(2,'0')}`, r.publish_status, r.file_url || '', r.created_at || '', r.report_content || '']);
  sendXlsx(res, headers, rows, `阿米巴月度月报_${year}.xlsx`);
});

// ---- 10. 组织架构：导出 ----
router.get('/org/export', requirePerm(PERM_VIEW), (req, res) => {
  const list = readAll('amiba_org').sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const headers = ['序号', '巴名称', '层级', '巴类型', '部门', '巴长', '关联销售员', '产品类别', '状态', '创建时间'];
  const rows = list.map((o, i) => [i + 1, o.amiba_name, o.amiba_level, o.amiba_type, o.department, o.charge_user_name, o.sales_person, o.product_category, o.status, o.created_at || '']);
  sendXlsx(res, headers, rows, `阿米巴组织架构_${now().substring(0,10)}.xlsx`);
});

module.exports = router;
