const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('bom_pricing');

// BOM成本项列表
const BOM_ITEMS = ['kit', 'cable', 'light_source', 'driver', 'battery', 'bracket', 'switch_type', 'solar_panel', 'socket', 'box', 'manual', 'packaging', 'accessories', 'labor'];
const BOM_LABELS = { kit: '套件', cable: '电缆线', light_source: '光源', driver: '驱动', battery: '电池', bracket: '支架', switch_type: '开关', solar_panel: '太阳能板', socket: '插座', box: '盒子', manual: '说明书', packaging: '包装', accessories: '配件', labor: '人工' };

// ===== 获取产品列表供关联选择 =====
router.get('/products/list', requirePerm('pricing:view'), (req, res) => {
  const prodTable = getTable('products');
  prodTable._invalidate();
  const products = prodTable.all().map(p => ({
    id: p.id,
    external_model: p.external_model,
    internal_model: p.internal_model,
    category: p.category,
    power: p.power,
    product_name: p.product_name || '',
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
  res.json({ data: products });
});

// ===== 核价表列表 =====
router.get('/', requirePerm('pricing:view'), (req, res) => {
  const { page = 1, limit = 15, keyword, customer, inquiry_no, model, pricer, certificate_level } = req.query;
  const table = getTable('bom_pricing');
  table._invalidate();
  const filter = (r) => {
    if (customer && !(r.customer || '').includes(customer)) return false;
    if (inquiry_no && !(r.inquiry_no || '').includes(inquiry_no)) return false;
    if (model && !(r.model || '').includes(model)) return false;
    if (pricer && !(r.pricer || '').includes(pricer)) return false;
    if (certificate_level && r.certificate_level !== certificate_level) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.customer, r.inquiry_no, r.model, r.product_name, r.pricer, r.pricing_link, r.remarks, r.product_series].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const { records, total } = table.findWhere(filter, 'created_at', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

  // 关联产品信息
  const prodTable = getTable('products');
  const enriched = records.map(r => {
    let product = prodTable.all().find(p => p.external_model === r.model || p.internal_model === r.model);
    if (!product && r.model) {
      const baseModel = r.model.replace(/-\d{2,}$/, '');
      if (baseModel !== r.model) {
        product = prodTable.all().find(p => p.external_model === baseModel || p.internal_model === baseModel);
      }
    }
    return { ...r, product_id: product ? product.id : null, product_category: product ? product.category : '' };
  });

  res.json({ data: enriched, total, page: parseInt(page), limit: parseInt(limit) });
});

// ===== 按询价单号获取子项产品列表 =====
router.get('/inquiry-products/:inquiryNo', requirePerm('pricing:view'), (req, res) => {
  const inquiryNo = req.params.inquiryNo;
  const inqTable = getTable('inquiries');
  inqTable._invalidate();
  // 查找同一询价单号的所有产品（支持分组编号如 JFX20260512-001 和 JFX20260512-001-02）
  const baseNo = inquiryNo.replace(/-\d{2,}$/, '');
  let list = inqTable.all().filter(i => {
    const sn = i.serial_number || '';
    return sn === inquiryNo || sn === baseNo || sn.startsWith(baseNo + '-');
  });
  // 如果没找到，尝试按客户名查找
  if (list.length === 0) {
    const first = inqTable.all().find(i => i.serial_number === inquiryNo);
    if (first && first.customer_name) {
      list = inqTable.all().filter(i => i.customer_name === first.customer_name);
    }
  }
  const data = list.map(i => ({
    id: i.id,
    serial_number: i.serial_number || '',
    customer_name: i.customer_name || '',
    customer_code: i.customer_code || '',
    external_model: i.external_model || '',
    internal_model: i.internal_model || '',
    product_name: i.product_name || '',
    power: i.power || '',
    quantity: i.quantity || 0,
    status: i.status || '',
    target_price: i.target_price || null,
    delivery_date: i.delivery_date || '',
    sales_person: i.sales_person || '',
    inquiry_time: i.inquiry_time || '',
    input_voltage: i.input_voltage || '',
    battery: i.battery || '',
    color_temp: i.color_temp || '',
    luminous_flux: i.luminous_flux || '',
    certificate_compliant: i.certificate_compliant || '',
    certificate_level: i.certificate_level || '',
    custom_requirements: i.custom_requirements || ''
  }));
  res.json({ data, total: data.length });
});

// ===== 按产品型号/名称搜索询价单（用于核价拉取）- 必须在 /:id 之前 =====
router.get('/search-inquiries', requirePerm('pricing:view'), (req, res) => {
  const { model, name } = req.query;
  const inqTable = getTable('inquiries');
  inqTable._invalidate();
  let list = inqTable.all();
  if (model) {
    const kw = model.toLowerCase();
    list = list.filter(i => (i.external_model || '').toLowerCase().includes(kw) || (i.internal_model || '').toLowerCase().includes(kw));
  }
  if (name) {
    const kw = name.toLowerCase();
    list = list.filter(i => (i.product_name || '').toLowerCase().includes(kw) || (i.customer_name || '').toLowerCase().includes(kw));
  }
  // 只返回最近20条
  list = list.slice(0, 20);
  const data = list.map(i => ({
    id: i.id,
    serial_number: i.serial_number || '',
    customer_name: i.customer_name || '',
    external_model: i.external_model || '',
    product_name: i.product_name || '',
    power: i.power || '',
    quantity: i.quantity || 0,
    status: i.status || '',
    target_price: i.target_price || null,
    delivery_date: i.delivery_date || '',
    sales_person: i.sales_person || '',
    inquiry_time: i.inquiry_time || ''
  }));
  res.json({ data, total: data.length });
});

// 核价详情
router.get('/:id', requirePerm('pricing:view'), (req, res) => {
  const table = getTable('bom_pricing');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '核价记录不存在' });

  const prodTable = getTable('products');
  let product = prodTable.all().find(p => p.external_model === row.model || p.internal_model === row.model);
  if (!product && row.model) {
    const baseModel = row.model.replace(/-\d{2,}$/, '');
    if (baseModel !== row.model) {
      product = prodTable.all().find(p => p.external_model === baseModel || p.internal_model === baseModel);
    }
  }
  res.json({ ...row, product_id: product ? product.id : null, product_info: product || null });
});

// 获取汇率
function getExchangeRate() {
  try {
    const settingsTable = getTable('system_settings');
    settingsTable._invalidate();
    const row = settingsTable.all().find(r => r.key === 'exchange_rate');
    if (row) {
      const val = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
      return parseFloat(val) || 7.25;
    }
  } catch(e) {}
  return 7.25;
}

// 批量删除核价记录
router.post('/batch-delete', requirePerm('pricing:delete'), (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要删除的记录' });
  }
  const table = getTable('bom_pricing');
  let deleted = 0;
  ids.forEach(id => {
    const existing = table.findById(id);
    if (existing) { table.delete(id); deleted++; }
  });
  res.json({ message: `成功删除 ${deleted} 条核价记录`, deleted });
});

// 创建核价记录
router.post('/', requirePerm('pricing:create'), (req, res) => {
  const { customer, inquiry_no, model, product_name, power, product_series,
    certificate_compliant, certificate_level,
    kit, cable, light_source, driver, battery, bracket, switch_type,
    solar_panel, socket, box, manual, packaging, accessories, labor,
    total_cost, labor_cost, process_cost, estimated_loss,
    min_price, pricer, pricing_link, price_rmb, price_usd, profit_rate, target_price,
    pricing_version, effective_date, remarks,
    input_voltage, color_temp, luminous_flux, main_body, lampshade,
    reflector, usb, waterproof, sensor, configuration, special_process,
    custom_requirements, quantity, delivery_date } = req.body;

  if (!model) return res.status(400).json({ error: '型号为必填项' });
  if (!pricer) return res.status(400).json({ error: '核价人为必填项' });

  // 自动计算BOM合计
  const bomCosts = { kit, cable, light_source, driver, battery, bracket, switch_type, solar_panel, socket, box, manual, packaging, accessories, labor };
  let calcBomTotal = 0;
  Object.values(bomCosts).forEach(v => { if (v) calcBomTotal += Number(v); });

  // 自动计算总成本 = BOM合计 + 人工加工费 + 工艺成本 + 预估损耗
  const lCost = labor_cost ? Number(labor_cost) : 0;
  const pCost = process_cost ? Number(process_cost) : 0;
  const eLoss = estimated_loss ? Number(estimated_loss) : 0;
  const calcTotal = (total_cost ? Number(total_cost) : calcBomTotal) + lCost + pCost + eLoss;

  const table = getTable('bom_pricing');
  // 汇率自动换算，报价保留2位小数
  const rate = getExchangeRate();
  let finalPriceRmb = price_rmb ? Math.round(Number(price_rmb) * 100) / 100 : null;
  let finalPriceUsd = price_usd ? Math.round(Number(price_usd) * 100) / 100 : null;
  if (finalPriceRmb && !finalPriceUsd) {
    finalPriceUsd = Math.round(finalPriceRmb / rate * 100) / 100;
  } else if (finalPriceUsd && !finalPriceRmb) {
    finalPriceRmb = Math.round(finalPriceUsd * rate * 100) / 100;
  }

  const result = table.insert({
    customer: customer || '',
    inquiry_no: inquiry_no || '',
    model,
    product_name: product_name || '',
    power: power || '',
    product_series: product_series || '',
    certificate_compliant: certificate_compliant || '',
    certificate_level: certificate_level || '',
    kit: kit ? Number(kit) : null,
    cable: cable ? Number(cable) : null,
    light_source: light_source ? Number(light_source) : null,
    driver: driver ? Number(driver) : null,
    battery: battery ? Number(battery) : null,
    bracket: bracket ? Number(bracket) : null,
    switch_type: switch_type ? Number(switch_type) : null,
    solar_panel: solar_panel ? Number(solar_panel) : null,
    socket: socket ? Number(socket) : null,
    box: box ? Number(box) : null,
    manual: manual ? Number(manual) : null,
    packaging: packaging ? Number(packaging) : null,
    accessories: accessories ? Number(accessories) : null,
    labor: labor ? Number(labor) : null,
    total_cost: calcTotal,
    labor_cost: lCost,
    process_cost: pCost,
    estimated_loss: eLoss,
    min_price: min_price ? Number(min_price) : null,
    pricer: pricer || '',
    pricing_link: pricing_link || '',
    price_rmb: finalPriceRmb,
    price_usd: finalPriceUsd,
    profit_rate: profit_rate ? Number(profit_rate) : null,
    target_price: target_price ? Number(target_price) : null,
    pricing_version: pricing_version || 'V1.0',
    effective_date: effective_date || now().substring(0, 10),
    remarks: remarks || '',
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
    quantity: quantity ? Number(quantity) : null,
    delivery_date: delivery_date || '',
    created_at: now(),
    updated_at: now()
  });

  const created = table.findById(result.lastID);
  syncToProduct(model, created);
  syncToInquiry(created);
  res.json({ message: '核价记录创建成功', data: created });
});

// 更新核价记录
router.put('/:id', requirePerm('pricing:edit'), (req, res) => {
  const table = getTable('bom_pricing');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '核价记录不存在' });

  const fields = { updated_at: now() };
  if (req.body.pricer !== undefined && !req.body.pricer) return res.status(400).json({ error: '核价人为必填项' });
  if (req.body.pricer === undefined && !existing.pricer) return res.status(400).json({ error: '核价人为必填项' });
  ['customer', 'inquiry_no', 'model', 'product_name', 'power', 'product_series',
   'certificate_compliant', 'certificate_level', 'pricer', 'pricing_link',
   'remarks', 'pricing_version', 'effective_date',
   'input_voltage', 'color_temp', 'luminous_flux', 'main_body', 'lampshade',
   'reflector', 'usb', 'waterproof', 'sensor', 'configuration', 'special_process',
   'custom_requirements', 'delivery_date'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['kit', 'cable', 'light_source', 'driver', 'battery', 'bracket', 'switch_type',
   'solar_panel', 'socket', 'box', 'manual', 'packaging', 'accessories', 'labor',
   'total_cost', 'labor_cost', 'process_cost', 'estimated_loss',
   'min_price', 'target_price', 'quantity', 'profit_rate'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f] !== null ? Number(req.body[f]) : null;
  });

  // 汇率自动换算，报价保留2位小数
  const rate = getExchangeRate();
  let priceRmb = req.body.price_rmb !== undefined ? (req.body.price_rmb !== null ? Math.round(Number(req.body.price_rmb) * 100) / 100 : null) : existing.price_rmb;
  let priceUsd = req.body.price_usd !== undefined ? (req.body.price_usd !== null ? Math.round(Number(req.body.price_usd) * 100) / 100 : null) : existing.price_usd;
  if (req.body.price_rmb !== undefined && req.body.price_usd === undefined) {
    priceUsd = priceRmb ? Math.round(priceRmb / rate * 100) / 100 : null;
  } else if (req.body.price_usd !== undefined && req.body.price_rmb === undefined) {
    priceRmb = priceUsd ? Math.round(priceUsd * rate * 100) / 100 : null;
  }
  fields.price_rmb = priceRmb;
  fields.price_usd = priceUsd;

  // 自动重算合计
  const updated = { ...existing, ...fields };
  let calcBomTotal = 0;
  BOM_ITEMS.forEach(item => { if (updated[item]) calcBomTotal += Number(updated[item]); });
  const lCost = updated.labor_cost || 0;
  const pCost = updated.process_cost || 0;
  const eLoss = updated.estimated_loss || 0;
  if (fields.total_cost === undefined) {
    fields.total_cost = calcBomTotal + Number(lCost) + Number(pCost) + Number(eLoss);
  }

  table.update(req.params.id, fields);
  const saved = table.findById(req.params.id);
  syncToProduct(saved.model, saved);
  syncToInquiry(saved);
  res.json({ message: '核价记录更新成功', data: saved });
});

