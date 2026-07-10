const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

ensureTable('spec_sheets');
ensureTable('config_sheets');
ensureTable('inquiries');
ensureTable('product_configs');

function getInquiryInfo(inquiryId) {
  const inquiryTable = getTable('inquiries');
  const inq = inquiryTable.findById(inquiryId);
  return inq;
}

function enrichSheet(sheet) {
  if (!sheet) return null;
  const inq = getInquiryInfo(sheet.inquiry_id);
  return {
    ...sheet,
    customer_name: inq ? inq.customer_name : '',
    external_model: inq ? inq.external_model : (sheet.model_no || sheet.model || ''),
    product_name: inq ? inq.product_name : (sheet.description || ''),
    sales_person: inq ? inq.sales_person : '',
    serial_number: inq ? inq.serial_number : ''
  };
}

// ===== 规格书库 =====
router.get('/spec-sheets', requirePerm('spec:view'), (req, res) => {
  const table = getTable('spec_sheets');
  let sheets = table.all().map(enrichSheet);

  const { keyword, status, page = 1, limit = 20 } = req.query;
  if (keyword) {
    const kw = keyword.toLowerCase();
    sheets = sheets.filter(s =>
      (s.model_no || '').toLowerCase().includes(kw) ||
      (s.description || '').toLowerCase().includes(kw) ||
      (s.customer_name || '').toLowerCase().includes(kw) ||
      (s.serial_number || '').toLowerCase().includes(kw)
    );
  }
  if (status) {
    sheets = sheets.filter(s => s.status === status);
  }

  const total = sheets.length;
  const p = Number(page);
  const l = Number(limit);
  const records = sheets.slice((p - 1) * l, p * l);
  res.json({ records, total, page: p, limit: l });
});

router.get('/spec-sheets/:id', requirePerm('spec:view'), (req, res) => {
  const table = getTable('spec_sheets');
  const sheet = table.findById(req.params.id);
  if (!sheet) return res.status(404).json({ error: '规格书不存在' });
  res.json(enrichSheet(sheet));
});

router.put('/spec-sheets/:id', requirePerm('spec:manage'), (req, res) => {
  const table = getTable('spec_sheets');
  const sheet = table.findById(req.params.id);
  if (!sheet) return res.status(404).json({ error: '规格书不存在' });
  const fields = req.body;
  fields.updated_at = now();
  table.update(sheet.id, fields);
  res.json(enrichSheet(table.findById(sheet.id)));
});

router.delete('/spec-sheets/:id', requirePerm('spec:delete'), (req, res) => {
  const table = getTable('spec_sheets');
  const result = table.delete(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '规格书不存在' });
  res.json({ success: true });
});

// ===== 配置表库 =====
router.get('/config-sheets', requirePerm('config-lib:view'), (req, res) => {
  const table = getTable('config_sheets');
  let sheets = table.all().map(enrichSheet);

  const { keyword, status, page = 1, limit = 20 } = req.query;
  if (keyword) {
    const kw = keyword.toLowerCase();
    sheets = sheets.filter(s =>
      (s.model || '').toLowerCase().includes(kw) ||
      (s.customer_name || '').toLowerCase().includes(kw) ||
      (s.serial_number || '').toLowerCase().includes(kw)
    );
  }
  if (status) {
    sheets = sheets.filter(s => s.status === status);
  }

  const total = sheets.length;
  const p = Number(page);
  const l = Number(limit);
  const records = sheets.slice((p - 1) * l, p * l);
  res.json({ records, total, page: p, limit: l });
});

router.get('/config-sheets/:id', requirePerm('config-lib:view'), (req, res) => {
  const table = getTable('config_sheets');
  const sheet = table.findById(req.params.id);
  if (!sheet) return res.status(404).json({ error: '配置表不存在' });
  res.json(enrichSheet(sheet));
});

router.put('/config-sheets/:id', requirePerm('config-lib:manage'), (req, res) => {
  const table = getTable('config_sheets');
  const sheet = table.findById(req.params.id);
  if (!sheet) return res.status(404).json({ error: '配置表不存在' });
  const fields = req.body;
  fields.updated_at = now();
  table.update(sheet.id, fields);
  res.json(enrichSheet(table.findById(sheet.id)));
});

router.delete('/config-sheets/:id', requirePerm('config-lib:delete'), (req, res) => {
  const table = getTable('config_sheets');
  const result = table.delete(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '配置表不存在' });
  res.json({ success: true });
});

