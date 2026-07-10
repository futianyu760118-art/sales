const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const XLSX = require('xlsx');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

ensureTable('product_configs');
ensureTable('quotations');
ensureTable('email_logs');
ensureTable('spec_sheets');
ensureTable('config_sheets');

function genSerial() {
  const d = new Date();
  const dateStr = d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  
  const table = getTable('inquiries');
  const yearPrefix = 'JFX' + d.getFullYear().toString();
  const yearRecords = table.all().filter(r => r.serial_number && r.serial_number.startsWith(yearPrefix));
  const maxNum = yearRecords.length > 0 
    ? Math.max(...yearRecords.map(r => {
        const baseSn = (r.serial_number || '').replace(/-\d{2,}$/, '');
        return parseInt(baseSn.slice(-3)) || 0;
      }))
    : 0;
  const seqNum = String(maxNum + 1).padStart(3, '0');
  
  return 'JFX' + dateStr + seqNum;
}

function genQuoteNo() {
  const d = new Date();
  const ts = d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  return 'QT' + ts + Math.floor(Math.random() * 10000);
}

// 记录操作日志
function logOperation(action, operator, detail, inquiry_id) {
  try {
    const logTable = getTable('operation_logs');
    logTable.insert({ action, operator, detail, inquiry_id: inquiry_id || null, created_at: now() });
  } catch (e) { console.error('记录操作日志失败:', e.message); }
}

// 解析导入文件为JSON数组（支持 xlsx/xls/csv/tsv）
function parseImportFile(buffer, originalname) {
  const ext = (originalname || '').toLowerCase();
  let workbook;
  if (ext.endsWith('.csv') || ext.endsWith('.tsv')) {
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true, FS: ext.endsWith('.tsv') ? '\t' : ',', codepage: 65001 });
  } else {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  json.forEach(r => Object.keys(r).forEach(k => { if (r[k] instanceof Date) r[k] = fmt(r[k]); }));
  return json;
}

// ===== 专用路由（必须在 /:id 之前注册）=====

// 智能带参：根据产品型号自动获取物料、核价标准、历史报价
router.get('/auto-params/:model', requirePerm('inquiry:view'), (req, res) => {
  const model = req.params.model;
  const productTable = getTable('products');
  const materialTable = getTable('materials');
  const pricingTable = getTable('bom_pricing');
  const inquiryTable = getTable('inquiries');
  const configTable = getTable('product_configs');

  const product = productTable.all().find(p => p.external_model === model || p.internal_model === model);
  if (!product) return res.json({ product: null, materials: [], pricing: [], history: [], config: null });

  let materials = materialTable.all().filter(m => m.product_id === product.id);
  if (materials.length === 0) {
    materials = materialTable.all().filter(m =>
      m.product_id === model || m.product_id === product.external_model ||
      m.product_id === product.internal_model
    );
  }

  const pricing = pricingTable.all().filter(ps => ps.model === model);

  const history = inquiryTable.all()
    .filter(i => i.external_model === model && i.final_price > 0)
    .sort((a, b) => (b.quoted_at || '').localeCompare(a.quoted_at || ''))
    .slice(0, 5)
    .map(i => ({
      serial_number: i.serial_number, customer_name: i.customer_name,
      quantity: i.quantity, final_price: i.final_price, base_cost: i.base_cost,
      profit_rate: i.profit_rate, discount_rate: i.discount_rate,
      quoted_at: i.quoted_at, status: i.status
    }));

  const configs = configTable.all().filter(c => c.model === model || c.model === product.external_model);
  const latestConfig = configs.length > 0 ? configs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] : null;

  res.json({
    product: {
      id: product.id, external_model: product.external_model, internal_model: product.internal_model,
      category: product.category, power: product.power, configuration: product.configuration, specs: product.specs,
      product_name: product.product_name || '',
      input_voltage: product.input_voltage || '', battery: product.battery || '',
      color_temp: product.color_temp || '', luminous_flux: product.luminous_flux || '',
      light_source: product.light_source || '', main_body: product.main_body || '',
      lampshade: product.lampshade || '', reflector: product.reflector || '',
      cable: product.cable || '', switch_type: product.switch_type || '',
      usb: product.usb || '', waterproof: product.waterproof || '', sensor: product.sensor || ''
    },
    materials,
    pricing,
    history,
    config: latestConfig
  });
});

// ===== 参数选项汇总（所有可选值） =====
router.get('/param-options', requirePerm('inquiry:view'), (req, res) => {
  const productTable = getTable('products');
  const inquiryTable = getTable('inquiries');

  const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
    'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
    'switch_type', 'usb', 'waterproof', 'sensor'];

  const defaults = {
    input_voltage: ['110-130V', '127-220V', '170-270V', '220-240V', '85-265V', '12V', '24V', '36V', '48V', 'DC 12V', 'DC 24V'],
    battery: ['3.7V 2000mAh', '3.7V 4000mAh', '3.7V 6000mAh', '3.7V 8000mAh', '无电池'],
    color_temp: ['2700K', '3000K', '3500K', '4000K', '4500K', '5000K', '5500K', '6500K', '3000K/6500K', '3000K/4000K/6500K'],
    luminous_flux: ['80LM/W', '85LM/W', '90LM/W', '100LM/W', '110LM/W', '120LM/W', '130LM/W', '150LM/W', '160LM/W', '180LM/W', '200LM/W'],
    light_source: ['SMD', 'COB', 'SMD+COB', 'LED灯珠', '集成LED'],
    main_body: ['铝合金', '铝', '铸铝', '铁', '不锈钢', '塑料', 'ABS', 'PC'],
    lampshade: ['玻璃', 'PC', 'PMMA', '亚克力', '透明PC', '磨砂PC', '无灯罩'],
    reflector: ['吸塑', '铝反光罩', 'PC反光罩', '无反光罩'],
    cable: ['0.3M H05 3*1平方', '1M H07RN-F 3G1.5', '3M H07RN-F 3G1.5', '5M H07RN-F 3G1.5', '3M H05VV-F 3G1.0', '5M H05VV-F 3G1.0', '无电缆'],
    switch_type: ['ON/OFF', '按钮开关', '拉线开关', '感应开关', '遥控开关', '无开关'],
    usb: ['USB-A', 'USB-C', 'USB-A+USB-C', '无USB'],
    waterproof: ['IP20', 'IP44', 'IP54', 'IP55', 'IP65', 'IP66', 'IP67', 'IPX4', 'IPX6', 'IPX8'],
    sensor: ['微波感应', '红外感应', '雷达感应', '光控', '人体感应', '无感应']
  };

  const options = {};
  paramFields.forEach(field => {
    const values = new Set(defaults[field] || []);
    productTable.all().forEach(p => {
      if (p[field] && String(p[field]).trim()) values.add(String(p[field]).trim());
    });
    inquiryTable.all().forEach(i => {
      if (i[field] && String(i[field]).trim()) values.add(String(i[field]).trim());
    });
    options[field] = Array.from(values);
  });

  res.json({ options });
});

// ===== 参数历史查询 =====

router.get('/param-history/:model', requirePerm('inquiry:view'), (req, res) => {
  const model = req.params.model;
  const productTable = getTable('products');
  const inquiryTable = getTable('inquiries');

  const prefix = model.replace(/[-].*$/, '');
  const seriesProducts = productTable.all().filter(p =>
    p.external_model === model || p.external_model.startsWith(prefix) ||
    p.internal_model === model || p.internal_model.startsWith(prefix)
  );

  const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
    'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
    'switch_type', 'usb', 'waterproof', 'sensor'];

  const paramHistory = {};
  paramFields.forEach(field => {
    const values = new Set();
    seriesProducts.forEach(p => {
      if (p[field] && String(p[field]).trim()) values.add(String(p[field]).trim());
    });
    inquiryTable.all().filter(i => i.external_model === model || i.external_model.startsWith(prefix)).forEach(i => {
      if (i[field] && String(i[field]).trim()) values.add(String(i[field]).trim());
    });
    if (values.size > 0) paramHistory[field] = Array.from(values);
  });

  const matchedProducts = seriesProducts.map(p => ({
    id: p.id,
    external_model: p.external_model,
    internal_model: p.internal_model || '',
    product_name: p.product_name || '',
    category: p.category || '',
    power: p.power || '',
    input_voltage: p.input_voltage || '',
    battery: p.battery || '',
    color_temp: p.color_temp || '',
    luminous_flux: p.luminous_flux || '',
    light_source: p.light_source || '',
    main_body: p.main_body || '',
    lampshade: p.lampshade || '',
    reflector: p.reflector || '',
    cable: p.cable || '',
    switch_type: p.switch_type || '',
    usb: p.usb || '',
    waterproof: p.waterproof || '',
    sensor: p.sensor || ''
  }));

  res.json({ paramHistory, matchedProducts });
});

// ===== 产品型号匹配 =====

router.post('/match-product', requirePerm('inquiry:view'), (req, res) => {
  const { external_model, input_voltage, battery, color_temp, luminous_flux,
    light_source, main_body, lampshade, reflector, cable, switch_type,
    usb, waterproof, sensor } = req.body;

  if (!external_model) return res.status(400).json({ error: '产品型号为必填项' });

  const productTable = getTable('products');
  const eq = (a, b) => (a || '').trim() === (b || '').trim();

  const exactMatch = productTable.all().find(p => {
    if (p.external_model !== external_model) return false;
    return eq(p.input_voltage, input_voltage) && eq(p.battery, battery) &&
      eq(p.color_temp, color_temp) && eq(p.luminous_flux, luminous_flux) &&
      eq(p.light_source, light_source) && eq(p.main_body, main_body) &&
      eq(p.lampshade, lampshade) && eq(p.reflector, reflector) &&
      eq(p.cable, cable) && eq(p.switch_type, switch_type) &&
      eq(p.usb, usb) && eq(p.waterproof, waterproof) && eq(p.sensor, sensor);
  });

  if (exactMatch) {
    return res.json({ matched: true, product: exactMatch, action: 'use_existing' });
  }

  const baseMatch = productTable.all().find(p => p.external_model === external_model);
  if (baseMatch) {
    const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
      'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
      'switch_type', 'usb', 'waterproof', 'sensor'];
    const diffFields = paramFields.filter(f => !eq(baseMatch[f], req.body[f]));
    if (diffFields.length > 0) {
      const allWithBaseModel = productTable.all().filter(p => p.external_model.startsWith(external_model + '-'));
      const maxSeq = allWithBaseModel.reduce((max, p) => {
        const match = p.external_model.match(new RegExp(`^${external_model}-(\\d+)$`));
        if (match) return Math.max(max, parseInt(match[1]));
        return max;
      }, 0);
      const newModel = `${external_model}-${String(maxSeq + 1).padStart(2, '0')}`;
      return res.json({
        matched: false,
        action: 'create_variant',
        base_model: external_model,
        suggested_model: newModel,
        diff_fields: diffFields,
        base_product: {
          id: baseMatch.id,
          external_model: baseMatch.external_model,
          product_name: baseMatch.product_name || ''
        }
      });
    }
  }

  return res.json({ matched: false, action: 'create_new', suggested_model: external_model });
});

// ===== 产品配置表 =====

// 生成产品配置表（自动关联物料库+核价库）
router.post('/generate-config', requirePerm('inquiry:edit'), (req, res) => {
  const { inquiry_id, model, certificate_compliant, certificate_level } = req.body;
  if (!model) return res.status(400).json({ error: '产品型号为必填项' });

  const productTable = getTable('products');
  const materialTable = getTable('materials');
  const pricingTable = getTable('bom_pricing');
  const configTable = getTable('product_configs');

  const product = productTable.all().find(p => p.external_model === model || p.internal_model === model);
  if (!product) return res.status(404).json({ error: '未找到对应产品' });

  let materials = materialTable.all().filter(m => m.product_id === product.id);
  if (materials.length === 0) {
    materials = materialTable.all().filter(m =>
      m.product_id === model || m.product_id === product.external_model ||
      m.product_id === product.internal_model
    );
  }

  let pricingRecords = pricingTable.all().filter(ps => ps.model === model);
  if (certificate_level) {
    pricingRecords = pricingRecords.filter(ps => ps.certificate_level === certificate_level);
  }
  const pricing = pricingRecords[0] || null;

  // 构建配置项：区分固定参数和可调参数
  const fixedParams = {
    product_name: product.product_name || product.external_model,
    external_model: product.external_model,
    internal_model: product.internal_model,
    category: product.category,
    power: product.power,
    certificate_compliant: certificate_compliant || '',
    certificate_level: certificate_level || ''
  };

  const adjustableParams = {
    input_voltage: product.input_voltage || '',
    battery: product.battery || '',
    color_temp: product.color_temp || '',
    luminous_flux: product.luminous_flux || '',
    light_source: product.light_source || '',
    main_body: product.main_body || '',
    lampshade: product.lampshade || '',
    reflector: product.reflector || '',
    cable: product.cable || '',
    switch_type: product.switch_type || '',
    usb: product.usb || '',
    waterproof: product.waterproof || '',
    sensor: product.sensor || '',
    configuration: product.configuration || ''
  };

  // 物料BOM成本明细
  const bomDetails = materials.map(m => ({
    material_id: m.id,
    material_name: m.material_name,
    material_code: m.material_code,
    specs: m.specs || '',
    material_type: m.material_type || '',
    standard_cost: m.standard_cost || 0,
    processing_cost: m.processing_cost || 0,
    processing_loss: m.processing_loss || 0,
    quantity: m.quantity || 1,
    unit: m.unit || '个',
    supplier: m.supplier || '',
    status: m.status || 'normal'
  }));

  // 核价数据
  const pricingData = pricing ? {
    pricing_id: pricing.id,
    bom_costs: {
      kit: pricing.kit, cable: pricing.cable, light_source: pricing.light_source,
      driver: pricing.driver, battery: pricing.battery, bracket: pricing.bracket,
      switch_type: pricing.switch_type, solar_panel: pricing.solar_panel,
      socket: pricing.socket, box: pricing.box, manual: pricing.manual,
      packaging: pricing.packaging, accessories: pricing.accessories, labor: pricing.labor
    },
    total_cost: pricing.total_cost,
    labor_cost: pricing.labor_cost || 0,
    process_cost: pricing.process_cost || 0,
    estimated_loss: pricing.estimated_loss || 0,
    min_price: pricing.min_price,
    price_rmb: pricing.price_rmb,
    price_usd: pricing.price_usd,
    pricing_version: pricing.pricing_version,
    effective_date: pricing.effective_date
  } : null;

  // 保存配置表
  const configRecord = {
    inquiry_id: inquiry_id || null,
    product_id: product.id,
    model,
    certificate_compliant: certificate_compliant || '',
    certificate_level: certificate_level || '',
    fixed_params: JSON.stringify(fixedParams),
    adjustable_params: JSON.stringify(adjustableParams),
    bom_details: JSON.stringify(bomDetails),
    pricing_data: pricingData ? JSON.stringify(pricingData) : null,
    status: 'draft',
    created_at: now(),
    updated_at: now()
  };

  const result = configTable.insert(configRecord);
  const saved = configTable.findById(result.lastID);

  // 更新询价单状态为 config_generated
  if (inquiry_id) {
    const inquiryTable = getTable('inquiries');
    const inquiry = inquiryTable.findById(inquiry_id);
    if (inquiry && (inquiry.status === 'new' || inquiry.status === 'cert_configured')) {
      inquiryTable.update(inquiry_id, { status: 'config_generated', updated_at: now() });
      const statusTable = getTable('inquiry_status_changes');
      statusTable.insert({ inquiry_id: Number(inquiry_id), status: 'config_generated', changed_by: 'system', changed_at: now(), reason: '产品配置表已生成' });
      logOperation('生成配置表', 'system', `询价单 ${inquiry.serial_number} 配置表已生成`, Number(inquiry_id));
    }
  }

  res.json({
    message: '产品配置表生成成功',
    data: {
      ...saved,
      fixed_params: fixedParams,
      adjustable_params: adjustableParams,
      bom_details: bomDetails,
      pricing_data: pricingData
    }
  });
});

