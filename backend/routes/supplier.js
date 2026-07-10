const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

ensureTable('supplier_products');
ensureTable('supplier_images');
ensureTable('supplier_evaluations');
ensureTable('supplier_documents');

const imgDir = path.join(__dirname, '..', '..', 'uploads', 'suppliers');
if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
const imgUpload = multer({ dest: imgDir, limits: { fileSize: 10 * 1024 * 1024 } });
const fileUpload = multer({ dest: path.join(__dirname, '..', 'uploads', '/') });

// ===== 供应商列表（分页+筛选+生命周期） =====
router.get('/', requirePerm('supplier:view'), (req, res) => {
  const { page = 1, limit = 15, keyword, level, lifecycle_status, risk_level, category, sort_by, sort_order } = req.query;
  const table = getTable('suppliers');
  const filter = (r) => {
    if (level && r.level !== level) return false;
    if (lifecycle_status && r.lifecycle_status !== lifecycle_status) return false;
    if (risk_level && r.risk_level !== risk_level) return false;
    if (category && !(r.category || '').includes(category)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const s = [r.name, r.code, r.contact, r.phone, r.category, r.supply_materials].join(' ').toLowerCase();
      if (!s.includes(kw)) return false;
    }
    return true;
  };
  const allowedSort = ['id', 'name', 'code', 'level', 'lifecycle_status', 'risk_level', 'overall_score', 'created_at'];
  const orderBy = allowedSort.includes(sort_by) ? sort_by : 'id';
  const orderDir = (sort_order && sort_order.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
  const { records, total } = table.findWhere(filter, orderBy, orderDir, parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 供应商代码自动生成（BYGY.001 格式） =====
function generateSupCode() {
  const table = getTable('suppliers');
  let max = 0;
  table.all().forEach(s => { const m = (s.code || '').match(/^BYGY\.(\d+)$/i); if (m) { const n = parseInt(m[1]); if (n > max) max = n; } });
  return 'BYGY.' + String(max + 1).padStart(3, '0');
}
router.get('/next-code', requirePerm('supplier:view'), (req, res) => { res.json({ code: generateSupCode() }); });

// ===== 供应商详情（含产品/图册/评估） =====
router.get('/:id', requirePerm('supplier:view'), (req, res) => {
  const table = getTable('suppliers');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '供应商不存在' });
  const prodTable = getTable('supplier_products');
  const imgTable = getTable('supplier_images');
  const evalTable = getTable('supplier_evaluations');
  prodTable._invalidate(); imgTable._invalidate(); evalTable._invalidate();
  row.products = prodTable.all().filter(p => p.supplier_id === Number(req.params.id));
  row.images = imgTable.all().filter(i => i.supplier_id === Number(req.params.id));
  row.evaluations = evalTable.all().filter(e => e.supplier_id === Number(req.params.id)).sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json(row);
});

// ===== 新增供应商 =====
router.post('/', requirePerm('supplier:create'), (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: '供应商名称为必填项' });
  const table = getTable('suppliers');
  if (table.all().find(s => s.name === b.name)) return res.status(400).json({ error: '供应商名称已存在' });
  const result = table.insert({
    name: b.name, code: b.code || '', contact: b.contact || '', phone: b.phone || '', email: b.email || '',
    address: b.address || '', category: b.category || '', level: b.level || 'C',
    supply_materials: b.supply_materials || '', remarks: b.remarks || '',
    lifecycle_status: b.lifecycle_status || 'reserve', risk_level: b.risk_level || 'medium',
    quality_score: 0, delivery_score: 0, price_score: 0, service_score: 0, overall_score: 0,
    // 付款信息
    payment_method: b.payment_method || '', payment_cycle: b.payment_cycle || '', payment_terms: b.payment_terms || '',
    bank_name: b.bank_name || '', bank_account: b.bank_account || '', tax_id: b.tax_id || '',
    // 资质
    business_license: b.business_license || '', website: b.website || '', fax: b.fax || '',
    cooperation_since: b.cooperation_since || '', total_orders: 0, total_amount: 0,
    exit_reason: '', exit_date: '',
    created_at: now(), updated_at: now()
  });
  res.json({ message: '供应商创建成功', data: table.findById(result.lastID) });
});

