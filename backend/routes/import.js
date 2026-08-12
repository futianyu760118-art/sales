const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const path = require('path');
const fs = require('fs');

// multer配置：内存存储，支持多种格式
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB限制
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv', '.tsv', '.ods'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式，请上传 Excel(.xlsx/.xls)、CSV(.csv)、TSV(.tsv) 或 ODS(.ods) 文件'));
    }
  }
});

// 健壮数值解析：去掉货币符号/千分位等非数字字符
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const s = String(v).replace(/[^\d.\-eE]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

// 表头归一化：去换行/空格/BOM、全角转半角括号冒号斜杠、小写
function normalizeHeader(s) {
  return String(s == null ? '' : s)
    .replace(/\r/g, '').replace(/\n/g, '').replace(/\s+/g, '')
    .replace(/^\uFEFF/, '').replace(/\u200B/g, '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/：/g, ':').replace(/／/g, '/')
    .toLowerCase();
}

// 子表名称 → 子模块：按目标表名挑选工作簿中对应的 Sheet
const TABLE_SHEET_HINTS = {
  bom_pricing: ['bom核价', '核价表', 'bom'],
  inquiries: ['询价'],
  customers: ['客户'],
  products: ['产品', '配置'],
  materials: ['物料'],
  projects: ['项目'],
  project_progress: ['进度'],
  project_supply_issues: ['品质', '异常', '供应链'],
  project_sales_promotion: ['推广', '销售'],
  project_reviews: ['复盘'],
  project_initiation: ['立项', '申请书'],
  expenses: ['费用'],
  labor: ['人工', '工资'],
  product_labor_rate: ['成品工价', '工价库', '产品工价']
};
function pickSheetName(workbook, tableName) {
  const names = (workbook && workbook.SheetNames) || [];
  const hints = (tableName && TABLE_SHEET_HINTS[tableName]) || [];
  for (const h of hints) {
    const nh = normalizeHeader(h);
    const found = names.find(n => normalizeHeader(n).includes(nh));
    if (found) return found;
  }
  return names[0];
}

// 解析上传文件为JSON数组
function parseFile(buffer, originalname, tableName) {
  const ext = path.extname(originalname).toLowerCase();
  let workbook;

  if (ext === '.csv' || ext === '.tsv') {
    // CSV/TSV：先转为二进制buffer再让xlsx解析，避免编码问题
    const separator = ext === '.tsv' ? '\t' : ',';
    workbook = XLSX.read(buffer, { type: 'buffer', raw: true, FS: separator, codepage: 65001 });
  } else {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  }

  const sheetName = pickSheetName(workbook, tableName);
  const sheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  // Date对象 → YYYY-MM-DD字符串
  const fmtDate = (d) => d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  jsonData.forEach(row => {
    Object.keys(row).forEach(k => {
      if (row[k] instanceof Date) row[k] = fmtDate(row[k]);
    });
  });
  return jsonData;
}

// 字段映射：中文表头 → 数据库字段
const fieldMappings = {
  inquiries: {
    '询价单号': 'serial_number', '单号': 'serial_number',
    '客户名称': 'customer_name', '客户': 'customer_name',
    '客户来源': 'customer_source', '来源': 'customer_source',
    '国家/地区': 'country_region', '国家': 'country_region', '地区': 'country_region',
    '销售员': 'sales_person', '销售': 'sales_person', '负责人': 'sales_person',
    '询价时间': 'inquiry_time', '时间': 'inquiry_time',
    '交货日期': 'delivery_date', '交期': 'delivery_date',
    '外部型号': 'external_model', '产品型号': 'external_model', '型号': 'external_model',
    '内部型号': 'internal_model',
    '产品品类': 'product_category', '品类': 'product_category', '类别': 'product_category',
    '功率': 'power',
    '配置': 'configuration', '配置说明': 'configuration',
    '数量': 'quantity',
    '定制要求': 'custom_requirements', '定制': 'custom_requirements',
    '特殊工艺': 'special_process',
    '备注': 'remarks',
    '报价有效期': 'quote_validity',
    '状态': 'status',
    '物料成本': 'material_cost',
    '加工成本': 'process_cost',
    '辅料成本': 'accessory_cost',
    '预计损耗': 'estimated_loss',
    '基础成本': 'base_cost',
    '利润率': 'profit_rate',
    '优惠率': 'discount_rate',
    '最终报价': 'final_price', '报价': 'final_price', '金额': 'final_price',
    '流失原因': 'lost_reason'
  },
  customers: {
    '客户编号': 'customer_code', '编号': 'customer_code', '序号': 'customer_code', '展位号': 'customer_code', '展商编号': 'customer_code',
    '客户全称': 'name', '客户名称': 'name', '客户': 'name', '名称': 'name', '公司名称': 'name', '公司': 'name', '企业名称': 'name', '客户名': 'name', '参展商': 'name',
    '客户曾用名': 'former_name', '曾用名': 'former_name',
    '母公司编号': 'parent_code',
    '决策人姓名': 'decision_maker', '决策人': 'decision_maker',
    '决策人职位': 'decision_maker_position',
    '决策核心诉求': 'decision_core_need',
    '普通对接人': 'contact_person', '联系人': 'contact_person', '对接人': 'contact_person', '联系人姓名': 'contact_person', '客户联系人': 'contact_person', '业务联系人': 'contact_person',
    '对接人职位': 'contact_position', '职位': 'contact_position', '职务': 'contact_position',
    '联系电话(含区号)': 'phone', '联系电话': 'phone', '电话': 'phone', '手机': 'phone', '手机号': 'phone', '联系方式': 'phone', '电话号码': 'phone', '座机': 'phone', '固话': 'phone', 'Tel': 'phone', 'Phone': 'phone', 'Mobile': 'phone',
    '对接邮箱': 'email', '邮箱': 'email', '电子邮件': 'email', '电子邮箱': 'email', '客户邮箱': 'email', 'E-mail': 'email', 'EMAIL': 'email', 'Email': 'email', 'Mail': 'email',
    '微信号': 'wechat', '微信': 'wechat', 'WeChat': 'wechat',
    'WhatsApp': 'whatsapp', 'Whatsapp': 'whatsapp', 'WA': 'whatsapp',
    'Skype': 'skype', 'skype': 'skype', 'QQ': 'other_im', 'QQ号': 'other_im', '其他即时联系方式': 'other_im',
    '客户等级': 'customer_level', '等级': 'customer_level',
    '销售模式': 'sales_mode', '模式': 'sales_mode',
    '客户状态': 'customer_status', '状态': 'customer_status', '合作状态': 'customer_status',
    '所属业务员': 'sales_person', '销售员': 'sales_person', '销售': 'sales_person', '负责人': 'sales_person', '业务员': 'sales_person', '业务代表': 'sales_person',
    '最后交易年份': 'last_trade_year', '交易年份': 'last_trade_year',
    '开票抬头': 'invoice_title', '抬头': 'invoice_title',
    '纳税人识别号': 'tax_id', '统一社会信用代码': 'tax_id', '信用代码': 'tax_id', '税号': 'tax_id',
    '开户银行': 'bank_name', '银行': 'bank_name', '开户行': 'bank_name',
    '银行账号': 'bank_account', '账号': 'bank_account',
    '地址': 'address', '详细地址': 'address', '通讯地址': 'address', '公司地址': 'address',
    '国家/地区': 'country_region', '国家': 'country_region', '地区': 'country_region', '国家地区': 'country_region', '所在地区': 'country_region', '省份': 'country_region', '城市': 'country_region',
    '客户来源': 'customer_source', '来源': 'customer_source', '信息来源': 'customer_source', '获客渠道': 'customer_source',
    '备注说明': 'remarks', '备注': 'remarks', '说明': 'remarks', '跟进备注': 'remarks'
  },
  products: {
    '产品名称': 'name', '名称': 'name',
    '外部型号': 'external_model', '产品型号': 'external_model', '型号': 'external_model',
    '内部型号': 'internal_model',
    '品类': 'category', '产品品类': 'category', '类别': 'category',
    '功率': 'power',
    '配置': 'configuration', '配置说明': 'configuration',
    '单位': 'unit',
    '状态': 'status',
    '备注': 'remarks'
  },
  materials: {
    '物料名称': 'material_name', '名称': 'material_name',
    '物料编码': 'material_code', '编码': 'material_code', '物料编号': 'material_code',
    '分类': 'category', '物料分类': 'category',
    '规格参数': 'specs', '规格': 'specs',
    '材质': 'material_type', '材料': 'material_type',
    '单位': 'unit',
    '标准成本': 'standard_cost', '成本': 'standard_cost',
    '加工费': 'processing_cost', '加工工艺费': 'processing_cost',
    '加工损耗': 'processing_loss', '损耗': 'processing_loss',
    '供应商': 'supplier',
    '状态': 'status', '物料状态': 'status',
    '证书要求': 'certificate_required', '证书': 'certificate_required',
    '产品ID': 'product_id', '产品编号': 'product_id',
    '单价': 'unit_price', '价格': 'unit_price',
    '数量': 'quantity', '库存数量': 'inventory_qty', '库存': 'inventory_qty',
    '最低库存': 'min_inventory', '月用量': 'monthly_usage',
    '总价': 'total_amount', '金额': 'total_amount', '小计': 'total_amount',
    '入库时间': 'stock_date', '入库日期': 'stock_date', '日期': 'stock_date',
    '备注': 'remarks'
  },
  expenses: {
    '费用编码': 'expense_code', '编码': 'expense_code', '编号': 'expense_code',
    '费用名称': 'expense_name', '名称': 'expense_name', '摘要': 'expense_name',
    '费用大类': 'expense_category', '大类': 'expense_category', '费用类别': 'expense_category',
    '费用细类': 'expense_type', '细类': 'expense_type', '子类': 'expense_type', '类型': 'expense_type',
    '所属部门': 'department', '部门': 'department',
    '关联项目': 'project', '项目': 'project',
    '收款方': 'supplier', '供应商': 'supplier', '对方单位': 'supplier', '收款单位': 'supplier',
    '发生日期': 'occur_date', '日期': 'occur_date', '费用日期': 'occur_date',
    '归属账期': 'account_period', '账期': 'account_period', '月份': 'account_period',
    '金额': 'amount', '不含税金额': 'amount', '费用金额': 'amount',
    '税率': 'tax_rate',
    '税额': 'tax_amount',
    '价税合计': 'total_amount', '合计': 'total_amount', '含税金额': 'total_amount',
    '币种': 'currency',
    '支付方式': 'payment_method',
    '支付状态': 'payment_status', '状态': 'payment_status',
    '经办人': 'payee', '报销人': 'payee',
    '发票号': 'invoice_no', '发票号码': 'invoice_no',
    '发票类型': 'invoice_type',
    '数据来源': 'source', '来源': 'source',
    '备注': 'remarks', '说明': 'remarks'
  },
  labor: {
    '人工编码': 'labor_code', '编码': 'labor_code', '记录编号': 'labor_code',
    '员工姓名': 'employee_name', '姓名': 'employee_name', '人员': 'employee_name',
    '工号': 'employee_no', '员工编号': 'employee_no',
    '部门': 'department',
    '岗位': 'position', '职务': 'position',
    '人工类型': 'labor_type', '类型': 'labor_type', '计薪方式': 'labor_type',
    '工作日期': 'work_date', '日期': 'work_date',
    '归属月份': 'work_month', '月份': 'work_month', '工资月份': 'work_month',
    '工时': 'hours', '正常工时': 'hours', '出勤工时': 'hours',
    '加班工时': 'overtime_hours',
    '件数': 'pieces', '完工件数': 'pieces', '产量': 'pieces',
    '单价': 'unit_price', '时薪': 'unit_price', '计件单价': 'unit_price',
    '基本工资': 'base_amount', '底薪': 'base_amount', '月薪': 'base_amount',
    '加班费': 'overtime_pay',
    '补贴': 'subsidy', '津贴': 'subsidy',
    '奖金': 'bonus', '绩效': 'bonus', '奖金/绩效': 'bonus',
    '社保': 'social_insurance', '社保(企业)': 'social_insurance',
    '公积金': 'housing_fund', '公积金(企业)': 'housing_fund',
    '合计金额': 'total_amount', '合计': 'total_amount', '人工成本': 'total_amount', '应发': 'total_amount',
    '关联项目': 'project', '项目': 'project',
    '数据来源': 'source', '来源': 'source',
    '备注': 'remarks', '说明': 'remarks'
  },
  product_labor_rate: {
    'bom编号': 'bom_no', 'bom_no': 'bom_no', 'BOM编号': 'bom_no', 'BOM': 'bom_no',
    '产品编码': 'product_code', '产品编号': 'product_code', '编码': 'product_code',
    '产品名称': 'product_name', '名称': 'product_name',
    '工价': 'labor_rate', '单台工价': 'labor_rate', '成品工价': 'labor_rate', '工价(元/台)': 'labor_rate',
    '计价方式': 'labor_rate_type', '工价类型': 'labor_rate_type', '类型': 'labor_rate_type',
    '工艺成本': 'process_cost', '单台工艺': 'process_cost',
    '生效日': 'effective_date', '生效日期': 'effective_date',
    '失效日': 'expire_date', '失效日期': 'expire_date',
    '来源': 'source', '数据来源': 'source',
    '审核状态': 'audit_status', '状态': 'audit_status',
    '审核人': 'approved_by',
    '备注': 'remarks', '说明': 'remarks'
  },
  bom_pricing: {
    '客户编号': 'customer', '客户': 'customer', '客户代码': 'customer',
    '询价单号': 'inquiry_no', '询价单': 'inquiry_no',
    '产品型号': 'model', '型号': 'model',
    '产品名称': 'product_name', '名称': 'product_name',
    '功率': 'power',
    '产品系列': 'product_series', '系列': 'product_series',
    '证书是否符合标准': 'certificate_compliant', '证书合规': 'certificate_compliant',
    '证书等级': 'certificate_level',
    '套件': 'kit', '电缆线': 'cable', '光源': 'light_source', '驱动': 'driver',
    '电池': 'battery', '支架': 'bracket', '开关': 'switch_type', '太阳能板': 'solar_panel',
    '插座': 'socket', '盒子': 'box', '说明书': 'manual', '包装': 'packaging',
    '配件': 'accessories', '人工': 'labor',
    '合计成本': 'total_cost', '成本合计': 'total_cost', '合计': 'total_cost',
    '人工加工费': 'labor_cost', '加工费': 'labor_cost',
    '工艺成本': 'process_cost', '工艺费': 'process_cost',
    '预估损耗': 'estimated_loss', '损耗': 'estimated_loss',
    '最低限价': 'min_price', '限价': 'min_price',
    '核价人': 'pricer', '核价成员': 'pricer',
    '核价链接': 'pricing_link',
    '核价日期': 'effective_date',
    '感应功能': 'sensor',
    '报价(RMB)': 'price_rmb', '报价RMB': 'price_rmb', '人民币报价': 'price_rmb',
    '报价(USD)': 'price_usd', '报价USD': 'price_usd', '美元报价': 'price_usd',
    '目标价': 'target_price',
    '核价版本': 'pricing_version', '版本': 'pricing_version',
    '备注': 'remarks'
  },
  projects: {
    '项目编号': 'project_no', '编号': 'project_no',
    '项目名称': 'project_name', '名称': 'project_name',
    '客户名称': 'customer_name', '客户': 'customer_name',
    '项目类型': 'project_type', '类型': 'project_type',
    '项目等级': 'project_level', '等级': 'project_level',
    '紧急程度': 'urgency',
    '负责人': 'owner', '项目负责人': 'owner',
    '责任单位': 'department', '部门': 'department',
    '立项时间': 'start_date', '开始日期': 'start_date',
    '目标时间': 'target_date', '目标日期': 'target_date',
    '结案时间': 'close_date', '结束日期': 'close_date',
    '目前阶段': 'current_stage', '阶段': 'current_stage',
    '进度情况': 'progress_note', '进度': 'progress_note',
    '投入金额': 'invest_amount', '投入': 'invest_amount',
    '订单金额': 'order_amount', '订单': 'order_amount',
    '年订单': 'annual_order',
    '上市时间': 'market_date', '上市日期': 'market_date',
    '状态': 'status',
    '稽核状态': 'audit_status', '稽核': 'audit_status',
    '甘特图链接': 'gantt_link',
    '资料链接': 'doc_link',
    '备注': 'remarks'
  },
  project_progress: {
    '项目编号': 'project_no', '编号': 'project_no',
    '项目名称': 'project_name', '名称': 'project_name',
    '计划表': 'plan', 'BOM': 'bom', '规格书': 'spec', '配置表': 'config',
    '模具图纸': 'mold_drawing', '开模评审': 'mold_review', '手样': 'hand_sample',
    '模具': 'mold', '模样': 'mold_sample', '包装设计': 'packaging',
    '电试': 'elec_trial', '研试': 'rd_trial', '工试': 'eng_trial',
    '生试': 'prod_trial', '测试报告': 'test_report', '技转': 'tech_transfer',
    '出货': 'shipment', '复盘': 'review'
  },
  project_supply_issues: {
    '发生日期': 'occur_date', '日期': 'occur_date',
    '提出人': 'proposer', '产品名称': 'product_name', '产品': 'product_name',
    '单号': 'order_no', '项目号': 'project_no', '项目编号': 'project_no',
    '问题描述': 'problem_desc', '描述': 'problem_desc',
    '临时措施': 'temp_measure', '原因分析': 'cause_analysis',
    '长期措施': 'long_term_measure', '长期措施完成时间': 'long_term_date',
    '责任人': 'responsible_person', '责任部门': 'responsible_dept', '部门': 'responsible_dept',
    '计划完成时间': 'plan_complete_date', '计划完成': 'plan_complete_date',
    '稽核': 'audit', '闭环': 'closed', '备注': 'remarks'
  },
  project_sales_promotion: {
    '产品型号': 'product_model', '型号': 'product_model',
    '业务员': 'salesperson', '销售': 'salesperson',
    '客户': 'customer', '外观': 'appearance', '外观反馈': 'appearance',
    '价格': 'price', '价格反馈': 'price',
    '性能': 'performance', '性能反馈': 'performance',
    '功能': 'function_feedback', '功能反馈': 'function_feedback',
    '目前进度': 'progress', '进度': 'progress', '备注': 'remarks'
  },
  project_reviews: {
    '项目编号': 'project_no', '编号': 'project_no',
    '项目名称': 'project_name', '名称': 'project_name',
    '回顾目标': 'goal_original', '当初目的': 'goal_original',
    '里程碑': 'goal_milestone', '回顾目标-里程碑': 'goal_milestone',
    'Highlights': 'result_highlights', '评估结果-Highlights': 'result_highlights',
    'Lowlights': 'result_lowlights', '评估结果-Lowlights': 'result_lowlights',
    '评估结果-实际': 'result_actual', '实际': 'result_actual',
    '成功因素': 'success_factors', '成功关键因素': 'success_factors',
    '失败原因': 'failure_causes', '失败根本原因': 'failure_causes',
    '总结规律': 'insights', '经验规律': 'experience',
    '行动计划': 'action_plan', '备注': 'remarks'
  },
  project_initiation: {
    // 一、基本信息（项目经理填写）
    '项目编号': 'project_no', '编号': 'project_no', '项目名称': 'project_name', '名称': 'project_name',
    '项目类型': 'project_type', '类型': 'project_type',
    '起始时间': 'start_date', '开始时间': 'start_date', '立项时间': 'start_date',
    '项目部门': 'department', '部门': 'department',
    '主要负责人': 'owner', '负责人': 'owner', 'owner': 'owner',
    '配合人员': 'cooperators', '配合': 'cooperators',
    '其他': 'other_info', '其他信息': 'other_info', '备注': 'other_info',
    // 二、客户信息（销售输出填写）
    '客户编号': 'customer_no', '客户号': 'customer_no',
    '客户类型': 'customer_type', '客户种类': 'customer_type',
    '客户等级': 'customer_level', '等级': 'customer_level',
    '客户赢率': 'customer_win_rate', '赢率': 'customer_win_rate', '中标率': 'customer_win_rate',
    '市场状况': 'market_status', '市场': 'market_status', '市场地区': 'market_status',
    '客户痛点识别': 'customer_pain', '客户痛点': 'customer_pain', '痛点': 'customer_pain',
    '关键成功要素': 'key_success', '成功要素': 'key_success', '关键要素': 'key_success',
    '是否有竞争对手': 'has_competitor', '竞争对手': 'has_competitor', '竞品': 'has_competitor',
    '竞争对手状态': 'competitor_status', '竞品状态': 'competitor_status',
    '客户采购周期': 'purchase_cycle', '采购周期': 'purchase_cycle',
    '定制开发类型': 'dev_type', '定制开发': 'dev_type', '开发类型': 'dev_type', '定制': 'dev_type',
    // 三、产品规格对比（导入为JSON文本）
    '产品规格对比': 'product_specs', '产品规格': 'product_specs', '规格对比': 'product_specs', '规格表': 'product_specs',
    // 四、可实现性评估（导入为JSON文本）
    '可实现性评估': 'feasibility', '可行性评估': 'feasibility', '可行性': 'feasibility',
    // 五、销售预测（导入为JSON文本）
    '销售预测': 'sales_forecast', '预测': 'sales_forecast', '销量预测': 'sales_forecast',
    // 六、特殊要求（导入为JSON文本）
    '特殊要求': 'special_reqs', '特别要求': 'special_reqs',
    // 七、审批信息
    '申请人': 'applicant', '申请': 'applicant', '申请日期': 'apply_date', '日期': 'apply_date',
    '审批状态': 'approval_status', '状态': 'approval_status',
    '审批人': 'approver', '批准人': 'approver',
    '审批日期': 'approval_date', '批准日期': 'approval_date',
    '审批意见': 'approval_opinion', '意见': 'approval_opinion', '批注': 'approval_opinion',
    // 兼容旧版模版字段
    '立项背景': 'background', '背景': 'background',
    '必要性分析': 'necessity', '必要性': 'necessity',
    '市场分析': 'market_analysis', '分析': 'market_analysis',
    '研发目标': 'rd_objectives', '目标': 'rd_objectives',
    '研发内容': 'rd_content', '内容': 'rd_content',
    '关键技术': 'key_innovation', '创新点': 'key_innovation',
    '技术方案': 'tech_solution', '方案': 'tech_solution',
    '技术路线': 'tech_route', '路线': 'tech_route',
    '研发计划概述': 'plan_summary', '计划概述': 'plan_summary',
    '关键里程碑': 'milestones', '里程碑': 'milestones',
    '预期成果': 'expected_outcome', '成果': 'expected_outcome',
    '经济效益': 'economic_benefit', '效益': 'economic_benefit',
    '目标市场': 'target_market',
    '预算总额': 'budget_total', '预算': 'budget_total',
    '预算明细': 'budget_detail', '明细': 'budget_detail',
    '团队需求': 'team_requirement', '团队': 'team_requirement',
    '风险分析': 'risk_analysis', '风险': 'risk_analysis',
    '风险对策': 'risk_measures', '对策': 'risk_measures'
  }
};

// 将行数据映射为数据库字段（表头按内容归一化匹配，兼容换行/全角/错位表头）
function mapRow(row, tableName) {
  const mapping = fieldMappings[tableName] || {};
  const normMap = {};
  for (const [k, v] of Object.entries(mapping)) {
    normMap[normalizeHeader(k)] = v;
  }
  const dbFields = new Set(Object.values(mapping));
  const mapped = {};
  for (const [key, value] of Object.entries(row)) {
    const nk = normalizeHeader(key);
    if (normMap[nk]) { mapped[normMap[nk]] = value; continue; }
    if (dbFields.has(nk)) { mapped[nk] = value; continue; }
    const trimmedKey = String(key).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, '');
    if (mapping[trimmedKey]) mapped[mapping[trimmedKey]] = value;
    else if (mapping[trimmedKey.toLowerCase()]) mapped[mapping[trimmedKey.toLowerCase()]] = value;
  }
  return mapped;
}

// 数据验证
function validateRow(row, tableName) {
  const errors = [];
  if (tableName === 'inquiries') {
    if (!row.customer_name) errors.push('客户名称不能为空');
    if (!row.external_model) errors.push('产品型号不能为空');
    if (!row.quantity || isNaN(Number(row.quantity))) row.quantity = 1;
    else row.quantity = Number(row.quantity);
    if (!row.status) row.status = 'new';
    if (!row.serial_number) {
      const d = new Date();
      row.serial_number = `XJ${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${String(Math.floor(Math.random()*1000)).padStart(3,'0')}`;
    }
    if (!row.inquiry_time) {
      row.inquiry_time = now();
    }
    // 数值字段转换
    ['material_cost', 'process_cost', 'accessory_cost', 'estimated_loss', 'base_cost', 'final_price'].forEach(f => {
      if (row[f] !== undefined) row[f] = Number(row[f]) || 0;
    });
    ['profit_rate', 'discount_rate'].forEach(f => {
      if (row[f] !== undefined) row[f] = Number(row[f]) || 0;
    });
  } else if (tableName === 'customers') {
    if (!row.name) errors.push('客户名称不能为空');
    if (row.customer_level) {
      const lv = String(row.customer_level).replace(/\s+/g, '');
      if (lv.includes('A级') || lv.includes('A')) row.customer_level = 'A级（核心大客户）';
      else if (lv.includes('B级') || lv.includes('B')) row.customer_level = 'B级（普通大客户）';
      else if (lv.includes('C级') || lv.includes('C')) row.customer_level = 'C级（中小客户）';
      else if (lv.includes('D级') || lv.includes('D')) row.customer_level = 'D级（新客/休眠客）';
    }
    if (!row.customer_source) row.customer_source = '其他';
    if (!row.customer_level) row.customer_level = 'D级（新客/休眠客）';
    if (!row.sales_mode) row.sales_mode = '外销';
    if (!row.customer_status) row.customer_status = '潜在客户';
  } else if (tableName === 'products') {
    if (!row.name && !row.external_model) errors.push('产品名称或型号不能为空');
    if (!row.status) row.status = 'active';
  } else if (tableName === 'materials') {
    if (!row.material_name) errors.push('物料名称不能为空');
    if (row.unit_price !== undefined) row.unit_price = Number(row.unit_price) || 0;
    if (row.quantity !== undefined) row.quantity = Number(row.quantity) || 1;
    if (row.standard_cost !== undefined) row.standard_cost = Number(row.standard_cost) || 0;
    if (row.processing_cost !== undefined) row.processing_cost = Number(row.processing_cost) || 0;
    if (row.processing_loss !== undefined) row.processing_loss = Number(row.processing_loss) || 0;
    if (row.product_id !== undefined) row.product_id = row.product_id || null;
    if (!row.status) row.status = 'normal';
    if (!row.unit) row.unit = '个';
  } else if (tableName === 'expenses') {
    if (!row.expense_name) errors.push('费用名称不能为空');
    ['amount', 'tax_rate', 'tax_amount', 'total_amount'].forEach(f => {
      if (row[f] !== undefined) row[f] = toNum(row[f]);
    });
    if (row.amount === undefined) row.amount = 0;
    if (!row.source) row.source = 'Excel导入';
    if (!row.currency) row.currency = 'CNY';
    if (!row.payment_status) row.payment_status = '未付';
    if (!row.account_period && row.occur_date) row.account_period = String(row.occur_date).replace('/', '-').substring(0, 7);
    // 金额联动：缺税额/合计时按金额+税率推算
    if (!row.tax_amount && row.amount !== undefined && row.tax_rate !== undefined) {
      row.tax_amount = Math.round(Number(row.amount) * Number(row.tax_rate) / 100 * 100) / 100;
    }
    if (row.total_amount === undefined && row.amount !== undefined) {
      row.total_amount = Math.round((Number(row.amount) + Number(row.tax_amount || 0)) * 100) / 100;
    }
  } else if (tableName === 'labor') {
    if (!row.employee_name) errors.push('员工姓名不能为空');
    ['hours', 'overtime_hours', 'pieces', 'unit_price', 'base_amount', 'overtime_pay',
     'subsidy', 'bonus', 'social_insurance', 'housing_fund', 'total_amount'].forEach(f => {
      if (row[f] !== undefined) row[f] = toNum(row[f]);
    });
    if (!row.labor_type) row.labor_type = '月薪';
    if (!row.source) row.source = 'Excel导入';
    if (!row.work_month && row.work_date) row.work_month = String(row.work_date).replace('/', '-').substring(0, 7);
    // 合计联动：缺合计时按类型推算
    if (row.total_amount === undefined) {
      let core = Number(row.base_amount || 0);
      if (row.labor_type === '计时') core = Number(row.unit_price || 0) * Number(row.hours || 0);
      else if (row.labor_type === '计件') core = Number(row.unit_price || 0) * Number(row.pieces || 0);
      row.total_amount = Math.round((core + Number(row.overtime_pay || 0) + Number(row.subsidy || 0) +
        Number(row.bonus || 0) + Number(row.social_insurance || 0) + Number(row.housing_fund || 0)) * 100) / 100;
    }
  } else if (tableName === 'product_labor_rate') {
    if (!row.bom_no) errors.push('BOM编号(bom_no)不能为空');
    if (row.labor_rate === undefined || row.labor_rate === '' || row.labor_rate === null) errors.push('工价(labor_rate)不能为空');
    ['labor_rate', 'process_cost'].forEach(f => {
      if (row[f] !== undefined && row[f] !== '') row[f] = toNum(row[f]);
    });
    if (row.labor_rate === undefined || row.labor_rate === '') row.labor_rate = 0;
    if (!row.labor_rate_type) row.labor_rate_type = '标准工价';
    if (!row.source) row.source = 'manual';
    if (!row.audit_status) row.audit_status = 'pending';
  } else if (tableName === 'bom_pricing') {
    if (!row.model) errors.push('产品型号不能为空');
    ['kit', 'cable', 'light_source', 'driver', 'battery', 'bracket', 'switch_type',
     'solar_panel', 'socket', 'box', 'manual', 'packaging', 'accessories', 'labor',
     'total_cost', 'labor_cost', 'process_cost', 'estimated_loss',
     'min_price', 'price_rmb', 'price_usd', 'target_price'].forEach(f => {
      if (row[f] !== undefined) row[f] = toNum(row[f]);
    });
    if (row.effective_date !== undefined && row.effective_date !== null && row.effective_date !== '') {
      const v = row.effective_date;
      if (typeof v === 'number' && v > 40000 && v < 100000) {
        const d = new Date((v - 25569) * 86400 * 1000);
        row.effective_date = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      } else if (v instanceof Date) {
        row.effective_date = v.getFullYear() + '-' + String(v.getMonth()+1).padStart(2,'0') + '-' + String(v.getDate()).padStart(2,'0');
      } else if (typeof v === 'string') {
        const m = v.match(/(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})/);
        if (m) {
          let y = m[1], mo = m[2], da = m[3];
          if (y.length === 2) y = '20' + y;
          if (m[1].length !== 4) { y = m[3]; mo = m[1]; da = m[2]; if (y.length === 2) y = '20' + y; }
          row.effective_date = y + '-' + mo.padStart(2,'0') + '-' + da.padStart(2,'0');
        }
      }
    }
    if (!row.pricing_version) row.pricing_version = 'V1.0';
  } else if (tableName === 'projects') {
    if (!row.project_name) errors.push('项目名称不能为空');
    ['invest_amount', 'order_amount'].forEach(f => {
      if (row[f] !== undefined) row[f] = Number(row[f]) || 0;
    });
    if (!row.status) row.status = 'init';
    if (!row.project_type) row.project_type = '客制';
    if (!row.department) row.department = '研发中心';
    if (!row.current_stage) row.current_stage = '预项目';
  } else if (tableName === 'project_progress') {
    if (!row.project_no && !row.project_name) errors.push('项目编号或名称不能为空');
    // 进度字段日期转换：Excel序列号 → YYYY-MM-DD
    const progFields = ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','mold','mold_sample','packaging','elec_trial','rd_trial','eng_trial','prod_trial','test_report','tech_transfer','shipment','review','other'];
    progFields.forEach(f => {
      if (typeof row[f] === 'number' && row[f] > 40000 && row[f] < 100000) {
        const d = new Date((row[f] - 25569) * 86400 * 1000);
        row[f] = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      }
      // 日期格式验证：确保符合 YYYY-MM-DD 标准
      if (row[f] && typeof row[f] === 'string') {
        const v = String(row[f]).trim();
        // 兼容 YYYY/MM/DD、YYYY.MM.DD 格式
        const m1 = v.match(/^(\d{4})[\/\.](\d{1,2})[\/\.](\d{1,2})/);
        if (m1) {
          row[f] = m1[1] + '-' + m1[2].padStart(2,'0') + '-' + m1[3].padStart(2,'0');
        }
        // 验证最终日期格式
        if (!/^(V|√|X|×|\/|-|进行中|待定)?$/.test(v) && !/^\d{4}-\d{2}-\d{2}/.test(row[f])) {
          errors.push(`字段"${f}"的值"${v}"不是有效的日期格式(YYYY-MM-DD)或状态标记(V/X)`);
        }
      }
    });
  } else if (tableName === 'project_supply_issues') {
    if (!row.product_name && !row.problem_desc) errors.push('产品或问题描述不能为空');
    if (!row.occur_date) row.occur_date = '';
    if (row.closed !== undefined) row.closed = Number(row.closed) || 0;
  } else if (tableName === 'project_sales_promotion') {
    if (!row.product_model) errors.push('产品型号不能为空');
  } else if (tableName === 'project_reviews') {
    // 复盘数据至少需要项目编号
  }
  return { row, errors };
}