// 获取配置表详情
router.get('/config-by-model/:model', requirePerm('inquiry:view'), (req, res) => {
  const model = req.params.model;
  const configTable = getTable('product_configs');
  const productTable = getTable('products');
  const pricingTable = getTable('bom_pricing');
  const materialTable = getTable('materials');
  const configs = configTable.all().filter(c => c.model === model);

  let config = null;
  if (configs.length > 0) {
    config = configs[configs.length - 1];
  }

  if (!config) {
    const product = productTable.all().find(p => p.external_model === model || p.internal_model === model);
    if (!product) return res.json({ config: null });

    const similarConfig = configTable.all().find(c =>
      c.model !== model && c.product_id === product.id &&
      (c.elec_param || c.elec_color_temp || c.elec_luminous || c.structure_shell || c.structure_waterproof)
    );

    let fixed_params = {
      product_name: product.product_name || product.external_model,
      external_model: product.external_model,
      internal_model: product.internal_model,
      category: product.category || '',
      power: product.power || ''
    };

    let adjustable_params = {};
    if (product.configuration) {
      const cfgStr = product.configuration;
      const voltageMatch = cfgStr.match(/输入[:\s]*AC?([\d\-~]+V)/i) || cfgStr.match(/([\d\-~]+V)\s*输入/i);
      if (voltageMatch) adjustable_params.input_voltage = voltageMatch[1];
      const outputMatch = cfgStr.match(/输出[:\s]*DC?([\d\-~V\/A.]+)/i) || cfgStr.match(/([\d\-~V\/A.]+)\s*输出/i);
      if (outputMatch) adjustable_params.configuration = cfgStr;
    }
    if (product.specs) {
      adjustable_params.configuration = (adjustable_params.configuration || '') + (adjustable_params.configuration ? ' | ' : '') + product.specs;
    }

    if (similarConfig) {
      if (similarConfig.elec_param) adjustable_params.input_voltage = adjustable_params.input_voltage || similarConfig.elec_param;
      if (similarConfig.elec_battery && similarConfig.elec_battery !== '/') adjustable_params.battery = similarConfig.elec_battery;
      if (similarConfig.elec_color_temp) adjustable_params.color_temp = similarConfig.elec_color_temp;
      if (similarConfig.elec_luminous) adjustable_params.luminous_flux = similarConfig.elec_luminous;
      if (similarConfig.elec_chip && similarConfig.elec_chip !== '/') adjustable_params.light_source = similarConfig.elec_chip;
      if (similarConfig.structure_waterproof) adjustable_params.waterproof = 'IP' + similarConfig.structure_waterproof;
      if (similarConfig.structure_shell && similarConfig.structure_shell !== '/') adjustable_params.main_body = similarConfig.structure_shell;
      if (similarConfig.structure_glass && similarConfig.structure_glass !== '/') adjustable_params.lampshade = similarConfig.structure_glass;
      if (similarConfig.structure_reflector && similarConfig.structure_reflector !== '/') adjustable_params.reflector = similarConfig.structure_reflector;
      if (similarConfig.structure_cable && similarConfig.structure_cable !== '/') adjustable_params.cable = similarConfig.structure_cable;
      if (similarConfig.elec_board_model && similarConfig.elec_board_model !== '/') adjustable_params.switch_type = similarConfig.elec_board_model;
    }

    const hasAnyAdj = Object.values(adjustable_params).some(v => v && String(v).trim() !== '');
    if (!hasAnyAdj) {
      const prefix = model.replace(/[-].*$/, '');
      const seriesConfigs = configTable.all().filter(c =>
        c.model !== model && c.model.startsWith(prefix) &&
        (c.elec_param || c.elec_color_temp || c.elec_luminous || c.structure_shell || c.structure_waterproof)
      );
      if (seriesConfigs.length > 0) {
        const ref = seriesConfigs[seriesConfigs.length - 1];
        if (ref.elec_param && !adjustable_params.input_voltage) adjustable_params.input_voltage = ref.elec_param;
        if (ref.elec_battery && ref.elec_battery !== '/' && !adjustable_params.battery) adjustable_params.battery = ref.elec_battery;
        if (ref.elec_color_temp && !adjustable_params.color_temp) adjustable_params.color_temp = ref.elec_color_temp;
        if (ref.elec_luminous && !adjustable_params.luminous_flux) adjustable_params.luminous_flux = ref.elec_luminous;
        if (ref.elec_chip && ref.elec_chip !== '/' && !adjustable_params.light_source) adjustable_params.light_source = ref.elec_chip;
        if (ref.structure_waterproof && !adjustable_params.waterproof) adjustable_params.waterproof = 'IP' + ref.structure_waterproof;
        if (ref.structure_shell && ref.structure_shell !== '/' && !adjustable_params.main_body) adjustable_params.main_body = ref.structure_shell;
        if (ref.structure_glass && ref.structure_glass !== '/' && !adjustable_params.lampshade) adjustable_params.lampshade = ref.structure_glass;
        if (ref.structure_reflector && ref.structure_reflector !== '/' && !adjustable_params.reflector) adjustable_params.reflector = ref.structure_reflector;
        if (ref.structure_cable && ref.structure_cable !== '/' && !adjustable_params.cable) adjustable_params.cable = ref.structure_cable;
        if (ref.elec_board_model && ref.elec_board_model !== '/' && !adjustable_params.switch_type) adjustable_params.switch_type = ref.elec_board_model;
      }
    }

    let bom_details = [];
    let materials = materialTable.all().filter(m => String(m.product_id) === String(product.id));
    if (materials.length === 0) {
      materials = materialTable.all().filter(m =>
        m.product_id === model || m.product_id === product.external_model ||
        m.product_id === product.internal_model
      );
    }
    bom_details = materials.map(m => ({
      material_id: m.id, material_name: m.material_name, material_code: m.material_code || '',
      specs: m.specs || '', material_type: m.material_type || '',
      standard_cost: m.standard_cost || m.unit_price || 0, processing_cost: m.processing_cost || 0,
      processing_loss: m.processing_loss || 0, quantity: m.quantity || 1, unit: m.unit || '个',
      supplier: m.supplier || '', status: m.status || 'normal'
    }));

    let pricing_data = null;
    const pricingRecords = pricingTable.all().filter(ps => ps.model === model);
    if (pricingRecords.length > 0) {
      const p = pricingRecords[0];
      pricing_data = {
        pricing_id: p.id,
        bom_costs: {
          kit: p.kit, cable: p.cable, light_source: p.light_source,
          driver: p.driver, battery: p.battery, bracket: p.bracket,
          switch_type: p.switch_type, solar_panel: p.solar_panel,
          socket: p.socket, box: p.box, manual: p.manual,
          packaging: p.packaging, accessories: p.accessories, labor: p.labor
        },
        total_cost: p.total_cost, labor_cost: p.labor_cost || 0,
        process_cost: p.process_cost || 0, estimated_loss: p.estimated_loss || 0,
        min_price: p.min_price, price_rmb: p.price_rmb, price_usd: p.price_usd,
        pricing_version: p.pricing_version, effective_date: p.effective_date
      };
    }

    return res.json({
      config: {
        model, product_id: product.id,
        certificate_compliant: '', certificate_level: '',
        fixed_params, adjustable_params, bom_details, pricing_data,
        status: 'virtual'
      }
    });
  }

  let fixed_params = {}, adjustable_params = {}, bom_details = [], pricing_data = null;
  try { fixed_params = JSON.parse(config.fixed_params); } catch(e) {}
  try { adjustable_params = JSON.parse(config.adjustable_params); } catch(e) {}
  try { bom_details = JSON.parse(config.bom_details); } catch(e) {}
  try { pricing_data = JSON.parse(config.pricing_data); } catch(e) {}

  const hasFixedValues = fixed_params && Object.values(fixed_params).some(v => v && v.trim && v.trim() !== '');
  if (!hasFixedValues) {
    fixed_params = {};
    if (config.elec_rated_power) fixed_params.power = config.elec_rated_power;
    if (config.elec_color_temp) fixed_params.color_temp = config.elec_color_temp;
    if (config.model) fixed_params.external_model = config.model;
    if (config.model) fixed_params.internal_model = config.model;
    const prod = productTable.all().find(p => p.external_model === model || p.internal_model === model);
    if (prod) {
      if (prod.product_name) fixed_params.product_name = prod.product_name;
      if (prod.category) fixed_params.category = prod.category;
      if (prod.power && !fixed_params.power) fixed_params.power = prod.power;
    }
  }

  const hasAdjValues = adjustable_params && Object.values(adjustable_params).some(v => v && v.trim && v.trim() !== '');
  if (!hasAdjValues) {
    adjustable_params = {};
    if (config.elec_param) adjustable_params.input_voltage = config.elec_param;
    if (config.elec_battery && config.elec_battery !== '/') adjustable_params.battery = config.elec_battery;
    if (config.elec_color_temp) adjustable_params.color_temp = config.elec_color_temp;
    if (config.elec_luminous) adjustable_params.luminous_flux = config.elec_luminous;
    if (config.elec_chip && config.elec_chip !== '/') adjustable_params.light_source = config.elec_chip;
    if (config.structure_waterproof) adjustable_params.waterproof = 'IP' + config.structure_waterproof;
    if (config.structure_shell && config.structure_shell !== '/') adjustable_params.main_body = config.structure_shell;
    if (config.structure_glass && config.structure_glass !== '/') adjustable_params.lampshade = config.structure_glass;
    if (config.structure_reflector && config.structure_reflector !== '/') adjustable_params.reflector = config.structure_reflector;
    if (config.structure_cable && config.structure_cable !== '/') adjustable_params.cable = config.structure_cable;
    if (config.elec_board_model && config.elec_board_model !== '/') adjustable_params.switch_type = config.elec_board_model;

    const prod = productTable.all().find(p => p.external_model === model || p.internal_model === model);
    if (prod) {
      if (prod.configuration) {
        const cfgStr = prod.configuration;
        const voltageMatch = cfgStr.match(/输入[:\s]*AC?([\d\-~]+V)/i) || cfgStr.match(/([\d\-~]+V)\s*输入/i);
        if (voltageMatch && !adjustable_params.input_voltage) adjustable_params.input_voltage = voltageMatch[1];
        if (!adjustable_params.configuration) adjustable_params.configuration = cfgStr;
      }
      if (prod.specs && !adjustable_params.configuration) {
        adjustable_params.configuration = prod.specs;
      }
    }

    const hasAnyAdj = Object.values(adjustable_params).some(v => v && String(v).trim() !== '');
    if (!hasAnyAdj) {
      const prefix = model.replace(/[-].*$/, '');
      const similarConfigs = configTable.all().filter(c =>
        c.model !== model && c.model.startsWith(prefix) &&
        (c.elec_param || c.elec_color_temp || c.elec_luminous || c.structure_shell || c.structure_waterproof)
      );
      if (similarConfigs.length > 0) {
        const ref = similarConfigs[similarConfigs.length - 1];
        if (ref.elec_param && !adjustable_params.input_voltage) adjustable_params.input_voltage = ref.elec_param;
        if (ref.elec_battery && ref.elec_battery !== '/' && !adjustable_params.battery) adjustable_params.battery = ref.elec_battery;
        if (ref.elec_color_temp && !adjustable_params.color_temp) adjustable_params.color_temp = ref.elec_color_temp;
        if (ref.elec_luminous && !adjustable_params.luminous_flux) adjustable_params.luminous_flux = ref.elec_luminous;
        if (ref.elec_chip && ref.elec_chip !== '/' && !adjustable_params.light_source) adjustable_params.light_source = ref.elec_chip;
        if (ref.structure_waterproof && !adjustable_params.waterproof) adjustable_params.waterproof = 'IP' + ref.structure_waterproof;
        if (ref.structure_shell && ref.structure_shell !== '/' && !adjustable_params.main_body) adjustable_params.main_body = ref.structure_shell;
        if (ref.structure_glass && ref.structure_glass !== '/' && !adjustable_params.lampshade) adjustable_params.lampshade = ref.structure_glass;
        if (ref.structure_reflector && ref.structure_reflector !== '/' && !adjustable_params.reflector) adjustable_params.reflector = ref.structure_reflector;
        if (ref.structure_cable && ref.structure_cable !== '/' && !adjustable_params.cable) adjustable_params.cable = ref.structure_cable;
        if (ref.elec_board_model && ref.elec_board_model !== '/' && !adjustable_params.switch_type) adjustable_params.switch_type = ref.elec_board_model;
      }
    }
  }

  if (bom_details.length === 0) {
    let materials = [];
    if (config.product_id) {
      materials = materialTable.all().filter(m => String(m.product_id) === String(config.product_id));
    }
    if (materials.length === 0) {
      materials = materialTable.all().filter(m =>
        m.product_id === model || m.product_id === fixed_params.external_model ||
        m.product_id === fixed_params.internal_model
      );
    }
    bom_details = materials.map(m => ({
      material_id: m.id,
      material_name: m.material_name,
      material_code: m.material_code || '',
      specs: m.specs || '',
      material_type: m.material_type || '',
      standard_cost: m.standard_cost || m.unit_price || 0,
      processing_cost: m.processing_cost || 0,
      processing_loss: m.processing_loss || 0,
      quantity: m.quantity || 1,
      unit: m.unit || '个',
      supplier: m.supplier || '',
      status: m.status || 'normal'
    }));
  }

  if (!pricing_data) {
    const pricingRecords = pricingTable.all().filter(ps => ps.model === model);
    if (pricingRecords.length > 0) {
      const p = pricingRecords[0];
      pricing_data = {
        pricing_id: p.id,
        bom_costs: {
          kit: p.kit, cable: p.cable, light_source: p.light_source,
          driver: p.driver, battery: p.battery, bracket: p.bracket,
          switch_type: p.switch_type, solar_panel: p.solar_panel,
          socket: p.socket, box: p.box, manual: p.manual,
          packaging: p.packaging, accessories: p.accessories, labor: p.labor
        },
        total_cost: p.total_cost,
        labor_cost: p.labor_cost || 0,
        process_cost: p.process_cost || 0,
        estimated_loss: p.estimated_loss || 0,
        min_price: p.min_price,
        price_rmb: p.price_rmb,
        price_usd: p.price_usd,
        pricing_version: p.pricing_version,
        effective_date: p.effective_date
      };
    }
  }

  res.json({
    config: {
      ...config,
      fixed_params,
      adjustable_params,
      bom_details,
      pricing_data
    }
  });
});

router.get('/config/:id', requirePerm('inquiry:view'), (req, res) => {
  const configTable = getTable('product_configs');
  const config = configTable.findById(req.params.id);
  if (!config) return res.status(404).json({ error: '配置表不存在' });

  let parsed = { ...config };
  try { parsed.fixed_params = JSON.parse(config.fixed_params); } catch(e) { parsed.fixed_params = {}; }
  try { parsed.adjustable_params = JSON.parse(config.adjustable_params); } catch(e) { parsed.adjustable_params = {}; }
  try { parsed.bom_details = JSON.parse(config.bom_details); } catch(e) { parsed.bom_details = []; }
  try { parsed.pricing_data = JSON.parse(config.pricing_data); } catch(e) { parsed.pricing_data = null; }

  res.json(parsed);
});

// 更新配置表（可调参数微调）
router.put('/config/:id', requirePerm('inquiry:edit'), (req, res) => {
  const configTable = getTable('product_configs');
  const existing = configTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '配置表不存在' });

  const fields = { updated_at: now() };
  if (req.body.adjustable_params) fields.adjustable_params = JSON.stringify(req.body.adjustable_params);
  if (req.body.pricing_data) fields.pricing_data = JSON.stringify(req.body.pricing_data);
  if (req.body.status) fields.status = req.body.status;
  if (req.body.certificate_compliant !== undefined) fields.certificate_compliant = req.body.certificate_compliant;
  if (req.body.certificate_level !== undefined) fields.certificate_level = req.body.certificate_level;

  configTable.update(req.params.id, fields);
  res.json({ message: '配置表更新成功', data: configTable.findById(req.params.id) });
});

// ===== 报价单 =====

// 生成报价单
router.post('/generate-quotation', requirePerm('inquiry:create'), (req, res) => {
  const { inquiry_id, config_id, operator } = req.body;
  if (!inquiry_id) return res.status(400).json({ error: '询价单ID为必填项' });

  const inquiryTable = getTable('inquiries');
  const quotationTable = getTable('quotations');
  const configTable = getTable('product_configs');

  const inquiry = inquiryTable.findById(inquiry_id);
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });

  // 获取配置表
  let config = null;
  if (config_id) {
    config = configTable.findById(config_id);
  } else {
    // 查找关联的配置表
    const configs = configTable.all().filter(c => c.inquiry_id === Number(inquiry_id));
    config = configs[configs.length - 1] || null;
  }

  // 构建报价单数据
  const quotation = {
    quote_no: genQuoteNo(),
    inquiry_id: Number(inquiry_id),
    inquiry_no: inquiry.serial_number,
    customer_name: inquiry.customer_name,
    customer_source: inquiry.customer_source || '',
    country_region: inquiry.country_region || '',
    sales_person: inquiry.sales_person || '',
    external_model: inquiry.external_model,
    internal_model: inquiry.internal_model || '',
    product_name: inquiry.product_name || '',
    product_category: inquiry.product_category || '',
    power: inquiry.power || '',
    quantity: inquiry.quantity,
    certificate_compliant: config ? config.certificate_compliant : (inquiry.certificate_compliant || ''),
    certificate_level: config ? config.certificate_level : (inquiry.certificate_level || ''),
    // 价格信息
    material_cost: inquiry.material_cost || 0,
    process_cost: inquiry.process_cost || 0,
    accessory_cost: inquiry.accessory_cost || 0,
    estimated_loss: inquiry.estimated_loss || 0,
    base_cost: inquiry.base_cost || 0,
    profit_rate: inquiry.profit_rate || 0,
    discount_rate: inquiry.discount_rate || 0,
    final_price: inquiry.final_price || 0,
    unit_price: inquiry.quantity > 0 ? Math.round((inquiry.final_price || 0) / inquiry.quantity * 100) / 100 : 0,
    // 配置信息
    config_data: config ? config.adjustable_params : JSON.stringify({}),
    bom_data: config ? config.bom_details : '[]',
    pricing_data: config ? config.pricing_data : null,
    // 其他
    custom_requirements: inquiry.custom_requirements || '',
    special_process: inquiry.special_process || '',
    delivery_date: inquiry.delivery_date || '',
    quote_validity: inquiry.quote_validity || '30天',
    remarks: inquiry.remarks || '',
    status: 'draft',
    created_by: operator || inquiry.sales_person || 'system',
    created_at: now(),
    updated_at: now()
  };

  const result = quotationTable.insert(quotation);
  const saved = quotationTable.findById(result.lastID);

  // 更新询价单状态
  inquiryTable.update(inquiry_id, { status: 'quoted', quoted_at: now(), updated_at: now() });

  const statusTable = getTable('inquiry_status_changes');
  statusTable.insert({ inquiry_id: Number(inquiry_id), status: 'quoted', changed_by: operator || 'system', changed_at: now(), reason: '报价单生成' });

  logOperation('生成报价单', operator || 'system', `报价单 ${quotation.quote_no} 已生成`, Number(inquiry_id));

  res.json({ message: '报价单生成成功', data: saved });
});

// 报价单列表
router.get('/quotations', requirePerm('inquiry:view'), (req, res) => {
  const { page = 1, limit = 15, keyword, customer_name, status } = req.query;
  const quotationTable = getTable('quotations');
  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (customer_name && !(r.customer_name || '').includes(customer_name)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.quote_no, r.customer_name, r.external_model, r.internal_model, r.product_name, r.sales_person].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const { records, total } = quotationTable.findWhere(filter, 'created_at', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  res.json({ data: records, total, page: parseInt(page), limit: parseInt(limit) });
});

// 报价单详情
router.get('/quotations/:id', requirePerm('inquiry:view'), (req, res) => {
  const quotationTable = getTable('quotations');
  const row = quotationTable.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '报价单不存在' });
  res.json(row);
});

// 更新报价单
router.put('/quotations/:id', requirePerm('inquiry:edit'), (req, res) => {
  const quotationTable = getTable('quotations');
  const existing = quotationTable.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '报价单不存在' });

  const fields = { updated_at: now() };
  ['status', 'final_price', 'unit_price', 'profit_rate', 'discount_rate', 'remarks', 'quote_validity'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  quotationTable.update(req.params.id, fields);
  res.json({ message: '报价单更新成功', data: quotationTable.findById(req.params.id) });
});

// ===== 流程推送：提交至研发核价 =====
router.post('/:id/submit-pricing', requirePerm('inquiry:status'), (req, res) => {
  const { operator, config_id } = req.body;
  const table = getTable('inquiries');
  const inquiry = table.findById(req.params.id);
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });

  if (inquiry.status !== 'new' && inquiry.status !== 'cert_configured' && inquiry.status !== 'config_generated' && inquiry.status !== 'pending_pricing') {
    return res.status(400).json({ error: '当前状态不允许提交核价' });
  }

  table.update(req.params.id, { status: 'pending_pricing', updated_at: now() });

  // 更新配置表状态
  if (config_id) {
    const configTable = getTable('product_configs');
    configTable.update(config_id, { status: 'submitted', updated_at: now() });
  }

  const statusTable = getTable('inquiry_status_changes');
  statusTable.insert({ inquiry_id: Number(req.params.id), status: 'pending_pricing', changed_by: operator || 'system', changed_at: now(), reason: '销售提交研发核价' });

  logOperation('提交核价', operator || 'system', `询价单 ${inquiry.serial_number} 已提交研发核价`, Number(req.params.id));
  res.json({ message: '已提交研发核价' });
});

// ===== 研发核价确认 =====
router.post('/:id/confirm-pricing', requirePerm('inquiry:price'), (req, res) => {
  const { operator, material_cost, process_cost, accessory_cost, estimated_loss,
          base_cost, profit_rate, discount_rate, final_price, pricing_remarks } = req.body;
  const table = getTable('inquiries');
  const inquiry = table.findById(req.params.id);
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });

  if (inquiry.status !== 'pending_pricing') {
    return res.status(400).json({ error: '当前状态不允许核价确认' });
  }

  const updates = { status: 'pending_quote', updated_at: now() };
  if (material_cost !== undefined) updates.material_cost = Number(material_cost);
  if (process_cost !== undefined) updates.process_cost = Number(process_cost);
  if (accessory_cost !== undefined) updates.accessory_cost = Number(accessory_cost);
  if (estimated_loss !== undefined) updates.estimated_loss = Number(estimated_loss);
  if (base_cost !== undefined) updates.base_cost = Number(base_cost);
  if (profit_rate !== undefined) updates.profit_rate = Number(profit_rate);
  if (discount_rate !== undefined) updates.discount_rate = Number(discount_rate);
  if (final_price !== undefined) updates.final_price = Number(final_price);

  table.update(req.params.id, updates);

  const quotationTable = getTable('quotations');
  const updatedInquiry = table.findById(req.params.id);
  quotationTable.insert({
    quote_no: genQuoteNo(),
    inquiry_id: Number(req.params.id),
    inquiry_no: updatedInquiry.serial_number,
    customer_name: updatedInquiry.customer_name,
    customer_source: updatedInquiry.customer_source || '',
    country_region: updatedInquiry.country_region || '',
    sales_person: updatedInquiry.sales_person || '',
    external_model: updatedInquiry.external_model,
    internal_model: updatedInquiry.internal_model || '',
    product_name: updatedInquiry.product_name || '',
    product_category: updatedInquiry.product_category || '',
    power: updatedInquiry.power || '',
    quantity: updatedInquiry.quantity,
    discount_rate: updatedInquiry.discount_rate || 1,
    final_price: updatedInquiry.final_price || 0,
    unit_price: updatedInquiry.quantity > 0 ? Math.round((updatedInquiry.final_price || 0) / updatedInquiry.quantity * 100) / 100 : 0,
    config_data: JSON.stringify({
      input_voltage: updatedInquiry.input_voltage || '', battery: updatedInquiry.battery || '',
      color_temp: updatedInquiry.color_temp || '', luminous_flux: updatedInquiry.luminous_flux || '',
      light_source: updatedInquiry.light_source || '', main_body: updatedInquiry.main_body || '',
      lampshade: updatedInquiry.lampshade || '', reflector: updatedInquiry.reflector || '',
      cable: updatedInquiry.cable || '', switch_type: updatedInquiry.switch_type || '',
      usb: updatedInquiry.usb || '', waterproof: updatedInquiry.waterproof || '',
      sensor: updatedInquiry.sensor || '', configuration: updatedInquiry.configuration || ''
    }),
    bom_data: '[]',
    pricing_data: JSON.stringify({
      total_cost: updatedInquiry.base_cost || 0,
      price_rmb: updatedInquiry.final_price || 0,
      min_price: updatedInquiry.base_cost || 0,
      pricing_version: 'V1.0',
      effective_date: now().substring(0, 10)
    }),
    custom_requirements: updatedInquiry.custom_requirements || '',
    special_process: updatedInquiry.special_process || '',
    delivery_date: updatedInquiry.delivery_date || '',
    quote_validity: updatedInquiry.quote_validity || '30天',
    remarks: updatedInquiry.remarks || '',
    certificate_compliant: updatedInquiry.certificate_compliant || '',
    certificate_level: updatedInquiry.certificate_level || '',
    discount_rate: discount_rate || 0,
    status: 'confirmed',
    created_by: operator || 'system',
    created_at: now(), updated_at: now()
  });

  const statusTable = getTable('inquiry_status_changes');
  statusTable.insert({ inquiry_id: Number(req.params.id), status: 'pending_quote', changed_by: operator || 'system', changed_at: now(), reason: pricing_remarks || '研发核价确认，已生成报价单' });

  logOperation('核价确认', operator || 'system', `询价单 ${inquiry.serial_number} 核价完成，报价 ¥${final_price || inquiry.final_price}，已生成报价单`, Number(req.params.id));
  res.json({ message: '核价确认完成，已生成报价单' });
});