// ===== 更新供应商 =====
router.put('/:id', requirePerm('supplier:edit'), (req, res) => {
  const table = getTable('suppliers');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '供应商不存在' });
  const fields = { updated_at: now() };
  ['name','code','contact','phone','email','address','category','level','supply_materials','remarks',
   'lifecycle_status','risk_level','qualification_status','cooperation_since','contract_no','contract_start','contract_end',
   'payment_method','payment_cycle','payment_terms','bank_name','bank_account','tax_id','business_license','website','fax',
   'exit_reason','exit_date'].forEach(f => { if (req.body[f] !== undefined) fields[f] = req.body[f]; });
  ['quality_score','delivery_score','price_score','service_score','total_orders','total_amount'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = Number(req.body[f]) || 0;
  });
  // 评估分自动计算综合分+等级
  if (fields.quality_score !== undefined || fields.delivery_score !== undefined || fields.price_score !== undefined || fields.service_score !== undefined) {
    const q = Number(fields.quality_score !== undefined ? fields.quality_score : existing.quality_score) || 0;
    const d = Number(fields.delivery_score !== undefined ? fields.delivery_score : existing.delivery_score) || 0;
    const p = Number(fields.price_score !== undefined ? fields.price_score : existing.price_score) || 0;
    const s = Number(fields.service_score !== undefined ? fields.service_score : existing.service_score) || 0;
    fields.overall_score = Math.round((q + d + p + s) / 4 * 10) / 10;
    fields.level = fields.overall_score >= 8 ? 'A' : fields.overall_score >= 6 ? 'B' : fields.overall_score >= 4 ? 'C' : 'D';
  }
  table.update(req.params.id, fields);
  res.json({ message: '更新成功', data: table.findById(req.params.id) });
});

router.delete('/:id', requirePerm('supplier:delete'), (req, res) => {
  const table = getTable('suppliers');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '供应商不存在' });
  table.delete(req.params.id);
  res.json({ message: '删除成功' });
});

// ===== 生命周期变更 =====
router.put('/:id/lifecycle', requirePerm('supplier:edit'), (req, res) => {
  const table = getTable('suppliers');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '供应商不存在' });
  const valid = ['reserve', 'reviewing', 'approved', 'cooperating', 'observing', 'exited'];
  const { lifecycle_status, reason } = req.body;
  if (!valid.includes(lifecycle_status)) return res.status(400).json({ error: '无效状态' });
  const statusMap = { reserve: '开发储备', reviewing: '准入审核', approved: '已准入', cooperating: '合作中', observing: '观察期', exited: '已退出' };
  const updates = { lifecycle_status, updated_at: now() };
  if (lifecycle_status === 'exited') { updates.exit_reason = reason || ''; updates.exit_date = now().split(' ')[0]; updates.status = 'inactive'; }
  if (lifecycle_status === 'cooperating') { updates.status = 'active'; if (!existing.cooperation_since) updates.cooperation_since = now().split(' ')[0]; }
  table.update(req.params.id, updates);
  res.json({ message: '生命周期变更: ' + (statusMap[lifecycle_status] || lifecycle_status), data: table.findById(req.params.id) });
});

// ===== 产品目录 =====
router.get('/:id/products', requirePerm('supplier:view'), (req, res) => {
  const t = getTable('supplier_products'); t._invalidate();
  res.json({ data: t.all().filter(p => p.supplier_id === Number(req.params.id)) });
});
router.post('/:id/products', requirePerm('supplier:edit'), (req, res) => {
  const t = getTable('supplier_products');
  const b = req.body;
  const r = t.insert({ supplier_id: Number(req.params.id), product_name: b.product_name || '', product_code: b.product_code || '', spec: b.spec || '', unit: b.unit || 'PCS', unit_price: Number(b.unit_price) || 0, moq: Number(b.moq) || 0, lead_time: b.lead_time || '', remarks: b.remarks || '', created_at: now(), updated_at: now() });
  res.json({ message: '添加成功', data: t.findById(r.lastID) });
});
router.put('/:id/products/:pid', requirePerm('supplier:edit'), (req, res) => {
  const t = getTable('supplier_products');
  if (!t.findById(req.params.pid)) return res.status(404).json({ error: '产品不存在' });
  const f = { updated_at: now() };
  ['product_name','product_code','spec','unit','lead_time','remarks'].forEach(k => { if (req.body[k] !== undefined) f[k] = req.body[k]; });
  ['unit_price','moq'].forEach(k => { if (req.body[k] !== undefined) f[k] = Number(req.body[k]) || 0; });
  t.update(req.params.pid, f);
  res.json({ message: '更新成功' });
});
router.delete('/:id/products/:pid', requirePerm('supplier:delete'), (req, res) => {
  const t = getTable('supplier_products'); t.delete(req.params.pid);
  res.json({ message: '删除成功' });
});