// ===== 批量导出规格书 =====
router.post('/batch-export-spec', requirePerm('spec:view'), (req, res) => {
  const { ids, format } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要导出的规格书' });
  }

  const table = getTable('spec_sheets');
  const sheets = ids.map(id => table.findById(Number(id))).filter(Boolean);

  if (sheets.length === 0) {
    return res.status(404).json({ error: '未找到选中的规格书' });
  }

  if (format === 'pdf') {
    batchExportSpecPDF(sheets, res);
  } else {
    batchExportSpecXLSX(sheets, res);
  }
});

function batchExportSpecXLSX(sheets, res) {
  const wb = XLSX.utils.book_new();

  sheets.forEach(sheet => {
    const inq = getInquiryInfo(sheet.inquiry_id);
    const sheetName = (sheet.model_no || '规格书').replace(/[\\\/\?\*\[\]]/g, '_').substring(0, 31);

    const rows = [
      ['', '', '', '', '', '', ''],
      ['', '', '', '', '', '', ''],
      ['产品规格书 SPECIFICATIONS', '', '', '', '', '', ''],
      ['', '', '', '', '           表格编号（File No.）：' + (sheet.file_no || 'HJ/ED/R-21'), '', ''],
      ['产 品 类 型 （Description）', '', sheet.description || '/', '', '版 本 （Version ）', sheet.version || 'B/1', ''],
      ['产 品 型 号 （Model No.）', '', sheet.model_no || '/', '', '日 期 （Date）', new Date().toISOString().slice(0, 10).replace(/-/g, '.'), ''],
      ['产 品 规 格 表 （Technical Parameters）', '', '', '配光曲线图 Lighting Distribution', '', '', ''],
      ['光源  （Light Source）：', sheet.light_source || '/', '', '', '', '', ''],
      ['系统功率 （Power）：', sheet.power || '/', '', '', '', '', ''],
      ['输入输出电压 （Input Voltage）：', sheet.input_voltage || '/', '', '', '', '', ''],
      ['功率因素 （Power Efficiency）：', sheet.power_efficiency || '/', '', '', '', '', ''],
      ['发光角度 （Beam Angle）：', sheet.beam_angle || '/', '', '', '', '', ''],
      ['有效光通量 （Luminous Flux）：', sheet.luminous_flux || '/', '', '', '', '', ''],
      ['色温 （CCT）：', sheet.cct || '/', '', '', '', '', ''],
      ['显色指数 （RA）：', sheet.ra || '/', '', '', '', '', ''],
      ['工作环境温度 （Ta）：', sheet.ta || '/', '', '', '', '', ''],
      ['灯具寿命（Life Time）：', sheet.life_time || '/', '', '', '', '', ''],
      ['IP 等级（IP Rating）：', sheet.ip_rating || '/', '', '产品外型图Picture', '', '', ''],
      ['灯壳材质', sheet.shell_material || '/', '', '', '', '', ''],
      ['反光罩材质', sheet.reflector_material || '/', '', '', '', '', ''],
      ['电池容量（Battery capacity ）：', sheet.battery_capacity || '/', '', '', '', '', ''],
      ['连续放电时间（Continuous discharge time）：', sheet.discharge_time || '/', '', '', '', '', ''],
      ['充电时间（Charging time）：', sheet.charging_time || '/', '', '', '', '', ''],
      ['开关（Switch）：', sheet.switch_type || '/', '', '', '', '', ''],
      ['产品尺寸 （Dimension）：', sheet.dimension || '/', '', '', '', '', ''],
      ['产品重量 （Net Weight）：', sheet.net_weight || '/', '', '', '', '', ''],
      ['白盒尺寸 （Size of Inbox）：', sheet.inbox_size || '/', '', '', '', '', ''],
      ['外箱尺寸 （Size of Carton）：', sheet.carton_size || '/', '', '', '', '', ''],
      ['单箱毛净重（G.W & N.W.）', sheet.gw_nw || '/', '', '', '', '', ''],
      ['电缆线规格', sheet.cable_spec || '/', '', '', '', '', ''],
      ['产品尺寸图:Dimension:', '', '', '', '', '', ''],
      ['', '', '', '', '', '', ''],
      ['制作                                                    审核                                                                                              审批', '', '', '', '', '', '']
    ];

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 28 }, { wch: 8 }, { wch: 20 }, { wch: 22 }, { wch: 22 }, { wch: 14 }, { wch: 10 }];
    ws['!merges'] = [
      { s: { r: 2, c: 0 }, e: { r: 2, c: 6 } },
      { s: { r: 3, c: 4 }, e: { r: 3, c: 6 } },
      { s: { r: 6, c: 0 }, e: { r: 6, c: 2 } },
      { s: { r: 6, c: 3 }, e: { r: 6, c: 6 } },
      { s: { r: 17, c: 4 }, e: { r: 17, c: 6 } },
      { s: { r: 30, c: 0 }, e: { r: 30, c: 6 } },
      { s: { r: 32, c: 0 }, e: { r: 32, c: 6 } }
    ];
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('规格书批量导出.xlsx'));
  res.send(buf);
}

