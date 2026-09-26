-- ============================================================
-- S&OP系统 初始化种子数据
-- ============================================================

USE sop_system;

-- ------------------------------------------------------------
-- 组织
-- ------------------------------------------------------------
INSERT INTO sys_organization (org_code, org_name, org_type) VALUES
('HQ','总部','HQ'),
('DIV-MFG','制造事业部','DIVISION'),
('DIV-SALE','销售事业部','DIVISION'),
('DEPT-PMC','PMC部','DEPT'),
('DEPT-PUR','采购部','DEPT'),
('DEPT-QC','品质部','DEPT'),
('DEPT-ENG','工程部','DEPT'),
('DEPT-RD','研发部','DEPT');

-- ------------------------------------------------------------
-- 用户 (实际人员)
-- ------------------------------------------------------------
INSERT INTO sys_user (user_code, user_name, org_id, role_code) VALUES
('U001','沈旭日',2,'COMMITTEE_HEAD'),     -- 计委主任
('U002','虞周峰',3,'SALES_DIRECTOR'),    -- 销售总监
('U003','廖新平',2,'PROD_DIRECTOR'),     -- 生产总监
('U004','沈建凯',5,'PURCHASE_HEAD'),     -- 采购主管
('U005','李玉英',6,'QUALITY_HEAD'),      -- 品质主管
('U006','戎双娇',4,'SOP_OFFICER'),       -- S&OP专员
('U007','工程主管',7,'ENGINEER_HEAD'),    -- 工程主管
('U008','研发主管',8,'R&D_HEAD');         -- 研发主管

-- ------------------------------------------------------------
-- 数据获取配置 (8大类取数开关)
-- ------------------------------------------------------------
INSERT INTO cfg_data_fetch (config_code, config_name, source_system, source_table, source_field, target_table, target_field, fetch_mode, cron_expr, time_window) VALUES
('DF-001','交付OTD取数','K3','sales_delivery','delivery_date','kpi_actual','actual_value','AUTO','0 30 1 16 *','16th-15th'),
('DF-002','生产实绩取数','K3','task_report','report_date','kpi_actual','actual_value','AUTO','0 35 1 16 *','16th-15th'),
('DF-003','来料品质取数','OA','inspection_report','report_date','kpi_actual','actual_value','AUTO','0 40 1 16 *','16th-15th'),
('DF-004','制程品质取数','K3','task_report','report_date','kpi_actual','actual_value','AUTO','0 45 1 16 *','16th-15th'),
('DF-005','成品检验取数','OA','qa_report','report_date','kpi_actual','actual_value','AUTO','0 50 1 16 *','16th-15th'),
('DF-006','验货异常取数','OA','inspection_exception','create_date','kpi_actual','actual_value','AUTO','0 55 1 16 *','16th-15th'),
('DF-007','采购齐套取数','K3','purchase_order','demand_date','supply_mrp','demand_date','AUTO','0 0 2 16 *','16th-15th'),
('DF-008','销售预测取数','ERP','sales_order','order_date','demand_forecast','forecast_qty','AUTO','0 5 2 16 *','16th-15th'),
('DF-009','BOM归档状态','K3','bom_header','archive_status','md_bom','is_archived','AUTO','0 10 2 * *','realtime'),
('DF-010','首件检验取数','OA','first_piece_inspect','inspect_date','kpi_actual','actual_value','AUTO','0 15 2 16 *','16th-15th'),
('DF-011','客诉及时率取数','OA','customer_complaint','create_time','kpi_actual','actual_value','MANUAL',NULL,'16th-15th'),
('DF-012','异常闭环取数','OA','exception_ticket','close_date','kpi_actual','actual_value','AUTO','0 20 2 16 *','16th-15th'),
('DF-013','样品合格率取数','K3','sample_test','test_date','kpi_actual','actual_value','MANUAL',NULL,'16th-15th'),
('DF-014','UPPH实绩取数','MES','production_line','report_date','supply_capacity','upph_actual','AUTO','0 25 2 16 *','16th-15th'),
('DF-015','安全库存取数','K3','safety_stock','update_date','psi_line','safety_stock','AUTO','0 30 2 16 *','16th-15th'),
('DF-016','产能负荷取数','MES','line_load','report_date','supply_capacity','load_rate','AUTO','0 0 3 * *','realtime');