// ===== 图册管理 =====
router.get('/:id/images', requirePerm('supplier:view'), (req, res) => {
  const t = getTable('supplier_images'); t._invalidate();
  res.json({ data: t.all().filter(i => i.supplier_id === Number(req.params.id)).sort((a, b) => (b.id || 0) - (a.id || 0)) });
});
router.post('/:id/images', requirePerm('supplier:edit'), imgUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  const t = getTable('supplier_images');
  const r = t.insert({ supplier_id: Number(req.params.id), file_name: req.file.originalname, file_path: req.file.path, file_type: path.extname(req.file.originalname).toLowerCase(), description: req.body.description || '', category: req.body.category || '产品图', created_at: now() });
  res.json({ message: '上传成功', data: t.findById(r.lastID) });
});
router.delete('/:id/images/:imgId', requirePerm('supplier:delete'), (req, res) => {
  const t = getTable('supplier_images');
  const img = t.findById(req.params.imgId);
  if (img && img.file_path) { try { fs.unlinkSync(img.file_path); } catch (e) {} }
  t.delete(req.params.imgId);
  res.json({ message: '删除成功' });
});
router.get('/images/:imgId/view', (req, res) => {
  const t = getTable('supplier_images');
  const img = t.findById(req.params.imgId);
  if (!img || !fs.existsSync(img.file_path)) return res.status(404).json({ error: '图片不存在' });
  res.sendFile(path.resolve(img.file_path));
});

// ===== 评估记录 =====
router.get('/:id/evaluations', requirePerm('supplier:view'), (req, res) => {
  const t = getTable('supplier_evaluations'); t._invalidate();
  res.json({ data: t.all().filter(e => e.supplier_id === Number(req.params.id)).sort((a, b) => (b.id || 0) - (a.id || 0)) });
});
router.post('/:id/evaluations', requirePerm('supplier:edit'), (req, res) => {
  const t = getTable('supplier_evaluations');
  const b = req.body;
  const q = Number(b.quality_score) || 0, d = Number(b.delivery_score) || 0, p = Number(b.price_score) || 0, s = Number(b.service_score) || 0;
  const overall = Math.round((q + d + p + s) / 4 * 10) / 10;
  const r = t.insert({ supplier_id: Number(req.params.id), eval_date: b.eval_date || now().split(' ')[0], quality_score: q, delivery_score: d, price_score: p, service_score: s, overall_score: overall, evaluator: b.evaluator || '', remarks: b.remarks || '', created_at: now() });
  // 同步更新供应商主表评分
  const supTable = getTable('suppliers');
  const level = overall >= 8 ? 'A' : overall >= 6 ? 'B' : overall >= 4 ? 'C' : 'D';
  supTable.update(req.params.id, { quality_score: q, delivery_score: d, price_score: p, service_score: s, overall_score: overall, level, updated_at: now() });
  res.json({ message: '评估提交成功', data: t.findById(r.lastID) });
});

