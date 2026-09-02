const express = require('express');
const logger = require('../lib/logger');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const XLSX = require('xlsx');

ensureTable('product_configs');

// multer配置：内存存储
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .xlsx/.xls 格式文件'));
    }
  }
});

// ===== 配置表列表 =====
router.get('/', requirePerm('config:view'), (req, res) => {
  const { page = 1, limit = 15, keyword, model, status } = req.query;
  const table = getTable('product_configs');
  const filter = (r) => {
    if (model && !(r.model || '').includes(model)) return false;
    if (status && r.status !== status) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.model, r.certificate_compliant, r.certificate_level,
        r.structure_shell, r.structure_reflector, r.structure_bracket,
        r.elec_luminous, r.elec_color_temp, r.elec_power,
        r.pack_inner, r.pack_outer, r.certificate_required,
        r.special_env, r.special_uv, r.special_salt
      ].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const { records, total } = table.findWhere(filter, 'created_at', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 下载配置表导入模板 =====
router.get('/template/download', requirePerm('config:view'), (req, res) => {
  const rows = [
    ['宁波恒剑光电科技有限公司\n配置表', '', '', ''],
    ['型号：', '', '', ''],
    ['序号', '配置明细', '', ''],
    ['1、结构', '1.1、壳体材质', '', ''],
    ['', '1.2、反光罩材质', '', ''],
    ['', '1.3、支架', '', ''],
    ['', '1.4、手杆', '', ''],
    ['', '1.5、防水等级', '', ''],
    ['', '1.6、电缆线规格', '', ''],
    ['', '1.7、螺丝材质', '', ''],
    ['', '1.8、玻璃', '', ''],
    ['2、电子技术参数', '2.1、光参数(LM)', '', ''],
    ['', '2.2、补偿后光参数（LM）', '', ''],
    ['', '2.3、光效（LM/W）', '', ''],
    ['', '2.4、电参数', '', ''],
    ['', '2.5、色温(K)', '', ''],
    ['', '2.6、显指（RA)', '', ''],
    ['', '2.7、灯珠数量', '', ''],
    ['', '2.8、标称功率', '', ''],
    ['', '2.9、芯片方案', '', ''],
    ['', '2.10、电路板型号', '', ''],
    ['', '2.11、电池容量', '', ''],
    ['', '2.12、放电时间（h）', '', ''],
    ['', '2.13、充电时间（h）', ''],
    ['3、包装', '3.1、内包', '', ''],
    ['', '3.2、外包', '', ''],
    ['', '3.3、运输要求', '', ''],
    ['', '3.4、其他', '', ''],
    ['4、证书', '4.1、认证需求', '', ''],
    ['5、特殊需求', '5.1、环保要求', '', ''],
    ['', '5.2、UV测试', '', ''],
    ['', '5.3、盐雾测试', '', ''],
    ['', '5.4、其他', '', ''],
    [' 制作:                                                                   审核：                                                       审批:  ', '', '', '']
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = [
    { s: { c: 0, r: 0 }, e: { c: 2, r: 0 } },
    { s: { c: 0, r: 1 }, e: { c: 1, r: 1 } },
    { s: { c: 0, r: 3 }, e: { c: 0, r: 10 } },
    { s: { c: 0, r: 11 }, e: { c: 0, r: 23 } },
    { s: { c: 0, r: 24 }, e: { c: 0, r: 27 } },
    { s: { c: 0, r: 28 }, e: { c: 0, r: 28 } },
    { s: { c: 0, r: 29 }, e: { c: 0, r: 32 } },
    { s: { c: 0, r: 33 }, e: { c: 2, r: 33 } }
  ];
  ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 30 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws, '配置表');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('核价配置表模板.xlsx'));
  res.send(buf);
});

// ===== 导入Excel配置表（直接上传文件） =====
router.post('/import-xlsx', requirePerm('config:create'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    const model = data[1] ? (data[1][2] || '') : '';
    if (!model) return res.status(400).json({ error: '无法从模板中解析型号' });

    const configTable = getTable('product_configs');

    const record = {
      inquiry_id: null,
      model,
      structure_shell: data[3] ? data[3][2] : '',
      structure_reflector: data[4] ? data[4][2] : '',
      structure_bracket: data[5] ? data[5][2] : '',
      structure_handle: data[6] ? data[6][2] : '',
      structure_waterproof: data[7] ? data[7][2] : '',
      structure_cable: data[8] ? data[8][2] : '',
      structure_screw: data[9] ? data[9][2] : '',
      structure_glass: data[10] ? data[10][2] : '',
      elec_luminous: data[11] ? data[11][2] : '',
      elec_luminous_comp: data[12] ? data[12][2] : '',
      elec_efficiency: data[13] ? data[13][2] : '',
      elec_param: data[14] ? data[14][2] : '',
      elec_color_temp: data[15] ? data[15][2] : '',
      elec_ra: data[16] ? data[16][2] : '',
      elec_led_count: data[17] ? data[17][2] : '',
      elec_rated_power: data[18] ? data[18][2] : '',
      elec_chip: data[19] ? data[19][2] : '',
      elec_board_model: data[20] ? data[20][2] : '',
      elec_battery: data[21] ? data[21][2] : '',
      elec_discharge_time: data[22] ? data[22][2] : '',
      elec_charge_time: data[23] ? data[23][2] : '',
      pack_inner: data[24] ? data[24][2] : '',
      pack_outer: data[25] ? data[25][2] : '',
      pack_transport: data[26] ? data[26][2] : '',
      pack_other: data[27] ? data[27][2] : '',
      certificate_required: data[28] ? data[28][2] : '',
      certificate_compliant: data[28] ? data[28][2] : '',
      certificate_level: '',
      special_env: data[29] ? data[29][2] : '',
      special_uv: data[30] ? data[30][2] : '',
      special_salt: data[31] ? data[31][2] : '',
      special_other: data[32] ? data[32][2] : '',
      bom_details: '[]',
      pricing_data: null,
      status: 'imported',
      created_at: now(),
      updated_at: now()
    };

    const result = configTable.insert(record);
    res.json({ message: '配置表导入成功', id: result.lastID, model });
  } catch (e) {
    logger.error('导入配置表失败:', e);
    res.status(500).json({ error: '导入失败: ' + e.message });
  }
});

// ===== 批量导入产品配置表（报价配置表横向格式，每行一个产品）- 必须在 /:id 之前 =====
router.post('/batch-import-xlsx', requirePerm('config:create'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (data.length < 2) return res.status(400).json({ error: '文件为空或无数据行' });

    // 检测表头格式：横向表头（报价配置表格式）
    const header = data[0] || [];
    const headerStr = header.join(',');

    // 报价配置表横向格式的列映射
    const colMap = {};
    const colDefs = [
      { keys: ['产品型号'], field: 'model' },
      { keys: ['产品名称'], field: 'product_name' },
      { keys: ['功率'], field: 'elec_rated_power' },
      { keys: ['输入电压'], field: 'elec_param' },
      { keys: ['电池'], field: 'elec_battery' },
      { keys: ['色温'], field: 'elec_color_temp' },
      { keys: ['光通量', '光效'], field: 'elec_luminous' },
      { keys: ['光源'], field: 'elec_chip' },
      { keys: ['主体'], field: 'structure_shell' },
      { keys: ['压框'], field: 'structure_handle' },
      { keys: ['灯罩'], field: 'structure_glass' },
      { keys: ['反光罩'], field: 'structure_reflector' },
      { keys: ['电缆线'], field: 'structure_cable' },
      { keys: ['开关'], field: 'structure_bracket' },
      { keys: ['USB'], field: 'elec_board_model' },
      { keys: ['防水等级'], field: 'structure_waterproof' },
      { keys: ['感应器'], field: 'special_other' },
      { keys: ['其他要求1', '其他要求'], field: 'special_env' },
      { keys: ['其他要求2'], field: 'special_uv' },
      { keys: ['报价'], field: 'reference_price' }
    ];

    header.forEach((h, idx) => {
      if (!h) return;
      const hClean = String(h).replace(/\s/g, '');
      for (const def of colDefs) {
        if (def.keys.some(k => hClean.includes(k))) {
          colMap[idx] = def.field;
          break;
        }
      }
    });

    // 如果没找到型号列，尝试核价配置表纵向格式
    if (!Object.values(colMap).includes('model')) {
      return res.status(400).json({ error: '无法识别文件格式，请确保表头包含"产品型号"列' });
    }

    const modelColIdx = Object.keys(colMap).find(k => colMap[k] === 'model');

    const configTable = getTable('product_configs');
    let imported = 0, skipped = 0;
    const details = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || !row[modelColIdx]) {
        details.push({ row: i + 1, status: 'skipped', reason: '型号为空' });
        skipped++;
        continue;
      }

      const modelVal = String(row[modelColIdx]).trim();

      // 检查型号是否已存在
      const existing = configTable.findWhere(r => r.model === modelVal, 'id', 'ASC');
      if (existing.records.length > 0) {
        details.push({ row: i + 1, model: modelVal, status: 'skipped', reason: '型号已存在' });
        skipped++;
        continue;
      }

      // 构建配置记录
      const record = {
        inquiry_id: null,
        model: modelVal,
        structure_shell: '',
        structure_reflector: '',
        structure_bracket: '',
        structure_handle: '',
        structure_waterproof: '',
        structure_cable: '',
        structure_screw: '',
        structure_glass: '',
        elec_luminous: '',
        elec_luminous_comp: '',
        elec_efficiency: '',
        elec_param: '',
        elec_color_temp: '',
        elec_ra: '',
        elec_led_count: '',
        elec_rated_power: '',
        elec_chip: '',
        elec_board_model: '',
        elec_battery: '',
        elec_discharge_time: '',
        elec_charge_time: '',
        pack_inner: '',
        pack_outer: '',
        pack_transport: '',
        pack_other: '',
        certificate_required: '',
        certificate_compliant: '',
        certificate_level: '',
        special_env: '',
        special_uv: '',
        special_salt: '',
        special_other: '',
        bom_details: '[]',
        pricing_data: null,
        status: 'imported',
        created_at: now(),
        updated_at: now()
      };

      // 填充映射字段
      for (const [colIdx, field] of Object.entries(colMap)) {
        const val = row[parseInt(colIdx)];
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          if (field === 'reference_price') {
            // 报价存入pricing_data
            record.pricing_data = JSON.stringify({ reference_price: val });
          } else if (field === 'product_name') {
            // 产品名称存入bom_details的备注
            record.bom_details = JSON.stringify([{ name: String(val).trim(), category: '产品名称' }]);
          } else {
            record[field] = String(val).trim();
          }
        }
      }

      configTable.insert(record);
      details.push({ row: i + 1, model: modelVal, status: 'imported' });
      imported++;
    }

    res.json({
      message: `批量导入完成：成功 ${imported} 条，跳过 ${skipped} 条`,
      imported,
      skipped,
      details
    });
  } catch (e) {
    logger.error('批量导入配置表失败:', e);
    res.status(500).json({ error: '导入失败: ' + e.message });
  }
});