// 删除核价记录
router.delete('/:id', requirePerm('pricing:delete'), (req, res) => {
  const table = getTable('bom_pricing');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '核价记录不存在' });
  table.delete(req.params.id);
  res.json({ message: '核价记录删除成功' });
});

// ===== 从产品名称推断品类 =====
function inferCategory(productName) {
  if (!productName) return '';
  const keywords = ['工作灯','泛光灯','投光灯','隧道灯','路灯','工矿灯','防爆灯','应急灯','手电筒','头灯','营地灯','太阳能灯','草坪灯','庭院灯','筒灯','射灯','面板灯','灯带','灯管','灯泡'];
  for (const kw of keywords) {
    if (productName.includes(kw)) return kw;
  }
  return '';
}

// ===== 同步核价到产品 =====
function syncToProduct(model, bomRecord) {
  if (!model) return;
  const prodTable = getTable('products');
  prodTable._invalidate();
  const product = prodTable.all().find(p => p.external_model === model || p.internal_model === model);
  if (product) {
    // 已存在产品，更新内部型号、品类、产品名称和价格
    const updates = { updated_at: now() };
    if (bomRecord.total_cost) updates.cost_price = bomRecord.total_cost;
    if (bomRecord.price_rmb) updates.price_rmb = bomRecord.price_rmb;
    if (bomRecord.price_usd) updates.price_usd = bomRecord.price_usd;
    if (bomRecord.min_price) updates.min_price = bomRecord.min_price;
    // 同步品类和产品名称（核价有值且产品为空时覆盖）
    if (bomRecord.product_series && (!product.category || product.category === '')) updates.category = bomRecord.product_series;
    if (bomRecord.product_name && (!product.product_name || product.product_name === '')) updates.product_name = bomRecord.product_name;
    if (bomRecord.power && (!product.power || product.power === '')) updates.power = bomRecord.power;
    // 从产品名称推断品类（如 "S系列100W工作灯" → "工作灯"）
    if (!updates.category && bomRecord.product_name) {
      const inferred = inferCategory(bomRecord.product_name);
      if (inferred && (!product.category || product.category === '')) updates.category = inferred;
    }
    prodTable.update(product.id, updates);
  } else {
    // 不存在产品，自动创建，型号作为内部型号
    const category = bomRecord.product_series || inferCategory(bomRecord.product_name || '') || '';
    prodTable.insert({
      external_model: model,
      internal_model: model,
      product_name: bomRecord.product_name || '',
      category: category,
      power: bomRecord.power || '',
      cost_price: bomRecord.total_cost || null,
      price_rmb: bomRecord.price_rmb || null,
      price_usd: bomRecord.price_usd || null,
      min_price: bomRecord.min_price || null,
      pricing_status: 'priced',
      created_at: now(),
      updated_at: now()
    });
  }

  // 同步客户到客户管理
  syncToCustomer(bomRecord);
}