// ===== 多格式导入（Excel解析 / PDF+图片+Word存为资料） =====
router.post('/import', requirePerm('supplier:create'), fileUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const isExcel = ['.xlsx', '.xls', '.csv'].includes(ext);
  const supplierId = req.body.supplier_id || null;

  if (isExcel) {
    // Excel/CSV → 解析数据导入供应商
    try {
      const wb = XLSX.readFile(req.file.path);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      const table = getTable('suppliers');
      const existing = new Set(table.all().map(s => s.name));
      let imported = 0, skipped = 0, failed = 0;
      const colMap = (row, keys) => { for (const k of keys) { for (const rk of Object.keys(row)) { if (rk.includes(k)) return row[rk]; } } return ''; };
      rows.forEach(row => {
        const name = String(colMap(row, ['\u540d\u79f0', 'name', '\u4f9b\u5e94\u5546']) || '').trim();
        if (!name) { skipped++; return; }
        if (existing.has(name)) { skipped++; return; }
        try {
          table.insert({
            name, code: String(colMap(row, ['\u7f16\u53f7', 'code']) || ''),
            contact: String(colMap(row, ['\u8054\u7cfb\u4eba', 'contact']) || ''),
            phone: String(colMap(row, ['\u7535\u8bdd', '\u624b\u673a', 'phone']) || ''),
            email: String(colMap(row, ['\u90ae\u7bb1', 'email']) || ''),
            address: String(colMap(row, ['\u5730\u5740', 'address']) || ''),
            category: String(colMap(row, ['\u7c7b\u522b', '\u54c1\u7c7b', 'category']) || ''),
            level: String(colMap(row, ['\u7b49\u7ea7', 'level']) || 'C'),
            supply_materials: String(colMap(row, ['\u4e3b\u8425', '\u7269\u6599', 'supply']) || ''),
            payment_method: String(colMap(row, ['\u4ed8\u6b3e\u65b9\u5f0f']) || ''),
            payment_cycle: String(colMap(row, ['\u4ed8\u6b3e\u5468\u671f']) || ''),
            bank_name: String(colMap(row, ['\u5f00\u6237\u884c', '\u94f6\u884c']) || ''),
            bank_account: String(colMap(row, ['\u8d26\u53f7']) || ''),
            tax_id: String(colMap(row, ['\u7a0e\u53f7']) || ''),
            risk_level: String(colMap(row, ['\u98ce\u9669']) || 'medium'),
            lifecycle_status: 'reserve',
            quality_score: 0, delivery_score: 0, price_score: 0, service_score: 0, overall_score: 0,
            remarks: String(colMap(row, ['\u5907\u6ce8', 'remarks']) || '\u5bfc\u5165'),
            created_at: now(), updated_at: now()
          });
          existing.add(name); imported++;
        } catch (e) { failed++; }
      });
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      res.json({ message: '\u5bfc\u5165\u5b8c\u6210', imported, skipped, failed, total: rows.length, type: 'excel' });
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch (e2) {}
      res.status(500).json({ error: '\u5bfc\u5165\u5931\u8d25: ' + e.message });
    }
  } else {
    // PDF/图片/Word/其他 → 存为资料 + 图片自动OCR提取供应商信息
    const docTable = getTable('supplier_documents');
    const docDir = path.join(imgDir);
    const newPath = path.join(docDir, Date.now() + '_' + req.file.originalname.replace(/[^\w\u4e00-\u9fa5.\-]/g, '_'));
    try { fs.renameSync(req.file.path, newPath); } catch (e) { newPath = req.file.path; }
    const docTypeMap = { '.pdf': 'PDF文档', '.doc': 'Word文档', '.docx': 'Word文档', '.jpg': '图片', '.jpeg': '图片', '.png': '图片', '.gif': '图片', '.bmp': '图片', '.txt': '文本' };
    const isImage = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp'].includes(ext);
    const docR = docTable.insert({
      supplier_id: supplierId ? Number(supplierId) : null,
      file_name: req.file.originalname, file_path: newPath, file_type: ext,
      doc_type: docTypeMap[ext] || '其他', description: req.body.description || '', file_size: req.file.size,
      created_at: now()
    });
    const docId = docR.lastID;

    // 图片自动OCR提取供应商信息并同步到供应商列表
    let extracted = null; let autoSupplierId = supplierId ? Number(supplierId) : null;
    if (isImage) {
      try {
        const Tesseract = require('tesseract.js');
        const result = await Tesseract.recognize(newPath, 'chi_sim+eng', { logger: () => {} });
        const text = (result.data.text || '').trim();
        if (text) {
          const phones = text.match(/1[3-9]\d{9}/g) || [];
          const landlines = text.match(/0\d{2,3}-?\d{7,8}/g) || [];
          const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
          const allPhones = [...new Set([...phones, ...landlines])];
          const nameLine = text.split('\n').find(l => /公司|有限|厂|集团|科技|电子|五金|包装|塑/.test(l) && l.trim().length > 2);
          const addrLine = text.split('\n').find(l => /路|街|号|区|市|省|镇|村|工业/.test(l) && l.trim().length > 4);
          const taxMatch = text.match(/[0-9A-Z]{15,20}/);
          extracted = {
            name: nameLine ? nameLine.trim().substring(0, 50) : '',
            phone: allPhones[0] || '', email: emails[0] || '',
            address: addrLine ? addrLine.trim().substring(0, 100) : '',
            tax_id: taxMatch ? taxMatch[0] : '', raw_text: text.substring(0, 300)
          };
          // 如果提取到公司名称且没有指定供应商，自动创建
          if (extracted.name && !supplierId) {
            const supTable = getTable('suppliers');
            const existing = supTable.all().find(s => s.name === extracted.name);
            if (existing) {
              autoSupplierId = existing.id;
            } else {
              const code = generateSupCode();
              const supR = supTable.insert({
                name: extracted.name, code, contact: '', phone: extracted.phone, email: extracted.email,
                address: extracted.address, category: '', level: 'C', lifecycle_status: 'reserve', risk_level: 'medium',
                supply_materials: '', remarks: '从资料OCR自动提取', tax_id: extracted.tax_id,
                payment_method: '', payment_cycle: '', quality_score: 0, delivery_score: 0, price_score: 0, service_score: 0, overall_score: 0,
                created_at: now(), updated_at: now()
              });
              autoSupplierId = supR.lastID;
              extracted.code = code;
              extracted.auto_created = true;
            }
          }
          // 关联文档到供应商
          if (autoSupplierId) {
            docTable.update(docId, { supplier_id: autoSupplierId, updated_at: now() });
          }
        }
      } catch (ocrErr) { /* OCR失败不影响存储 */ }
    }

    res.json({
      message: isImage && extracted && extracted.name ? '资料已导入并自动提取供应商信息' : '文件已存为供应商资料',
      type: 'document', doc_id: docId, file_name: req.file.originalname, doc_type: docTypeMap[ext] || '其他',
      extracted: extracted, supplier_id: autoSupplierId
    });
  }
});

