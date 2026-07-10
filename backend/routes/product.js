const express = require('express');
const router = express.Router();
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const XLSX = require('xlsx');

function getSubModelRules() {
  const dictTable = getTable('data_dictionary');
  dictTable._invalidate();
  const rules = dictTable.all().filter(r => r.group_code === 'sub_model_rule' && r.enabled !== 0);
  const ruleMap = {};
  rules.forEach(r => {
    const val = r.item_value || '';
    const [key, ...rest] = val.split(':');
    ruleMap[key.trim()] = rest.join(':').trim();
  });
  return {
    separator: ruleMap['分隔符'] || '-',
    digits: parseInt(ruleMap['流水号位数']) || 2,
    startSeq: parseInt(ruleMap['起始编号']) || 1,
    suffixFormat: ruleMap['后缀格式'] || '-NN',
    compareFields: (ruleMap['判断字段'] || 'power,input_voltage,battery,color_temp,luminous_flux,light_source,main_body,lampshade,reflector,cable,switch_type,usb,waterproof,sensor').split(',').map(s => s.trim()).filter(Boolean)
  };
}

// 产品列表（分页+筛选）
router.get('/', requirePerm('product:view'), (req, res) => {
  const { page = 1, limit = 10, category, external_model, internal_model, keyword } = req.query;
  const table = getTable('products');
  table._invalidate();
  const filter = (r) => {
    if (category && !(r.category || '').includes(category)) return false;
    if (external_model && !(r.external_model || '').includes(external_model)) return false;
    if (internal_model && !(r.internal_model || '').includes(internal_model)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [r.external_model, r.internal_model, r.category, r.power,
        r.configuration, r.specs, r.product_name, r.input_voltage, r.battery,
        r.color_temp, r.luminous_flux, r.light_source, r.main_body, r.lampshade,
        r.reflector, r.cable, r.switch_type, r.usb, r.waterproof, r.sensor].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const { records, total } = table.findWhere(filter, 'created_at', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

  // 关联核价信息
  const bomTable = getTable('bom_pricing');
  bomTable._invalidate();
  const enriched = records.map(r => {
    const bom = bomTable.all().find(b => b.model === r.external_model || b.model === r.internal_model);
    return {
      ...r,
      cost_price: bom ? bom.total_cost : (r.cost_price || null),
      price_rmb: bom ? bom.price_rmb : (r.price_rmb || null),
      price_usd: bom ? bom.price_usd : (r.price_usd || null)
    };
  });

  res.json({ data: enriched, total, page: parseInt(page), limit: parseInt(limit) });
});

// 从核价表导入产品（去重）- 必须在 /:id 之前
router.post('/import-from-pricing', requirePerm('product:create'), (req, res) => {
  const { ids } = req.body;
  const bomTable = getTable('bom_pricing');
  bomTable._invalidate();
  const prodTable = getTable('products');
  prodTable._invalidate();

  let pricingList = bomTable.all();
  if (ids && Array.isArray(ids) && ids.length > 0) {
    pricingList = pricingList.filter(p => ids.includes(String(p.id)));
  }

  const existingExt = new Set(prodTable.all().map(p => p.external_model).filter(Boolean));
  const existingInt = new Set(prodTable.all().map(p => p.internal_model).filter(Boolean));
  let imported = 0, skipped = 0, results = [];

  pricingList.forEach(p => {
    const model = p.model;
    if (!model) { skipped++; return; }
    const intModel = (p.internal_model || '').trim();
    // 外部型号或内部型号重复均不导入
    if (existingExt.has(model) || (intModel && existingInt.has(intModel))) {
      skipped++;
      const reason = existingExt.has(model) ? '外部型号已存在' : '内部型号已存在';
      results.push({ model, status: 'skipped', reason });
      return;
    }
    prodTable.insert({
      external_model: model,
      internal_model: intModel,
      category: p.product_category || p.category || '',
      power: p.power || '',
      product_name: p.product_name || '',
      configuration: p.configuration || '',
      specs: '',
      input_voltage: p.input_voltage || '',
      battery: p.battery || '',
      color_temp: p.color_temp || '',
      luminous_flux: p.luminous_flux || '',
      light_source: p.light_source || '',
      main_body: p.main_body || '',
      press_frame: '',
      lampshade: p.lampshade || '',
      reflector: p.reflector || '',
      cable: p.cable || '',
      switch_type: p.switch_type || '',
      usb: p.usb || '',
      waterproof: p.waterproof || '',
      sensor: p.sensor || '',
      cost_price: p.total_cost || null,
      price_rmb: p.price_rmb || null,
      price_usd: p.price_usd || null,
      created_at: now(), updated_at: now()
    });
    existingExt.add(model);
    if (intModel) existingInt.add(intModel);
    imported++;
    results.push({ model, status: 'imported' });
  });

  res.json({ imported, skipped, results });
});

// 获取核价表中可导入的产品列表 - 必须在 /:id 之前
router.get('/pricing-available', requirePerm('product:view'), (req, res) => {
  const bomTable = getTable('bom_pricing');
  bomTable._invalidate();
  const prodTable = getTable('products');
  prodTable._invalidate();

  const existingModels = new Set(prodTable.all().map(p => p.external_model));
  const pricingList = bomTable.all().filter(p => p.model && !existingModels.has(p.model));

  const data = pricingList.map(p => ({
    id: p.id,
    model: p.model,
    product_name: p.product_name || '',
    power: p.power || '',
    category: p.product_category || p.category || '',
    price_rmb: p.price_rmb || '',
    customer: p.customer || '',
    created_at: p.created_at || ''
  }));

  res.json({ data, total: data.length });
});

// Excel上传导入BOM（必须在/:id之前，否则会被匹配为id参数）
router.post('/bom-upload', upload.single('file'), requirePerm('product:create'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  const productId = Number(req.body.productId);
  if (!productId) return res.status(400).json({ error: '缺少产品ID' });

  const prodTable = getTable('products');
  const product = prodTable.findById(productId);
  if (!product) return res.status(404).json({ error: '产品不存在' });

  const importLog = {
    product_id: productId,
    product_model: product.external_model || '',
    file_name: req.file.originalname || req.file.filename || '',
    import_time: now(),
    status: 'processing',
    total_rows: 0,
    imported_count: 0,
    max_level: 0,
    hierarchy_nodes: 0,
    processing_fee_total: 0,
    quantity_total: 0,
    amount_total: 0,
    errors: [],
    warnings: [],
    summary: ''
  };

  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });

    const bomHeaderIdx = data.findIndex(row => row && row.some(c => String(c).includes('层次') || String(c).includes('层级')));
    if (bomHeaderIdx === -1) {
      importLog.status = 'failed';
      importLog.errors.push('未找到BOM表头（层次列）');
      saveImportLog(importLog);
      try { require('fs').unlinkSync(req.file.path); } catch(e) {}
      return res.status(400).json({ error: '未找到BOM表头（层次列）' });
    }

    const headerRow = data[bomHeaderIdx];
    const colMap = {};
    headerRow.forEach((cell, idx) => {
      const c = String(cell || '').trim();
      if (c.includes('层次') || c.includes('层级')) colMap.level = idx;
      else if (c.includes('物料代码') || c.includes('物料编码') || c === '代码') colMap.code = idx;
      else if (c.includes('物料名称') || c.includes('名称')) colMap.name = idx;
      else if (c.includes('规格') || c.includes('型号')) colMap.spec = idx;
      else if (c === '单位') colMap.unit = idx;
      else if (c.includes('数量')) colMap.quantity = idx;
      else if (c.includes('物料属性') || c.includes('属性')) colMap.material_type = idx;
      else if (c.includes('加工费')) colMap.processing_fee = idx;
      else if (c.includes('单价') || c.includes('标准成本')) colMap.unit_price = idx;
      else if (c.includes('金额') || c.includes('总价')) colMap.amount = idx;
      else if (c.includes('备注')) colMap.remarks = idx;
    });

    if (colMap.level === undefined || colMap.code === undefined) {
      importLog.status = 'failed';
      importLog.errors.push('表头缺少必要列（层次/物料代码）');
      saveImportLog(importLog);
      try { require('fs').unlinkSync(req.file.path); } catch(e) {}
      return res.status(400).json({ error: '表头缺少必要列（层次/物料代码）' });
    }

    const items = [];
    const validationErrors = [];
    const validationWarnings = [];
    let rowNum = bomHeaderIdx + 1;

    for (let i = bomHeaderIdx + 1; i < data.length; i++) {
      rowNum++;
      const row = data[i];
      if (!row || !row[colMap.level]) continue;
      const levelStr = String(row[colMap.level]).trim();
      if (!levelStr.match(/^\.+/)) continue;

      const level = levelStr.match(/^\.+/)[0].length;
      const code = colMap.code !== undefined ? String(row[colMap.code] || '').trim() : '';
      const name = colMap.name !== undefined ? String(row[colMap.name] || '').trim() : '';
      const isFeeRow = code === '费用' || code.includes('加工费');

      const item = {
        row_num: rowNum,
        level,
        code,
        name,
        spec: colMap.spec !== undefined ? String(row[colMap.spec] || '').trim() : '',
        unit: colMap.unit !== undefined ? String(row[colMap.unit] || '').trim() : '',
        quantity: colMap.quantity !== undefined ? (Number(row[colMap.quantity]) || 0) : 0,
        material_type: colMap.material_type !== undefined ? String(row[colMap.material_type] || '').trim() : '',
        processing_fee: colMap.processing_fee !== undefined ? (Number(row[colMap.processing_fee]) || 0) : 0,
        unit_price: colMap.unit_price !== undefined ? (Number(row[colMap.unit_price]) || 0) : 0,
        amount: colMap.amount !== undefined ? (Number(row[colMap.amount]) || 0) : 0,
        remarks: colMap.remarks !== undefined ? String(row[colMap.remarks] || '').trim() : '',
        is_fee_row: isFeeRow
      };

      if (item.processing_fee < 0) {
        validationErrors.push(`第${rowNum}行: 加工费为负数(${item.processing_fee})`);
      }
      if (item.quantity < 0) {
        validationErrors.push(`第${rowNum}行: 数量为负数(${item.quantity})`);
      }
      if (item.unit_price < 0) {
        validationWarnings.push(`第${rowNum}行: 单价为负数(${item.unit_price})`);
      }
      if (item.amount > 0 && item.quantity > 0 && item.unit_price > 0) {
        const expectedAmount = item.quantity * item.unit_price;
        if (Math.abs(item.amount - expectedAmount) > 0.01) {
          validationWarnings.push(`第${rowNum}行: 金额(${item.amount})与数量×单价(${expectedAmount.toFixed(4)})不一致`);
        }
      }

      if (!isFeeRow && !code) {
        validationWarnings.push(`第${rowNum}行: 物料代码为空`);
      }

      items.push(item);
    }

    importLog.total_rows = items.length;
    if (items.length === 0) {
      importLog.status = 'failed';
      importLog.errors.push('未解析到有效的BOM数据');
      saveImportLog(importLog);
      try { require('fs').unlinkSync(req.file.path); } catch(e) {}
      return res.status(400).json({ error: '未解析到有效的BOM数据' });
    }

    const prevLevel = 0;
    let maxLevel = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.level > maxLevel) maxLevel = item.level;
      if (i === 0 && item.level !== 1) {
        validationWarnings.push(`第${item.row_num}行: 首行层级应为1，实际为${item.level}`);
      }
      if (i > 0) {
        const prevItem = items[i - 1];
        if (item.level > prevItem.level + 1) {
          validationErrors.push(`第${item.row_num}行: 层级跳跃，从${prevItem.level}跳到${item.level}（应为${prevItem.level + 1}或更小）`);
        }
      }
    }
    importLog.max_level = maxLevel;

    if (validationErrors.length > 0) {
      importLog.status = 'failed';
      importLog.errors = validationErrors;
      importLog.warnings = validationWarnings;
      saveImportLog(importLog);
      try { require('fs').unlinkSync(req.file.path); } catch(e) {}
      return res.status(400).json({
        error: '数据验证失败',
        validation_errors: validationErrors,
        validation_warnings: validationWarnings
      });
    }

    const bomTable = getTable('product_bom');
    bomTable._invalidate();
    const existing = bomTable.all().filter(r => r.product_id === productId);
    existing.forEach(r => bomTable.delete(r.id));

    const parentStack = [];
    let count = 0;
    let processingFeeTotal = 0;
    let quantityTotal = 0;
    let amountTotal = 0;
    let hierarchyNodes = 0;

    items.forEach((item, idx) => {
      while (parentStack.length >= item.level) parentStack.pop();
      const parentId = parentStack.length > 0 ? parentStack[parentStack.length - 1] : null;
      if (parentId) hierarchyNodes++;

      const result = bomTable.insert({
        product_id: productId,
        parent_id: parentId,
        level: item.level,
        code: item.code,
        name: item.name,
        spec: item.spec,
        unit: item.unit,
        quantity: item.quantity,
        material_type: item.material_type,
        material_category: item.material_category || '',
        processing_fee: item.processing_fee,
        unit_price: item.unit_price,
        amount: item.amount,
        is_fee_row: item.is_fee_row ? 1 : 0,
        remarks: item.remarks,
        sort: idx + 1,
        created_at: now(),
        updated_at: now()
      });
      const record = bomTable.findById(result.lastID);
      parentStack.push(record.id);
      count++;

      processingFeeTotal += item.processing_fee;
      quantityTotal += item.quantity;
      amountTotal += item.amount;
    });

    importLog.imported_count = count;
    importLog.hierarchy_nodes = hierarchyNodes;
    importLog.processing_fee_total = Number(processingFeeTotal.toFixed(4));
    importLog.quantity_total = Number(quantityTotal.toFixed(4));
    importLog.amount_total = Number(amountTotal.toFixed(4));
    importLog.warnings = validationWarnings;
    importLog.status = 'success';
    importLog.summary = `导入成功：共${count}条，最大层级${maxLevel}级，父子关系${hierarchyNodes}个，加工费合计¥${processingFeeTotal.toFixed(2)}，金额合计¥${amountTotal.toFixed(2)}`;

    const fs = require('fs');
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    const matTable = getTable('materials');
    matTable._invalidate();
    const existingMats = matTable.all();
    const codeMap = {};
    existingMats.forEach(m => { codeMap[m.material_code] = m; });

    const ruleTable = getTable('classification_rules');
    ruleTable._invalidate();
    const rules = ruleTable.all().filter(r => r.enabled !== 0).sort((a, b) => (a.priority || 999) - (b.priority || 999));

    function classifyByRules(matData) {
      for (const rule of rules) {
        const val = String(matData[rule.field] || '');
        let match = false;
        if (rule.operator === 'equals') match = val === rule.value;
        else if (rule.operator === 'contains') match = val.includes(rule.value);
        else if (rule.operator === 'startsWith') match = val.startsWith(rule.value);
        else if (rule.operator === 'endsWith') match = val.endsWith(rule.value);
        if (match) return rule.result_category;
      }
      return '';
    }

    function smartClassify(materialType, usageCount, matData) {
      const ruleResult = classifyByRules(matData);
      if (ruleResult) return ruleResult;
      if (materialType === '委外加工' || materialType === '自制') return '定制物料';
      if (materialType === '外购') {
        if (usageCount >= 3) return '常用物料';
        return '专用物料';
      }
      return '通用物料';
    }

    let matAdded = 0, matUpdated = 0;
    items.forEach(item => {
      if (!item.code || item.is_fee_row) return;
      if (codeMap[item.code]) {
        const mat = codeMap[item.code];
        const currentProducts = (mat.used_in_products || '').split(',').filter(Boolean);
        if (!currentProducts.includes(product.external_model) && product.external_model) {
          currentProducts.push(product.external_model);
          const newUsageCount = currentProducts.length;
          const newClassification = smartClassify(item.material_type || mat.material_type, newUsageCount, { material_name: item.name, material_code: item.code, classification: mat.classification });
          const updateFields = {
            used_in_products: currentProducts.join(','),
            bom_usage_count: newUsageCount,
            classification: newClassification,
            updated_at: now()
          };
          if (item.processing_fee > 0) updateFields.processing_cost = item.processing_fee;
          matTable.update(mat.id, updateFields);
          matUpdated++;
        } else if (item.processing_fee > 0 && (!mat.processing_cost || mat.processing_cost === 0)) {
          matTable.update(mat.id, { processing_cost: item.processing_fee, updated_at: now() });
          matUpdated++;
        }
      } else {
        const matData = { material_name: item.name, material_code: item.code, classification: '' };
        const classification = smartClassify(item.material_type, product.external_model ? 1 : 0, matData);
        const result = matTable.insert({
          product_id: productId,
          material_name: item.name || '',
          material_code: item.code,
          category: item.material_type || '',
          specs: item.spec || '',
          material_type: item.material_type || '',
          unit: item.unit || '',
          standard_cost: Number(item.unit_price) || 0,
          processing_cost: Number(item.processing_fee) || 0,
          processing_loss: 0,
          supplier: '',
          status: 'normal',
          unit_price: Number(item.unit_price) || 0,
          quantity: Number(item.quantity) || 0,
          classification,
          inventory_qty: 0,
          min_inventory: 0,
          monthly_usage: 0,
          bom_usage_count: product.external_model ? 1 : 0,
          used_in_products: product.external_model || '',
          certificate_required: '',
          remarks: item.remarks || '',
          created_at: now(),
          updated_at: now()
        });
        codeMap[item.code] = matTable.findById(result.lastID);
        matAdded++;
      }
    });

    importLog.mat_added = matAdded;
    importLog.mat_updated = matUpdated;
    saveImportLog(importLog);

    res.json({
      message: 'BOM导入成功',
      count,
      matAdded,
      matUpdated,
      totals: {
        quantity: Number(quantityTotal.toFixed(4)),
        amount: Number(amountTotal.toFixed(4)),
        processing_fee: Number(processingFeeTotal.toFixed(4)),
        max_level: maxLevel,
        hierarchy_nodes: hierarchyNodes
      },
      validation: {
        errors: validationErrors,
        warnings: validationWarnings
      },
      column_mapping: colMap
    });
  } catch (e) {
    importLog.status = 'failed';
    importLog.errors.push('解析Excel失败: ' + e.message);
    saveImportLog(importLog);
    try { require('fs').unlinkSync(req.file.path); } catch(e2) {}
    res.status(500).json({ error: '解析Excel失败: ' + e.message });
  }
});

