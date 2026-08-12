const Module=require('module');
const orig=Module.prototype.require;
Module.prototype.require=function(name){
  if(name==='express'){
    const noop=()=>{};
    const ro={get:noop,post:noop,put:noop,delete:noop,patch:noop,use:noop,all:noop,head:noop,options:noop};
    const e=function(){return ro;}; e.Router=function(){return ro;};
    e.json=()=>noop; e.urlencoded=()=>noop; e.static=()=>noop;
    return e;
  }
  return orig.apply(this,arguments);
};
const oa=require('./order-analysis');
const {getTable}=require('../db');
const orders=getTable('orders'); orders._invalidate();
const op=getTable('order_products'); op._invalidate();
const order=orders.all().find(o=>o.order_no==='HJ202601-0020-0127');
console.log('=== 0020-0127 真实成本反推: 每台100元 ===');
console.log('用户给的基准: 20006台 × ~100元/台 = ¥2,000,600 ≈ 订单金额 ¥2,110,000');
console.log('我之前算的 (脏 BOM 19行): 31.92/台 (材料) + 4/台 (工价) = 35.92/台 ← 严重偏低');
console.log('');

// 直接用 calcPlanCost 算，但越过去 bom_no 优先级匹配脏 BOM
// 强制走 158 行干净 BOM (product_code=3.1.HJ-8110-001)
const DirectCalc = oa.calcPlanCost;
// calcPlanCost 内部会先试 bom_no=HJ-8110-709-01 (脏 19行)，且不走 product_code 回退
// 我们直接用 buildBomTree 算 158 行 BOM
console.log('=== 对比: 19行脏 BOM vs 158行干净 BOM 的单台材料 ===');
console.log('--- 19行脏 BOM (HJ-8110-709-01) ---');
const r1=DirectCalc(order);
console.log('  material='+r1.material+' tree节点='+r1.products[0].tree.length+' → 单台材料='+(r1.material/20006).toFixed(2));

// 手动构造 candidates 优先 3.1.HJ-8110-001
// 通过修改 order.bom_no=空，让 candidates 走 product_code
const order2={...order, bom_no:''};
const r2=DirectCalc(order2);
console.log('--- 158行干净 BOM (3.1.HJ-8110-001, 清空bom_no让系统选product_code) ---');
if(r2.products[0].tree.length===158){
  console.log('  material='+r2.material+' tree节点='+r2.products[0].tree.length+' → 单台材料='+(r2.material/20006).toFixed(2));
  console.log('  ✓ 若≈100元/台 → 158行 BOM 是权威 BOM');
}else{
  console.log('  tree节点='+r2.products[0].tree.length+' (仍走了脏 BOM)');
  console.log('  完整返回: '+JSON.stringify(r2.products.map(p=>({bom_no:p.bom_no,material:p.material,tree_len:p.tree?p.tree.length:0}))));
}