// ===== \u4f9b\u5e94\u5546\u8d44\u6599\u6587\u6863\u5217\u8868 =====
router.get('/documents/list', requirePerm('supplier:view'), (req, res) => {
  const t = getTable('supplier_documents'); t._invalidate();
  let docs = t.all();
  if (req.query.supplier_id) docs = docs.filter(d => d.supplier_id === Number(req.query.supplier_id));
  docs.sort((a, b) => (b.id || 0) - (a.id || 0));
  res.json({ data: docs });
});

// ===== 资料文档下载 =====
router.get('/documents/:docId/download', requirePerm('supplier:view'), (req, res) => {
  const t = getTable('supplier_documents');
  const doc = t.findById(req.params.docId);
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).json({ error: '文件不存在' });
  res.download(doc.file_path, doc.file_name);
});

// ===== 资料在线预览（浏览器内嵌显示） =====
router.get('/documents/:docId/preview', requirePerm('supplier:view'), (req, res) => {
  const t = getTable('supplier_documents');
  const doc = t.findById(req.params.docId);
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).json({ error: '文件不存在' });
  const ext = (doc.file_type || '').toLowerCase();
  const imageTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  if (imageTypes[ext]) {
    res.setHeader('Content-Type', imageTypes[ext]);
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(doc.file_path).pipe(res);
  } else if (ext === '.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(doc.file_path).pipe(res);
  } else {
    res.download(doc.file_path, doc.file_name);
  }
});

router.delete('/documents/:docId', requirePerm('supplier:delete'), (req, res) => {
  const t = getTable('supplier_documents');
  const doc = t.findById(req.params.docId);
  if (doc && doc.file_path) { try { fs.unlinkSync(doc.file_path); } catch (e) {} }
  t.delete(req.params.docId);
  res.json({ message: '删除成功' });
});

// ===== OCR提取供应商信息（从图片资料） =====
router.post('/documents/:docId/extract', requirePerm('supplier:edit'), async (req, res) => {
  const docTable = getTable('supplier_documents');
  const doc = docTable.findById(req.params.docId);
  if (!doc || !fs.existsSync(doc.file_path)) return res.status(404).json({ error: '文件不存在' });
  const ext = (doc.file_type || '').toLowerCase();
  const imageExts = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp'];
  if (!imageExts.includes(ext)) {
    return res.json({ message: '该格式暂不支持自动提取，请手动录入或上传图片格式资料', extracted: null });
  }
  try {
    const Tesseract = require('tesseract.js');
    const result = await Tesseract.recognize(doc.file_path, 'chi_sim+eng', { logger: () => {} });
    const text = (result.data.text || '').trim();
    if (!text) return res.json({ message: '未识别到文字', extracted: { raw_text: '' } });
    // 正则提取信息
    const phones = text.match(/1[3-9]\d{9}/g) || [];
    const landlines = text.match(/0\d{2,3}-?\d{7,8}/g) || [];
    const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
    const allPhones = [...new Set([...phones, ...landlines])];
    // 公司名称：找含"公司""厂""有限"的行
    const nameMatch = text.split('\n').find(l => /公司|有限|厂|集团|科技|电子|五金|包装|塑/.test(l) && l.trim().length > 2);
    // 地址：找含"路""街""号""区""市""省"的行
    const addrMatch = text.split('\n').find(l => /路|街|号|区|市|省|镇|村|工业/.test(l) && l.trim().length > 4);
    // 税号
    const taxMatch = text.match(/[0-9A-Z]{15,20}/);
    const extracted = {
      raw_text: text.substring(0, 500),
      name: nameMatch ? nameMatch.trim().substring(0, 50) : '',
      phone: allPhones[0] || '',
      phone2: allPhones[1] || '',
      email: emails[0] || '',
      address: addrMatch ? addrMatch.trim().substring(0, 100) : '',
      tax_id: taxMatch ? taxMatch[0] : ''
    };
    // 自动分配供应商代码
    extracted.code = generateSupCode();
    res.json({ message: '识别完成', extracted, doc_id: req.params.docId });
  } catch (e) {
    res.json({ message: 'OCR识别失败: ' + e.message, extracted: null });
  }
});

// ===== 关联资料到供应商 =====
router.put('/documents/:docId/assign', requirePerm('supplier:edit'), (req, res) => {
  const t = getTable('supplier_documents');
  const doc = t.findById(req.params.docId);
  if (!doc) return res.status(404).json({ error: '资料不存在' });
  t.update(req.params.docId, { supplier_id: req.body.supplier_id ? Number(req.body.supplier_id) : null, updated_at: now() });
  res.json({ message: '关联成功' });
});