// ===== 批量导入 =====
router.post('/batch', requirePerm('inquiry:import'), (req, res) => {
  const inquiries = req.body;
  if (!Array.isArray(inquiries) || inquiries.length === 0) {
    return res.status(400).json({ error: '请提供询价单数组' });
  }
  const table = getTable('inquiries');
  let successCount = 0;
  let errorCount = 0;
  const errors = [];
  inquiries.forEach((item, index) => {
    try {
      if (!item.customer_name || !item.external_model || !item.quantity) {
        errorCount++;
        errors.push({ row: index + 1, error: '缺少必填字段(客户名称/产品型号/数量)' });
        return;
      }
      table.insert({
        serial_number: genSerial() + index,
        customer_name: item.customer_name, customer_source: item.customer_source,
        country_region: item.country_region || '',
        sales_person: item.sales_person, inquiry_time: now(),
        delivery_date: item.delivery_date, external_model: item.external_model,
        internal_model: item.internal_model, product_category: item.product_category,
        power: item.power, configuration: item.configuration, quantity: item.quantity,
        custom_requirements: item.custom_requirements, special_process: item.special_process,
        remarks: item.remarks, quote_validity: item.quote_validity,
        product_name: item.product_name || '',
        input_voltage: item.input_voltage || '', battery: item.battery || '',
        color_temp: item.color_temp || '', luminous_flux: item.luminous_flux || '',
        light_source: item.light_source || '', main_body: item.main_body || '',
        lampshade: item.lampshade || '', reflector: item.reflector || '',
        cable: item.cable || '', switch_type: item.switch_type || '',
        usb: item.usb || '', waterproof: item.waterproof || '', sensor: item.sensor || '',
        target_price: item.target_price || 0, quote_time_needed: item.quote_time_needed || '',
        certificate_compliant: item.certificate_compliant || '',
        certificate_level: item.certificate_level || '',
        status: 'new', material_cost: 0, process_cost: 0, accessory_cost: 0,
        estimated_loss: 0, base_cost: 0, profit_rate: 0, discount_rate: 0,
        final_price: 0, quoted_at: null, follow_up_records: '', lost_reason: '',
        created_at: now(), updated_at: now()
      });
      const lastInsert = table.all().slice(-1)[0];
      if (lastInsert) {
        const statusTable = getTable('inquiry_status_changes');
        statusTable.insert({ inquiry_id: lastInsert.id, status: 'new', changed_by: item.sales_person || 'system', changed_at: now(), reason: '批量导入创建' });
        logOperation('创建询价', item.sales_person || 'system', `批量导入询价单 ${lastInsert.serial_number} [new]`, lastInsert.id);
      }
      successCount++;
    } catch (e) {
      errorCount++;
      errors.push({ row: index + 1, error: e.message });
    }
  });
  logOperation('批量导入', 'system', `批量导入询价单，成功${successCount}条，失败${errorCount}条`, null);
  res.json({ success: successCount, error: errorCount, errors, message: `批量导入完成，成功${successCount}条，失败${errorCount}条` });
});

// ===== 批量导出 =====
router.post('/export', requirePerm('inquiry:export'), (req, res) => {
  const { status, customer_name, sales_person, start_date, end_date, keyword, product_model, ids } = req.body;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (ids && Array.isArray(ids) && ids.length > 0) return ids.includes(r.id);
    if (status && r.status !== status) return false;
    if (customer_name && !(r.customer_name || '').includes(customer_name)) return false;
    if (sales_person && !(r.sales_person || '').includes(sales_person)) return false;
    if (product_model && !(r.external_model || '').includes(product_model) && !(r.internal_model || '').includes(product_model)) return false;
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.serial_number, r.customer_name, r.external_model, r.internal_model,
        r.custom_requirements, r.remarks, r.sales_person, r.product_name, r.power,
        r.product_category, r.configuration, r.light_source, r.main_body,
        r.color_temp, r.waterproof, r.sensor, r.input_voltage, r.battery,
        r.cable, r.switch_type, r.lampshade, r.reflector, r.certificate_compliant, r.certificate_level].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const records = table.all().filter(filter);
  logOperation('批量导出', 'system', `导出询价单 ${records.length} 条`, null);
  res.json({ data: records, total: records.length });
});

// ===== 报价单Excel导出（按模板格式）=====
router.get('/quotations/:id/export-xlsx', requirePerm('inquiry:export'), (req, res) => {
  const quotationTable = getTable('quotations');
  const q = quotationTable.findById(req.params.id);
  if (!q) return res.status(404).json({ error: '报价单不存在' });

  // 获取询价单详细信息
  const inquiryTable = getTable('inquiries');
  const inq = inquiryTable.findById(q.inquiry_id);

  // 模板列：产品型号、产品名称、功率、输入电压、电池、色温、光通量/光效、光源、主体、压框、灯罩、反光罩、电缆线、开关、USB、防水等级、感应器、其他要求1、其他要求2、报价
  const headers = ['产品型号', '产品名称', '功率', '输入电压', '电池', '色温', '光通量/光效', '光源', '主体', '压框', '灯罩', '反光罩', '电缆线', '开关', 'USB', '防水等级', '感应器', '其他要求1', '其他要求2', '报价'];

  // 计算单价
  const quantity = q.quantity || 1;
  const unitPrice = q.final_price ? Math.round(q.final_price / quantity * 100) / 100 : 0;

  // 其他要求1：证书+配置信息
  let otherReq1 = '';
  if (q.certificate_compliant) otherReq1 += `证书合规: ${q.certificate_compliant}\n`;
  if (q.certificate_level) otherReq1 += `证书等级: ${q.certificate_level}\n`;
  if (q.custom_requirements) otherReq1 += q.custom_requirements;

  // 其他要求2：交期+有效期+备注
  let otherReq2 = '';
  if (q.delivery_date) otherReq2 += `交期: ${q.delivery_date}\n`;
  if (q.quote_validity) otherReq2 += `报价有效期: ${q.quote_validity}\n`;
  if (q.remarks) otherReq2 += q.remarks;

  const row = [
    q.external_model || '',
    q.product_name || (inq ? inq.product_name : '') || '',
    q.power || (inq ? inq.power : '') || '',
    inq ? (inq.input_voltage || '') : '',
    inq ? (inq.battery || '') : '',
    inq ? (inq.color_temp || '') : '',
    inq ? (inq.luminous_flux || '') : '',
    inq ? (inq.light_source || '') : '',
    inq ? (inq.main_body || '') : '',
    '', // 压框
    inq ? (inq.lampshade || '') : '',
    inq ? (inq.reflector || '') : '',
    inq ? (inq.cable || '') : '',
    inq ? (inq.switch_type || '') : '',
    inq ? (inq.usb || '') : '',
    inq ? (inq.waterproof || '') : '',
    inq ? (inq.sensor || '') : '',
    otherReq1.trim(),
    otherReq2.trim(),
    unitPrice
  ];

  // 创建工作簿
  const wb = XLSX.utils.book_new();
  const wsData = [headers, row];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // 设置列宽
  ws['!cols'] = [
    { wch: 22 }, // 产品型号
    { wch: 30 }, // 产品名称
    { wch: 8 },  // 功率
    { wch: 12 }, // 输入电压
    { wch: 8 },  // 电池
    { wch: 8 },  // 色温
    { wch: 12 }, // 光通量/光效
    { wch: 8 },  // 光源
    { wch: 10 }, // 主体
    { wch: 8 },  // 压框
    { wch: 10 }, // 灯罩
    { wch: 10 }, // 反光罩
    { wch: 25 }, // 电缆线
    { wch: 12 }, // 开关
    { wch: 20 }, // USB
    { wch: 10 }, // 防水等级
    { wch: 12 }, // 感应器
    { wch: 30 }, // 其他要求1
    { wch: 30 }, // 其他要求2
    { wch: 10 }, // 报价
  ];

  XLSX.utils.book_append_sheet(wb, ws, '配置表');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = encodeURIComponent(`报价单_${q.quote_no || q.inquiry_no}.xlsx`);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + fileName);
  res.send(buf);

  logOperation('导出报价单', 'system', `导出报价单 ${q.quote_no || q.inquiry_no}`, q.inquiry_id);
});

// ===== 导出配置表（按模板格式） =====
router.get('/:id/export-config-xlsx', requirePerm('inquiry:export'), (req, res) => {
  const inquiryTable = getTable('inquiries');
  const inq = inquiryTable.findById(req.params.id);
  if (!inq) return res.status(404).json({ error: '询价单不存在' });

  const csTable = getTable('config_sheets');
  let cs = csTable.all().find(s => s.inquiry_id === Number(req.params.id));
  let v = (field) => cs && cs[field] ? cs[field] : '/';

  if (!cs) {
    const configTable = getTable('product_configs');
    let config = configTable.all().find(c => c.inquiry_id === Number(req.params.id));
    let fp = {}, ap = {};
    if (config) {
      try { fp = JSON.parse(config.fixed_params); } catch(e) {}
      try { ap = JSON.parse(config.adjustable_params); } catch(e) {}
    }
    v = (field, apKey, inqKey) => {
      if (apKey && ap[apKey]) return ap[apKey];
      if (inqKey && inq[inqKey]) return inq[inqKey];
      return '/';
    };
    const vOld = v;
    v = (field, apKey, inqKey) => vOld(field, apKey, inqKey);
  }

  const wb = XLSX.utils.book_new();
  const rows = [
    ['宁波恒剑光电科技有限公司\n配置表', '', '', ''],
    ['型号：', '', inq.external_model || '', ''],
    ['序号', '配置明细', '', ''],
    ['1、结构', '1.1、壳体材质', cs ? v('shell_material') : (ap && ap.main_body) || inq.main_body || '/', ''],
    ['', '1.2、反光罩材质', cs ? v('reflector_material') : (ap && ap.reflector) || inq.reflector || '/', ''],
    ['', '1.3、支架', cs ? v('bracket') : '/', ''],
    ['', '1.4、手杆', cs ? v('handle_bar') : '/', ''],
    ['', '1.5、防水等级', cs ? v('waterproof') : (ap && ap.waterproof) || inq.waterproof || '/', ''],
    ['', '1.6、电缆线规格', cs ? v('cable_spec') : (ap && ap.cable) || inq.cable || '/', ''],
    ['', '1.7、螺丝材质', cs ? v('screw_material') : '/', ''],
    ['', '1.8、玻璃', cs ? v('glass') : '/', ''],
    ['2、电子技术参数', '2.1、光参数(LM)', cs ? v('luminous_flux') : (ap && ap.luminous_flux) || inq.luminous_flux || '/', ''],
    ['', '2.2、补偿后光参数（LM）', cs ? v('compensated_flux') : '/', ''],
    ['', '2.3、光效（LM/W）', cs ? v('light_efficiency') : '/', ''],
    ['', '2.4、电参数', cs ? v('electrical_params') : (ap && ap.input_voltage) || inq.input_voltage || '/', ''],
    ['', '2.5、色温(K)', cs ? v('cct') : (ap && ap.color_temp) || inq.color_temp || '/', ''],
    ['', '2.6、显指（RA)', cs ? v('ra') : '/', ''],
    ['', '2.7、灯珠数量', cs ? v('led_count') : (ap && ap.light_source) || inq.light_source || '/', ''],
    ['', '2.8、标称功率', cs ? v('rated_power') : inq.power || '/', ''],
    ['', '2.9、芯片方案', cs ? v('chip_solution') : '/', ''],
    ['', '2.10、电路板型号', cs ? v('pcb_model') : '/', ''],
    ['', '2.11、电池容量', cs ? v('battery_capacity') : (ap && ap.battery) || inq.battery || '/', ''],
    ['', '2.12、放电时间（h）', cs ? v('discharge_time') : '/', ''],
    ['', '2.13、充电时间（h）', cs ? v('charging_time') : '/', ''],
    ['3、包装', '3.1、内包', cs ? v('inner_pack') : '/', ''],
    ['', '3.2、外包', cs ? v('outer_pack') : '/', ''],
    ['', '3.3、运输要求', cs ? v('transport_req') : '/', ''],
    ['', '3.4、其他', cs ? v('pack_other') : '/', ''],
    ['4、证书', '4.1、认证需求', cs ? v('cert_need') : (inq.certificate_compliant ? `${inq.certificate_compliant} ${inq.certificate_level || ''}`.trim() : '/'), ''],
    ['5、特殊需求', '5.1、环保要求', cs ? v('env_req') : '/', ''],
    ['', '5.2、UV测试', cs ? v('uv_test') : '/', ''],
    ['', '5.3、盐雾测试', cs ? v('salt_spray') : '/', ''],
    ['', '5.4、其他', cs ? v('special_other') : inq.custom_requirements || '/', ''],
    [' 制作:                                                                审核：                                                       审批: ', '', '', '']
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
  ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 30 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, '配置表');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = encodeURIComponent(`配置表_${inq.external_model || inq.serial_number}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + fileName);
  res.send(buf);
  logOperation('导出配置表', 'system', `导出配置表 ${inq.external_model}`, Number(req.params.id));
});

// ===== 导出规格书 =====
router.get('/:id/export-spec-xlsx', requirePerm('inquiry:export'), (req, res) => {
  const inquiryTable = getTable('inquiries');
  const inq = inquiryTable.findById(req.params.id);
  if (!inq) return res.status(404).json({ error: '询价单不存在' });

  const ssTable = getTable('spec_sheets');
  let ss = ssTable.all().find(s => s.inquiry_id === Number(req.params.id));
  let sv = (field) => ss && ss[field] ? ss[field] : '/';

  if (!ss) {
    const configTable = getTable('product_configs');
    let config = configTable.all().find(c => c.inquiry_id === Number(req.params.id));
    let fp = {}, ap = {};
    if (config) {
      try { fp = JSON.parse(config.fixed_params); } catch(e) {}
      try { ap = JSON.parse(config.adjustable_params); } catch(e) {}
    }
    sv = (field, apKey, inqKey, fpKey) => {
      if (apKey && ap[apKey]) return ap[apKey];
      if (inqKey && inq[inqKey]) return inq[inqKey];
      if (fpKey && fp[fpKey]) return fp[fpKey];
      return '/';
    };
  }

  const desc = ss ? sv('description') : (inq.product_name || (typeof fp !== 'undefined' && fp.product_name) || '/');
  const model = ss ? sv('model_no') : (inq.external_model || '/');
  const version = ss ? sv('version') : 'B/1';

  const wb = XLSX.utils.book_new();
  const rows = [
    ['', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['产品规格书 SPECIFICATIONS', '', '', '', '', '', ''],
    ['', '', '', '', '           表格编号（File No.）：HJ/ED/R-21', '', ''],
    ['产 品 类 型 （Description）', '', desc, '', '版 本 （Version ）', version, ''],
    ['产 品 型 号 （Model No.）', '', model, '', '日 期 （Date）', new Date().toISOString().slice(0,10).replace(/-/g,'.'), ''],
    ['产 品 规 格 表 （Technical Parameters）', '', '', '配光曲线图 Lighting Distribution', '', '', ''],
    ['光源  （Light Source）：', ss ? sv('light_source') : ((typeof ap !== 'undefined' && ap.light_source) || inq.light_source || '/'), '', '', '', '', ''],
    ['系统功率 （Power）：', ss ? sv('power') : (inq.power || '/'), '', '', '', '', ''],
    ['输入输出电压 （Input Voltage）：', ss ? sv('input_voltage') : ((typeof ap !== 'undefined' && ap.input_voltage) || inq.input_voltage || '/'), '', '', '', '', ''],
    ['功率因素 （Power Efficeiency）：', ss ? sv('power_efficiency') : '/', '', '', '', '', ''],
    ['发光角度 （Beam Angle）：', ss ? sv('beam_angle') : '/', '', '', '', '', ''],
    ['有效光通量 （Luminous Flux）：', ss ? sv('luminous_flux') : ((typeof ap !== 'undefined' && ap.luminous_flux) || inq.luminous_flux || '/'), '', '', '', '', ''],
    ['色温 （CCT）：', ss ? sv('cct') : ((typeof ap !== 'undefined' && ap.color_temp) || inq.color_temp || '/'), '', '', '', '', ''],
    ['显色指数 （RA）：', ss ? sv('ra') : '/', '', '', '', '', ''],
    ['工作环境温度 （Ta）：', ss ? sv('ta') : '/', '', '', '', '', ''],
    ['灯具寿命（Life Time）：', ss ? sv('life_time') : '/', '', '', '', '', ''],
    ['IP 等级（IP Rating）：', ss ? sv('ip_rating') : ((typeof ap !== 'undefined' && ap.waterproof) || inq.waterproof || '/'), '', '产品外型图Picture', '', '', ''],
    ['灯壳材质', ss ? sv('shell_material') : ((typeof ap !== 'undefined' && ap.main_body) || inq.main_body || '/'), '', '', '', '', ''],
    ['反光罩材质', ss ? sv('reflector_material') : ((typeof ap !== 'undefined' && ap.reflector) || inq.reflector || '/'), '', '', '', '', ''],
    ['电池容量（Battery capacity ）：', ss ? sv('battery_capacity') : ((typeof ap !== 'undefined' && ap.battery) || inq.battery || '/'), '', '', '', '', ''],
    ['连续放时间（Continuous discharge time）：', ss ? sv('discharge_time') : '', '', '', '', '', ''],
    ['充电时间（Charging time）：', ss ? sv('charging_time') : '', '', '', '', '', ''],
    ['开关（Switch）：', ss ? sv('switch_type') : ((typeof ap !== 'undefined' && ap.switch_type) || inq.switch_type || '/'), '', '', '', '', ''],
    ['产品尺寸 （Dimension）：', ss ? sv('dimension') : '/', '', '', '', '', ''],
    ['产品重量 （Net Weight）：', ss ? sv('net_weight') : '/', '', '', '', '', ''],
    ['白盒尺寸 （Size of Inbox）：', ss ? sv('inbox_size') : '/', '', '', '', '', ''],
    ['外箱尺寸 （Size of Carton）：', ss ? sv('carton_size') : '/', '', '', '', '', ''],
    ['单箱毛净重（G.W & N.W.）', ss ? sv('gw_nw') : '/', '', '', '', '', ''],
    ['电缆线规格', ss ? sv('cable_spec') : ((typeof ap !== 'undefined' && ap.cable) || inq.cable || '/'), '', '', '', '', ''],
    ['产品尺寸图:Dimension:', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['制作                                                    审核                                                                                              审批', '', '', '', '', '', '']
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = [
    { s: { c: 0, r: 0 }, e: { c: 6, r: 1 } },
    { s: { c: 0, r: 2 }, e: { c: 6, r: 2 } },
    { s: { c: 4, r: 3 }, e: { c: 6, r: 3 } },
    { s: { c: 0, r: 4 }, e: { c: 1, r: 4 } },
    { s: { c: 2, r: 4 }, e: { c: 3, r: 4 } },
    { s: { c: 5, r: 4 }, e: { c: 6, r: 4 } },
    { s: { c: 0, r: 5 }, e: { c: 1, r: 5 } },
    { s: { c: 2, r: 5 }, e: { c: 3, r: 5 } },
    { s: { c: 5, r: 5 }, e: { c: 6, r: 5 } },
    { s: { c: 0, r: 6 }, e: { c: 2, r: 6 } },
    { s: { c: 3, r: 6 }, e: { c: 6, r: 6 } },
    { s: { c: 1, r: 7 }, e: { c: 2, r: 7 } },
    { s: { c: 3, r: 7 }, e: { c: 6, r: 16 } },
    { s: { c: 1, r: 8 }, e: { c: 2, r: 8 } },
    { s: { c: 1, r: 9 }, e: { c: 2, r: 9 } },
    { s: { c: 1, r: 10 }, e: { c: 2, r: 10 } },
    { s: { c: 1, r: 11 }, e: { c: 2, r: 11 } },
    { s: { c: 1, r: 12 }, e: { c: 2, r: 12 } },
    { s: { c: 1, r: 13 }, e: { c: 2, r: 13 } },
    { s: { c: 1, r: 14 }, e: { c: 2, r: 14 } },
    { s: { c: 1, r: 15 }, e: { c: 2, r: 15 } },
    { s: { c: 1, r: 16 }, e: { c: 2, r: 16 } },
    { s: { c: 1, r: 17 }, e: { c: 2, r: 17 } },
    { s: { c: 3, r: 17 }, e: { c: 6, r: 17 } },
    { s: { c: 1, r: 18 }, e: { c: 2, r: 18 } },
    { s: { c: 3, r: 18 }, e: { c: 6, r: 27 } },
    { s: { c: 1, r: 19 }, e: { c: 2, r: 19 } },
    { s: { c: 1, r: 20 }, e: { c: 2, r: 20 } },
    { s: { c: 1, r: 21 }, e: { c: 2, r: 21 } },
    { s: { c: 1, r: 22 }, e: { c: 2, r: 22 } },
    { s: { c: 1, r: 23 }, e: { c: 2, r: 23 } },
    { s: { c: 1, r: 24 }, e: { c: 2, r: 24 } },
    { s: { c: 1, r: 25 }, e: { c: 2, r: 25 } },
    { s: { c: 1, r: 26 }, e: { c: 2, r: 26 } },
    { s: { c: 1, r: 27 }, e: { c: 2, r: 27 } },
    { s: { c: 0, r: 28 }, e: { c: 6, r: 28 } },
    { s: { c: 0, r: 29 }, e: { c: 6, r: 29 } },
    { s: { c: 0, r: 32 }, e: { c: 6, r: 32 } }
  ];
  ws['!cols'] = [
    { wch: 30 }, { wch: 14 }, { wch: 10 },
    { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 10 }
  ];
  ws['!rows'] = [
    { hpt: 20 }, { hpt: 20 },
    { hpt: 30 },
    { hpt: 18 },
    { hpt: 22 }, { hpt: 22 },
    { hpt: 22 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, '规格书');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = encodeURIComponent(`规格书_${inq.external_model || inq.serial_number}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + fileName);
  res.send(buf);
  logOperation('导出规格书', 'system', `导出规格书 ${inq.external_model}`, Number(req.params.id));
});