// ===== 同步核价客户到客户管理 =====
function syncToCustomer(bomRecord) {
  const customerName = bomRecord.customer;
  if (!customerName) return;
  const custTable = getTable('customers');
  custTable._invalidate();
  const existing = custTable.all().find(c => c.name === customerName);
  if (!existing) {
    // 客户不存在，自动创建
    custTable.insert({
      name: customerName,
      source: '核价导入',
      contact: '',
      phone: '',
      email: '',
      created_at: now(),
      updated_at: now()
    });
  }
}

// ===== 核价完成后回写询价单 =====
function syncToInquiry(bomRecord) {
  if (!bomRecord.inquiry_no) return;
  const inqTable = getTable('inquiries');
  inqTable._invalidate();
  const bomNo = bomRecord.inquiry_no || '';
  const bomModel = bomRecord.model || '';
  let matchedInquiry = null;
  const exactMatch = inqTable.all().find(i => i.serial_number === bomNo || i.inquiry_no === bomNo);
  if (exactMatch) {
    matchedInquiry = exactMatch;
  } else {
    const baseNo = bomNo.replace(/-\d{2,}$/, '');
    const candidates = inqTable.all().filter(i => {
      const sn = i.serial_number || '';
      return sn === baseNo || sn.startsWith(baseNo + '-');
    });
    if (candidates.length > 0 && bomModel) {
      matchedInquiry = candidates.find(i => i.external_model === bomModel);
      if (!matchedInquiry) {
        const baseModel = bomModel.replace(/-\d{2,}$/, '');
        matchedInquiry = candidates.find(i => {
          const iModel = (i.external_model || '').replace(/-\d{2,}$/, '');
          return iModel === baseModel;
        });
      }
    }
    if (!matchedInquiry && candidates.length === 1) {
      matchedInquiry = candidates[0];
    }
  }
  if (!matchedInquiry) return;

  const updates = { updated_at: now() };
  if (bomRecord.total_cost) updates.material_cost = bomRecord.total_cost;
  if (bomRecord.base_cost || bomRecord.total_cost) updates.base_cost = bomRecord.base_cost || bomRecord.total_cost;
  if (bomRecord.price_rmb) {
    updates.final_price = bomRecord.price_rmb;
    updates.quoted_price = bomRecord.price_rmb;
  }
  if (bomRecord.price_usd) updates.quoted_price_usd = bomRecord.price_usd;
  if (bomRecord.min_price) updates.min_price = bomRecord.min_price;
  updates.pricing_id = bomRecord.id;
  if (matchedInquiry.status === 'new' || matchedInquiry.status === 'pending_pricing') {
    updates.status = 'pending_quote';
  }
  if (matchedInquiry.status === 'pending_quote' && bomRecord.price_rmb) {
    updates.status = 'quoted';
  }
  inqTable.update(matchedInquiry.id, updates);

  if (updates.status && updates.status !== matchedInquiry.status) {
    const statusTable = getTable('inquiry_status_changes');
    statusTable.insert({
      inquiry_id: matchedInquiry.id,
      status: updates.status,
      changed_by: 'system',
      changed_at: now(),
      reason: `核价库自动回写: 型号${bomRecord.model}, 报价¥${bomRecord.price_rmb || '-'}`
    });
  }

  if (bomRecord.customer) {
    const custTable = getTable('customers');
    const exists = custTable.all().find(c => c.name === bomRecord.customer || c.code === bomRecord.customer);
    if (!exists) {
      custTable.insert({ name: bomRecord.customer, code: bomRecord.customer, source: '核价库', contact: '', phone: '', email: '', created_at: now(), updated_at: now() });
    }
  }
}