// ===== 从物料库提取 =====
router.post('/extract-from-materials', requirePerm('supplier:create'), (req, res) => {
  const matTable = getTable('materials'); matTable._invalidate();
  const supTable = getTable('suppliers'); supTable._invalidate();
  const existing = new Set(supTable.all().map(s => s.name));
  let added = 0; const details = [];
  const counter = {};
  matTable.all().forEach(m => { const sup = (m.supplier || '').trim(); if (sup) counter[sup] = (counter[sup] || 0) + 1; });
  Object.entries(counter).forEach(([name, count]) => {
    if (existing.has(name)) return;
    const r = supTable.insert({ name, code: '', contact: '', phone: '', email: '', address: '', category: '', level: count >= 5 ? 'B' : 'C', lifecycle_status: 'reserve', risk_level: 'medium', supply_materials: '', remarks: '从物料库提取(关联' + count + '种)', payment_method: '', payment_cycle: '', quality_score: 0, delivery_score: 0, price_score: 0, service_score: 0, overall_score: 0, created_at: now(), updated_at: now() });
    existing.add(name); added++; details.push({ name, count });
  });
  res.json({ message: '提取完成', added, details: details.sort((a, b) => b.count - a.count).slice(0, 50) });
});

// ===== 仪表盘分析 =====
router.get('/stats/overview', requirePerm('supplier:view'), (req, res) => {
  const table = getTable('suppliers'); table._invalidate();
  const evalTable = getTable('supplier_evaluations'); evalTable._invalidate();
  const prodTable = getTable('supplier_products'); prodTable._invalidate();
  const all = table.all();
  const byLifecycle = {}; const byLevel = {}; const byRisk = {}; const byCategory = {}; const byPaymentCycle = {};
  let avgScore = 0; let scored = 0;
  // 合作分析维度评分累计
  let sumQ = 0, sumD = 0, sumP = 0, sumS = 0, dimScored = 0;
  let evaluatedCount = 0; let totalOrders = 0; let totalAmount = 0;
  all.forEach(s => {
    byLifecycle[s.lifecycle_status || 'reserve'] = (byLifecycle[s.lifecycle_status || 'reserve'] || 0) + 1;
    byLevel[s.level || 'C'] = (byLevel[s.level || 'C'] || 0) + 1;
    byRisk[s.risk_level || 'medium'] = (byRisk[s.risk_level || 'medium'] || 0) + 1;
    const cat = s.category || '未分类'; byCategory[cat] = (byCategory[cat] || 0) + 1;
    const pc = s.payment_cycle || '未设'; byPaymentCycle[pc] = (byPaymentCycle[pc] || 0) + 1;
    if (s.overall_score > 0) { avgScore += Number(s.overall_score); scored++; evaluatedCount++; }
    // 维度评分（任一维度有分即计入）
    if (Number(s.quality_score) > 0 || Number(s.delivery_score) > 0 || Number(s.price_score) > 0 || Number(s.service_score) > 0) {
      sumQ += Number(s.quality_score) || 0; sumD += Number(s.delivery_score) || 0;
      sumP += Number(s.price_score) || 0; sumS += Number(s.service_score) || 0; dimScored++;
    }
    totalOrders += Number(s.total_orders) || 0;
    totalAmount += Number(s.total_amount) || 0;
  });
  const lcLabels = { reserve: '开发储备', reviewing: '准入审核', approved: '已准入', cooperating: '合作中', observing: '观察期', exited: '已退出' };
  // 等级归并到 A/B/C/D
  const normLevel = lv => {
    const v = String(lv || '').toUpperCase();
    if (v.includes('A')) return 'A';
    if (v.includes('B')) return 'B';
    if (v.includes('C')) return 'C';
    if (v.includes('D')) return 'D';
    return 'C';
  };
  const levelDist = { A: 0, B: 0, C: 0, D: 0 };
  all.forEach(s => { levelDist[normLevel(s.level)]++; });
  const coopTotal = byLifecycle.cooperating || 0;
  // 评估次数（评估记录表）
  const evalTimes = evalTable.all().length;
  // 供应商产品数
  const productCount = prodTable.all().length;
  // 合作率 = 合作中 / 总数
  const coopRate = all.length ? Math.round(coopTotal / all.length * 1000) / 10 : 0;
  // TOP 供应商（按综合评分，其次按订单数）
  const topSuppliers = all.slice().sort((a, b) => {
    const sa = (Number(b.overall_score) || 0) * 1000 + (Number(b.total_orders) || 0);
    const sb = (Number(a.overall_score) || 0) * 1000 + (Number(a.total_orders) || 0);
    return sa - sb;
  }).filter(s => (Number(s.overall_score) > 0) || (Number(s.total_orders) > 0)).slice(0, 10)
    .map(s => ({ name: s.name, score: s.overall_score, level: s.level, orders: Number(s.total_orders) || 0, amount: Number(s.total_amount) || 0 }));
  res.json({
    total: all.length,
    by_lifecycle: byLifecycle, lc_labels: lcLabels,
    by_level: byLevel, by_risk: byRisk, by_category: byCategory, by_payment_cycle: byPaymentCycle,
    avg_score: scored ? Math.round(avgScore / scored * 10) / 10 : 0,
    cooperating_count: byLifecycle.cooperating || 0,
    reserve_count: byLifecycle.reserve || 0,
    exited_count: byLifecycle.exited || 0,
    high_risk_count: byRisk.high || 0,
    top_suppliers: topSuppliers,
    // 合作分析扩展字段
    cooperation: {
      cooperating_count: coopTotal,
      cooperation_rate: coopRate,
      evaluated_count: evaluatedCount,
      evaluation_times: evalTimes,
      product_count: productCount,
      total_orders: totalOrders,
      total_amount: totalAmount,
      avg_quality: dimScored ? Math.round(sumQ / dimScored * 10) / 10 : 0,
      avg_delivery: dimScored ? Math.round(sumD / dimScored * 10) / 10 : 0,
      avg_price: dimScored ? Math.round(sumP / dimScored * 10) / 10 : 0,
      avg_service: dimScored ? Math.round(sumS / dimScored * 10) / 10 : 0,
      level_distribution: levelDist,
      by_category_top: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ name: k, value: v }))
    }
  });
});