-- ------------------------------------------------------------
-- KPI标准定义 (29项指标 精选核心)
-- ------------------------------------------------------------
INSERT INTO kpi_standard (kpi_code, kpi_name, category, target_value, warning_threshold, critical_threshold, data_source, calc_formula, time_window) VALUES
('KPI-001','OTD交付达成率','KPI',95,90,85,'K3销售出库单','准时交付数/总交付数','16th-15th'),
('KPI-002','采购齐套率','KPI',90,70,50,'K3采购订单','按时到料数/总需求数','16th-15th'),
('KPI-003','来料合格率','PI',98,95,90,'OA来料异常单','合格批数/总检验批数','16th-15th'),
('KPI-004','制程一次合格率','PI',97,93,88,'K3任务汇报单','一次合格数/总生产数','16th-15th'),
('KPI-005','成品检验合格率','PI',99,96,92,'OA检验报告','合格数/总检验数','16th-15th'),
('KPI-006','客诉24h及时率','KPI',100,80,0,'OA客诉单','24h内响应数/总客诉数','16th-15th'),
('KPI-007','首件检验率','PI',100,85,76,'OA首件检验单','已检数/应检数','16th-15th'),
('KPI-008','异常闭环率','KPI',80,70,62,'OA异常单','已闭环数/总异常数','16th-15th'),
('KPI-009','预测偏差率MAPE','KPI',15,20,25,'ERP预测vs实绩','ABS(预测-实绩)/实绩','16th-15th'),
('KPI-010','库存周转率ITO','KPI',6,4,2,'K3库存+财务','COGS/平均库存','16th-15th'),
('KPI-011','装配线UPPH','PI',45,42,40,'MES产线报工','产出数/人时','16th-15th'),
('KPI-012','精益线UPPH','PI',45,42,40,'MES产线报工','产出数/人时','16th-15th'),
('KPI-013','产能利用率','PI',85,75,60,'MES负荷数据','实际产出/理论产能','16th-15th'),
('KPI-014','预测确认及时率','MI',100,90,80,'系统日志','按时确认数/总预测数','16th-15th'),
('KPI-015','BOM创建准时率','MI',100,90,80,'K3 BOM','按时创建数/总需求数','16th-15th'),
('KPI-016','新物料定义准时率','MI',100,90,80,'K3物料主数据','按时定义数/新物料总数','16th-15th'),
('KPI-017','冻结期违反率','PI',0,5,10,'系统审计日志','违反次数/总计划变更','16th-15th'),
('KPI-018','主计划周目标完成率','PI',95,88,80,'K3生产计划','周完成数/周计划数','16th-15th'),
('KPI-019','每日生产完成率','PI',95,88,80,'K3日报表','日完成数/日计划数','16th-15th'),
('KPI-020','未按时足量交付率','KPI',5,10,15,'K3出库单','延迟交付数/总交付数','16th-15th'),
('KPI-021','齐套率(物料)','KPI',90,70,49,'K3+MRP','齐套工单数/总工单数','16th-15th'),
('KPI-022','样品合格率-吴建英','PI',80,70,64,'K3样品测试','合格数/总数','16th-15th'),
('KPI-023','样品合格率-邓桃院','PI',80,70,75,'K3样品测试','合格数/总数','16th-15th'),
('KPI-024','样品合格率-包跃','PI',80,70,60,'K3样品测试','合格数/总数','16th-15th'),
('KPI-025','常规类预测达成率','KPI',85,80,70,'ERP销售订单','实际/预测','16th-15th'),
('KPI-026','项目类预测达成率','KPI',60,10,0.6,'手动台账','实际/预测','16th-15th'),
('KPI-027','安全库存达成率','KPI',100,90,80,'K3库存','库存>=安全库存SKU数/总SKU','16th-15th'),
('KPI-028','模具图纸归档率','MI',100,95,90,'K3 BOM+工程系统','已归档数/总数','16th-15th'),
('KPI-029','供应商交期履约率','PI',95,85,70,'K3采购订单','按时到货数/总订单数','16th-15th');

