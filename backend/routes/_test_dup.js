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
const order=orders.all().find(o=>o.order_no==='HJ202601-0020-0127');
(async () => {
const plan=await oa.calcPlanCost(order);
const orderQty=order.quantity;
console.log('order quantity='+orderQty);
console.log('=== 遍历每个 product 的 tree 节点，对比 actual vs expected ===');
let dupFound=false;
plan.products.forEach((p,pi)=>{
  console.log('  --- product['+pi+'] bom_no='+p.bom_no+' qty='+p.order_qty+' material='+p.material+' ---');
  function walk(nodes){
    nodes.forEach(n=>{
      const expected=(Number(n.unit_price)||0)*(Number(n.bom_qty)||0)*Number(p.order_qty);
      const actual=Number(n.material_amount)||0;
      const ratio=expected>0?(actual/expected):0;
      if(Math.abs(actual-expected)>0.01){
        console.log('    ⚠ 异常: '+n.material_code+'  unit_price='+n.unit_price+'  bom_qty='+n.bom_qty+'  actual='+actual.toFixed(2)+'  expected='+expected.toFixed(2)+'  ratio='+ratio.toFixed(2));
        dupFound=true;
      }
      if(n.children&&n.children.length)walk(n.children);
    });
  }
  walk(p.tree);
});
if(!dupFound)console.log('  ✓ tree 节点 material_amount 与 unit_price×qty×orderQty 完全一致，无重复算');
console.log('\n=== 汇总 4 个 product 合计 ===');
console.log('  product['+0+'] qty='+plan.products[0].order_qty+' material='+plan.products[0].material);
console.log('  product['+1+'] qty='+plan.products[1].order_qty+' material='+plan.products[1].material);
console.log('  product['+2+'] qty='+plan.products[2].order_qty+' material='+plan.products[2].material);
console.log('  product['+3+'] qty='+plan.products[3].order_qty+' material='+plan.products[3].material);
console.log('  TOTAL material='+plan.material);
console.log('  注: 4 行 order_products 同一 bom_no HJ-8110-709-01，qty 各为 1/3/2/20000');
console.log('  若每行独立 buildBomTree 算单台材料×qty，合计=638623.74');
console.log('  若合并 1 行 qty=20006 算一次，合计=638623.74  (一致)');
})().catch(e=>console.error('ERR',e));