function saveImportLog(logData) {
  const logTable = getTable('bom_import_logs');
  logTable.insert({
    ...logData,
    created_at: now()
  });
}

// 查询BOM导入日志
router.get('/bom-import-logs', requirePerm('product:view'), (req, res) => {
  const { product_id, page = 1, limit = 20 } = req.query;
  const logTable = getTable('bom_import_logs');
  logTable._invalidate();
  let records = logTable.all();
  if (product_id) records = records.filter(r => r.product_id === Number(product_id));
  records.sort((a, b) => (b.import_time || '').localeCompare(a.import_time || ''));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

// 智能匹配或创建产品（支持手动输入/复制粘贴的产品信息）
router.post('/match-or-create', requirePerm('product:create'), (req, res) => {
  const { external_model, internal_model, product_name, category, power,
          input_voltage, battery, color_temp, luminous_flux, light_source,
          main_body, lampshade, reflector, cable, switch_type, usb, waterproof, sensor,
          configuration, specs, auto_create } = req.body;

  const inputModel = (external_model || '').trim();
  const inputName = (product_name || '').trim();
  const inputInternal = (internal_model || '').trim();

  if (!inputModel && !inputName && !inputInternal) {
    return res.status(400).json({ error: '请至少提供产品型号或产品名称' });
  }

  const table = getTable('products');
  table._invalidate();
  const all = table.all();

  const candidates = [];
  all.forEach(p => {
    let score = 0;
    const reasons = [];
    if (inputModel && p.external_model) {
      if (p.external_model === inputModel) { score += 100; reasons.push('外部型号完全匹配'); }
      else if (p.external_model.toLowerCase() === inputModel.toLowerCase()) { score += 95; reasons.push('外部型号匹配(忽略大小写)'); }
      else if (p.external_model.includes(inputModel) || inputModel.includes(p.external_model)) { score += 60; reasons.push('外部型号包含匹配'); }
    }
    if (inputInternal && p.internal_model) {
      if (p.internal_model === inputInternal) { score += 80; reasons.push('内部型号完全匹配'); }
      else if (p.internal_model.includes(inputInternal)) { score += 40; reasons.push('内部型号包含匹配'); }
    }
    if (inputName && p.product_name) {
      if (p.product_name === inputName) { score += 70; reasons.push('产品名称完全匹配'); }
      else if (p.product_name.includes(inputName) || inputName.includes(p.product_name)) { score += 45; reasons.push('产品名称包含匹配'); }
    }
    if (category && p.category && p.category === category) { score += 15; reasons.push('分类匹配'); }
    if (power && p.power && String(p.power) === String(power)) { score += 10; reasons.push('功率匹配'); }
    if (score > 0) candidates.push({ product: p, score, reasons });
  });

  candidates.sort((a, b) => b.score - a.score);
  const bestMatch = candidates.length > 0 && candidates[0].score >= 60 ? candidates[0] : null;

  if (bestMatch) {
    const updateFields = { updated_at: now() };
    if (inputName && !bestMatch.product.product_name) updateFields.product_name = inputName;
    if (category && !bestMatch.product.category) updateFields.category = category;
    if (power && !bestMatch.product.power) updateFields.power = power;
    if (configuration && !bestMatch.product.configuration) updateFields.configuration = configuration;
    if (specs && !bestMatch.product.specs) updateFields.specs = specs;
    if (Object.keys(updateFields).length > 1) table.update(bestMatch.product.id, updateFields);
    return res.json({
      action: 'matched',
      product: table.findById(bestMatch.product.id),
      score: bestMatch.score,
      reasons: bestMatch.reasons,
      candidates: candidates.slice(0, 5).map(c => ({ id: c.product.id, external_model: c.product.external_model, product_name: c.product.product_name, score: c.score }))
    });
  }

  if (auto_create === false) {
    return res.json({
      action: 'no_match',
      product: null,
      candidates: candidates.slice(0, 5).map(c => ({ id: c.product.id, external_model: c.product.external_model, product_name: c.product.product_name, score: c.score }))
    });
  }

  const result = table.insert({
    external_model: inputModel || `AUTO-${Date.now()}`,
    internal_model: inputInternal || inputModel || '',
    product_name: inputName || '',
    category: category || '',
    power: power || '',
    configuration: configuration || '',
    specs: specs || '',
    input_voltage: input_voltage || '', battery: battery || '',
    color_temp: color_temp || '', luminous_flux: luminous_flux || '',
    light_source: light_source || '', main_body: main_body || '',
    lampshade: lampshade || '', reflector: reflector || '',
    cable: cable || '', switch_type: switch_type || '',
    usb: usb || '', waterproof: waterproof || '', sensor: sensor || '',
    created_at: now(), updated_at: now()
  });
  const created = table.findById(result.lastID);
  res.json({
    action: 'created',
    product: created,
    candidates: candidates.slice(0, 5).map(c => ({ id: c.product.id, external_model: c.product.external_model, product_name: c.product.product_name, score: c.score }))
  });
});

// 解析粘贴的产品信息文本（支持多种分隔格式）
router.post('/parse-product-text', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: '请输入产品信息文本' });

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const result = { external_model: '', internal_model: '', product_name: '', category: '', power: '', configuration: '', specs: '', raw: text };

  const fieldPatterns = [
    { keys: ['外部型号', '型号', '产品型号', 'external_model', 'model'], field: 'external_model' },
    { keys: ['内部型号', 'internal_model'], field: 'internal_model' },
    { keys: ['产品名称', '名称', 'product_name', 'name'], field: 'product_name' },
    { keys: ['分类', '产品分类', 'category'], field: 'category' },
    { keys: ['功率', 'power'], field: 'power' },
    { keys: ['配置', '配置说明', 'configuration'], field: 'configuration' },
    { keys: ['规格', '规格参数', 'specs'], field: 'specs' }
  ];

  lines.forEach(line => {
    const separators = ['：', ':', '=', '：', '\t', '  '];
    for (const sep of separators) {
      const idx = line.indexOf(sep);
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        const val = line.substring(idx + sep.length).trim();
        if (key && val) {
          const matched = fieldPatterns.find(fp => fp.keys.some(k => key.includes(k)));
          if (matched && !result[matched.field]) {
            result[matched.field] = val;
            return;
          }
        }
      }
    }
  });

  if (!result.external_model && !result.product_name && lines.length > 0) {
    const firstLine = lines[0];
    const parts = firstLine.split(/[\s,，\t|]+/).filter(Boolean);
    if (parts.length >= 1) result.external_model = parts[0];
    if (parts.length >= 2) result.product_name = parts.slice(1).join(' ');
  }

  res.json(result);
});