-- ------------------------------------------------------------
-- 预警规则 (11条)
-- ------------------------------------------------------------
INSERT INTO alert_rule (rule_code, rule_name, trigger_condition, alert_level, notify_roles, escalation_path) VALUES
('AR-001','预测偏差超阈值','SELECT kpi_id FROM kpi_actual WHERE kpi_id IN (SELECT id FROM kpi_standard WHERE kpi_code=''KPI-009'') AND actual_value > 15','Y',JSON_ARRAY('SALES_DIRECTOR','MARKET_PLANNER'),JSON_ARRAY('LEVEL1:当天通知','LEVEL2:超时1天抄送主管','LEVEL3:超时3天抄送副总')),
('AR-002','齐套率红灯','SELECT kpi_id FROM kpi_actual WHERE kpi_id IN (SELECT id FROM kpi_standard WHERE kpi_code=''KPI-002'') AND actual_value < 70','R',JSON_ARRAY('PURCHASE_HEAD','PROD_DIRECTOR','COMMITTEE_HEAD'),JSON_ARRAY('LEVEL1:当天通知','LEVEL2:超时1天抄送副总')),
('AR-003','产能超载','SELECT line_code FROM supply_capacity WHERE load_rate > 85','R',JSON_ARRAY('PROD_DIRECTOR'),JSON_ARRAY('LEVEL1:当天通知','LEVEL2:超时1天抄送副总')),
('AR-004','客诉超时未响应','SELECT id FROM sop_action WHERE description LIKE ''%客诉%'' AND status=''PENDING'' AND TIMESTAMPDIFF(HOUR,created_at,NOW()) > 24','R',JSON_ARRAY('QUALITY_HEAD','GENERAL_MANAGER'),JSON_ARRAY('LEVEL1:1h短信','LEVEL2:4h抄送副总','LEVEL3:24h抄送总经理')),
('AR-005','首件检验率下降','SELECT kpi_id FROM kpi_actual WHERE kpi_id IN (SELECT id FROM kpi_standard WHERE kpi_code=''KPI-007'') AND actual_value < 76','Y',JSON_ARRAY('QUALITY_ENGINEER'),NULL),
('AR-006','异常闭环率恶化','SELECT kpi_id FROM kpi_actual WHERE kpi_id IN (SELECT id FROM kpi_standard WHERE kpi_code=''KPI-008'') AND actual_value < 80','R',JSON_ARRAY('DEPT_HEAD'),JSON_ARRAY('LEVEL1:当天通知责任人','LEVEL2:超时1天抄送主管')),
('AR-007','模具图纸未归档(硬拦截)','SELECT product_code FROM md_bom WHERE is_archived=0 AND EXISTS(SELECT 1 FROM psi_line pl JOIN psi_header ph ON pl.header_id=ph.id WHERE pl.product_code=md_bom.product_code AND ph.status IN (''CONFIRMED'',''LOCKED''))','BLOCK',JSON_ARRAY('ENGINEER_HEAD','PROD_PLANNER'),JSON_ARRAY('BLOCK:阻止MPS下发')),
('AR-008','安全库存跌破','SELECT id FROM psi_line WHERE color_status=''R''','Y',JSON_ARRAY('PLANNER','SALES_REP'),NULL),
('AR-009','项目类预测偏差','SELECT kpi_id FROM kpi_actual WHERE kpi_id IN (SELECT id FROM kpi_standard WHERE kpi_code=''KPI-026'') AND actual_value < 5','R',JSON_ARRAY('PROJECT_MANAGER','SALES_VP'),NULL),
('AR-010','供应商交期违约','SELECT supplier_code FROM supply_mrp WHERE is_ontime=0 AND demand_date < DATE_SUB(NOW(),INTERVAL 2 DAY)','Y',JSON_ARRAY('PURCHASER','SQE'),NULL),
('AR-011','样品合格率不达标','SELECT kpi_id FROM kpi_actual WHERE kpi_id IN (SELECT id FROM kpi_standard WHERE kpi_code IN (''KPI-022'',''KPI-023'',''KPI-024'')) AND actual_value < 70','Y',JSON_ARRAY('R&D_HEAD'),NULL);

