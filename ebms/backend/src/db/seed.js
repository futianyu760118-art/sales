/**
 * 链路底座种子数据。
 *
 * 这是全库唯一的写入口 —— 反向查询链路在代码层面无法写库（仓储只有 SELECT）。
 *
 * 数据覆盖 AC 前置条件与边界：
 *   - 3 条 Result（毛利率 / 按期交付率 / 库存周转天数），由 M09 / M06 / M11 供给；
 *   - 10 条归因项，含 Exception 型与 M03 自有归因分析型，且覆盖多级展开；
 *   - 14 条 Evidence，含 1 条 source_system 未标注、1 条无任何归因关联（空态用）；
 *   - 15 组 (Evidence, Result) 关联对，满足「抽样不少于 10 条比对」。
 */

const NOW = '2026-09-26T10:00:00+08:00';

const METRICS = [
  {
    id: 'M-GM',
    result_id: 'RES-GM-202609',
    code: 'gross_margin',
    name: '毛利率',
    source_system: 'M09',
    object_id: 'gross_margin',
    period_type: 'month',
    period_value: '2026-09',
    target: 32,
    actual: 27.4,
    unit: 'percent',
    calculation_version: 'M09-GM-V1',
  },
  {
    id: 'M-OTD',
    result_id: 'RES-OTD-202609',
    code: 'on_time_delivery_rate',
    name: '订单按期交付率',
    source_system: 'M06',
    object_id: 'on_time_delivery_rate',
    period_type: 'month',
    period_value: '2026-09',
    target: 96,
    actual: 88.5,
    unit: 'percent',
    calculation_version: 'M06-OTD-V1',
  },
  {
    id: 'M-INV',
    result_id: 'RES-INV-202609',
    code: 'inventory_turnover_days',
    name: '库存周转天数',
    source_system: 'M11',
    object_id: 'inventory_turnover_days',
    period_type: 'month',
    period_value: '2026-09',
    target: 45,
    actual: 58,
    unit: 'day',
    calculation_version: 'M11-INV-V1',
  },
];

const EXCEPTIONS = [
  { id: 'X-COST1', exception_id: 'EXC-COST-001', source_system: 'M04', object_type: 'BOM', object_id: 'BOM-2026-09', reason_code: 'BOM_COST_OVERRUN', severity: 'high' },
  { id: 'X-COST2', exception_id: 'EXC-COST-002', source_system: 'M11', object_type: 'PurchaseOrder', object_id: 'PO-2026-09', reason_code: 'PURCHASE_PRICE_UP', severity: 'medium' },
  { id: 'X-DELAY1', exception_id: 'EXC-DELAY-001', source_system: 'M06', object_type: 'DeliveryOrder', object_id: 'SO-2026-09', reason_code: 'DELIVERY_RISK', severity: 'high' },
  { id: 'X-QUAL1', exception_id: 'EXC-QUALITY-001', source_system: 'M06', object_type: 'InspectionLot', object_id: 'QC-2026-09', reason_code: 'QUALITY_REJECT', severity: 'high' },
  { id: 'X-STOCK1', exception_id: 'EXC-STOCK-001', source_system: 'M11', object_type: 'InventoryLot', object_id: 'INV-2026-09', reason_code: 'SLOW_MOVING_STOCK', severity: 'medium' },
];

