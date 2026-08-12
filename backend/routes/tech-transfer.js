const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { getTable, ensureTable, now } = require('../db');
const { requirePerm, requireAnyPerm, getUserPermissions, extractUserId } = require('../auth-middleware');

const CN_FONT_PATH = 'C:\\Windows\\Fonts\\simhei.ttf';
const APPROVAL_STAGE_LABEL = { dept_review: '待部门经理审核', gm_approve: '待总经理批准', approved: '已批准署名', rejected: '已驳回' };

['tech_documents', 'tech_document_versions', 'tech_transfer_flows',
 'tech_transfer_handovers', 'tech_changes', 'tech_reviews',
 'tech_cases', 'tech_access_logs'].forEach(ensureTable);

const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'tech-transfer');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const origName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const base = path.basename(origName, ext).replace(/[^\w\u4e00-\u9fa5.\-]/g, '_').slice(0, 50);
    cb(null, `${Date.now()}_${base}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

const STAGES = ['presale', 'rd', 'production', 'delivery'];
const STAGE_LABEL = { presale: '售前对接', rd: '研发定型', production: '生产落地', delivery: '交付复盘' };
const CATEGORY_LABEL = {
  presale: '售前技术对接', sample: '样品技术验证', initiate: '项目立项技转',
  production: '核心生产工艺', delivery: '履约交付', review: '技术复盘迭代'
};
const LEVEL_LABEL = { 1: '通用', 2: '核心', 3: '涉密' };
const DOC_STATUS = ['新增', '待审核', '已归档', '已作废', '已迭代'];

function getCurrentUser(req) {
  const userId = extractUserId(req);
  if (!userId) return null;
  const userTable = getTable('users');
  userTable._invalidate();
  const user = userTable.findById(Number(userId));
  if (user) return user;
  const byName = userTable.all().find(u => String(u.username) === String(userId));
  return byName || null;
}

function isAdminUser(req) {
  const userId = extractUserId(req);
  if (!userId) return false;
  const { isAdmin } = getUserPermissions(userId);
  return !!isAdmin;
}

function genNo(prefix) {
  const d = new Date();
  const ymd = d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  return prefix + ymd + '-' + String(Date.now()).slice(-6);
}

function nextVersion(v) {
  const m = String(v || '').match(/^v?(\d+)\.(\d+)$/);
  if (!m) return 'v1.0';
  return 'v' + m[1] + '.' + (Number(m[2]) + 1);
}

function fileHash(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(buf).digest('hex');
  } catch (e) {
    return '';
  }
}

async function stampSignature(relPath, deptMgr, gm) {
  const abs = resolvePath(relPath);
  if (!fs.existsSync(abs)) return null;
  if (path.extname(abs).toLowerCase() !== '.pdf') return null;
  try {
    const doc = await PDFDocument.load(fs.readFileSync(abs), { ignoreEncryption: true });
    doc.registerFontkit(fontkit);
    const fontBytes = fs.existsSync(CN_FONT_PATH)
      ? fs.readFileSync(CN_FONT_PATH)
      : null;
    const font = fontBytes ? await doc.embedFont(fontBytes, { subset: true }) : null;
    const pages = doc.getPages();
    pages.forEach(page => {
      const { width } = page.getSize();
      const boxW = 210, boxH = 66, x = width - boxW - 16, y = 16;
      page.drawRectangle({ x, y, width: boxW, height: boxH, color: rgb(0.78, 0.1, 0.1), opacity: 0.1, borderColor: rgb(0.78, 0.1, 0.1), borderWidth: 1.2 });
      if (font) {
        page.drawText('☑ 已审核批准', { x: x + 10, y: y + boxH - 17, size: 11, font, color: rgb(0.6, 0.03, 0.03) });
        page.drawText('部门经理：' + (deptMgr.name || ''), { x: x + 10, y: y + boxH - 33, size: 8.5, font, color: rgb(0.2, 0.2, 0.2) });
        page.drawText('总经理：' + (gm.name || ''), { x: x + 10, y: y + boxH - 46, size: 8.5, font, color: rgb(0.2, 0.2, 0.2) });
        page.drawText('批准日期：' + (gm.date || ''), { x: x + 10, y: y + 6, size: 7.5, font, color: rgb(0.4, 0.4, 0.4) });
      }
    });
    const out = await doc.save();
    const signedAbs = abs.replace(/\.pdf$/i, '_signed.pdf');
    fs.writeFileSync(signedAbs, out);
    return 'uploads/tech-transfer/' + path.basename(signedAbs);
  } catch (e) {
    return null;
  }
}

function checkDocAccess(req, doc, action) {
  if (isAdminUser(req)) return { ok: true };
  const userId = extractUserId(req);
  if (!userId) return { ok: false, reason: '未登录' };
  const { perms } = getUserPermissions(userId);
  const has = c => perms && perms.has(c);
  const level = Number(doc.level) || 1;
  switch (action) {
    case 'preview':
      if (level <= 1) return has('tech:view') ? { ok: true } : { ok: false, reason: '无预览权限' };
      return has('tech:preview:core') ? { ok: true } : { ok: false, reason: '无核心技术预览权限' };
    case 'download':
      if (Number(doc.allow_download) === 0) return { ok: false, reason: '该资料禁止下载' };
      if (level <= 1) return has('tech:view') ? { ok: true } : { ok: false, reason: '无下载权限' };
      if (level === 2) return has('tech:download') ? { ok: true } : { ok: false, reason: '无核心资料下载权限' };
      return has('tech:download:secret') ? { ok: true } : { ok: false, reason: '涉密资料仅超级管理员可下载' };
    case 'forward':
      if (Number(doc.allow_forward) === 0) return { ok: false, reason: '该资料禁止转发' };
      if (level === 3) return { ok: false, reason: '涉密资料禁止转发' };
      return has('tech:forward') ? { ok: true } : { ok: false, reason: '无转发权限' };
    case 'edit':
      return has('tech:edit') ? { ok: true } : { ok: false, reason: '无编辑权限' };
    case 'delete':
      return has('tech:delete') ? { ok: true } : { ok: false, reason: '无删除权限' };
    case 'reuse':
      return has('tech:reuse') ? { ok: true } : { ok: false, reason: '无复用权限' };
    default:
      return { ok: false, reason: '未知操作' };
  }
}

function logAccess(docId, docTitle, req, action, result, reason) {
  const user = getCurrentUser(req);
  const table = getTable('tech_access_logs');
  table.insert({
    doc_id: docId || null,
    doc_title: docTitle || '',
    user_id: user ? user.id : null,
    user_name: user ? (user.name || user.username) : 'anonymous',
    action, result, reason: reason || '',
    ip: req.ip || req.connection.remoteAddress || '',
    user_agent: req.headers['user-agent'] || '',
    created_at: now()
  });
}

function ensureFlow(projectId) {
  const table = getTable('tech_transfer_flows');
  table._invalidate();
  let flow = table.all().find(f => f.project_id === Number(projectId));
  if (flow) return flow;
  const projectsTable = getTable('projects');
  projectsTable._invalidate();
  const proj = projectsTable.findById(Number(projectId)) || {};
  const result = table.insert({
    project_id: Number(projectId),
    project_no: proj.project_no || '',
    inquiry_no: proj.inquiry_no || '',
    customer_name: proj.customer_name || '',
    presale_status: '未开始', rd_status: '未开始',
    production_status: '未开始', delivery_status: '未开始',
    current_stage: 'presale',
    tech_lead: '', handover_count: 0, change_count: 0,
    created_at: now(), updated_at: now()
  });
  return table.findById(result.lastID);
}

function resolvePath(rel) {
  return path.join(__dirname, '..', '..', rel);
}

const PROG_NODE_FIELDS = ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','mold','mold_sample','packaging','elec_trial','rd_trial','eng_trial','prod_trial','test_report','tech_transfer','shipment','review','other'];

function syncProgressNode(projectId, nodeField, value) {
  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  const prog = progTable.all().find(p => p.project_id === Number(projectId));
  if (prog) {
    progTable.update(prog.id, { [nodeField]: value, updated_at: now() });
  } else {
    const projectsTable = getTable('projects');
    projectsTable._invalidate();
    const proj = projectsTable.findById(Number(projectId)) || {};
    progTable.insert({ project_id: Number(projectId), project_name: proj.project_name || '', [nodeField]: value, created_at: now(), updated_at: now() });
  }
}

// ==================== A. 技术资料管理（11.3） ====================

router.get('/documents', requirePerm('tech:view'), (req, res) => {
  const { page = 1, limit = 50, keyword, category, level, status, project_id, project_no, inquiry_no, customer, owner_dept, sort_by, sort_order } = req.query;
  const table = getTable('tech_documents');
  table._invalidate();
  let records = table.all();
  if (category) records = records.filter(r => r.category === category);
  if (level) records = records.filter(r => String(r.level) === String(level));
  if (status) records = records.filter(r => r.status === status);
  if (project_id) records = records.filter(r => Number(r.project_id) === Number(project_id));
  if (project_no) records = records.filter(r => (r.project_no || '') === project_no);
  if (inquiry_no) records = records.filter(r => (r.inquiry_no || '').includes(inquiry_no));
  if (owner_dept) records = records.filter(r => r.owner_dept === owner_dept);
  if (customer) records = records.filter(r => (r.customer_name || '').includes(customer));
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    records = records.filter(r => {
      const s = [r.doc_no, r.title, r.project_no, r.inquiry_no, r.customer_name, r.sub_category].join(' ').toLowerCase();
      return s.includes(kw);
    });
  }
  const dir = sort_order === 'asc' ? 1 : -1;
  const cmp = (a, b) => String(a || '').localeCompare(String(b || ''));
  if (sort_by === 'title') records.sort((a, b) => dir * cmp(a.title, b.title));
  else if (sort_by === 'level') records.sort((a, b) => dir * ((Number(a.level) || 0) - (Number(b.level) || 0)));
  else if (sort_by === 'category') records.sort((a, b) => dir * cmp(a.category, b.category));
  else records.sort((a, b) => dir * ((a.id || 0) - (b.id || 0)));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/documents/stats', requirePerm('tech:view'), (req, res) => {
  const table = getTable('tech_documents');
  table._invalidate();
  const all = table.all();
  const byCategory = {}, byLevel = {}, byStatus = {}, byProject = {};
  let archived = 0;
  all.forEach(d => {
    const cat = d.category || 'unknown';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const lv = String(d.level || 1);
    byLevel[lv] = (byLevel[lv] || 0) + 1;
    const st = d.status || '新增';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (d.status === '已归档') archived++;
    if (d.project_no) byProject[d.project_no] = (byProject[d.project_no] || 0) + 1;
  });
  res.json({
    total: all.length,
    by_category: byCategory, by_level: byLevel, by_status: byStatus,
    archived, projects_covered: Object.keys(byProject).length
  });
});

router.get('/documents/:id', requirePerm('tech:view'), (req, res) => {
  if (isNaN(Number(req.params.id))) return res.status(404).json({ error: '无效路径' });
  const table = getTable('tech_documents');
  const doc = table.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: '资料不存在' });
  const verTable = getTable('tech_document_versions');
  verTable._invalidate();
  doc.versions = verTable.all().filter(v => v.doc_id === doc.id).sort((a, b) => (b.id - a.id));
  doc.category_label = CATEGORY_LABEL[doc.category] || doc.category;
  doc.level_label = LEVEL_LABEL[doc.level] || doc.level;
  doc.approval_stage_label = APPROVAL_STAGE_LABEL[doc.approval_stage] || doc.approval_stage || '未发起';
  res.json(doc);
});

router.post('/documents', requirePerm('tech:create'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传资料文件' });
  const b = req.body;
  const table = getTable('tech_documents');
  const fileRel = 'uploads/tech-transfer/' + req.file.filename;
  const level = Number(b.level) || 1;
  const doc = {
    doc_no: b.doc_no || genNo('JZ'),
    title: b.title || req.file.originalname,
    category: b.category || 'presale',
    sub_category: b.sub_category || '',
    level,
    stage: b.stage || '',
    project_id: Number(b.project_id) || null,
    project_no: b.project_no || '',
    inquiry_no: b.inquiry_no || '',
    sample_id: Number(b.sample_id) || null,
    customer_name: b.customer_name || '',
    owner_dept: b.owner_dept || '',
    file_path: fileRel,
    file_name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
    file_ext: path.extname(req.file.originalname) || '',
    file_size: req.file.size,
    file_hash: fileHash(req.file.path),
    version: 'v1.0',
    prev_version: '',
    status: '待审核',
    approval_stage: 'dept_review',
    dept_status: 'pending',
    dept_by: '', dept_at: '', dept_note: '',
    gm_status: 'pending',
    gm_by: '', gm_at: '', gm_note: '',
    file_signed_path: '',
    watermark: level >= 2 ? 1 : (Number(b.watermark) || 0),
    allow_preview: b.allow_preview !== undefined ? Number(b.allow_preview) : 1,
    allow_download: b.allow_download !== undefined ? Number(b.allow_download) : 1,
    allow_forward: b.allow_forward !== undefined ? Number(b.allow_forward) : (level === 3 ? 0 : 1),
    description: b.description || '',
    uploaded_by: (getCurrentUser(req) || {}).name || b.uploaded_by || '',
    archived_at: '',
    created_at: now(), updated_at: now()
  };
  const result = table.insert(doc);
  const created = table.findById(result.lastID);
  const verTable = getTable('tech_document_versions');
  verTable.insert({
    doc_id: created.id, version: 'v1.0', file_path: fileRel,
    file_name: created.file_name, file_hash: created.file_hash, file_size: created.file_size,
    change_summary: '初始版本', change_reason: '首次上传',
    changed_by: created.uploaded_by, is_current: 1, created_at: now()
  });
  if (created.project_id) ensureFlow(created.project_id);
  logAccess(created.id, created.title, req, 'upload', 'success', '');
  res.json({ message: '上传成功', data: created });
});

router.put('/documents/:id', requirePerm('tech:edit'), (req, res) => {
  const table = getTable('tech_documents');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '资料不存在' });
  const access = checkDocAccess(req, existing, 'edit');
  if (!access.ok) {
    logAccess(existing.id, existing.title, req, 'edit', 'denied', access.reason);
    return res.status(403).json({ error: access.reason, code: 'PERMISSION_DENIED' });
  }
  const fields = { updated_at: now() };
  ['title', 'category', 'sub_category', 'stage', 'project_no', 'inquiry_no', 'customer_name', 'owner_dept', 'description', 'status'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['level', 'watermark', 'allow_preview', 'allow_download', 'allow_forward'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = Number(req.body[f]);
  });
  if (req.body.project_id !== undefined) fields.project_id = Number(req.body.project_id) || null;
  table.update(req.params.id, fields);
  logAccess(existing.id, existing.title, req, 'edit', 'success', '');
  res.json({ message: '更新成功' });
});

router.post('/documents/:id/new-version', requirePerm('tech:edit'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传新版本文件' });
  const table = getTable('tech_documents');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '资料不存在' });
  const access = checkDocAccess(req, existing, 'edit');
  if (!access.ok) {
    logAccess(existing.id, existing.title, req, 'edit', 'denied', access.reason);
    return res.status(403).json({ error: access.reason, code: 'PERMISSION_DENIED' });
  }
  const fileRel = 'uploads/tech-transfer/' + req.file.filename;
  const newVer = nextVersion(existing.version);
  const verTable = getTable('tech_document_versions');
  verTable._invalidate();
  verTable.all().filter(v => v.doc_id === existing.id).forEach(v => {
    verTable.update(v.id, { is_current: 0 });
  });
  verTable.insert({
    doc_id: existing.id, version: newVer, file_path: fileRel,
    file_name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
    file_hash: fileHash(req.file.path), file_size: req.file.size,
    change_summary: req.body.change_summary || '版本迭代',
    change_reason: req.body.change_reason || '',
    changed_by: (getCurrentUser(req) || {}).name || '',
    is_current: 1, created_at: now()
  });
  table.update(req.params.id, {
    prev_version: existing.version, version: newVer,
    file_path: fileRel, file_name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
    file_ext: path.extname(req.file.originalname) || '', file_size: req.file.size,
    file_hash: fileHash(req.file.path), status: '已迭代', updated_at: now()
  });
  logAccess(existing.id, existing.title, req, 'edit', 'success', '版本迭代 ' + newVer);
  res.json({ message: '新版本上传成功', version: newVer });
});

router.put('/documents/:id/audit', requirePerm('tech:audit'), (req, res) => {
  const table = getTable('tech_documents');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '资料不存在' });
  const status = req.body.status;
  if (!DOC_STATUS.includes(status)) return res.status(400).json({ error: '无效状态' });
  const fields = { status, updated_at: now() };
  if (status === '已归档') fields.archived_at = now();
  if (status === '已作废') { fields.allow_download = 0; fields.allow_forward = 0; }
  table.update(req.params.id, fields);
  logAccess(existing.id, existing.title, req, 'audit', 'success', '审核为 ' + status);
  res.json({ message: '审核完成' });
});

router.put('/documents/:id/approve', requireAnyPerm('tech:approve:dept','tech:approve:gm','tech:admin'), async (req, res) => {
  const table = getTable('tech_documents');
  const doc = table.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: '资料不存在' });
  const level = req.body.level;
  const action = req.body.action;
  if (!['dept', 'gm'].includes(level) || !['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: '参数无效' });
  }
  const user = getCurrentUser(req) || {};
  const fields = { updated_at: now() };
  const note = req.body.note || '';

  if (level === 'dept') {
    if (doc.approval_stage !== 'dept_review') return res.status(400).json({ error: '当前不在部门经理审核阶段' });
    if (action === 'approve') {
      fields.dept_status = 'approved';
      fields.dept_by = user.name || '';
      fields.dept_at = now();
      fields.dept_note = note;
      fields.approval_stage = 'gm_approve';
    } else {
      fields.dept_status = 'rejected';
      fields.dept_by = user.name || '';
      fields.dept_at = now();
      fields.dept_note = note;
      fields.approval_stage = 'rejected';
      fields.status = '已作废';
      fields.allow_download = 0; fields.allow_forward = 0;
    }
  } else {
    if (doc.approval_stage !== 'gm_approve') return res.status(400).json({ error: '当前不在总经理批准阶段' });
    if (action === 'approve') {
      fields.gm_status = 'approved';
      fields.gm_by = user.name || '';
      fields.gm_at = now();
      fields.gm_note = note;
      fields.approval_stage = 'approved';
      fields.status = '已归档';
      fields.archived_at = now();
      const deptMgr = { name: doc.dept_by, date: (doc.dept_at || '').substring(0, 10) };
      const gm = { name: fields.gm_by, date: fields.gm_at.substring(0, 10) };
      const signedPath = await stampSignature(doc.file_path, deptMgr, gm);
      if (signedPath) fields.file_signed_path = signedPath;
    } else {
      fields.gm_status = 'rejected';
      fields.gm_by = user.name || '';
      fields.gm_at = now();
      fields.gm_note = note;
      fields.approval_stage = 'dept_review';
      fields.dept_status = 'pending';
    }
  }
  table.update(req.params.id, fields);
  logAccess(doc.id, doc.title, req, 'audit', 'success', `${level === 'dept' ? '部门经理' : '总经理'}${action === 'approve' ? '通过' : '驳回'}`);
  res.json({
    message: action === 'approve'
      ? (level === 'dept' ? '部门经理审核通过，待总经理批准' : '总经理批准完成，文件已署名归档')
      : (level === 'dept' ? '部门经理已驳回' : '总经理驳回，退回部门经理复审'),
    approval_stage: fields.approval_stage,
    signed: level === 'gm' && action === 'approve' ? !!fields.file_signed_path : false
  });
});

router.get('/documents/:id/preview', (req, res) => {
  const table = getTable('tech_documents');
  const doc = table.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: '资料不存在' });
  if (Number(doc.allow_preview) === 0) {
    logAccess(doc.id, doc.title, req, 'preview', 'denied', '该资料禁止预览');
    return res.status(403).json({ error: '该资料禁止预览' });
  }
  const access = checkDocAccess(req, doc, 'preview');
  if (!access.ok) {
    logAccess(doc.id, doc.title, req, 'preview', 'denied', access.reason);
    return res.status(403).json({ error: access.reason, code: 'PERMISSION_DENIED' });
  }
  const abs = resolvePath((doc.approval_stage === 'approved' && doc.file_signed_path) ? doc.file_signed_path : doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在' });
  logAccess(doc.id, doc.title, req, 'preview', 'success', '');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Frame-Options', 'DENY');
  if (Number(doc.watermark) === 1) res.setHeader('X-Tech-Watermark', 'true');
  res.sendFile(abs);
});

router.get('/documents/:id/download', (req, res) => {
  const table = getTable('tech_documents');
  const doc = table.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: '资料不存在' });
  const access = checkDocAccess(req, doc, 'download');
  if (!access.ok) {
    logAccess(doc.id, doc.title, req, 'download', 'denied', access.reason);
    return res.status(403).json({ error: access.reason, code: 'PERMISSION_DENIED' });
  }
  const useSigned = doc.approval_stage === 'approved' && doc.file_signed_path;
  const abs = resolvePath(useSigned ? doc.file_signed_path : doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在' });
  logAccess(doc.id, doc.title, req, 'download', 'success', useSigned ? '署名版' : '');
  res.download(abs, doc.file_name);
});

router.post('/documents/:id/forward', (req, res) => {
  const table = getTable('tech_documents');
  const doc = table.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: '资料不存在' });
  const access = checkDocAccess(req, doc, 'forward');
  if (!access.ok) {
    logAccess(doc.id, doc.title, req, 'forward', 'denied', access.reason);
    return res.status(403).json({ error: access.reason, code: 'PERMISSION_DENIED' });
  }
  const { to_user, remark } = req.body;
  if (!to_user) return res.status(400).json({ error: '请指定接收人' });
  logAccess(doc.id, doc.title, req, 'forward', 'success', `转发至 ${to_user}：${remark || ''}`);
  res.json({ message: '已转发', to_user });
});

router.post('/documents/:id/reuse', requirePerm('tech:reuse'), (req, res) => {
  const table = getTable('tech_documents');
  const src = table.findById(req.params.id);
  if (!src) return res.status(404).json({ error: '资料不存在' });
  const { project_id, project_no, customer_name } = req.body;
  if (!project_id && !project_no) return res.status(400).json({ error: '请指定目标项目' });
  const created = table.insert({
    ...src,
    id: undefined,
    doc_no: genNo('JZ'),
    project_id: Number(project_id) || src.project_id,
    project_no: project_no || src.project_no,
    customer_name: customer_name || src.customer_name,
    version: 'v1.0', prev_version: '',
    status: '新增', archived_at: '',
    description: (src.description ? src.description + ' [复用自 ' + src.doc_no + ']' : '[复用自 ' + src.doc_no + ']'),
    uploaded_by: (getCurrentUser(req) || {}).name || '',
    created_at: now(), updated_at: now()
  });
  delete created.id;
  const result = table.insert(created);
  const newDoc = table.findById(result.lastID);
  const verTable = getTable('tech_document_versions');
  verTable.insert({
    doc_id: newDoc.id, version: 'v1.0', file_path: newDoc.file_path,
    file_name: newDoc.file_name, file_hash: newDoc.file_hash, file_size: newDoc.file_size,
    change_summary: '复用自 ' + src.doc_no, change_reason: '跨项目复用',
    changed_by: newDoc.uploaded_by, is_current: 1, created_at: now()
  });
  logAccess(newDoc.id, newDoc.title, req, 'reuse', 'success', '复用自 ' + src.doc_no);
  res.json({ message: '复用成功', data: newDoc });
});

router.delete('/documents/:id', requirePerm('tech:delete'), (req, res) => {
  const table = getTable('tech_documents');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '资料不存在' });
  const access = checkDocAccess(req, existing, 'delete');
  if (!access.ok) {
    logAccess(existing.id, existing.title, req, 'delete', 'denied', access.reason);
    return res.status(403).json({ error: access.reason, code: 'PERMISSION_DENIED' });
  }
  if (existing.status === '已归档') {
    table.update(req.params.id, { status: '已作废', allow_download: 0, allow_forward: 0, updated_at: now() });
    logAccess(existing.id, existing.title, req, 'delete', 'success', '归档资料转作废');
    return res.json({ message: '已归档资料转为作废，保留溯源记录' });
  }
  table.delete(req.params.id);
  const verTable = getTable('tech_document_versions');
  verTable._invalidate();
  verTable.all().filter(v => v.doc_id === existing.id).forEach(v => verTable.delete(v.id));
  try { if (fs.existsSync(resolvePath(existing.file_path))) fs.unlinkSync(resolvePath(existing.file_path)); } catch (e) {}
  logAccess(existing.id, existing.title, req, 'delete', 'success', '物理删除');
  res.json({ message: '删除成功' });
});

router.get('/documents/:id/versions', requirePerm('tech:view'), (req, res) => {
  const verTable = getTable('tech_document_versions');
  verTable._invalidate();
  const records = verTable.all().filter(v => v.doc_id === Number(req.params.id)).sort((a, b) => b.id - a.id);
  res.json({ data: records, total: records.length });
});

router.get('/documents/:id/access-logs', requirePerm('tech:admin'), (req, res) => {
  const logTable = getTable('tech_access_logs');
  logTable._invalidate();
  const records = logTable.all().filter(l => l.doc_id === Number(req.params.id)).sort((a, b) => b.id - a.id);
  res.json({ data: records, total: records.length });
});

// ==================== B. 四段式技转流转（11.4.1） ====================

router.get('/flows', requirePerm('tech:view'), (req, res) => {
  const { page = 1, limit = 50, keyword, current_stage, project_no, customer, started } = req.query;
  const projectsTable = getTable('projects');
  const flowTable = getTable('tech_transfer_flows');
  projectsTable._invalidate();
  flowTable._invalidate();
  const flowMap = {};
  flowTable.all().forEach(f => { flowMap[f.project_id] = f; });
  let records = projectsTable.all().map(p => {
    const f = flowMap[p.id] || {};
    return {
      id: f.id || null,
      project_id: p.id,
      project_no: p.project_no || '',
      project_name: p.project_name || '',
      customer_name: p.customer_name || '',
      inquiry_no: f.inquiry_no || (p.inquiry_no || ''),
      proj_stage: p.current_stage || '',
      owner: p.owner || '',
      presale_status: f.presale_status || '未开始',
      rd_status: f.rd_status || '未开始',
      production_status: f.production_status || '未开始',
      delivery_status: f.delivery_status || '未开始',
      current_stage: f.current_stage || '',
      tech_lead: f.tech_lead || '',
      handover_count: f.handover_count || 0,
      change_count: f.change_count || 0,
      tech_started: !!f.id
    };
  });
  if (started === '1') records = records.filter(r => r.tech_started);
  if (started === '0') records = records.filter(r => !r.tech_started);
  if (current_stage) records = records.filter(r => r.current_stage === current_stage);
  if (project_no) records = records.filter(r => (r.project_no || '').includes(project_no));
  if (customer) records = records.filter(r => (r.customer_name || '').includes(customer));
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    records = records.filter(r => [r.project_no, r.project_name, r.customer_name].join(' ').toLowerCase().includes(kw));
  }
  records.sort((a, b) => (b.project_id - a.project_id));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit)).map(r => ({
    ...r, current_stage_label: r.current_stage ? (STAGE_LABEL[r.current_stage] || r.current_stage) : '未启动'
  }));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/flows/:projectId', requirePerm('tech:view'), (req, res) => {
  const flow = ensureFlow(req.params.projectId);
  const handoverTable = getTable('tech_transfer_handovers');
  const changeTable = getTable('tech_changes');
  const reviewTable = getTable('tech_reviews');
  const docTable = getTable('tech_documents');
  handoverTable._invalidate(); changeTable._invalidate(); reviewTable._invalidate(); docTable._invalidate();
  flow.handovers = handoverTable.all().filter(h => h.flow_id === flow.id).sort((a, b) => b.id - a.id);
  flow.changes = changeTable.all().filter(c => c.project_id === flow.project_id).sort((a, b) => b.id - a.id);
  flow.reviews = reviewTable.all().filter(r => r.project_id === flow.project_id).sort((a, b) => b.id - a.id);
  flow.documents = docTable.all().filter(d => Number(d.project_id) === flow.project_id).sort((a, b) => b.id - a.id);
  flow.current_stage_label = STAGE_LABEL[flow.current_stage] || flow.current_stage;
  res.json(flow);
});

router.put('/flows/:id/stage', requirePerm('tech:transfer'), (req, res) => {
  const table = getTable('tech_transfer_flows');
  const flow = table.findById(req.params.id);
  if (!flow) return res.status(404).json({ error: '技转主档不存在' });
  const stage = req.body.current_stage;
  if (!STAGES.includes(stage)) return res.status(400).json({ error: '无效阶段' });
  const stageStatusMap = { presale: 'presale_status', rd: 'rd_status', production: 'production_status', delivery: 'delivery_status' };
  const fields = { current_stage: stage, updated_at: now() };
  const prevStageStatus = stageStatusMap[flow.current_stage];
  if (prevStageStatus && flow[prevStageStatus] !== '完成') fields[prevStageStatus] = '完成';
  const nextStatus = stageStatusMap[stage];
  if (nextStatus && flow[nextStatus] === '未开始') fields[nextStatus] = '进行中';
  table.update(req.params.id, fields);
  res.json({ message: '阶段已推进' });
});

router.get('/handovers', requirePerm('tech:view'), (req, res) => {
  const { page = 1, limit = 50, flow_id, project_id, stage, status } = req.query;
  const table = getTable('tech_transfer_handovers');
  table._invalidate();
  let records = table.all();
  if (flow_id) records = records.filter(r => r.flow_id === Number(flow_id));
  if (project_id) records = records.filter(r => Number(r.project_id) === Number(project_id));
  if (stage) records = records.filter(r => r.stage === stage);
  if (status) records = records.filter(r => r.status === status);
  records.sort((a, b) => (b.id - a.id));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.post('/handovers', requirePerm('tech:transfer'), (req, res) => {
  const b = req.body;
  if (!b.project_id) return res.status(400).json({ error: '请指定项目' });
  const flow = ensureFlow(b.project_id);
  const table = getTable('tech_transfer_handovers');
  const user = getCurrentUser(req) || {};
  const result = table.insert({
    handover_no: b.handover_no || genNo('HS'),
    flow_id: flow.id, project_id: flow.project_id,
    project_no: flow.project_no, inquiry_no: flow.inquiry_no,
    customer_name: flow.customer_name,
    stage: b.stage || flow.current_stage || 'presale',
    doc_ids: Array.isArray(b.doc_ids) ? b.doc_ids : [],
    from_user: user.name || b.from_user || '',
    from_role: b.from_role || '',
    to_user: b.to_user || '', to_role: b.to_role || '生产',
    content: b.content || '',
    status: b.status || '待审核',
    audited_by: '', audit_note: '', audited_at: '',
    created_at: now(), updated_at: now()
  });
  getTable('tech_transfer_flows').update(flow.id, {
    handover_count: (Number(flow.handover_count) || 0) + 1,
    updated_at: now()
  });
  res.json({ message: '交底单已创建', data: table.findById(result.lastID) });
});

router.put('/handovers/:id/audit', requirePerm('tech:transfer'), (req, res) => {
  const table = getTable('tech_transfer_handovers');
  const h = table.findById(req.params.id);
  if (!h) return res.status(404).json({ error: '交底单不存在' });
  const status = req.body.status;
  if (!['已通过', '已驳回', '已流转'].includes(status)) {
    return res.status(400).json({ error: '无效状态' });
  }
  const user = getCurrentUser(req) || {};
  const fields = {
    status,
    audited_by: user.name || '',
    audit_note: req.body.audit_note || '',
    audited_at: now(),
    updated_at: now()
  };
  table.update(req.params.id, fields);
  if (status === '已通过' || status === '已流转') {
    const flowTable = getTable('tech_transfer_flows');
    const flow = flowTable.findById(h.flow_id);
    if (flow) {
      const stageStatusMap = { presale: 'presale_status', rd: 'rd_status', production: 'production_status', delivery: 'delivery_status' };
      const cur = stageStatusMap[h.stage];
      const updates = { updated_at: now() };
      if (cur) updates[cur] = '完成';
      const idx = STAGES.indexOf(h.stage);
      if (idx >= 0 && idx < STAGES.length - 1) {
        const nextStage = STAGES[idx + 1];
        const nextField = stageStatusMap[nextStage];
        if (nextField) updates[nextField] = '进行中';
        updates.current_stage = nextStage;
      }
      flowTable.update(flow.id, updates);
      if (h.stage === 'rd') {
        syncProgressNode(flow.project_id, 'tech_transfer', 'V');
      } else if (h.stage === 'delivery') {
        syncProgressNode(flow.project_id, 'review', 'V');
      }
    }
  }
  res.json({ message: '审核完成，研发数据库已同步' });
});

router.get('/handovers/:id', requirePerm('tech:view'), (req, res) => {
  const table = getTable('tech_transfer_handovers');
  const h = table.findById(req.params.id);
  if (!h) return res.status(404).json({ error: '交底单不存在' });
  if (Array.isArray(h.doc_ids) && h.doc_ids.length) {
    const docTable = getTable('tech_documents');
    docTable._invalidate();
    h.documents = h.doc_ids.map(id => docTable.findById(id)).filter(Boolean);
  } else {
    h.documents = [];
  }
  h.stage_label = STAGE_LABEL[h.stage] || h.stage;
  res.json(h);
});

// ==================== C. 技术变更强制流转（11.4.2） ====================

router.get('/changes', requirePerm('tech:view'), (req, res) => {
  const { page = 1, limit = 50, project_id, change_type, status, keyword } = req.query;
  const table = getTable('tech_changes');
  table._invalidate();
  let records = table.all();
  if (project_id) records = records.filter(r => Number(r.project_id) === Number(project_id));
  if (change_type) records = records.filter(r => r.change_type === change_type);
  if (status) records = records.filter(r => r.status === status);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    records = records.filter(r => [r.change_no, r.scope, r.reason, r.project_no].join(' ').toLowerCase().includes(kw));
  }
  records.sort((a, b) => (b.id - a.id));
  const projectsTable = getTable('projects');
  projectsTable._invalidate();
  const pName = {};
  projectsTable.all().forEach(p => { pName[p.id] = p.project_name; });
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit)).map(r => ({ ...r, project_name: pName[r.project_id] || '' }));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.post('/changes', requirePerm('tech:change'), (req, res) => {
  const b = req.body;
  if (!b.project_id) return res.status(400).json({ error: '请指定项目' });
  const user = getCurrentUser(req) || {};
  const table = getTable('tech_changes');
  const result = table.insert({
    change_no: b.change_no || genNo('BG'),
    project_id: Number(b.project_id), project_no: b.project_no || '',
    change_type: b.change_type || '参数',
    scope: b.scope || '',
    before_value: b.before_value || '', after_value: b.after_value || '',
    reason: b.reason || '', impact_analysis: b.impact_analysis || '',
    status: '发起',
    initiator: user.name || b.initiator || '',
    auditor: '', related_doc_ids: Array.isArray(b.related_doc_ids) ? b.related_doc_ids : [],
    notify_roles: Array.isArray(b.notify_roles) ? b.notify_roles : [],
    executed_at: '', verified_at: '', verified_note: '',
    created_at: now(), updated_at: now()
  });
  const flowTable = getTable('tech_transfer_flows');
  flowTable._invalidate();
  const flow = flowTable.all().find(f => f.project_id === Number(b.project_id));
  if (flow) flowTable.update(flow.id, { change_count: (Number(flow.change_count) || 0) + 1, updated_at: now() });
  res.json({ message: '变更已发起', data: table.findById(result.lastID) });
});

router.put('/changes/:id/audit', requirePerm('tech:change'), (req, res) => {
  const table = getTable('tech_changes');
  const c = table.findById(req.params.id);
  if (!c) return res.status(404).json({ error: '变更不存在' });
  const status = req.body.status;
  if (!['审核中', '已通过', '已驳回'].includes(status)) return res.status(400).json({ error: '无效状态' });
  const user = getCurrentUser(req) || {};
  table.update(req.params.id, { status, auditor: user.name || '', updated_at: now() });
  res.json({ message: '审核完成，关联岗位已知悉' });
});

router.put('/changes/:id/execute', requirePerm('tech:change'), (req, res) => {
  const table = getTable('tech_changes');
  const c = table.findById(req.params.id);
  if (!c) return res.status(404).json({ error: '变更不存在' });
  if (c.status !== '已通过') return res.status(400).json({ error: '仅已通过的变更可执行' });
  table.update(req.params.id, { status: '已执行', executed_at: now(), updated_at: now() });
  if (Array.isArray(c.related_doc_ids)) {
    const docTable = getTable('tech_documents');
    const verTable = getTable('tech_document_versions');
    c.related_doc_ids.forEach(did => {
      const doc = docTable.findById(did);
      if (doc) {
        const newVer = nextVersion(doc.version);
        verTable.insert({
          doc_id: doc.id, version: newVer, file_path: doc.file_path,
          file_name: doc.file_name, file_hash: doc.file_hash, file_size: doc.file_size,
          change_summary: '变更 ' + c.change_no + ' 触发', change_reason: c.reason,
          changed_by: c.auditor || c.initiator, is_current: 1, created_at: now()
        });
        docTable.update(doc.id, { prev_version: doc.version, version: newVer, status: '已迭代', updated_at: now() });
      }
    });
  }
  res.json({ message: '变更已执行，受影响资料版本已更新' });
});

router.put('/changes/:id/verify', requirePerm('tech:change'), (req, res) => {
  const table = getTable('tech_changes');
  const c = table.findById(req.params.id);
  if (!c) return res.status(404).json({ error: '变更不存在' });
  if (c.status !== '已执行') return res.status(400).json({ error: '仅已执行的变更可校验' });
  table.update(req.params.id, { status: '已校验', verified_at: now(), verified_note: req.body.verified_note || '', updated_at: now() });
  res.json({ message: '校验完成，变更闭环' });
});

router.get('/changes/:id', requirePerm('tech:view'), (req, res) => {
  const table = getTable('tech_changes');
  const c = table.findById(req.params.id);
  if (!c) return res.status(404).json({ error: '变更不存在' });
  if (Array.isArray(c.related_doc_ids) && c.related_doc_ids.length) {
    const docTable = getTable('tech_documents');
    docTable._invalidate();
    c.documents = c.related_doc_ids.map(id => docTable.findById(id)).filter(Boolean);
  } else {
    c.documents = [];
  }
  res.json(c);
});

// ==================== D. 技术复盘与案例库（11.5） ====================

router.get('/reviews', requirePerm('tech:view'), (req, res) => {
  const { page = 1, limit = 50, project_id, dimension, status } = req.query;
  const table = getTable('tech_reviews');
  table._invalidate();
  let records = table.all();
  if (project_id) records = records.filter(r => Number(r.project_id) === Number(project_id));
  if (dimension) records = records.filter(r => r.dimension === dimension);
  if (status) records = records.filter(r => r.status === status);
  records.sort((a, b) => (b.id - a.id));
  const projectsTable = getTable('projects');
  projectsTable._invalidate();
  const pName = {};
  projectsTable.all().forEach(p => { pName[p.id] = p.project_name; });
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit)).map(r => ({ ...r, project_name: pName[r.project_id] || '' }));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.post('/reviews', requirePerm('tech:review'), (req, res) => {
  const b = req.body;
  if (!b.project_id) return res.status(400).json({ error: '请指定项目' });
  const user = getCurrentUser(req) || {};
  const table = getTable('tech_reviews');
  const result = table.insert({
    review_no: b.review_no || genNo('FK'),
    project_id: Number(b.project_id), project_no: b.project_no || '',
    customer_name: b.customer_name || '',
    dimension: b.dimension || 'parameter',
    findings: b.findings || '', issues: b.issues || '',
    improvements: b.improvements || '', action_plan: b.action_plan || '',
    risk_level: b.risk_level || '',
    owner: user.name || b.owner || '',
    status: b.status || '草稿',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '复盘已创建', data: table.findById(result.lastID) });
});

router.put('/reviews/:id', requirePerm('tech:review'), (req, res) => {
  const table = getTable('tech_reviews');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '复盘不存在' });
  const fields = { updated_at: now() };
  ['dimension', 'findings', 'issues', 'improvements', 'action_plan', 'risk_level', 'owner', 'status'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '复盘已更新' });
});

router.post('/reviews/:id/promote-case', requirePerm('tech:case:manage'), (req, res) => {
  const reviewTable = getTable('tech_reviews');
  const r = reviewTable.findById(req.params.id);
  if (!r) return res.status(404).json({ error: '复盘不存在' });
  if (r.status !== '已完成') return res.status(400).json({ error: '仅已完成的复盘可沉淀为案例' });
  const caseTable = getTable('tech_cases');
  const result = caseTable.insert({
    case_no: genNo('AL'),
    title: req.body.title || (r.project_no + ' ' + (r.dimension || '') + '复盘案例'),
    product_category: req.body.product_category || '',
    problem_type: r.dimension || '',
    problem_desc: r.issues || r.findings || '',
    root_cause: req.body.root_cause || '',
    solution: r.improvements || '',
    source_project_id: r.project_id, source_project_no: r.project_no,
    related_review_id: r.id,
    tags: Array.isArray(req.body.tags) ? req.body.tags : [],
    view_count: 0,
    created_by: (getCurrentUser(req) || {}).name || '',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '已沉淀为案例', data: caseTable.findById(result.lastID) });
});

router.get('/cases', requirePerm('tech:view'), (req, res) => {
  const { page = 1, limit = 50, product_category, problem_type, keyword } = req.query;
  const table = getTable('tech_cases');
  table._invalidate();
  let records = table.all();
  if (product_category) records = records.filter(r => r.product_category === product_category);
  if (problem_type) records = records.filter(r => r.problem_type === problem_type);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    records = records.filter(r => [r.title, r.problem_desc, r.solution, r.root_cause].join(' ').toLowerCase().includes(kw));
  }
  records.sort((a, b) => (b.id - a.id));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/cases/:id', requirePerm('tech:view'), (req, res) => {
  const table = getTable('tech_cases');
  const c = table.findById(req.params.id);
  if (!c) return res.status(404).json({ error: '案例不存在' });
  table.update(req.params.id, { view_count: (Number(c.view_count) || 0) + 1 });
  res.json({ ...c, view_count: (Number(c.view_count) || 0) + 1 });
});

router.post('/cases', requirePerm('tech:case:manage'), (req, res) => {
  const b = req.body;
  if (!b.title) return res.status(400).json({ error: '案例标题为必填' });
  const table = getTable('tech_cases');
  const result = table.insert({
    case_no: b.case_no || genNo('AL'),
    title: b.title,
    product_category: b.product_category || '',
    problem_type: b.problem_type || '',
    problem_desc: b.problem_desc || '',
    root_cause: b.root_cause || '',
    solution: b.solution || '',
    source_project_id: Number(b.source_project_id) || null,
    source_project_no: b.source_project_no || '',
    related_review_id: Number(b.related_review_id) || null,
    tags: Array.isArray(b.tags) ? b.tags : [],
    view_count: 0,
    created_by: (getCurrentUser(req) || {}).name || '',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '案例已创建', data: table.findById(result.lastID) });
});

router.put('/cases/:id', requirePerm('tech:case:manage'), (req, res) => {
  const table = getTable('tech_cases');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '案例不存在' });
  const fields = { updated_at: now() };
  ['title', 'product_category', 'problem_type', 'problem_desc', 'root_cause', 'solution', 'source_project_no', 'tags'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '案例已更新' });
});

router.delete('/cases/:id', requirePerm('tech:case:manage'), (req, res) => {
  const table = getTable('tech_cases');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '案例不存在' });
  table.delete(req.params.id);
  res.json({ message: '案例已删除' });
});

// ==================== 项目研发数据库关联（项目管理 ↔ 项目技转） ====================

router.get('/project/:projectId/context', requirePerm('tech:view'), (req, res) => {
  const pid = Number(req.params.projectId);
  const projectsTable = getTable('projects');
  projectsTable._invalidate();
  const project = projectsTable.findById(pid);
  if (!project) return res.status(404).json({ error: '项目不存在' });

  const progTable = getTable('rd_project_progress');
  progTable._invalidate();
  const progress = progTable.all().find(p => p.project_id === pid) || null;
  const nodeDone = progress ? PROG_NODE_FIELDS.filter(f => progress[f] === 'V' || progress[f] === '√').length : 0;

  const reviewTable = getTable('rd_project_reviews');
  reviewTable._invalidate();
  const rdReview = reviewTable.all().find(r => r.project_id === pid) || null;

  const flow = ensureFlow(pid);
  const docTable = getTable('tech_documents');
  docTable._invalidate();
  const docs = docTable.all().filter(d => Number(d.project_id) === pid);
  const changeTable = getTable('tech_changes');
  changeTable._invalidate();
  const changes = changeTable.all().filter(c => c.project_id === pid);
  const handoverTable = getTable('tech_transfer_handovers');
  handoverTable._invalidate();
  const handovers = handoverTable.all().filter(h => h.project_id === pid);
  const techReviewTable = getTable('tech_reviews');
  techReviewTable._invalidate();
  const techReviews = techReviewTable.all().filter(r => r.project_id === pid);

  res.json({
    project: {
      id: project.id, project_no: project.project_no, project_name: project.project_name,
      customer_name: project.customer_name, current_stage: project.current_stage,
      owner: project.owner, status: project.status, change_count: project.change_count
    },
    rd_progress: progress ? {
      node_done: nodeDone, node_total: PROG_NODE_FIELDS.length,
      node_rate: Math.round(nodeDone / PROG_NODE_FIELDS.length * 100),
      tech_transfer: progress.tech_transfer || ''
    } : { node_done: 0, node_total: PROG_NODE_FIELDS.length, node_rate: 0, tech_transfer: '' },
    rd_review: rdReview,
    tech_flow: flow,
    tech_docs: {
      total: docs.length,
      archived: docs.filter(d => d.status === '已归档').length,
      by_level: { 1: docs.filter(d => Number(d.level) === 1).length, 2: docs.filter(d => Number(d.level) === 2).length, 3: docs.filter(d => Number(d.level) === 3).length }
    },
    tech_changes: { total: changes.length, open: changes.filter(c => c.status !== '已校验').length },
    tech_handovers: { total: handovers.length },
    tech_reviews: { total: techReviews.length }
  });
});

router.post('/flows/:id/sync-progress', requirePerm('tech:transfer'), (req, res) => {
  const flowTable = getTable('tech_transfer_flows');
  const flow = flowTable.findById(req.params.id);
  if (!flow) return res.status(404).json({ error: '技转主档不存在' });
  const synced = [];
  if (flow.rd_status === '完成') { syncProgressNode(flow.project_id, 'tech_transfer', 'V'); synced.push('tech_transfer'); }
  if (flow.delivery_status === '完成') { syncProgressNode(flow.project_id, 'review', 'V'); synced.push('review'); }
  res.json({ message: synced.length ? '已同步研发数据库节点：' + synced.join('、') : '当前无可同步节点（研发定型/交付复盘阶段未完成）', synced });
});

// ==================== E. 合规 / 防外泄 / 审计（11.3.2、11.6） ====================

router.get('/access-logs', requirePerm('tech:admin'), (req, res) => {
  const { page = 1, limit = 50, doc_id, user_id, action, result } = req.query;
  const table = getTable('tech_access_logs');
  table._invalidate();
  let records = table.all();
  if (doc_id) records = records.filter(r => Number(r.doc_id) === Number(doc_id));
  if (user_id) records = records.filter(r => String(r.user_id) === String(user_id));
  if (action) records = records.filter(r => r.action === action);
  if (result) records = records.filter(r => r.result === result);
  records.sort((a, b) => (b.id - a.id));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/leak-alerts', requirePerm('tech:admin'), (req, res) => {
  const table = getTable('tech_access_logs');
  table._invalidate();
  const all = table.all();
  const denied = all.filter(l => l.result === 'denied');
  const byUser = {};
  all.filter(l => l.action === 'download').forEach(l => {
    const key = l.user_name || 'anonymous';
    byUser[key] = (byUser[key] || 0) + 1;
  });
  const bulkDownload = Object.entries(byUser).filter(([, n]) => n > 10).map(([u, n]) => ({ user: u, downloads: n }));
  res.json({
    denied_count: denied.length,
    denied_recent: denied.slice(-20).reverse(),
    bulk_download_suspect: bulkDownload,
    forward_denied: all.filter(l => l.action === 'forward' && l.result === 'denied').length
  });
});

router.get('/level-config', requirePerm('tech:admin'), (req, res) => {
  const cfgTable = getTable('settings');
  cfgTable._invalidate();
  const cfg = cfgTable.all().find(s => s.key === 'tech_level_config');
  const defaults = {
    levels: [
      { level: 1, name: '通用', roles: ['sales', 'purchase', 'finance', 'viewer', 'engineer', 'sales_manager', 'admin'] },
      { level: 2, name: '核心', roles: ['engineer', 'sales_manager', 'admin'] },
      { level: 3, name: '涉密', roles: ['admin'] }
    ],
    watermark: { level_gte: 2 },
    anti_screenshot: { level_gte: 2 },
    batch_download_limit: 1
  };
  res.json({ data: (cfg && cfg.value) ? cfg.value : defaults });
});

router.put('/level-config', requirePerm('tech:admin'), (req, res) => {
  const cfgTable = getTable('settings');
  cfgTable._invalidate();
  const existing = cfgTable.all().find(s => s.key === 'tech_level_config');
  if (existing) {
    cfgTable.update(existing.id, { value: req.body, updated_at: now() });
  } else {
    cfgTable.insert({ key: 'tech_level_config', value: req.body, created_at: now(), updated_at: now() });
  }
  res.json({ message: '分级权限配置已更新' });
});

module.exports = router;
