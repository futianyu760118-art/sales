const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('quote_library');
ensureTable('sync_logs');

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
  return 7.25; // 默认汇率
}

// ===== 报价库列表 =====
router.get('/', requirePerm('quote:view'), (req, res) => {
  const table = getTable('quote_library');
  const records = table.all().sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json(records);
});

// ===== 获取同步日志（必须在 /:id 之前）=====
router.get('/sync-logs', requirePerm('quote:view'), (req, res) => {
  const logTable = getTable('sync_logs');
  if (!logTable) return res.json([]);
  const logs = logTable.all()
    .filter(l => l.sync_type === 'pricing_to_quote')
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 20);
  res.json(logs);
});

// ===== 报价库详情 =====
router.get('/:id', requirePerm('quote:view'), (req, res) => {
  const table = getTable('quote_library');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '报价记录不存在' });
  res.json(row);
});

// ===== 创建报价库记录 =====
router.post('/', requirePerm('quote:manage'), async (req, res) => {
  const { external_model, internal_model, product_name, category, power, 
          configuration, specs, certificate_level, price_rmb, price_usd, 
          unit_price, min_price, validity_days, remarks, creator } = req.body;
  
  if (!external_model) return res.status(400).json({ error: '产品型号为必填项' });
  if (!price_rmb && !price_usd) return res.status(400).json({ error: '单价金额为必填项' });

  // 根据汇率自动换算
  const rate = await getExchangeRate();
  let finalPriceRmb = price_rmb ? Number(price_rmb) : null;
  let finalPriceUsd = price_usd ? Number(price_usd) : null;
  if (finalPriceRmb && !finalPriceUsd) {
    finalPriceUsd = Math.round(finalPriceRmb / rate * 10000) / 10000;
  } else if (finalPriceUsd && !finalPriceRmb) {
    finalPriceRmb = Math.round(finalPriceUsd * rate * 100) / 100;
  }

  const table = getTable('quote_library');
  
  // 检查是否已存在相同型号+证书等级的报价
  const existing = table.all().find(q => 
    q.external_model === external_model && q.certificate_level === certificate_level
  );
  
  if (existing) {
    return res.status(400).json({ 
      error: '该型号+证书等级的报价已存在',
      existing_id: existing.id 
    });
  }

  const result = table.insert({
    external_model: external_model || '',
    internal_model: internal_model || '',
    product_name: product_name || '',
    category: category || '',
    power: power || '',
    configuration: configuration || '',
    specs: specs || '',
    certificate_level: certificate_level || '',
    price_rmb: finalPriceRmb,
    price_usd: finalPriceUsd,
    unit_price: finalPriceRmb,
    min_price: min_price || null,
    validity_days: validity_days || 30,
    remarks: remarks || '',
    creator: creator || '',
    created_at: now(),
    updated_at: now(),
    usage_count: 0
  });
  
  const created = table.findById(result.lastID);
  res.json({ message: '报价库记录创建成功', data: created });
});

// ===== 更新报价库记录 =====
router.put('/:id', requirePerm('quote:manage'), async (req, res) => {
  const table = getTable('quote_library');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '报价记录不存在' });

  const updates = {};
  ['external_model', 'internal_model', 'product_name', 'category', 'power', 
   'configuration', 'specs', 'certificate_level', 'min_price', 
   'validity_days', 'remarks', 'created_at'].forEach(f => {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  });

  // 汇率自动换算
  const rate = await getExchangeRate();
  let priceRmb = req.body.price_rmb !== undefined ? Number(req.body.price_rmb) || null : existing.price_rmb;
  let priceUsd = req.body.price_usd !== undefined ? Number(req.body.price_usd) || null : existing.price_usd;
  // 判断用户修改了哪个字段，自动换算另一个
  if (req.body.price_rmb !== undefined && req.body.price_usd === undefined) {
    priceUsd = priceRmb ? Math.round(priceRmb / rate * 10000) / 10000 : null;
  } else if (req.body.price_usd !== undefined && req.body.price_rmb === undefined) {
    priceRmb = priceUsd ? Math.round(priceUsd * rate * 100) / 100 : null;
  }
  updates.price_rmb = priceRmb;
  updates.price_usd = priceUsd;
  updates.unit_price = priceRmb;
  updates.updated_at = now();

  table.update(req.params.id, updates);
  res.json({ message: '报价库记录更新成功', data: table.findById(req.params.id) });
});

// ===== 删除报价库记录 =====
router.delete('/:id', requirePerm('quote:delete'), (req, res) => {
  const table = getTable('quote_library');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '报价记录不存在' });
  
  table.delete(req.params.id);
  res.json({ message: '报价库记录删除成功' });
});