// 删除BOM单项（必须在/:id之前）
router.delete('/bom-item/:id', requirePerm('product:delete'), (req, res) => {
  const bomTable = getTable('product_bom');
  bomTable._invalidate();
  const item = bomTable.findById(req.params.id);
  if (!item) return res.status(404).json({ error: '物料不存在' });

  bomTable.delete(req.params.id);
  bomTable.all().filter(r => r.parent_id === Number(req.params.id)).forEach(child => {
    bomTable.delete(child.id);
  });
  res.json({ message: '删除成功' });
});

router.put('/bom-item/:id', requirePerm('product:edit'), (req, res) => {
  const bomTable = getTable('product_bom');
  bomTable._invalidate();
  const item = bomTable.findById(req.params.id);
  if (!item) return res.status(404).json({ error: '物料不存在' });

  const fields = { updated_at: now() };
  ['code', 'name', 'spec', 'unit', 'material_type', 'material_category', 'remarks'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  ['quantity', 'unit_price', 'amount', 'level'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f] !== null ? Number(req.body[f]) : 0;
  });
  if (req.body.quantity !== undefined || req.body.unit_price !== undefined) {
    const qty = req.body.quantity !== undefined ? Number(req.body.quantity) : item.quantity;
    const price = req.body.unit_price !== undefined ? Number(req.body.unit_price) : Number(item.unit_price);
    fields.amount = qty * price;
  }
  bomTable.update(req.params.id, fields);
  res.json({ message: '更新成功', data: bomTable.findById(req.params.id) });
});