// ===== 批量导出配置表 =====
router.post('/export-batch', requirePerm('config:view'), (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要导出的配置表' });
  }

  const table = getTable('product_configs');
  const configs = ids.map(id => table.findById(id)).filter(Boolean);

  if (configs.length === 0) return res.status(404).json({ error: '未找到配置表' });

  const wb = XLSX.utils.book_new();

  configs.forEach(config => {
    const sheetName = (config.model || 'config').substring(0, 31).replace(/[\\\/\?\*\[\]]/g, '_');
    const rows = [
      ['宁波恒剑光电科技有限公司\n配置表', '', '', ''],
      ['型号：', '', config.model || '/', ''],
      ['序号', '配置明细', '', ''],
      ['1、结构', '1.1、壳体材质', config.structure_shell || '/', ''],
      ['', '1.2、反光罩材质', config.structure_reflector || '/', ''],
      ['', '1.3、支架', config.structure_bracket || '/', ''],
      ['', '1.4、手杆', config.structure_handle || '/', ''],
      ['', '1.5、防水等级', config.structure_waterproof || '/', ''],
      ['', '1.6、电缆线规格', config.structure_cable || '/', ''],
      ['', '1.7、螺丝材质', config.structure_screw || '/', ''],
      ['', '1.8、玻璃', config.structure_glass || '/', ''],
      ['2、电子技术参数', '2.1、光参数(LM)', config.elec_luminous || '/', ''],
      ['', '2.2、补偿后光参数（LM）', config.elec_luminous_comp || '/', ''],
      ['', '2.3、光效（LM/W）', config.elec_efficiency || '/', ''],
      ['', '2.4、电参数', config.elec_param || '/', ''],
      ['', '2.5、色温(K)', config.elec_color_temp || '/', ''],
      ['', '2.6、显指（RA)', config.elec_ra || '/', ''],
      ['', '2.7、灯珠数量', config.elec_led_count || '/', ''],
      ['', '2.8、标称功率', config.elec_rated_power || '/', ''],
      ['', '2.9、芯片方案', config.elec_chip || '/', ''],
      ['', '2.10、电路板型号', config.elec_board_model || '/', ''],
      ['', '2.11、电池容量', config.elec_battery || '/', ''],
      ['', '2.12、放电时间（h）', config.elec_discharge_time || '/', ''],
      ['', '2.13、充电时间（h）', config.elec_charge_time || '/', ''],
      ['3、包装', '3.1、内包', config.pack_inner || '/', ''],
      ['', '3.2、外包', config.pack_outer || '/', ''],
      ['', '3.3、运输要求', config.pack_transport || '/', ''],
      ['', '3.4、其他', config.pack_other || '/', ''],
      ['4、证书', '4.1、认证需求', config.certificate_required || '/', ''],
      ['5、特殊需求', '5.1、环保要求', config.special_env || '/', ''],
      ['', '5.2、UV测试', config.special_uv || '/', ''],
      ['', '5.3、盐雾测试', config.special_salt || '/', ''],
      ['', '5.4、其他', config.special_other || '/', ''],
      [' 制作:                                                                   审核：                                                       审批:  ', '', '', '']
    ];

    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!merges'] = [
      { s: { c: 0, r: 0 }, e: { c: 2, r: 0 } },
      { s: { c: 0, r: 1 }, e: { c: 1, r: 1 } },
      { s: { c: 0, r: 3 }, e: { c: 0, r: 10 } },
      { s: { c: 0, r: 11 }, e: { c: 0, r: 23 } },
      { s: { c: 0, r: 24 }, e: { c: 0, r: 27 } },
      { s: { c: 0, r: 28 }, e: { c: 0, r: 28 } },
      { s: { c: 0, r: 29 }, e: { c: 0, r: 32 } },
      { s: { c: 0, r: 33 }, e: { c: 2, r: 33 } }
    ];
    ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 30 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = encodeURIComponent(`配置表_批量导出_${configs.length}条.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + fileName);
  res.send(buf);
});

// ===== 从核价表批量导入配置表（一键导入，去重）- 必须在 /:id 之前 =====
router.post('/import-from-pricing', requirePerm('config:create'), (req, res) => {
  const { ids } = req.body;
  const bomTable = getTable('bom_pricing');
  bomTable._invalidate();
  const configTable = getTable('product_configs');
  configTable._invalidate();

  let pricingList = bomTable.all();
  if (ids && Array.isArray(ids) && ids.length > 0) {
    pricingList = pricingList.filter(p => ids.includes(String(p.id)));
  }

  const existingModels = new Set(configTable.all().map(c => c.model));
  let imported = 0, skipped = 0, results = [];

  pricingList.forEach(p => {
    const model = p.model;
    if (!model) { skipped++; return; }
    if (existingModels.has(model)) {
      skipped++;
      results.push({ model, status: 'skipped', reason: '型号已存在' });
      return;
    }
    configTable.insert({
      inquiry_id: null,
      model,
      structure_shell: p.main_body || '',
      structure_reflector: p.reflector || '',
      structure_bracket: p.bracket || '',
      structure_handle: '',
      structure_waterproof: p.waterproof || '',
      structure_cable: p.cable || '',
      structure_screw: '',
      structure_glass: p.lampshade || '',
      elec_luminous: p.luminous_flux || '',
      elec_luminous_comp: '',
      elec_efficiency: '',
      elec_param: p.input_voltage || '',
      elec_color_temp: p.color_temp || '',
      elec_ra: '',
      elec_led_count: '',
      elec_rated_power: p.power || '',
      elec_chip: p.light_source || '',
      elec_board_model: '',
      elec_battery: p.battery || '',
      elec_discharge_time: '',
      elec_charge_time: '',
      pack_inner: p.box || '',
      pack_outer: p.packaging || '',
      pack_transport: '',
      pack_other: p.accessories || '',
      certificate_required: p.certificate_compliant || '',
      certificate_compliant: p.certificate_compliant || '',
      certificate_level: p.certificate_level || '',
      special_env: '',
      special_uv: '',
      special_salt: '',
      special_other: '',
      bom_details: '[]',
      pricing_data: JSON.stringify({
        total_cost: p.total_cost,
        price_rmb: p.price_rmb,
        price_usd: p.price_usd,
        pricer: p.pricer,
        pricing_version: p.pricing_version
      }),
      status: 'confirmed',
      created_at: now(),
      updated_at: now()
    });
    existingModels.add(model);
    imported++;
    results.push({ model, status: 'imported' });
  });

  res.json({ imported, skipped, results });
});

// ===== 获取核价表中可导入的配置表列表 - 必须在 /:id 之前 =====
router.get('/pricing-available', requirePerm('config:view'), (req, res) => {
  const bomTable = getTable('bom_pricing');
  bomTable._invalidate();
  const configTable = getTable('product_configs');
  configTable._invalidate();

  const existingModels = new Set(configTable.all().map(c => c.model));
  const pricingList = bomTable.all().filter(p => p.model && !existingModels.has(p.model));

  const data = pricingList.map(p => ({
    id: p.id,
    model: p.model,
    product_name: p.product_name || '',
    power: p.power || '',
    category: p.product_category || p.category || '',
    price_rmb: p.price_rmb || '',
    customer: p.customer || '',
    light_source: p.light_source || '',
    waterproof: p.waterproof || '',
    created_at: p.created_at || ''
  }));

  res.json({ data, total: data.length });
});

// ===== 配置表详情 =====
router.get('/:id', requirePerm('config:view'), (req, res) => {
  const table = getTable('product_configs');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '配置表不存在' });

  // 解析JSON字段
  let parsed = { ...row };
  try { parsed.bom_details = JSON.parse(row.bom_details || '[]'); } catch(e) { parsed.bom_details = []; }
  try { parsed.pricing_data = JSON.parse(row.pricing_data || 'null'); } catch(e) { parsed.pricing_data = null; }

  // 关联询价单信息
  if (row.inquiry_id) {
    const inquiryTable = getTable('inquiries');
    const inquiry = inquiryTable.findById(row.inquiry_id);
    parsed.inquiry = inquiry || null;
  }

  res.json(parsed);
});

// ===== 创建配置表 =====
router.post('/', requirePerm('config:create'), (req, res) => {
  const table = getTable('product_configs');
  const {
    inquiry_id, model,
    // 结构参数
    structure_shell, structure_reflector, structure_bracket, structure_handle,
    structure_waterproof, structure_cable, structure_screw, structure_glass,
    // 电子技术参数
    elec_luminous, elec_luminous_comp, elec_efficiency, elec_param,
    elec_color_temp, elec_ra, elec_led_count, elec_rated_power,
    elec_chip, elec_board_model, elec_battery, elec_discharge_time, elec_charge_time,
    // 包装
    pack_inner, pack_outer, pack_transport, pack_other,
    // 证书
    certificate_required, certificate_compliant, certificate_level,
    // 特殊需求
    special_env, special_uv, special_salt, special_other,
    // 其他
    bom_details, pricing_data, status
  } = req.body;

  if (!model) return res.status(400).json({ error: '型号不能为空' });

  const record = {
    inquiry_id: inquiry_id || null,
    model,
    structure_shell: structure_shell || '',
    structure_reflector: structure_reflector || '',
    structure_bracket: structure_bracket || '',
    structure_handle: structure_handle || '',
    structure_waterproof: structure_waterproof || '',
    structure_cable: structure_cable || '',
    structure_screw: structure_screw || '',
    structure_glass: structure_glass || '',
    elec_luminous: elec_luminous || '',
    elec_luminous_comp: elec_luminous_comp || '',
    elec_efficiency: elec_efficiency || '',
    elec_param: elec_param || '',
    elec_color_temp: elec_color_temp || '',
    elec_ra: elec_ra || '',
    elec_led_count: elec_led_count || '',
    elec_rated_power: elec_rated_power || '',
    elec_chip: elec_chip || '',
    elec_board_model: elec_board_model || '',
    elec_battery: elec_battery || '',
    elec_discharge_time: elec_discharge_time || '',
    elec_charge_time: elec_charge_time || '',
    pack_inner: pack_inner || '',
    pack_outer: pack_outer || '',
    pack_transport: pack_transport || '',
    pack_other: pack_other || '',
    certificate_required: certificate_required || '',
    certificate_compliant: certificate_compliant || '',
    certificate_level: certificate_level || '',
    special_env: special_env || '',
    special_uv: special_uv || '',
    special_salt: special_salt || '',
    special_other: special_other || '',
    bom_details: typeof bom_details === 'string' ? bom_details : JSON.stringify(bom_details || []),
    pricing_data: pricing_data ? (typeof pricing_data === 'string' ? pricing_data : JSON.stringify(pricing_data)) : null,
    status: status || 'draft',
    created_at: now(),
    updated_at: now()
  };

  const result = table.insert(record);
  res.json({ message: '配置表创建成功', id: result.lastID });
});

// ===== 更新配置表 =====
router.put('/:id', requirePerm('config:edit'), (req, res) => {
  const table = getTable('product_configs');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '配置表不存在' });

  const fields = { ...req.body, updated_at: now() };
  // JSON字段处理
  if (fields.bom_details && typeof fields.bom_details !== 'string') {
    fields.bom_details = JSON.stringify(fields.bom_details);
  }
  if (fields.pricing_data && typeof fields.pricing_data !== 'string') {
    fields.pricing_data = JSON.stringify(fields.pricing_data);
  }
  delete fields.id;
  delete fields.created_at;

  table.update(req.params.id, fields);
  res.json({ message: '配置表更新成功', data: table.findById(req.params.id) });
});

// ===== 删除配置表 =====
router.delete('/:id', requirePerm('config:delete'), (req, res) => {
  const table = getTable('product_configs');
  table.delete(req.params.id);
  res.json({ message: '配置表删除成功' });
});

// ===== 从询价单生成配置表 =====
router.post('/generate-from-inquiry/:inquiryId', requirePerm('config:edit'), (req, res) => {
  const inquiryTable = getTable('inquiries');
  const inquiry = inquiryTable.findById(req.params.inquiryId);
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });

  const configTable = getTable('product_configs');

  // 检查是否已存在
  const existing = configTable.all().find(c => c.inquiry_id === Number(req.params.inquiryId));
  if (existing) return res.json({ message: '配置表已存在', id: existing.id, existing: true });

  const record = {
    inquiry_id: Number(req.params.inquiryId),
    model: inquiry.external_model || '',
    structure_shell: inquiry.main_body || '',
    structure_reflector: inquiry.reflector || '',
    structure_waterproof: inquiry.waterproof || '',
    structure_cable: inquiry.cable || '',
    structure_bracket: '',
    structure_handle: '',
    structure_screw: '',
    structure_glass: '',
    elec_luminous: inquiry.luminous_flux || '',
    elec_color_temp: inquiry.color_temp || '',
    elec_rated_power: inquiry.power || '',
    elec_battery: inquiry.battery || '',
    elec_chip: inquiry.light_source || '',
    elec_led_count: '',
    elec_luminous_comp: '',
    elec_efficiency: '',
    elec_param: '',
    elec_ra: '',
    elec_board_model: '',
    elec_discharge_time: '',
    elec_charge_time: '',
    pack_inner: '',
    pack_outer: '',
    pack_transport: '',
    pack_other: '',
    certificate_required: inquiry.certificate_compliant || '',
    certificate_compliant: inquiry.certificate_compliant || '',
    certificate_level: inquiry.certificate_level || '',
    special_env: '',
    special_uv: '',
    special_salt: '',
    special_other: inquiry.custom_requirements || '',
    bom_details: '[]',
    pricing_data: null,
    status: 'draft',
    created_at: now(),
    updated_at: now()
  };

  const result = configTable.insert(record);

  // 更新询价单状态
  if (inquiry.status === 'new' || inquiry.status === 'cert_configured') {
    inquiryTable.update(req.params.inquiryId, { status: 'config_generated', updated_at: now() });
  }

  res.json({ message: '配置表已从询价单生成', id: result.lastID });
});

// ===== 从核价表同步到配置表 =====
router.post('/sync-from-pricing/:pricingId', requirePerm('config:edit'), (req, res) => {
  const pricingTable = getTable('bom_pricing');
  const pricing = pricingTable.findById(req.params.pricingId);
  if (!pricing) return res.status(404).json({ error: '核价表不存在' });

  const configTable = getTable('product_configs');

  // 查找关联的配置表
  let config = null;
  if (pricing.inquiry_no) {
    const inquiryTable = getTable('inquiries');
    const inquiry = inquiryTable.all().find(i => i.serial_number === pricing.inquiry_no);
    if (inquiry) {
      config = configTable.all().find(c => c.inquiry_id === inquiry.id);
    }
  }

  // 如果没有关联配置表，创建新的
  if (!config) {
    const record = {
      inquiry_id: null,
      model: pricing.model || '',
      structure_shell: '',
      structure_reflector: '',
      structure_waterproof: '',
      structure_cable: '',
      structure_bracket: '',
      structure_handle: '',
      structure_screw: '',
      structure_glass: '',
      elec_rated_power: pricing.power || '',
      elec_luminous: '',
      elec_color_temp: '',
      elec_battery: '',
      elec_chip: '',
      elec_led_count: '',
      elec_luminous_comp: '',
      elec_efficiency: '',
      elec_param: '',
      elec_ra: '',
      elec_board_model: '',
      elec_discharge_time: '',
      elec_charge_time: '',
      pack_inner: '',
      pack_outer: '',
      pack_transport: '',
      pack_other: '',
      certificate_required: pricing.certificate_compliant || '',
      certificate_compliant: pricing.certificate_compliant || '',
      certificate_level: pricing.certificate_level || '',
      special_env: '',
      special_uv: '',
      special_salt: '',
      special_other: '',
      bom_details: '[]',
      pricing_data: JSON.stringify({
        total_cost: pricing.total_cost,
        price_rmb: pricing.price_rmb,
        price_usd: pricing.price_usd,
        pricer: pricing.pricer,
        pricing_version: pricing.pricing_version
      }),
      status: 'confirmed',
      created_at: now(),
      updated_at: now()
    };
    const result = configTable.insert(record);
    return res.json({ message: '已从核价表创建配置表', id: result.lastID });
  }

  // 更新现有配置表的核价数据
  configTable.update(config.id, {
    pricing_data: JSON.stringify({
      total_cost: pricing.total_cost,
      price_rmb: pricing.price_rmb,
      price_usd: pricing.price_usd,
      pricer: pricing.pricer,
      pricing_version: pricing.pricing_version
    }),
    certificate_compliant: pricing.certificate_compliant || config.certificate_compliant,
    certificate_level: pricing.certificate_level || config.certificate_level,
    status: 'confirmed',
    updated_at: now()
  });

  res.json({ message: '已同步核价数据到配置表', id: config.id });
});

// ===== 导出配置表为Excel =====
router.get('/:id/export-xlsx', requirePerm('config:view'), (req, res) => {
  const table = getTable('product_configs');
  const config = table.findById(req.params.id);
  if (!config) return res.status(404).json({ error: '配置表不存在' });

  const rows = [
    ['宁波恒剑光电科技有限公司\n配置表', '', '', ''],
    ['型号：', '', config.model || '', ''],
    ['序号', '配置明细', '', ''],
    ['1、结构', '1.1、壳体材质', config.structure_shell || '/', ''],
    ['', '1.2、反光罩材质', config.structure_reflector || '/', ''],
    ['', '1.3、支架', config.structure_bracket || '/', ''],
    ['', '1.4、手杆', config.structure_handle || '/', ''],
    ['', '1.5、防水等级', config.structure_waterproof || '/', ''],
    ['', '1.6、电缆线规格', config.structure_cable || '/', ''],
    ['', '1.7、螺丝材质', config.structure_screw || '/', ''],
    ['', '1.8、玻璃', config.structure_glass || '/', ''],
    ['2、电子技术参数', '2.1、光参数(LM)', config.elec_luminous || '/', ''],
    ['', '2.2、补偿后光参数（LM）', config.elec_luminous_comp || '/', ''],
    ['', '2.3、光效（LM/W）', config.elec_efficiency || '/', ''],
    ['', '2.4、电参数', config.elec_param || '/', ''],
    ['', '2.5、色温(K)', config.elec_color_temp || '/', ''],
    ['', '2.6、显指（RA)', config.elec_ra || '/', ''],
    ['', '2.7、灯珠数量', config.elec_led_count || '/', ''],
    ['', '2.8、标称功率', config.elec_rated_power || '/', ''],
    ['', '2.9、芯片方案', config.elec_chip || '/', ''],
    ['', '2.10、电路板型号', config.elec_board_model || '/', ''],
    ['', '2.11、电池容量', config.elec_battery || '/', ''],
    ['', '2.12、放电时间（h）', config.elec_discharge_time || '/', ''],
    ['', '2.13、充电时间（h）', config.elec_charge_time || '/', ''],
    ['3、包装', '3.1、内包', config.pack_inner || '/', ''],
    ['', '3.2、外包', config.pack_outer || '/', ''],
    ['', '3.3、运输要求', config.pack_transport || '/', ''],
    ['', '3.4、其他', config.pack_other || '/', ''],
    ['4、证书', '4.1、认证需求', config.certificate_required || '/', ''],
    ['5、特殊需求', '5.1、环保要求', config.special_env || '/', ''],
    ['', '5.2、UV测试', config.special_uv || '/', ''],
    ['', '5.3、盐雾测试', config.special_salt || '/', ''],
    ['', '5.4、其他', config.special_other || '/', ''],
    [' 制作:                                                                   审核：                                                       审批:  ', '', '', '']
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = [
    { s: { c: 0, r: 0 }, e: { c: 2, r: 0 } },
    { s: { c: 0, r: 1 }, e: { c: 1, r: 1 } },
    { s: { c: 0, r: 3 }, e: { c: 0, r: 10 } },
    { s: { c: 0, r: 11 }, e: { c: 0, r: 23 } },
    { s: { c: 0, r: 24 }, e: { c: 0, r: 27 } },
    { s: { c: 0, r: 28 }, e: { c: 0, r: 28 } },
    { s: { c: 0, r: 29 }, e: { c: 0, r: 32 } },
    { s: { c: 0, r: 33 }, e: { c: 2, r: 33 } }
  ];
  ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 30 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws, '配置表');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = encodeURIComponent(`配置表_${config.model}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + fileName);
  res.send(buf);
});