-- ------------------------------------------------------------
-- 自检模板 (每周10项)
-- ------------------------------------------------------------
INSERT INTO self_check_template (template_code, template_name, frequency, items_json) VALUES
('SCT-WEEKLY','每周产销自检表','WEEKLY',JSON_ARRAY(
  JSON_OBJECT('no',1,'item','PSI三月亮数据是否已刷新','check_method','系统自动校验version_no'),
  JSON_OBJECT('no',2,'item','本月预测偏差>15%的产品是否已标记','check_method','系统筛选MAPE>15%'),
  JSON_OBJECT('no',3,'item','Top3缺料是否已有对策','check_method','检查supply_mrp.shortage_qty>0是否有action'),
  JSON_OBJECT('no',4,'item','本周异常创建到分配是否<4h','check_method','系统计算平均响应时间'),
  JSON_OBJECT('no',5,'item','BOM归档率是否100%','check_method','系统自动计算md_bom.is_archived'),
  JSON_OBJECT('no',6,'item','模具图纸更新是否完成','check_method','工程系统对接'),
  JSON_OBJECT('no',7,'item','供应商交期承诺是否已确认','check_method','检查supply_commit回复率'),
  JSON_OBJECT('no',8,'item','客诉SLA计时是否合规','check_method','系统校验24h响应率'),
  JSON_OBJECT('no',9,'item','行动计划逾期数是否>0','check_method','系统筛选sop_action.status=PENDING AND due_date<NOW()'),
  JSON_OBJECT('no',10,'item','KPI红黄灯数量趋势','check_method','仪表盘截图对比上周')
));

-- ------------------------------------------------------------
-- 流程配置 (5大流程)
-- ------------------------------------------------------------
INSERT INTO flow_config (flow_code, flow_name, flow_type, steps_json, source) VALUES
('FL-MAIN','S&OP主流程','MAIN',JSON_ARRAY(
  JSON_OBJECT('step',1,'name','数据准备','role','SOP_OFFICER','auto','true'),
  JSON_OBJECT('step',2,'name','需求预测制定','role','MARKET_PLANNER','auto','false'),
  JSON_OBJECT('step',3,'name','供应能力评估','role','PROD_PLANNER','auto','true'),
  JSON_OBJECT('step',4,'name','预备会议','role','COMMITTEE_HEAD','auto','false'),
  JSON_OBJECT('step',5,'name','高层决策会','role','COMMITTEE_HEAD','auto','false')
),'PPT'),
('FL-RD','新品研发流程','R&D',JSON_ARRAY(
  JSON_OBJECT('step',1,'name','样品申请','role','R&D'),
  JSON_OBJECT('step',2,'name','样品测试','role','QC'),
  JSON_OBJECT('step',3,'name','BOM创建','role','ENGINEER'),
  JSON_OBJECT('step',4,'name','量产前验证','role','R&D')
),'PPT'),
('FL-SALE','销售预测流程','SALES',JSON_ARRAY(
  JSON_OBJECT('step',1,'name','区域提报','role','SALES_REP'),
  JSON_OBJECT('step',2,'name','中心评审','role','SALES_DIRECTOR'),
  JSON_OBJECT('step',3,'name','总部汇总','role','MARKET_PLANNER')
),'MEETING'),
('FL-PUR-PROD','采购生产协同流程','PURCHASE_PROD',JSON_ARRAY(
  JSON_OBJECT('step',1,'name','MRP展开','role','PROD_PLANNER','auto','true'),
  JSON_OBJECT('step',2,'name','Supply Commit回复','role','PURCHASER'),
  JSON_OBJECT('step',3,'name','短缺协调','role','PURCHASE_HEAD'),
  JSON_OBJECT('step',4,'name','MPS确认','role','COMMITTEE_HEAD')
),'PPT'),
('FL-QC','品质异常流程','QUALITY',JSON_ARRAY(
  JSON_OBJECT('step',1,'name','异常创建','role','QUALITY_ENGINEER','auto','true'),
  JSON_OBJECT('step',2,'name','责任分配','role','QUALITY_HEAD'),
  JSON_OBJECT('step',3,'name','对策制定','role','DEPT_HEAD'),
  JSON_OBJECT('step',4,'name','效果验证','role','QUALITY_ENGINEER'),
  JSON_OBJECT('step',5,'name','闭环确认','role','QUALITY_HEAD')
),'MEETING');

-- ============================================================
-- END OF SEED DATA
-- ============================================================