router.get('/bom/search', requirePerm('product:view'), (req, res) => {
  const { keyword, code, name, spec, supplier, material_type, material_category, product_id, page = 1, limit = 50 } = req.query;
  const bomTable = getTable('product_bom');
  const prodTable = getTable('products');
  bomTable._invalidate();
  prodTable._invalidate();

  let items = bomTable.all();
  if (product_id) items = items.filter(r => r.product_id === Number(product_id));
  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter(r => [r.code, r.name, r.spec, r.material_type, r.material_category].join(' ').toLowerCase().includes(kw));
  }
  if (code) items = items.filter(r => (r.code || '').toLowerCase().includes(code.toLowerCase()));
  if (name) items = items.filter(r => (r.name || '').toLowerCase().includes(name.toLowerCase()));
  if (spec) items = items.filter(r => (r.spec || '').toLowerCase().includes(spec.toLowerCase()));
  if (material_type) items = items.filter(r => r.material_type === material_type);
  if (material_category) items = items.filter(r => (r.material_category || '') === material_category);

  items.sort((a, b) => (a.product_id - b.product_id) || ((a.sort || 0) - (b.sort || 0)));

  const products = prodTable.all();
  const prodMap = {};
  products.forEach(p => { prodMap[p.id] = p; });

  const total = items.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  const paged = items.slice(start, start + parseInt(limit));

  const result = paged.map(item => ({
    ...item,
    product_model: prodMap[item.product_id] ? prodMap[item.product_id].external_model : '',
    product_category: prodMap[item.product_id] ? prodMap[item.product_id].category : ''
  }));

  res.json({ data: result, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/bom/filter-presets', requirePerm('product:view'), (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const presetPath = path.join(__dirname, '..', 'data', 'bom_filter_presets.json');
    if (fs.existsSync(presetPath)) {
      const presets = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
      return res.json(presets);
    }
    res.json([]);
  } catch (e) { res.json([]); }
});

router.post('/bom/filter-presets', requirePerm('product:create'), (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const presetPath = path.join(dir, 'bom_filter_presets.json');
    let presets = [];
    if (fs.existsSync(presetPath)) presets = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    const newPreset = {
      id: Date.now(),
      name: req.body.name || '未命名',
      filters: req.body.filters || {},
      created_at: now()
    };
    presets.push(newPreset);
    fs.writeFileSync(presetPath, JSON.stringify(presets, null, 2), 'utf8');
    res.json(newPreset);
  } catch (e) { res.status(500).json({ error: '保存失败' }); }
});

router.delete('/bom/filter-presets/:id', requirePerm('product:delete'), (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const presetPath = path.join(__dirname, '..', 'data', 'bom_filter_presets.json');
    if (!fs.existsSync(presetPath)) return res.json({ message: '删除成功' });
    let presets = JSON.parse(fs.readFileSync(presetPath, 'utf8'));
    presets = presets.filter(p => p.id !== Number(req.params.id));
    fs.writeFileSync(presetPath, JSON.stringify(presets, null, 2), 'utf8');
    res.json({ message: '删除成功' });
  } catch (e) { res.status(500).json({ error: '删除失败' }); }
});