// ===== 导出规格书PDF =====
router.get('/:id/export-spec-pdf', requirePerm('inquiry:export'), (req, res) => {
  const inquiryTable = getTable('inquiries');
  const inq = inquiryTable.findById(req.params.id);
  if (!inq) return res.status(404).json({ error: '询价单不存在' });

  const ssTable = getTable('spec_sheets');
  let ss = ssTable.all().find(s => s.inquiry_id === Number(req.params.id));
  let sv = (f) => ss && ss[f] ? ss[f] : '/';

  if (!ss) {
    const configTable = getTable('product_configs');
    let config = configTable.all().find(c => c.inquiry_id === Number(req.params.id));
    let fp2 = {}, ap2 = {};
    if (config) {
      try { fp2 = JSON.parse(config.fixed_params); } catch(e) {}
      try { ap2 = JSON.parse(config.adjustable_params); } catch(e) {}
    }
    sv = (f, apK, inqK) => {
      if (apK && ap2[apK]) return ap2[apK];
      if (inqK && inq[inqK]) return inq[inqK];
      return '/';
    };
  }

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const fileName = encodeURIComponent(`规格书_${inq.external_model || inq.serial_number}.pdf`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + fileName);
  doc.pipe(res);

  const path = require('path');
  const fs = require('fs');
  let hasChineseFont = false;
  const fontCandidates = [
    path.join(__dirname, '..', 'fonts', 'SimHei.ttf'),
    path.join(__dirname, '..', 'fonts', 'SimSun.ttf'),
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simfang.ttf'
  ];
  let fontPath = '';
  for (const fp of fontCandidates) {
    if (fs.existsSync(fp)) { fontPath = fp; hasChineseFont = true; break; }
  }
  if (hasChineseFont) {
    doc.registerFont('Chinese', fontPath);
  }
  const fn = hasChineseFont ? 'Chinese' : 'Helvetica';
  const fnBold = hasChineseFont ? 'Chinese' : 'Helvetica-Bold';

  const pageW = doc.page.width - 80;
  const leftCol = 280;
  const rightCol = pageW - leftCol;
  const rowH = 22;
  const labelW = 160;
  const valueW = leftCol - labelW;

  doc.font(fnBold).fontSize(16).text('产品规格书 SPECIFICATIONS', { align: 'center' });
  doc.moveDown(0.3);
  doc.font(fn).fontSize(9).text('表格编号（File No.）：HJ/ED/R-21', { align: 'right' });
  doc.moveDown(0.5);

  const desc = ss ? ss.description : (inq.product_name || '/');
  const model = ss ? ss.model_no : (inq.external_model || '/');
  const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'.');

  const infoY = doc.y;
  doc.font(fn).fontSize(9);
  doc.text('产 品 类 型 （Description）', 40, infoY, { width: labelW });
  doc.text(desc, 40 + labelW, infoY, { width: valueW });
  doc.text('版 本 （Version ）', 40 + leftCol, infoY, { width: 80 });
  doc.text(ss ? ss.version : 'B/1', 40 + leftCol + 80, infoY);
  const infoY2 = infoY + rowH;
  doc.text('产 品 型 号 （Model No.）', 40, infoY2, { width: labelW });
  doc.text(model, 40 + labelW, infoY2, { width: valueW });
  doc.text('日 期 （Date）', 40 + leftCol, infoY2, { width: 80 });
  doc.text(dateStr, 40 + leftCol + 80, infoY2);
  doc.y = infoY2 + rowH + 5;

  doc.font(fnBold).fontSize(10).text('产 品 规 格 表 （Technical Parameters）', 40, doc.y, { width: leftCol });
  const tableTop = doc.y + 18;

  const specRows = [
    ['光源  （Light Source）：', ss ? sv('light_source') : sv('light_source','light_source','light_source')],
    ['系统功率 （Power）：', ss ? sv('power') : sv('power','power','power')],
    ['输入输出电压 （Input Voltage）：', ss ? sv('input_voltage') : sv('input_voltage','input_voltage','input_voltage')],
    ['功率因素 （Power Efficeiency）：', ss ? sv('power_efficiency') : '/'],
    ['发光角度 （Beam Angle）：', ss ? sv('beam_angle') : '/'],
    ['有效光通量 （Luminous Flux）：', ss ? sv('luminous_flux') : sv('luminous_flux','luminous_flux','luminous_flux')],
    ['色温 （CCT）：', ss ? sv('cct') : sv('cct','color_temp','color_temp')],
    ['显色指数 （RA）：', ss ? sv('ra') : '/'],
    ['工作环境温度 （Ta）：', ss ? sv('ta') : '/'],
    ['灯具寿命（Life Time）：', ss ? sv('life_time') : '/'],
    ['IP 等级（IP Rating）：', ss ? sv('ip_rating') : sv('ip_rating','waterproof','waterproof')],
    ['灯壳材质', ss ? sv('shell_material') : sv('shell_material','main_body','main_body')],
    ['反光罩材质', ss ? sv('reflector_material') : sv('reflector_material','reflector','reflector')],
    ['电池容量（Battery capacity ）：', ss ? sv('battery_capacity') : sv('battery_capacity','battery','battery')],
    ['连续放时间（Continuous discharge time）：', ss ? sv('discharge_time') : '/'],
    ['充电时间（Charging time）：', ss ? sv('charging_time') : '/'],
    ['开关（Switch）：', ss ? sv('switch_type') : sv('switch_type','switch_type','switch_type')],
    ['产品尺寸 （Dimension）：', ss ? sv('dimension') : '/'],
    ['产品重量 （Net Weight）：', ss ? sv('net_weight') : '/'],
    ['白盒尺寸 （Size of Inbox）：', ss ? sv('inbox_size') : '/'],
    ['外箱尺寸 （Size of Carton）：', ss ? sv('carton_size') : '/'],
    ['单箱毛净重（G.W & N.W.）', ss ? sv('gw_nw') : '/'],
    ['电缆线规格', ss ? sv('cable_spec') : sv('cable_spec','cable','cable')]
  ];

  doc.font(fn).fontSize(8);
  let curY = tableTop;
  specRows.forEach(([label, value]) => {
    doc.text(label, 45, curY, { width: labelW - 10 });
    doc.text(value, 45 + labelW, curY, { width: leftCol - labelW - 10 });
    curY += rowH;
  });

  const rightBoxTop = tableTop - 18;
  doc.rect(40 + leftCol, rightBoxTop, rightCol, (specRows.length * rowH) + 18).stroke();
  doc.font(fnBold).fontSize(9).text('配光曲线图 / 产品外型图', 40 + leftCol + 10, rightBoxTop + 5, { width: rightCol - 20 });

  doc.rect(40, tableTop - 2, leftCol, specRows.length * rowH).stroke();

  doc.y = curY + 10;
  doc.font(fn).fontSize(9).text('产品尺寸图:Dimension:', 40, doc.y);
  doc.moveDown(1.5);
  doc.font(fn).fontSize(9).text('制作                    审核                    审批', 40, doc.y);

  doc.end();
  logOperation('导出规格书PDF', 'system', `导出规格书PDF ${inq.external_model}`, Number(req.params.id));
});

// ===== 导出配置表PDF =====
router.get('/:id/export-config-pdf', requirePerm('inquiry:export'), (req, res) => {
  const inquiryTable = getTable('inquiries');
  const inq = inquiryTable.findById(req.params.id);
  if (!inq) return res.status(404).json({ error: '询价单不存在' });

  const csTable = getTable('config_sheets');
  let cs = csTable.all().find(s => s.inquiry_id === Number(req.params.id));
  let cv = (f) => cs && cs[f] ? cs[f] : '/';

  if (!cs) {
    const configTable = getTable('product_configs');
    let config = configTable.all().find(c => c.inquiry_id === Number(req.params.id));
    let fp2 = {}, ap2 = {};
    if (config) {
      try { fp2 = JSON.parse(config.fixed_params); } catch(e) {}
      try { ap2 = JSON.parse(config.adjustable_params); } catch(e) {}
    }
    cv = (f, apK, inqK) => {
      if (apK && ap2[apK]) return ap2[apK];
      if (inqK && inq[inqK]) return inq[inqK];
      return '/';
    };
  }

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const fileName = encodeURIComponent(`配置表_${inq.external_model || inq.serial_number}.pdf`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + fileName);
  doc.pipe(res);

  const path = require('path');
  const fs = require('fs');
  let hasChineseFont = false;
  const fontCandidates = [
    path.join(__dirname, '..', 'fonts', 'SimHei.ttf'),
    path.join(__dirname, '..', 'fonts', 'SimSun.ttf'),
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simfang.ttf'
  ];
  let fontPath = '';
  for (const fp of fontCandidates) {
    if (fs.existsSync(fp)) { fontPath = fp; hasChineseFont = true; break; }
  }
  if (hasChineseFont) {
    doc.registerFont('Chinese', fontPath);
  }
  const fn = hasChineseFont ? 'Chinese' : 'Helvetica';
  const fnBold = hasChineseFont ? 'Chinese' : 'Helvetica-Bold';

  const pageW = doc.page.width - 80;
  const col1 = 80;
  const col2 = 160;
  const col3 = pageW - col1 - col2;
  const rowH = 20;

  doc.font(fnBold).fontSize(14).text('宁波恒剑光电科技有限公司', { align: 'center' });
  doc.font(fnBold).fontSize(12).text('配置表', { align: 'center' });
  doc.moveDown(0.5);
  doc.font(fn).fontSize(10).text(`型号：${inq.external_model || '-'}`, 40);
  doc.moveDown(0.5);

  const sections = [
    { title: '1、结构', items: [
      ['1.1、壳体材质', cs ? cv('shell_material') : cv('shell_material','main_body','main_body')],
      ['1.2、反光罩材质', cs ? cv('reflector_material') : cv('reflector_material','reflector','reflector')],
      ['1.3、支架', cs ? cv('bracket') : '/'],
      ['1.4、手杆', cs ? cv('handle_bar') : '/'],
      ['1.5、防水等级', cs ? cv('waterproof') : cv('waterproof','waterproof','waterproof')],
      ['1.6、电缆线规格', cs ? cv('cable_spec') : cv('cable_spec','cable','cable')],
      ['1.7、螺丝材质', cs ? cv('screw_material') : '/'],
      ['1.8、玻璃', cs ? cv('glass') : '/']
    ]},
    { title: '2、电子技术参数', items: [
      ['2.1、光参数(LM)', cs ? cv('luminous_flux') : cv('luminous_flux','luminous_flux','luminous_flux')],
      ['2.2、补偿后光参数（LM）', cs ? cv('compensated_flux') : '/'],
      ['2.3、光效（LM/W）', cs ? cv('light_efficiency') : '/'],
      ['2.4、电参数', cs ? cv('electrical_params') : cv('electrical_params','input_voltage','input_voltage')],
      ['2.5、色温(K)', cs ? cv('cct') : cv('cct','color_temp','color_temp')],
      ['2.6、显指（RA)', cs ? cv('ra') : '/'],
      ['2.7、灯珠数量', cs ? cv('led_count') : cv('led_count','light_source','light_source')],
      ['2.8、标称功率', cs ? cv('rated_power') : cv('rated_power','power','power')],
      ['2.9、芯片方案', cs ? cv('chip_solution') : '/'],
      ['2.10、电路板型号', cs ? cv('pcb_model') : '/'],
      ['2.11、电池容量', cs ? cv('battery_capacity') : cv('battery_capacity','battery','battery')],
      ['2.12、放电时间（h）', cs ? cv('discharge_time') : '/'],
      ['2.13、充电时间（h）', cs ? cv('charging_time') : '/']
    ]},
    { title: '3、包装', items: [
      ['3.1、内包', cs ? cv('inner_pack') : '/'],
      ['3.2、外包', cs ? cv('outer_pack') : '/'],
      ['3.3、运输要求', cs ? cv('transport_req') : '/'],
      ['3.4、其他', cs ? cv('pack_other') : '/']
    ]},
    { title: '4、证书', items: [
      ['4.1、认证需求', cs ? cv('cert_need') : (inq.certificate_compliant ? `${inq.certificate_compliant} ${inq.certificate_level || ''}`.trim() : '/')]
    ]},
    { title: '5、特殊需求', items: [
      ['5.1、环保要求', cs ? cv('env_req') : '/'],
      ['5.2、UV测试', cs ? cv('uv_test') : '/'],
      ['5.3、盐雾测试', cs ? cv('salt_spray') : '/'],
      ['5.4、其他', cs ? cv('special_other') : (inq.custom_requirements || '/')]
    ]}
  ];

  let curY = doc.y;
  doc.font(fn).fontSize(8);

  sections.forEach(sec => {
    const secH = sec.items.length * rowH;
    if (curY + secH + 10 > doc.page.height - 60) {
      doc.addPage();
      curY = 40;
    }
    doc.rect(40, curY, col1, secH).stroke();
    doc.font(fnBold).fontSize(8).text(sec.title, 42, curY + 4, { width: col1 - 4 });

    sec.items.forEach((item, idx) => {
      const itemY = curY + idx * rowH;
      doc.rect(40 + col1, itemY, col2, rowH).stroke();
      doc.rect(40 + col1 + col2, itemY, col3, rowH).stroke();
      doc.font(fn).fontSize(8).text(item[0], 42 + col1, itemY + 4, { width: col2 - 4 });
      doc.text(item[1], 42 + col1 + col2, itemY + 4, { width: col3 - 4 });
    });
    curY += secH;
  });

  curY += 20;
  doc.font(fn).fontSize(9).text('制作                    审核                    审批', 40, curY);

  doc.end();
  logOperation('导出配置表PDF', 'system', `导出配置表PDF ${inq.external_model}`, Number(req.params.id));
});

// ===== 发送邮件（报价单/规格书/配置表） =====
router.post('/:id/send-email', requirePerm('inquiry:edit'), async (req, res) => {
  const { to, cc, subject, body, attachments } = req.body;
  if (!to) return res.status(400).json({ error: '收件人邮箱为必填项' });

  const inquiryTable = getTable('inquiries');
  const inq = inquiryTable.findById(req.params.id);
  if (!inq) return res.status(404).json({ error: '询价单不存在' });

  const emailLog = {
    inquiry_id: Number(req.params.id),
    inquiry_no: inq.serial_number,
    to, cc: cc || '', subject: subject || `报价通知 - ${inq.external_model}`,
    body: body || '',
    attachments: JSON.stringify(attachments || []),
    status: 'sent',
    sent_at: now(),
    created_at: now()
  };

  const emailTable = getTable('email_logs');
  const result = emailTable.insert(emailLog);

  logOperation('发送邮件', 'system', `询价单 ${inq.serial_number} 发送邮件至 ${to} 附件:${(attachments||[]).join(',')}`, Number(req.params.id));

  res.json({
    message: '邮件已发送',
    data: { ...emailLog, id: result.lastID },
    preview: {
      to,
      cc: cc || '',
      subject: subject || `报价通知 - ${inq.external_model}`,
      attachment_count: (attachments || []).length,
      attachment_names: (attachments || []).map(a => {
        const nameMap = { quotation: '报价单', config: '配置表', spec: '规格书' };
        return nameMap[a] || a;
      })
    }
  });
});

// ===== 批量修改 =====
router.post('/batch-update', requirePerm('inquiry:edit'), (req, res) => {
  const { ids, fields, operator } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请提供要修改的询价单ID数组' });
  if (!fields || Object.keys(fields).length === 0) return res.status(400).json({ error: '请提供要修改的字段' });

  const allowedFields = ['status', 'sales_person', 'customer_source', 'country_region', 'remarks'];
  const updateFields = {};
  allowedFields.forEach(f => { if (fields[f] !== undefined) updateFields[f] = fields[f]; });
  updateFields.updated_at = now();

  const validTransitions = {
    'new': ['cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'lost'],
    'cert_configured': ['config_generated', 'pending_pricing', 'new', 'lost'],
    'config_generated': ['pending_pricing', 'cert_configured', 'new', 'lost'],
    'pending_pricing': ['pending_quote', 'quoted', 'config_generated', 'lost'],
    'pending_quote': ['quoted', 'config_generated', 'lost'],
    'quoted': ['negotiating', 'sample', 'project', 'closed', 'lost'],
    'negotiating': ['sample', 'project', 'lost', 'quoted', 'closed'],
    'sample': ['project', 'closed', 'lost'],
    'project': ['closed', 'lost'],
    'lost': ['new'],
    'closed': []
  };

  const table = getTable('inquiries');
  const statusTable = getTable('inquiry_status_changes');
  let successCount = 0;
  const skippedIds = [];
  ids.forEach(id => {
    const existing = table.findById(id);
    if (!existing) return;
    if (updateFields.status && updateFields.status !== existing.status) {
      const allowed = validTransitions[existing.status] || [];
      if (!allowed.includes(updateFields.status)) {
        skippedIds.push({ id, from: existing.status, to: updateFields.status });
        return;
      }
      statusTable.insert({ inquiry_id: Number(id), status: updateFields.status, changed_by: operator || 'system', changed_at: now(), reason: '批量修改状态' });
    }
    table.update(id, updateFields);
    successCount++;
  });
  logOperation('批量修改', operator || 'system', `批量修改询价单 ${successCount} 条${skippedIds.length > 0 ? '，跳过违规' + skippedIds.length + '条' : ''}`, null);
  res.json({ success: successCount, skipped: skippedIds, message: `批量修改完成，成功${successCount}条${skippedIds.length > 0 ? '，跳过违规状态跳转' + skippedIds.length + '条' : ''}` });
});

// ===== 按询价单号批量导入报价库信息（回填询价单报价字段，自动推进状态）=====
router.post('/import-pricing', requirePerm('inquiry:price'), uploadMem.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  try {
    const rows = parseImportFile(req.file.buffer, req.file.originalname);
    if (!rows.length) return res.status(400).json({ error: '文件中没有数据' });

    // 中文表头 → 字段
    const headerMap = {
      '询价单号': 'serial_number', '单号': 'serial_number', '询价号': 'serial_number', '询价编号': 'serial_number',
      '物料成本': 'material_cost', '材料成本': 'material_cost',
      '加工成本': 'process_cost', '加工费': 'process_cost', '工艺成本': 'process_cost', '工艺费': 'process_cost',
      '辅料成本': 'accessory_cost', '配件费': 'accessory_cost', '配件成本': 'accessory_cost',
      '预计损耗': 'estimated_loss', '损耗': 'estimated_loss',
      '基础成本': 'base_cost', '成本合计': 'base_cost', '合计成本': 'base_cost', '总成本': 'base_cost',
      '利润率': 'profit_rate', '利润': 'profit_rate',
      '优惠率': 'discount_rate', '折扣率': 'discount_rate', '折扣': 'discount_rate',
      '最终报价': 'final_price', '报价': 'final_price', '金额': 'final_price', '人民币报价': 'final_price', '报价(rmb)': 'final_price', '报价rmb': 'final_price',
      '美元报价': 'quoted_price_usd', '报价(usd)': 'quoted_price_usd', '报价usd': 'quoted_price_usd', '美金报价': 'quoted_price_usd'
    };

    // 支持前端传回的自定义列映射
    let customMapping = null;
    try { customMapping = req.body.fieldMapping ? JSON.parse(req.body.fieldMapping) : null; } catch (e) {}

    const table = getTable('inquiries');
    const statusTable = getTable('inquiry_status_changes');
    table._invalidate();
    const all = table.all();
    const operator = req.body.operator || 'system';

    let updated = 0, skipped = 0, notFound = 0;
    const errors = [];
    const preQuoteStates = ['new', 'cert_configured', 'config_generated', 'pending_pricing', 'pending_quote'];

    rows.forEach((rawRow, index) => {
      // 行字段映射
      let mapped;
      if (customMapping && Object.keys(customMapping).length) {
        mapped = {};
        for (const [col, field] of Object.entries(customMapping)) {
          if (!field) continue;
          const c = String(col).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, '');
          const rawKey = Object.keys(rawRow).find(k => String(k).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, '') === c);
          if (rawKey !== undefined) mapped[field] = rawRow[rawKey];
        }
      } else {
        mapped = {};
        for (const [k, v] of Object.entries(rawRow)) {
          const key = String(k).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, '');
          const field = headerMap[key] || headerMap[key.toLowerCase()];
          if (field) mapped[field] = v;
        }
      }

      // 按询价单号匹配
      const sn = String(mapped.serial_number || '').trim();
      if (!sn) { skipped++; errors.push({ row: index + 2, errors: ['缺少询价单号，无法匹配'] }); return; }

      let inq = all.find(i => i.serial_number === sn);
      if (!inq) {
        const low = sn.toLowerCase();
        inq = all.find(i => {
          const s = (i.serial_number || '').toLowerCase();
          return s && (s.includes(low) || low.includes(s));
        });
      }
      if (!inq) { notFound++; errors.push({ row: index + 2, errors: [`未找到询价单号: ${sn}`] }); return; }

      // 组装更新字段
      const fields = { updated_at: now() };
      const numClean = v => Number(String(v).replace(/[,，¥$\s]/g, ''));
      ['material_cost', 'process_cost', 'accessory_cost', 'estimated_loss', 'base_cost', 'final_price', 'quoted_price_usd'].forEach(f => {
        if (mapped[f] !== undefined && mapped[f] !== '' && mapped[f] !== null) {
          const n = numClean(mapped[f]);
          if (!isNaN(n)) fields[f] = n;
        }
      });
      // 利润率/优惠率：>1 视为百分比，自动转小数
      ['profit_rate', 'discount_rate'].forEach(f => {
        if (mapped[f] !== undefined && mapped[f] !== '' && mapped[f] !== null) {
          let n = numClean(String(mapped[f]).replace(/[%％]/g, ''));
          if (!isNaN(n)) { if (n > 1) n = n / 100; fields[f] = n; }
        }
      });

      if (Object.keys(fields).length <= 1) {
        skipped++; errors.push({ row: index + 2, errors: [`询价单 ${sn} 未识别到可更新的报价字段`] }); return;
      }

      // 有最终报价且处于报价前状态 → 自动推进为已报价
      if (fields.final_price !== undefined && fields.final_price > 0 && preQuoteStates.includes(inq.status)) {
        fields.status = 'quoted';
        fields.quoted_at = now();
        statusTable.insert({ inquiry_id: Number(inq.id), status: 'quoted', changed_by: operator, changed_at: now(), reason: '批量导入报价库信息' });
      }

      table.update(inq.id, fields);
      updated++;
    });

    table._invalidate();
    logOperation('批量导入报价库信息', operator, `按询价单号回填报价：更新 ${updated} 条，未找到 ${notFound} 条，跳过 ${skipped} 条`, null);
    res.json({
      message: `报价库信息导入完成：更新 ${updated} 条，未找到 ${notFound} 条，跳过 ${skipped} 条`,
      imported: updated,
      skipped: skipped + notFound,
      total: rows.length,
      updated, notFound,
      errors: errors.slice(0, 30)
    });
  } catch (e) {
    res.status(500).json({ error: `文件解析失败: ${e.message}` });
  }
});

// ===== CRUD路由 =====

// 询价单列表（分页+筛选+模糊搜索）
router.get('/', requirePerm('inquiry:view'), (req, res) => {
  const { page = 1, limit = 10, status, customer_name, sales_person, start_date, end_date, keyword, product_model } = req.query;
  const table = getTable('inquiries');
  const filter = (r) => {
    if (status && r.status !== status) return false;
    if (customer_name && !(r.customer_name || '').includes(customer_name)) return false;
    if (sales_person && !(r.sales_person || '').includes(sales_person)) return false;
    if (product_model && !(r.external_model || '').includes(product_model) && !(r.internal_model || '').includes(product_model)) return false;
    if (start_date && r.inquiry_time < start_date) return false;
    if (end_date && r.inquiry_time > end_date) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.serial_number, r.customer_name, r.external_model, r.internal_model,
        r.custom_requirements, r.remarks, r.sales_person, r.product_name, r.power,
        r.product_category, r.configuration, r.light_source, r.main_body,
        r.color_temp, r.waterproof, r.sensor, r.input_voltage, r.battery,
        r.cable, r.switch_type, r.lampshade, r.reflector, r.certificate_compliant, r.certificate_level].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const { records, total } = table.findWhere(filter, 'inquiry_time', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

  // 附加每个询价单的配置信息
  const configTable = getTable('product_configs');
  const quotationTable = getTable('quotations');
  const custTable = getTable('customers');
  const recordsWithConfig = records.map(r => {
    const configs = configTable.all().filter(c => c.inquiry_id === Number(r.id));
    const quotations = quotationTable.all().filter(q => q.inquiry_id === Number(r.id));
    // 自动填充客户代码
    if (!r.customer_code && r.customer_name) {
      const cust = custTable.all().find(c => c.name === r.customer_name);
      if (cust && cust.customer_code) {
        r.customer_code = cust.customer_code;
        table.update(r.id, { customer_code: cust.customer_code });
      }
    }
    return { ...r, config_count: configs.length, quotation_count: quotations.length };
  });

  res.json({ data: recordsWithConfig, total, page: parseInt(page), limit: parseInt(limit) });
});

// 询价单详情
router.get('/:id', requirePerm('inquiry:view'), (req, res) => {
  const table = getTable('inquiries');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '询价单不存在' });

  // 关联配置表
  const configTable = getTable('product_configs');
  const configs = configTable.all().filter(c => c.inquiry_id === Number(req.params.id));
  const latestConfig = configs.length > 0 ? configs[configs.length - 1] : null;

  // 关联报价单
  const quotationTable = getTable('quotations');
  const quotations = quotationTable.all().filter(q => q.inquiry_id === Number(req.params.id));

  res.json({ ...row, config: latestConfig, quotations });
});

// ===== 询价单模板Excel导入 - 必须在 /:id 之前 =====
router.post('/import-template', requirePerm('inquiry:import'), (req, res) => {
  const { customer_name, customer_code, customer_source, country_region, sales_person, delivery_date,
          quote_validity, contact_person, contact_phone, contact_email,
          products } = req.body;

  if (!customer_name) return res.status(400).json({ error: '客户名称为必填项' });
  if (!products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: '至少需要一个产品' });
  }

  const table = getTable('inquiries');
  const baseSerial = genSerial();
  const custTable = getTable('customers');
  const prodTable = getTable('products');
  const pricingTable = getTable('bom_pricing');
  const quoteTable = getTable('quote_library');
  const configTable = getTable('product_configs');
  const quotationTable = getTable('quotations');
  const statusTable = getTable('inquiry_status_changes');
  let created = 0;
  const createdIds = [];
  let autoQuotedCount = 0;
  let pendingPricingCount = 0;

  products.forEach((prod, idx) => {
    const serialNumber = idx === 0 ? baseSerial : baseSerial + '-' + String(idx + 1).padStart(2, '0');

    if (prod.external_model) {
      const existingProduct = prodTable.all().find(p => p.external_model === prod.external_model);
      if (existingProduct) {
        const eq = (a, b) => (a || '').trim() === (b || '').trim();
        const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
          'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
          'switch_type', 'usb', 'waterproof', 'sensor'];
        const diffFields = paramFields.filter(f => !eq(existingProduct[f], prod[f]) && ((prod[f] || '').trim() || (existingProduct[f] || '').trim()));
        if (diffFields.length > 0) {
          const allWithBaseModel = prodTable.all().filter(p => p.external_model.startsWith(prod.external_model + '-'));
          const maxSeq = allWithBaseModel.reduce((max, p) => {
            const match = p.external_model.match(new RegExp(`^${prod.external_model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`));
            if (match) return Math.max(max, parseInt(match[1]));
            return max;
          }, 0);
          const newVariantModel = `${prod.external_model}-${String(maxSeq + 1).padStart(2, '0')}`;
          prodTable.insert({
            external_model: newVariantModel,
            internal_model: prod.internal_model || existingProduct.internal_model || '',
            category: prod.product_category || existingProduct.category || '',
            power: prod.power || existingProduct.power || '',
            product_name: prod.product_name || existingProduct.product_name || '',
            configuration: prod.configuration || existingProduct.configuration || '',
            specs: '',
            input_voltage: prod.input_voltage || '', battery: prod.battery || '',
            color_temp: prod.color_temp || '', luminous_flux: prod.luminous_flux || '',
            light_source: prod.light_source || '', main_body: prod.main_body || '',
            press_frame: existingProduct.press_frame || '', lampshade: prod.lampshade || '',
            reflector: prod.reflector || '', cable: prod.cable || '',
            switch_type: prod.switch_type || '', usb: prod.usb || '',
            waterproof: prod.waterproof || '', sensor: prod.sensor || '',
            base_model: prod.external_model,
            variant_of: existingProduct.id,
            variant_reason: diffFields.join(','),
            created_at: now(), updated_at: now()
          });
          logOperation('创建变体', sales_person || 'system', `批量创建: 型号 ${prod.external_model} 参数不同(${diffFields.join(',')})，创建变体 ${newVariantModel}`);
          prod.external_model = newVariantModel;
        }
      }
    }

    let hasQuotePrice = false;
    let quoteSource = null;
    let configSource = null;

    if (prod.external_model) {
      const quoteRecords = quoteTable.all().filter(q =>
        q.external_model === prod.external_model || q.internal_model === prod.external_model
      ).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      if (quoteRecords.length > 0 && quoteRecords[0].price_rmb) {
        hasQuotePrice = true;
        quoteSource = quoteRecords[0];
      }
      if (!hasQuotePrice) {
        const cfgs = configTable.all().filter(c => c.model === prod.external_model);
        if (cfgs.length > 0) {
          const latestCfg = cfgs[cfgs.length - 1];
          let pd = null;
          try { pd = JSON.parse(latestCfg.pricing_data); } catch(e) {}
          if (pd && pd.price_rmb) {
            hasQuotePrice = true;
            configSource = latestCfg;
          }
        }
      }
    }

    const initialStatus = hasQuotePrice ? 'quoted' : 'pending_pricing';
    let initialFinalPrice = 0, initialBaseCost = 0, initialMaterialCost = 0, initialProcessCost = 0, initialEstimatedLoss = 0;
    if (hasQuotePrice && quoteSource) {
      initialFinalPrice = quoteSource.price_rmb || 0;
      initialBaseCost = quoteSource.min_price || 0;
    } else if (hasQuotePrice && configSource) {
      let pd = null;
      try { pd = JSON.parse(configSource.pricing_data); } catch(e) {}
      if (pd) {
        initialFinalPrice = pd.price_rmb || 0;
        initialBaseCost = pd.min_price || 0;
        initialMaterialCost = pd.total_cost || 0;
        initialProcessCost = pd.process_cost || 0;
        initialEstimatedLoss = pd.estimated_loss || 0;
      }
    }

    const record = {
      serial_number: serialNumber,
      customer_name,
      customer_source: customer_source || '',
      country_region: country_region || '',
      sales_person: sales_person || '',
      customer_code: customer_code || '',
      contact_person: contact_person || '',
      contact_phone: contact_phone || '',
      contact_email: contact_email || '',
      inquiry_time: now(),
      delivery_date: delivery_date || '',
      external_model: prod.external_model || '',
      internal_model: prod.internal_model || '',
      product_category: prod.product_category || '',
      power: prod.power || '',
      configuration: '',
      quantity: prod.quantity || 0,
      custom_requirements: prod.custom_requirements || '',
      special_process: '',
      remarks: '',
      quote_validity: quote_validity || '',
      product_name: prod.product_name || '',
      input_voltage: prod.input_voltage || '',
      battery: prod.battery || '',
      color_temp: prod.color_temp || '',
      luminous_flux: prod.luminous_flux || '',
      light_source: prod.light_source || '',
      main_body: prod.main_body || '',
      lampshade: prod.lampshade || '',
      reflector: prod.reflector || '',
      cable: prod.cable || '',
      switch_type: prod.switch_type || '',
      usb: prod.usb || '',
      waterproof: prod.waterproof || '',
      sensor: prod.sensor || '',
      product_image: prod.product_image || '',
      target_price: prod.target_price || 0,
      quote_time_needed: prod.quote_time_needed || '',
      certificate_compliant: prod.certificate_compliant || '',
      certificate_level: prod.certificate_level || '',
      status: initialStatus,
      material_cost: initialMaterialCost, process_cost: initialProcessCost, accessory_cost: 0,
      estimated_loss: initialEstimatedLoss, base_cost: initialBaseCost, profit_rate: 0, discount_rate: 0,
      final_price: initialFinalPrice, quoted_at: hasQuotePrice ? now() : null, follow_up_records: '', lost_reason: '',
      created_at: now(), updated_at: now()
    };
    const result = table.insert(record);
    createdIds.push(result.lastID);
    created++;

    statusTable.insert({ inquiry_id: result.lastID, status: initialStatus, changed_by: sales_person || 'system', changed_at: now(), reason: hasQuotePrice ? '报价库有价格，自动完成报价' : '报价库无价格，提交核价' });
    logOperation('创建询价', sales_person || 'system', `模板导入询价单 ${serialNumber} [${initialStatus}]`, result.lastID);

    if (hasQuotePrice) {
      autoQuotedCount++;
      if (!configSource) {
        configTable.insert({
          inquiry_id: result.lastID, product_id: null, model: prod.external_model,
          certificate_compliant: prod.certificate_compliant || '', certificate_level: prod.certificate_level || '',
          fixed_params: JSON.stringify({ product_name: prod.product_name || quoteSource.product_name || '', external_model: prod.external_model, internal_model: prod.internal_model || '', category: prod.product_category || quoteSource.category || '', power: prod.power || quoteSource.power || '' }),
          adjustable_params: JSON.stringify({ input_voltage: prod.input_voltage || '', battery: prod.battery || '', color_temp: prod.color_temp || '', luminous_flux: prod.luminous_flux || '', light_source: prod.light_source || '', main_body: prod.main_body || '', lampshade: prod.lampshade || '', reflector: prod.reflector || '', cable: prod.cable || '', switch_type: prod.switch_type || '', waterproof: prod.waterproof || '', configuration: quoteSource ? quoteSource.configuration || quoteSource.specs || '' : '' }),
          bom_details: '[]',
          pricing_data: JSON.stringify({ pricing_id: null, bom_costs: {}, total_cost: initialMaterialCost, price_rmb: initialFinalPrice, price_usd: quoteSource ? quoteSource.price_usd : null, min_price: initialBaseCost, pricing_version: 'V1.0', effective_date: now().substring(0, 10) }),
          status: 'auto_generated', created_at: now(), updated_at: now()
        });
      }
      quotationTable.insert({
        quote_no: genQuoteNo(), inquiry_id: result.lastID, inquiry_no: serialNumber,
        customer_name, customer_source: customer_source || '', country_region: country_region || '', sales_person: sales_person || '',
        external_model: prod.external_model, internal_model: prod.internal_model || '',
        product_name: prod.product_name || quoteSource.product_name || '',
        product_category: prod.product_category || quoteSource.category || '',
        power: prod.power || quoteSource.power || '', quantity: prod.quantity || 0,
        final_price: initialFinalPrice, unit_price: (prod.quantity || 0) > 0 ? Math.round(initialFinalPrice / prod.quantity * 100) / 100 : 0,
        config_data: configSource ? configSource.adjustable_params : '{}',
        bom_data: configSource ? configSource.bom_details : '[]',
        pricing_data: configSource ? configSource.pricing_data : null,
        custom_requirements: prod.custom_requirements || '', special_process: '', delivery_date: delivery_date || '',
        quote_validity: quote_validity || '30天', remarks: '',
        status: 'confirmed', created_by: sales_person || 'system', created_at: now(), updated_at: now()
      });
    } else {
      pendingPricingCount++;
      const externalModel = prod.external_model;
      if (externalModel) {
        let product = prodTable.all().find(p => p.external_model === externalModel || p.internal_model === externalModel);
        if (!product) {
          const baseModel = externalModel.split('-')[0];
          product = prodTable.all().find(p => p.external_model === baseModel || p.external_model.startsWith(baseModel + '-') || p.internal_model === baseModel || p.internal_model?.startsWith(baseModel + '-'));
        }
        const existingPricing = pricingTable.all().find(b => b.model === externalModel && b.inquiry_no === serialNumber);
        if (!existingPricing) {
          pricingTable.insert({
            customer: customer_name, inquiry_no: serialNumber, model: externalModel,
            product_name: prod.product_name || (product ? product.product_name : '') || '',
            power: prod.power || (product ? product.power : '') || '',
            product_series: product ? product.category || '' : '',
            certificate_compliant: prod.certificate_compliant || '', certificate_level: prod.certificate_level || '',
            kit: null, cable: null, light_source: null, driver: null,
            battery: null, bracket: null, switch_type: null, solar_panel: null,
            socket: null, box: null, manual: null, packaging: null,
            accessories: null, labor: null,
            total_cost: null, labor_cost: null, process_cost: null,
            estimated_loss: null, min_price: null,
            pricer: '', pricing_link: '', price_rmb: null, price_usd: null,
            target_price: prod.target_price || null, pricing_version: 'V1.0',
            effective_date: now().substring(0, 10), remarks: '',
            input_voltage: prod.input_voltage || '', color_temp: prod.color_temp || '',
            luminous_flux: prod.luminous_flux || '', main_body: prod.main_body || '',
            lampshade: prod.lampshade || '', reflector: prod.reflector || '',
            usb: prod.usb || '', waterproof: prod.waterproof || '',
            sensor: prod.sensor || '', configuration: prod.configuration || '',
            special_process: prod.special_process || '',
            custom_requirements: prod.custom_requirements || '',
            quantity: prod.quantity || null, delivery_date: prod.delivery_date || '',
            created_at: now(), updated_at: now()
          });
        }
      }
    }

    const exists = custTable.all().find(c => c.name === customer_name);
    if (exists && exists.customer_code) {
      table.update(result.lastID, { customer_code: exists.customer_code });
    }
  });

  const exists = custTable.all().find(c => c.name === customer_name);
  if (!exists) {
    custTable.insert({
      name: customer_name, source: customer_source || '线上', customer_source: customer_source || '线上', country_region: country_region || '',
      contact: contact_person || '',
      phone: contact_phone || '',
      email: contact_email || '',
      created_at: now(), updated_at: now()
    });
  } else {
    const custUpdates = { updated_at: now() };
    const existingSource = exists.customer_source || exists.source || '';
    if (customer_source && (!existingSource || existingSource === '询价同步' || existingSource === '线上')) {
      custUpdates.source = customer_source;
      custUpdates.customer_source = customer_source;
    }
    if (country_region && !exists.country_region) {
      custUpdates.country_region = country_region;
    }
    if (contact_person && !exists.contact && !exists.contact_person) custUpdates.contact = contact_person;
    if (contact_phone && !exists.phone) custUpdates.phone = contact_phone;
    if (contact_email && !exists.email) custUpdates.email = contact_email;
    custTable.update(exists.id, custUpdates);
  }

  logOperation('模板导入询价', sales_person || 'system', `询价单 ${baseSerial} 共 ${created} 个产品 (自动报价:${autoQuotedCount}, 待核价:${pendingPricingCount})`, null);
  res.json({ message: `模板导入成功: ${autoQuotedCount}个产品自动报价, ${pendingPricingCount}个产品待核价`, created, serial_number: baseSerial, ids: createdIds, auto_quoted: autoQuotedCount, pending_pricing: pendingPricingCount });
});

// ===== 批量创建询价单（一个询价单多款产品）- 必须在 /:id 之前 =====
router.post('/batch-create', requirePerm('inquiry:create'), (req, res) => {
  const { customer_name, customer_code, customer_source, country_region, sales_person, delivery_date,
          quote_validity, remarks, products } = req.body;

  if (!customer_name) return res.status(400).json({ error: '客户名称为必填项' });
  if (!products || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: '至少需要一个产品' });
  }

  for (let i = 0; i < products.length; i++) {
    if (!products[i].external_model) return res.status(400).json({ error: `产品 #${i+1} 的型号为必填项` });
    if (!products[i].quantity || products[i].quantity <= 0) return res.status(400).json({ error: `产品 #${i+1} 的询价数量为必填项` });
  }

  const table = getTable('inquiries');
  const baseSerial = genSerial();
  const custTable = getTable('customers');
  const prodTable = getTable('products');
  const pricingTable = getTable('bom_pricing');
  const quoteTable = getTable('quote_library');
  const configTable = getTable('product_configs');
  const quotationTable = getTable('quotations');
  const statusTable = getTable('inquiry_status_changes');
  let created = 0;
  const createdIds = [];
  let autoQuotedCount = 0;
  let pendingPricingCount = 0;

  products.forEach((prod, idx) => {
    const serialNumber = idx === 0 ? baseSerial : baseSerial + '-' + String(idx + 1).padStart(2, '0');

    let hasQuotePrice = false;
    let quoteSource = null;
    let configSource = null;

    if (prod.external_model) {
      const quoteRecords = quoteTable.all().filter(q =>
        q.external_model === prod.external_model || q.internal_model === prod.external_model
      ).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      if (quoteRecords.length > 0 && quoteRecords[0].price_rmb) {
        hasQuotePrice = true;
        quoteSource = quoteRecords[0];
      }
      if (!hasQuotePrice) {
        const cfgs = configTable.all().filter(c => c.model === prod.external_model);
        if (cfgs.length > 0) {
          const latestCfg = cfgs[cfgs.length - 1];
          let pd = null;
          try { pd = JSON.parse(latestCfg.pricing_data); } catch(e) {}
          if (pd && pd.price_rmb) {
            hasQuotePrice = true;
            configSource = latestCfg;
          }
        }
      }
    }

    const initialStatus = hasQuotePrice ? 'quoted' : 'pending_pricing';
    let initialFinalPrice = 0, initialBaseCost = 0, initialMaterialCost = 0, initialProcessCost = 0, initialEstimatedLoss = 0;
    if (hasQuotePrice && quoteSource) {
      initialFinalPrice = quoteSource.price_rmb || 0;
      initialBaseCost = quoteSource.min_price || 0;
    } else if (hasQuotePrice && configSource) {
      let pd = null;
      try { pd = JSON.parse(configSource.pricing_data); } catch(e) {}
      if (pd) {
        initialFinalPrice = pd.price_rmb || 0;
        initialBaseCost = pd.min_price || 0;
        initialMaterialCost = pd.total_cost || 0;
        initialProcessCost = pd.process_cost || 0;
        initialEstimatedLoss = pd.estimated_loss || 0;
      }
    }

    const record = {
      serial_number: serialNumber,
      customer_name,
      customer_source: customer_source || '',
      country_region: country_region || '',
      sales_person: sales_person || '',
      customer_code: customer_code || '',
      contact_person: req.body.contact_person || '',
      contact_phone: req.body.contact_phone || '',
      contact_email: req.body.contact_email || '',
      inquiry_time: now(),
      delivery_date: delivery_date || '',
      external_model: prod.external_model || '',
      internal_model: prod.internal_model || '',
      product_category: prod.product_category || '',
      power: prod.power || '',
      configuration: prod.configuration || '',
      quantity: prod.quantity || 0,
      custom_requirements: prod.custom_requirements || '',
      special_process: '',
      remarks: remarks || '',
      quote_validity: quote_validity || '',
      product_name: prod.product_name || '',
      input_voltage: prod.input_voltage || '',
      battery: prod.battery || '',
      color_temp: prod.color_temp || '',
      luminous_flux: prod.luminous_flux || '',
      light_source: prod.light_source || '',
      main_body: prod.main_body || '',
      lampshade: prod.lampshade || '',
      reflector: prod.reflector || '',
      cable: prod.cable || '',
      switch_type: prod.switch_type || '',
      usb: prod.usb || '',
      waterproof: prod.waterproof || '',
      sensor: prod.sensor || '',
      product_image: prod.product_image || '',
      target_price: prod.target_price || 0,
      quote_time_needed: prod.quote_time_needed || '',
      certificate_compliant: prod.certificate_compliant || '',
      certificate_level: prod.certificate_level || '',
      status: initialStatus,
      material_cost: initialMaterialCost, process_cost: initialProcessCost, accessory_cost: 0,
      estimated_loss: initialEstimatedLoss, base_cost: initialBaseCost, profit_rate: 0, discount_rate: 0,
      final_price: initialFinalPrice, quoted_at: hasQuotePrice ? now() : null, follow_up_records: '', lost_reason: '',
      created_at: now(), updated_at: now()
    };
    const result = table.insert(record);
    createdIds.push(result.lastID);
    created++;

    statusTable.insert({ inquiry_id: result.lastID, status: initialStatus, changed_by: sales_person || 'system', changed_at: now(), reason: hasQuotePrice ? '报价库有价格，自动完成报价' : '报价库无价格，提交核价' });
    logOperation('创建询价', sales_person || 'system', `批量创建询价单 ${serialNumber} [${initialStatus}]`, result.lastID);

    if (hasQuotePrice) {
      autoQuotedCount++;
      if (!configSource) {
        const newConfig = {
          inquiry_id: result.lastID, product_id: null, model: prod.external_model,
          certificate_compliant: prod.certificate_compliant || '', certificate_level: prod.certificate_level || '',
          fixed_params: JSON.stringify({ product_name: prod.product_name || quoteSource.product_name || '', external_model: prod.external_model, internal_model: prod.internal_model || '', category: prod.product_category || quoteSource.category || '', power: prod.power || quoteSource.power || '' }),
          adjustable_params: JSON.stringify({ input_voltage: prod.input_voltage || '', battery: prod.battery || '', color_temp: prod.color_temp || '', luminous_flux: prod.luminous_flux || '', light_source: prod.light_source || '', main_body: prod.main_body || '', lampshade: prod.lampshade || '', reflector: prod.reflector || '', cable: prod.cable || '', switch_type: prod.switch_type || '', waterproof: prod.waterproof || '', configuration: quoteSource ? quoteSource.configuration || quoteSource.specs || '' : '' }),
          bom_details: '[]',
          pricing_data: JSON.stringify({ pricing_id: null, bom_costs: {}, total_cost: initialMaterialCost, price_rmb: initialFinalPrice, price_usd: quoteSource ? quoteSource.price_usd : null, min_price: initialBaseCost, pricing_version: 'V1.0', effective_date: now().substring(0, 10) }),
          status: 'auto_generated', created_at: now(), updated_at: now()
        };
        configTable.insert(newConfig);
      }
      quotationTable.insert({
        quote_no: genQuoteNo(), inquiry_id: result.lastID, inquiry_no: serialNumber,
        customer_name, customer_source: customer_source || '', country_region: country_region || '', sales_person: sales_person || '',
        external_model: prod.external_model, internal_model: prod.internal_model || '',
        product_name: prod.product_name || quoteSource.product_name || '',
        product_category: prod.product_category || quoteSource.category || '',
        power: prod.power || quoteSource.power || '', quantity: prod.quantity || 0,
        final_price: initialFinalPrice, unit_price: (prod.quantity || 0) > 0 ? Math.round(initialFinalPrice / prod.quantity * 100) / 100 : 0,
        config_data: configSource ? configSource.adjustable_params : '{}',
        bom_data: configSource ? configSource.bom_details : '[]',
        pricing_data: configSource ? configSource.pricing_data : null,
        custom_requirements: prod.custom_requirements || '', special_process: '', delivery_date: delivery_date || '',
        quote_validity: quote_validity || '30天', remarks: remarks || '',
        status: 'confirmed', created_by: sales_person || 'system', created_at: now(), updated_at: now()
      });
    } else {
      pendingPricingCount++;
      const externalModel = prod.external_model;
      if (externalModel) {
        let product = prodTable.all().find(p => p.external_model === externalModel || p.internal_model === externalModel);
        if (!product) {
          const baseModel = externalModel.split('-')[0];
          product = prodTable.all().find(p => p.external_model === baseModel || p.external_model.startsWith(baseModel + '-') || p.internal_model === baseModel || p.internal_model?.startsWith(baseModel + '-'));
        }
        const existingPricing = pricingTable.all().find(b => b.model === externalModel && b.inquiry_no === serialNumber);
        if (!existingPricing) {
          pricingTable.insert({
            customer: customer_name, inquiry_no: serialNumber, model: externalModel,
            product_name: prod.product_name || (product ? product.product_name : '') || '',
            power: prod.power || (product ? product.power : '') || '',
            product_series: product ? product.category || '' : '',
            certificate_compliant: prod.certificate_compliant || '', certificate_level: prod.certificate_level || '',
            kit: null, cable: null, light_source: null, driver: null,
            battery: null, bracket: null, switch_type: null, solar_panel: null,
            socket: null, box: null, manual: null, packaging: null,
            accessories: null, labor: null,
            total_cost: null, labor_cost: null, process_cost: null,
            estimated_loss: null, min_price: null,
            pricer: '', pricing_link: '', price_rmb: null, price_usd: null,
            target_price: prod.target_price || null, pricing_version: 'V1.0',
            effective_date: now().substring(0, 10), remarks: '',
            created_at: now(), updated_at: now()
          });
        }
      }
    }

    const exists = custTable.all().find(c => c.name === customer_name);
    if (exists && exists.customer_code) {
      table.update(result.lastID, { customer_code: exists.customer_code });
    }
  });

  const exists = custTable.all().find(c => c.name === customer_name);
  if (!exists) {
    custTable.insert({
      name: customer_name, source: customer_source || '线上', customer_source: customer_source || '线上', country_region: country_region || '',
      contact: req.body.contact_person || '',
      phone: req.body.contact_phone || '',
      email: req.body.contact_email || '',
      created_at: now(), updated_at: now()
    });
  } else {
    const custUpdates = { updated_at: now() };
    const existingSource = exists.customer_source || exists.source || '';
    if (customer_source && (!existingSource || existingSource === '询价同步' || existingSource === '线上')) {
      custUpdates.source = customer_source;
      custUpdates.customer_source = customer_source;
    }
    if (country_region && !exists.country_region) {
      custUpdates.country_region = country_region;
    }
    if (req.body.contact_person && !exists.contact && !exists.contact_person) custUpdates.contact = req.body.contact_person;
    if (req.body.contact_phone && !exists.phone) custUpdates.phone = req.body.contact_phone;
    if (req.body.contact_email && !exists.email) custUpdates.email = req.body.contact_email;
    custTable.update(exists.id, custUpdates);
  }

  logOperation('批量创建询价', sales_person || 'system', `询价单 ${baseSerial} 共 ${created} 个产品 (自动报价:${autoQuotedCount}, 待核价:${pendingPricingCount})`, null);
  res.json({ message: `批量创建成功: ${autoQuotedCount}个产品自动报价, ${pendingPricingCount}个产品待核价`, created, serial_number: baseSerial, ids: createdIds, auto_quoted: autoQuotedCount, pending_pricing: pendingPricingCount });
});