// ===== 扫描提取：扫描未关联图片资料 → OCR → 提取供应商信息 → 创建+关联 =====
router.post('/scan-and-extract', requirePerm('supplier:create'), async (req, res) => {
  const { apply } = req.body;
  const doApply = apply !== false;
  const docTable = getTable('supplier_documents'); docTable._invalidate();
  const supTable = getTable('suppliers'); supTable._invalidate();

  const imageExts = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp'];
  const unlinked = docTable.all().filter(d =>
    !d.supplier_id && imageExts.includes((d.file_type || '').toLowerCase()) && fs.existsSync(d.file_path)
  );

  if (unlinked.length === 0) {
    return res.json({ message: '没有需要识别的未关联图片资料', scanned: 0, results: [] });
  }

  const existingNames = new Set(supTable.all().map(s => s.name));
  const results = [];

  for (const doc of unlinked) {
    const item = { doc_id: doc.id, file_name: doc.file_name, status: '', info: null };
    try {
      // OCR识别（先英文后中文）
      const Tesseract = require('tesseract.js');
      const tessDir = path.join(__dirname);
      let text = '';
      try {
        const r = await Tesseract.recognize(doc.file_path, 'eng', { logger: () => {}, langPath: tessDir });
        text += (r.data.text || '').trim();
      } catch (e) {}
      try {
        const r2 = await Tesseract.recognize(doc.file_path, 'chi_sim', { logger: () => {}, langPath: tessDir });
        text += '\n' + (r2.data.text || '').trim();
      } catch (e) {}

      if (!text || !text.trim()) { item.status = 'no_text'; results.push(item); continue; }

      // 提取信息
      const phones = text.match(/1[3-9]\d{9}/g) || [];
      const landlines = text.match(/0\d{2,3}-?\d{7,8}/g) || [];
      const allPhones = [...new Set([...phones, ...landlines])];
      const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
      const nameLine = lines.find(l => /公司|有限|厂|集团|科技|电子|五金|包装|塑料|照明|电器|贸易|实业|金属|光电/.test(l));
      const addrLine = lines.find(l => /路|街|号|区|市|省|镇|村|工业|大道|大厦/.test(l) && l.length > 4);
      const contactLine = lines.find(l => /联系人|经办人|代表|经理|主任|先生|女士/.test(l));
      const contactMatch = contactLine ? contactLine.match(/[:：]\s*(.+?)[\s,，]/) : null;
      const taxMatch = text.match(/[0-9A-Z]{15,20}/);

      const info = {
        name: nameLine ? nameLine.replace(/^[:：\s]+/, '').substring(0, 50) : '',
        phone: allPhones[0] || '', email: emails[0] || '',
        address: addrLine ? addrLine.substring(0, 100) : '',
        contact: contactMatch ? contactMatch[1].trim() : '',
        tax_id: taxMatch ? taxMatch[0] : '',
        raw_text: text.substring(0, 200)
      };
      item.info = info;

      if (!info.name) { item.status = 'no_name'; results.push(item); continue; }

      if (existingNames.has(info.name)) {
        const existing = supTable.all().find(s => s.name === info.name);
        item.status = 'exists'; item.supplier_id = existing.id;
        if (doApply) { docTable.update(doc.id, { supplier_id: existing.id, updated_at: now() }); }
        results.push(item); continue;
      }

      // 创建新供应商
      const code = generateSupCode();
      item.code = code;
      if (doApply) {
        const ts = now();
        const r = supTable.insert({
          name: info.name, code, contact: info.contact || '', phone: info.phone || '',
          email: info.email || '', address: info.address || '', category: '', level: 'C',
          lifecycle_status: 'reviewing', risk_level: 'medium', supply_materials: '',
          remarks: '扫描提取自动创建', tax_id: info.tax_id || '',
          payment_method: '', payment_cycle: '', quality_score: 0, delivery_score: 0,
          price_score: 0, service_score: 0, overall_score: 0,
          created_at: ts, updated_at: ts
        });
        const newId = r.lastID;
        docTable.update(doc.id, { supplier_id: newId, updated_at: now() });
        existingNames.add(info.name);
        item.supplier_id = newId; item.status = 'created';
      } else {
        item.status = 'preview';
      }
      results.push(item);
    } catch (e) {
      item.status = 'error'; item.error = e.message.substring(0, 100);
      results.push(item);
    }
  }

  const created = results.filter(r => r.status === 'created').length;
  const exists = results.filter(r => r.status === 'exists').length;
  const noName = results.filter(r => r.status === 'no_name').length;
  const noText = results.filter(r => r.status === 'no_text').length;
  const errors = results.filter(r => r.status === 'error').length;

  res.json({
    message: doApply ? `扫描完成：新建${created}家，关联${exists}家，未识别${noName + noText}条` : `预览：可新建${results.filter(r=>r.status==='preview').length}家，关联${exists}家`,
    scanned: unlinked.length, created, exists, no_name: noName, no_text: noText, errors,
    applied: doApply, results
  });
});