// ===== 配置表数据同步到询价单 =====
router.post('/:id/sync-to-inquiry', requirePerm('config:edit'), (req, res) => {
  const configTable = getTable('product_configs');
  const config = configTable.findById(req.params.id);
  if (!config) return res.status(404).json({ error: '配置表不存在' });

  if (!config.inquiry_id) return res.status(400).json({ error: '该配置表未关联询价单' });

  const inquiryTable = getTable('inquiries');
  const inquiry = inquiryTable.findById(config.inquiry_id);
  if (!inquiry) return res.status(404).json({ error: '关联的询价单不存在' });

  const updates = {
    external_model: config.model || inquiry.external_model,
    main_body: config.structure_shell || inquiry.main_body,
    reflector: config.structure_reflector || inquiry.reflector,
    waterproof: config.structure_waterproof || inquiry.waterproof,
    cable: config.structure_cable || inquiry.cable,
    luminous_flux: config.elec_luminous || inquiry.luminous_flux,
    color_temp: config.elec_color_temp || inquiry.color_temp,
    power: config.elec_rated_power || inquiry.power,
    battery: config.elec_battery || inquiry.battery,
    light_source: config.elec_chip || inquiry.light_source,
    certificate_compliant: config.certificate_compliant || inquiry.certificate_compliant,
    certificate_level: config.certificate_level || inquiry.certificate_level,
    custom_requirements: config.special_other || inquiry.custom_requirements,
    updated_at: now()
  };

  inquiryTable.update(config.inquiry_id, updates);
  res.json({ message: '配置表数据已同步到询价单' });
});

module.exports = router;