// ===== 解析Excel表头，返回字段映射配置 =====
router.post('/parse-headers/:table', upload.single('file'), (req, res) => {
  const tableName = req.params.table;
  const supportedTables = ['inquiries', 'customers', 'products', 'materials', 'bom_pricing', 'projects', 'project_progress', 'project_supply_issues', 'project_sales_promotion', 'project_reviews', 'project_initiation', 'expenses', 'labor', 'product_labor_rate'];


  if (!supportedTables.includes(tableName)) {
    return res.status(400).json({ error: `不支持的导入表: ${tableName}` });
  }

  if (!req.file) {
    return res.status(400).json({ error: '请上传文件' });
  }

  try {
    const rows = parseFile(req.file.buffer, req.file.originalname, tableName);
    if (rows.length === 0) {
      return res.status(400).json({ error: '文件中没有数据' });
    }

    const mapping = fieldMappings[tableName] || {};
    const rawHeaders = Object.keys(rows[0]);
    const headers = rawHeaders.map(h => String(h).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, ''));

    // 自动匹配映射
    const autoMapping = {};
    const unmatched = [];
    headers.forEach((h, idx) => {
      if (mapping[h]) {
        autoMapping[idx] = { header: h, field: mapping[h], matched: true };
      } else if (mapping[h.toLowerCase()]) {
        autoMapping[idx] = { header: h, field: mapping[h.toLowerCase()], matched: true };
      } else {
        autoMapping[idx] = { header: h, field: '', matched: false };
        unmatched.push({ idx, header: h });
      }
    });

    // 获取所有可映射的字段（去重）
    const allFields = [...new Set(Object.values(mapping))];

    // 预览前3行数据
    const preview = rows.slice(0, 3).map(row =>
      headers.map(h => {
        const rawKey = rawHeaders.find(rk => String(rk).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, '') === h);
        return row[rawKey] || '';
      })
    );

    res.json({
      headers,
      autoMapping,
      unmatched,
      allFields,
      preview,
      totalRows: rows.length
    });
  } catch (e) {
    res.status(500).json({ error: `文件解析失败: ${e.message}` });
  }
});

