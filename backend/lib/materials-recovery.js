// 物料库数据自愈模块：用于检测 materials.json 损坏并自动从外部 API 恢复
const fs = require('fs');
const path = require('path');

const MATERIALS_FILE = path.join(__dirname, '..', 'database', 'materials.json');
const MATERIALS_BAK = path.join(__dirname, '..', 'database', 'materials.json.bak');
const THRESHOLD_BYTES = 50 * 1024;
const COOLDOWN_MS = 60 * 1000;

let _running = false;
let _lastAt = 0;

function check() {
  try {
    const stat = fs.statSync(MATERIALS_FILE);
    return { ok: true, size: stat.size, tooSmall: stat.size < THRESHOLD_BYTES };
  } catch (e) {
    return { ok: false, size: 0, tooSmall: true };
  }
}

async function recover(reason, hooks) {
  // hooks: { log?: fn, getRouter?: () => express app, runSyncFn?: async () => number }
  if (_running) return { skipped: 'busy' };
  if (Date.now() - _lastAt < COOLDOWN_MS) return { skipped: 'cooldown' };
  _running = true; _lastAt = Date.now();
  const log = (hooks && hooks.log) || ((m) => console.log('[recovery] ' + m));
  try {
    log('触发自愈（' + reason + '），从外部 API 同步...');
    // 用注入的 runSyncFn（如果 routes 已加载），否则执行最小的 DB 操作
    let result;
    if (hooks && typeof hooks.runSyncFn === 'function') {
      result = await hooks.runSyncFn();
    } else {
      // 兜底：直接做 DB 层操作，避开 HTTP 自调用
      const { getTable, now } = require('../db');
      const extSync = require('../routes/external-sync');
      const matTable = getTable('materials');
      const bomTable = getTable('product_bom');
      matTable._invalidate(); bomTable._invalidate();
      const items = await (extSync.fetchAllPages ? extSync.fetchAllPages('materials.list', 200) : []);
      if (!items.length) { log('外部 API 无数据'); return { created: 0, updated: 0 }; }
      const inv = await extSync.fetchInventoryAggregate().catch(() => ({ agg: {}, detail: [] }));
      const codeMap = {};
      matTable.all().forEach(m => { if (m.material_code) codeMap[m.material_code] = m; });
      let created = 0, updated = 0;
      for (const item of items) {
        const code = item.material_code || item.code || '';
        if (!code) continue;
        const existing = codeMap[code];
        const mapped = {
          material_code: code, material_name: item.material_name || item.name || '',
          category: item.material_category || item.category || '', specs: item.spec_model || item.specification || item.specs || '',
          material_type: item.material_type || item.type || '', unit: item.unit_of_measure || item.unit || item.uom || '',
          unit_price: Number(item.unit_price || item.price || 0),
          standard_cost: Number(item.standard_cost || item.cost || 0),
          supplier: item.brand || item.supplier_name || item.supplier || '',
          status: item.status === 1 ? 'active' : (item.status === 0 ? 'inactive' : (item.status || 'active')),
          classification: item.classification || '通用物料', updated_at: now()
        };
        const invRec = inv.agg ? inv.agg[code] : null;
        if (invRec) { mapped.inventory_qty = Math.round(invRec.on_hand * 1000) / 1000; mapped.available_qty = Math.round(invRec.available * 1000) / 1000; }
        else if (item.stock_qty !== undefined || item.inventory_qty !== undefined) { mapped.inventory_qty = Number(item.stock_qty || item.inventory_qty || 0); }
        if (item.stock_qty !== undefined || item.quantity !== undefined) mapped.quantity = Number(item.stock_qty || item.quantity || 0);
        if (item.safety_stock !== undefined || item.min_inventory !== undefined) mapped.min_inventory = Number(item.safety_stock || item.min_inventory || 0);
        if (existing) { Object.assign(existing, mapped); updated++; }
        else {
          if (mapped.inventory_qty === undefined) mapped.inventory_qty = 0;
          if (mapped.quantity === undefined) mapped.quantity = 0;
          if (mapped.min_inventory === undefined) mapped.min_inventory = 0;
          mapped.created_at = now();
          matTable.insertNoSave(mapped); codeMap[code] = mapped; created++;
        }
      }
      // 关键：用异步写，不阻塞事件循环 —— 这样在 13MB 写盘期间，其它 HTTP 请求仍能正常响应
      await matTable._saveAsync(); matTable._invalidate();
      result = { message: '自愈完成（异步写入）：新增 ' + created + '，更新 ' + updated, created, updated, async_write: true };
    }
    log('成功：' + (result.message || JSON.stringify(result)));
    return result;
  } catch (e) {
    log('失败：' + e.message);
    return { error: e.message };
  } finally { _running = false }
}

module.exports = { check, recover, FILE: MATERIALS_FILE };
