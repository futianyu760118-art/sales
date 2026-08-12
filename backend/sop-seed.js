/**
 * S&OP 产销协调会系统 — 种子数据
 * ------------------------------------------------------------------
 * 启动时幂等灌入：29 KPI / 11 预警规则 / 5 流程 / 16 取数配置 / 10 自检项
 * + 7月真实业务数据（齐套49%、客诉0%、异常闭环62%、UPPH 装配40.5/精益44.5 等）
 * 仅当对应表为空时写入，避免覆盖用户数据。
 */
const { getTable, ensureTable, now } = require('./db');

function seedTable(name, records) {
  // 直接同步操作缓存+落盘，避免 insertNoSave/saveNow 异步表锁竞态
  // （saveNow 会同步捕获快照，但 insert 微任务尚未执行 → 写入空表）
  const t = ensureTable(name);
  const data = t._load();          // 同步加载到 _cache
  if (data.records.length > 0) return false; // 已有数据，跳过
  const ts = now();
  records.forEach(r => {
    if (!r.created_at) r.created_at = ts;
    if (!r.updated_at) r.updated_at = ts;
    r.id = data.nextId++;
    data.records.push(r);
  });
  t._save();                       // 同步原子写盘
  t._invalidate();                 // 下次访问重新加载
  return true;
}