// ===== 批量导入API（支持自定义映射） =====
// ==================== 立项申请书多Sheet结构化导入 ====================
// 按详情格式字段做字符匹配，解析主表+5子表，汇总为一条记录
router.post('/project_initiation_structured', upload.single('file'), requirePerm('initiation:apply'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sv = v => v == null ? '' : String(v).trim();

    // 找Sheet：按名称包含关键词匹配
    function findSheet(keywords) {
      return wb.SheetNames.find(n => keywords.some(k => n.includes(k)));
    }
    const mainSheet = findSheet(['立项申请', '主表', '申请书']) || wb.SheetNames[0];
    const basicSheet = findSheet(['基本信息']);
    const specSheet = findSheet(['产品规格', '规格对比']);
    const feasSheet = findSheet(['可实现', '可行性', '评估']);
    const forecastSheet = findSheet(['销售预测', '预测']);
    const reqsSheet = findSheet(['特殊要求', '特殊']);

    // --- 扁平字段：主表 + 基本信息子表，按字符匹配详情格式字段名 ---
    // 详情格式字段名 → 数据库字段 的映射
    const flatMap = {
      '项目编号': 'project_no', '编号': 'project_no',
      '项目名称': 'project_name', '名称': 'project_name',
      '项目类型': 'project_type', '类型': 'project_type',
      '起始时间': 'start_date', '开始时间': 'start_date', '立项时间': 'start_date',
      '项目部门': 'department', '部门': 'department', '责任单位': 'department',
      '主要负责人': 'owner', '负责人': 'owner',
      '配合人员': 'cooperators', '配合': 'cooperators',
      '其他': 'other_info', '其他信息': 'other_info',
      '客户编号': 'customer_no', '客户号': 'customer_no',
      '客户类型': 'customer_type', '客户种类': 'customer_type',
      '客户等级': 'customer_level', '等级': 'customer_level',
      '客户赢率': 'customer_win_rate', '赢率': 'customer_win_rate', '中标率': 'customer_win_rate',
      '市场状况': 'market_status', '市场': 'market_status', '市场地区': 'market_status',
      '客户痛点识别': 'customer_pain', '客户痛点': 'customer_pain', '痛点': 'customer_pain',
      '关键成功要素': 'key_success', '成功要素': 'key_success', '关键要素': 'key_success',
      '是否有竞争对手': 'has_competitor', '竞争对手': 'has_competitor', '竞品': 'has_competitor',
      '竞争对手状态': 'competitor_status', '竞品状态': 'competitor_status',
      '客户采购周期': 'purchase_cycle', '采购周期': 'purchase_cycle',
      '定制开发类型': 'dev_type', '定制开发': 'dev_type', '定制': 'dev_type',
      '申请人': 'applicant', '申请日期': 'apply_date',
      '审批状态': 'approval_status', '审批人': 'approver',
      '审批日期': 'approval_date', '批准日期': 'approval_date',
      '审批意见': 'approval_opinion', '意见': 'approval_opinion',
      '备注': 'remarks'
    };

    function extractFlat(sheetName) {
      const obj = {};
      if (!sheetName || !wb.Sheets[sheetName]) return obj;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      rows.forEach(row => {
        const a = sv(row[0]), b = sv(row[1]);
        if (!a || !b || a === b) return;
        // 去掉前缀序号 "1." "2." 等
        const cleanKey = a.replace(/^\d+\.\s*/, '').replace(/[:：]\s*$/, '').trim();
        // 精确匹配
        if (flatMap[cleanKey]) { obj[flatMap[cleanKey]] = b; return; }
        // 模糊匹配：包含关键词
        for (const [cn, db] of Object.entries(flatMap)) {
          if (cleanKey.includes(cn) || cn.includes(cleanKey)) { obj[db] = b; return; }
        }
      });
      return obj;
    }

    let record = {};
    Object.assign(record, extractFlat(mainSheet));
    if (basicSheet) Object.assign(record, extractFlat(basicSheet));

    // --- 子表3: 产品规格对比 → JSON数组 ---
    if (specSheet && wb.Sheets[specSheet]) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[specSheet], { header: 1, defval: '' });
      // 第2行是产品列表头
      const headerRow = rows[1] || rows[0] || [];
      const cols = headerRow.slice(1).map(sv).filter(x => x);
      const specs = [];
      rows.forEach((r, i) => {
        if (i > 1 && sv(r[0]) && sv(r[0]) !== '规格项') {
          const item = { '规格项': sv(r[0]) };
          cols.forEach((c, j) => { const v = sv(r[1 + j]); if (v) item[c] = v; });
          specs.push(item);
        }
      });
      if (specs.length) record.product_specs = JSON.stringify(specs);
    }

    // --- 子表4: 可实现性评估 → JSON数组 ---
    if (feasSheet && wb.Sheets[feasSheet]) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[feasSheet], { header: 1, defval: '' });
      const feas = [];
      rows.forEach(r => {
        if (sv(r[0]) && sv(r[1]) && !sv(r[0]).includes('评估大') && !sv(r[0]).includes('可实现')) {
          feas.push({ 类别: sv(r[0]), 评估项: sv(r[1]), 结果: sv(r[2]), 关联项: sv(r[3]), 备注: sv(r[4]) });
        }
      });
      if (feas.length) record.feasibility = JSON.stringify(feas);
    }

    // --- 子表5: 销售预测 → JSON {cols,rows} ---
    if (forecastSheet && wb.Sheets[forecastSheet]) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[forecastSheet], { header: 1, defval: '' });
      let hi = -1;
      rows.forEach((r, i) => { if (sv(r[0]) === '时间周期') hi = i; });
      if (hi >= 0) {
        const cols = rows[hi].slice(1).map(sv).filter(x => x);
        const frows = [];
        rows.forEach((r, i) => {
          if (i > hi && sv(r[0]) && /月|年|周|季/.test(sv(r[0]))) {
            const item = { 周期: sv(r[0]) };
            cols.forEach((c, j) => { const v = sv(r[1 + j]); item[c] = v ? (isNaN(v) ? v : Number(v)) : 0; });
            frows.push(item);
          }
        });
        if (frows.length) record.sales_forecast = JSON.stringify({ cols, rows: frows });
      }
    }

    // --- 子表6: 特殊要求 → JSON数组 ---
    if (reqsSheet && wb.Sheets[reqsSheet]) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[reqsSheet], { header: 1, defval: '' });
      const reqs = [];
      rows.forEach(r => {
        if (sv(r[0]) && sv(r[1]) && !sv(r[0]).includes('特殊要求') && !sv(r[0]).includes('样板')) {
          reqs.push({ 产品: sv(r[0]), 要求: sv(r[1]) });
        }
      });
      if (reqs.length) record.special_reqs = JSON.stringify(reqs);
    }

    // 补充默认值
    if (!record.apply_date) record.apply_date = now().substring(0, 10);
    if (!record.approval_status) record.approval_status = 'draft';
    if (!record.workflow_stage) record.workflow_stage = 'apply';
    if (!record.step1_apply_date) record.step1_apply_date = record.apply_date;

    // 检查是否已存在同项目编号的记录
    const table = getTable('rd_project_initiation');
    table._invalidate();
    const existing = record.project_no ? table.all().find(r => r.project_no === record.project_no) : null;

    if (existing) {
      // 更新已有记录
      const fields = { updated_at: now() };
      Object.assign(fields, record);
      table.update(existing.id, fields);
      res.json({ message: `更新成功：${record.project_no || ''}（主表+${[specSheet, feasSheet, forecastSheet, reqsSheet].filter(Boolean).length}个子表）`, id: existing.id, updated: true, data: record });
    } else {
      // 新建记录
      record.created_at = now();
      record.updated_at = now();
      const result = table.insert(record);
      res.json({ message: `导入成功：${record.project_no || '新记录'}（主表+${[specSheet, feasSheet, forecastSheet, reqsSheet].filter(Boolean).length}个子表）`, id: result.lastID, updated: false, data: record });
    }
  } catch (e) {
    res.status(500).json({ error: '导入失败: ' + e.message });
  }
});

