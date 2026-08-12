// 把订单审核台的计划成本回写到物料库成品（standard_cost / labor_cost）
// POST /api/material-costs/sync-from-orders
// 入参：{ order_no: "HJ..." } 或 { order_nos: ["...", "..."] }，{ dry_run: true }
// 行为：按指定 order_no 调订单分析库的 calcPlanCost 计算每产品 plan 物料成本和工价成本，
//       匹配物料库中 category='成品' 的同 material_code 行，写入 standard_cost/labor_cost。
//       落库后外部 sync 不再覆盖这两列（在 external-sync.js 已对成品做白名单豁免）。
const express = require('express');
const router = express.Router();
const path = require('path');
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

// 复用订单分析库的 calcPlanCost
const orderAnalysis = require('./order-analysis');

router.post('/sync-from-orders', requirePerm('material:edit'), async (req, res) => {
  try {
    const orderNos = []
      .concat(req.body.order_no ? [req.body.order_no] : [])
      .concat(Array.isArray(req.body.order_nos) ? req.body.order_nos : []);
    if (!orderNos.length) return res.status(400).json({ error: 'order_no 或 order_nos 必填' });
    const dryRun = !!req.body.dry_run;

    const orderTable = getTable('orders');
    const matTable = getTable('materials');
    matTable._invalidate();
    const matsByCode = {};
    matTable.all().forEach(m => { if (m.material_code) matsByCode[m.material_code] = m; });

    const ts = now();
    const summary = [];
    let totalUpdated = 0, totalSkipped = 0, totalUnmatched = 0;

    for (const orderNo of orderNos) {
      const order = orderTable.all().find(o => (o.order_no || '') === orderNo);
      if (!order) {
        summary.push({ order_no: orderNo, status: 'order_not_found' });
        continue;
      }
      let plan;
      try { plan = await orderAnalysis.calcPlanCost(order); }
      catch (e) {
        summary.push({ order_no: orderNo, status: 'calc_error', error: e.message });
        continue;
      }
      const productResults = [];
      for (const p of plan.products || []) {
        const mat = matsByCode[p.product_code];
        if (!mat) {
          totalUnmatched++;
          productResults.push({ product_code: p.product_code, status: 'not_in_material_library',
                                plan_material: p.material, plan_labor: p.labor });
          continue;
        }
        if (mat.category !== '成品') {
          totalSkipped++;
          productResults.push({ product_code: p.product_code, status: 'not_finished_product',
                                current_category: mat.category || '',
                                plan_material: p.material, plan_labor: p.labor });
          continue;
        }
        const newStd = Math.round(Number(p.material || 0) * 100) / 100;
        const newLab = Math.round(Number(p.labor || 0) * 100) / 100;
        const oldStd = Number(mat.standard_cost || 0);
        const oldLab = Number(mat.labor_cost || 0);
        if (!dryRun) {
          matTable.update(mat.id, { standard_cost: newStd, labor_cost: newLab, updated_at: ts });
        }
        totalUpdated++;
        productResults.push({
          product_code: p.product_code, material_id: mat.id, material_name: mat.material_name,
          status: dryRun ? 'preview' : 'updated',
          old: { standard_cost: oldStd, labor_cost: oldLab },
          new: { standard_cost: newStd, labor_cost: newLab },
          plan_material: p.material, plan_labor: p.labor
        });
      }
      summary.push({
        order_no: orderNo, order_id: order.id,
        plan_total: plan.total, plan_material: plan.material, plan_labor: plan.labor,
        products: productResults
      });
    }
    if (!dryRun) matTable._invalidate();
    res.json({
      message: dryRun
        ? `预览完成：${totalUpdated} 条将更新，${totalSkipped} 条非成品跳过，${totalUnmatched} 条未匹配到物料`
        : `同步完成：${totalUpdated} 条成品已写入 standard_cost/labor_cost，${totalSkipped} 条跳过，${totalUnmatched} 条未匹配`,
      dry_run: dryRun, total_updated: totalUpdated, total_skipped: totalSkipped, total_unmatched: totalUnmatched,
      orders: summary
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;