// ===== 从询价单转入报价库 =====
router.post('/from-inquiry/:inquiry_id', requirePerm('quote:manage'), async (req, res) => {
  const inquiryTable = getTable('inquiries');
  const inquiry = inquiryTable.findById(req.params.inquiry_id);
  
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });
  
  // 检查是否已有报价
  if (!inquiry.final_price && !inquiry.quoted_price) {
    return res.status(400).json({ error: '该询价单尚未有报价金额' });
  }

  const table = getTable('quote_library');
  
  // 检查是否已存在相同型号+证书等级的报价
  const existing = table.all().find(q => 
    q.external_model === inquiry.external_model && 
    q.certificate_level === inquiry.certificate_level
  );
  
  if (existing) {
    return res.status(400).json({ 
      error: '该型号+证书等级的报价已存在',
      existing_id: existing.id,
      message: '可选择更新现有报价或使用不同的证书等级'
    });
  }

  // 获取产品信息
  const prodTable = getTable('products');
  const product = prodTable.all().find(p => 
    p.external_model === inquiry.external_model || p.internal_model === inquiry.external_model
  );

  // 计算单价：final_price是总价，单价=总价/数量
  const quantity = inquiry.quantity || 1;
  const unitPriceRmb = (inquiry.final_price || inquiry.quoted_price) 
    ? Math.round((inquiry.final_price || inquiry.quoted_price) / quantity * 100) / 100 
    : null;

  // 汇率自动换算（保留4位小数以支持小金额）
  const rate = await getExchangeRate();
  const unitPriceUsd = unitPriceRmb ? Math.round(unitPriceRmb / rate * 10000) / 10000 : null;

  const result = table.insert({
    external_model: inquiry.external_model || '',
    internal_model: inquiry.internal_model || '',
    product_name: inquiry.product_name || (product ? product.product_name : '') || '',
    category: inquiry.product_category || (product ? product.category : '') || '',
    power: inquiry.power || '',
    configuration: inquiry.configuration || '',
    specs: inquiry.specs || '',
    certificate_level: inquiry.certificate_level || '',
    price_rmb: unitPriceRmb,
    price_usd: unitPriceUsd,
    unit_price: unitPriceRmb,
    min_price: inquiry.min_price || null,
    validity_days: parseInt(inquiry.quote_validity) || 30,
    remarks: inquiry.remarks || '',
    creator: inquiry.sales_person || '',
    created_at: inquiry.created_at || now(),
    updated_at: now(),
    usage_count: 0,
    source_inquiry_id: req.params.inquiry_id,
    source_inquiry_no: inquiry.serial_number
  });
  
  const created = table.findById(result.lastID);
  
  // 标记询价单已转入报价库
  inquiryTable.update(req.params.inquiry_id, { quote_library_id: result.lastID, updated_at: now() });
  
  res.json({ message: '报价已转入报价库', data: created });
});

// ===== 快速申请报价（从报价库获取）=====
router.post('/apply', requirePerm('quote:manage'), (req, res) => {
  const { inquiry_id, quote_library_id } = req.body;
  
  if (!inquiry_id || !quote_library_id) {
    return res.status(400).json({ error: '询价单ID和报价库ID为必填项' });
  }

  const inquiryTable = getTable('inquiries');
  const inquiry = inquiryTable.findById(inquiry_id);
  
  if (!inquiry) return res.status(404).json({ error: '询价单不存在' });

  const libraryTable = getTable('quote_library');
  const quote = libraryTable.findById(quote_library_id);
  
  if (!quote) return res.status(404).json({ error: '报价库记录不存在' });

  const prodTable = getTable('products');
  const prodInfo = prodTable.all().find(p => p.external_model === quote.external_model || p.internal_model === quote.external_model);

  const updates = {
    quoted_price: quote.price_rmb,
    price_usd: quote.price_usd,
    unit_price: quote.unit_price,
    min_price: quote.min_price,
    final_price: quote.price_rmb,
    base_cost: quote.min_price || 0,
    quote_validity: quote.validity_days + '天',
    status: 'pending_quote',
    updated_at: now()
  };

  if (quote.product_name && !inquiry.product_name) updates.product_name = quote.product_name;
  if (quote.category && !inquiry.product_category) updates.product_category = quote.category;
  if (quote.power && !inquiry.power) updates.power = quote.power;
  if (quote.configuration && !inquiry.configuration) updates.configuration = quote.configuration;
  if (quote.certificate_level && !inquiry.certificate_level) updates.certificate_level = quote.certificate_level;

  if (prodInfo) {
    const paramFields = ['input_voltage', 'battery', 'color_temp', 'luminous_flux',
      'light_source', 'main_body', 'lampshade', 'reflector', 'cable',
      'switch_type', 'usb', 'waterproof', 'sensor'];
    paramFields.forEach(f => {
      if (prodInfo[f] && !inquiry[f]) updates[f] = prodInfo[f];
    });
    if (prodInfo.product_name && !inquiry.product_name) updates.product_name = prodInfo.product_name;
    if (prodInfo.internal_model && !inquiry.internal_model) updates.internal_model = prodInfo.internal_model;
    if (prodInfo.category && !inquiry.product_category) updates.product_category = prodInfo.category;
    if (prodInfo.power && !inquiry.power) updates.power = prodInfo.power;
  }
  
  inquiryTable.update(inquiry_id, updates);
  
  libraryTable.update(quote_library_id, { 
    usage_count: (quote.usage_count || 0) + 1,
    updated_at: now()
  });
  
  res.json({ 
    message: '报价申请成功，已从报价库获取报价和产品参数', 
    data: inquiryTable.findById(inquiry_id),
    quote_source: quote 
  });
});