router.post('/:table', upload.single('file'), (req, res) => {
  const tableName = req.params.table;
  const supportedTables = ['inquiries', 'customers', 'products', 'materials', 'bom_pricing', 'projects', 'project_progress', 'project_supply_issues', 'project_sales_promotion', 'project_reviews', 'project_initiation', 'expenses', 'labor', 'product_labor_rate'];


  if (!supportedTables.includes(tableName)) {
    return res.status(400).json({ error: `不支持的导入表: ${tableName}，支持: ${supportedTables.join(', ')}` });
  }

  if (!req.file) {
    return res.status(400).json({ error: '请上传文件' });
  }

  try {
    // 立项申请书：检测多Sheet格式并使用专用解析器
    let rows;
    let isMultiSheetInitiation = false;
    if (tableName === 'project_initiation') {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.xlsx' || ext === '.xls' || ext === '.ods') {
        // 检测是否为多Sheet格式
        const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const hasMultiSheet = wb.SheetNames.some(n =>
          n.includes('立项') || n.includes('申请书') || n.includes('基本信息') ||
          n.includes('产品规格') || n.includes('可实现性') || n.includes('销售预测') || n.includes('特殊要求')
        );
        if (hasMultiSheet) {
          isMultiSheetInitiation = true;
          rows = parseInitiationMultiSheet(req.file.buffer, req.file.originalname);
        }
      }
    }
    if (!isMultiSheetInitiation) {
      rows = parseFile(req.file.buffer, req.file.originalname, tableName);
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: '文件中没有数据' });
    }

    // 支持自定义映射配置（从请求体或URL参数传入）
    let customMapping = null;
    try { customMapping = req.body.fieldMapping ? JSON.parse(req.body.fieldMapping) : null; } catch(e) {}
    const syncMode = req.body.syncMode === 'true' || req.body.syncMode === true;

    // 导入键名 → 真实数据库表名映射
    const dbTableMap = {
      projects: 'projects',
      project_progress: 'rd_project_progress',
      project_supply_issues: 'rd_supply_issues',
      project_sales_promotion: 'rd_sales_promotion',
      project_reviews: 'rd_project_reviews',
      project_initiation: 'rd_project_initiation'
    };
    const dbTableName = dbTableMap[tableName] || tableName;
    const table = getTable(dbTableName);
    let imported = 0;
    let skipped = 0;
    const errors = [];

    // 客户导入：按名称/编号去重（与客户模块导入逻辑一致）
    let custExistingNames = null, custExistingCodes = null;
    if (tableName === 'customers') {
      table._invalidate();
      custExistingNames = new Set(table.all().map(c => c.name).filter(n => n));
      custExistingCodes = new Set(table.all().map(c => c.customer_code).filter(c => c));
    }

    rows.forEach((rawRow, index) => {
      let mapped;
      if (isMultiSheetInitiation) {
        // 多Sheet立项申请书解析器已直接返回DB字段名映射，跳过mapRow
        mapped = { ...rawRow };
      } else if (customMapping) {
        // 使用自定义映射：customMapping = { "Excel列名": "数据库字段", ... }
        mapped = {};
        for (const [excelCol, dbField] of Object.entries(customMapping)) {
          if (!dbField) continue;
          const cleanCol = String(excelCol).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, '');
          const rawKey = Object.keys(rawRow).find(k =>
            String(k).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, '') === cleanCol
          );
          if (rawKey !== undefined) {
            mapped[dbField] = rawRow[rawKey];
          }
        }
        // 如果没有自定义映射到任何字段，回退到自动映射
        if (Object.keys(mapped).length === 0) {
          mapped = mapRow(rawRow, tableName);
        }
      } else {
        mapped = mapRow(rawRow, tableName);
      }

      const { row, errors: rowErrors } = validateRow(mapped, tableName);

      if (rowErrors.length > 0) {
        skipped++;
        errors.push({ row: index + 2, errors: rowErrors });
        return;
      }

      // 子表关联项目ID
      if (['project_progress', 'project_reviews', 'project_initiation'].includes(tableName)) {
        const projectsTable = getTable('projects');
        projectsTable._invalidate();
        let project = null;
        if (row.project_id) {
          project = projectsTable.findById(row.project_id);
        }
        if (!project && row.project_no) {
          project = projectsTable.all().find(p => p.project_no === row.project_no);
        }
        if (!project && row.project_name) {
          project = projectsTable.all().find(p => p.project_name === row.project_name);
        }
        if (project) {
          row.project_id = project.id;
        }
        // 如果没有找到关联项目，跳过此行
        if (!project && tableName === 'project_progress') {
          skipped++;
          errors.push({ row: index + 2, errors: ['未找到关联项目，请确认项目编号或名称'] });
          return;
        }
        // 进度跟踪：已有记录则更新而非重复插入
        if (project && tableName === 'project_progress') {
          const progTable = getTable('rd_project_progress');
          progTable._invalidate();
          const existing = progTable.all().find(p => p.project_id === project.id);
          if (existing) {
            const fields = { updated_at: now() };
            const progFieldKeys = ['plan','bom','spec','config','mold_drawing','mold_review','hand_sample','mold','mold_sample','packaging','elec_trial','rd_trial','eng_trial','prod_trial','test_report','tech_transfer','shipment','review','other'];
            progFieldKeys.forEach(f => {
              if (row[f] !== undefined && row[f] !== null && row[f] !== '') {
                fields[f] = row[f];
              }
            });
            progTable.update(existing.id, fields);
            imported++;
            return;
          }
        }
      }

      // 库存同步模式：按物料编码匹配更新
      if (syncMode && tableName === 'materials' && row.material_code) {
        const existing = table.all().find(m => m.material_code === row.material_code);
        if (existing) {
          const fields = { updated_at: now() };
          ['material_name','category','specs','material_type','unit','standard_cost','processing_cost','processing_loss','supplier','status','unit_price','quantity','inventory_qty','min_inventory','monthly_usage','stock_date','total_amount','remarks'].forEach(f => {
            if (row[f] !== undefined && row[f] !== null && row[f] !== '') {
              fields[f] = row[f];
            }
          });
          table.update(existing.id, fields);
          imported++;
          return;
        }
      }

      // 添加创建时间
      if (!row.created_at) {
        row.created_at = now();
      }

      // 客户去重：名称或编号已存在则跳过
      if (tableName === 'customers' && custExistingNames) {
        const cname = row.name ? String(row.name).trim() : '';
        const ccode = row.customer_code ? String(row.customer_code).trim() : '';
        if (cname && custExistingNames.has(cname)) {
          skipped++;
          errors.push({ row: index + 2, errors: [`客户名称已存在: ${cname}`] });
          return;
        }
        if (ccode && custExistingCodes.has(ccode)) {
          skipped++;
          errors.push({ row: index + 2, errors: [`客户编号已存在: ${ccode}`] });
          return;
        }
        if (cname) custExistingNames.add(cname);
        if (ccode) custExistingCodes.add(ccode);
      }

      try {
        table.insert(row);
        imported++;
      } catch (e) {
        skipped++;
        errors.push({ row: index + 2, errors: [`插入失败: ${e.message}`] });
      }
    });

    // 清除缓存确保数据一致
    table._invalidate();

    res.json({
      message: `导入完成：成功 ${imported} 条，跳过 ${skipped} 条`,
      imported,
      skipped,
      total: rows.length,
      errors: errors.slice(0, 20) // 最多返回20条错误
    });
  } catch (e) {
    res.status(500).json({ error: `文件解析失败: ${e.message}` });
  }
});