router.get('/bom/export', requirePerm('product:view'), (req, res) => {
  const { product_id, format } = req.query;
  const bomTable = getTable('product_bom');
  const prodTable = getTable('products');
  bomTable._invalidate();
  prodTable._invalidate();

  let items = bomTable.all();
  if (product_id) items = items.filter(r => r.product_id === Number(product_id));
  items.sort((a, b) => (a.product_id - b.product_id) || ((a.sort || 0) - (b.sort || 0)));

  const products = prodTable.all();
  const prodMap = {};
  products.forEach(p => { prodMap[p.id] = p; });

  if (format === 'excel' || !format) {
    const XLSX = require('xlsx');
    const rows = items.map(item => ({
      '产品型号': prodMap[item.product_id] ? prodMap[item.product_id].external_model : '',
      '层级': item.level,
      '物料代码': item.code || '',
      '物料名称': item.name || '',
      '规格型号': item.spec || '',
      '单位': item.unit || '',
      '数量': item.quantity || 0,
      '物料属性': item.material_type || '',
      '物料分类': item.material_category || '',
      '单价': Number(item.unit_price) || 0,
      '金额': Number(item.amount) || 0,
      '备注': item.remarks || ''
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 18 }, { wch: 6 }, { wch: 22 }, { wch: 30 }, { wch: 20 }, { wch: 6 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws, 'BOM');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=bom_export.xlsx');
    res.send(buf);
  } else {
    const headers = ['产品型号', '层级', '物料代码', '物料名称', '规格型号', '单位', '数量', '物料属性', '物料分类', '单价', '金额', '备注'];
    let csv = headers.join(',') + '\n';
    items.forEach(item => {
      const row = [
        prodMap[item.product_id] ? prodMap[item.product_id].external_model : '',
        item.level, item.code || '', item.name || '', item.spec || '',
        item.unit || '', item.quantity || 0, item.material_type || '',
        item.material_category || '', Number(item.unit_price) || 0,
        Number(item.amount) || 0, item.remarks || ''
      ].map(v => String(v).replace(/,/g, '，'));
      csv += row.join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=bom_export.csv');
    res.send('\uFEFF' + csv);
  }
});

// 订单汇总查询（必须在 /:id 之前定义，避免被动态路由拦截）
router.get('/bom-order-summary', requirePerm('product:view'), (req, res) => {
  const { batch_file, page = 1, limit = 50 } = req.query;
  const table = getTable('bom_order_summary');
  table._invalidate();
  let records = table.all();
  if (batch_file) records = records.filter(r => r.batch_file === batch_file);
  records.sort((a, b) => (b.import_time || '').localeCompare(a.import_time || ''));
  const total = records.length;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const data = records.slice(offset, offset + parseInt(limit));
  res.json({ data, total, page: parseInt(page), limit: parseInt(limit) });
});

// 产品详情（含关联核价记录）
router.get('/:id', requirePerm('product:view'), (req, res) => {
  const table = getTable('products');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '产品不存在' });

  // 关联核价记录
  const bomTable = getTable('bom_pricing');
  bomTable._invalidate();
  const pricingRecords = bomTable.all().filter(b => b.model === row.external_model || b.model === row.internal_model);

  res.json({ ...row, pricing_records: pricingRecords });
});

// 创建产品
router.post('/', requirePerm('product:create'), (req, res) => {
  const { external_model, internal_model, category, power, configuration, specs,
          product_name, input_voltage, battery, color_temp, luminous_flux,
          light_source, main_body, press_frame, lampshade, reflector, cable,
          switch_type, usb, waterproof, sensor } = req.body;
  if (!external_model) return res.status(400).json({ error: '产品外部型号为必填项' });

  const table = getTable('products');
  const rules = getSubModelRules();
  
  const existing = table.all().find(p => p.external_model === external_model);
  
  let finalModel = external_model;
  let baseModel = external_model;
  let diffFields = [];
  
  if (existing) {
    const eq = (a, b) => (a || '') === (b || '');
    const compareFields = rules.compareFields.length > 0 ? rules.compareFields : ['category','power','configuration','specs','input_voltage','battery','color_temp','luminous_flux','light_source','main_body','press_frame','lampshade','reflector','cable','switch_type','usb','waterproof','sensor'];
    const allParamsMatch = compareFields.every(f => eq(existing[f], req.body[f]));
    
    if (allParamsMatch) {
      return res.status(400).json({ error: '该型号及参数已存在，无需重复创建' });
    }
    
    diffFields = compareFields.filter(f => !eq(existing[f], req.body[f]));
    
    const sep = rules.separator;
    const digits = rules.digits;
    const allWithBaseModel = table.all().filter(p => {
      if (p.external_model === external_model) return true;
      return p.external_model.startsWith(external_model + sep);
    });
    
    const maxSeq = allWithBaseModel.reduce((max, p) => {
      if (p.external_model === external_model) return max;
      const match = p.external_model.match(new RegExp(`^${external_model}${escapeRegex(sep)}(\\d+)$`));
      if (match) {
        const seq = parseInt(match[1]);
        return seq > max ? seq : max;
      }
      return max;
    }, 0);
    
    const newSeq = String(maxSeq + 1).padStart(digits, '0');
    finalModel = `${external_model}${sep}${newSeq}`;
  }

  const result = table.insert({
    external_model: finalModel, internal_model: internal_model || baseModel, category: category || '',
    power: power || '', configuration: configuration || '', specs: specs || '',
    product_name: product_name || '',
    base_model: baseModel,
    input_voltage: input_voltage || '', battery: battery || '',
    color_temp: color_temp || '', luminous_flux: luminous_flux || '',
    light_source: light_source || '', main_body: main_body || '',
    press_frame: press_frame || '', lampshade: lampshade || '',
    reflector: reflector || '', cable: cable || '',
    switch_type: switch_type || '', usb: usb || '',
    waterproof: waterproof || '', sensor: sensor || '',
    created_at: now(), updated_at: now()
  });
  const created = table.findById(result.lastID);
  
  const message = finalModel === external_model ? '产品创建成功' : `产品创建成功，参数差异[${diffFields.join(', ')}]，型号已自动调整为 ${finalModel}`;
  res.json({ message, data: created, auto_adjusted: finalModel !== external_model, diff_fields: diffFields, base_model: baseModel });
});

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 更新产品
router.put('/:id', requirePerm('product:edit'), (req, res) => {
  const table = getTable('products');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '产品不存在' });

  const fields = { updated_at: now() };
  ['external_model', 'internal_model', 'category', 'power', 'configuration', 'specs',
   'product_name', 'input_voltage', 'battery', 'color_temp', 'luminous_flux',
   'light_source', 'main_body', 'press_frame', 'lampshade', 'reflector', 'cable',
   'switch_type', 'usb', 'waterproof', 'sensor', 'cost_price', 'price_rmb', 'price_usd'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  res.json({ message: '产品更新成功' });
});

// 删除产品
router.delete('/:id', requirePerm('product:delete'), (req, res) => {
  const table = getTable('products');
  const result = table.delete(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '产品不存在' });
  res.json({ message: '产品删除成功' });
});

// 按型号搜索产品
router.get('/search/:model', (req, res) => {
  const table = getTable('products');
  const model = req.params.model;
  const { records } = table.findWhere(r => (r.external_model || '').includes(model) || (r.internal_model || '').includes(model));
  res.json(records);
});

// 获取同基础型号的子型号列表
router.get('/sub-models/:baseModel', requirePerm('product:view'), (req, res) => {
  const table = getTable('products');
  table._invalidate();
  const rules = getSubModelRules();
  const baseModel = req.params.baseModel;
  const sep = rules.separator;
  
  const all = table.all();
  const base = all.find(p => p.external_model === baseModel);
  const subs = all.filter(p => {
    if (p.external_model === baseModel) return false;
    return p.external_model.startsWith(baseModel + sep);
  }).sort((a, b) => a.external_model.localeCompare(b.external_model));
  
  const compareFields = rules.compareFields;
  const diffMap = {};
  if (base) {
    subs.forEach(sub => {
      const diffs = compareFields.filter(f => (base[f] || '') !== (sub[f] || ''));
      diffMap[sub.external_model] = diffs;
    });
  }
  
  res.json({ base, subs, diff_map: diffMap, rules: { separator: sep, digits: rules.digits, compare_fields: compareFields } });
});

// 预览子型号生成结果
router.post('/preview-sub-model', (req, res) => {
  const table = getTable('products');
  table._invalidate();
  const rules = getSubModelRules();
  const { external_model } = req.body;
  
  const existing = table.all().find(p => p.external_model === external_model);
  if (!existing) {
    return res.json({ will_generate: false, message: '基础型号不存在' });
  }
  
  const sep = rules.separator;
  const digits = rules.digits;
  const allWithBase = table.all().filter(p => {
    if (p.external_model === external_model) return true;
    return p.external_model.startsWith(external_model + sep);
  });
  
  const maxSeq = allWithBase.reduce((max, p) => {
    if (p.external_model === external_model) return max;
    const match = p.external_model.match(new RegExp(`^${external_model}${escapeRegex(sep)}(\\d+)$`));
    if (match) return Math.max(max, parseInt(match[1]));
    return max;
  }, 0);
  
  const newSeq = String(maxSeq + 1).padStart(digits, '0');
  const newModel = `${external_model}${sep}${newSeq}`;
  
  res.json({ will_generate: true, new_model: newModel, base_model: external_model, sub_count: allWithBase.length - 1 });
});

// 获取产品关联的物料
router.get('/:id/materials', requirePerm('product:view'), (req, res) => {
  const prodTable = getTable('products');
  const product = prodTable.findById(req.params.id);
  if (!product) return res.status(404).json({ error: '产品不存在' });

  const matTable = getTable('materials');
  const { records } = matTable.findWhere(r => r.product_id === Number(req.params.id));
  res.json(records);
});

// 获取产品核价标准
router.get('/:id/pricing', requirePerm('product:view'), (req, res) => {
  const prodTable = getTable('products');
  const product = prodTable.findById(req.params.id);
  if (!product) return res.status(404).json({ error: '产品不存在' });

  const priceTable = getTable('pricing_standards');
  const pricing = priceTable.all().find(ps => ps.product_id === product.id);
  res.json(pricing || {});
});

// 获取产品BOM
router.get('/:id/bom', requirePerm('product:view'), (req, res) => {
  const prodTable = getTable('products');
  const product = prodTable.findById(req.params.id);
  if (!product) return res.status(404).json({ error: '产品不存在' });

  const bomTable = getTable('product_bom');
  bomTable._invalidate();
  const items = bomTable.all()
    .filter(r => r.product_id === product.id)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0));

  const tree = buildBomTree(items);
  res.json({ product, items, tree });
});

