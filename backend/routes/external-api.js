/**
 * 外部数据供给 API 对接模块
 * 对接 https://192.168.0.127:18084 的供应商数据
 * 认证方式: HMAC-SHA256
 */
const express = require('express');
const router = express.Router();
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

// ===== 配置 =====
const CONFIG = {
  BASE_URL: 'https://192.168.0.127:18084',
  APP_KEY: 'ak_745e44c96d4f4790',
  APP_SECRET: 'c93b118d21c9403ead9819d3336f7afafcbda6deab9b4738b5c57278396d6336',
};

// HMAC-SHA256 签名
function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

// endpoint_code（签名用，下划线）→ URL 路径（多词接口用连字符）映射
const ENDPOINT_PATH = {
  'bom_details.list': 'bom-details/list',
  'order_details.list': 'order-details/list',
  'purchase_orders.list': 'purchase-orders/list',
  'schedule_plans.list': 'schedule-plans/list',
};
function endpointPath(code) {
  return ENDPOINT_PATH[code] || code.replace('.', '/');
}

// 调用对外业务接口
function callExternalAPI(endpointCode, queryParams = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.entries(queryParams)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => k + '=' + encodeURIComponent(v))
      .join('&');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const stringToSign = timestamp + CONFIG.APP_KEY + endpointCode + qs;
    const signature = sign(CONFIG.APP_SECRET, stringToSign);

    const url = new URL(CONFIG.BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: '/api/v1/external/' + endpointPath(endpointCode) + (qs ? '?' + qs : ''),
      method: 'GET',
      rejectUnauthorized: false,  // 自签证书
      headers: {
        'X-App-Key': CONFIG.APP_KEY,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.code === 0) resolve(json.data || json);
          else reject(new Error((json.message || json.detail || 'API返回错误 code=' + json.code).substring(0, 200)));
        } catch (e) {
          reject(new Error('解析响应失败: ' + body.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// 调用通用数据供给接口
function callDataSupply(dataType, queryParams = {}) {
  return new Promise((resolve, reject) => {
    const qs = Object.entries(queryParams)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => k + '=' + encodeURIComponent(v))
      .join('&');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const stringToSign = timestamp + CONFIG.APP_KEY + dataType + qs;
    const signature = sign(CONFIG.APP_SECRET, stringToSign);

    const url = new URL(CONFIG.BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: '/api/v1/basicdata/data-supply/data/' + dataType + (qs ? '?' + qs : ''),
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        'X-App-Key': CONFIG.APP_KEY,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.code === 0) resolve(json.data || json);
          else reject(new Error((json.message || json.detail || 'API返回错误').substring(0, 200)));
        } catch (e) {
          reject(new Error('解析响应失败: ' + body.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// ===== 批量拉取供应商（分页，最多取2000条） =====
async function fetchAllSuppliers() {
  const allItems = [];
  let page = 1;
  const pageSize = 200;
  let total = null;
  while (page <= 10) {
    try {
      const data = await callExternalAPI('suppliers.list', { page: page, page_size: pageSize });
      const items = data.items || data.data || [];
      if (data.total !== undefined) total = data.total;
      if (items.length === 0) break;
      allItems.push(...items);
      if (items.length < pageSize || (total !== null && allItems.length >= total)) break;
      page++;
    } catch (e) {
      throw new Error('第' + page + '页拉取失败: ' + e.message);
    }
  }
  return allItems;
}

// ===== 同步供应商到本地 =====
router.post('/sync-suppliers', requirePerm('supplier:create'), async (req, res) => {
  const supTable = getTable('suppliers');
  const { apply } = req.body;
  const doApply = apply !== false;
  try {
    const items = await fetchAllSuppliers();
    if (items.length === 0) {
      return res.json({ message: '外部系统无供应商数据', imported: 0, skipped: 0, total: 0 });
    }

    const existingNames = new Set(supTable.all().map(s => s.name));
    let imported = 0, skipped = 0, details = [];

    for (const item of items) {
      const name = (item.supplier_name || item.name || item.company_name || '').trim();
      if (!name) { skipped++; continue; }
      // 外部系统字段映射
      const phone = (item.contact_phone || item.phone || item.tel || '').trim();
      const contact = (item.contact_person || item.contact || item.linkman || '').trim();
      const email = (item.email || '').trim();
      const address = (item.address || '').trim();
      const category = (item.supplier_type || item.type || item.category || item.business_type || '').trim();
      const code = (item.supplier_code || item.code || item.erp_code || '').trim();
      // 外部系统可能返回简体中文或繁体中文字段名
      const altName = (item.\u4f9b\u5e94\u5546\u540d\u79f0 || item.\u4f9b\u5e94\u5546 || '').trim();
      const finalName = name || altName;
      if (!finalName) { skipped++; continue; }

      if (existingNames.has(finalName)) {
        skipped++;
        continue;
      }

      if (doApply) {
        const insertData = {
          name: finalName, code, contact, phone, email, address, category,
          level: (item.level || item.grade || 'C'),
          lifecycle_status: 'reviewing',
          risk_level: 'medium',
          supply_materials: (item.supply_materials || item.products || item.business_scope || '').trim(),
          remarks: '从外部系统同步',
          payment_method: (item.payment_method || '').trim(),
          payment_cycle: (item.payment_cycle || '').trim(),
          tax_id: (item.tax_id || '').trim(),
          status: 'active',
          quality_score: 0, delivery_score: 0, price_score: 0, service_score: 0, overall_score: 0,
          created_at: now(), updated_at: now()
        };
        supTable.insert(insertData);
        existingNames.add(finalName);
      }
      imported++;
      if (details.length < 20) details.push({ name: finalName, code, phone, category });
    }

    res.json({
      message: doApply ? '同步完成：导入' + imported + '家，跳过' + skipped + '家（已存在）' : '预览：可导入' + imported + '家，已存在' + skipped + '家',
      imported, skipped, total_fetched: items.length, applied: doApply, details
    });
  } catch (e) {
    res.status(500).json({ error: '同步失败: ' + e.message });
  }
});

// ===== 测试连接 =====
router.get('/test-connection', requirePerm('supplier:view'), async (req, res) => {
  try {
    const data = await callExternalAPI('suppliers.list', { page: 1, page_size: 1 });
    const count = data.total || data.items ? (data.items || data.data || []).length : 'unknown';
    res.json({ connected: true, message: '连接成功，返回' + count + '条记录', sample: (data.items || data.data || [])[0] || null });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

// ===== 调试：查看外部订单 API 原始字段（排查产品信息是否在别的字段名下）=====
router.get('/debug/orders-raw', requirePerm('order:view'), async (req, res) => {
  try {
    const data = await callExternalAPI('orders.list', { page: 1, page_size: 3 });
    const items = data.items || data.data || [];
    res.json({
      total: data.total || items.length,
      count: items.length,
      raw_first_item: items[0] || null,
      all_field_keys: items[0] ? Object.keys(items[0]) : [],
      field_values_sample: items.slice(0, 3).map(it => {
        const o = {}; Object.keys(it).forEach(k => { o[k] = it[k]; }); return o;
      })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/debug/order-details-raw', requirePerm('order:view'), async (req, res) => {
  try {
    const data = await callExternalAPI('order_details.list', { page: 1, page_size: 3 });
    const items = data.items || data.data || [];
    res.json({
      total: data.total || items.length,
      count: items.length,
      raw_first_item: items[0] || null,
      all_field_keys: items[0] ? Object.keys(items[0]) : [],
      field_values_sample: items.slice(0, 3).map(it => {
        const o = {}; Object.keys(it).forEach(k => { o[k] = it[k]; }); return o;
      })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 同步物料到本地物料库 =====
router.post('/sync-materials', requirePerm('material:create'), async (req, res) => {
  const matTable = getTable('materials');
  const { apply } = req.body;
  const doApply = apply !== false;

  const errors = [];

  // 方式1：对外业务接口 materials.list
  try {
    const items = [];
    let page = 1;
    while (page <= 5) {
      const data = await callExternalAPI('materials.list', { page, page_size: 200 });
      const batch = data.items || data.data || [];
      if (batch.length === 0) break;
      items.push(...batch);
      if (batch.length < 200) break;
      page++;
    }
    if (items.length > 0) {
      return syncMaterialsToLocal(items, doApply, 'materials.list', res);
    }
    errors.push('materials.list 返回空数据');
  } catch (e) {
    errors.push('materials.list: ' + e.message);
  }

  // 方式2：通用数据供给 materials
  try {
    const items = [];
    let page = 1;
    while (page <= 5) {
      const data = await callDataSupply('materials', { page, page_size: 200 });
      const batch = data.items || data.data || [];
      if (batch.length === 0) break;
      items.push(...batch);
      if (batch.length < 200) break;
      page++;
    }
    if (items.length > 0) {
      return syncMaterialsToLocal(items, doApply, 'data-supply materials', res);
    }
    errors.push('data-supply materials 返回空数据');
  } catch (e) {
    errors.push('data-supply materials: ' + e.message);
  }

  // 两种方式都失败
  const fixHint = errors.some(e => e.includes('update_time'))
    ? '外部系统 Material 模型缺少 update_time 字段，需服务端修复'
    : errors.some(e => e.includes('签名') || e.includes('403'))
    ? 'API Key 未授权 materials 数据类型，需管理员在数据范围配置中启用'
    : '请检查外部系统 materials 接口状态';
  res.status(502).json({
    error: '外部物料接口不可用',
    diagnostics: errors,
    fix_hint: fixHint,
    suggestion: '请联系外部系统管理员：1) 修复 Material.update_time 字段 或 2) 为 API Key 开通 materials 数据权限',
  });
});

// 同步物料到本地（共享逻辑）
function syncMaterialsToLocal(items, doApply, source, res) {
  const matTable = getTable('materials');
  const existingCodes = new Set(matTable.all().map(m => m.material_code));
  let imported = 0, skipped = 0; const details = [];
  for (const item of items) {
    const code = (item.material_code || item.code || item.material_number || '').trim();
    if (!code) { skipped++; continue; }
    if (existingCodes.has(code)) { skipped++; continue; }
    const name = (item.material_name || item.name || item.description || '').trim();
    const specs = (item.specs || item.spec || item.specification || item.model || '').trim();
    const mtype = (item.material_type || item.type || item.category || '').trim();
    const unit = (item.unit || item.uom || '').trim() || 'PCS';
    const cost = Number(item.standard_cost || item.unit_price || item.cost || 0);
    if (doApply) {
      matTable.insert({
        material_name: name, material_code: code, specs, material_type: mtype, unit,
        standard_cost: cost, category: mtype, supplier: (item.supplier || item.supplier_name || '').trim(),
        processing_cost: 0, processing_loss: 0, status: 'normal',
        classification: (item.classification || '').trim() || '专用物料',
        unit_price: cost, quantity: 1,
        inventory_qty: 0, min_inventory: 0, monthly_usage: 0,
        bom_usage_count: 0, used_in_products: '',
        product_id: null, certificate_required: '',
        remarks: '从外部系统同步(' + source + ')',
        created_at: now(), updated_at: now()
      });
      existingCodes.add(code);
    }
    imported++;
    if (details.length < 20) details.push({ material_code: code, material_name: name.substring(0, 20), material_type: mtype, unit, cost });
  }
  res.json({
    message: doApply ? '同步完成：导入' + imported + '条，跳过' + skipped + '条（已存在）' : '预览：可导入' + imported + '条，已存在' + skipped + '条',
    imported, skipped, total_fetched: items.length, source, applied: doApply, details
  });
}

// ===== 同步客户到本地客户管理 =====
router.post('/sync-customers', requirePerm('customer:create'), async (req, res) => {
  const custTable = getTable('customers');
  const { apply } = req.body;
  const doApply = apply !== false;

  try {
    // 分页拉取
    const items = [];
    let page = 1;
    while (page <= 5) {
      const data = await callExternalAPI('customers.list', { page, page_size: 200 });
      const batch = data.items || data.data || [];
      if (batch.length === 0) break;
      items.push(...batch);
      if (batch.length < 200) break;
      page++;
    }

    if (items.length === 0) {
      return res.json({ message: '外部系统无客户数据', imported: 0, skipped: 0, total: 0 });
    }

    const existingNames = new Set(custTable.all().map(c => c.name));
    let imported = 0, skipped = 0; const details = [];

    for (const item of items) {
      const name = (item.customer_name || item.name || item.company_name || '').trim();
      if (!name) { skipped++; continue; }
      if (existingNames.has(name)) { skipped++; continue; }

      const code = (item.customer_code || item.code || '').trim();
      const level = (item.customer_level || item.level || '').trim();
      const status = item.status === 1 ? 'active' : 'dormant';

      if (doApply) {
        custTable.insert({
          name, source: '外部系统同步', contact: '', phone: '', email: '',
          level: level || 'C', status, trade_mode: 'domestic',
          address: '', remarks: (item.customer_short || '') + (code ? ' [' + code + ']' : ''),
          created_at: now(), updated_at: now()
        });
        existingNames.add(name);
      }
      imported++;
      if (details.length < 20) details.push({ name: name.substring(0, 22), code, level, status });
    }

    res.json({
      message: doApply ? '同步完成：导入' + imported + '家，跳过' + skipped + '家（已存在）' : '预览：可导入' + imported + '家，已存在' + skipped + '家',
      imported, skipped, total_fetched: items.length, applied: doApply, details
    });
  } catch (e) {
    res.status(500).json({ error: '客户同步失败: ' + e.message });
  }
});

// ===== 同步订单到本地（订单分析库一键对接外部订单总控台）=====
// 全链路：orders.list 订单+行明细 → 按 order_no+line_no upsert（新增入库/已有更新状态数量交期）
//        → 自动关联产品型号 → 连分级BOM模版一起展开，明细落库 order_bom_details + 计划成本快照
// body: { apply?: true(默认，false=仅预览), max_pages?: 50, expand_bom?: true(默认) }
router.post('/sync-orders', requirePerm('order:create'), async (req, res) => {
  const orderTable = getTable('orders');
  const { apply, max_pages, expand_bom } = req.body || {};
  const doApply = apply !== false;
  const maxPages = parseInt(max_pages) || 50;
  const doExpandBom = expand_bom !== false;

  try {
    // 1. 拉取外部订单总控台全部订单行（订单+明细）
    const items = [];
    let page = 1;
    while (page <= maxPages) {
      const data = await callExternalAPI('orders.list', { page, page_size: 200 });
      const batch = data.items || data.data || [];
      if (batch.length === 0) break;
      items.push(...batch);
      if (batch.length < 200) break;
      page++;
    }

    if (items.length === 0) return res.json({ message: '外部系统无订单数据', imported: 0, updated: 0, skipped: 0, total: 0 });

    // 2. upsert：按 order_no+line_no 匹配，只同步 HJ2 开头的大货订单（HJY 样品单等过滤）
    // 外部状态到本地状态的映射：外部"已完成"=本地"发货完成"
    const statusMap = { 'completed': 'shipped', 'open': 'open', 'closed': 'completed', 'cancelled': 'cancelled' };
    orderTable._invalidate();
    const exMap = {};
    orderTable.all().forEach(o => { exMap[o.order_no + '_' + (o.line_no || '')] = o; });

    let created = 0, updated = 0, unchanged = 0, skipped = 0;
    const touchedIds = [];  // 本次新增或有字段更新的订单 id
    const syncedIds = [];   // 本次同步命中的全部订单 id（含未变化）
    const details = [];

    for (const item of items) {
      const orderNo = (item.order_no || '').trim();
      if (!orderNo.toUpperCase().startsWith('HJ2')) { skipped++; continue; }
      const lineNo = (item.line_no || '').trim();
      const key = orderNo + '_' + lineNo;
      // 逐字段构建：外部为 null/undefined 的字段视为"无数据"，不纳入同步——
      // 更新时不会用空值冲掉本地已有值（如 completed_qty、promised_date）
      const fields = { order_no: orderNo, line_no: lineNo };
      if (item.customer != null) fields.customer_name = String(item.customer).trim();
      if (item.customer_code != null) fields.customer_code = String(item.customer_code).trim();
      if (item.order_qty != null) fields.quantity = Number(item.order_qty) || 0;
      if (item.completed_qty != null) fields.completed_qty = Number(item.completed_qty) || 0;
      if (item.order_amount != null) fields.order_amount = Number(item.order_amount) || 0;
      if (item.status != null && item.status !== '') fields.status = statusMap[item.status] || item.status;
      if (item.risk_level != null && item.risk_level !== '') fields.risk_level = item.risk_level;
      if (item.promised_date != null && item.promised_date !== '') fields.promised_date = String(item.promised_date).substring(0, 10);
      // 外部带产品编码/名称时才透传，避免用 null 清空本地已关联的产品
      if (item.product_code) fields.product_code = String(item.product_code).trim();
      if (item.product_name) fields.product_name = String(item.product_name).trim();

      const ex = exMap[key];
      if (ex) {
        syncedIds.push(ex.id);
        // 仅更新有变化的字段（预览模式下同样计算差异但不落库）
        const patch = {};
        for (const k of Object.keys(fields)) {
          if (k === 'order_no' || k === 'line_no') continue;
          if (String(ex[k] == null ? '' : ex[k]) !== String(fields[k] == null ? '' : fields[k])) patch[k] = fields[k];
        }
        if (Object.keys(patch).length) {
          updated++;
          if (doApply) {
            patch.updated_at = now();
            await orderTable.update(ex.id, patch);
            Object.assign(ex, patch);
            touchedIds.push(ex.id);
          }
        } else unchanged++;
      } else {
        if (doApply) {
          // 新单入库默认值（外部缺失字段时兜底）
          if (fields.customer_name === undefined) fields.customer_name = '';
          if (fields.customer_code === undefined) fields.customer_code = '';
          if (fields.quantity === undefined) fields.quantity = 0;
          if (fields.completed_qty === undefined) fields.completed_qty = 0;
          if (fields.order_amount === undefined) fields.order_amount = 0;
          if (fields.status === undefined) fields.status = 'open';
          if (fields.risk_level === undefined) fields.risk_level = 'blue';
          if (fields.promised_date === undefined) fields.promised_date = '';
          fields.remarks = '外部同步';
          fields.created_at = now(); fields.updated_at = now();
          const r = await orderTable.insert(fields);
          exMap[key] = Object.assign({ id: r.lastID }, fields);
          touchedIds.push(r.lastID);
          syncedIds.push(r.lastID);
        }
        created++;
        if (details.length < 20) details.push({ order_no: orderNo, customer: fields.customer_name, amount: fields.order_amount, status: item.status });
      }
    }

    // 2.3 从 order-details.list 补充全部已有订单的产品编码/名称/BOM 信息
    let enrichedCount = 0;
    if (doApply) {
      try {
        orderTable._invalidate();
        const allOrders = orderTable.all();
        const allOrd = {};
        allOrders.forEach(o => { allOrd[o.order_no] = o; });

        // 2.3a 先用已有完整订单的产品编码→名称映射，填充仅有编码无名称的订单
        const code2name = {};
        allOrders.forEach(o => { if (o.product_code && o.product_name) code2name[o.product_code] = o.product_name; });
        for (const o of allOrders) {
          if (o.product_code && !o.product_name && code2name[o.product_code]) {
            o.product_name = code2name[o.product_code];
            await orderTable.update(o.id, { product_name: o.product_name, updated_at: now() });
            enrichedCount++;
          }
        }

        // 2.3b 从 order-details.list 补充产品编码/名称
        let dp = 1;
        while (dp <= 20) {
          const dd = await callExternalAPI('order_details.list', { page: dp, page_size: 200 });
          const batch = dd.items || dd.data || [];
          if (!batch.length) { console.log('[enrich] page', dp, 'empty, stopping'); break; }
          console.log('[enrich] page', dp, 'got', batch.length, 'items');
          let pageMatched = 0, pageEnriched = 0;
          for (const d of batch) {
            const oNo = (d.order_no || '').trim();
            const ex = allOrd[oNo];
            if (!ex) { if (dp === 1 && pageMatched === 0 && pageEnriched === 0) console.log('[enrich] first unmatched:', oNo); continue; }
            pageMatched++;
            if (ex.product_code && ex.product_name) continue;
            const patch = {};
            if (d.product_code) patch.product_code = String(d.product_code).trim();
            if (d.product_name) patch.product_name = String(d.product_name).trim();
            if (d.bom_id != null) patch.bom_id = d.bom_id;
            if (d.bom_no) patch.bom_no = String(d.bom_no).trim();
            if (Object.keys(patch).length) {
              patch.updated_at = now();
              await orderTable.update(ex.id, patch);
              Object.assign(ex, patch);
              pageEnriched++;
              enrichedCount++;
            }
          }
          console.log('[enrich] page', dp, 'matched:', pageMatched, 'enriched:', pageEnriched);
          if (batch.length < 200) break;
          dp++;
        }
        // 2.3c 对仍有编码无名称的订单，尝试从 products.list、materials.list 查找产品名称
        {
          const stillMissing = orderTable.all().filter(o => o.product_code && !o.product_name);
          if (stillMissing.length) {
            const unknownCodes = [...new Set(stillMissing.map(o => o.product_code))];
            console.log('[enrich] looking up', unknownCodes.length, 'unknown codes from products.list+materials.list');
            try {
              const extSync = require('./external-sync');
              const codeMap = {};
              // 先从 products.list 查找
              try {
                const prodItems = await extSync.fetchAllPages('products.list', 200);
                prodItems.forEach(p => {
                  const c = (p.product_code || p.code || p.model || '').trim();
                  if (c) codeMap[c] = p.product_name || p.name || '';
                });
              } catch (e) { console.error('[enrich] products.list error:', e.message); }
              // 再从 materials.list 查找
              try {
                const matItems = await extSync.fetchAllPages('materials.list', 200);
                matItems.forEach(m => {
                  const c = (m.material_code || m.code || '').trim();
                  if (c && !codeMap[c]) codeMap[c] = m.material_name || m.name || '';
                });
              } catch (e) { console.error('[enrich] materials.list error:', e.message); }
              console.log('[enrich] lookup codes fetched:', Object.keys(codeMap).length);
              for (const o of stillMissing) {
                const name = codeMap[o.product_code];
                if (name) {
                  o.product_name = String(name).trim();
                  await orderTable.update(o.id, { product_name: o.product_name, updated_at: now() });
                  enrichedCount++;
                }
              }
            } catch (e) { console.error('[enrich] lookup error:', e.message); }
          }
        }
      } catch (e) { console.error('[sync-orders] product enrichment error:', e.message); }
    }

    // 2.5 将产品写入 order_products（确保展开后能看到产品列表）
    let orderProductsCreated = 0;
    if (doApply) {
      try {
        const op = getTable('order_products');
        op._invalidate();
        const existingKeys = new Set(op.all().map(r => r.order_id + '::' + r.product_code));
        orderTable._invalidate();
        const seen = new Set();
        for (const id of syncedIds) {
          const o = orderTable.findById(id);
          if (!o || !o.product_code) continue;
          const key = o.order_no + '::' + o.product_code;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!existingKeys.has(o.id + '::' + o.product_code)) {
            try {
              await op.insert({ order_id: o.id, order_no: o.order_no, product_code: o.product_code, product_name: o.product_name || '', created_at: now(), updated_at: now() });
              orderProductsCreated++;
            } catch(_) {}
          }
        }
      } catch(_) {}
    }

    // 2.6 将客户同步到 customers 表（从订单中提取去重客户）
    let customersCreated = 0;
    if (doApply) {
      try {
        const custTable = getTable('customers');
        custTable._invalidate();
        const existNames = new Set(custTable.all().map(c => (c.name || '').trim()).filter(Boolean));
        const existCodes = new Set(custTable.all().map(c => (c.customer_code || '').trim()).filter(Boolean));
        const seenCust = new Set();
        for (const item of items) {
          const oNo = (item.order_no || '').trim();
          if (!oNo.toUpperCase().startsWith('HJ2')) continue;
          const cName = (item.customer || '').trim();
          const cCode = (item.customer_code || '').trim();
          if (!cName && !cCode) continue;
          const key = cCode || cName;
          if (seenCust.has(key)) continue;
          seenCust.add(key);
          if (!(cName && existNames.has(cName)) && !(cCode && existCodes.has(cCode))) {
            try {
              await custTable.insert({
                name: cName || cCode || '', customer_code: cCode || '',
                source: '外部系统同步', contact: '', phone: '', email: '',
                level: 'C', status: 'active', trade_mode: 'domestic',
                address: '', remarks: '订单同步自动创建',
                created_at: now(), updated_at: now()
              });
              if (cName) existNames.add(cName);
              if (cCode) existCodes.add(cCode);
              customersCreated++;
            } catch(_) {}
          }
        }
      } catch(_) {}
    }

    // 2.7 将产品同步到 products 表（从订单中提取去重产品编码）
    let productsCreated = 0;
    if (doApply) {
      try {
        const prodTable = getTable('products');
        prodTable._invalidate();
        const existProds = new Set(prodTable.all().map(p => (p.external_model || '').trim()).filter(Boolean));
        const seenProd = new Set();
        for (const item of items) {
          const oNo = (item.order_no || '').trim();
          if (!oNo.toUpperCase().startsWith('HJ2')) continue;
          const pCode = (item.product_code || '').trim();
          if (!pCode || seenProd.has(pCode)) continue;
          seenProd.add(pCode);
          if (!existProds.has(pCode)) {
            try {
              await prodTable.insert({
                external_model: pCode, internal_model: pCode,
                product_name: (item.product_name || '').trim() || '',
                source: '外部系统同步',
                created_at: now(), updated_at: now()
              });
              existProds.add(pCode);
              productsCreated++;
            } catch(_) {}
          }
        }
      } catch(_) {}
    }

    // 3. 连BOM模版一起同步：自动关联产品型号 + 展开分级BOM明细落库（仅 doApply 时）
    //    展开范围 = 本次新增/更新的订单 ∪ 已同步但尚无BOM明细的订单（未变化且已有明细的跳过，避免快照刷屏）
    let mapped = 0, bomExpanded = 0, bomDetails = 0, expandFailed = 0;
    if (doApply && doExpandBom) {
      try {
        const orderAnalysis = require('./order-analysis');
        const det = getTable('order_bom_details');
        det._invalidate();
        const hasDetails = new Set(det.all().map(d => d.order_id));
        const expandSet = new Set(touchedIds);
        for (const id of syncedIds) {
          if (!expandSet.has(id) && !hasDetails.has(id)) expandSet.add(id);
        }
        orderTable._invalidate();
        for (const id of expandSet) {
          try {
            const o = orderTable.findById(id);
            if (!o) continue;
            if (o.product_code) {
              orderAnalysis.clearMatPriceCache();
              const plan = await orderAnalysis.calcPlanCost(o);
              const ds = await orderAnalysis.syncOrderBomDetails(o.id);
              bomExpanded++;
              bomDetails += ds.synced || 0;
            }
          } catch (_) { expandFailed++; }
        }
        orderTable._invalidate();
      } catch (_) {}
    }

    res.json({
      message: doApply
          ? ('同步完成：订单新增' + created + '条、更新' + updated + '条、未变化' + unchanged + '条（过滤非大货单' + skipped + '条）；补充产品信息' + enrichedCount + '条，关联客户' + customersCreated + '家、产品' + productsCreated + '个，写入产品库' + orderProductsCreated + '条，自动关联产品' + mapped + '个，连BOM模版展开' + bomExpanded + '单（明细' + bomDetails + '行）' + (expandFailed ? '，展开失败' + expandFailed + '单' : ''))
          : ('预览：可新增' + created + '条，可更新' + updated + '条，未变化' + unchanged + '条，过滤' + skipped + '条'),
      imported: created, updated, unchanged, skipped, total_fetched: items.length,
      applied: doApply, enriched: enrichedCount, customers_created: customersCreated, products_created: productsCreated,
      order_products_created: orderProductsCreated, mapped, bom_expanded: bomExpanded, bom_details: bomDetails, expand_failed: expandFailed, details
    });
  } catch (e) {
    res.status(500).json({ error: '订单同步失败: ' + e.message });
  }
});

// ===== 同步订单：状态/计划交期/上线时间/相关产品（从外部ERP，订单管理模块一键同步）=====
// 1) 拉 orders.list → 按 order_no+line_no 更新本地订单的 status（状态取发货完成信息）+ 表头"外部同步"标识
// 2) 拉 schedule_plans.list → 按 order_no 更新本地订单的 plan_date / online_date
// 3) 解析订单相关产品（映射规则匹配 product_code）并写入 order_products
router.post('/sync-order-status', requirePerm('order:edit'), async (req, res) => {
  const orderTable = getTable('orders');
  const ts = now();

  // ----- 1. 拉 orders.list，更新 status -----
  let orderItems = [];
  let orderFetchError = '';
  try {
    let page = 1;
    while (page <= 10) {
      const data = await callExternalAPI('orders.list', { page, page_size: 200 });
      const batch = data.items || data.data || [];
      if (batch.length === 0) break;
      orderItems.push(...batch);
      if (batch.length < 200) break;
      page++;
    }
  } catch (e) { orderFetchError = e.message; }

  // 外部状态 → 本地状态映射（兼容中英文；"状态取发货完成信息"：completed/已完成/发货完成 → shipped 已发货）
  const extStatusMap = {
    'completed': 'shipped', '已完成': 'shipped', '发货完成': 'shipped', '已发货': 'shipped',
    'open': 'open', '待确认': 'open', 'confirmed': 'confirmed', '已确认': 'confirmed',
    'closed': 'completed', '已关闭': 'completed', 'cancelled': 'cancelled', '已取消': 'cancelled'
  };
  let statusUpdated = 0, statusFetched = orderItems.length;
  let statusLockedSkipped = 0;

  if (orderItems.length > 0) {
    orderTable._invalidate();
    const exMap = {};
    orderTable.all().forEach(o => { exMap[o.order_no + '_' + (o.line_no || '')] = o; });
    let statusLocked = 0;
    for (const item of orderItems) {
      const orderNo = (item.order_no || '').trim();
      if (!orderNo) continue;
      const lineNo = (item.line_no || '').trim();
      const ex = exMap[orderNo + '_' + lineNo];
      if (!ex) continue;
      const patch = {};
      // 状态：本地已加锁（user_status_locked=1）的订单跳过状态覆盖；其它字段照常同步
      const isLocked = Number(ex.user_status_locked) === 1 || String(ex.user_status_locked) === '1';
      if (!isLocked) {
        // 优先外部状态映射；映射不到时按发货完成信息推断（完成数 >= 订单数 → 已发货）
        const mapped = extStatusMap[item.status] || null;
        if (mapped && mapped !== ex.status) patch.status = mapped;
        if (!patch.status && item.completed_qty != null) {
          const done = Number(item.completed_qty) || 0;
          const qty = Number(ex.quantity) || Number(item.order_qty) || 0;
          if (qty > 0 && done >= qty && ex.status !== 'shipped') patch.status = 'shipped';
        }
      } else {
        statusLockedSkipped++;
      }
      if (item.completed_qty != null && (Number(item.completed_qty) || 0) !== (Number(ex.completed_qty) || 0)) {
        patch.completed_qty = Number(item.completed_qty) || 0;
      }
      // 同步信息在表头标识：外部同步订单备注追加"外部同步"标记（保留用户已有备注）
      const rmk = String(ex.remarks || '');
      if (!rmk.includes('外部同步')) patch.remarks = rmk ? (rmk + ' 外部同步') : '外部同步';
      if (Object.keys(patch).length) { patch.updated_at = ts; orderTable.update(ex.id, patch); statusUpdated++; }
    }
    if (statusLockedSkipped) {
      // 暴露给前端：被锁的订单数量
      console.log('[sync-order-status] 跳过 '+ statusLockedSkipped +' 条已本地锁定状态');
    }
  }

  // ----- 2. 拉 schedule_plans.list，更新 plan_date / online_date -----
  let scheduleItems = [];
  let scheduleFetchError = '';
  try {
    let page = 1;
    while (page <= 10) {
      const data = await callExternalAPI('schedule_plans.list', { page, page_size: 200 });
      const batch = data.items || data.data || [];
      if (batch.length === 0) break;
      scheduleItems.push(...batch);
      if (batch.length < 200) break;
      page++;
    }
  } catch (e) { scheduleFetchError = e.message; }

  let scheduleUpdated = 0;
  if (scheduleItems.length > 0) {
    orderTable._invalidate();
    const idx = {};
    orderTable.all().forEach(o => {
      if (!o.order_no) return;
      if (!idx[o.order_no]) idx[o.order_no] = [];
      idx[o.order_no].push(o);
    });
    for (const plan of scheduleItems) {
      const orderNo = (plan.order_no || plan.order_number || plan.order_code || '').trim();
      if (!orderNo) continue;
      // 字段名兼容多种命名
      const planDate = String(plan.plan_date || plan.plan_finish_date || plan.planned_date || plan.delivery_date || plan.plan_delivery_date || '').trim().substring(0, 10);
      const onlineDate = String(plan.online_date || plan.online_time || plan.start_date || plan.plan_start_date || plan.online_start_date || '').trim().substring(0, 10);
      const lineNo = String(plan.line_no || '').trim();
      const matches = idx[orderNo] || [];
      for (const o of matches) {
        if (lineNo && o.line_no && lineNo !== String(o.line_no)) continue;
        const patch = {};
        if (planDate && o.plan_date !== planDate) patch.plan_date = planDate;
        if (onlineDate && o.online_date !== onlineDate) patch.online_date = onlineDate;
        if (Object.keys(patch).length > 0) {
          patch.updated_at = ts;
          orderTable.update(o.id, patch);
          scheduleUpdated++;
        }
      }
    }
  }

  // ----- 3. 解析订单相关产品（API同步过来的产品型号）+ 写入 order_products -----
  

  let msg = '同步完成';
  if (orderFetchError && scheduleFetchError) {
    msg = '外部接口暂不可用：订单(' + orderFetchError + ')；排程(' + scheduleFetchError + ')';
  } else {
    const parts = [];
    if (orderItems.length > 0) parts.push('状态更新' + statusUpdated + '条（拉取' + statusFetched + '条订单）');
    else if (orderFetchError) parts.push('订单拉取失败(' + orderFetchError + ')');
    if (statusLockedSkipped > 0) parts.push('本地已锁定 ' + statusLockedSkipped + ' 条（保持本地状态）');
    if (scheduleItems.length > 0) parts.push('计划/上线时间更新' + scheduleUpdated + '条（拉取' + scheduleItems.length + '条排程）');
    else if (scheduleFetchError) parts.push('排程拉取失败(' + scheduleFetchError + ')');
    if (productResolved > 0 || orderProductsCreated > 0) parts.push('关联产品' + productResolved + '单（写入' + orderProductsCreated + '条）');
    else if (productError) parts.push('产品解析失败(' + productError + ')');
    msg = parts.length ? '同步完成：' + parts.join('；') : '同步完成（无数据）';
  }
  res.json({
    message: msg,
    status_updated: statusUpdated,
    status_fetched: statusFetched,
    status_locked_skipped: statusLockedSkipped,
    status_error: orderFetchError,
    schedule_updated: scheduleUpdated,
    schedule_fetched: scheduleItems.length,
    schedule_error: scheduleFetchError,
    product_resolved: productResolved,
    order_products_created: orderProductsCreated,
    product_error: productError
  });
});

// ===== 同步配置管理 =====
const CONFIG_PATH = path.join(__dirname, '..', '..', 'database', 'sync-config.json');

function readSyncConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  return { enabled: false, frequency: 'manual', modules: {}, frequency_map: {} };
}
function writeSyncConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

router.get('/sync-config', requirePerm('system:config'), (req, res) => {
  const cfg = readSyncConfig();
  res.json(cfg);
});

router.put('/sync-config', requirePerm('system:config'), (req, res) => {
  const cfg = readSyncConfig();
  const b = req.body;
  if (b.enabled !== undefined) cfg.enabled = b.enabled;
  if (b.frequency) cfg.frequency = b.frequency;
  if (b.modules) {
    Object.keys(b.modules).forEach(k => {
      cfg.modules[k] = { ...(cfg.modules[k] || {}), ...b.modules[k] };
    });
  }
  writeSyncConfig(cfg);
  res.json(cfg);
});

// 一键同步全部已启用模块
router.post('/sync-all', requirePerm('system:config'), async (req, res) => {
  const cfg = readSyncConfig();
  const mods = cfg.modules || {};
  const results = {};
  const { apply } = req.body;
  const doApply = apply !== false;

  for (const [name, mod] of Object.entries(mods)) {
    if (!mod.enabled) continue;
    try {
      const data = await callExternalAPI(name + '.list', { page: 1, page_size: 200 });
      const items = data.items || data.data || [];
      if (name === 'suppliers') {
        if (doApply) {
          const supTable = getTable('suppliers');
          const exist = new Set(supTable.all().map(s => s.name));
          let imp = 0;
          items.forEach(item => {
            const n = (item.supplier_name || item.name || '').trim();
            if (n && !exist.has(n)) {
              supTable.insert({ name: n, code: (item.supplier_code || '').trim(), lifecycle_status: 'reviewing', risk_level: 'medium', level: 'C', quality_score: 0, delivery_score: 0, price_score: 0, service_score: 0, overall_score: 0, created_at: now(), updated_at: now() });
              exist.add(n); imp++;
            }
          });
          results[name] = { fetched: items.length, imported: imp };
        } else {
          results[name] = { fetched: items.length, preview: true };
        }
      } else if (name === 'customers') {
        if (doApply) {
          const custTable = getTable('customers');
          const exist = new Set(custTable.all().map(c => c.name));
          let imp = 0;
          items.forEach(item => {
            const n = (item.customer_name || item.name || '').trim();
            if (n && !exist.has(n)) {
              custTable.insert({ name: n, source: '自动同步', contact: '', phone: '', email: '', level: (item.customer_level || '').trim() || 'C', status: item.status === 1 ? 'active' : 'dormant', trade_mode: 'domestic', address: '', remarks: '', created_at: now(), updated_at: now() });
              exist.add(n); imp++;
            }
          });
          results[name] = { fetched: items.length, imported: imp };
        } else {
          results[name] = { fetched: items.length, preview: true };
        }
      } else {
        results[name] = { fetched: items.length, imported: 0, note: '批量同步仅支持suppliers/customers' };
      }
      // 更新最后同步时间
      cfg.modules[name].last_sync = now();
    } catch (e) {
      results[name] = { error: e.message.substring(0, 80) };
    }
  }
  writeSyncConfig(cfg);
  res.json({ message: '同步完成', results });
});

// ===== 数据回写（写回外部系统）=====
// 签名 POST：在 GET 拉取签名基础上增加 body 摘要，防篡改
function callExternalWrite(endpointCode, payload, method) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload || {});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodySig = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const signature = sign(CONFIG.APP_SECRET, timestamp + CONFIG.APP_KEY + endpointCode + bodySig);
    const url = new URL(CONFIG.BASE_URL);
    const options = {
      hostname: url.hostname, port: url.port || 443,
      path: '/api/v1/external/' + endpointPath(endpointCode),
      method: method || 'POST', rejectUnauthorized: false,
      headers: {
        'X-App-Key': CONFIG.APP_KEY, 'X-Timestamp': timestamp,
        'X-Signature': signature, 'X-Body-Sig': bodySig,
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr)
      },
      timeout: 30000
    };
    const req = https.request(options, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ http_status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { resolve({ http_status: res.statusCode, raw: body.substring(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(bodyStr); req.end();
  });
}

// 回写模块元数据：本地表 → 查找字段 → 外部字段映射
const WRITEBACK_MODULES = {
  suppliers: { table: 'suppliers', key: 'name', label: '供应商', fields: { name: 'supplier_name', code: 'supplier_code' } },
  customers: { table: 'customers', key: 'name', label: '客户', fields: { name: 'customer_name', level: 'customer_level' } },
  materials: { table: 'materials', key: 'material_code', label: '物料', fields: { material_code: 'material_code', material_name: 'material_name', classification: 'classification', classification2: 'classification2', standard_cost: 'standard_cost', unit: 'unit', material_type: 'material_type' } },
  orders: { table: 'orders', key: 'serial_number', label: '订单', fields: { serial_number: 'order_code', customer_name: 'customer_name', status: 'status' } }
};

// 可回写模块列表
router.get('/write-back/modules', requirePerm('system:config'), (req, res) => {
  const cfg = readSyncConfig();
  const list = Object.entries(WRITEBACK_MODULES).map(([k, m]) => ({
    module: k, label: m.label, key: m.key,
    writeback_enabled: !!((cfg.modules[k] || {}).writeback)
  }));
  res.json({ data: list });
});

// 执行回写：按 code 取本地记录，映射字段后签名 POST 到外部
router.post('/write-back', requirePerm('system:config'), async (req, res) => {
  const { module, code, op, data } = req.body;
  const meta = WRITEBACK_MODULES[module];
  if (!meta) return res.status(400).json({ error: '不支持的回写模块：' + module });
  const cfg = readSyncConfig();
  if (!((cfg.modules[module] || {}).writeback)) return res.status(403).json({ error: '该模块未开启回写，请先在设置中启用' });

  // 取本地数据：显式 data 优先，否则按 code 查本地表
  let payload = data;
  let local;
  if (!payload) {
    const t = getTable(meta.table);
    t._invalidate();
    local = t.all().find(r => String(r[meta.key]) === String(code));
    if (!local) return res.status(404).json({ error: '本地未找到 ' + meta.label + '：' + code });
    payload = {};
    Object.entries(meta.fields).forEach(([lk, ek]) => { if (local[lk] !== undefined && local[lk] !== '') payload[ek] = local[lk]; });
  }
  const operation = op || 'update';
  const endpointCode = module + '.' + operation;

  let result, ok = false, errMsg = '';
  try {
    const r = await callExternalWrite(endpointCode, payload, operation === 'delete' ? 'POST' : 'POST');
    result = r;
    ok = (r.http_status >= 200 && r.http_status < 300);
    if (!ok) errMsg = 'HTTP ' + r.http_status;
  } catch (e) {
    errMsg = e.message;
    result = { error: e.message };
  }

  // 记录回写日志
  try {
    const logT = getTable('writeback_log');
    logT.insert({
      module, code: String(code || ''), op: operation, endpoint: endpointCode,
      ok: ok ? 1 : 0, error: errMsg,
      payload_preview: JSON.stringify(payload).substring(0, 500),
      created_at: now()
    });
  } catch (e) {}

  res.json({
    message: ok ? '回写成功' : ('回写失败：' + errMsg),
    ok, module, code, op: operation, endpoint: endpointCode,
    payload, external_response: result
  });
});

// 回写日志
router.get('/write-back/log', requirePerm('system:config'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const t = getTable('writeback_log');
  t._invalidate();
  const all = t.all().sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, limit);
  res.json({ data: all, total: t.all().length });
});

// ============================================================
// 销售中心订单管理专用：外部 API 直读 + 4 个完成时间聚合
// ============================================================
// 数据来源：
//   - orders.list            订单基础信息（含 planned_start_date 计划上线时间）
//   - order_details.list     订单下产品明细（按 order_no 过滤）
//   - purchase_orders.list   采购入库时间（actual_arrival_date），按 order_no 关联聚合
//   - schedule_plans.list    排程（备查 start_date / end_date / plan_date）
// 4 个完成时间聚合规则：
//   - 计划上线时间 = orders.list.planned_start_date
//   - 入库时间     = max(purchase_orders.actual_arrival_date) 按 order_no 聚合
//   - 发货时间     = 派生：status 在 [shipped, completed, closed] 时取 orders.updated_at 的日期部分
//   - 交付时间     = 派生：status 在 [completed, closed] 时取 orders.updated_at 的日期部分
// 注意：发货/交付在外部 API 未提供精确时间戳，先用 updated_at 日期作为代理；后续外部系统如提供独立时间字段，再调整此处映射。

function ymd(v) {
  if (v == null) return '';
  const s = String(v);
  // 兼容 2026-07-23T11:32:07.396212 / 2026-07-23 11:32:07 / 2026-07-23
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s.substring(0, 10);
}
function deriveShipDate(o) {
  if (!o) return '';
  const s = String(o.status || '').toLowerCase();
  if (['shipped', 'completed', 'closed'].includes(s)) return ymd(o.updated_at);
  return '';
}
function deriveDeliveryDate(o) {
  if (!o) return '';
  const s = String(o.status || '').toLowerCase();
  if (['completed', 'closed'].includes(s)) return ymd(o.updated_at);
  return '';
}

// 提取 order_no 中的根号（去除行号/后缀）便于聚合：HJ202607-0015-0156 形式直接用，HJ202607-0015-0156-1 也用原值
function orderKey(no) {
  return String(no || '').trim();
}

// 拉取所有 POs（按需缓存，避免每次请求都拉全量）
let _poCache = null, _poCacheTs = 0;
async function fetchAllPOs(maxAgeMs = 5 * 60 * 1000) {
  if (_poCache && Date.now() - _poCacheTs < maxAgeMs) return _poCache;
  const items = [];
  let page = 1;
  try {
    while (page <= 40) {
      const data = await callExternalAPI('purchase_orders.list', { page, page_size: 200 });
      const batch = data.items || data.data || [];
      if (!batch.length) break;
      items.push(...batch);
      if (batch.length < 200) break;
      page++;
    }
  } catch (e) {
    // 静默失败：POs 拉不到不影响订单列表
    console.warn('[orders-with-progress] POs fetch failed:', e.message);
  }
  _poCache = items;
  _poCacheTs = Date.now();
  return items;
}

// 按 order_no 聚合入库时间 = max(actual_arrival_date)
function buildPOIndex(pos) {
  const idx = {};
  for (const p of pos) {
    const k = orderKey(p.order_no);
    if (!k) continue;
    const arr = (p.actual_arrival_date || '').toString().substring(0, 10);
    if (!arr || arr === 'null') continue;
    const prev = idx[k];
    if (!prev || arr > prev) idx[k] = arr;
  }
  return idx;
}

// 列表：外部 API 订单 + 4 个完成时间（不含 BOM 明细）
router.get('/orders-with-progress', requirePerm('order:view'), async (req, res) => {
  const { page = 1, page_size = 50, keyword, status, risk_level } = req.query;
  const ps = Math.min(Math.max(parseInt(page_size) || 50, 1), 500);
  const pg = Math.max(parseInt(page) || 1, 1);
  try {
    const data = await callExternalAPI('orders.list', { page: pg, page_size: ps });
    const items = data.items || data.data || [];
    const total = data.total || items.length;
    const pos = await fetchAllPOs();
    const poIdx = buildPOIndex(pos);

    // 关联本地库：标记 user_status_locked，让前端知道哪些是人工改过的
    const localTable = getTable('orders');
    localTable._invalidate();
    const localMap = {};
    localTable.all().forEach(o => {
      const k = String(o.order_no || '').trim() + '||' + String(o.line_no || '').trim();
      localMap[k] = o;
    });

    let rows = items.map(o => {
      const k = orderKey(o.order_no);
      const localKey = String(o.order_no || '').trim() + '||' + String(o.line_no || '').trim();
      const local = localMap[localKey];
      const locked = local && (Number(local.user_status_locked) === 1 || String(local.user_status_locked) === '1');
      return {
        order_no: o.order_no || '',
        line_no: o.line_no || '',
        ext_id: o.id || null,
        local_id: local ? local.id : null,
        customer: o.customer || '',
        customer_code: o.customer_code || '',
        product_code: o.product_code || '',
        product_name: o.product_name || '',
        order_qty: Number(o.order_qty) || 0,
        completed_qty: o.completed_qty != null ? Number(o.completed_qty) || 0 : null,
        order_amount: Number(o.order_amount) || 0,
        status: o.status || '',
        risk_level: o.risk_level || '',
        promised_date: ymd(o.promised_date),
        // 4 个完成时间
        planned_online_date: ymd(o.planned_start_date),  // 计划上线时间
        warehouse_date: poIdx[k] || '',                  // 入库时间
        ship_date: deriveShipDate(o),                     // 发货时间
        delivery_date: deriveDeliveryDate(o),             // 交付时间
        updated_at: o.updated_at || '',
        // 本地状态：本地库有记录且 user_status_locked=1 时返回
        local_status: local ? local.status : null,
        user_status_locked: locked ? 1 : 0,
        user_status_modified_at: local && locked ? (local.user_status_modified_at || '') : '',
        user_status_modified_by: local && locked ? (local.user_status_modified_by || '') : ''
      };
    });

    // 服务端过滤（按 keyword/status/risk_level）
    const kw = String(keyword || '').trim().toLowerCase();
    if (kw) {
      rows = rows.filter(r => [r.order_no, r.customer, r.product_code, r.product_name].join(' ').toLowerCase().includes(kw));
    }
    if (status) rows = rows.filter(r => r.status === status);
    if (risk_level) rows = rows.filter(r => r.risk_level === risk_level);

    res.json({
      data: rows,
      total: rows.length,   // 服务端过滤后的数量
      page: pg,
      page_size: ps,
      ext_total: total,     // 外部 API 返回的总记录数（过滤前）
      has_more: items.length >= ps,
      source: 'external-api'
    });
  } catch (e) {
    res.status(500).json({ error: '订单拉取失败: ' + e.message });
  }
});

// 单订单下的产品明细（来自 order_details.list）
router.get('/orders/:order_no/products', requirePerm('order:view'), async (req, res) => {
  const orderNo = String(req.params.order_no || '').trim();
  if (!orderNo) return res.status(400).json({ error: 'order_no 必填' });
  try {
    const items = [];
    let page = 1;
    while (page <= 20) {
      const data = await callExternalAPI('order_details.list', { page, page_size: 200, order_no: orderNo });
      const batch = data.items || data.data || [];
      if (!batch.length) break;
      items.push(...batch);
      if (batch.length < 200) break;
      page++;
    }
    // 仅保留匹配的 order_no（防止误拉）
    const rows = items.filter(it => orderKey(it.order_no) === orderNo).map(it => ({
      order_no: it.order_no || '',
      line_no: it.line_no || '',
      erp_line_id: it.erp_line_id || '',
      product_code: it.product_code || '',
      product_name: it.product_name || '',
      product_model: it.product_model || '',
      order_qty: Number(it.order_qty) || 0,
      order_amount: Number(it.order_amount) || 0,
      promised_date: ymd(it.promised_date),
      planned_online_date: ymd(it.planned_start_date),
      batch_no: it.batch_no || '',
      bom_no: it.bom_no || '',
      bom_id: it.bom_id || null,
      status: it.status || ''
    }));
    res.json({ data: rows, total: rows.length, order_no: orderNo, source: 'order_details.list' });
  } catch (e) {
    res.status(500).json({ error: '订单明细拉取失败: ' + e.message });
  }
});

// 模块导出保留
module.exports = router;
