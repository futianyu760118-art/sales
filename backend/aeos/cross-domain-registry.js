const REGISTRATIONS = Object.freeze([
  { dataset: 'orders', sourceModule: 'M05', consumer: 'M03', purpose: 'management aggregation during migration', contractVersion: 'AEOS.Result.V1', owner: 'Sales Autonomy Owner', deprecationCondition: 'M05 Result API accepted', allowedFields: ['id', 'order_no', 'status', 'customer_id', 'amount', 'gross_margin'], authoritative: false },
  { dataset: 'projects', sourceModule: 'M04', consumer: 'M03', purpose: 'management aggregation during migration', contractVersion: 'AEOS.Result.V1', owner: 'R&D Autonomy Owner', deprecationCondition: 'M04 Result API accepted', allowedFields: ['id', 'name', 'status', 'owner_id', 'progress'], authoritative: false },
  { dataset: 'materials', sourceModule: 'M06/M02', consumer: 'M03', purpose: 'exception aggregation during migration', contractVersion: 'AEOS.Exception.V1', owner: 'Delivery & Data Owner', deprecationCondition: 'governed material API accepted', allowedFields: ['id', 'material_no', 'name', 'status', 'stock'], authoritative: false },
  { dataset: 'finance_results', sourceModule: 'M09', consumer: 'M03', purpose: 'authoritative finance result consumption', contractVersion: 'AEOS.Result.V1', owner: 'Finance Autonomy Owner', deprecationCondition: 'none; governed result interface', allowedFields: ['id', 'metric', 'calculation_version', 'evidence_ids', 'status'], authoritative: true },
  { dataset: 'material_costs', sourceModule: 'M09', consumer: 'M03', purpose: 'migration comparison only', contractVersion: 'AEOS.Result.V1', owner: 'Finance Autonomy Owner', deprecationCondition: 'M09 result parity accepted', allowedFields: ['id', 'material_id', 'amount', 'currency'], authoritative: false }
]);

function getRegistration(dataset, consumer = 'M03') {
  return REGISTRATIONS.find(item => item.dataset === dataset && item.consumer === consumer) || null;
}

module.exports = { REGISTRATIONS, getRegistration };