// 保存产品BOM（追加模式）
router.post('/:id/bom', requirePerm('product:create'), (req, res) => {
  const prodTable = getTable('products');
  const product = prodTable.findById(req.params.id);
  if (!product) return res.status(404).json({ error: '产品不存在' });

  const bomTable = getTable('product_bom');
  bomTable._invalidate();

  const { items, replace } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items必须为数组' });

  if (replace) {
    const existing = bomTable.all().filter(r => r.product_id === product.id);
    existing.forEach(r => bomTable.delete(r.id));
  }

  const maxSort = bomTable.all()
    .filter(r => r.product_id === product.id)
    .reduce((max, r) => Math.max(max, r.sort || 0), 0);

  const created = [];
  items.forEach((item, idx) => {
    const result = bomTable.insert({
      product_id: product.id,
      parent_id: item.parent_id || null,
      level: item.level || 1,
      code: item.code || '',
      name: item.name || '',
      spec: item.spec || '',
      unit: item.unit || '',
      quantity: item.quantity || 0,
      material_type: item.material_type || '',
      material_category: item.material_category || '',
      unit_price: item.unit_price || 0,
      amount: item.amount || 0,
      sort: maxSort + idx + 1,
      created_at: now(),
      updated_at: now()
    });
    created.push(bomTable.findById(result.lastID));
  });

  res.json({ message: 'BOM保存成功', count: created.length });
});

// 从Excel导入BOM
router.post('/:id/bom/import', requirePerm('product:create'), (req, res) => {
  const prodTable = getTable('products');
  const product = prodTable.findById(req.params.id);
  if (!product) return res.status(404).json({ error: '产品不存在' });

  const bomTable = getTable('product_bom');
  bomTable._invalidate();
  
  const existing = bomTable.all().filter(r => r.product_id === product.id);
  existing.forEach(r => bomTable.delete(r.id));

  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items必须为数组' });

  const created = [];
  const parentStack = [];

  items.forEach((item, idx) => {
    const level = item.level || 1;
    while (parentStack.length >= level) parentStack.pop();
    const parentId = parentStack.length > 0 ? parentStack[parentStack.length - 1] : null;

    const result = bomTable.insert({
      product_id: product.id,
      parent_id: parentId,
      level: level,
      code: item.code || '',
      name: item.name || '',
      spec: item.spec || '',
      unit: item.unit || '',
      quantity: item.quantity || 0,
      material_type: item.material_type || '',
      material_category: item.material_category || '',
      unit_price: item.unit_price || 0,
      amount: item.amount || 0,
      sort: idx + 1,
      created_at: now(),
      updated_at: now()
    });
    const record = bomTable.findById(result.lastID);
    created.push(record);
    parentStack.push(record.id);
  });

  res.json({ message: 'BOM导入成功', count: created.length });
});

function buildBomTree(items) {
  const map = {};
  const roots = [];
  items.forEach(item => { map[item.id] = { ...item, children: [] }; });
  items.forEach(item => {
    if (item.parent_id && map[item.parent_id]) {
      map[item.parent_id].children.push(map[item.id]);
    } else {
      roots.push(map[item.id]);
    }
  });
  return roots;
}

function parseOrderSummarySheet(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
  const headerRow = rows[0] || [];
  const colMap = {};
  headerRow.forEach((cell, idx) => {
    const c = String(cell || '').trim();
    if (c.includes('物料代码') || c.includes('物料编码')) colMap.code = idx;
    else if (c.includes('物料名称') || c.includes('名称')) colMap.name = idx;
    else if (c === '数量') colMap.quantity = idx;
    else if (c.includes('不含税单个成本') && !c.includes('采购')) colMap.unit_cost = idx;
    else if (c === '合计' && colMap.cost_total === undefined) colMap.cost_total = idx;
    else if (c.includes('采购确认价格不含税单个成本')) colMap.purchase_unit_price = idx;
    else if (c.includes('采购确认价格合计')) colMap.purchase_total = idx;
    else if (c.includes('不含税销售单价')) colMap.sales_unit_price = idx;
    else if (c === '合计' && colMap.sales_total === undefined && colMap.cost_total !== undefined) colMap.sales_total = idx;
    else if (c === '毛利' && colMap.gross_profit === undefined) colMap.gross_profit = idx;
    else if (c === '毛利率' && colMap.gross_margin === undefined) colMap.gross_margin = idx;
    else if (c.includes('采购确认价格毛利') && !c.includes('率')) colMap.purchase_gross_profit = idx;
    else if (c.includes('采购确认价格毛利率')) colMap.purchase_gross_margin = idx;
    else if (c.includes('最后毛利')) colMap.final_gross_profit = idx;
  });
  const items = [];
  const errors = [];
  const warnings = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const code = colMap.code !== undefined ? String(row[colMap.code] || '').trim() : '';
    if (!code) continue;
    if (!code.startsWith('3.1')) {
      warnings.push(`订单表第${i + 1}行: 型号"${code}"非3.1前缀，已跳过`);
      continue;
    }
    const quantity = colMap.quantity !== undefined ? (Number(row[colMap.quantity]) || 0) : 0;
    const unitCost = colMap.unit_cost !== undefined ? (Number(row[colMap.unit_cost]) || 0) : 0;
    if (quantity <= 0) {
      errors.push(`订单表第${i + 1}行: 型号"${code}"数量无效(${quantity})`);
    }
    if (unitCost < 0) {
      errors.push(`订单表第${i + 1}行: 型号"${code}"不含税成本为负数(${unitCost})`);
    }
    items.push({
      row_num: i + 1,
      product_model: code,
      product_name: colMap.name !== undefined ? String(row[colMap.name] || '').trim() : '',
      quantity,
      unit_cost: unitCost,
      cost_total: colMap.cost_total !== undefined ? (Number(row[colMap.cost_total]) || 0) : 0,
      purchase_unit_price: colMap.purchase_unit_price !== undefined ? (Number(row[colMap.purchase_unit_price]) || 0) : 0,
      purchase_total: colMap.purchase_total !== undefined ? (Number(row[colMap.purchase_total]) || 0) : 0,
      sales_unit_price: colMap.sales_unit_price !== undefined ? (Number(row[colMap.sales_unit_price]) || 0) : 0,
      sales_total: colMap.sales_total !== undefined ? (Number(row[colMap.sales_total]) || 0) : 0,
      gross_profit: colMap.gross_profit !== undefined ? (Number(row[colMap.gross_profit]) || 0) : 0,
      gross_margin: colMap.gross_margin !== undefined ? (Number(row[colMap.gross_margin]) || 0) : 0,
      purchase_gross_profit: colMap.purchase_gross_profit !== undefined ? (Number(row[colMap.purchase_gross_profit]) || 0) : 0,
      purchase_gross_margin: colMap.purchase_gross_margin !== undefined ? (Number(row[colMap.purchase_gross_margin]) || 0) : 0,
      final_gross_profit: colMap.final_gross_profit !== undefined ? (Number(row[colMap.final_gross_profit]) || 0) : 0
    });
  }
  return { items, errors, warnings, colMap };
}