function run() {
  const seeded = [];

  // ========== 主数据：产品 ==========
  if (seedTable('md_products', [
    { product_code: 'JFS01B-B1WA10', product_name: 'LED 筒灯 JFS01B', product_family: '筒灯', is_active: 1 },
    { product_code: 'JFS03-B1WB20', product_name: 'LED 射灯 JFS03', product_family: '射灯', is_active: 1 },
    { product_code: 'JFS04-B1WB50', product_name: 'LED 工矿灯 JFS04', product_family: '工矿灯', is_active: 1 },
    { product_code: 'JFX20260512-119', product_name: '项目定制灯 119', product_family: '项目类', is_active: 1 },
    { product_code: 'JFX20260629-158', product_name: '项目定制灯 158', product_family: '项目类', is_active: 1 }
  ])) seeded.push('md_products');

  // ========== 主数据：供应商 ==========
  if (seedTable('md_suppliers', [
    { supplier_code: 'S001', supplier_name: '宁波恒剑供应商A', is_active: 1 },
    { supplier_code: 'S002', supplier_name: '深圳光源科技', is_active: 1 },
    { supplier_code: 'S003', supplier_name: '东莞驱动电源厂', is_active: 1 }
  ])) seeded.push('md_suppliers');

  // ========== 主数据：客户 ==========
  if (seedTable('md_customers', [
    { customer_code: 'C001', customer_name: '客户A（常规）', is_active: 1 },
    { customer_code: 'C002', customer_name: '客户B（项目）', is_active: 1 }
  ])) seeded.push('md_customers');

  // ========== BOM 主数据（归档状态用于硬拦截）==========
  if (seedTable('md_boms', [
    { product_code: 'JFS01B-B1WA10', version: 'V1.0', is_archived: 1, archived_at: now() },
    { product_code: 'JFS03-B1WB20', version: 'V1.0', is_archived: 1, archived_at: now() },
    { product_code: 'JFS04-B1WB50', version: 'V1.0', is_archived: 0, archived_at: null },
    { product_code: 'JFX20260512-119', version: 'V0.9', is_archived: 0, archived_at: null }
  ])) seeded.push('md_boms');

  // ========== KPI 标准定义（29 项）==========
  const KPIS = [
    ['KPI-001','OTD交付达成率','KPI',95,90,85,'K3销售出库单','准时交付数/总交付数'],
    ['KPI-002','采购齐套率','KPI',90,70,50,'K3采购订单','按时到料数/总需求数'],
    ['KPI-003','来料合格率','PI',98,95,90,'OA来料异常单','合格批数/总检验批数'],
    ['KPI-004','制程一次合格率','PI',97,93,88,'K3任务汇报单','一次合格数/总生产数'],
    ['KPI-005','成品检验合格率','PI',99,96,92,'OA检验报告','合格数/总检验数'],
    ['KPI-006','客诉24h及时率','KPI',100,80,0,'OA客诉单','24h内响应数/总客诉数'],
    ['KPI-007','首件检验率','PI',100,85,76,'OA首件检验单','已检数/应检数'],
    ['KPI-008','异常闭环率','KPI',80,70,62,'OA异常单','已闭环数/总异常数'],
    ['KPI-009','预测偏差率MAPE','KPI',15,20,25,'ERP预测vs实绩','ABS(预测-实绩)/实绩'],
    ['KPI-010','库存周转率ITO','KPI',6,4,2,'K3库存+财务','COGS/平均库存'],
    ['KPI-011','装配线UPPH','PI',45,42,40,'MES产线报工','产出数/人时'],
    ['KPI-012','精益线UPPH','PI',45,42,40,'MES产线报工','产出数/人时'],
    ['KPI-013','产能利用率','PI',85,75,60,'MES负荷数据','实际产出/理论产能'],
    ['KPI-014','预测确认及时率','MI',100,90,80,'系统日志','按时确认数/总预测数'],
    ['KPI-015','BOM创建准时率','MI',100,90,80,'K3 BOM','按时创建数/总需求数'],
    ['KPI-016','新物料定义准时率','MI',100,90,80,'K3物料主数据','按时定义数/新物料总数'],
    ['KPI-017','冻结期违反率','PI',0,5,10,'系统审计日志','违反次数/总计划变更'],
    ['KPI-018','主计划周目标完成率','PI',95,88,80,'K3生产计划','周完成数/周计划数'],
    ['KPI-019','每日生产完成率','PI',95,88,80,'K3日报表','日完成数/日计划数'],
    ['KPI-020','未按时足量交付率','KPI',5,10,15,'K3出库单','延迟交付数/总交付数'],
    ['KPI-021','齐套率(物料)','KPI',90,70,49,'K3+MRP','齐套工单数/总工单数'],
    ['KPI-022','样品合格率-吴建英','PI',80,70,64,'K3样品测试','合格数/总数'],
    ['KPI-023','样品合格率-邓桃院','PI',80,70,75,'K3样品测试','合格数/总数'],
    ['KPI-024','样品合格率-包跃','PI',80,70,60,'K3样品测试','合格数/总数'],
    ['KPI-025','常规类预测达成率','KPI',85,80,70,'ERP销售订单','实际/预测'],
    ['KPI-026','项目类预测达成率','KPI',60,10,1,'手动台账','实际/预测'],
    ['KPI-027','安全库存达成率','KPI',100,90,80,'K3库存','库存>=安全库存SKU数/总SKU'],
    ['KPI-028','模具图纸归档率','MI',100,95,90,'K3 BOM+工程系统','已归档数/总数'],
    ['KPI-029','供应商交期履约率','PI',95,85,70,'K3采购订单','按时到货数/总订单数']
  ];
  if (seedTable('kpi_standards', KPIS.map(k => ({
    kpi_code: k[0], kpi_name: k[1], category: k[2],
    target_value: k[3], warning_threshold: k[4], critical_threshold: k[5],
    data_source: k[6], calc_formula: k[7], time_window: '16th-15th', is_active: 1
  })))) seeded.push('kpi_standards');

  // ========== KPI 实绩（7月真实数据）==========
  const stdT = ensureTable('kpi_standards'); stdT._invalidate();
  const stdAll = stdT.all();
  const period = '2026-07';
  // [kpi_code, actual_value] — 来自 7 月会议真实数据
  const ACTUALS = {
    'KPI-001': 88, 'KPI-002': 49, 'KPI-003': 96, 'KPI-004': 95, 'KPI-005': 98,
    'KPI-006': 0, 'KPI-007': 76, 'KPI-008': 62, 'KPI-009': 22, 'KPI-010': 5,
    'KPI-011': 40.5, 'KPI-012': 44.5, 'KPI-013': 78, 'KPI-014': 92, 'KPI-015': 95,
    'KPI-016': 90, 'KPI-017': 8, 'KPI-018': 86, 'KPI-019': 90, 'KPI-020': 12,
    'KPI-021': 49, 'KPI-022': 64.29, 'KPI-023': 75, 'KPI-024': 60, 'KPI-025': 88,
    'KPI-026': 0.6, 'KPI-027': 85, 'KPI-028': 92, 'KPI-029': 82
  };
  // 计算 R/Y/G 状态：MAPE/未交付/冻结违反 为"越低越好"，其余为"越高越好"
  const LOWER_BETTER = new Set(['KPI-009', 'KPI-017', 'KPI-020']);
  function calcStatus(kpi, actual) {
    const target = Number(kpi.target_value), warn = Number(kpi.warning_threshold), crit = Number(kpi.critical_threshold);
    const lower = LOWER_BETTER.has(kpi.kpi_code);
    if (lower) {
      if (actual > crit) return 'R';
      if (actual > warn) return 'Y';
      return 'G';
    } else {
      if (actual < crit) return 'R';
      if (actual < warn) return 'Y';
      return 'G';
    }
  }
  const actualRecords = stdAll.map(k => {
    const av = ACTUALS[k.kpi_code] !== undefined ? ACTUALS[k.kpi_code] : k.target_value;
    return { kpi_id: k.id, kpi_code: k.kpi_code, period_month: period, actual_value: av, status: calcStatus(k, av) };
  });
  if (seedTable('kpi_actuals', actualRecords)) seeded.push('kpi_actuals');

  // ========== 预警规则（11 条）==========
  const RULES = [
    ['AR-001','预测偏差超阈值','KPI_VALUE','KPI-009','>15','Y','["SALES_DIRECTOR","MARKET_PLANNER"]','R/Y'],
    ['AR-002','齐套率红灯','KPI_VALUE','KPI-002','<70','R','["PURCHASE_HEAD","PROD_DIRECTOR","COMMITTEE_HEAD"]','R'],
    ['AR-003','产能超载','TABLE_VALUE','supply_capacities.load_rate','>85','R','["PROD_DIRECTOR"]','R'],
    ['AR-004','客诉超时未响应','TIME_ELAPSED','sop_action(客诉) PENDING >24h','>24h','R','["QUALITY_HEAD","GENERAL_MANAGER"]','R'],
    ['AR-005','首件检验率下降','KPI_VALUE','KPI-007','<76 OR 本周<上周','Y','["QUALITY_ENGINEER"]','Y'],
    ['AR-006','异常闭环率恶化','KPI_VALUE','KPI-008','<80','R','["DEPT_HEAD"]','R'],
    ['AR-007','模具图纸未归档(硬拦截)','HARD_BLOCK','md_bom.is_archived=0','block','BLOCK','["ENGINEER_HEAD","PROD_PLANNER"]','BLOCK'],
    ['AR-008','安全库存跌破','TABLE_VALUE','psi_line.inventory_end<safety_stock','<','Y','["PLANNER","SALES_REP"]','Y'],
    ['AR-009','项目类预测偏差','KPI_VALUE','KPI-026','<5','R','["PROJECT_MANAGER","SALES_VP"]','R'],
    ['AR-010','供应商交期违约','TABLE_VALUE','supply_mrp.is_ontime=0','延迟>2天','Y','["PURCHASER","SQE"]','Y'],
    ['AR-011','样品合格率不达标','KPI_VALUE','KPI-022/023/024','<70','Y','["R&D_HEAD"]','Y']
  ];
  if (seedTable('alert_rules', RULES.map(r => ({
    rule_code: r[0], rule_name: r[1], trigger_type: r[2], kpi_code: r[3], condition: r[4],
    alert_level: r[5], notify_roles: r[6], escalation_path: r[7], is_active: 1
  })))) seeded.push('alert_rules');

  // ========== 流程配置（5 大流程）==========
  const FLOWS = [
    ['FL-MAIN','S&OP主流程','MAIN',[['数据准备','SOP_OFFICER'],['需求预测制定','MARKET_PLANNER'],['供应能力评估','PROD_PLANNER'],['预备会议','COMMITTEE_HEAD'],['高层决策会','COMMITTEE_HEAD']],'PPT'],
    ['FL-RD','新品研发流程','R&D',[['样品申请','R&D'],['样品测试','QC'],['BOM创建','ENGINEER'],['量产前验证','R&D']],'PPT'],
    ['FL-SALE','销售预测流程','SALES',[['区域提报','SALES_REP'],['中心评审','SALES_DIRECTOR'],['总部汇总','MARKET_PLANNER']],'MEETING'],
    ['FL-PUR-PROD','采购生产协同流程','PURCHASE_PROD',[['MRP展开','PROD_PLANNER'],['Supply Commit回复','PURCHASER'],['短缺协调','PURCHASE_HEAD'],['MPS确认','COMMITTEE_HEAD']],'PPT'],
    ['FL-QC','品质异常流程','QUALITY',[['异常创建','QUALITY_ENGINEER'],['责任分配','QUALITY_HEAD'],['对策制定','DEPT_HEAD'],['效果验证','QUALITY_ENGINEER'],['闭环确认','QUALITY_HEAD']],'MEETING']
  ];
  if (seedTable('flow_configs', FLOWS.map(f => ({
    flow_code: f[0], flow_name: f[1], flow_type: f[2],
    steps_json: JSON.stringify(f[3].map((s, i) => ({ step: i + 1, name: s[0], role: s[1] }))),
    source: f[4], is_active: 1
  })))) seeded.push('flow_configs');

  // ========== 数据获取配置（16 个取数开关）==========
  const FETCH = [
    ['DF-001','交付OTD取数','K3','sales_delivery','kpi_actual(KPI-001)','AUTO','0 30 1 16 *'],
    ['DF-002','生产实绩取数','K3','task_report','kpi_actual(KPI-004/011/012)','AUTO','0 35 1 16 *'],
    ['DF-003','来料品质取数','OA','inspection_report','kpi_actual(KPI-003)','AUTO','0 40 1 16 *'],
    ['DF-004','制程品质取数','K3','task_report','kpi_actual(KPI-004)','AUTO','0 45 1 16 *'],
    ['DF-005','成品检验取数','OA','qa_report','kpi_actual(KPI-005)','AUTO','0 50 1 16 *'],
    ['DF-006','验货异常取数','OA','inspection_exception','kpi_actual(KPI-005)','AUTO','0 55 1 16 *'],
    ['DF-007','采购齐套取数','K3','purchase_order','supply_mrp','AUTO','0 0 2 16 *'],
    ['DF-008','销售预测取数','ERP','forecast_entry','demand_forecast','AUTO','0 5 2 16 *'],
    ['DF-009','BOM归档状态','K3','bom_header','md_bom','AUTO','0 10 2 * *'],
    ['DF-010','首件检验取数','OA','first_piece_inspect','kpi_actual(KPI-007)','AUTO','0 15 2 16 *'],
    ['DF-011','客诉及时率取数','OA','customer_complaint','kpi_actual(KPI-006)','MANUAL',null],
    ['DF-012','异常闭环取数','OA','exception_ticket','kpi_actual(KPI-008)','AUTO','0 20 2 16 *'],
    ['DF-013','样品合格率取数','K3','sample_test','kpi_actual(KPI-022/023/024)','MANUAL',null],
    ['DF-014','UPPH实绩取数','MES','production_line','supply_capacity','AUTO','0 25 2 16 *'],
    ['DF-015','安全库存取数','K3','safety_stock','psi_line','AUTO','0 30 2 16 *'],
    ['DF-016','产能负荷取数','MES','line_load','supply_capacity','AUTO','0 0 3 * *']
  ];
  if (seedTable('data_fetch_configs', FETCH.map(f => ({
    config_code: f[0], config_name: f[1], source_system: f[2], source_table: f[3],
    target_desc: f[4], fetch_mode: f[5], cron_expr: f[6], time_window: '16th-15th',
    is_enabled: 1, last_status: 'SUCCESS'
  })))) seeded.push('data_fetch_configs');

  // ========== 自检模板（每周 10 项）==========
  const CHECK_ITEMS = [
    ['PSI三月亮数据是否已刷新','系统自动校验version_no'],
    ['本月预测偏差>15%的产品是否已标记','系统筛选MAPE>15%'],
    ['Top3缺料是否已有对策','检查supply_mrp.shortage_qty>0是否有action'],
    ['本周异常创建到分配是否<4h','系统计算平均响应时间'],
    ['BOM归档率是否100%','系统自动计算md_bom.is_archived'],
    ['模具图纸更新是否完成','工程系统对接'],
    ['供应商交期承诺是否已确认','检查supply_commit回复率'],
    ['客诉SLA计时是否合规','系统校验24h响应率'],
    ['行动计划逾期数是否>0','系统筛选status=PENDING AND due_date<NOW()'],
    ['KPI红黄灯数量趋势','仪表盘截图对比上周']
  ];
  if (seedTable('self_check_templates', [{
    template_code: 'SCT-WEEKLY', template_name: '每周产销自检表', frequency: 'WEEKLY',
    items_json: JSON.stringify(CHECK_ITEMS.map((c, i) => ({ no: i + 1, item: c[0], check_method: c[1] }))),
    is_active: 1
  }])) seeded.push('self_check_templates');

  // ========== 供应产能（UPPH 真实数据）==========
  if (seedTable('supply_capacities', [
    { line_code: '装配线', period_month: '2026-07', available_days: 26, upph_actual: 40.5, upph_target: 45, load_rate: 78, bottleneck: '' },
    { line_code: '精益线', period_month: '2026-07', available_days: 26, upph_actual: 44.5, upph_target: 45, load_rate: 88, bottleneck: '瓶颈工位B' }
  ])) seeded.push('supply_capacities');

  // ========== MRP 齐套（含短缺）==========
  if (seedTable('supply_mrps', [
    { product_code: 'JFS01B-B1WA10', material_code: 'LED-2835', demand_date: '2026-07-20', required_qty: 10000, arrived_qty: 6000, supplier_code: 'S002' },
    { product_code: 'JFS03-B1WB20', material_code: 'DRV-24V', demand_date: '2026-07-22', required_qty: 5000, arrived_qty: 2000, supplier_code: 'S003' },
    { product_code: 'JFS04-B1WB50', material_code: 'PCB-R04', demand_date: '2026-07-25', required_qty: 3000, arrived_qty: 3000, supplier_code: 'S001' }
  ].map(r => {
    r.shortage_qty = Math.max(0, r.required_qty - r.arrived_qty);
    r.is_ontime = r.arrived_qty >= r.required_qty ? 1 : 0;
    return r;
  }))) seeded.push('supply_mrps');

  // ========== PSI 头表 + 明细（核心，同步直写避免竞态）==========
  const psiHT = ensureTable('psi_headers');
  const psiHData = psiHT._load();
  let psiHeaderId = null;
  if (psiHData.records.length === 0) {
    psiHeaderId = psiHData.nextId++;
    psiHData.records.push({
      id: psiHeaderId, psi_code: 'PSI-202607-001', sales_type: '内销', period_month: '2026-07',
      version_no: 1, status: 'CONFIRMED', is_rolled: 0, created_by: 1, created_at: now(), updated_at: now()
    });
    psiHT._save(); psiHT._invalidate();
    seeded.push('psi_headers');

    const lineT = ensureTable('psi_lines');
    const lineData = lineT._load();
    const products = ['JFS01B-B1WA10', 'JFS03-B1WB20', 'JFS04-B1WB50'];
    products.forEach((pc, idx) => {
      const begin = [1200, 800, 500][idx];
      const sales = [1000, 900, 400][idx];
      const prod = [950, 950, 450][idx];
      const safety = [300, 250, 200][idx];
      [0, 1, 2].forEach(off => {
        const b = off === 0 ? begin : (begin + prod - sales);
        const sp = off === 0 ? sales : Math.round(sales * 1.05);
        const pp = off === 0 ? prod : Math.round(prod * 1.05);
        const ss = off === 0 ? safety : Math.round(safety * 0.9);
        const end = b + pp - sp;
        let color = 'G';
        if (end < ss) color = 'R';
        else if (end < ss * 1.2) color = 'Y';
        lineData.records.push({
          id: lineData.nextId++, header_id: psiHeaderId, product_code: pc, month_offset: off,
          inventory_begin: b, sales_plan: sp, production_plan: pp,
          inventory_end: end, safety_stock: ss, color_status: color, is_editable: off > 0 ? 1 : 0,
          created_at: now(), updated_at: now()
        });
      });
    });
    lineT._save(); lineT._invalidate();
    seeded.push('psi_lines');
  }

  // ========== 需求预测 ==========
  if (seedTable('demand_forecasts', [
    { product_code: 'JFS01B-B1WA10', period_month: '2026-07', month_offset: 1, forecast_qty: 1050, forecast_type: 'FLEXIBLE', method: 'MOVING_AVG', mape_reference: 18, currency_amount: 52500, version_no: 1, created_by: 1 },
    { product_code: 'JFS03-B1WB20', period_month: '2026-07', month_offset: 1, forecast_qty: 950, forecast_type: 'FLEXIBLE', method: 'EXP_SMOOTH', mape_reference: 12, currency_amount: 38000, version_no: 1, created_by: 1 },
    { product_code: 'JFX20260512-119', period_month: '2026-07', month_offset: 1, forecast_qty: 200, forecast_type: 'REFERENCE', method: 'QUALITATIVE', mape_reference: 0, currency_amount: 60000, remark: '项目类手工台账', version_no: 1, created_by: 1 }
  ])) seeded.push('demand_forecasts');

  // ========== Action 待办（7月会议真实未完成项）==========
  if (seedTable('sop_actions', [
    { action_code: 'ACT-202607-001', meeting_id: null, issue_no: '8', description: '采购齐套率提升至70%（当前49%）', owner_name: '沈建凯', owner_role: 'PURCHASE_HEAD', due_date: '2026-08-15', priority: 'P0', status: 'IN_PROGRESS', escalation_level: 1, source_system: 'SOP' },
    { action_code: 'ACT-202607-002', meeting_id: null, issue_no: '8', description: '客诉24h及时率制度重建（当前0%）', owner_name: '李玉英', owner_role: 'QUALITY_HEAD', due_date: '2026-08-10', priority: 'P0', status: 'PENDING', escalation_level: 0, source_system: 'SOP' },
    { action_code: 'ACT-202607-003', meeting_id: null, issue_no: '8', description: '异常闭环率回升至80%+（当前62%，恶化中）', owner_name: '各部门', owner_role: 'DEPT_HEAD', due_date: '2026-08-08', priority: 'P0', status: 'IN_PROGRESS', escalation_level: 2, source_system: 'SOP' },
    { action_code: 'ACT-202607-004', meeting_id: null, issue_no: '9', description: '项目类预测数据提取方案（当前0.6%，ERP无法提取）', owner_name: 'IT+销售', owner_role: 'IT_ADMIN', due_date: '2026-08-20', priority: 'P1', status: 'IN_PROGRESS', escalation_level: 0, source_system: 'SOP' },
    { action_code: 'ACT-202607-005', meeting_id: null, issue_no: '9', description: '模具图纸归档硬拦截上线（规则已定）', owner_name: '工程+IT', owner_role: 'ENGINEER_HEAD', due_date: '2026-08-12', priority: 'P1', status: 'IN_PROGRESS', escalation_level: 0, source_system: 'SOP' }
  ])) seeded.push('sop_actions');

  return seeded;
}

module.exports = { run, seedTable };