function batchExportSpecPDF(sheets, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('规格书批量导出.pdf'));
  doc.pipe(res);

  const fontCandidates = [
    path.join(__dirname, '..', 'fonts', 'SimHei.ttf'),
    path.join(__dirname, '..', 'fonts', 'SimSun.ttf'),
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simfang.ttf'
  ];
  let hasChineseFont = false;
  let fontPath = '';
  for (const fp of fontCandidates) {
    if (fs.existsSync(fp)) { fontPath = fp; hasChineseFont = true; break; }
  }
  if (hasChineseFont) doc.registerFont('Chinese', fontPath);
  const fn = hasChineseFont ? 'Chinese' : 'Helvetica';
  const fnBold = hasChineseFont ? 'Chinese' : 'Helvetica-Bold';

  sheets.forEach((sheet, idx) => {
    if (idx > 0) doc.addPage();

    const labelW = 160;
    const leftCol = 280;
    const rowH = 22;
    const valueW = leftCol - labelW;

    doc.font(fnBold).fontSize(16).text('产品规格书 SPECIFICATIONS', { align: 'center' });
    doc.moveDown(0.3);
    doc.font(fn).fontSize(9).text('表格编号（File No.）：' + (sheet.file_no || 'HJ/ED/R-21'), { align: 'right' });
    doc.moveDown(0.5);

    const infoY = doc.y;
    doc.font(fn).fontSize(9);
    doc.text('产 品 类 型 （Description）', 40, infoY, { width: labelW });
    doc.text(sheet.description || '/', 40 + labelW, infoY, { width: valueW });
    doc.text('版 本 （Version ）', 40 + leftCol, infoY, { width: 80 });
    doc.text(sheet.version || 'B/1', 40 + leftCol + 80, infoY);
    const infoY2 = infoY + rowH;
    doc.text('产 品 型 号 （Model No.）', 40, infoY2, { width: labelW });
    doc.text(sheet.model_no || '/', 40 + labelW, infoY2, { width: valueW });
    doc.text('日 期 （Date）', 40 + leftCol, infoY2, { width: 80 });
    doc.text(new Date().toISOString().slice(0, 10).replace(/-/g, '.'), 40 + leftCol + 80, infoY2);
    doc.y = infoY2 + rowH + 5;

    doc.font(fnBold).fontSize(10).text('产 品 规 格 表 （Technical Parameters）', 40, doc.y, { width: leftCol });
    const tableTop = doc.y + 18;

    const specRows = [
      ['光源  （Light Source）：', sheet.light_source || '/'],
      ['系统功率 （Power）：', sheet.power || '/'],
      ['输入输出电压 （Input Voltage）：', sheet.input_voltage || '/'],
      ['功率因素 （Power Efficiency）：', sheet.power_efficiency || '/'],
      ['发光角度 （Beam Angle）：', sheet.beam_angle || '/'],
      ['有效光通量 （Luminous Flux）：', sheet.luminous_flux || '/'],
      ['色温 （CCT）：', sheet.cct || '/'],
      ['显色指数 （RA）：', sheet.ra || '/'],
      ['工作环境温度 （Ta）：', sheet.ta || '/'],
      ['灯具寿命（Life Time）：', sheet.life_time || '/'],
      ['IP 等级（IP Rating）：', sheet.ip_rating || '/'],
      ['灯壳材质', sheet.shell_material || '/'],
      ['反光罩材质', sheet.reflector_material || '/'],
      ['电池容量（Battery capacity ）：', sheet.battery_capacity || '/'],
      ['连续放电时间（Discharge time）：', sheet.discharge_time || '/'],
      ['充电时间（Charging time）：', sheet.charging_time || '/'],
      ['开关（Switch）：', sheet.switch_type || '/'],
      ['产品尺寸 （Dimension）：', sheet.dimension || '/'],
      ['产品重量 （Net Weight）：', sheet.net_weight || '/'],
      ['白盒尺寸 （Size of Inbox）：', sheet.inbox_size || '/'],
      ['外箱尺寸 （Size of Carton）：', sheet.carton_size || '/'],
      ['单箱毛净重（G.W & N.W.）', sheet.gw_nw || '/'],
      ['电缆线规格', sheet.cable_spec || '/']
    ];

    doc.font(fn).fontSize(8);
    let curY = tableTop;
    specRows.forEach(([label, value]) => {
      doc.text(label, 45, curY, { width: labelW - 10 });
      doc.text(value, 45 + labelW, curY, { width: leftCol - labelW - 10 });
      curY += rowH;
    });

    doc.y = curY + 10;
    doc.font(fn).fontSize(9).text('产品尺寸图:Dimension:', 40, doc.y);
    doc.moveDown(1.5);
    doc.font(fn).fontSize(9).text('制作                    审核                    审批', 40, doc.y);
  });

  doc.end();
}