function parseBomSheet(ws, sheetName) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
  const bomHeaderIdx = rows.findIndex(row => row && row.some(c => String(c).includes('层次') || String(c).includes('层级')));
  if (bomHeaderIdx === -1) {
    return { items: [], errors: [`BOM表"${sheetName}"未找到层次表头`], warnings: [], productInfo: null };
  }
  const headerRow = rows[bomHeaderIdx];
  const colMap = {};
  headerRow.forEach((cell, idx) => {
    const c = String(cell || '').trim();
    if (c.includes('层次') || c.includes('层级')) colMap.level = idx;
    else if (c.includes('物料代码') || c.includes('物料编码')) colMap.code = idx;
    else if (c.includes('物料名称') || c.includes('名称')) colMap.name = idx;
    else if (c.includes('规格') || c.includes('型号')) colMap.spec = idx;
    else if (c === '单位') colMap.unit = idx;
    else if (c.includes('数量')) colMap.quantity = idx;
    else if (c.includes('物料属性') || c.includes('属性')) colMap.material_type = idx;
    else if (c.includes('委外加工费') || c.includes('加工费')) colMap.processing_fee = idx;
    else if (c.includes('直接材料')) colMap.unit_price = idx;
    else if (c.includes('备注')) colMap.remarks = idx;
  });

  let productInfo = null;
  if (bomHeaderIdx >= 2) {
    const infoRow = rows[1] || [];
    productInfo = {
      code: String(infoRow[0] || sheetName).trim(),
      name: String(infoRow[1] || '').trim(),
      spec: String(infoRow[2] || '').trim(),
      unit_price: Number(infoRow[7]) || 0
    };
  }

  const items = [];
  const errors = [];
  const warnings = [];
  let rowNum = bomHeaderIdx + 1;
  for (let i = bomHeaderIdx + 1; i < rows.length; i++) {
    rowNum++;
    const row = rows[i];
    if (!row || colMap.level === undefined || !row[colMap.level]) continue;
    const levelStr = String(row[colMap.level]).trim();
    if (!levelStr.match(/^\.+/)) continue;
    const level = levelStr.match(/^\.+/)[0].length;
    const code = colMap.code !== undefined ? String(row[colMap.code] || '').trim() : '';
    const name = colMap.name !== undefined ? String(row[colMap.name] || '').trim() : '';
    const isFeeRow = code === '费用' || code.includes('加工费');
    const item = {
      row_num: rowNum,
      level,
      code,
      name,
      spec: colMap.spec !== undefined ? String(row[colMap.spec] || '').trim() : '',
      unit: colMap.unit !== undefined ? String(row[colMap.unit] || '').trim() : '',
      quantity: colMap.quantity !== undefined ? (Number(row[colMap.quantity]) || 0) : 0,
      material_type: colMap.material_type !== undefined ? String(row[colMap.material_type] || '').trim() : '',
      processing_fee: colMap.processing_fee !== undefined ? (Number(row[colMap.processing_fee]) || 0) : 0,
      unit_price: colMap.unit_price !== undefined ? (Number(row[colMap.unit_price]) || 0) : 0,
      amount: 0,
      remarks: colMap.remarks !== undefined ? String(row[colMap.remarks] || '').trim() : '',
      is_fee_row: isFeeRow
    };
    item.amount = Number((item.quantity * item.unit_price).toFixed(4));
    if (item.processing_fee < 0) errors.push(`BOM表"${sheetName}"第${rowNum}行: 加工费为负数(${item.processing_fee})`);
    if (item.quantity < 0) errors.push(`BOM表"${sheetName}"第${rowNum}行: 数量为负数(${item.quantity})`);
    if (!isFeeRow && !code) warnings.push(`BOM表"${sheetName}"第${rowNum}行: 物料代码为空`);
    items.push(item);
  }

  let maxLevel = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.level > maxLevel) maxLevel = item.level;
    if (i > 0) {
      const prevItem = items[i - 1];
      if (item.level > prevItem.level + 1) {
        errors.push(`BOM表"${sheetName}"第${item.row_num}行: 层级跳跃，从${prevItem.level}跳到${item.level}`);
      }
    }
  }
  return { items, errors, warnings, colMap, productInfo, maxLevel };
}