// ===== 搜索报价库 =====
router.get('/search/:keyword', requirePerm('quote:view'), (req, res) => {
  const keyword = req.params.keyword.toLowerCase();
  const table = getTable('quote_library');
  const records = table.all().filter(r => 
    (r.external_model && r.external_model.toLowerCase().includes(keyword)) ||
    (r.internal_model && r.internal_model.toLowerCase().includes(keyword)) ||
    (r.product_name && r.product_name.toLowerCase().includes(keyword)) ||
    (r.category && r.category.toLowerCase().includes(keyword))
  ).sort((a, b) => b.created_at.localeCompare(a.created_at));
  
  res.json(records);
});

// ===== 获取可用报价（用于下拉选择）=====
router.get('/available/:model', requirePerm('quote:view'), (req, res) => {
  const model = req.params.model;
  const table = getTable('quote_library');
  
  // 精确匹配或基础型号匹配
  const records = table.all().filter(r => 
    r.external_model === model || 
    r.external_model.startsWith(model.split('-')[0] + '-') ||
    r.internal_model === model
  ).sort((a, b) => b.created_at.localeCompare(a.created_at));
  
  res.json(records);
});

// ===== 核价库→报价库 同步 =====
function syncPricingToQuote() {
  const pricingTable = getTable('bom_pricing');
  const quoteTable = getTable('quote_library');
  const logTable = getTable('sync_logs');
  pricingTable._invalidate();
  quoteTable._invalidate();

  const allPricing = pricingTable.all();
  const allQuotes = quoteTable.all();
  let created = 0, updated = 0, skipped = 0;
  const details = [];
  const r2 = v => v != null ? Math.round(parseFloat(v) * 100) / 100 : null;

  allPricing.forEach(pricing => {
    if (!pricing.model) { skipped++; return; }
    if (!pricing.price_rmb && !pricing.price_usd && !pricing.min_price) { skipped++; return; }

    const existing = allQuotes.find(q =>
      q.external_model === pricing.model &&
      (q.certificate_level || '') === (pricing.certificate_level || '')
    );

    if (!existing) {
      const existingByModel = allQuotes.filter(q => q.external_model === pricing.model);
      if (existingByModel.length > 0 && !pricing.certificate_level) {
        existingByModel.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
        const sameEmpty = existingByModel.find(q => !q.certificate_level);
        if (sameEmpty) {
          const needsUp = (pricing.price_rmb && r2(pricing.price_rmb) !== sameEmpty.price_rmb) ||
            (pricing.updated_at && sameEmpty.updated_at && pricing.updated_at > sameEmpty.updated_at);
          if (needsUp) {
            const updates = { updated_at: now() };
            if (pricing.price_rmb) { updates.price_rmb = r2(pricing.price_rmb); updates.unit_price = r2(pricing.price_rmb); }
            if (pricing.price_usd) updates.price_usd = r2(pricing.price_usd);
            if (pricing.min_price) updates.min_price = r2(pricing.min_price);
            if (pricing.product_name) updates.product_name = pricing.product_name;
            if (pricing.product_series) updates.category = pricing.product_series;
            if (pricing.power) updates.power = pricing.power;
            if (pricing.pricer) updates.creator = pricing.pricer;
            if (pricing.remarks) updates.specs = pricing.remarks;
            updates.source_pricing_id = pricing.id;
            updates.source_inquiry_no = pricing.inquiry_no || '';
            quoteTable.update(sameEmpty.id, updates);
            updated++;
            details.push('更新(空证书): ' + pricing.model + ' RMB¥' + (pricing.price_rmb || '-'));
          } else {
            skipped++;
          }
          return;
        }
      }
    }

    const quoteData = {
      external_model: pricing.model,
      internal_model: pricing.model,
      product_name: pricing.product_name || '',
      category: pricing.product_series || '',
      power: pricing.power || '',
      configuration: '',
      specs: pricing.remarks || '',
      certificate_level: pricing.certificate_level || '',
      price_rmb: r2(pricing.price_rmb),
      price_usd: r2(pricing.price_usd),
      unit_price: r2(pricing.price_rmb),
      min_price: r2(pricing.min_price),
      validity_days: 30,
      remarks: pricing.remarks || '',
      creator: pricing.pricer || '',
      updated_at: now(),
      source_pricing_id: pricing.id,
      source_inquiry_no: pricing.inquiry_no || ''
    };

    if (existing) {
      const needsUpdate =
        (pricing.price_rmb && r2(pricing.price_rmb) !== existing.price_rmb) ||
        (pricing.price_usd && r2(pricing.price_usd) !== existing.price_usd) ||
        (pricing.min_price && r2(pricing.min_price) !== existing.min_price) ||
        (pricing.updated_at && existing.updated_at && pricing.updated_at > existing.updated_at);

      if (needsUpdate) {
        const updates = { updated_at: now() };
        if (pricing.price_rmb) { updates.price_rmb = r2(pricing.price_rmb); updates.unit_price = r2(pricing.price_rmb); }
        if (pricing.price_usd) updates.price_usd = r2(pricing.price_usd);
        if (pricing.min_price) updates.min_price = r2(pricing.min_price);
        if (pricing.product_name) updates.product_name = pricing.product_name;
        if (pricing.product_series) updates.category = pricing.product_series;
        if (pricing.power) updates.power = pricing.power;
        if (pricing.certificate_level) updates.certificate_level = pricing.certificate_level;
        if (pricing.pricer) updates.creator = pricing.pricer;
        if (pricing.remarks) updates.specs = pricing.remarks;
        updates.source_pricing_id = pricing.id;
        updates.source_inquiry_no = pricing.inquiry_no || '';
        quoteTable.update(existing.id, updates);
        updated++;
        details.push(`更新: ${pricing.model} RMB¥${pricing.price_rmb || '-'}`);
      } else {
        skipped++;
      }
    } else {
      quoteData.created_at = pricing.created_at || now();
      quoteData.usage_count = 0;
      quoteTable.insert(quoteData);
      created++;
      details.push(`新增: ${pricing.model} RMB¥${pricing.price_rmb || '-'}`);
    }
  });

  const summary = `核价→报价同步完成: 新增${created}条, 更新${updated}条, 跳过${skipped}条`;
  if (logTable) {
    logTable.insert({
      sync_type: 'pricing_to_quote',
      status: 'success',
      summary,
      details: details.join('\n'),
      created_count: created,
      updated_count: updated,
      skipped_count: skipped,
      created_at: now()
    });
  }

  return { created, updated, skipped, summary, details };
}

