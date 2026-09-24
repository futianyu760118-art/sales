'use strict';

const ALLOWED_SORT_FIELDS = Object.freeze([
  'id', 'order_no', 'customer_name', 'order_amount', 'status', 'promised_date', 'created_at',
  'quantity', 'plan_total_cost', 'purchase_confirm_cost', 'actual_total_cost',
  'gross_profit', 'gross_rate', 'actual_gross_profit', 'actual_gross_rate', 'cost_variance',
  'review_status'
]);

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function isVoidAdjustmentAllowed({ isVoid, source = 'automatic' } = {}) {
  return Number(isVoid) !== 1 || source === 'manual';
}

function buildGrossMarginAnalysis(input = {}) {
  const orderAmount = round(toFiniteNumber(input.orderAmount));
  const materialCost = round(toFiniteNumber(input.materialCost));
  const laborCost = round(toFiniteNumber(input.laborCost));
  const expenseCost = round(toFiniteNumber(input.expenseCost));
  const totalCost = round(input.planCost == null
    ? materialCost + laborCost + expenseCost
    : toFiniteNumber(input.planCost));
  const grossProfit = round(input.grossProfit == null ? orderAmount - totalCost : toFiniteNumber(input.grossProfit));
  const hasFiniteGrossRate = input.grossRate != null && Number.isFinite(Number(input.grossRate));
  const grossRate = !hasFiniteGrossRate
    ? (orderAmount > 0 ? round(grossProfit / orderAmount * 100) : null)
    : round(toFiniteNumber(input.grossRate));
  const isNegative = grossRate != null ? grossRate < 0 : grossProfit < 0;
  const reasons = [];
  const suggestions = [];
  const composition = {
    material: { amount: materialCost, rate: orderAmount > 0 ? round(materialCost / orderAmount * 100) : null },
    labor: { amount: laborCost, rate: orderAmount > 0 ? round(laborCost / orderAmount * 100) : null },
    expense: { amount: expenseCost, rate: orderAmount > 0 ? round(expenseCost / orderAmount * 100) : null }
  };

  if (!isNegative) {
    return {
      is_negative: false,
      order_amount: orderAmount,
      total_cost: totalCost,
      gross_profit: grossProfit,
      gross_rate: grossRate,
      cost_composition: composition,
      reasons,
      suggestions,
      source_warnings: Array.isArray(input.warnings) ? input.warnings : []
    };
  }

  if (orderAmount <= 0) {
    reasons.push({ code: 'ORDER_AMOUNT_INVALID', label: '订单金额异常', detail: '订单金额小于等于 0，毛利率不可作为有效经营口径。' });
    suggestions.push('先核对订单金额、币种和订单行金额。');
  }
  if (totalCost > orderAmount) {
    reasons.push({
      code: 'TOTAL_COST_EXCEEDS_REVENUE',
      label: '总成本超过订单金额',
      detail: `总成本 ${totalCost} 大于订单金额 ${orderAmount}，超额 ${round(totalCost - orderAmount)}。`
    });
  }

  const costReasons = [
    ['material', 'MATERIAL_COST', '物料成本占比', '检查 BOM 用量、物料最新价格和采购确认价。'],
    ['labor', 'LABOR_COST', '人工成本占比', '检查产品工价、工序数量和人工归集是否重复。'],
    ['expense', 'EXPENSE_COST', '费用成本占比', '检查制造费用、分摊规则和费用归属。']
  ];
  costReasons.forEach(([key, code, label, suggestion]) => {
    const item = composition[key];
    if (item.amount > 0) {
      reasons.push({ code, label, detail: `${label} ${item.rate == null ? '-' : item.rate + '%'}（金额 ${item.amount}）。` });
      suggestions.push(suggestion);
    }
  });

  (Array.isArray(input.warnings) ? input.warnings : []).forEach(warning => {
    if (!warning) return;
    reasons.push({ code: 'DATA_WARNING', label: '成本数据待核对', detail: String(warning) });
  });
  if (!suggestions.length) suggestions.push('检查订单金额、BOM、工价和费用归集数据。');

  return {
    is_negative: true,
    order_amount: orderAmount,
    total_cost: totalCost,
    gross_profit: grossProfit,
    gross_rate: grossRate,
    cost_composition: composition,
    reasons,
    suggestions: [...new Set(suggestions)],
    source_warnings: Array.isArray(input.warnings) ? input.warnings : []
  };
}

function paginate(items, page = 1, limit = 30) {
  const records = Array.isArray(items) ? items : [];
  const safeLimit = Math.max(1, Number(limit) || 30);
  const pages = Math.max(1, Math.ceil(records.length / safeLimit));
  const safePage = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (safePage - 1) * safeLimit;
  return {
    page: safePage,
    limit: safeLimit,
    total: records.length,
    pages,
    items: records.slice(start, start + safeLimit)
  };
}

function syncProductRatesFromLibrary(products = [], libraryRows = [], existingRates = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const approved = new Map();
  (Array.isArray(libraryRows) ? libraryRows : []).forEach(row => {
    if (!row || row.audit_status !== 'approved') return;
    if (row.effective_date && String(row.effective_date) > today) return;
    if (row.expire_date && String(row.expire_date) < today) return;
    const key = String(row.bom_no || '').trim();
    const rate = toFiniteNumber(row.labor_rate);
    if (!key || rate <= 0) return;
    const previous = approved.get(key);
    const newer = !previous || String(row.updated_at || '') > String(previous.updated_at || '') ||
      (String(row.updated_at || '') === String(previous.updated_at || '') && Number(row.id) > Number(previous.id));
    if (newer) approved.set(key, row);
  });

  const rates = { ...(existingRates && typeof existingRates === 'object' ? existingRates : {}) };
  const updated = [];
  const unmatched = [];
  const seen = new Set();
  (Array.isArray(products) ? products : []).forEach(product => {
    const key = String(product && (product.bom_no || product.product_code) || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    const source = approved.get(key);
    if (!source) {
      unmatched.push(key);
      return;
    }
    const rate = toFiniteNumber(source.labor_rate);
    if (rates[key] !== rate) updated.push(key);
    rates[key] = rate;
  });
  return { rates, updated, unmatched };
}

function applyApprovedLaborRates(products = [], approvedRateMap = {}) {
  let applied = 0;
  (Array.isArray(products) ? products : []).forEach(product => {
    const key = String(product && product.bom_no || '').trim();
    const rate = toFiniteNumber(approvedRateMap[key]);
    if (!product || !key || rate <= 0) return;
    product.labor_rate = rate;
    applied++;
  });
  return applied;
}

module.exports = {
  ALLOWED_SORT_FIELDS,
  isVoidAdjustmentAllowed,
  buildGrossMarginAnalysis,
  paginate,
  syncProductRatesFromLibrary,
  applyApprovedLaborRates
};
