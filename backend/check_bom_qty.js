process.chdir(__dirname);
const { getTable } = require('./db');

// 检查BOM明细中的层级和总用量
const det = getTable('order_bom_details');
det._invalidate();
const all = det.all();

console.log('=== BOM明细总用量检查 ===');
console.log('总记录数:', all.length);

// 按订单分组，找有多个层级的订单
const orderGroups = {};
all.forEach(r => {
  if (!orderGroups[r.order_id]) orderGroups[r.order_id] = [];
  orderGroups[r.order_id].push(r);
});

// 找有多层级的订单
let multiLevelOrders = 0;
let sampleOrders = [];
for (const [orderId, rows] of Object.entries(orderGroups)) {
  const depths = [...new Set(rows.map(r => r.depth))];
  if (depths.length > 1 || Math.max(...depths) > 1) {
    multiLevelOrders++;
    if (sampleOrders.length < 3) {
      sampleOrders.push({ orderId, rows, depths });
    }
  }
}

console.log('有多层级的订单数:', multiLevelOrders);

// 检查一个有层级结构的订单
for (const sample of sampleOrders) {
  console.log('\n--- 订单ID:', sample.orderId, ' 层级:', sample.depths.join(','), ' ---');
  sample.rows.sort((a, b) => (a.path || '').localeCompare(b.path || ''));
  sample.rows.forEach(r => {
    console.log(`  depth=${r.depth} path=${r.path || ''} code=${r.material_code} bom_qty=${r.bom_qty} total_qty=${r.total_qty} mat_amt=${r.material_amount} rollup=${r.material_rollup}`);
  });
}

// 检查bom_items的level字段格式
console.log('\n=== BOM Items level字段格式检查 ===');
const bomItems = getTable('bom_items');
bomItems._invalidate();
const bomSample = bomItems.all().slice(0, 20);
bomSample.forEach(b => {
  console.log(`  product_code=${b.product_code} level="${b.level}" material_code=${b.material_code} qty=${b.quantity}`);
});

// 检查levelDepth函数对不同level值的解析
console.log('\n=== levelDepth解析检查 ===');
function levelDepth(line) {
  const s = String(line.level || '.1').trim();
  if (s.indexOf('0') === 0) return 0;
  let d = 0;
  for (const ch of s) { if (ch === '.') d++; else break; }
  return d || 1;
}
const testLevels = ['1', '2', '3', '.1', '..2', '...3', '1.2', '2.3.1'];
testLevels.forEach(l => {
  console.log(`  level="${l}" -> depth=${levelDepth({level: l})}`);
});