// ===== 一次性同步历史数据 =====
router.post('/sync-all', requirePerm('pricing:edit'), (req, res) => {
  const table = getTable('bom_pricing');
  table._invalidate();
  const allRecords = table.all();
  let syncedProducts = 0, syncedCustomers = 0, skippedProducts = 0, skippedCustomers = 0;

  allRecords.forEach(r => {
    // 同步产品
    if (r.model) {
      const prodTable = getTable('products');
      prodTable._invalidate();
      const product = prodTable.all().find(p => p.external_model === r.model || p.internal_model === r.model);
      if (product) {
        const updates = { updated_at: now() };
        if (r.total_cost) updates.cost_price = r.total_cost;
        if (r.price_rmb) updates.price_rmb = r.price_rmb;
        if (r.price_usd) updates.price_usd = r.price_usd;
        if (r.min_price) updates.min_price = r.min_price;
        if (r.product_series && (!product.category || product.category === '')) updates.category = r.product_series;
        if (r.product_name && (!product.product_name || product.product_name === '')) updates.product_name = r.product_name;
        if (r.power && (!product.power || product.power === '')) updates.power = r.power;
        if (!updates.category && r.product_name) {
          const inferred = inferCategory(r.product_name);
          if (inferred && (!product.category || product.category === '')) updates.category = inferred;
        }
        prodTable.update(product.id, updates);
        skippedProducts++;
      } else {
        const category = r.product_series || inferCategory(r.product_name || '') || '';
        prodTable.insert({
          external_model: r.model,
          internal_model: r.model,
          product_name: r.product_name || '',
          category: category,
          power: r.power || '',
          cost_price: r.total_cost || null,
          price_rmb: r.price_rmb || null,
          price_usd: r.price_usd || null,
          min_price: r.min_price || null,
          pricing_status: 'priced',
          created_at: now(),
          updated_at: now()
        });
        syncedProducts++;
      }
    }

    // 同步客户
    if (r.customer) {
      const custTable = getTable('customers');
      custTable._invalidate();
      const existing = custTable.all().find(c => c.name === r.customer);
      if (!existing) {
        custTable.insert({
          name: r.customer,
          source: '核价导入',
          contact: '',
          phone: '',
          email: '',
          created_at: now(),
          updated_at: now()
        });
        syncedCustomers++;
      } else {
        skippedCustomers++;
      }
    }
  });

  res.json({
    message: '同步完成',
    total_pricing_records: allRecords.length,
    synced_products: syncedProducts,
    updated_products: skippedProducts,
    synced_customers: syncedCustomers,
    existing_customers: skippedCustomers
  });
});

