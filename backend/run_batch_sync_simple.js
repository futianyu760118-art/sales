console.log('=== 启动简化版批量同步脚本 ===');

process.chdir(__dirname);

const { getTable, ensureTable, now } = require('./db');
const externalSync = require('./routes/external-sync');
const fetchAllPages = externalSync.fetchAllPages;

ensureTable('order_bom_details');

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.\-eE]/g, ''));
  return isNaN(n) ? 0 : n;
}

async function main() {
  console.log('\n=== 步骤1: 同步外部BOM数据 ===');
  try {
    const maxPages = 500;
    const details = await fetchAllPages('bom_details.list', 200, maxPages);
    const table = getTable('bom_items');
    const existing = {};
    table.all().forEach(b => {
      const k = [b.bom_no, b.material_code, b.line_no].join('||');
      if (b.bom_no && b.material_code) existing[k] = b;
    });
    let created = 0, updated = 0, skipped = 0;
    for (const d of details) {
      const bomNo = (d.bom_no || '').trim();
      const materialCode = (d.material_code || '').trim();
      if (!bomNo || !materialCode) { skipped++; continue; }
      const lineNo = (d.line_no || '').toString();
      const key = [bomNo, materialCode, lineNo].join('||');
      const lvlMatch = String(d.material_code).match(/^(\d+(?:\.\d+)*)\./);
      const stdQty = Number(d.standard_qty) || 0;
      const mapped = {
        product_code: bomNo,
        product_name: '',
        bom_no: bomNo,
        line_no: lineNo,
        level: lvlMatch ? lvlMatch[1] : '1',
        material_code: materialCode,
        material_name: (d.material_name || '').trim(),
        spec: (d.material_size || '').trim(),
        unit: (d.unit_id || d.unit || '').trim(),
        quantity: stdQty,
        qty: stdQty,
        material_attr: (d.material_type || '').trim(),
        use_status: (d.use_status !== undefined ? d.use_status : ''),
        source: 'external_sync',
        updated_at: now()
      };
      const ex = existing[key];
      if (ex) { await table.updateNoSave(ex.id, mapped); updated++; }
      else { mapped.created_at = now(); const nid = await table.insertNoSave(mapped); existing[key] = { id: nid }; created++; }
    }
    await table.saveNow();
    console.log(`BOM同步完成：新增${created}条，更新${updated}条，跳过${skipped}条`);
  } catch (e) {
    console.error('BOM同步失败:', e.message);
  }

  console.log('\n=== 步骤2: 构建索引 ===');
  
  const matTable = getTable('materials');
  const priceMap = {};
  matTable.all().forEach(m => {
    const code = (m.material_code || '').trim();
    if (code) {
      priceMap[code] = toNum(m.unit_price);
    }
  });
  console.log('物料价格映射数:', Object.keys(priceMap).length);
  
  const bomItems = getTable('bom_items');
  const bomIdx = {};
  bomItems.all().forEach(b => {
    if (!bomIdx[b.product_code]) bomIdx[b.product_code] = [];
    bomIdx[b.product_code].push(b);
  });
  console.log('BOM产品编码数:', Object.keys(bomIdx).length);

  const orders = getTable('orders');
  const orderList = orders.all().filter(o => o.product_code && o.product_code.trim());
  console.log('有产品编码的订单数:', orderList.length);

  console.log('\n=== 步骤3: 批量生成BOM明细 ===');
  
  const detailsTable = getTable('order_bom_details');
  await detailsTable.deleteWhereNoSave(() => true);
  console.log('清空BOM明细后缓存:', detailsTable._cache ? detailsTable._cache.records.length : 'null');

  let totalRecords = 0;
  
  for (let i = 0; i < orderList.length; i++) {
    const o = orderList[i];
    const prodCode = o.product_code.trim();
    const items = bomIdx[prodCode] || [];
    
    if (!items.length) continue;

    for (const item of items) {
      const unitPrice = priceMap[item.material_code] || 0;
      const orderQty = toNum(o.quantity) || toNum(o.amount) || 1;
      const bomQty = toNum(item.quantity) || toNum(item.qty) || 1;
      const totalQty = bomQty * orderQty;
      const matAmt = totalQty * unitPrice;
      
      const lvlMatch = String(item.material_code).match(/^(\d+(?:\.\d+)*)\./);
      
      const record = {
        order_id: o.id,
        order_no: o.order_no,
        product_code: prodCode,
        product_name: o.product_name || '',
        material_code: item.material_code,
        material_name: item.material_name || '',
        spec: item.spec || '',
        unit: item.unit || '',
        bom_qty: bomQty,
        order_qty: orderQty,
        total_qty: totalQty,
        unit_price: unitPrice,
        price_source: unitPrice > 0 ? 'material_library' : 'external_bom',
        depth: lvlMatch ? lvlMatch[1].split('.').length : 1,
        level: item.level || '1',
        material_amount: matAmt,
        labor_amount: 0,
        expense_amount: 0,
        line_total: matAmt,
        total_rollup: matAmt,
        material_rollup: matAmt,
        labor_rollup: 0,
        expense_rollup: 0,
        purchase_confirm_cost: 0,
        actual_cost: 0,
        bom_item_id: item.id,
        source: 'external_bom',
        created_at: now(),
        updated_at: now()
      };
      
      await detailsTable.insertNoSave(record);
      totalRecords++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`进度: ${i + 1}/${orderList.length} (已生成记录: ${totalRecords})`);
    }
  }

  console.log('\n=== 步骤4: 保存所有BOM明细 ===');
  console.log('缓存记录数:', detailsTable._cache ? detailsTable._cache.records.length : 'null');
  const saveResult = await detailsTable.saveNow();
  console.log('saveNow 结果:', saveResult);

  console.log(`\n批量同步完成！`);
  console.log(`  订单数: ${orderList.length}`);
  console.log(`  生成BOM明细记录数: ${totalRecords}`);

  console.log('\n=== 操作完成 ===');
}

main().catch(e => {
  console.error('批量同步脚本执行失败:', e);
  process.exit(1);
});
