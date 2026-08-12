process.chdir(__dirname);
const { getTable } = require('./db');

// 检查bom_items的level字段分布
const bomItems = getTable('bom_items');
bomItems._invalidate();
const all = bomItems.all();

const levelDist = {};
all.forEach(b => {
  const lv = b.level || '(空)';
  levelDist[lv] = (levelDist[lv] || 0) + 1;
});

console.log('=== BOM Items level字段分布 ===');
Object.entries(levelDist).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
  console.log(`  level="${k}" -> ${v}条`);
});

// 检查material_code前缀分布
const prefixDist = {};
all.forEach(b => {
  const mc = (b.material_code || '').trim();
  const dotCount = (mc.match(/\./g) || []).length;
  prefixDist[dotCount] = (prefixDist[dotCount] || 0) + 1;
});

console.log('\n=== material_code点数分布 ===');
Object.entries(prefixDist).sort((a,b) => a[0]-b[0]).forEach(([k,v]) => {
  console.log(`  点数=${k} -> ${v}条`);
});

// 检查同一个product_code下的level分布
console.log('\n=== 样品product_code的level分布 ===');
const pcGroups = {};
all.forEach(b => {
  if (!pcGroups[b.product_code]) pcGroups[b.product_code] = [];
  pcGroups[b.product_code].push(b);
});

const samplePcs = Object.keys(pcGroups).slice(0, 3);
for (const pc of samplePcs) {
  const rows = pcGroups[pc];
  const levels = [...new Set(rows.map(r => r.level))];
  console.log(`\n  product_code: ${pc} (${rows.length}条)`);
  console.log(`  level值: ${levels.join(', ')}`);
  rows.slice(0, 5).forEach(r => {
    console.log(`    level="${r.level}" mc=${r.material_code} qty=${r.quantity}`);
  });
}

// 检查order_bom_details中的depth分布
console.log('\n=== order_bom_details depth分布 ===');
const det = getTable('order_bom_details');
det._invalidate();
const detAll = det.all();
const depthDist = {};
detAll.forEach(r => {
  depthDist[r.depth] = (depthDist[r.depth] || 0) + 1;
});
Object.entries(depthDist).sort((a,b) => a[0]-b[0]).forEach(([k,v]) => {
  console.log(`  depth=${k} -> ${v}条`);
});
