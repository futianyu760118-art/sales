const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const routeSource = fs.readFileSync(path.join(root, 'backend', 'routes', 'order-analysis.js'), 'utf8');
const laborRateSource = fs.readFileSync(path.join(root, 'backend', 'routes', 'product-labor-rate.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'frontend', 'order-analysis.html'), 'utf8');

// These contracts intentionally fail until the order-analysis change is implemented.
assert.match(routeSource, /VOID_MANUAL_ONLY/, 'void orders must have a manual-only policy');
assert.match(routeSource, /gross_margin_analysis/, 'negative gross margin analysis must be returned');
assert.match(routeSource, /void_status/, 'the API must support active/void/all filtering');
assert.match(pageSource, /header-filter-row/, 'the audit table must expose header filters');
assert.match(pageSource, /pageStart/, 'the audit table must render numbered pagination');
assert.match(pageSource, /原因分析/, 'negative gross margin rows must expose reason analysis');

const rules = require(path.join(root, 'backend', 'lib', 'order-analysis-rules'));

assert.equal(rules.isVoidAdjustmentAllowed({ isVoid: 1, source: 'external_sync' }), false);
assert.equal(rules.isVoidAdjustmentAllowed({ isVoid: 1, source: 'manual' }), true);
assert.equal(rules.isVoidAdjustmentAllowed({ isVoid: 0, source: 'external_sync' }), true);

const analysis = rules.buildGrossMarginAnalysis({
  orderAmount: 100,
  materialCost: 90,
  laborCost: 20,
  expenseCost: 5,
  warnings: ['BOM 单价缺失']
});
assert.equal(analysis.is_negative, true);
assert.equal(analysis.gross_profit, -15);
assert.equal(analysis.gross_rate, -15);
assert.deepEqual(analysis.cost_composition, {
  material: { amount: 90, rate: 90 },
  labor: { amount: 20, rate: 20 },
  expense: { amount: 5, rate: 5 }
});
assert.deepEqual(analysis.reasons.map(item => item.code), [
  'TOTAL_COST_EXCEEDS_REVENUE',
  'MATERIAL_COST',
  'LABOR_COST',
  'EXPENSE_COST',
  'DATA_WARNING'
]);
assert.match(analysis.suggestions.join(' '), /BOM/);

assert.deepEqual(rules.paginate(['a', 'b', 'c', 'd', 'e'], 2, 2), {
  page: 2,
  limit: 2,
  total: 5,
  pages: 3,
  items: ['c', 'd']
});

assert.deepEqual(rules.ALLOWED_SORT_FIELDS.includes('quantity'), true);
assert.deepEqual(rules.ALLOWED_SORT_FIELDS.includes('gross_profit'), true);
assert.deepEqual(rules.ALLOWED_SORT_FIELDS.includes('cost_variance'), true);

const syncedRates = rules.syncProductRatesFromLibrary(
  [{ bom_no: 'P-001' }, { bom_no: 'P-002' }, { bom_no: 'P-003' }],
  [
    { bom_no: 'P-001', labor_rate: 12, audit_status: 'approved', effective_date: '2026-01-01' },
    { bom_no: 'P-002', labor_rate: 8, audit_status: 'pending', effective_date: '2026-01-01' },
    { bom_no: 'P-003', labor_rate: 0, audit_status: 'approved', effective_date: '2026-01-01' }
  ],
  { 'P-001': 3, 'P-002': 4, 'P-003': 5 }
);
assert.deepEqual(syncedRates.rates, { 'P-001': 12, 'P-002': 4, 'P-003': 5 });
assert.deepEqual(syncedRates.updated, ['P-001']);
assert.deepEqual(syncedRates.unmatched, ['P-002', 'P-003']);
assert.match(routeSource, /if \(!card && Object\.keys\(result\.rates\)\.length\)/,
  'orders without an analysis card must create one when the library has a product rate');
assert.match(routeSource, /fast === '1'/, 'dashboard stats must support a fast snapshot mode');
assert.match(laborRateSource, /!source && r\.source === 'pricing_import'/,
  'pricing-import labor rates must be hidden from the default list');
const productsWithLibraryRates = [{ bom_no: 'P-001', labor_rate: 0 }, { bom_no: 'P-002', labor_rate: 9 }];
assert.equal(rules.applyApprovedLaborRates(productsWithLibraryRates, { 'P-001': 12, 'P-002': 0 }), 1);
assert.equal(productsWithLibraryRates[0].labor_rate, 12);

console.log('order analysis regression checks passed');