// ===== 下载导入模板 =====
router.get('/template/:table', requirePerm('inquiry:import'), (req, res) => {
  const tableName = req.params.table;
  const templates = {
    inquiries: {
      headers: ['客户名称', '客户来源', '销售员', '询价时间', '交货日期', '外部型号', '内部型号', '产品品类', '功率', '配置', '数量', '定制要求', '特殊工艺', '备注', '报价有效期', '状态', '物料成本', '加工成本', '辅料成本', '预计损耗', '基础成本', '利润率', '优惠率', '最终报价', '流失原因'],
      sample: ['深圳科技有限公司', '网络推广', '张三', '2024-01-15 10:00:00', '2024-03-01', 'PRO-P100', 'INT-P001', '电源', '100W', '标准配置', 50, '需定制接口', '', '首次合作', '15天', 'new', 5000, 2000, 500, 250, 7750, 0.2, 0.05, 9112.5, '']
    },
    inquiry_pricing: {
      headers: ['询价单号', '物料成本', '加工费', '配件费', '预计损耗', '成本合计', '利润率', '优惠率', '最终报价', '美元报价'],
      sample: ['JFX20260501119', 55.8, 3.0, 2.0, 1.5, 62.3, 0.2, 1, 75.0, 10.5]
    },
    customers: {
      headers: ['客户编号', '客户全称', '客户曾用名', '决策人姓名', '决策人职位', '普通对接人', '对接人职位', '联系电话(含区号)', '对接邮箱', '微信号', 'WhatsApp', 'Skype', '客户等级', '销售模式', '客户状态', '所属业务员', '最后交易年份', '开票抬头', '纳税人识别号', '开户银行', '银行账号', '地址', '国家/地区', '客户来源', '备注说明'],
      sample: ['KH0001', '深圳科技有限公司', '', '王总', '总经理', '李经理', '采购经理', '0755-12345678', 'li@test.com', 'wxid_xxx', '8613800138000', 'li.skype', 'A级', '外销', '大货合作客户', '张三', '2024', '深圳科技有限公司', '91440300XXXXXXXX', '中国银行', '6225XXXXXXXXXXXX', '深圳市南山区科技园', '中国', '网络推广', '重要客户']
    },
    products: {
      headers: ['产品名称', '外部型号', '内部型号', '品类', '功率', '配置', '单位', '状态', '备注'],
      sample: ['智能电源模块', 'PRO-P100', 'INT-P001', '电源', '100W', '标准配置', '台', 'active', '']
    },
    materials: {
      headers: ['物料名称', '物料编码', '分类', '规格参数', '材质', '单位', '标准成本', '加工费', '加工损耗', '供应商', '物料状态', '证书要求', '产品ID', '单价', '数量', '备注'],
      sample: ['电容10uF', 'CAP-10UF', '常规物料', '100μF/400V', '铝电解', '个', 0.5, 0.1, 2, '深圳电子', 'normal', '国标', '1', 0.6, 10, '']
    },
    expenses: {
      headers: ['费用编码', '费用名称', '费用大类', '费用细类', '所属部门', '关联项目', '收款方', '发生日期', '归属账期', '金额', '税率', '税额', '价税合计', '币种', '支付方式', '支付状态', '经办人', '发票号', '发票类型', '数据来源', '备注'],
      sample: ['FY2026070001', '7月差旅费', '差旅费', '市内交通', '销售部', '', '中铁旅运', '2026-07-05', '2026-07', 3500, 6, 210, 3710, 'CNY', '银行转账', '已付', '张三', 'FP20260705', '增普', '手工录入', '客户拜访']
    },
    labor: {
      headers: ['人工编码', '员工姓名', '工号', '部门', '岗位', '人工类型', '工作日期', '归属月份', '工时', '加班工时', '件数', '单价', '基本工资', '加班费', '补贴', '奖金/绩效', '社保', '公积金', '合计金额', '关联项目', '数据来源', '备注'],
      sample: ['LR2026070001', '王伟', 'G00321', '装配车间', '装配工', '计时', '2026-07-15', '2026-07', 176, 24, 0, 25, 0, 600, 300, 200, 850, 210, 5610, '', '手工录入', '']
    },
    product_labor_rate: {
      headers: ['BOM编号', '产品编码', '产品名称', '工价(元/台)', '计价方式', '工艺成本', '生效日', '失效日', '来源', '审核状态', '审核人', '备注'],
      sample: ['JFS22-B1WB10S27-46-01', 'JFS22-B1WB10S27', 'S系列27W工作灯', 3.5, '标准工价', 0.5, '2026-01-01', '', 'manual', 'pending', '', '']
    },
    bom_pricing: {
      headers: ['客户编号', '询价单号', '产品型号', '产品名称', '功率', '产品系列', '证书是否符合标准', '证书等级', '套件', '电缆线', '光源', '驱动', '电池', '支架', '开关', '太阳能板', '插座', '盒子', '说明书', '包装', '配件', '人工', '合计成本', '人工加工费', '工艺成本', '预估损耗', '最低限价', '核价人', '核价链接', '报价(RMB)', '报价(USD)', '目标价', '核价版本', '备注'],
      sample: ['972', '26-119', 'JFS24-B1WA100-Z-003', 'S系列100W工作灯', '100W', 'S系列', '是', '国标', 15.5, 3.2, 8.0, 12.0, 5.0, 2.5, 1.0, 0, 0.8, 1.5, 0.3, 2.0, 1.0, 3.0, 55.8, 3.0, 2.0, 1.5, 62.3, '李工', 'JFX20260512-119', 75.0, 10.5, 70.0, 'V1.0', '']
    },
    projects: {
      headers: ['项目编号', '项目名称', '客户名称', '项目类型', '项目等级', '紧急程度', '负责人', '责任单位', '立项时间', '目标时间', '结案时间', '目前阶段', '进度情况', '投入金额', '订单金额', '年订单', '上市时间', '状态', '稽核状态', '甘特图链接', '资料链接', '备注'],
      sample: ['PRJ-2024-001', '智能工作灯研发', 'ABC客户', '自研', 'A', '重要紧急', '张三', '研发中心', '2024-01-15', '2024-06-30', '', '手样', '正常推进', 50000, 200000, '2024年度', '2024-09-01', 'init', '', '', '', '']
    },
    project_progress: {
      headers: ['项目编号', '项目名称', '计划表', 'BOM', '规格书', '配置表', '模具图纸', '开模评审', '手样', '模具', '模样', '包装设计', '电试', '研试', '工试', '生试', '测试报告', '技转', '出货', '复盘'],
      sample: ['PRJ-2024-001', '智能工作灯研发', '√', '√', '', '√', '', '', '进行中', '', '', '', '', '', '', '', '', '', '', '']
    },
    project_supply_issues: {
      headers: ['发生日期', '提出人', '产品名称', '单号', '项目号', '问题描述', '临时措施', '原因分析', '长期措施', '长期措施完成时间', '责任人', '责任部门', '计划完成时间', '稽核', '闭环', '备注'],
      sample: ['2024-03-15', '李四', '100W工作灯', 'PO-001', 'PRJ-001', '灯珠亮度不足', '更换灯珠批次', '供应商来料问题', '加强来料检验', '2024-03-30', '王五', '品质部', '2024-04-15', '通过', '0', '']
    },
    project_sales_promotion: {
      headers: ['产品型号', '业务员', '客户', '外观', '价格', '性能', '功能', '目前进度', '备注'],
      sample: ['JFS24-B1WA100', '张三', 'ABC客户', '满意', '偏高', '满足', '待测试', '洽谈中', '']
    },
    project_reviews: {
      headers: ['项目编号', '项目名称', '回顾目标', '里程碑', 'Highlights', 'Lowlights', '评估结果-实际', '成功关键因素', '失败根本原因', '总结规律', '经验规律', '行动计划', '备注'],
      sample: ['PRJ-2024-001', '智能工作灯研发', '开发100W工作灯', 'Q1完成设计', '按时交付', '成本超预算', '完成设计评审', '团队协作', '供应商延误', '提前锁定供应商', '', '加强供应链管理', '']
    },
    project_initiation: {
      headers: ['项目编号', '项目名称', '立项背景', '必要性分析', '市场分析', '研发目标', '研发内容', '关键技术与创新点', '技术方案', '技术路线', '研发计划概述', '关键里程碑', '预期成果', '经济效益', '目标市场', '预算总额', '预算明细', '团队需求', '风险分析', '风险对策', '申请人', '申请日期', '审批状态', '审批人', '审批日期', '审批意见', '备注'],
      sample: ['PRJ-2024-001', '智能工作灯研发', '市场对高效工作灯需求旺盛', '完成产品线布局', '户外照明市场年增长15%', '开发100W LED工作灯', '光学设计/散热结构/防水认证', '可替换灯头快接技术', '模块化设计+自研驱动', '手板→模具→试产→认证→上市', '2024年Q1-Q2', 'T1模具/Q2工程试产/Q3批量出货', '年销10万台工作灯', '预计年产值2000万元', '欧洲/北美', '500000', '模具100k+电子50k+认证30k', '研发3人+工艺1人+品质1人', '竞品压价/模具延期/认证不通过', '降价10%应对/提前备料/ANSI认证备案', '张三', '2024-01-15', 'draft', '', '', '', '']
    }
  };

  // 立项申请书：多Sheet格式模板（匹配实际业务表单）
  if (tableName === 'project_initiation') {
    return generateInitiationTemplate(req, res);
  }

  const tpl = templates[tableName];
  if (!tpl) {
    return res.status(400).json({ error: `不支持的模板: ${tableName}` });
  }

  const wb = XLSX.utils.book_new();
  const wsData = [tpl.headers, tpl.sample];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // 设置列宽
  ws['!cols'] = tpl.headers.map(() => ({ wch: 15 }));

  XLSX.utils.book_append_sheet(wb, ws, '导入数据');

  const ext = req.query.format === 'csv' ? '.csv' : '.xlsx';
  const fileName = `${tableName}_import_template${ext}`;

  if (ext === '.csv') {
    const csvContent = XLSX.utils.sheet_to_csv(ws);
    res.setHeader('Content-Type', 'text/csv;charset=utf-8');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
    res.send('\uFEFF' + csvContent);
  } else {
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
    res.send(buf);
  }
});

