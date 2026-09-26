-- ============================================================
-- S&OP产销协调会系统 数据库DDL (MySQL 8.0+)
-- 字符集: utf8mb4  排序规则: utf8mb4_unicode_ci
-- ============================================================

CREATE DATABASE IF NOT EXISTS sop_system
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE sop_system;

-- ------------------------------------------------------------
-- 1. 组织与用户
-- ------------------------------------------------------------
CREATE TABLE sys_organization (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  org_code      VARCHAR(64)  NOT NULL UNIQUE  COMMENT '组织编码',
  org_name      VARCHAR(128) NOT NULL         COMMENT '组织名称',
  parent_id     BIGINT       DEFAULT NULL     COMMENT '上级组织ID',
  org_type      ENUM('HQ','DIVISION','PLANT','DEPT') DEFAULT 'DEPT',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='组织表';

CREATE TABLE sys_user (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  user_code     VARCHAR(64)  NOT NULL UNIQUE  COMMENT '工号',
  user_name     VARCHAR(64)  NOT NULL         COMMENT '姓名',
  email         VARCHAR(128) DEFAULT NULL,
  phone         VARCHAR(20)  DEFAULT NULL,
  org_id        BIGINT       NOT NULL         COMMENT '所属组织',
  role_code     VARCHAR(64)  NOT NULL         COMMENT '角色编码(见permission_matrix)',
  is_active     TINYINT      DEFAULT 1,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_org (org_id),
  INDEX idx_role (role_code)
) ENGINE=InnoDB COMMENT='用户表';

-- ------------------------------------------------------------
-- 2. 主数据
-- ------------------------------------------------------------
CREATE TABLE md_product (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  product_code  VARCHAR(64)  NOT NULL UNIQUE  COMMENT '产品编码',
  product_name  VARCHAR(256) NOT NULL         COMMENT '产品名称',
  product_family VARCHAR(64) DEFAULT NULL     COMMENT '产品族',
  is_active     TINYINT      DEFAULT 1,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='产品主数据';

CREATE TABLE md_customer (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  customer_code VARCHAR(64)  NOT NULL UNIQUE,
  customer_name VARCHAR(256) NOT NULL,
  is_active     TINYINT      DEFAULT 1
) ENGINE=InnoDB COMMENT='客户主数据';

CREATE TABLE md_supplier (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  supplier_code VARCHAR(64)  NOT NULL UNIQUE,
  supplier_name VARCHAR(256) NOT NULL,
  is_active     TINYINT      DEFAULT 1
) ENGINE=InnoDB COMMENT='供应商主数据';

CREATE TABLE md_bom (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  product_code  VARCHAR(64)  NOT NULL,
  version       VARCHAR(20)  NOT NULL         COMMENT 'BOM版本',
  is_archived   TINYINT      DEFAULT 0        COMMENT '是否已归档(硬拦截用)',
  archived_at   DATETIME     DEFAULT NULL,
  archived_by   BIGINT       DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_product_version (product_code, version)
) ENGINE=InnoDB COMMENT='BOM主数据(归档状态用于硬拦截)';

-- ------------------------------------------------------------
-- 3. 数据获取配置 (自动/手动开关)
-- ------------------------------------------------------------
CREATE TABLE cfg_data_fetch (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  config_code   VARCHAR(64)  NOT NULL UNIQUE  COMMENT '配置编码',
  config_name   VARCHAR(128) NOT NULL         COMMENT '配置名称',
  source_system VARCHAR(64)  NOT NULL         COMMENT '来源系统:K3/OA/QMS/MES/ERP',
  source_table  VARCHAR(128) NOT NULL         COMMENT '来源表名',
  source_field  VARCHAR(128) NOT NULL         COMMENT '来源字段',
  target_table  VARCHAR(128) NOT NULL         COMMENT '目标表名',
  target_field  VARCHAR(128) NOT NULL         COMMENT '目标字段',
  fetch_mode    ENUM('AUTO','MANUAL') DEFAULT 'AUTO' COMMENT '获取模式',
  is_enabled    TINYINT      DEFAULT 1        COMMENT '开关:1开/0关',
  cron_expr     VARCHAR(64)  DEFAULT NULL     COMMENT '自动获取Cron表达式',
  time_window   VARCHAR(32)  DEFAULT '16th-15th' COMMENT '数据时间窗口',
  filter_sql    TEXT         DEFAULT NULL     COMMENT '额外过滤条件',
  last_run_at   DATETIME     DEFAULT NULL,
  last_status   VARCHAR(20)  DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='数据自动获取配置(开关+映射)';

-- ------------------------------------------------------------
-- 4. 需求预测
-- ------------------------------------------------------------
CREATE TABLE demand_forecast (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  product_code  VARCHAR(64)  NOT NULL,
  period_month  CHAR(7)      NOT NULL         COMMENT '月份 YYYY-MM',
  month_offset  TINYINT      NOT NULL         COMMENT '0=当月(M),1=M+1,2=M+2',
  forecast_qty  DECIMAL(14,2) DEFAULT 0      COMMENT '预测数量',
  forecast_type ENUM('LOCKED','FLEXIBLE','REFERENCE') DEFAULT 'FLEXIBLE',
  method        ENUM('MOVING_AVG','EXP_SMOOTH','REGRESSION','LIFE_CYCLE','QUALITATIVE') DEFAULT 'QUALITATIVE',
  mape_reference DECIMAL(6,2) DEFAULT NULL   COMMENT '历史MAPE参考值',
  currency_amount DECIMAL(16,2) DEFAULT 0    COMMENT '折算金额(给财务)',
  remark        TEXT         DEFAULT NULL,
  created_by    BIGINT       NOT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  version_no    INT          DEFAULT 1,
  UNIQUE KEY uk_product_period_version (product_code, period_month, month_offset, version_no),
  INDEX idx_period (period_month)
) ENGINE=InnoDB COMMENT='需求预测表(无约束)';

-- ------------------------------------------------------------
-- 5. 供应能力
-- ------------------------------------------------------------
CREATE TABLE supply_capacity (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  line_code     VARCHAR(64)  NOT NULL         COMMENT '产线编码(装配线/精益线)',
  period_month  CHAR(7)      NOT NULL,
  available_days DECIMAL(5,1) DEFAULT 0       COMMENT '可用天数',
  upph_actual   DECIMAL(8,2) DEFAULT 0       COMMENT '实际UPPH',
  upph_target   DECIMAL(8,2) DEFAULT 45      COMMENT '目标UPPH',
  load_rate     DECIMAL(6,2) DEFAULT 0       COMMENT '负荷率%',
  bottleneck    VARCHAR(256) DEFAULT NULL     COMMENT '瓶颈工序描述',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='供应产能表';

CREATE TABLE supply_mrp (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  product_code  VARCHAR(64)  NOT NULL,
  material_code VARCHAR(64)  NOT NULL,
  demand_date   DATE         NOT NULL         COMMENT '需求日期(生产计划前3天)',
  required_qty  DECIMAL(14,2) DEFAULT 0,
  arrived_qty   DECIMAL(14,2) DEFAULT 0,
  shortage_qty  DECIMAL(14,2) GENERATED ALWAYS AS (required_qty - arrived_qty) STORED,
  is_ontime     TINYINT      DEFAULT 0        COMMENT '按时达成:到料<=需求日',
  supplier_code VARCHAR(64)  DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_demand_date (demand_date),
  INDEX idx_product (product_code)
) ENGINE=InnoDB COMMENT='MRP物料齐套检查表';

-- ------------------------------------------------------------
-- 6. PSI产销存 (核心)
-- ------------------------------------------------------------
CREATE TABLE psi_header (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  psi_code      VARCHAR(64)  NOT NULL UNIQUE  COMMENT 'PSI编号 PSI-YYYYMM-xxx',
  sales_type    ENUM('内销','外销') NOT NULL DEFAULT '内销',
  period_month  CHAR(7)      NOT NULL         COMMENT '主月份',
  version_no    INT          DEFAULT 1,
  status        ENUM('DRAFT','REVIEW','CONFIRMED','LOCKED') DEFAULT 'DRAFT',
  is_rolled     TINYINT      DEFAULT 0        COMMENT '是否已滚动',
  rolled_from   BIGINT       DEFAULT NULL     COMMENT '滚动来源header_id',
  created_by    BIGINT       NOT NULL,
  approved_by   BIGINT       DEFAULT NULL,
  approved_at   DATETIME     DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_period (period_month),
  INDEX idx_status (status)
) ENGINE=InnoDB COMMENT='PSI头表';

CREATE TABLE psi_line (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  header_id     BIGINT       NOT NULL,
  product_code  VARCHAR(64)  NOT NULL,
  month_offset  TINYINT      NOT NULL         COMMENT '0=当月,1=次月,2=第三月',
  inventory_begin DECIMAL(14,2) DEFAULT 0    COMMENT '期初库存',
  sales_plan    DECIMAL(14,2) DEFAULT 0      COMMENT '销售计划',
  production_plan DECIMAL(14,2) DEFAULT 0    COMMENT '生产计划',
  inventory_end DECIMAL(14,2) DEFAULT 0      COMMENT '期末库存(自动计算)',
  safety_stock  DECIMAL(14,2) DEFAULT 0      COMMENT '安全库存',
  color_status  ENUM('R','Y','G') DEFAULT 'G' COMMENT '红黄绿灯',
  is_editable   TINYINT      DEFAULT 1,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (header_id) REFERENCES psi_header(id) ON DELETE CASCADE,
  INDEX idx_header (header_id),
  INDEX idx_product (product_code)
) ENGINE=InnoDB COMMENT='PSI明细行(三月滚动)';

-- 自动计算期末库存的触发器
DELIMITER //
CREATE TRIGGER trg_psi_line_calc_end
BEFORE INSERT ON psi_line
FOR EACH ROW
BEGIN
  SET NEW.inventory_end = NEW.inventory_begin + NEW.production_plan - NEW.sales_plan;
END //

CREATE TRIGGER trg_psi_line_calc_end_update
BEFORE UPDATE ON psi_line
FOR EACH ROW
BEGIN
  SET NEW.inventory_end = NEW.inventory_begin + NEW.production_plan - NEW.sales_plan;
END //
DELIMITER ;

-- 自动计算颜色状态的触发器
DELIMITER //
CREATE TRIGGER trg_psi_line_color
BEFORE INSERT ON psi_line
FOR EACH ROW
BEGIN
  IF NEW.inventory_end < NEW.safety_stock THEN
    SET NEW.color_status = 'R';
  ELSEIF NEW.inventory_end < NEW.safety_stock * 1.2 THEN
    SET NEW.color_status = 'Y';
  ELSE
    SET NEW.color_status = 'G';
  END IF;
END //

CREATE TRIGGER trg_psi_line_color_update
BEFORE UPDATE ON psi_line
FOR EACH ROW
BEGIN
  IF NEW.inventory_end < NEW.safety_stock THEN
    SET NEW.color_status = 'R';
  ELSEIF NEW.inventory_end < NEW.safety_stock * 1.2 THEN
    SET NEW.color_status = 'Y';
  ELSE
    SET NEW.color_status = 'G';
  END IF;
END //
DELIMITER ;

-- ------------------------------------------------------------
-- 7. S&OP会议
-- ------------------------------------------------------------
CREATE TABLE sop_meeting (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  meeting_code  VARCHAR(64)  NOT NULL UNIQUE  COMMENT '会议编号',
  meeting_type  ENUM('PRE_SOP','EXECUTIVE','WEEKLY','AD_HOC') NOT NULL,
  meeting_date  DATETIME     NOT NULL,
  status        ENUM('SCHEDULED','IN_PROGRESS','DECIDED','CLOSED') DEFAULT 'SCHEDULED',
  agenda_json   JSON         DEFAULT NULL     COMMENT '议程(JSON格式)',
  decision_summary TEXT      DEFAULT NULL,
  psi_header_id BIGINT       DEFAULT NULL     COMMENT '关联的PSI',
  created_by    BIGINT       NOT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  closed_at     DATETIME     DEFAULT NULL,
  INDEX idx_type_date (meeting_type, meeting_date)
) ENGINE=InnoDB COMMENT='S&OP会议主表';

CREATE TABLE sop_meeting_attendee (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  meeting_id    BIGINT       NOT NULL,
  user_id       BIGINT       NOT NULL,
  rapid_role    ENUM('R','A','D','I','P') NOT NULL COMMENT 'RAPID角色',
  attendance    ENUM('PRESENT','ABSENT','REMOTE') DEFAULT 'PRESENT',
  vote_result   ENUM('AGREE','VETO','ABSTAIN') DEFAULT NULL,
  vote_comment  TEXT         DEFAULT NULL,
  FOREIGN KEY (meeting_id) REFERENCES sop_meeting(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='会议出席+RAPID表决';

-- ------------------------------------------------------------
-- 8. 决议/Action待办
-- ------------------------------------------------------------
CREATE TABLE sop_action (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  action_code   VARCHAR(64)  NOT NULL UNIQUE  COMMENT 'ACTION编号',
  meeting_id    BIGINT       DEFAULT NULL,
  issue_no      VARCHAR(32)  DEFAULT NULL     COMMENT '议题编号',
  description   TEXT         NOT NULL         COMMENT '任务描述',
  owner_id      BIGINT       NOT NULL         COMMENT '责任人',
  collaborator_ids JSON       DEFAULT NULL     COMMENT '协作者ID数组',
  due_date      DATE         NOT NULL,
  priority      ENUM('P0','P1','P2') DEFAULT 'P1',
  status        ENUM('PENDING','IN_PROGRESS','VERIFYING','CLOSED') DEFAULT 'PENDING',
  evidence_url  VARCHAR(512) DEFAULT NULL    COMMENT '完成证据URL',
  escalation_level TINYINT   DEFAULT 0       COMMENT '升级层级0~3',
  source_system VARCHAR(64)  DEFAULT 'SOP'   COMMENT '来源系统(会议助手/手动)',
  created_by    BIGINT       NOT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  closed_at     DATETIME     DEFAULT NULL,
  INDEX idx_owner (owner_id),
  INDEX idx_status_due (status, due_date),
  INDEX idx_priority (priority)
) ENGINE=InnoDB COMMENT='Action待办表(输出到会议助手系统)';

-- ------------------------------------------------------------
-- 9. KPI指标
-- ------------------------------------------------------------
CREATE TABLE kpi_standard (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  kpi_code      VARCHAR(64)  NOT NULL UNIQUE,
  kpi_name      VARCHAR(128) NOT NULL,
  category      ENUM('MI','PI','KPI') NOT NULL COMMENT '领先/过程/结果',
  target_value  DECIMAL(14,2) NOT NULL,
  warning_threshold DECIMAL(14,2) DEFAULT NULL,
  critical_threshold DECIMAL(14,2) DEFAULT NULL,
  data_source   VARCHAR(256) NOT NULL         COMMENT '取数来源描述',
  calc_formula  VARCHAR(512) DEFAULT NULL    COMMENT '计算公式',
  time_window   VARCHAR(32)  DEFAULT '16th-15th',
  is_active     TINYINT      DEFAULT 1,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='KPI标准定义(29项)';

CREATE TABLE kpi_actual (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  kpi_id        BIGINT       NOT NULL,
  period_month  CHAR(7)      NOT NULL,
  actual_value  DECIMAL(14,2) DEFAULT 0,
  status        ENUM('R','Y','G') DEFAULT 'G',
  raw_data_json JSON         DEFAULT NULL     COMMENT '原始数据快照',
  calculated_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (kpi_id) REFERENCES kpi_standard(id),
  UNIQUE KEY uk_kpi_period (kpi_id, period_month),
  INDEX idx_period (period_month)
) ENGINE=InnoDB COMMENT='KPI实绩表';

-- ------------------------------------------------------------
-- 10. 预警引擎
-- ------------------------------------------------------------
CREATE TABLE alert_rule (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  rule_code     VARCHAR(64)  NOT NULL UNIQUE,
  rule_name     VARCHAR(128) NOT NULL,
  trigger_condition TEXT     NOT NULL         COMMENT '触发条件(SQL/表达式)',
  alert_level   ENUM('R','Y','BLOCK') NOT NULL COMMENT '红/黄/拦截',
  notify_users  JSON         DEFAULT NULL     COMMENT '通知用户ID数组',
  notify_roles  JSON         DEFAULT NULL     COMMENT '通知角色数组',
  escalation_path JSON      DEFAULT NULL     COMMENT '升级路径JSON',
  is_active     TINYINT      DEFAULT 1,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='预警规则表(11条)';

CREATE TABLE alert_log (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  rule_id       BIGINT       NOT NULL,
  triggered_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  level         ENUM('R','Y','BLOCK') NOT NULL,
  message       TEXT         NOT NULL,
  entity_type   VARCHAR(64)  DEFAULT NULL,
  entity_id     BIGINT       DEFAULT NULL,
  is_acknowledged TINYINT    DEFAULT 0,
  acknowledged_by BIGINT     DEFAULT NULL,
  acknowledged_at DATETIME   DEFAULT NULL,
  is_resolved   TINYINT      DEFAULT 0,
  resolved_at   DATETIME     DEFAULT NULL,
  escalation_level TINYINT   DEFAULT 0,
  INDEX idx_rule_time (rule_id, triggered_at),
  INDEX idx_unresolved (is_resolved, triggered_at)
) ENGINE=InnoDB COMMENT='预警日志表';

-- ------------------------------------------------------------
-- 11. 自检待办
-- ------------------------------------------------------------
CREATE TABLE self_check_template (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  template_code VARCHAR(64)  NOT NULL UNIQUE,
  template_name VARCHAR(128) NOT NULL,
  frequency     ENUM('DAILY','WEEKLY','MONTHLY') DEFAULT 'WEEKLY',
  items_json    JSON         NOT NULL         COMMENT '检查项数组',
  is_active     TINYINT      DEFAULT 1
) ENGINE=InnoDB COMMENT='自检模板表(10项每周自检)';

CREATE TABLE self_check_record (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  template_id   BIGINT       NOT NULL,
  week_no       VARCHAR(16)  NOT NULL         COMMENT '周次 YYYY-WW',
  checked_by    BIGINT       NOT NULL,
  check_date    DATE         NOT NULL,
  items_result_json JSON     NOT NULL         COMMENT '各项结果',
  total_score   DECIMAL(6,2) DEFAULT 0,
  issues_found  TEXT         DEFAULT NULL,
  is_passed     TINYINT      DEFAULT 0,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_week (week_no),
  INDEX idx_checker (checked_by)
) ENGINE=InnoDB COMMENT='自检记录表';

-- ------------------------------------------------------------
-- 12. 流程配置
-- ------------------------------------------------------------
CREATE TABLE flow_config (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  flow_code     VARCHAR(64)  NOT NULL UNIQUE,
  flow_name     VARCHAR(128) NOT NULL,
  flow_type     ENUM('MAIN','R&D','SALES','PURCHASE_PROD','QUALITY') NOT NULL,
  steps_json    JSON         NOT NULL         COMMENT '流程步骤数组',
  source        ENUM('PPT','MEETING') DEFAULT 'PPT' COMMENT '来源标注',
  is_active     TINYINT      DEFAULT 1,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='流程配置表(5大流程)';

-- ------------------------------------------------------------
-- 13. 硬拦截日志
-- ------------------------------------------------------------
CREATE TABLE block_log (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  block_type    ENUM('BOM_UNARCHIVED','MOLD_DRAWING_OUTDATED','CAPACITY_OVERLOAD') NOT NULL,
  entity_type   VARCHAR(64)  NOT NULL         COMMENT '被拦截对象类型',
  entity_code   VARCHAR(128) NOT NULL         COMMENT '被拦截对象编码',
  block_reason  TEXT         NOT NULL,
  blocked_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  blocked_by_system VARCHAR(64) DEFAULT 'SOP_ENGINE',
  is_overridden TINYINT      DEFAULT 0,
  overridden_by BIGINT       DEFAULT NULL,
  overridden_at DATETIME     DEFAULT NULL,
  override_reason TEXT       DEFAULT NULL,
  INDEX idx_entity (entity_type, entity_code),
  INDEX idx_blocked_at (blocked_at)
) ENGINE=InnoDB COMMENT='硬拦截日志(审计用)';

-- ------------------------------------------------------------
-- 14. 审计日志
-- ------------------------------------------------------------
CREATE TABLE audit_log (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  table_name    VARCHAR(64)  NOT NULL,
  record_id     BIGINT       NOT NULL,
  action        ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  old_value_json JSON        DEFAULT NULL,
  new_value_json JSON        DEFAULT NULL,
  changed_by    BIGINT       NOT NULL,
  changed_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  change_reason VARCHAR(512) DEFAULT NULL,
  version_no    INT          DEFAULT 1,
  INDEX idx_table_record (table_name, record_id),
  INDEX idx_changed_at (changed_at)
) ENGINE=InnoDB COMMENT='审计日志(所有关键表变更留痕)';

-- ------------------------------------------------------------
-- 15. IM会话表
-- ------------------------------------------------------------
CREATE TABLE im_conversation (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  conv_type     ENUM('SINGLE','GROUP','SYSTEM','MEETING_ROOM') NOT NULL DEFAULT 'SINGLE',
  conv_name     VARCHAR(256) DEFAULT NULL     COMMENT '群名/会议名',
  owner_id      BIGINT       NOT NULL         COMMENT '创建者user_id',
  related_type  ENUM('MEETING','ACTION','ALERT','PSI','KPI','GENERAL') DEFAULT 'GENERAL' COMMENT '关联业务类型',
  related_id    BIGINT       DEFAULT NULL     COMMENT '关联业务ID',
  is_active     TINYINT      DEFAULT 1,
  last_msg_at   DATETIME     DEFAULT NULL     COMMENT '最后消息时间(排序用)',
  last_msg_preview VARCHAR(512) DEFAULT NULL COMMENT '最后消息预览',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_owner (owner_id),
  INDEX idx_related (related_type, related_id),
  INDEX idx_last_msg (last_msg_at DESC)
) ENGINE=InnoDB COMMENT='IM会话表(单聊/群聊/系统/会议)';

-- ------------------------------------------------------------
-- 16. IM会话成员
-- ------------------------------------------------------------
CREATE TABLE im_conversation_member (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  conv_id       BIGINT       NOT NULL,
  user_id       BIGINT       NOT NULL,
  role          ENUM('OWNER','ADMIN','MEMBER') DEFAULT 'MEMBER',
  is_muted      TINYINT      DEFAULT 0         COMMENT '是否免打扰',
  is_pinned     TINYINT      DEFAULT 0         COMMENT '是否置顶',
  unread_count  INT          DEFAULT 0,
  last_read_msg_id BIGINT     DEFAULT 0         COMMENT '已读到最后消息ID',
  joined_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
  left_at       DATETIME     DEFAULT NULL,
  UNIQUE KEY uk_conv_user (conv_id, user_id),
  INDEX idx_user (user_id),
  FOREIGN KEY (conv_id) REFERENCES im_conversation(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='IM会话成员表';

-- ------------------------------------------------------------
-- 17. IM消息表
-- ------------------------------------------------------------
CREATE TABLE im_message (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  conv_id       BIGINT       NOT NULL,
  sender_id     BIGINT       NOT NULL         COMMENT '发送者(0=系统)',
  msg_type      ENUM('TEXT','IMAGE','FILE','VOICE','VIDEO','SYSTEM','ALERT','ACTION_REMINDER','MEETING_INVITE','RAPID_VOTE','QUOTE_REPLY','EMOJI_REACTION','RECALL') NOT NULL DEFAULT 'TEXT',
  content       TEXT         DEFAULT NULL,
  rich_content_json JSON      DEFAULT NULL       COMMENT '富文本/卡片/按钮等结构化内容',
  reply_to_msg_id BIGINT     DEFAULT NULL     COMMENT '引用回复的消息ID',
  is_recalled   TINYINT      DEFAULT 0,
  recalled_at   DATETIME     DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conv_time (conv_id, created_at DESC),
  INDEX idx_sender (sender_id),
  FOREIGN KEY (conv_id) REFERENCES im_conversation(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='IM消息表(所有类型统一存储)';

-- ------------------------------------------------------------
-- 18. IM消息已读回执
-- ------------------------------------------------------------
CREATE TABLE im_message_receipt (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  msg_id        BIGINT       NOT NULL,
  user_id       BIGINT       NOT NULL,
  status        ENUM('SENT','DELIVERED','READ') DEFAULT 'SENT',
  read_at       DATETIME     DEFAULT NULL,
  delivered_at  DATETIME     DEFAULT NULL,
  UNIQUE KEY uk_msg_user (msg_id, user_id),
  INDEX idx_user_status (user_id, status),
  FOREIGN KEY (msg_id) REFERENCES im_message(id) ON DELETE CASCADE
) ENGINE=InnoDB COMMENT='IM消息已读回执表';

-- ------------------------------------------------------------
-- 19. IM用户通知偏好
-- ------------------------------------------------------------
CREATE TABLE im_notification_rule (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  user_id       BIGINT       NOT NULL UNIQUE,
  alert_realtime_push   TINYINT DEFAULT 1  COMMENT '预警实时推送',
  action_reminder_push  TINYINT DEFAULT 1  COMMENT 'Action提醒推送',
  meeting_invite_push   TINYINT DEFAULT 1  COMMENT '会议邀请推送',
  psi_update_push       TINYINT DEFAULT 0  COMMENT 'PSI变更推送',
  kpi_report_push       TINYINT DEFAULT 1  COMMENT 'KPI报告推送',
  self_check_push       TINYINT DEFAULT 1  COMMENT '自检报告推送',
  quiet_hours_start     TIME    DEFAULT '22:00' COMMENT '免打扰开始',
  quiet_hours_end       TIME    DEFAULT '08:00' COMMENT '免打扰结束',
  allow_at_mention_bypass TINYINT DEFAULT 1 COMMENT '@提及突破免打扰',
  channel_priority      JSON    DEFAULT '["WEBSOCKET","WECHAT_WORK","SMS","EMAIL"]' COMMENT '推送通道优先级',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='IM用户通知偏好设置';

-- ------------------------------------------------------------
-- 20. IM外部推送日志
-- ------------------------------------------------------------
CREATE TABLE im_push_log (
  id            BIGINT       PRIMARY KEY AUTO_INCREMENT,
  msg_id        BIGINT       DEFAULT NULL,
  channel       ENUM('WEBSOCKET','WECHAT_WORK','DINGTALK','FEISHU','SMS','EMAIL','IN_APP') NOT NULL,
  target_user_id BIGINT      NOT NULL,
  target_address VARCHAR(256) DEFAULT NULL    COMMENT '手机号/邮箱/Webhook URL',
  status        ENUM('PENDING','SENT','DELIVERED','READ','FAILED') DEFAULT 'PENDING',
  response_code VARCHAR(32)  DEFAULT NULL,
  response_msg  TEXT         DEFAULT NULL,
  sent_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
  retry_count   TINYINT      DEFAULT 0,
  INDEX idx_msg (msg_id),
  INDEX idx_target_status (target_user_id, status),
  INDEX idx_sent_at (sent_at)
) ENGINE=InnoDB COMMENT='IM外部推送日志(微信/短信/邮件)';

-- ------------------------------------------------------------
-- 索引优化: 常用查询
-- ------------------------------------------------------------
CREATE INDEX idx_psi_line_header_product ON psi_line(header_id, product_code);
CREATE INDEX idx_action_owner_status ON sop_action(owner_id, status);
CREATE INDEX idx_kpi_actual_month ON kpi_actual(period_month, status);
CREATE INDEX idx_alert_unresolved_level ON alert_log(is_resolved, level);
CREATE INDEX idx_im_msg_conv ON im_message(conv_id, created_at DESC);
CREATE INDEX idx_im_receipt_unread ON im_message_receipt(status) WHERE status != 'READ';

-- ============================================================
-- END OF DDL
-- ============================================================
