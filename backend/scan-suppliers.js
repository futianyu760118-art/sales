/**
 * 供应商资料识别导入脚本
 * 扫描 supplier_documents 中未关联的资料文件
 * 对图片执行OCR提取供应商信息 → 自动创建供应商 → 关联资料
 * 
 * 用法: node scan-suppliers.js [--apply]
 *   不带 --apply: 仅扫描预览，不写入
 *   带 --apply:   实际执行创建和关联
 */
const path = require('path');
const fs = require('fs');

// 加载数据库表（复用系统的JSON数据库）
const DB_DIR = path.join(__dirname, '..', 'database');
function loadTable(name) {
  const fp = path.join(DB_DIR, name + '.json');
  if (!fs.existsSync(fp)) return { records: [], nextId: 1 };
  const raw = fs.readFileSync(fp, 'utf8');
  try { return JSON.parse(raw); } catch(e) { return { records: [], nextId: 1 }; }
}
function saveTable(name, data) {
  const fp = path.join(DB_DIR, name + '.json');
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
}
function insertRecord(table, record) {
  record.id = table.nextId;
  table.records.push(record);
  table.nextId++;
  return record.id;
}
function updateRecord(table, id, fields) {
  const r = table.records.find(x => x.id === id);
  if (r) Object.assign(r, fields);
}

// 生成 BYGY.xxx 代码
function genCode(suppliers) {
  let max = 0;
  suppliers.records.forEach(s => {
    const m = (s.code || '').match(/^BYGY\.(\d+)$/i);
    if (m) { const n = parseInt(m[1]); if (n > max) max = n; }
  });
  return 'BYGY.' + String(max + 1).padStart(3, '0');
}

// 从OCR文本中提取供应商信息
function extractFromText(text) {
  if (!text || !text.trim()) return null;
  const phones = text.match(/1[3-9]\d{9}/g) || [];
  const landlines = text.match(/0\d{2,3}-?\d{7,8}/g) || [];
  const allPhones = [...new Set([...phones, ...landlines])];
  const emails = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
  // 公司名称
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  const nameLine = lines.find(l => /公司|有限|厂|集团|科技|电子|五金|包装|塑料|照明|电器|贸易|实业|金属/.test(l));
  // 地址
  const addrLine = lines.find(l => /路|街|号|区|市|省|镇|村|工业|大道|大厦/.test(l) && l.length > 4);
  // 联系人
  const contactLine = lines.find(l => /联系人|经办人|代表|经理|主任|先生|女士/.test(l));
  const contactMatch = contactLine ? contactLine.match(/[:：]\s*(.+?)[\s,，]/) : null;
  // 税号
  const taxMatch = text.match(/[0-9A-Z]{15,20}/);
  // 银行账号
  const bankMatch = text.match(/\d{16,19}/);

  return {
    name: nameLine ? nameLine.replace(/^[:：\s]+/, '').substring(0, 50) : '',
    phone: allPhones[0] || '',
    phone2: allPhones[1] || '',
    email: emails[0] || '',
    address: addrLine ? addrLine.substring(0, 100) : '',
    contact: contactMatch ? contactMatch[1].trim() : '',
    tax_id: taxMatch ? taxMatch[0] : '',
    bank_account: bankMatch ? bankMatch[0] : '',
    raw_text: text.substring(0, 300)
  };
}