const EVIDENCES = [
  { id: 'V-BOM', evidence_id: 'EVD-BOM-001', type: 'document', title: 'BOM 成本变更单', formed_at: '2026-09-03', owner: '工艺部', source_system: 'MES', object_type: 'BOM', object_id: 'BOM-2026-09' },
  { id: 'V-PO1', evidence_id: 'EVD-PO-001', type: 'contract', title: '采购框架合同补充协议', formed_at: '2026-09-05', owner: '采购部', source_system: 'ERP-PROC', object_type: 'PurchaseOrder', object_id: 'PO-2026-09' },
  { id: 'V-CRM', evidence_id: 'EVD-CRM-001', type: 'system_record', title: '订单价格台账', formed_at: '2026-09-06', owner: '销售中心', source_system: 'CRM', object_type: 'SalesOrder', object_id: 'SO-2026-09' },
  { id: 'V-MES1', evidence_id: 'EVD-MES-001', type: 'system_record', title: 'MES 生产工单记录', formed_at: '2026-09-07', owner: '生产部', source_system: 'MES', object_type: 'WorkOrder', object_id: 'WO-2026-09' },
  { id: 'V-QC', evidence_id: 'EVD-QC-001', type: 'system_record', title: '来料检验报告', formed_at: '2026-09-08', owner: '品质部', source_system: 'MES-QC', object_type: 'InspectionLot', object_id: 'QC-2026-09' },
  { id: 'V-PLAN', evidence_id: 'EVD-PLAN-001', type: 'manual_note', title: '排产插单说明', formed_at: '2026-09-09', owner: '计划部', source_system: 'OA', object_type: 'Schedule', object_id: 'SCH-2026-09' },
  { id: 'V-WMS', evidence_id: 'EVD-WMS-001', type: 'system_record', title: 'WMS 库龄报表', formed_at: '2026-09-10', owner: '仓储部', source_system: 'WMS', object_type: 'InventoryLot', object_id: 'INV-2026-09' },
  { id: 'V-PO2', evidence_id: 'EVD-PO-002', type: 'contract', title: '供应商调价函', formed_at: '2026-09-11', owner: '采购部', source_system: 'ERP-PROC', object_type: 'PurchaseOrder', object_id: 'PO-2026-09' },
  { id: 'V-INV1', evidence_id: 'EVD-INV-001', type: 'manual_note', title: '安全库存策略评审纪要', formed_at: '2026-09-12', owner: '供应链中心', source_system: 'OA', object_type: 'InventoryPolicy', object_id: 'INVP-2026' },
  { id: 'V-FIN1', evidence_id: 'EVD-FIN-001', type: 'document', title: '财务共享成本结转', formed_at: '2026-09-13', owner: '财务中心', source_system: 'FIN-SHARE', object_type: 'CostCarryover', object_id: 'CC-2026-09' },
  { id: 'V-FIN2', evidence_id: 'EVD-FIN-002', type: 'document', title: '财务月度快报', formed_at: '2026-09-14', owner: '财务中心', source_system: 'FIN-SHARE', object_type: 'FinancialReport', object_id: 'FR-2026-09' },
  // 边界：source_system 未标注（PAND-83「来源未标注」）
  { id: 'V-NOSRC', evidence_id: 'EVD-NOSRC-001', type: 'system_record', title: '现场停机记录', formed_at: '2026-09-15', owner: '生产部', source_system: null, object_type: 'Equipment', object_id: 'EQ-2026-09' },
  // 边界：无任何归因关联（反向空态）
  { id: 'V-ORPHAN', evidence_id: 'EVD-ORPHAN-001', type: 'document', title: '孤立凭证（无归因关联）', formed_at: '2026-09-16', owner: '采购部', source_system: 'ERP-PROC', object_type: 'PurchaseOrder', object_id: 'PO-2026-09' },
  { id: 'V-MES2', evidence_id: 'EVD-MES-002', type: 'system_record', title: 'MES 设备停机记录', formed_at: '2026-09-17', owner: '设备部', source_system: 'MES', object_type: 'Equipment', object_id: 'EQ-2026-09' },
];

// kind='exception' 必须挂 Exception；kind='m03_analysis' 必须带分析名且不挂 Exception
const ATTRIBUTIONS = [
  { id: 'A-COST1', metric_id: 'M-GM', parent_id: null, kind: 'exception', exception_id: 'X-COST1', analysis_name: null, direction: 'negative', contribution_pct: 40, owner: '生产·交付中心', order_no: 1 },
  { id: 'A-COST1-1', metric_id: 'M-GM', parent_id: 'A-COST1', kind: 'm03_analysis', exception_id: null, analysis_name: '原材料规格变更致返工', direction: 'negative', contribution_pct: 55, owner: 'M03', order_no: 1 },
  { id: 'A-COST2', metric_id: 'M-GM', parent_id: null, kind: 'exception', exception_id: 'X-COST2', analysis_name: null, direction: 'negative', contribution_pct: 28, owner: '供应链中心', order_no: 2 },
  { id: 'A-PRICE', metric_id: 'M-GM', parent_id: null, kind: 'm03_analysis', exception_id: null, analysis_name: '低价订单占比上升', direction: 'negative', contribution_pct: 32, owner: 'M03', order_no: 3 },

  { id: 'A-DELAY1', metric_id: 'M-OTD', parent_id: null, kind: 'exception', exception_id: 'X-DELAY1', analysis_name: null, direction: 'negative', contribution_pct: 45, owner: '生产·交付中心', order_no: 1 },
  { id: 'A-QUAL1', metric_id: 'M-OTD', parent_id: null, kind: 'exception', exception_id: 'X-QUAL1', analysis_name: null, direction: 'negative', contribution_pct: 25, owner: '生产·交付中心', order_no: 2 },
  { id: 'A-PLAN', metric_id: 'M-OTD', parent_id: null, kind: 'm03_analysis', exception_id: null, analysis_name: '排产插单频繁', direction: 'negative', contribution_pct: 30, owner: 'M03', order_no: 3 },

  { id: 'A-STOCK1', metric_id: 'M-INV', parent_id: null, kind: 'exception', exception_id: 'X-STOCK1', analysis_name: null, direction: 'negative', contribution_pct: 60, owner: '供应链中心', order_no: 1 },
  { id: 'A-COST2-INV', metric_id: 'M-INV', parent_id: null, kind: 'exception', exception_id: 'X-COST2', analysis_name: null, direction: 'negative', contribution_pct: 15, owner: '供应链中心', order_no: 2 },
  { id: 'A-SAFETY', metric_id: 'M-INV', parent_id: null, kind: 'm03_analysis', exception_id: null, analysis_name: '安全库存策略偏保守', direction: 'negative', contribution_pct: 25, owner: 'M03', order_no: 3 },
];