// 创建询价单
router.post('/', requirePerm('inquiry:create'), (req, res) => {
  const { customer_name, customer_code, customer_source, country_region, sales_person, delivery_date,
          internal_model, product_category, power, configuration, quantity,
          custom_requirements, special_process, remarks, quote_validity,
          product_name, input_voltage, battery, color_temp, luminous_flux,
          light_source, main_body, lampshade, reflector, cable, switch_type,
          usb, waterproof, sensor, target_price, quote_time_needed,
          certificate_compliant, certificate_level,
          contact_person, contact_phone, contact_email,
          product_image } = req.body;
  let external_model = req.body.external_model;

  // 关键字段非空校验
  const errors = [];
  if (!customer_name) errors.push('客户名称');
  if (!external_model) errors.push('产品型号');
  if (!quantity) errors.push('询价数量');
  if (errors.length > 0) {
    return res.status(400).json({ error: `以下字段为必填项：${errors.join('、')}` });
  }

  const table = getTable('inquiries');
  const quoteTable = getTable('quote_library');
  const configTable = getTable('product_configs');
  const bomTable = getTable('bom_pricing');
  const quotationTable = getTable('quotations');
  const prodTable = getTable('products');
  const rulesTable = getTable('workflow_rules');
  rulesTable._invalidate();

  let isVariant = false;
  let variantBaseModel = '';
  if (external_model) {
    const existingProduct = prodTable.all().find(p => p.external_model === external_model);
    if (existingProduct) {
      const eq = (a, b) => (a || '').trim() === (b || '').trim();
      const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
        'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
        'switch_type', 'usb', 'waterproof', 'sensor'];
      const diffFields = paramFields.filter(f => !eq(existingProduct[f], req.body[f]) && ((req.body[f] || '').trim() || (existingProduct[f] || '').trim()));
      if (diffFields.length > 0) {
        isVariant = true;
        variantBaseModel = external_model;
        const allWithBaseModel = prodTable.all().filter(p => p.external_model.startsWith(external_model + '-'));
        const maxSeq = allWithBaseModel.reduce((max, p) => {
          const match = p.external_model.match(new RegExp(`^${external_model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`));
          if (match) return Math.max(max, parseInt(match[1]));
          return max;
        }, 0);
        external_model = `${external_model}-${String(maxSeq + 1).padStart(2, '0')}`;
        logOperation('变体检测', sales_person || 'system', `型号 ${variantBaseModel} 参数不同(${diffFields.join(',')})，生成变体 ${external_model}`);
      }
    }
  }

  let hasQuotePrice = false;
  let quoteSource = null;
  let configSource = null;
  let matchedQuoteByConfig = null;

  if (external_model) {
    const certLevel = req.body.certificate_level || '';
    const configVal = req.body.configuration || '';
    const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
      'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
      'switch_type', 'usb', 'waterproof', 'sensor'];
    const eq = (a, b) => (a || '').trim() === (b || '').trim();

    const quoteRecords = quoteTable.all().filter(q =>
      q.external_model === external_model || q.internal_model === external_model
    ).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

    let bestMatch = null;
    let bestMatchScore = -1;
    quoteRecords.forEach(q => {
      if (!q.price_rmb) return;
      let score = 0;
      if (certLevel && eq(q.certificate_level, certLevel)) score += 10;
      if (configVal && eq(q.configuration, configVal)) score += 5;
      if (score > bestMatchScore) {
        bestMatchScore = score;
        bestMatch = q;
      }
    });

    if (bestMatch) {
      hasQuotePrice = true;
      quoteSource = bestMatch;
      matchedQuoteByConfig = bestMatch;
    } else if (quoteRecords.length > 0 && quoteRecords[0].price_rmb) {
      hasQuotePrice = true;
      quoteSource = quoteRecords[0];
    }

    if (!hasQuotePrice) {
      const configs = configTable.all().filter(c => c.model === external_model);
      if (configs.length > 0) {
        const latestConfig = configs[configs.length - 1];
        let pricingData = null;
        try { pricingData = JSON.parse(latestConfig.pricing_data); } catch(e) {}
        if (pricingData && pricingData.price_rmb) {
          hasQuotePrice = true;
          configSource = latestConfig;
        }
      }
    }
  }

  const ruleContext = {
    has_quote_price: hasQuotePrice,
    has_config_pricing: !!configSource,
    customer_not_exists: false,
    product_exists: false,
    status_changed: true
  };
  if (customer_name) {
    const custTable = getTable('customers');
    ruleContext.customer_not_exists = !custTable.all().find(c => c.name === customer_name);
  }
  if (external_model) {
    ruleContext.product_exists = !!prodTable.all().find(p => p.external_model === external_model || p.internal_model === external_model);
  }

  let activeRules = rulesTable.all().filter(r => r.enabled && r.category === 'inquiry');
  activeRules.sort((a, b) => {
    if (a.type === 'core' && b.type !== 'core') return -1;
    if (a.type !== 'core' && b.type === 'core') return 1;
    return (b.priority || 0) - (a.priority || 0);
  });
  const appliedRules = [];
  activeRules.forEach(rule => {
    let matched = false;
    const cond = rule.condition || '';
    if (!cond) return;
    if (cond.includes('quote_library.has_price == true')) matched = ruleContext.has_quote_price === true;
    else if (cond.includes('quote_library.has_price == false')) matched = ruleContext.has_quote_price === false;
    else if (cond.includes('product_config.has_pricing == true')) matched = ruleContext.has_config_pricing === true;
    else if (cond.includes('customer.not_exists == true')) matched = ruleContext.customer_not_exists === true;
    else if (cond.includes('product.exists == true')) matched = ruleContext.product_exists === true;
    else if (cond.includes('status.changed == true')) matched = ruleContext.status_changed === true;
    else if (cond.includes('AND')) {
      const parts = cond.split('AND').map(p => p.trim());
      matched = parts.every(part => {
        if (part.includes('quote_library.has_price == true')) return ruleContext.has_quote_price === true;
        if (part.includes('product_config.has_pricing == true')) return ruleContext.has_config_pricing === true;
        return true;
      });
    }
    if (matched) appliedRules.push({ code: rule.code, name: rule.name, type: rule.type, priority: rule.priority, action: rule.action });
  });
  const coreApplied = appliedRules.filter(r => r.type === 'core');
  const finalAction = coreApplied.length > 0 ? coreApplied[0].action : (appliedRules.length > 0 ? appliedRules[0].action : null);

  let initialStatus, statusReason;
  if (finalAction === 'auto_quote' || finalAction === 'prefer_quote_library' || finalAction === 'extract_config_price') {
    initialStatus = 'quoted';
    statusReason = coreApplied.length > 0
      ? `核心准则[${coreApplied[0].code}]: ${coreApplied[0].name}`
      : `基本规则[${appliedRules[0].code}]: ${appliedRules[0].name}`;
  } else if (finalAction === 'submit_pricing') {
    initialStatus = 'pending_pricing';
    statusReason = coreApplied.length > 0
      ? `核心准则[${coreApplied[0].code}]: ${coreApplied[0].name}`
      : '报价库无价格，提交核价';
  } else {
    initialStatus = hasQuotePrice ? 'quoted' : 'pending_pricing';
    statusReason = hasQuotePrice ? '报价库有价格，自动完成报价' : '报价库无价格，提交核价';
  }
  let initialFinalPrice = 0;
  let initialBaseCost = 0;
  let initialMaterialCost = 0;
  let initialProcessCost = 0;
  let initialEstimatedLoss = 0;

  if (hasQuotePrice && quoteSource) {
    initialFinalPrice = quoteSource.price_rmb || 0;
    initialBaseCost = quoteSource.min_price || 0;
    if (matchedQuoteByConfig) {
      const qs = matchedQuoteByConfig;
      if (qs.product_name && !product_name) req.body.product_name = qs.product_name;
      if (qs.category && !product_category) req.body.product_category = qs.category;
      if (qs.power && !power) req.body.power = qs.power;
      if (qs.configuration && !configuration) req.body.configuration = qs.configuration;
    }
  } else if (hasQuotePrice && configSource) {
    let pd = null;
    try { pd = JSON.parse(configSource.pricing_data); } catch(e) {}
    if (pd) {
      initialFinalPrice = pd.price_rmb || 0;
      initialBaseCost = pd.min_price || 0;
      initialMaterialCost = pd.total_cost || 0;
      initialProcessCost = pd.process_cost || 0;
      initialEstimatedLoss = pd.estimated_loss || 0;
    }
  }

  let serialNumber;
  const parentSerial = req.body.parent_serial || '';
  if (parentSerial) {
    const baseNo = parentSerial.replace(/-\d{2,}$/, '');
    const siblings = table.all().filter(r => {
      const sn = r.serial_number || '';
      return sn === baseNo || sn.startsWith(baseNo + '-');
    });
    let maxSub = 0;
    siblings.forEach(s => {
      const m = (s.serial_number || '').match(/-(\d{2,})$/);
      if (m) maxSub = Math.max(maxSub, parseInt(m[1]));
    });
    const nextSeq = maxSub > 0 ? maxSub + 1 : (siblings.length > 1 ? siblings.length + 1 : 2);
    serialNumber = `${baseNo}-${String(nextSeq).padStart(2, '0')}`;
  } else {
    serialNumber = genSerial();
  }

  const record = {
    serial_number: serialNumber,
    customer_name, customer_source, country_region, sales_person,
    customer_code: customer_code || '', contact_person: contact_person || '', contact_phone: contact_phone || '', contact_email: contact_email || '',
    inquiry_time: now(),
    delivery_date, external_model, internal_model, product_category,
    power, configuration, quantity,
    custom_requirements, special_process, remarks, quote_validity,
    product_name: product_name || (quoteSource ? quoteSource.product_name : '') || '',
    input_voltage: input_voltage || '', battery: battery || '',
    color_temp: color_temp || '', luminous_flux: luminous_flux || '',
    light_source: light_source || '', main_body: main_body || '',
    lampshade: lampshade || '', reflector: reflector || '',
    cable: cable || '', switch_type: switch_type || '',
    usb: usb || '', waterproof: waterproof || '', sensor: sensor || '',
    product_image: product_image || '',
    target_price: target_price || 0, quote_time_needed: quote_time_needed || '',
    certificate_compliant: certificate_compliant || '',
    certificate_level: certificate_level || '',
    status: initialStatus,
    material_cost: initialMaterialCost, process_cost: initialProcessCost, accessory_cost: 0,
    estimated_loss: initialEstimatedLoss, base_cost: initialBaseCost, profit_rate: 0, discount_rate: 0,
    final_price: initialFinalPrice, quoted_at: hasQuotePrice ? now() : null, follow_up_records: '', lost_reason: '',
    created_at: now(), updated_at: now()
  };

  if (hasQuotePrice && external_model) {
    const prodInfo = prodTable.all().find(p => p.external_model === external_model || p.internal_model === external_model);
    if (prodInfo) {
      const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
        'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
        'switch_type', 'usb', 'waterproof', 'sensor'];
      paramFields.forEach(f => {
        if (!record[f] && prodInfo[f]) record[f] = prodInfo[f];
      });
      if (!record.product_name && prodInfo.product_name) record.product_name = prodInfo.product_name;
      if (!record.power && prodInfo.power) record.power = prodInfo.power;
      if (!record.internal_model && prodInfo.internal_model) record.internal_model = prodInfo.internal_model;
      if (!record.product_category && prodInfo.category) record.product_category = prodInfo.category;
    }
  }
  const result = table.insert(record);

  // 自动创建或更新产品
  if (external_model) {
    if (isVariant) {
      const baseProduct = prodTable.all().find(p => p.external_model === variantBaseModel);
      prodTable.insert({
        external_model,
        internal_model: internal_model || (baseProduct ? baseProduct.internal_model : '') || '',
        category: product_category || (baseProduct ? baseProduct.category : '') || '',
        power: power || (baseProduct ? baseProduct.power : '') || '',
        product_name: product_name || (baseProduct ? baseProduct.product_name : '') || '',
        configuration: configuration || (baseProduct ? baseProduct.configuration : '') || '',
        specs: '',
        input_voltage: input_voltage || '', battery: battery || '',
        color_temp: color_temp || '', luminous_flux: luminous_flux || '',
        light_source: light_source || '', main_body: main_body || '',
        press_frame: baseProduct ? baseProduct.press_frame || '' : '', lampshade: lampshade || '',
        reflector: reflector || '', cable: cable || '',
        switch_type: switch_type || '', usb: usb || '',
        waterproof: waterproof || '', sensor: sensor || '',
        base_model: variantBaseModel,
        variant_of: baseProduct ? baseProduct.id : null,
        created_at: now(), updated_at: now()
      });
      logOperation('创建变体', sales_person || 'system', `型号 ${variantBaseModel} → 变体 ${external_model}`, result.lastID);
    } else {
      const existingProduct = prodTable.all().find(p => p.external_model === external_model);
      if (existingProduct) {
        const updates = { updated_at: now() };
        const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
          'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
          'switch_type', 'usb', 'waterproof', 'sensor'];
        paramFields.forEach(f => {
          if (req.body[f] && !existingProduct[f]) updates[f] = req.body[f];
        });
        if (product_name && !existingProduct.product_name) updates.product_name = product_name;
        if (internal_model && !existingProduct.internal_model) updates.internal_model = internal_model;
        if (power && !existingProduct.power) updates.power = power;
        prodTable.update(existingProduct.id, updates);
      } else {
        prodTable.insert({
          external_model, internal_model: internal_model || '',
          category: product_category || '', power: power || '',
          product_name: product_name || '', configuration: configuration || '', specs: '',
          input_voltage: input_voltage || '', battery: battery || '',
          color_temp: color_temp || '', luminous_flux: luminous_flux || '',
          light_source: light_source || '', main_body: main_body || '',
          press_frame: '', lampshade: lampshade || '',
          reflector: reflector || '', cable: cable || '',
          switch_type: switch_type || '', usb: usb || '',
          waterproof: waterproof || '', sensor: sensor || '',
          created_at: now(), updated_at: now()
        });
      }
    }
  }

  const statusTable = getTable('inquiry_status_changes');
  statusTable.insert({ inquiry_id: result.lastID, status: initialStatus, changed_by: sales_person || 'system', changed_at: now(), reason: statusReason });
  logOperation('创建询价', sales_person || 'system', `新建询价单 ${record.serial_number} [${initialStatus}] 规则:${statusReason}`, result.lastID);

  if (hasQuotePrice) {
    let configId = null;
    if (configSource) {
      configId = configSource.id;
    } else {
      const newConfig = {
        inquiry_id: result.lastID,
        product_id: null,
        model: external_model,
        certificate_compliant: certificate_compliant || '',
        certificate_level: certificate_level || '',
        fixed_params: JSON.stringify({
          product_name: product_name || quoteSource.product_name || '',
          external_model: external_model,
          internal_model: internal_model || '',
          category: product_category || quoteSource.category || '',
          power: power || quoteSource.power || ''
        }),
        adjustable_params: JSON.stringify({
          input_voltage: input_voltage || '',
          battery: battery || '',
          color_temp: color_temp || '',
          luminous_flux: luminous_flux || '',
          light_source: light_source || '',
          main_body: main_body || '',
          lampshade: lampshade || '',
          reflector: reflector || '',
          cable: cable || '',
          switch_type: switch_type || '',
          waterproof: waterproof || '',
          configuration: quoteSource ? quoteSource.configuration || quoteSource.specs || '' : ''
        }),
        bom_details: '[]',
        pricing_data: JSON.stringify({
          pricing_id: null,
          bom_costs: {},
          total_cost: initialMaterialCost,
          price_rmb: initialFinalPrice,
          price_usd: quoteSource ? quoteSource.price_usd : null,
          min_price: initialBaseCost,
          pricing_version: 'V1.0',
          effective_date: now().substring(0, 10)
        }),
        status: 'auto_generated',
        created_at: now(), updated_at: now()
      };
      const cfgResult = configTable.insert(newConfig);
      configId = cfgResult.lastID;
    }

    const quotation = {
      quote_no: genQuoteNo(),
      inquiry_id: result.lastID,
      inquiry_no: record.serial_number,
      customer_name, customer_source: customer_source || '', country_region: country_region || '',
      sales_person: sales_person || '',
      external_model, internal_model: record.internal_model || '',
      product_name: record.product_name || quoteSource.product_name || '',
      product_category: record.product_category || quoteSource.category || '',
      power: record.power || quoteSource.power || '',
      quantity,
      final_price: initialFinalPrice,
      unit_price: quantity > 0 ? Math.round(initialFinalPrice / quantity * 100) / 100 : 0,
      config_data: configSource ? configSource.adjustable_params : JSON.stringify({
        input_voltage: record.input_voltage || '', battery: record.battery || '',
        color_temp: record.color_temp || '', luminous_flux: record.luminous_flux || '',
        light_source: record.light_source || '', main_body: record.main_body || '',
        lampshade: record.lampshade || '', reflector: record.reflector || '',
        cable: record.cable || '', switch_type: record.switch_type || '',
        usb: record.usb || '', waterproof: record.waterproof || '',
        sensor: record.sensor || '', configuration: record.configuration || quoteSource.configuration || ''
      }),
      bom_data: configSource ? configSource.bom_details : '[]',
      pricing_data: configSource ? configSource.pricing_data : JSON.stringify({
        pricing_id: null, bom_costs: {},
        total_cost: initialMaterialCost,
        price_rmb: initialFinalPrice,
        price_usd: quoteSource ? quoteSource.price_usd : null,
        min_price: initialBaseCost,
        pricing_version: 'V1.0',
        effective_date: now().substring(0, 10)
      }),
      custom_requirements: custom_requirements || '',
      special_process: special_process || '',
      delivery_date: delivery_date || '',
      quote_validity: quote_validity || '30天',
      remarks: remarks || '',
      certificate_compliant: certificate_compliant || '',
      certificate_level: certificate_level || '',
      status: 'confirmed',
      created_by: sales_person || 'system',
      created_at: now(), updated_at: now()
    };
    quotationTable.insert(quotation);
    logOperation('自动生成报价单', 'system', `询价单 ${record.serial_number} 报价库有价格，自动生成报价单`, result.lastID);
  } else {
    if (external_model) {
      const existingPricing = bomTable.all().find(b =>
        b.model === external_model && b.inquiry_no === record.serial_number
      );
      if (!existingPricing) {
        let product = prodTable.all().find(p => p.external_model === external_model || p.internal_model === external_model);
        if (!product) {
          const baseModel = external_model.split('-')[0];
          product = prodTable.all().find(p => p.external_model === baseModel || p.external_model.startsWith(baseModel + '-') || p.internal_model === baseModel || p.internal_model?.startsWith(baseModel + '-'));
        }
        let existingBom = bomTable.all().find(b => b.model === external_model && b.kit !== null);
        if (!existingBom) {
          const baseModel = external_model.split('-')[0];
          existingBom = bomTable.all().find(b => (b.model === baseModel || b.model.startsWith(baseModel + '-')) && b.kit !== null);
        }
        bomTable.insert({
          customer: customer_name || '',
          inquiry_no: record.serial_number,
          model: external_model,
          product_name: product_name || (product ? product.product_name : '') || '',
          power: power || '',
          product_series: product_category || (product ? product.category : '') || '',
          certificate_compliant: certificate_compliant || '',
          certificate_level: certificate_level || '',
          kit: existingBom ? existingBom.kit : null,
          cable: existingBom ? existingBom.cable : null,
          light_source: existingBom ? existingBom.light_source : null,
          driver: existingBom ? existingBom.driver : null,
          battery: existingBom ? existingBom.battery : null,
          bracket: existingBom ? existingBom.bracket : null,
          switch_type: existingBom ? existingBom.switch_type : null,
          solar_panel: existingBom ? existingBom.solar_panel : null,
          socket: existingBom ? existingBom.socket : null,
          box: existingBom ? existingBom.box : null,
          manual: existingBom ? existingBom.manual : null,
          packaging: existingBom ? existingBom.packaging : null,
          accessories: existingBom ? existingBom.accessories : null,
          labor: existingBom ? existingBom.labor : null,
          total_cost: existingBom ? existingBom.total_cost : (product ? (product.cost_price || 0) : 0),
          labor_cost: existingBom ? existingBom.labor_cost : 0,
          process_cost: existingBom ? existingBom.process_cost : 0,
          estimated_loss: existingBom ? existingBom.estimated_loss : 0,
          min_price: existingBom ? existingBom.min_price : null,
          pricer: existingBom ? existingBom.pricer : '',
          pricing_link: existingBom ? existingBom.pricing_link : '',
          price_rmb: existingBom ? existingBom.price_rmb : (product ? (product.price_rmb || null) : null),
          price_usd: existingBom ? existingBom.price_usd : (product ? (product.price_usd || null) : null),
          target_price: target_price || null,
          pricing_version: existingBom ? existingBom.pricing_version : 'V1.0',
          effective_date: existingBom ? existingBom.effective_date : now().substring(0, 10),
          remarks: custom_requirements || '',
          input_voltage: input_voltage || '',
          color_temp: color_temp || '',
          luminous_flux: luminous_flux || '',
          main_body: main_body || '',
          lampshade: lampshade || '',
          reflector: reflector || '',
          usb: usb || '',
          waterproof: waterproof || '',
          sensor: sensor || '',
          configuration: configuration || '',
          special_process: special_process || '',
          custom_requirements: custom_requirements || '',
          quantity: quantity || null,
          delivery_date: delivery_date || '',
          created_at: now(), updated_at: now()
        });
      }
      logOperation('提交核价', sales_person || 'system', `询价单 ${record.serial_number} 报价库无价格，已提交核价库`, result.lastID);
    }
  }

  if (customer_name) {
    const custTable = getTable('customers');
    const exists = custTable.all().find(c => c.name === customer_name);
    if (!exists) {
      custTable.insert({ name: customer_name, customer_code: customer_code || '', source: customer_source || '线上', customer_source: customer_source || '线上', country_region: country_region || '', contact: contact_person || '', phone: contact_phone || '', email: contact_email || '', created_at: now(), updated_at: now() });
    } else {
      const custUpdates = { updated_at: now() };
      const existingSource = exists.customer_source || exists.source || '';
      if (customer_source && (!existingSource || existingSource === '询价同步' || existingSource === '线上')) {
        custUpdates.source = customer_source;
        custUpdates.customer_source = customer_source;
      }
      if (country_region && !exists.country_region) {
        custUpdates.country_region = country_region;
      }
      if (contact_person && !exists.contact && !exists.contact_person) custUpdates.contact = contact_person;
      if (contact_phone && !exists.phone) custUpdates.phone = contact_phone;
      if (contact_email && !exists.email) custUpdates.email = contact_email;
      if (exists.customer_code) {
        table.update(result.lastID, { customer_code: exists.customer_code });
      } else if (customer_code) {
        custUpdates.customer_code = customer_code;
      }
      custTable.update(exists.id, custUpdates);
    }
  }

  if (external_model && product_category) {
    const product = prodTable.all().find(p => p.external_model === external_model);
    if (product && (!product.category || product.category === '')) {
      prodTable.update(product.id, { category: product_category, updated_at: now() });
    }
  }

  const created = table.findById(result.lastID);
  res.json({ message: statusReason, data: created, auto_quoted: initialStatus === 'quoted', applied_rules: appliedRules });
});

// 更新询价单
router.put('/:id', requirePerm('inquiry:edit'), (req, res) => {
  const table = getTable('inquiries');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '询价单不存在' });

  const fields = { updated_at: now() };
  const allowedFields = ['customer_name', 'customer_code', 'customer_source', 'country_region', 'sales_person', 'delivery_date',
    'external_model', 'internal_model', 'product_category', 'power', 'configuration',
    'quantity', 'custom_requirements', 'special_process', 'remarks', 'quote_validity',
    'product_name', 'input_voltage', 'battery', 'color_temp', 'luminous_flux',
    'light_source', 'main_body', 'lampshade', 'reflector', 'cable', 'switch_type',
    'usb', 'waterproof', 'sensor', 'target_price', 'quote_time_needed',
    'certificate_compliant', 'certificate_level', 'status',
    'contact_person', 'contact_phone', 'contact_email',
    'product_image',
    'material_cost', 'process_cost', 'accessory_cost', 'estimated_loss',
    'base_cost', 'profit_rate', 'discount_rate', 'final_price'];
  allowedFields.forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  // 如果状态变更，校验流转合规性并记录日志
  if (req.body.status && req.body.status !== existing.status) {
    const validTransitions = {
      'new': ['cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'lost'],
      'cert_configured': ['config_generated', 'pending_pricing', 'new', 'lost'],
      'config_generated': ['pending_pricing', 'cert_configured', 'new', 'lost'],
      'pending_pricing': ['pending_quote', 'quoted', 'config_generated', 'lost'],
      'pending_quote': ['quoted', 'config_generated', 'lost'],
      'quoted': ['negotiating', 'sample', 'project', 'closed', 'lost'],
      'negotiating': ['sample', 'project', 'lost', 'quoted', 'closed'],
      'sample': ['project', 'closed', 'lost'],
      'project': ['closed', 'lost'],
      'lost': ['new'],
      'closed': []
    };
    const allowed = validTransitions[existing.status] || [];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: `不允许从"${existing.status}"变更为"${req.body.status}"` });
    }
    const statusTable = getTable('inquiry_status_changes');
    statusTable.insert({ inquiry_id: Number(req.params.id), status: req.body.status, changed_by: req.body.operator || 'system', changed_at: now(), reason: req.body.reason || '状态变更' });
  }
  // 如果客户名称变更，同步到客户管理
  if (req.body.customer_name) {
    const custTable = getTable('customers');
    const exists = custTable.all().find(c => c.name === req.body.customer_name);
    if (!exists) {
      custTable.insert({ name: req.body.customer_name, source: req.body.customer_source || '线上', country_region: req.body.country_region || '', contact: '', phone: '', email: '', created_at: now(), updated_at: now() });
    } else {
      if (req.body.customer_source && (!exists.source || exists.source === '线上')) {
        custTable.update(exists.id, { source: req.body.customer_source, updated_at: now() });
      }
      if (req.body.country_region && !exists.country_region) {
        custTable.update(exists.id, { country_region: req.body.country_region, updated_at: now() });
      }
      if (exists.customer_code) {
        fields.customer_code = exists.customer_code;
      }
    }
  }
  table.update(req.params.id, fields);

  // 同步变更到关联的核价记录
  const bomTable = getTable('bom_pricing');
  bomTable._invalidate();
  const linkedPricings = bomTable.all().filter(b => b.inquiry_no === existing.serial_number);
  if (linkedPricings.length > 0) {
    const syncFields = {};
    const syncMap = {
      customer_name: 'customer',
      external_model: 'model',
      product_name: 'product_name',
      power: 'power',
      certificate_compliant: 'certificate_compliant',
      certificate_level: 'certificate_level',
      input_voltage: 'input_voltage',
      color_temp: 'color_temp',
      luminous_flux: 'luminous_flux',
      light_source: 'light_source',
      main_body: 'main_body',
      lampshade: 'lampshade',
      reflector: 'reflector',
      cable: 'cable',
      switch_type: 'switch_type',
      usb: 'usb',
      waterproof: 'waterproof',
      sensor: 'sensor',
      configuration: 'configuration',
      custom_requirements: 'custom_requirements',
      quantity: 'quantity',
      delivery_date: 'delivery_date'
    };
    Object.keys(syncMap).forEach(inqField => {
      if (req.body[inqField] !== undefined) {
        syncFields[syncMap[inqField]] = req.body[inqField];
      }
    });
    if (Object.keys(syncFields).length > 0) {
      syncFields.updated_at = now();
      linkedPricings.forEach(bp => {
        bomTable.update(bp.id, syncFields);
      });
    }
  }

  logOperation('更新询价', req.body.operator || 'system', `更新询价单 ${existing.serial_number}`, Number(req.params.id));
  res.json({ message: '询价单更新成功', data: table.findById(req.params.id) });
});

// 删除询价单
router.delete('/:id', requirePerm('inquiry:delete'), (req, res) => {
  const table = getTable('inquiries');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '询价单不存在' });

  const bomTable = getTable('bom_pricing');
  const orphans = bomTable.all().filter(b => b.inquiry_no === existing.serial_number);
  orphans.forEach(b => { bomTable.update(b.id, { inquiry_no: '/', updated_at: now() }); });

  table.delete(req.params.id);
  logOperation('删除询价', req.query.operator || 'system', `删除询价单 ${existing.serial_number}${orphans.length > 0 ? '，清理关联核价记录' + orphans.length + '条' : ''}`, Number(req.params.id));
  res.json({ message: '询价单删除成功' });
});