async function runOCR(filePath) {
  const Tesseract = require('tesseract.js');
  const tessDir = path.join(__dirname);
  let text = '';
  // 英文先识别
  try {
    const r = await Tesseract.recognize(filePath, 'eng', { logger: () => {}, langPath: tessDir });
    text += (r.data.text || '').trim();
  } catch (e) {}
  // 中文识别
  try {
    const r2 = await Tesseract.recognize(filePath, 'chi_sim', { logger: () => {}, langPath: tessDir });
    text += '\n' + (r2.data.text || '').trim();
  } catch (e) {}
  return text;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log('=====================================');
  console.log('  供应商资料识别导入脚本');
  console.log('  模式: ' + (apply ? '★ 执行模式(写入)' : '○ 预览模式(不写入)'));
  console.log('=====================================\n');

  const docs = loadTable('supplier_documents');
  const suppliers = loadTable('suppliers');
  const existingNames = new Set(suppliers.records.map(s => s.name));

  // 找未关联的图片资料
  const imageExts = ['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp'];
  const unlinked = docs.records.filter(d =>
    d.supplier_id === null &&
    imageExts.includes((d.file_type || '').toLowerCase()) &&
    fs.existsSync(d.file_path)
  );

  console.log('资料总数: ' + docs.records.length);
  console.log('未关联图片: ' + unlinked.length + '\n');

  if (unlinked.length === 0) {
    console.log('没有需要识别的未关联图片资料。');
    return;
  }

  const results = [];
  let processed = 0;

  for (const doc of unlinked) {
    processed++;
    console.log('[' + processed + '/' + unlinked.length + '] ' + doc.file_name);
    console.log('  OCR识别中...');

    try {
      const text = await runOCR(doc.file_path);
      const info = extractFromText(text);

      if (!info || !info.name) {
        console.log('  ✗ 未识别到公司名称');
        results.push({ doc_id: doc.id, file: doc.file_name, status: 'no_name', info });
        continue;
      }

      if (existingNames.has(info.name)) {
        console.log('  ⊙ 已存在: ' + info.name);
        const existing = suppliers.records.find(s => s.name === info.name);
        if (apply) {
          updateRecord(docs, doc.id, { supplier_id: existing.id });
          existingNames.add(info.name);
        }
        results.push({ doc_id: doc.id, file: doc.file_name, status: 'exists', supplier_id: existing.id, info });
        continue;
      }

      // 创建新供应商
      const code = genCode(suppliers);
      console.log('  ✓ 提取到: ' + info.name);
      console.log('    代码: ' + code);
      console.log('    电话: ' + (info.phone || '-'));
      console.log('    邮箱: ' + (info.email || '-'));
      console.log('    地址: ' + (info.address || '-'));

      if (apply) {
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const newId = insertRecord(suppliers, {
          name: info.name, code, contact: info.contact || '', phone: info.phone || '',
          email: info.email || '', address: info.address || '', category: '', level: 'C',
          lifecycle_status: 'reviewing', risk_level: 'medium', supply_materials: '',
          remarks: '脚本OCR识别导入', tax_id: info.tax_id || '', bank_account: info.bank_account || '',
          payment_method: '', payment_cycle: '', quality_score: 0, delivery_score: 0,
          price_score: 0, service_score: 0, overall_score: 0,
          created_at: ts, updated_at: ts
        });
        updateRecord(docs, doc.id, { supplier_id: newId });
        existingNames.add(info.name);
        console.log('  → 已创建供应商 #' + newId + ' 并关联资料');
        results.push({ doc_id: doc.id, file: doc.file_name, status: 'created', supplier_id: newId, code, info });
      } else {
        console.log('  → (预览模式，未写入)');
        results.push({ doc_id: doc.id, file: doc.file_name, status: 'preview', code, info });
      }
    } catch (e) {
      console.log('  ✗ OCR失败: ' + e.message);
      results.push({ doc_id: doc.id, file: doc.file_name, status: 'error', error: e.message });
    }
    console.log('');
  }

  // 保存
  if (apply) {
    saveTable('suppliers', suppliers);
    saveTable('supplier_documents', docs);
    console.log('★ 数据已写入');
  }

  // 汇总
  const created = results.filter(r => r.status === 'created').length;
  const exists = results.filter(r => r.status === 'exists').length;
  const noName = results.filter(r => r.status === 'no_name').length;
  const errors = results.filter(r => r.status === 'error').length;
  console.log('=====================================');
  console.log('  汇总');
  console.log('=====================================');
  console.log('  处理: ' + results.length);
  console.log('  新建供应商: ' + created);
  console.log('  已存在(关联): ' + exists);
  console.log('  未识别到名称: ' + noName);
  console.log('  失败: ' + errors);
  if (!apply) console.log('\n  这是预览结果。加 --apply 参数执行实际导入:');
  if (!apply) console.log('  node scan-suppliers.js --apply');
}

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });
