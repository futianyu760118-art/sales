// ============================================================
// 0020-0127 重复成本诊断脚本 —— 在【运行的系统】上跑
// 用法: cd backend/routes && node _test_real_calc.js
// ============================================================
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

const ORDER_NO='HJ202601-0020-0127';
const orders=getTable('orders'); orders._invalidate();
const op=getTable('order_products'); op._invalidate();
const det=getTable('order_bom_details'); det._invalidate();
const order=orders.all().find(o=>o.order_no===ORDER_NO);
if(!order){console.error('未找到 '+ORDER_NO);process.exit(1);}

console.log('═════════ '+ORDER_NO+' 重复成本诊断 ═════════');
console.log('orders 表该订单记录数: '+orders.all().filter(o=>o.order_no===ORDER_NO).length);

const opRows=op.all().filter(r=>r.order_no===ORDER_NO);
console.log('\n【order_products】行数: '+opRows.length+'  (预期4)');
const byId={};
opRows.forEach(r=>{const k='order_id='+r.order_id;(byId[k]=byId[k]||[]).push(r);});
Object.entries(byId).forEach(([k,rs])=>{
  console.log('  '+k+' → '+rs.length+'行  qty和='+rs.reduce((s,r)=>s+(r.quantity||0),0)+'  amount和='+rs.reduce((s,r)=>s+(r.amount||0),0));
  rs.forEach(r=>console.log('    line_no='+(r.line_no||'')+'  qty='+(r.quantity||0)+'  amount='+(r.amount||0)+'  bom_no='+(r.bom_no||'')+'  src='+(r.source||'')));
});

const detRows=det.all().filter(r=>r.order_no===ORDER_NO);
const detMat=detRows.reduce((s,r)=>s+(Number(r.material_amount)||0),0);
console.log('\n【order_bom_details】行数: '+detRows.length+'  (预期76=4组×19)');
console.log('  material_amount 总和: '+detMat.toFixed(2)+'  (预期≈638815)');

(async () => {
const plan=await oa.calcPlanCost(order);
console.log('\n【calcPlanCost 实时结果】');
console.log('  material='+plan.material+'  labor='+plan.labor+'  expense='+plan.expense+'  total='+plan.total);
console.log('  products='+plan.products.length+'行');
console.log('\n═════════ 判定 ═════════');
console.log('  若 order_products 行数 > 4 → 同步重复累积（calcPlanCost逐行累加翻倍）');
console.log('  若 order_bom_details 行数 > 76 → BOM明细重复写入（明细汇总翻倍）');
console.log('  若两者都正常但 calcPlanCost total ≈ 3803047 → 算法/单价差异，需对比 bom_items');
})().catch(e=>console.error('ERR',e));
