console.log('=== 批量同步 order_products（从外部API获取多产品信息）===');
process.chdir(__dirname);

const { getTable, ensureTable, now } = require('./db');
const externalSync = require('./routes/external-sync');
const fetchAllPages = externalSync.fetchAllPages;

ensureTable('order_products');

async function main() {
  const orders = getTable('orders');
  orders._invalidate();
  const allOrders = orders.all();
  // 只处理有 product_code 的订单
  const orderList = allOrders.filter(o => o.product_code && o.product_code.trim());
  console.log(`总订单数: ${allOrders.length}`);
  console.log(`有产品编码的订单数: ${orderList.length}`);

  const op = getTable('order_products');
  op._invalidate();
  console.log(`当前 order_products 记录数: ${op.all().length}`);

  // 先清空所有旧记录
  console.log('清空旧 order_products...');
  await op.deleteWhereNoSave(() => true);
  console.log('已清空（内存）');

  let synced = 0, skipped = 0, failed = 0;
  let totalProducts = 0;
  const failedList = [];

  for (let i = 0; i < orderList.length; i++) {
    const o = orderList[i];
    try {
      // 调用外部 order_details.list 获取该订单的所有产品行
      const items = await fetchAllPages('order_details.list', 200, 5, { order_no: o.order_no });
      if (!items.length) {
        // 外部无数据，用 orders 主表信息回退
        op.insertNoSave({
          order_id: o.id, order_no: o.order_no,
          product_code: o.product_code, product_name: o.product_name || '',
          bom_no: o.bom_no || '', quantity: Number(o.quantity) || 0, amount: Number(o.order_amount) || 0,
          line_no: o.line_no || '', source: 'local_order',
          created_at: now(), updated_at: now()
        });
        totalProducts++;
        skipped++;
      } else {
        for (const it of items) {
          const code = (it.product_code || '').trim();
          if (!code) continue;
          op.insertNoSave({
            order_id: o.id, order_no: o.order_no,
            product_code: code, product_name: (it.product_name || '').trim(),
            bom_no: (it.bom_no || '').trim(),
            quantity: Number(it.order_qty || 0), amount: Number(it.order_amount || 0),
            line_no: it.line_no || '', source: 'external_order',
            created_at: now(), updated_at: now()
          });
          totalProducts++;
        }
        synced++;
      }
    } catch (e) {
      failed++;
      if (failedList.length < 20) {
        failedList.push({ id: o.id, order_no: o.order_no, reason: e.message });
      }
      // 失败时用 orders 主表信息回退
      op.insertNoSave({
        order_id: o.id, order_no: o.order_no,
        product_code: o.product_code, product_name: o.product_name || '',
        bom_no: o.bom_no || '', quantity: Number(o.quantity) || 0, amount: Number(o.order_amount) || 0,
        line_no: o.line_no || '', source: 'local_order',
        created_at: now(), updated_at: now()
      });
      totalProducts++;
    }

    if ((i + 1) % 100 === 0) {
      console.log(`进度: ${i + 1}/${orderList.length} (已同步: ${synced}, 跳过: ${skipped}, 失败: ${failed}, 产品数: ${totalProducts})`);
    }
  }

  // 统一落盘
  console.log(`\n同步完成，准备落盘...`);
  console.log(`缓存记录数: ${op._cache ? op._cache.records.length : 'null'}`);
  const saveResult = await op.saveNow();
  console.log(`saveNow 结果:`, saveResult);
  op._invalidate();

  console.log(`\n=== 同步完成 ===`);
  console.log(`  已同步（外部多产品）: ${synced}`);
  console.log(`  跳过（外部无数据，用本地）: ${skipped}`);
  console.log(`  失败（回退本地）: ${failed}`);
  console.log(`  order_products 总记录数: ${totalProducts}`);

  if (failedList.length > 0) {
    console.log('\n失败列表（前20条）:');
    failedList.forEach(f => console.log(`  ${f.order_no}: ${f.reason}`));
  }

  // 验证
  op._invalidate();
  const finalCount = op.all().length;
  console.log(`\n最终 order_products 记录数: ${finalCount}`);

  // 统计多产品订单数
  const orderProductCount = {};
  op.all().forEach(r => {
    orderProductCount[r.order_id] = (orderProductCount[r.order_id] || 0) + 1;
  });
  const multiProductOrders = Object.values(orderProductCount).filter(c => c > 1).length;
  console.log(`多产品订单数: ${multiProductOrders}`);

  console.log('\n=== 完成 ===');
}

main().catch(e => {
  console.error('同步失败:', e);
  process.exit(1);
});
