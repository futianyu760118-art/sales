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

// ===== 同步订单到本地 =====
router.post('/sync-orders', requirePerm('order:create'), async (req, res) => {
  const orderTable = getTable('orders');
  const { apply } = req.body;
  const doApply = apply !== false;

  try {
    const items = [];
    let page = 1;
    while (page <= 5) {
      const data = await callExternalAPI('orders.list', { page, page_size: 200 });
      const batch = data.items || data.data || [];
      if (batch.length === 0) break;
      items.push(...batch);
      if (batch.length < 200) break;
      page++;
    }

    if (items.length === 0) return res.json({ message: '外部系统无订单数据', imported: 0, skipped: 0, total: 0 });

    const existingNos = new Set(orderTable.all().map(o => o.order_no + '_' + (o.line_no || '')));
    let imported = 0, skipped = 0; const details = [];

    for (const item of items) {
      const orderNo = (item.order_no || '').trim();
      // 只导入 HJ2 开头的大货订单，其余前缀（含 HJY 样品单等）均不导入
      if (!orderNo.toUpperCase().startsWith('HJ2')) { skipped++; continue; }
      const lineNo = (item.line_no || '').trim();
      const key = orderNo + '_' + lineNo;
      if (existingNos.has(key)) { skipped++; continue; }

      if (doApply) {
        // 外部状态到本地状态的映射：外部"已完成"=本地"发货完成"
        const statusMap = { 'completed': 'shipped', 'open': 'open', 'closed': 'completed', 'cancelled': 'cancelled' };
        const localStatus = statusMap[item.status] || item.status || 'open';
        orderTable.insert({
          order_no: orderNo, line_no: lineNo,
          customer_name: (item.customer || '').trim(),
          customer_code: (item.customer_code || '').trim(),
          product_code: (item.product_code || '').trim(),
          product_name: (item.product_name || '').trim(),
          quantity: Number(item.order_qty) || 0,
          completed_qty: Number(item.completed_qty) || 0,
          order_amount: Number(item.order_amount) || 0,
          status: localStatus,
          risk_level: (item.risk_level || 'blue'),
          promised_date: (item.promised_date || '').substring(0, 10),
          remarks: '外部同步',
          created_at: now(), updated_at: now()
        });
        existingNos.add(key);
      }
      imported++;
      if (details.length < 20) details.push({ order_no: orderNo, customer: (item.customer || ''), amount: item.order_amount, status: item.status });
    }

    res.json({
      message: doApply ? '同步完成：导入' + imported + '条，跳过' + skipped + '条（已存在）' : '预览：可导入' + imported + '条',
      imported, skipped, total_fetched: items.length, applied: doApply, details
    });
  } catch (e) {
    res.status(500).json({ error: '订单同步失败: ' + e.message });
  }
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

module.exports = router;