// ===== 批量导出配置表 =====
router.post('/batch-export-config', requirePerm('config-lib:view'), (req, res) => {
  const { ids, format } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要导出的配置表' });
  }

  const table = getTable('config_sheets');
  const sheets = ids.map(id => table.findById(Number(id))).filter(Boolean);

  if (sheets.length === 0) {
    return res.status(404).json({ error: '未找到选中的配置表' });
  }

  if (format === 'pdf') {
    batchExportConfigPDF(sheets, res);
  } else {
    batchExportConfigXLSX(sheets, res);
  }
});

function batchExportConfigXLSX(sheets, res) {
  const wb = XLSX.utils.book_new();

  sheets.forEach(sheet => {
    const inq = getInquiryInfo(sheet.inquiry_id);
    const sheetName = (sheet.model || inq?.external_model || '配置表').replace(/[\\\/\?\*\[\]]/g, '_').substring(0, 31);
    const v = (field) => sheet[field] || '/';

    const rows = [
      ['宁波恒剑光电科技有限公司\n配置表', '', '', ''],
      ['型号：', '', inq?.external_model || sheet.model || '/', ''],
      ['序号', '配置明细', '', ''],
      ['1、结构', '1.1、壳体材质', v('shell_material'), ''],
      ['', '1.2、反光罩材质', v('reflector_material'), ''],
      ['', '1.3、支架', v('bracket'), ''],
      ['', '1.4、手杆', v('handle_bar'), ''],
      ['', '1.5、防水等级', v('waterproof'), ''],
      ['', '1.6、电缆线规格', v('cable_spec'), ''],
      ['', '1.7、螺丝材质', v('screw_material'), ''],
      ['', '1.8、玻璃', v('glass'), ''],
      ['2、电子技术参数', '2.1、光参数(LM)', v('luminous_flux'), ''],
      ['', '2.2、补偿后光参数（LM）', v('compensated_flux'), ''],
      ['', '2.3、光效（LM/W）', v('light_efficiency'), ''],
      ['', '2.4、电参数', v('electrical_params'), ''],
      ['', '2.5、色温(K)', v('cct'), ''],
      ['', '2.6、显指（RA)', v('ra'), ''],
      ['', '2.7、灯珠数量', v('led_count'), ''],
      ['', '2.8、标称功率', v('rated_power'), ''],
      ['', '2.9、芯片方案', v('chip_solution'), ''],
      ['', '2.10、电路板型号', v('pcb_model'), ''],
      ['', '2.11、电池容量', v('battery_capacity'), ''],
      ['', '2.12、放电时间（h）', v('discharge_time'), ''],
      ['', '2.13、充电时间（h）', v('charging_time'), ''],
      ['3、包装', '3.1、内包', v('inner_pack'), ''],
      ['', '3.2、外包', v('outer_pack'), ''],
      ['', '3.3、运输要求', v('transport_req'), ''],
      ['', '3.4、其他', v('pack_other'), ''],
      ['4、证书', '4.1、认证需求', v('cert_need'), ''],
      ['5、特殊需求', '5.1、环保要求', v('env_req'), ''],
      ['', '5.2、UV测试', v('uv_test'), ''],
      ['', '5.3、盐雾测试', v('salt_spray'), ''],
      ['', '5.4、其他', v('special_other'), '']
    ];

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 18 }, { wch: 24 }, { wch: 30 }, { wch: 10 }];
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 1 } },
      { s: { r: 1, c: 2 }, e: { r: 1, c: 3 } },
      { s: { r: 3, c: 0 }, e: { r: 10, c: 0 } },
      { s: { r: 11, c: 0 }, e: { r: 23, c: 0 } },
      { s: { r: 24, c: 0 }, e: { r: 27, c: 0 } },
      { s: { r: 28, c: 0 }, e: { r: 28, c: 0 } },
      { s: { r: 29, c: 0 }, e: { r: 32, c: 0 } }
    ];
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('配置表批量导出.xlsx'));
  res.send(buf);
}

function batchExportConfigPDF(sheets, res) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('配置表批量导出.pdf'));
  doc.pipe(res);

  const fontCandidates = [
    path.join(__dirname, '..', 'fonts', 'SimHei.ttf'),
    path.join(__dirname, '..', 'fonts', 'SimSun.ttf'),
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simfang.ttf'
  ];
  let hasChineseFont = false;
  let fontPath = '';
  for (const fp of fontCandidates) {
    if (fs.existsSync(fp)) { fontPath = fp; hasChineseFont = true; break; }
  }
  if (hasChineseFont) doc.registerFont('Chinese', fontPath);
  const fn = hasChineseFont ? 'Chinese' : 'Helvetica';
  const fnBold = hasChineseFont ? 'Chinese' : 'Helvetica-Bold';

  const pageW = doc.page.width - 80;
  const col1 = 80;
  const col2 = 160;
  const rowH = 20;

  const CONFIG_SECTIONS = [
    { title: '1、结构', items: [
      { key: 'shell_material', label: '1.1、壳体材质' },
      { key: 'reflector_material', label: '1.2、反光罩材质' },
      { key: 'bracket', label: '1.3、支架' },
      { key: 'handle_bar', label: '1.4、手杆' },
      { key: 'waterproof', label: '1.5、防水等级' },
      { key: 'cable_spec', label: '1.6、电缆线规格' },
      { key: 'screw_material', label: '1.7、螺丝材质' },
      { key: 'glass', label: '1.8、玻璃' }
    ]},
    { title: '2、电子技术参数', items: [
      { key: 'luminous_flux', label: '2.1、光参数(LM)' },
      { key: 'compensated_flux', label: '2.2、补偿后光参数（LM）' },
      { key: 'light_efficiency', label: '2.3、光效（LM/W）' },
      { key: 'electrical_params', label: '2.4、电参数' },
      { key: 'cct', label: '2.5、色温(K)' },
      { key: 'ra', label: '2.6、显指（RA)' },
      { key: 'led_count', label: '2.7、灯珠数量' },
      { key: 'rated_power', label: '2.8、标称功率' },
      { key: 'chip_solution', label: '2.9、芯片方案' },
      { key: 'pcb_model', label: '2.10、电路板型号' },
      { key: 'battery_capacity', label: '2.11、电池容量' },
      { key: 'discharge_time', label: '2.12、放电时间（h）' },
      { key: 'charging_time', label: '2.13、充电时间（h）' }
    ]},
    { title: '3、包装', items: [
      { key: 'inner_pack', label: '3.1、内包' },
      { key: 'outer_pack', label: '3.2、外包' },
      { key: 'transport_req', label: '3.3、运输要求' },
      { key: 'pack_other', label: '3.4、其他' }
    ]},
    { title: '4、证书', items: [
      { key: 'cert_need', label: '4.1、认证需求' }
    ]},
    { title: '5、特殊需求', items: [
      { key: 'env_req', label: '5.1、环保要求' },
      { key: 'uv_test', label: '5.2、UV测试' },
      { key: 'salt_spray', label: '5.3、盐雾测试' },
      { key: 'special_other', label: '5.4、其他' }
    ]}
  ];

  sheets.forEach((sheet, idx) => {
    if (idx > 0) doc.addPage();
    const inq = getInquiryInfo(sheet.inquiry_id);

    doc.font(fnBold).fontSize(14).text('宁波恒剑光电科技有限公司', { align: 'center' });
    doc.font(fnBold).fontSize(12).text('配置表', { align: 'center' });
    doc.moveDown(0.5);
    doc.font(fn).fontSize(10).text(`型号：${inq?.external_model || sheet.model || '-'}`, 40);
    doc.moveDown(0.5);

    let curY = doc.y;
    doc.font(fn).fontSize(8);

    CONFIG_SECTIONS.forEach(sec => {
      const secH = sec.items.length * rowH;
      if (curY + secH + 10 > doc.page.height - 60) {
        doc.addPage();
        curY = 40;
      }
      doc.rect(40, curY, col1, secH).stroke();
      doc.font(fnBold).fontSize(8).text(sec.title, 42, curY + 4, { width: col1 - 4 });

      sec.items.forEach((item, i) => {
        const itemY = curY + i * rowH;
        doc.rect(40 + col1, itemY, col2, rowH).stroke();
        doc.font(fn).fontSize(8).text(item.label, 42 + col1, itemY + 4, { width: col2 - 4 });
        doc.rect(40 + col1 + col2, itemY, pageW - col1 - col2, rowH).stroke();
        doc.text(sheet[item.key] || '/', 42 + col1 + col2, itemY + 4, { width: pageW - col1 - col2 - 4 });
      });

      curY += secH;
    });
  });

  doc.end();
}

module.exports = router;