// ===== 从询价单拉取信息 =====
router.get('/from-inquiry/:inquiryNo', requirePerm('pricing:view'), (req, res) => {
  const inqTable = getTable('inquiries');
  inqTable._invalidate();
  const bomNo = req.params.inquiryNo;
  const all = inqTable.all();
  let inquiry = all.find(i => i.serial_number === bomNo || i.inquiry_no === bomNo);
  if (!inquiry) {
    inquiry = all.find(i => {
      const sn = i.serial_number || '';
      const ino = i.inquiry_no || '';
      return sn.startsWith(bomNo) || bomNo.startsWith(sn) || ino.startsWith(bomNo) || bomNo.startsWith(ino);
    });
  }
  if (!inquiry) return res.json(null);

  const result = {
    inquiry_id: inquiry.id,
    serial_number: inquiry.serial_number,
    customer_name: inquiry.customer_name || '',
    external_model: inquiry.external_model || '',
    product_name: inquiry.product_name || '',
    internal_model: inquiry.internal_model || '',
    power: inquiry.power || '',
    quantity: inquiry.quantity || 0,
    status: inquiry.status,
    requirements: inquiry.requirements || '',
    target_price: inquiry.target_price || null,
    delivery_date: inquiry.delivery_date || '',
    sales_person: inquiry.sales_person || '',
    input_voltage: inquiry.input_voltage || '',
    color_temp: inquiry.color_temp || '',
    luminous_flux: inquiry.luminous_flux || '',
    light_source: inquiry.light_source || '',
    main_body: inquiry.main_body || '',
    lampshade: inquiry.lampshade || '',
    reflector: inquiry.reflector || '',
    cable: inquiry.cable || '',
    switch_type: inquiry.switch_type || '',
    usb: inquiry.usb || '',
    waterproof: inquiry.waterproof || '',
    sensor: inquiry.sensor || '',
    configuration: inquiry.configuration || '',
    special_process: inquiry.special_process || '',
    custom_requirements: inquiry.custom_requirements || '',
    certificate_compliant: inquiry.certificate_compliant || '',
    certificate_level: inquiry.certificate_level || '',
    product_category: inquiry.product_category || ''
  };

  const model = inquiry.external_model || '';
  if (model) {
    const prodTable = getTable('products');
    prodTable._invalidate();
    let product = prodTable.all().find(p => p.external_model === model || p.internal_model === model);
    if (!product) {
      const baseModel = model.replace(/-\d{2,}$/, '');
      if (baseModel !== model) {
        product = prodTable.all().find(p => p.external_model === baseModel || p.internal_model === baseModel);
      }
    }
    if (product) {
      result.base_model = product.external_model;
      result.is_variant = product.external_model !== model;
      if (!result.product_name && product.product_name) result.product_name = product.product_name;
      if (!result.internal_model && product.internal_model) result.internal_model = product.internal_model;
      if (!result.power && product.power) result.power = product.power;
      if (!result.product_category && product.category) result.product_category = product.category;
      const paramFields = ['input_voltage','battery','color_temp','luminous_flux','light_source','main_body','lampshade','reflector','cable','switch_type','usb','waterproof','sensor'];
      paramFields.forEach(f => {
        if (!result[f] && product[f]) result[f] = product[f];
      });
    }
  }

  res.json(result);
});