// ===== 智能核价（增强版：基于BOM表分项成本+核价库）=====
router.post('/:id/price', requirePerm('inquiry:price'), (req, res) => {
  const { profit_rate, discount_rate, operator } = req.body;
  const table = getTable('inquiries');
  const inquiry = table.findById(req.params.id);
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });

  const productTable = getTable('products');
  const pricingTable = getTable('bom_pricing');
  const materialTable = getTable('materials');
  const product = productTable.all().find(p => p.external_model === inquiry.external_model || p.internal_model === inquiry.external_model);

  let material_cost = 0, process_cost = 0, accessory_cost = 0, estimated_loss = 0, base_cost = 0;
  let bomDetails = [], pricingInfo = null;

  if (product) {
    // 从物料BOM计算成本
    const materials = materialTable.all().filter(m => m.product_id === product.id);
    materials.forEach(m => {
      const bomTotal = (m.kit_cost || 0) + (m.cable_cost || 0) + (m.light_source_cost || 0) +
                       (m.driver_cost || 0) + (m.battery_cost || 0) + (m.bracket_cost || 0) +
                       (m.switch_cost || 0) + (m.solar_panel_cost || 0) + (m.socket_cost || 0) +
                       (m.box_cost || 0) + (m.manual_cost || 0) + (m.packaging_cost || 0) +
                       (m.accessory_cost || 0) + (m.labor_cost || 0);
      const totalMatCost = bomTotal > 0 ? bomTotal : (m.standard_cost || m.unit_price || 0) * (m.quantity || 1);
      material_cost += totalMatCost;
      bomDetails.push({
        material_name: m.material_name, material_code: m.material_code,
        standard_cost: m.standard_cost, unit_price: m.unit_price,
        quantity: m.quantity, total: totalMatCost
      });
    });

    // 从核价库获取标准价格（按证书等级匹配）
    let pricingRecords = pricingTable.all().filter(ps => ps.model === inquiry.external_model || ps.model === inquiry.internal_model);
    if (inquiry.certificate_level) {
      const matched = pricingRecords.filter(ps => ps.certificate_level === inquiry.certificate_level);
      if (matched.length > 0) pricingRecords = matched;
    }
    const pricing = pricingRecords[0] || null;

    if (pricing) {
      pricingInfo = {
        pricing_id: pricing.id,
        total_cost: pricing.total_cost,
        labor_cost: pricing.labor_cost,
        process_cost: pricing.process_cost,
        estimated_loss: pricing.estimated_loss,
        min_price: pricing.min_price,
        price_rmb: pricing.price_rmb,
        price_usd: pricing.price_usd,
        pricing_version: pricing.pricing_version,
        effective_date: pricing.effective_date
      };
      // 使用核价库数据
      material_cost = pricing.total_cost - (pricing.labor_cost || 0) - (pricing.process_cost || 0) - (pricing.estimated_loss || 0);
      process_cost = (pricing.process_cost || 0) * inquiry.quantity;
      accessory_cost = (pricing.labor_cost || 0) * inquiry.quantity;
      estimated_loss = (pricing.estimated_loss || 0) * inquiry.quantity;
      base_cost = pricing.total_cost * inquiry.quantity;
    } else if (material_cost > 0) {
      process_cost = Math.round(material_cost * 0.25 * 100) / 100;
      accessory_cost = Math.round(material_cost * 0.1 * 100) / 100;
      estimated_loss = Math.round(material_cost * 0.05 * 100) / 100;
      base_cost = (material_cost + process_cost + accessory_cost + estimated_loss) * inquiry.quantity;
    }
  }

  if (base_cost === 0) {
    base_cost = 100 * inquiry.quantity;
    material_cost = Math.round(base_cost * 0.6 * 100) / 100;
    process_cost = Math.round(base_cost * 0.25 * 100) / 100;
    accessory_cost = Math.round(base_cost * 0.1 * 100) / 100;
    estimated_loss = Math.round(base_cost * 0.05 * 100) / 100;
  }

  const pRate = profit_rate !== undefined ? profit_rate : 0.2;
  const dRate = discount_rate !== undefined ? discount_rate : 1;
  const final_price = Math.round(base_cost * (1 + pRate) * dRate * 100) / 100;

  table.update(req.params.id, {
    material_cost, process_cost, accessory_cost, estimated_loss,
    base_cost, profit_rate: pRate, discount_rate: dRate, final_price,
    status: 'quoted', quoted_at: now(),
    updated_at: now()
  });

  const quotationTable = getTable('quotations');
  const updatedInquiry = table.findById(req.params.id);
  quotationTable.insert({
    quote_no: genQuoteNo(),
    inquiry_id: Number(req.params.id),
    inquiry_no: updatedInquiry.serial_number,
    customer_name: updatedInquiry.customer_name,
    customer_source: updatedInquiry.customer_source || '',
    country_region: updatedInquiry.country_region || '',
    sales_person: updatedInquiry.sales_person || '',
    external_model: updatedInquiry.external_model,
    internal_model: updatedInquiry.internal_model || '',
    product_name: updatedInquiry.product_name || '',
    product_category: updatedInquiry.product_category || '',
    power: updatedInquiry.power || '',
    quantity: updatedInquiry.quantity,
    discount_rate: dRate,
    final_price,
    unit_price: updatedInquiry.quantity > 0 ? Math.round(final_price / updatedInquiry.quantity * 100) / 100 : 0,
    config_data: JSON.stringify({
      input_voltage: updatedInquiry.input_voltage || '', battery: updatedInquiry.battery || '',
      color_temp: updatedInquiry.color_temp || '', luminous_flux: updatedInquiry.luminous_flux || '',
      light_source: updatedInquiry.light_source || '', main_body: updatedInquiry.main_body || '',
      lampshade: updatedInquiry.lampshade || '', reflector: updatedInquiry.reflector || '',
      cable: updatedInquiry.cable || '', switch_type: updatedInquiry.switch_type || '',
      usb: updatedInquiry.usb || '', waterproof: updatedInquiry.waterproof || '',
      sensor: updatedInquiry.sensor || '', configuration: updatedInquiry.configuration || ''
    }),
    bom_data: JSON.stringify(bomDetails),
    pricing_data: JSON.stringify({
      pricing_id: pricingInfo ? pricingInfo.pricing_id : null,
      bom_costs: {}, total_cost: base_cost,
      price_rmb: final_price, price_usd: null,
      min_price: pricingInfo ? pricingInfo.min_price : null,
      pricing_version: pricingInfo ? pricingInfo.pricing_version : 'V1.0',
      effective_date: now().substring(0, 10)
    }),
    custom_requirements: updatedInquiry.custom_requirements || '',
    special_process: updatedInquiry.special_process || '',
    delivery_date: updatedInquiry.delivery_date || '',
    quote_validity: updatedInquiry.quote_validity || '30天',
    remarks: updatedInquiry.remarks || '',
    certificate_compliant: updatedInquiry.certificate_compliant || '',
    certificate_level: updatedInquiry.certificate_level || '',
    discount_rate: dRate,
    status: 'confirmed',
    created_by: operator || 'system',
    created_at: now(), updated_at: now()
  });

  const statusTable = getTable('inquiry_status_changes');
  statusTable.insert({ inquiry_id: Number(req.params.id), status: 'quoted', changed_by: operator || 'system', changed_at: now(), reason: `快速报价 ¥${final_price}，已生成报价单` });
  logOperation('快速报价', operator || 'system', `询价单 ${updatedInquiry.serial_number} 报价 ¥${final_price}，已生成报价单`, Number(req.params.id));

  res.json({
    message: '核价成功，已生成报价单',
    data: { material_cost, process_cost, accessory_cost, estimated_loss, base_cost, profit_rate: pRate, discount_rate: dRate, final_price, bom_details: bomDetails, pricing_info: pricingInfo }
  });
});

// ===== 状态变更 =====
router.put('/:id/status', requirePerm('inquiry:status'), (req, res) => {
  const { status, changed_by, reason, lost_reason } = req.body;
  const validStatuses = ['new', 'cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'negotiating',
                         'sample', 'project', 'lost', 'closed'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: '无效的状态值，有效值: ' + validStatuses.join(', ') });
  }

  const table = getTable('inquiries');
  const inquiry = table.findById(req.params.id);
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });

  const transitions = {
    'new': ['cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'lost'],
    'cert_configured': ['config_generated', 'pending_pricing', 'new', 'lost'],
    'config_generated': ['pending_pricing', 'cert_configured', 'new', 'lost'],
    'pending_pricing': ['pending_quote', 'quoted', 'config_generated', 'lost'],
    'pending_quote': ['quoted', 'config_generated', 'lost'],
    'quoted': ['negotiating', 'sample', 'project', 'closed', 'lost'],
    'negotiating': ['sample', 'project', 'lost', 'quoted', 'closed'],
    'sample': ['project', 'closed', 'lost'],
    'project': ['closed', 'lost'],
    'lost': ['new'],
    'closed': []
  };
  const allowed = transitions[inquiry.status] || [];
  if (inquiry.status === status) {
    return res.status(400).json({ error: `状态已经是"${status}"，无需重复变更` });
  }
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `不允许从"${inquiry.status}"变更为"${status}"` });
  }

  const fields = { status, updated_at: now() };
  if (status === 'lost' && lost_reason) fields.lost_reason = lost_reason;
  table.update(req.params.id, fields);

  const statusTable = getTable('inquiry_status_changes');
  statusTable.insert({ inquiry_id: Number(req.params.id), status, changed_by: changed_by || 'system', changed_at: now(), reason: reason || '状态变更' });

  logOperation('状态变更', changed_by || 'system', `询价单 ${inquiry.serial_number} 状态从 ${inquiry.status} 变更为 ${status}`, Number(req.params.id));
  res.json({ message: '状态变更成功' });
});

// ===== 清理非法状态变更记录 =====
router.post('/clean-status-history', requirePerm('inquiry:edit'), (req, res) => {
  const statusTable = getTable('inquiry_status_changes');
  const inqTable = getTable('inquiries');
  statusTable._invalidate();
  inqTable._invalidate();

  const validTransitions = {
    'new': ['cert_configured', 'config_generated', 'pending_pricing', 'pending_quote', 'quoted', 'lost'],
    'cert_configured': ['config_generated', 'pending_pricing', 'new', 'lost'],
    'config_generated': ['pending_pricing', 'cert_configured', 'new', 'lost'],
    'pending_pricing': ['pending_quote', 'quoted', 'config_generated', 'lost'],
    'pending_quote': ['quoted', 'config_generated', 'lost'],
    'quoted': ['negotiating', 'sample', 'project', 'closed', 'lost'],
    'negotiating': ['sample', 'project', 'lost', 'quoted', 'closed'],
    'sample': ['project', 'closed', 'lost'],
    'project': ['closed', 'lost'],
    'lost': ['new'],
    'closed': []
  };

  const changes = statusTable.all().sort((a, b) => a.id - b.id);
  const byInquiry = {};
  changes.forEach(ch => {
    if (!byInquiry[ch.inquiry_id]) byInquiry[ch.inquiry_id] = [];
    byInquiry[ch.inquiry_id].push(ch);
  });

  const toDelete = [];
  let fixedCount = 0;

  for (const [inqId, chs] of Object.entries(byInquiry)) {
    for (let i = 1; i < chs.length; i++) {
      const prev = chs[i - 1].status;
      const curr = chs[i].status;
      const allowed = validTransitions[prev];
      if (prev === curr || (allowed && !allowed.includes(curr))) {
        toDelete.push(chs[i].id);
        fixedCount++;
      }
    }
  }

  toDelete.forEach(id => statusTable.delete(id));

  res.json({
    message: `清理完成，删除${fixedCount}条非法状态变更记录`,
    deleted: fixedCount,
    remaining: statusTable.all().length
  });
});

// ===== 规格书 CRUD =====
router.get('/:id/spec-sheet', requirePerm('inquiry:view'), (req, res) => {
  const table = getTable('spec_sheets');
  let sheet = table.all().find(s => s.inquiry_id === Number(req.params.id));
  if (!sheet) {
    const inquiryTable = getTable('inquiries');
    const inq = inquiryTable.findById(req.params.id);
    if (!inq) return res.status(404).json({ error: '询价单不存在' });
    const configTable = getTable('product_configs');
    let config = configTable.all().find(c => c.inquiry_id === Number(req.params.id));
    let fp = {}, ap = {};
    if (config) {
      try { fp = JSON.parse(config.fixed_params); } catch(e) {}
      try { ap = JSON.parse(config.adjustable_params); } catch(e) {}
    }
    sheet = {
      inquiry_id: Number(req.params.id),
      description: inq.product_name || fp.product_name || '',
      model_no: inq.external_model || '',
      version: 'B/1',
      file_no: 'HJ/ED/R-21',
      light_source: ap.light_source || inq.light_source || '',
      power: inq.power || '',
      input_voltage: ap.input_voltage || inq.input_voltage || '',
      power_efficiency: '',
      beam_angle: '',
      luminous_flux: ap.luminous_flux || inq.luminous_flux || '',
      cct: ap.color_temp || inq.color_temp || '',
      ra: '',
      ta: '',
      life_time: '',
      ip_rating: ap.waterproof || inq.waterproof || '',
      shell_material: ap.main_body || inq.main_body || '',
      reflector_material: ap.reflector || inq.reflector || '',
      battery_capacity: ap.battery || inq.battery || '',
      discharge_time: '',
      charging_time: '',
      switch_type: ap.switch_type || inq.switch_type || '',
      dimension: '',
      net_weight: '',
      inbox_size: '',
      carton_size: '',
      gw_nw: '',
      cable_spec: ap.cable || inq.cable || '',
      status: 'draft',
      created_at: now(),
      updated_at: now()
    };
    table.insert(sheet);
    sheet = table.all().find(s => s.inquiry_id === Number(req.params.id));
  }
  res.json(sheet);
});

router.put('/:id/spec-sheet', requirePerm('inquiry:edit'), (req, res) => {
  const table = getTable('spec_sheets');
  let sheet = table.all().find(s => s.inquiry_id === Number(req.params.id));
  if (!sheet) return res.status(404).json({ error: '规格书不存在，请先获取' });
  const fields = req.body;
  fields.updated_at = now();
  table.update(sheet.id, fields);
  sheet = table.all().find(s => s.inquiry_id === Number(req.params.id));
  logOperation('更新规格书', 'system', `更新规格书 ${sheet.model_no}`, Number(req.params.id));
  res.json(sheet);
});

// ===== 配置表 CRUD =====
router.get('/:id/config-sheet', requirePerm('inquiry:view'), (req, res) => {
  const table = getTable('config_sheets');
  let sheet = table.all().find(s => s.inquiry_id === Number(req.params.id));
  if (!sheet) {
    const inquiryTable = getTable('inquiries');
    const inq = inquiryTable.findById(req.params.id);
    if (!inq) return res.status(404).json({ error: '询价单不存在' });
    const configTable = getTable('product_configs');
    let config = configTable.all().find(c => c.inquiry_id === Number(req.params.id));
    let fp = {}, ap = {};
    if (config) {
      try { fp = JSON.parse(config.fixed_params); } catch(e) {}
      try { ap = JSON.parse(config.adjustable_params); } catch(e) {}
    }
    sheet = {
      inquiry_id: Number(req.params.id),
      model: inq.external_model || '',
      shell_material: ap.main_body || inq.main_body || '',
      reflector_material: ap.reflector || inq.reflector || '',
      bracket: '',
      handle_bar: '',
      waterproof: ap.waterproof || inq.waterproof || '',
      cable_spec: ap.cable || inq.cable || '',
      screw_material: '',
      glass: '',
      luminous_flux: ap.luminous_flux || inq.luminous_flux || '',
      compensated_flux: '',
      light_efficiency: '',
      electrical_params: ap.input_voltage || inq.input_voltage || '',
      cct: ap.color_temp || inq.color_temp || '',
      ra: '',
      led_count: ap.light_source || inq.light_source || '',
      rated_power: inq.power || '',
      chip_solution: '',
      pcb_model: '',
      battery_capacity: ap.battery || inq.battery || '',
      discharge_time: '',
      charging_time: '',
      inner_pack: '',
      outer_pack: '',
      transport_req: '',
      pack_other: '',
      cert_need: inq.certificate_compliant ? `${inq.certificate_compliant} ${inq.certificate_level || ''}`.trim() : '',
      env_req: '',
      uv_test: '',
      salt_spray: '',
      special_other: inq.custom_requirements || '',
      status: 'draft',
      created_at: now(),
      updated_at: now()
    };
    table.insert(sheet);
    sheet = table.all().find(s => s.inquiry_id === Number(req.params.id));
  }
  res.json(sheet);
});

router.put('/:id/config-sheet', requirePerm('inquiry:edit'), (req, res) => {
  const table = getTable('config_sheets');
  let sheet = table.all().find(s => s.inquiry_id === Number(req.params.id));
  if (!sheet) return res.status(404).json({ error: '配置表不存在，请先获取' });
  const fields = req.body;
  fields.updated_at = now();
  table.update(sheet.id, fields);
  sheet = table.all().find(s => s.inquiry_id === Number(req.params.id));
  logOperation('更新配置表', 'system', `更新配置表 ${sheet.model}`, Number(req.params.id));
  res.json(sheet);
});

// ===== 折扣审批 =====
router.post('/:id/discount-approval', requirePerm('inquiry:edit'), (req, res) => {
  const { discount_rate, reason, applicant, approver, action } = req.body;
  const table = getTable('inquiries');
  const inquiry = table.findById(req.params.id);
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });

  const approvalTable = getTable('discount_approvals');

  if (action === 'apply') {
    if (discount_rate === undefined || discount_rate === null) {
      return res.status(400).json({ error: '折扣率为必填项' });
    }
    const d = Number(discount_rate);
    let approvalLevel = '';
    if (d >= 1) {
      approvalLevel = 'none';
    } else if (d >= 0.95) {
      approvalLevel = 'manager';
    } else {
      approvalLevel = 'director';
    }

    if (approvalLevel === 'none') {
      table.update(req.params.id, {
        discount_rate: d,
        final_price: Math.round((inquiry.base_cost || 0) * (1 + (inquiry.profit_rate || 0)) * d * 100) / 100,
        updated_at: now()
      });
      const quotationTable = getTable('quotations');
      const quotations = quotationTable.all().filter(q => q.inquiry_id === Number(req.params.id));
      if (quotations.length > 0) {
        const latestQuote = quotations[quotations.length - 1];
        const newFinalPrice = Math.round((inquiry.base_cost || 0) * (1 + (inquiry.profit_rate || 0)) * d * 100) / 100;
        const unitPrice = latestQuote.quantity > 0 ? Math.round(newFinalPrice / latestQuote.quantity * 100) / 100 : newFinalPrice;
        quotationTable.update(latestQuote.id, {
          discount_rate: d,
          final_price: newFinalPrice,
          unit_price: unitPrice,
          updated_at: now()
        });
      }
      logOperation('折扣申请', applicant || 'system', `询价单 ${inquiry.serial_number} 折扣率${(d*100).toFixed(0)}%，无需审批`, Number(req.params.id));
      return res.json({ message: '折扣率≥1，无需审批，已直接应用', approval_level: 'none', discount_rate: d });
    }

    approvalTable.insert({
      inquiry_id: Number(req.params.id),
      inquiry_no: inquiry.serial_number,
      discount_rate: d,
      original_price: inquiry.final_price || inquiry.base_cost || 0,
      discounted_price: Math.round((inquiry.base_cost || 0) * (1 + (inquiry.profit_rate || 0)) * d * 100) / 100,
      reason: reason || '',
      applicant: applicant || '',
      approval_level: approvalLevel,
      status: 'pending',
      approver: '',
      approved_at: '',
      created_at: now(),
      updated_at: now()
    });
    logOperation('折扣申请', applicant || 'system', `询价单 ${inquiry.serial_number} 折扣率${(d*100).toFixed(0)}%，需${approvalLevel === 'manager' ? '经理' : '总监'}审批`, Number(req.params.id));
    res.json({
      message: `折扣率${(d*100).toFixed(0)}%，需${approvalLevel === 'manager' ? '经理' : '总监'}审批`,
      approval_level: approvalLevel,
      discount_rate: d,
      status: 'pending'
    });
  } else if (action === 'approve' || action === 'reject') {
    const pendingApprovals = approvalTable.all().filter(a =>
      a.inquiry_id === Number(req.params.id) && a.status === 'pending'
    );
    if (pendingApprovals.length === 0) {
      return res.status(400).json({ error: '无待审批的折扣申请' });
    }
    const latest = pendingApprovals[pendingApprovals.length - 1];
    approvalTable.update(latest.id, {
      status: action === 'approve' ? 'approved' : 'rejected',
      approver: approver || '',
      approved_at: now(),
      updated_at: now()
    });

    if (action === 'approve') {
      table.update(req.params.id, {
        discount_rate: latest.discount_rate,
        final_price: latest.discounted_price,
        updated_at: now()
      });
      const quotationTable = getTable('quotations');
      const quotations = quotationTable.all().filter(q => q.inquiry_id === Number(req.params.id));
      if (quotations.length > 0) {
        const latestQuote = quotations[quotations.length - 1];
        const unitPrice = latestQuote.quantity > 0 ? Math.round(latest.discounted_price / latestQuote.quantity * 100) / 100 : latest.discounted_price;
        quotationTable.update(latestQuote.id, {
          discount_rate: latest.discount_rate,
          final_price: latest.discounted_price,
          unit_price: unitPrice,
          updated_at: now()
        });
      }
      logOperation('折扣审批通过', approver || 'system', `询价单 ${inquiry.serial_number} 折扣率${(latest.discount_rate*100).toFixed(0)}%已审批通过`, Number(req.params.id));
      res.json({ message: '折扣审批已通过，已应用到报价', discount_rate: latest.discount_rate, final_price: latest.discounted_price });
    } else {
      logOperation('折扣审批驳回', approver || 'system', `询价单 ${inquiry.serial_number} 折扣率${(latest.discount_rate*100).toFixed(0)}%已驳回`, Number(req.params.id));
      res.json({ message: '折扣审批已驳回' });
    }
  } else {
    return res.status(400).json({ error: '无效的操作类型，支持: apply/approve/reject' });
  }
});

router.get('/:id/discount-approvals', requirePerm('inquiry:view'), (req, res) => {
  const approvalTable = getTable('discount_approvals');
  const approvals = approvalTable.all().filter(a => a.inquiry_id === Number(req.params.id));
  res.json(approvals);
});

module.exports = router;