// ==================== 立项申请书：多Sheet模板生成 ====================
function generateInitiationTemplate(req, res) {
  const wb = XLSX.utils.book_new();

  // Sheet1: 立项申请书（主表单）
  const mainData = [
    ['销售需求立项申请书    2025.11版', '', '', '', ''],
    ['', '', '', '', ''],
    ['一、基本信息（项目经理填写）', '', '', '', ''],
    ['1. 项目编号', 'HJ.26033.V1.XXXJY', '', '', ''],
    ['2. 项目类型', '客户定制+自研', '', '', ''],
    ['3. 起始时间', '2026-06-18', '', '', ''],
    ['4. 项目部门', '研发中心', '', '', ''],
    ['5. 项目主要负责人', '', '', '', ''],
    ['6. 配合人员', '', '', '', ''],
    ['7. 其他', '', '', '', ''],
    ['', '', '', '', ''],
    ['二、客户信息', '', '', '', ''],
    ['8. 客户编号', '', '', '', ''],
    ['9. 客户类型', '', '', '', ''],
    ['10. 客户等级', '', '', '', ''],
    ['11. 客户赢率', '', '', '', ''],
    ['12. 市场状况', '', '', '', ''],
    ['13. 客户痛点', '', '', '', ''],
    ['14. 关键成功要素', '', '', '', ''],
    ['15. 竞争对手', '', '', '', ''],
    ['16. 客户采购周期', '', '', '', ''],
    ['17. 定制开发/转化推广', '', '', '', ''],
    ['18. 其他', '', '', '', ''],
    ['', '', '', '', ''],
    ['三、项目信息（销售输出填写）', '', '', '', ''],
    ['▶ 需求目的：', '', '', '', ''],
    ['规格项', '产品1', '产品2', '产品3', ''],
    ['产品型号', '', '', '', ''],
    ['产品名称', '', '', '', ''],
    ['样品需求时间', '', '', '', ''],
    ['模具样时间', '', '', '', ''],
    ['功率', '', '', '', ''],
    ['产品尺寸', '', '', '', ''],
    ['可调角度', '', '', '', ''],
    ['输入电压', '', '', '', ''],
    ['色温', '', '', '', ''],
    ['盐雾要求', '', '', '', ''],
    ['光通量/光效', '', '', '', ''],
    ['电池容量', '', '', '', ''],
    ['发光角度', '', '', '', ''],
    ['光源', '', '', '', ''],
    ['灯壳', '', '', '', ''],
    ['反光罩', '', '', '', ''],
    ['防水接头', '', '', '', ''],
    ['IK', '', '', '', ''],
    ['防水等级', '', '', '', ''],
    ['色容差', '', '', '', ''],
    ['浪涌', '', '', '', ''],
    ['绝缘耐压', '', '', '', ''],
    ['RA', '', '', '', ''],
    ['包装要求', '', '', '', ''],
    ['认证要求', '', '', '', ''],
    ['目标价格(元)', '', '', '', ''],
    ['数量', '', '', '', ''],
    ['合计金额(元)', '', '', '', ''],
    ['样品数量', '', '', '', ''],
    ['询价单号', '', '', '', ''],
    ['▶ 特殊要求（分产品）', '', '', '', ''],
    ['产品1 特殊要求', '', '', '', ''],
    ['产品2 特殊要求', '', '', '', ''],
    ['产品3 特殊要求', '', '', '', ''],
    ['', '', '', '', ''],
    ['四、可实现性评估（研发填写）', '', '', '', ''],
    ['评估大类', '评估项', '评估结果', '关联项', '备注/数值'],
    ['设计标准', '是否有设计标准', '', '设计标准提供时间', ''],
    ['测试标准', '是否有测试标准', '', '测试标准提供时间', ''],
    ['测试报告', '是否有现成测试报告模板', '', '测试报告模板提供时间', ''],
    ['工艺标准', '是否有现成工艺标准', '', '工艺标准提供时间', ''],
    ['包装评估', '现成包装是否满足', '', '提供时间', ''],
    ['', '现成产品铭牌是否满足', '', '提供时间', ''],
    ['', '现有说明书是否满足', '', '提供时间', ''],
    ['', '现有操作说明是否满足', '', '提供时间', ''],
    ['竞品评估', '是否有竞品', '', '购买竞品时间', ''],
    ['硬件评估', '能否实现', '', '实现周期', ''],
    ['', '研发成本', '', '设计费用', ''],
    ['软件评估', '能否实现', '', '研发成本', ''],
    ['手板质量', '高', '', '低', ''],
    ['商务费用评估', '', '', '', ''],
    ['', '', '', '', ''],
    ['五、立项决议', '', '', '', ''],
    ['立项人员', '销售总监', '研发经理', '项目经理', '总经理'],
    ['', '', '', '', ''],
    ['', '供应链', '', '', ''],
    ['', '', '', '', ''],
    ['六、销售预测 & 金额汇总', '', '', '', ''],
    ['时间周期', '产品1 数量', '产品2 数量', '产品3 数量', '合计数量'],
    ['6个月', '', '', '', ''],
    ['1年', '', '', '', ''],
    ['2年', '', '', '', ''],
    ['3年', '', '', '', ''],
    ['合计销售数量', '', '', '', ''],
    ['', '产品1', '产品2', '产品3', '合计'],
    ['单价(元)', '', '', '', ''],
    ['小计价格(元)', '', '', '', ''],
    ['合计销售金额(元)', '', '', '', ''],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(mainData);
  ws1['!cols'] = [{ wch: 22 }, { wch: 25 }, { wch: 25 }, { wch: 25 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws1, '立项申请书');

  // Sheet2: 子表-基本信息
  const basicData = [
    ['基本信息快照', '', '', ''],
    ['', '', '', ''],
    ['项目编号', '', '', ''],
    ['项目类型', '', '', ''],
    ['起始时间', '', '', ''],
    ['项目部门', '', '', ''],
    ['客户编号', '', '', ''],
    ['客户类型', '', '', ''],
    ['客户等级', '', '', ''],
    ['客户赢率', '', '', ''],
    ['市场状况', '', '', ''],
    ['客户痛点', '', '', ''],
    ['关键成功要素', '', '', ''],
    ['竞争对手', '', '', ''],
    ['采购周期', '', '', ''],
    ['定制开发', '', '', ''],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(basicData);
  ws2['!cols'] = [{ wch: 18 }, { wch: 25 }, { wch: 15 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws2, '子表-基本信息');

  // Sheet3: 子表-产品规格对比
  const specData = [
    ['产品规格对比表', '', '', ''],
    ['规格项', '产品1', '产品2', '产品3'],
    ['产品型号', '', '', ''],
    ['产品名称', '', '', ''],
    ['样品需求时间', '', '', ''],
    ['模具样时间', '', '', ''],
    ['功率', '', '', ''],
    ['产品尺寸', '', '', ''],
    ['可调角度', '', '', ''],
    ['输入电压', '', '', ''],
    ['色温', '', '', ''],
    ['盐雾要求', '', '', ''],
    ['光通量/光效', '', '', ''],
    ['电池容量', '', '', ''],
    ['发光角度', '', '', ''],
    ['光源', '', '', ''],
    ['灯壳', '', '', ''],
    ['反光罩', '', '', ''],
    ['防水接头', '', '', ''],
    ['IK', '', '', ''],
    ['防水等级', '', '', ''],
    ['色容差', '', '', ''],
    ['浪涌', '', '', ''],
    ['绝缘耐压', '', '', ''],
    ['RA', '', '', ''],
    ['包装要求', '', '', ''],
    ['认证要求', '', '', ''],
    ['目标价格(元)', '', '', ''],
    ['数量', '', '', ''],
    ['合计金额(元)', '', '', ''],
    ['样品数量', '', '', ''],
    ['询价单号', '', '', ''],
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(specData);
  ws3['!cols'] = [{ wch: 18 }, { wch: 25 }, { wch: 25 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, ws3, '子表-产品规格对比');

  // Sheet4: 子表-可实现性评估
  const feasData = [
    ['可实现性评估', '', '', ''],
    ['评估大类', '评估项', '评估结果', '关联项', '备注/数值'],
    ['设计标准', '是否有设计标准', '', '设计标准提供时间', ''],
    ['测试标准', '是否有测试标准', '', '测试标准提供时间', ''],
    ['测试报告', '是否有现成测试报告模板', '', '测试报告模板提供时间', ''],
    ['工艺标准', '是否有现成工艺标准', '', '工艺标准提供时间', ''],
    ['包装评估', '现成包装是否满足', '', '提供时间', ''],
    ['', '现成产品铭牌是否满足', '', '提供时间', ''],
    ['', '现有说明书是否满足', '', '提供时间', ''],
    ['', '现有操作说明是否满足', '', '提供时间', ''],
    ['竞品评估', '是否有竞品', '', '购买竞品时间', ''],
    ['硬件评估', '能否实现', '', '实现周期', ''],
    ['', '研发成本', '', '设计费用', ''],
    ['软件评估', '能否实现', '', '研发成本', ''],
    ['手板质量', '高', '', '低', ''],
    ['商务费用评估', '', '', '', ''],
  ];
  const ws4 = XLSX.utils.aoa_to_sheet(feasData);
  ws4['!cols'] = [{ wch: 15 }, { wch: 22 }, { wch: 15 }, { wch: 20 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws4, '子表-可实现性评估');

  // Sheet5: 子表-销售预测
  const forecastData = [
    ['销售预测 & 金额汇总', '', '', ''],
    ['时间周期', '产品1 数量', '产品2 数量', '产品3 数量', '合计数量'],
    ['6个月', '', '', '', ''],
    ['1年', '', '', '', ''],
    ['2年', '', '', '', ''],
    ['3年', '', '', '', ''],
    ['合计销售数量', '', '', '', ''],
    ['', '产品1', '产品2', '产品3', '合计'],
    ['单价(元)', '', '', '', ''],
    ['小计价格(元)', '', '', '', ''],
    ['合计销售金额(元)', '', '', '', ''],
  ];
  const ws5 = XLSX.utils.aoa_to_sheet(forecastData);
  ws5['!cols'] = [{ wch: 18 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws5, '子表-销售预测');

  // Sheet6: 子表-特殊要求
  const reqData = [
    ['各产品特殊要求', ''],
    ['', ''],
    ['产品1 特殊要求', ''],
    ['产品2 特殊要求', ''],
    ['产品3 特殊要求', ''],
  ];
  const ws6 = XLSX.utils.aoa_to_sheet(reqData);
  ws6['!cols'] = [{ wch: 20 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws6, '子表-特殊要求');

  const ext = req.query.format === 'csv' ? '.csv' : '.xlsx';
  const fileName = `project_initiation_import_template${ext}`;
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
  res.send(buf);
}

// ==================== 立项申请书：多Sheet导入解析 ====================
function parseInitiationMultiSheet(buffer, originalname) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const result = {
    project_no: '', project_name: '', project_type: '', start_date: '',
    department: '', owner: '', cooperators: '', other_info: '',
    customer_no: '', customer_type: '', customer_level: '', customer_win_rate: '',
    market_status: '', customer_pain: '', key_success: '', has_competitor: '',
    purchase_cycle: '', dev_type: '',
    product_specs: '', feasibility: '', approval_signs: '',
    sales_forecast: '', special_reqs: '',
    background: '', necessity: '', market_analysis: '',
    applicant: '', apply_date: '', approval_status: 'draft',
    workflow_stage: 'apply',
  };

  // 辅助：从key-value行提取值
  const findVal = (rows, keyMatch) => {
    for (const r of rows) {
      if (r[0] && String(r[0]).includes(keyMatch)) return String(r[1] || '').trim();
    }
    return '';
  };

  // 尝试从"立项申请书"主表解析
  const mainSheet = wb.SheetNames.find(n => n.includes('立项') || n.includes('申请书'));
  if (mainSheet) {
    const ws = wb.Sheets[mainSheet];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    result.project_no = findVal(data, '项目编号');
    result.project_type = findVal(data, '项目类型');
    result.start_date = findVal(data, '起始时间');
    result.department = findVal(data, '项目部门');
    result.owner = findVal(data, '项目主要负责人');
    result.cooperators = findVal(data, '配合人员');
    result.customer_no = findVal(data, '客户编号');
    result.customer_type = findVal(data, '客户类型');
    result.customer_level = findVal(data, '客户等级');
    result.customer_win_rate = findVal(data, '客户赢率');
    result.market_status = findVal(data, '市场状况');
    result.customer_pain = findVal(data, '客户痛点');
    result.key_success = findVal(data, '关键成功要素');
    result.has_competitor = findVal(data, '竞争对手');
    result.purchase_cycle = findVal(data, '采购周期');
    result.dev_type = findVal(data, '定制开发');

    // 解析产品规格对比（找到"规格项"行开始）
    const specStartIdx = data.findIndex(r => String(r[0] || '').includes('规格项'));
    if (specStartIdx >= 0) {
      const specHeaders = data[specStartIdx].slice(1).filter(h => h);
      const specs = [];
      for (let i = specStartIdx + 1; i < data.length; i++) {
        const row = data[i];
        if (!row[0] || String(row[0]).includes('▶') || String(row[0]).includes('四、')) break;
        if (String(row[0]).trim()) {
          const specRow = { 规格项: String(row[0]).trim() };
          specHeaders.forEach((h, idx) => { specRow[h] = String(row[idx + 1] || '').trim(); });
          specs.push(specRow);
        }
      }
      result.product_specs = JSON.stringify(specs);
    }

    // 解析特殊要求
    const reqStartIdx = data.findIndex(r => String(r[0] || '').includes('特殊要求'));
    if (reqStartIdx >= 0) {
      const reqs = {};
      for (let i = reqStartIdx; i < data.length; i++) {
        const row = data[i];
        if (String(row[0] || '').includes('四、')) break;
        if (row[0] && String(row[0]).includes('特殊要求') && row[1]) {
          reqs[String(row[0]).trim()] = String(row[1]).trim();
        }
      }
      result.special_reqs = JSON.stringify(reqs);
    }

    // 解析可实现性评估
    const feasStartIdx = data.findIndex(r => String(r[0] || '').includes('评估大类'));
    if (feasStartIdx >= 0) {
      const feas = [];
      for (let i = feasStartIdx + 1; i < data.length; i++) {
        const row = data[i];
        if (!row[0] && !row[1]) continue;
        if (String(row[0] || '').includes('五、')) break;
        if (row[1] || row[0]) {
          feas.push({
            category: String(row[0] || '').trim(),
            item: String(row[1] || '').trim(),
            result: String(row[2] || '').trim(),
            related: String(row[3] || '').trim(),
            note: String(row[4] || '').trim(),
          });
        }
      }
      result.feasibility = JSON.stringify(feas);
    }

    // 解析销售预测
    const forecastStartIdx = data.findIndex(r => String(r[0] || '').includes('时间周期'));
    if (forecastStartIdx >= 0) {
      const forecast = { periods: [], prices: {} };
      for (let i = forecastStartIdx + 1; i < data.length; i++) {
        const row = data[i];
        if (!row[0]) continue;
        const label = String(row[0]).trim();
        if (['6个月', '1年', '2年', '3年', '合计销售数量'].includes(label)) {
          forecast.periods.push({ period: label, p1: row[1], p2: row[2], p3: row[3], total: row[4] });
        } else if (label.includes('单价')) {
          forecast.prices = { p1: row[1], p2: row[2], p3: row[3], total: row[4] };
        } else if (label.includes('小计')) {
          forecast.subtotals = { p1: row[1], p2: row[2], p3: row[3], total: row[4] };
        } else if (label.includes('合计销售金额')) {
          forecast.total_amount = row[1];
        }
      }
      result.sales_forecast = JSON.stringify(forecast);
    }

    // 解析立项决议
    const approvalStartIdx = data.findIndex(r => String(r[0] || '').includes('立项人员'));
    if (approvalStartIdx >= 0) {
      const approval = {};
      const headers = data[approvalStartIdx].slice(1).filter(h => h);
      for (let i = approvalStartIdx + 1; i < data.length; i++) {
        const row = data[i];
        if (String(row[0] || '').includes('六、')) break;
        if (row[0] || row[1]) {
          headers.forEach((h, idx) => { if (row[idx + 1]) approval[h] = String(row[idx + 1]).trim(); });
        }
      }
      result.approval_signs = JSON.stringify(approval);
    }
  }

  // 也尝试从子表-基本信息补充
  const basicSheet = wb.SheetNames.find(n => n.includes('基本信息'));
  if (basicSheet) {
    const ws = wb.Sheets[basicSheet];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!result.project_no) result.project_no = findVal(data, '项目编号');
    if (!result.project_type) result.project_type = findVal(data, '项目类型');
    if (!result.start_date) result.start_date = findVal(data, '起始时间');
    if (!result.department) result.department = findVal(data, '项目部门');
    if (!result.customer_no) result.customer_no = findVal(data, '客户编号');
    if (!result.customer_type) result.customer_type = findVal(data, '客户类型');
    if (!result.customer_level) result.customer_level = findVal(data, '客户等级');
    if (!result.customer_win_rate) result.customer_win_rate = findVal(data, '客户赢率');
    if (!result.market_status) result.market_status = findVal(data, '市场状况');
    if (!result.customer_pain) result.customer_pain = findVal(data, '客户痛点');
    if (!result.key_success) result.key_success = findVal(data, '关键成功要素');
    if (!result.has_competitor) result.has_competitor = findVal(data, '竞争对手');
    if (!result.purchase_cycle) result.purchase_cycle = findVal(data, '采购周期');
    if (!result.dev_type) result.dev_type = findVal(data, '定制开发');
  }

  // 子表-产品规格对比
  const specSheet = wb.SheetNames.find(n => n.includes('产品规格') || n.includes('规格对比'));
  if (specSheet && !result.product_specs) {
    const ws = wb.Sheets[specSheet];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const specStartIdx = data.findIndex(r => String(r[0] || '').includes('规格项'));
    if (specStartIdx >= 0) {
      const specHeaders = data[specStartIdx].slice(1).filter(h => h);
      const specs = [];
      for (let i = specStartIdx + 1; i < data.length; i++) {
        const row = data[i];
        if (!row[0] || !String(row[0]).trim()) continue;
        const specRow = { 规格项: String(row[0]).trim() };
        specHeaders.forEach((h, idx) => { specRow[h] = String(row[idx + 1] || '').trim(); });
        specs.push(specRow);
      }
      result.product_specs = JSON.stringify(specs);
    }
  }

  // 子表-销售预测
  const forecastSheet = wb.SheetNames.find(n => n.includes('销售预测'));
  if (forecastSheet && !result.sales_forecast) {
    const ws = wb.Sheets[forecastSheet];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const forecastStartIdx = data.findIndex(r => String(r[0] || '').includes('时间周期'));
    if (forecastStartIdx >= 0) {
      const forecast = { periods: [], prices: {} };
      for (let i = forecastStartIdx + 1; i < data.length; i++) {
        const row = data[i];
        if (!row[0]) continue;
        const label = String(row[0]).trim();
        if (['6个月', '1年', '2年', '3年', '合计销售数量'].includes(label)) {
          forecast.periods.push({ period: label, p1: row[1], p2: row[2], p3: row[3], total: row[4] });
        } else if (label.includes('单价')) {
          forecast.prices = { p1: row[1], p2: row[2], p3: row[3], total: row[4] };
        } else if (label.includes('小计')) {
          forecast.subtotals = { p1: row[1], p2: row[2], p3: row[3], total: row[4] };
        } else if (label.includes('合计销售金额')) {
          forecast.total_amount = row[1];
        }
      }
      result.sales_forecast = JSON.stringify(forecast);
    }
  }

  // 子表-特殊要求
  const reqSheet = wb.SheetNames.find(n => n.includes('特殊要求'));
  if (reqSheet && !result.special_reqs) {
    const ws = wb.Sheets[reqSheet];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const reqs = {};
    data.forEach(row => {
      if (row[0] && String(row[0]).includes('特殊要求') && row[1]) {
        reqs[String(row[0]).trim()] = String(row[1]).trim();
      }
    });
    result.special_reqs = JSON.stringify(reqs);
  }

  // 子表-可实现性评估
  const feasSheet = wb.SheetNames.find(n => n.includes('可实现性') || n.includes('评估'));
  if (feasSheet && !result.feasibility) {
    const ws = wb.Sheets[feasSheet];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const feasStartIdx = data.findIndex(r => String(r[0] || '').includes('评估大类'));
    if (feasStartIdx >= 0) {
      const feas = [];
      for (let i = feasStartIdx + 1; i < data.length; i++) {
        const row = data[i];
        if (!row[0] && !row[1]) continue;
        if (row[1] || row[0]) {
          feas.push({
            category: String(row[0] || '').trim(),
            item: String(row[1] || '').trim(),
            result: String(row[2] || '').trim(),
            related: String(row[3] || '').trim(),
            note: String(row[4] || '').trim(),
          });
        }
      }
      result.feasibility = JSON.stringify(feas);
    }
  }

  result.apply_date = result.start_date || new Date().toISOString().slice(0, 10);
  return [result];
}

// Multer错误处理中间件
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件大小超过限制（最大50MB）' });
    }
    return res.status(400).json({ error: '文件上传错误: ' + err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;