router.post('/import-multi-sheet', upload.single('file'), requirePerm('product:create'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  const report = {
    file_name: req.file.originalname || req.file.filename || '',
    import_time: now(),
    status: 'processing',
    order_summary: { total: 0, imported: 0, failed: 0, errors: [], warnings: [] },
    bom_sheets: [],
    totals: { products_created: 0, products_matched: 0, bom_items_imported: 0, bom_failed: 0, materials_added: 0, materials_updated: 0, materials_name_matched: 0 }
  };

  try {
    const wb = XLSX.readFile(req.file.path);
    const sheetNames = wb.SheetNames;
    if (sheetNames.length === 0) {
      report.status = 'failed';
      report.order_summary.errors.push('工作簿无任何工作表');
      saveImportLog({ product_id: 0, product_model: '(分表导入)', file_name: report.file_name, import_time: report.import_time, status: 'failed', errors: ['工作簿无任何工作表'], summary: '分表导入失败：无工作表' });
      try { require('fs').unlinkSync(req.file.path); } catch (e) {}
      return res.status(400).json({ error: '工作簿无任何工作表' });
    }

    const orderWs = wb.Sheets[sheetNames[0]];
    const orderResult = parseOrderSummarySheet(orderWs);
    report.order_summary.total = orderResult.items.length;
    report.order_summary.warnings = orderResult.warnings;

    if (orderResult.errors.length > 0) {
      report.order_summary.errors = orderResult.errors;
      report.order_summary.failed = orderResult.items.length;
    } else {
      const orderTable = getTable('bom_order_summary');
      orderTable._invalidate();
      const existing = orderTable.all().filter(r => r.batch_file === report.file_name);
      existing.forEach(r => orderTable.delete(r.id));
      orderResult.items.forEach(item => {
        orderTable.insert({
          ...item,
          batch_file: report.file_name,
          import_time: report.import_time,
          created_at: now(),
          updated_at: now()
        });
        report.order_summary.imported++;
      });
    }

    const bomSheetNames = sheetNames.slice(1).filter(n => String(n).startsWith('3.1'));
    const skippedSheets = sheetNames.slice(1).filter(n => !String(n).startsWith('3.1'));

    const prodTable = getTable('products');
    const bomTable = getTable('product_bom');
    const matTable = getTable('materials');
    const ruleTable = getTable('classification_rules');
    ruleTable._invalidate();
    const rules = ruleTable.all().filter(r => r.enabled !== 0).sort((a, b) => (a.priority || 999) - (b.priority || 999));

    function classifyByRules(matData) {
      for (const rule of rules) {
        const val = String(matData[rule.field] || '');
        let match = false;
        if (rule.operator === 'equals') match = val === rule.value;
        else if (rule.operator === 'contains') match = val.includes(rule.value);
        else if (rule.operator === 'startsWith') match = val.startsWith(rule.value);
        else if (rule.operator === 'endsWith') match = val.endsWith(rule.value);
        if (match) return rule.result_category;
      }
      return '';
    }
    function smartClassify(materialType, usageCount, matData) {
      const ruleResult = classifyByRules(matData);
      if (ruleResult) return ruleResult;
      if (materialType === '委外加工' || materialType === '自制') return '定制物料';
      if (materialType === '外购') return usageCount >= 3 ? '常用物料' : '专用物料';
      return '通用物料';
    }

    // ===== 名称大致对应工具（BOM导入时按名称匹配已有物料，避免重复）=====
    function normalizeName(s) {
      return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[（）、,，;；:：.。\-_()/\\""'']/g, '');
    }
    function levenshtein(a, b) {
      const m = a.length, n = b.length;
      if (!m) return n; if (!n) return m;
      let prev = Array.from({ length: n + 1 }, (_, j) => j);
      let curr = new Array(n + 1);
      for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
          curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
        }
        const t = prev; prev = curr; curr = t;
      }
      return prev[n];
    }
    function nameSimilarity(a, b) {
      if (!a || !b) return 0;
      if (a === b) return 1;
      return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
    }
    // 按名称在已有物料中大致对应：归一化精确 → 包含关系 → 模糊相似度
    function findMaterialByName(name, nameList) {
      const nn = normalizeName(name);
      if (!nn) return null;
      const exact = nameList.find(x => x.nn === nn);
      if (exact) return { mat: exact.mat, method: 'name_exact' };
      const contain = nameList.find(x => x.nn.length >= 4 && nn.length >= 4 && (x.nn.includes(nn) || nn.includes(x.nn)) && Math.min(x.nn.length, nn.length) / Math.max(x.nn.length, nn.length) >= 0.6);
      if (contain) return { mat: contain.mat, method: 'name_contains' };
      let best = null, bestScore = 0;
      for (const x of nameList) {
        const s = nameSimilarity(nn, x.nn);
        if (s > bestScore) { bestScore = s; best = x; }
      }
      if (best && bestScore >= 0.85) return { mat: best.mat, method: 'name_fuzzy' };
      return null;
    }

    bomSheetNames.forEach(sheetName => {
      const sheetReport = { sheet_name: sheetName, product_model: sheetName, status: 'processing', total_rows: 0, imported: 0, failed: 0, errors: [], warnings: [], max_level: 0 };
      const ws = wb.Sheets[sheetName];
      const bomResult = parseBomSheet(ws, sheetName);
      sheetReport.total_rows = bomResult.items.length;
      sheetReport.warnings = bomResult.warnings;
      sheetReport.max_level = bomResult.maxLevel || 0;

      if (bomResult.errors.length > 0) {
        sheetReport.status = 'failed';
        sheetReport.errors = bomResult.errors;
        sheetReport.failed = bomResult.items.length;
        report.totals.bom_failed += bomResult.items.length;
        report.bom_sheets.push(sheetReport);
        return;
      }
      if (bomResult.items.length === 0) {
        sheetReport.status = 'failed';
        sheetReport.errors.push('未解析到有效BOM数据');
        report.bom_sheets.push(sheetReport);
        return;
      }

      prodTable._invalidate();
      let product = prodTable.all().find(p => p.external_model === sheetName || p.internal_model === sheetName);
      if (product) {
        report.totals.products_matched++;
      } else {
        const result = prodTable.insert({
          external_model: sheetName,
          internal_model: sheetName,
          category: '',
          product_name: bomResult.productInfo ? bomResult.productInfo.name : '',
          base_model: sheetName,
          specs: bomResult.productInfo ? bomResult.productInfo.spec : '',
          created_at: now(),
          updated_at: now()
        });
        product = prodTable.findById(result.lastID);
        report.totals.products_created++;
      }

      bomTable._invalidate();
      const existingBom = bomTable.all().filter(r => r.product_id === product.id);
      existingBom.forEach(r => bomTable.delete(r.id));

      const parentStack = [];
      let processingFeeTotal = 0, quantityTotal = 0, amountTotal = 0, hierarchyNodes = 0;
      bomResult.items.forEach((item, idx) => {
        while (parentStack.length >= item.level) parentStack.pop();
        const parentId = parentStack.length > 0 ? parentStack[parentStack.length - 1] : null;
        if (parentId) hierarchyNodes++;
        const result = bomTable.insert({
          product_id: product.id,
          parent_id: parentId,
          level: item.level,
          code: item.code,
          name: item.name,
          spec: item.spec,
          unit: item.unit,
          quantity: item.quantity,
          material_type: item.material_type,
          material_category: '',
          processing_fee: item.processing_fee,
          unit_price: item.unit_price,
          amount: item.amount,
          is_fee_row: item.is_fee_row ? 1 : 0,
          remarks: item.remarks,
          sort: idx + 1,
          created_at: now(),
          updated_at: now()
        });
        const record = bomTable.findById(result.lastID);
        parentStack.push(record.id);
        sheetReport.imported++;
        processingFeeTotal += item.processing_fee;
        quantityTotal += item.quantity;
        amountTotal += item.amount;
      });
      report.totals.bom_items_imported += sheetReport.imported;

      matTable._invalidate();
      const codeMap = {};
      const nameList = [];
      matTable.all().forEach(m => {
        if (m.material_code) codeMap[m.material_code] = m;
        if (m.material_name) { const nn = normalizeName(m.material_name); if (nn) nameList.push({ mat: m, nn }); }
      });
      bomResult.items.forEach(item => {
        if (!item.code || item.is_fee_row) return;
        // 先按编码精确匹配，匹配不上再按名称大致对应
        let mat = codeMap[item.code];
        if (!mat && item.name) {
          const nm = findMaterialByName(item.name, nameList);
          if (nm) { mat = nm.mat; report.totals.materials_name_matched++; }
        }
        if (mat) {
          const currentProducts = (mat.used_in_products || '').split(',').filter(Boolean);
          if (!currentProducts.includes(sheetName)) {
            currentProducts.push(sheetName);
            const newClassification = smartClassify(item.material_type || mat.material_type, currentProducts.length, { material_name: item.name, material_code: item.code, classification: mat.classification });
            const updateFields = { used_in_products: currentProducts.join(','), bom_usage_count: currentProducts.length, classification: newClassification, updated_at: now() };
            if (item.processing_fee > 0) updateFields.processing_cost = item.processing_fee;
            matTable.update(mat.id, updateFields);
            codeMap[item.code] = mat;
            report.totals.materials_updated++;
          } else if (item.processing_fee > 0 && (!mat.processing_cost || mat.processing_cost === 0)) {
            matTable.update(mat.id, { processing_cost: item.processing_fee, updated_at: now() });
            codeMap[item.code] = mat;
            report.totals.materials_updated++;
          }
        } else {
          const classification = smartClassify(item.material_type, 1, { material_name: item.name, material_code: item.code });
          const result = matTable.insert({
            product_id: product.id,
            material_name: item.name || '',
            material_code: item.code,
            category: item.material_type || '',
            specs: item.spec || '',
            material_type: item.material_type || '',
            unit: item.unit || '',
            standard_cost: Number(item.unit_price) || 0,
            processing_cost: Number(item.processing_fee) || 0,
            processing_loss: 0,
            supplier: '',
            status: 'normal',
            unit_price: Number(item.unit_price) || 0,
            quantity: Number(item.quantity) || 0,
            classification,
            inventory_qty: 0,
            min_inventory: 0,
            monthly_usage: 0,
            bom_usage_count: 1,
            used_in_products: sheetName,
            certificate_required: '',
            remarks: item.remarks || '',
            created_at: now(),
            updated_at: now()
          });
          const newMat = matTable.findById(result.lastID);
          codeMap[item.code] = newMat;
          const nn = normalizeName(item.name);
          if (nn) nameList.push({ mat: newMat, nn });
          report.totals.materials_added++;
        }
      });

      sheetReport.status = 'success';
      sheetReport.totals = {
        quantity: Number(quantityTotal.toFixed(4)),
        amount: Number(amountTotal.toFixed(4)),
        processing_fee: Number(processingFeeTotal.toFixed(4)),
        hierarchy_nodes: hierarchyNodes
      };
      sheetReport.summary = `导入${sheetReport.imported}条，最大层级${sheetReport.max_level}级，加工费合计¥${processingFeeTotal.toFixed(2)}，金额合计¥${amountTotal.toFixed(2)}`;

      saveImportLog({
        product_id: product.id,
        product_model: sheetName,
        file_name: report.file_name,
        import_time: report.import_time,
        status: 'success',
        total_rows: sheetReport.total_rows,
        imported_count: sheetReport.imported,
        max_level: sheetReport.max_level,
        hierarchy_nodes: hierarchyNodes,
        processing_fee_total: Number(processingFeeTotal.toFixed(4)),
        quantity_total: Number(quantityTotal.toFixed(4)),
        amount_total: Number(amountTotal.toFixed(4)),
        errors: [],
        warnings: sheetReport.warnings,
        summary: sheetReport.summary
      });

      report.bom_sheets.push(sheetReport);
    });

    report.skipped_sheets = skippedSheets;
    const failedBomSheets = report.bom_sheets.filter(s => s.status === 'failed').length;
    report.status = (report.order_summary.failed === 0 && failedBomSheets === 0) ? 'success' : 'partial_success';
    report.summary = `订单汇总导入${report.order_summary.imported}/${report.order_summary.total}条；BOM表${bomSheetNames.length}个(成功${report.bom_sheets.filter(s => s.status === 'success').length}个，失败${failedBomSheets}个)；BOM明细共${report.totals.bom_items_imported}条；新建产品${report.totals.products_created}个，匹配${report.totals.products_matched}个；物料库新增${report.totals.materials_added}条，更新${report.totals.materials_updated}条`;

    saveImportLog({
      product_id: 0,
      product_model: '(分表导入汇总)',
      file_name: report.file_name,
      import_time: report.import_time,
      status: report.status,
      total_rows: report.totals.bom_items_imported,
      imported_count: report.totals.bom_items_imported,
      errors: report.order_summary.errors,
      warnings: report.order_summary.warnings,
      summary: report.summary
    });

    try { require('fs').unlinkSync(req.file.path); } catch (e) {}
    res.json(report);
  } catch (e) {
    report.status = 'failed';
    report.order_summary.errors.push('解析Excel失败: ' + e.message);
    saveImportLog({
      product_id: 0,
      product_model: '(分表导入)',
      file_name: report.file_name,
      import_time: report.import_time,
      status: 'failed',
      errors: ['解析Excel失败: ' + e.message],
      summary: '分表导入失败：' + e.message
    });
    try { require('fs').unlinkSync(req.file.path); } catch (e2) {}
    res.status(500).json({ error: '解析Excel失败: ' + e.message });
  }
});

module.exports = router;