// ===== 按产品型号查询核价 =====
router.get('/by-model/:model', requirePerm('pricing:view'), (req, res) => {
  const table = getTable('bom_pricing');
  const records = table.all().filter(r => r.model === req.params.model);
  res.json({ data: records });
});

// ===== 按证书等级查询核价 =====
router.get('/by-certificate/:level', requirePerm('pricing:view'), (req, res) => {
  const table = getTable('bom_pricing');
  const records = table.all().filter(r => r.certificate_level === req.params.level);
  res.json({ data: records });
});

// ===== 核价统计 =====
router.get('/stats/summary', requirePerm('pricing:view'), (req, res) => {
  const table = getTable('bom_pricing');
  const all = table.all();
  const stats = {
    total: all.length,
    avg_cost: all.length ? (all.reduce((s, r) => s + (r.total_cost || 0), 0) / all.length).toFixed(2) : 0,
    avg_price_rmb: all.filter(r => r.price_rmb).length ? (all.filter(r => r.price_rmb).reduce((s, r) => s + r.price_rmb, 0) / all.filter(r => r.price_rmb).length).toFixed(2) : 0,
    total_customers: [...new Set(all.map(r => r.customer).filter(Boolean))].length,
    by_pricer: {},
    by_certificate: {}
  };
  all.forEach(r => {
    if (r.pricer) stats.by_pricer[r.pricer] = (stats.by_pricer[r.pricer] || 0) + 1;
    if (r.certificate_level) stats.by_certificate[r.certificate_level] = (stats.by_certificate[r.certificate_level] || 0) + 1;
  });
  res.json(stats);
});

