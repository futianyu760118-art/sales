console.log('=== 重新同步BOM明细（修复总用量：用 calcPlanCost/buildBomTree 级联计算） ===');
process.chdir(__dirname);

const { getTable, ensureTable } = require('./db');
const orderAnalysis = require('./routes/order-analysis');
const syncOrderBomDetails = orderAnalysis.syncOrderBomDetails;

ensureTable('order_bom_details');

async function main() {
  const orders = getTable('orders');
  orders._invalidate();
  const allOrders = orders.all();
  const ordersWithProduct = allOrders.filter(o => o.product_code && o.product_code.trim());

  console.log(`总订单数: ${allOrders.length}`);
  console.log(`有产品编码的订单数: ${ordersWithProduct.length}`);

  // 先清空所有旧明细（简化版脚本写入的数据有 depth/total_qty 错误）
  const det = getTable('order_bom_details');
  det._invalidate();
  const beforeCount = det.all().length;
  console.log(`清空前 BOM明细数: ${beforeCount}`);
  await det.deleteWhereNoSave(() => true);
  console.log('已清空旧明细（内存）');

  let synced = 0, skipped = 0, failed = 0;
  let totalRecords = 0;
  const failedList = [];

  for (let i = 0; i < ordersWithProduct.length; i++) {
    const o = ordersWithProduct[i];
    try {
      // skipCacheClear: 批量场景由外层统一管理缓存
      // skipSave: 批量模式，跳过逐单落盘
      const r = await syncOrderBomDetails(o.id, { skipCacheClear: true, skipSave: true });
      if (r.ok) {
        synced++;
        totalRecords += r.synced || 0;
      } else {
        skipped++;
      }
    } catch (e) {
      failed++;
      if (failedList.length < 20) {
        failedList.push({ id: o.id, order_no: o.order_no, reason: e.message });
      }
    }

    if ((i + 1) % 100 === 0) {
      console.log(`进度: ${i + 1}/${ordersWithProduct.length} (已同步: ${synced}, 跳过: ${skipped}, 失败: ${failed}, 记录数: ${totalRecords})`);
    }
  }

  // 统一落盘
  console.log(`\n同步完成，准备落盘...`);
  console.log(`缓存记录数: ${det._cache ? det._cache.records.length : 'null'}`);
  const saveResult = await det.saveNow();
  console.log(`saveNow 结果:`, saveResult);
  det._invalidate();

  console.log(`\n重新同步完成！`);
  console.log(`  已同步: ${synced}`);
  console.log(`  跳过: ${skipped}`);
  console.log(`  失败: ${failed}`);
  console.log(`  生成记录数: ${totalRecords}`);

  if (failedList.length > 0) {
    console.log('\n失败列表（前20条）:');
    failedList.forEach(f => console.log(`  ${f.order_no}: ${f.reason}`));
  }

  // 验证结果
  det._invalidate();
  const allDetails = det.all();
  const depthDist = {};
  allDetails.forEach(r => {
    depthDist[r.depth] = (depthDist[r.depth] || 0) + 1;
  });
  console.log('\n=== 验证结果 ===');
  console.log('BOM明细总数:', allDetails.length);
  console.log('depth分布:', depthDist);

  // 抽查 HJ201903-0020-0046
  const target = allDetails.filter(r => r.order_no === 'HJ201903-0020-0046');
  if (target.length > 0) {
    const order = orders.all().find(o => o.order_no === 'HJ201903-0020-0046');
    console.log(`\n=== HJ201903-0020-0046 验证 ===`);
    console.log(`订单: qty=${order.quantity} amount=${order.order_amount} bom_no=${order.bom_no || '(空)'}`);
    console.log(`明细数: ${target.length}`);
    const sumMat = target.reduce((s, r) => s + (Number(r.material_amount) || 0), 0);
    console.log(`material_amount 总和: ${Math.round(sumMat * 100) / 100}`);
    if (order.order_amount) {
      console.log(`毛利率: ${Math.round((order.order_amount - sumMat) / order.order_amount * 10000) / 100}%`);
    }
    // LD-03 检查
    const ld03 = target.filter(r => r.material_code && r.material_code.includes('LD-03'));
    console.log(`LD-03 记录数: ${ld03.length}`);
    ld03.forEach(r => {
      console.log(`  depth=${r.depth} path=${r.path} | bom_qty=${r.bom_qty} total_qty=${r.total_qty} | unit_price=${r.unit_price} amt=${r.material_amount}`);
    });
  }

  console.log('\n=== 完成 ===');
}

main().catch(e => {
  console.error('同步失败:', e);
  process.exit(1);
});