// ===== 供应商名称去重（扫描-合并-迁移关联数据） =====
// 名称归一：去除首尾/制表符空白，全角括号转半角，统一小写，便于识别同一供应商
function normalizeSupplierName(name) {
  return String(name || '')
    .replace(/[\t\r\n\f\v]+/g, ' ')
    .replace(/\s+/g, '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/【/g, '[').replace(/】/g, ']')
    .trim()
    .toLowerCase();
}

router.post('/dedupe', requirePerm('supplier:edit'), (req, res) => {
  const doApply = req.body.apply !== false && req.query.apply !== 'false';
  const supTable = getTable('suppliers'); supTable._invalidate();
  const prodTable = getTable('supplier_products');
  const evalTable = getTable('supplier_evaluations');
  const imgTable = getTable('supplier_images');
  const docTable = getTable('supplier_documents');

  const all = supTable.all();
  const groups = {};
  all.forEach(s => {
    const key = normalizeSupplierName(s.name);
    if (!key) return;
    (groups[key] = groups[key] || []).push(s);
  });

  // 记录信息完整度，用于决定保留哪一条
  const richness = s => {
    let n = 0;
    ['contact', 'phone', 'email', 'address', 'category', 'level', 'code', 'supply_materials'].forEach(f => { if (s[f]) n++; });
    if (Number(s.overall_score) > 0) n += 2;
    if (Number(s.total_orders) > 0) n += 1;
    return n;
  };

  const results = [];
  let removed = 0;
  Object.entries(groups).forEach(([key, arr]) => {
    if (arr.length < 2) return;
    arr.sort((a, b) => {
      const ra = richness(a), rb = richness(b);
      if (ra !== rb) return rb - ra;     // 信息更丰富的优先保留
      return a.id - b.id;                // 信息相同则保留较早创建的
    });
    const keep = arr[0];
    const dupList = arr.slice(1);
    dupList.forEach(d => {
      const item = { kept_id: keep.id, removed_id: d.id, kept_name: keep.name, removed_name: d.name, kept_code: keep.code, removed_code: d.code };
      if (doApply) {
        // 迁移关联数据到保留记录
        prodTable.all().forEach(p => { if (p.supplier_id === d.id) prodTable.update(p.id, { supplier_id: keep.id, updated_at: now() }); });
        evalTable.all().forEach(e => { if (e.supplier_id === d.id) evalTable.update(e.id, { supplier_id: keep.id }); });
        imgTable.all().forEach(i => { if (i.supplier_id === d.id) imgTable.update(i.id, { supplier_id: keep.id }); });
        docTable.all().forEach(dd => { if (dd.supplier_id === d.id) docTable.update(dd.id, { supplier_id: keep.id, updated_at: now() }); });
        // 补全保留记录缺失的字段（从被删记录取值）
        ['contact', 'phone', 'email', 'address', 'category', 'supply_materials', 'code'].forEach(f => {
          if (!keep[f] && d[f]) { keep[f] = d[f]; }
        });
        supTable.update(keep.id, keep);
        supTable.delete(d.id);
        removed++;
      }
      results.push(item);
    });
  });

  res.json({
    message: doApply
      ? `去重完成：合并删除 ${removed} 条重复供应商`
      : `发现 ${results.length} 组疑似重复（共 ${results.length} 条冗余）`,
    applied: doApply,
    removed_count: removed,
    duplicate_groups: results.length,
    duplicates: results
  });
});

module.exports = router;