// ===== 汇率重算 =====
router.post('/recalc-exchange', requirePerm('pricing:edit'), (req, res) => {
  const settingsTable = getTable('system_settings');
  settingsTable._invalidate();
  const rateRow = settingsTable.all().find(r => r.key === 'exchange_rate');
  const rate = rateRow ? Number(rateRow.value) : 7.25;

  const pricingTable = getTable('bom_pricing');
  pricingTable._invalidate();
  let pricingFixed = 0;
  pricingTable.all().forEach(p => {
    if (p.price_rmb && p.price_usd) {
      const expectedUsd = Math.round(p.price_rmb / rate * 10000) / 10000;
      const diff = Math.abs(p.price_usd - expectedUsd);
      const tolerance = Math.max(expectedUsd * 0.05, 0.5);
      if (diff > tolerance) {
        pricingTable.update(p.id, { price_usd: expectedUsd, updated_at: now() });
        pricingFixed++;
      }
    }
  });

  const quoteTable = getTable('quote_library');
  quoteTable._invalidate();
  let quoteFixed = 0;
  quoteTable.all().forEach(q => {
    if (q.price_rmb && q.price_usd) {
      const expectedUsd = Math.round(q.price_rmb / rate * 10000) / 10000;
      const diff = Math.abs(q.price_usd - expectedUsd);
      const tolerance = Math.max(expectedUsd * 0.05, 0.5);
      if (diff > tolerance) {
        quoteTable.update(q.id, { price_usd: expectedUsd, updated_at: now() });
        quoteFixed++;
      }
    }
  });

  res.json({
    message: `汇率重算完成(汇率=${rate})，修正核价${pricingFixed}条、报价${quoteFixed}条`,
    rate,
    pricing_fixed: pricingFixed,
    quote_fixed: quoteFixed
  });
});

module.exports = router;