// 手动触发同步
router.post('/sync-from-pricing', requirePerm('quote:manage'), (req, res) => {
  try {
    const result = syncPricingToQuote();
    res.json({ message: result.summary, ...result });
  } catch(e) {
    const logTable = getTable('sync_logs');
    if (logTable) {
      logTable.insert({
        sync_type: 'pricing_to_quote',
        status: 'error',
        summary: '同步失败: ' + e.message,
        details: e.stack || '',
        created_count: 0, updated_count: 0, skipped_count: 0,
        created_at: now()
      });
    }
    res.status(500).json({ error: '同步失败: ' + e.message });
  }
});

// ===== 去重清理 =====
router.post('/deduplicate', requirePerm('quote:manage'), (req, res) => {
  const table = getTable('quote_library');
  table._invalidate();
  const records = table.all();
  const seen = {};
  const toDelete = [];

  records.forEach(r => {
    const key = r.external_model + '|||' + (r.certificate_level || '');
    if (!seen[key]) {
      seen[key] = r;
    } else {
      const prev = seen[key];
      const prevTime = prev.updated_at || prev.created_at || '';
      const currTime = r.updated_at || r.created_at || '';
      if (currTime > prevTime) {
        toDelete.push(prev.id);
        seen[key] = r;
      } else {
        toDelete.push(r.id);
      }
    }
  });

  toDelete.forEach(id => table.delete(id));

  res.json({
    message: `去重完成，删除${toDelete.length}条重复记录`,
    deleted: toDelete.length,
    remaining: records.length - toDelete.length
  });
});

module.exports = { router, syncPricingToQuote };