// [attribution_id, evidence_id]
const LINKS = [
  ['A-COST1', 'V-BOM'],
  ['A-COST1-1', 'V-BOM'],
  ['A-COST1', 'V-FIN1'],
  ['A-COST2', 'V-PO1'],
  ['A-COST2', 'V-PO2'],
  ['A-COST2-INV', 'V-PO2'],
  ['A-COST2-INV', 'V-FIN2'],
  ['A-PRICE', 'V-CRM'],
  ['A-PRICE', 'V-FIN2'],
  ['A-DELAY1', 'V-MES1'],
  ['A-DELAY1', 'V-NOSRC'],
  ['A-DELAY1', 'V-MES2'],
  ['A-QUAL1', 'V-QC'],
  ['A-QUAL1', 'V-MES2'],
  ['A-PLAN', 'V-PLAN'],
  ['A-STOCK1', 'V-WMS'],
  ['A-SAFETY', 'V-INV1'],
];

const SEED_AUDIT = [
  { actor: 'seed', action: 'SEED_CHAIN', entity_type: 'result_metric', entity_id: 'M-GM', detail: '底座种子：Result/Exception/Evidence 关联建立' },
  { actor: 'seed', action: 'SEED_CHAIN', entity_type: 'attribution', entity_id: 'A-COST1', detail: '底座种子：归因元数据' },
  { actor: 'seed', action: 'SEED_CHAIN', entity_type: 'evidence', entity_id: 'V-BOM', detail: '底座种子：证据挂载' },
];

export function seedChain(db) {
  const insertMetric = db.prepare(`
    INSERT INTO result_metrics
      (id, result_id, code, name, source_system, object_id, period_type, period_value,
       target, actual, unit, calculation_version, status, trace_id, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?, ?)
  `);
  for (const m of METRICS) {
    insertMetric.run(
      m.id, m.result_id, m.code, m.name, m.source_system, m.object_id,
      m.period_type, m.period_value, m.target, m.actual, m.unit,
      m.calculation_version, `TRACE-${m.id}`, NOW, NOW,
    );
  }

  const insertException = db.prepare(`
    INSERT INTO exceptions
      (id, exception_id, source_system, object_type, object_id, reason_code, severity,
       status, trace_id, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)
  `);
  for (const x of EXCEPTIONS) {
    insertException.run(
      x.id, x.exception_id, x.source_system, x.object_type, x.object_id,
      x.reason_code, x.severity, `TRACE-${x.id}`, NOW, NOW,
    );
  }

  const insertEvidence = db.prepare(`
    INSERT INTO evidences
      (id, evidence_id, type, title, formed_at, owner, source_system,
       object_type, object_id, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const v of EVIDENCES) {
    insertEvidence.run(
      v.id, v.evidence_id, v.type, v.title, v.formed_at, v.owner,
      v.source_system, v.object_type, v.object_id, `${v.formed_at}T09:00:00+08:00`, NOW,
    );
  }

  const insertAttribution = db.prepare(`
    INSERT INTO attributions
      (id, metric_id, parent_id, kind, exception_id, analysis_name,
       direction, contribution_pct, owner, order_no, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of ATTRIBUTIONS) {
    insertAttribution.run(
      a.id, a.metric_id, a.parent_id, a.kind, a.exception_id, a.analysis_name,
      a.direction, a.contribution_pct, a.owner, a.order_no, NOW,
    );
  }

  const insertLink = db.prepare(`
    INSERT INTO attribution_evidences (attribution_id, evidence_id, linked_by, linked_at)
    VALUES (?, ?, 'seed', ?)
  `);
  for (const [attributionId, evidenceId] of LINKS) {
    insertLink.run(attributionId, evidenceId, NOW);
  }

  const insertAudit = db.prepare(`
    INSERT INTO audit_log (actor, action, entity_type, entity_id, detail, at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of SEED_AUDIT) {
    insertAudit.run(row.actor, row.action, row.entity_type, row.entity_id, row.detail, NOW);
  }

  return db;
}
