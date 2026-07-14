const { getTable, ensureTable, now } = require('./db');

// 确保所有表存在
const tableNames = ['users', 'products', 'customers', 'materials', 'pricing_standards',
  'inquiries', 'inquiry_status_changes', 'inquiry_comments', 'inquiry_messages',
  'operation_logs', 'samples', 'projects', 'orders', 'assessment_cycles', 'training_plans',
  'roles', 'permissions', 'role_permissions', 'user_roles', 'feedback', 'bom_pricing', 'workflow_rules',
  'annual_plan_goals', 'annual_department_plans', 'annual_kpis', 'annual_okrs', 'annual_action_plans',
  'annual_risks', 'annual_reviews', 'annual_ai_records', 'material_check_issues'];
tableNames.forEach(name => ensureTable(name));

// 初始化用户
const userTable = getTable('users');
if (userTable.all().length === 0) {
  userTable.insert({ username: 'admin', password: 'admin123', name: '超级管理员', role: 'admin', created_at: now() });
  userTable.insert({ username: 'sales01', password: 'sales123', name: '张三（销售）', role: 'sales', created_at: now() });
  userTable.insert({ username: 'sales02', password: 'sales123', name: '李四（销售）', role: 'sales', created_at: now() });
  userTable.insert({ username: 'smgr01', password: 'smgr123', name: '陈经理（销售经理）', role: 'sales_manager', created_at: now() });
  userTable.insert({ username: 'engineer01', password: 'eng123', name: '王工（工程师）', role: 'engineer', created_at: now() });
  userTable.insert({ username: 'purchase01', password: 'pur123', name: '赵采购', role: 'purchase', created_at: now() });
  userTable.insert({ username: 'finance01', password: 'fin123', name: '周财务', role: 'finance', created_at: now() });
  userTable.insert({ username: 'viewer01', password: 'view123', name: '审计查看', role: 'viewer', created_at: now() });
  userTable.insert({ username: 'pmgr01', password: 'pmgr123', name: '项目经理', role: 'project_manager', created_at: now() });
  userTable.insert({ username: 'rdmgr01', password: 'rdmgr123', name: '研发经理', role: 'rd_manager', created_at: now() });
  console.log('用户数据初始化完成（10个账户：admin/sales01/sales02/smgr01/engineer01/purchase01/finance01/viewer01/pmgr01/rdmgr01）');
}

// 初始化产品
const prodTable = getTable('products');
if (prodTable.all().length === 0) {
  const products = [
    { external_model: 'PRO-A100', internal_model: 'INT-A001', category: '电源', power: '100W', configuration: '输入: AC100-240V, 输出: DC12V/8.3A', specs: '符合CE认证标准', created_at: now(), updated_at: now() },
    { external_model: 'PRO-A200', internal_model: 'INT-A002', category: '电源', power: '200W', configuration: '输入: AC100-240V, 输出: DC24V/8.3A', specs: '符合CE认证标准', created_at: now(), updated_at: now() },
    { external_model: 'PRO-B100', internal_model: 'INT-B001', category: '控制器', power: '50W', configuration: '支持RS485通信, 4-20mA输出', specs: '工业级防护等级', created_at: now(), updated_at: now() },
    { external_model: 'PRO-C100', internal_model: 'INT-C001', category: '传感器', power: '10W', configuration: '温度范围: -40~85°C, 精度: ±0.5%', specs: 'IP67防护', created_at: now(), updated_at: now() },
    { external_model: 'PRO-D100', internal_model: 'INT-D001', category: '模块', power: '30W', configuration: '支持Modbus协议, 8路输入输出', specs: 'DIN导轨安装', created_at: now(), updated_at: now() },
    { external_model: 'PRO-E200', internal_model: 'INT-E002', category: '电源', power: '500W', configuration: '输入: AC100-240V, 输出: DC48V/10.4A', specs: '符合UL/CE双认证', created_at: now(), updated_at: now() },
    { external_model: 'PRO-F100', internal_model: 'INT-F001', category: '控制器', power: '80W', configuration: '支持以太网通信, 可编程逻辑控制', specs: '工业级IP40', created_at: now(), updated_at: now() }
  ];
  products.forEach(p => prodTable.insert(p));
  console.log('产品数据初始化完成');
}

// 初始化核价标准
const priceTable = getTable('pricing_standards');
if (priceTable.all().length === 0) {
  const pricingData = [
    { product_id: 1, cost_price: 80, min_price: 96, max_price: 120, profit_rate: 0.2, effective_date: '2024-01-01' },
    { product_id: 2, cost_price: 150, min_price: 180, max_price: 225, profit_rate: 0.2, effective_date: '2024-01-01' },
    { product_id: 3, cost_price: 120, min_price: 144, max_price: 180, profit_rate: 0.2, effective_date: '2024-01-01' },
    { product_id: 4, cost_price: 60, min_price: 72, max_price: 90, profit_rate: 0.2, effective_date: '2024-01-01' },
    { product_id: 5, cost_price: 90, min_price: 108, max_price: 135, profit_rate: 0.2, effective_date: '2024-01-01' },
    { product_id: 6, cost_price: 350, min_price: 420, max_price: 525, profit_rate: 0.2, effective_date: '2024-01-01' },
    { product_id: 7, cost_price: 200, min_price: 240, max_price: 300, profit_rate: 0.2, effective_date: '2024-01-01' }
  ];
  pricingData.forEach(p => priceTable.insert(p));
  console.log('核价标准初始化完成');
}

// 初始化客户
const custTable = getTable('customers');
if (custTable.all().length === 0) {
  const customers = [
    { name: '上海科技有限公司', source: '线上', contact: '王经理', phone: '13800138001', email: 'wang@sh-tech.com', created_at: now(), updated_at: now() },
    { name: '深圳电子集团', source: '线下', contact: '李总', phone: '13800138002', email: 'li@shenzhen-elec.com', created_at: now(), updated_at: now() },
    { name: '北京自动化公司', source: '老客户', contact: '张工', phone: '13800138003', email: 'zhang@bj-auto.com', created_at: now(), updated_at: now() },
    { name: '广州智造科技', source: '转介绍', contact: '陈经理', phone: '13800138004', email: 'chen@gz-smart.com', created_at: now(), updated_at: now() },
    { name: '杭州物联网公司', source: '线上', contact: '刘总', phone: '13800138005', email: 'liu@hz-iot.com', created_at: now(), updated_at: now() },
    { name: '成都光电科技', source: '展会', contact: '周工', phone: '13800138006', email: 'zhou@cd-opto.com', created_at: now(), updated_at: now() },
    { name: '武汉智能装备', source: '老客户', contact: '吴经理', phone: '13800138007', email: 'wu@wh-equip.com', created_at: now(), updated_at: now() },
    { name: '南京精密仪器', source: '线上', contact: '孙总', phone: '13800138008', email: 'sun@nj-prec.com', created_at: now(), updated_at: now() }
  ];
  customers.forEach(c => custTable.insert(c));
  console.log('客户数据初始化完成');
}

// 初始化物料
const matTable = getTable('materials');
if (matTable.all().length === 0) {
  const materials = [
    { product_id: 1, material_name: '电源芯片', material_code: 'IC-001', status: 'normal', unit_price: 25, quantity: 1 },
    { product_id: 1, material_name: '电解电容', material_code: 'CAP-001', status: 'normal', unit_price: 5, quantity: 4 },
    { product_id: 1, material_name: '变压器', material_code: 'TF-001', status: 'normal', unit_price: 18, quantity: 1 },
    { product_id: 2, material_name: '电源芯片', material_code: 'IC-002', status: 'normal', unit_price: 45, quantity: 1 },
    { product_id: 2, material_name: '散热片', material_code: 'HS-001', status: 'normal', unit_price: 12, quantity: 2 },
    { product_id: 3, material_name: 'MCU芯片', material_code: 'MCU-001', status: 'normal', unit_price: 35, quantity: 1 },
    { product_id: 3, material_name: '通信模块', material_code: 'COM-001', status: 'normal', unit_price: 28, quantity: 1 },
    { product_id: 4, material_name: '传感器元件', material_code: 'SNS-001', status: 'normal', unit_price: 15, quantity: 1 },
    { product_id: 4, material_name: 'PCB板', material_code: 'PCB-001', status: 'normal', unit_price: 8, quantity: 1 },
    { product_id: 5, material_name: 'IO芯片', material_code: 'IO-001', status: 'normal', unit_price: 22, quantity: 1 },
    { product_id: 5, material_name: '继电器', material_code: 'RLY-001', status: 'normal', unit_price: 10, quantity: 8 },
    { product_id: 6, material_name: '大功率电源芯片', material_code: 'IC-P500', status: 'normal', unit_price: 120, quantity: 1 },
    { product_id: 6, material_name: '大功率变压器', material_code: 'TF-P500', status: 'custom', unit_price: 85, quantity: 1 },
    { product_id: 6, material_name: '散热模组', material_code: 'HS-M500', status: 'normal', unit_price: 35, quantity: 2 },
    { product_id: 7, material_name: 'PLC芯片', material_code: 'PLC-001', status: 'normal', unit_price: 65, quantity: 1 },
    { product_id: 7, material_name: '以太网模块', material_code: 'ETH-001', status: 'normal', unit_price: 30, quantity: 1 }
  ];
  materials.forEach(m => matTable.insert(m));
  console.log('物料数据初始化完成');
}

// 初始化示例询价单
const inqTable = getTable('inquiries');
if (inqTable.all().length === 0) {
  const inquiries = [
    {
      serial_number: 'XJ20240101001', customer_name: '上海科技有限公司', customer_source: '线上',
      sales_person: '张三', inquiry_time: '2024-01-15 09:30:00', delivery_date: '2024-02-15',
      external_model: 'PRO-A100', internal_model: 'INT-A001', product_category: '电源',
      power: '100W', configuration: '输入: AC100-240V, 输出: DC12V/8.3A', quantity: 100,
      custom_requirements: '需要定制外壳颜色', special_process: '', remarks: '长期合作客户',
      quote_validity: '30天', status: 'quoted', material_cost: 4800, process_cost: 2000,
      accessory_cost: 800, estimated_loss: 400, base_cost: 8000, profit_rate: 0.2,
      discount_rate: 0.05, final_price: 9120, quoted_at: '2024-01-16 14:00:00',
      follow_up_records: '客户对报价满意，正在内部审批', lost_reason: '',
      created_at: '2024-01-15 09:30:00', updated_at: '2024-01-16 14:00:00'
    },
    {
      serial_number: 'XJ20240102001', customer_name: '深圳电子集团', customer_source: '线下',
      sales_person: '李四', inquiry_time: '2024-01-20 10:00:00', delivery_date: '2024-03-01',
      external_model: 'PRO-B100', internal_model: 'INT-B001', product_category: '控制器',
      power: '50W', configuration: '支持RS485通信, 4-20mA输出', quantity: 50,
      custom_requirements: '', special_process: '需要做EMC测试', remarks: '',
      quote_validity: '15天', status: 'negotiating', material_cost: 3150, process_cost: 1312.5,
      accessory_cost: 525, estimated_loss: 262.5, base_cost: 5250, profit_rate: 0.2,
      discount_rate: 0, final_price: 6300, quoted_at: '2024-01-21 11:00:00',
      follow_up_records: '客户要求再降价5%', lost_reason: '',
      created_at: '2024-01-20 10:00:00', updated_at: '2024-01-22 16:00:00'
    },
    {
      serial_number: 'XJ20240103001', customer_name: '北京自动化公司', customer_source: '老客户',
      sales_person: '张三', inquiry_time: '2024-02-05 14:00:00', delivery_date: '2024-03-15',
      external_model: 'PRO-C100', internal_model: 'INT-C001', product_category: '传感器',
      power: '10W', configuration: '温度范围: -40~85°C, 精度: ±0.5%', quantity: 200,
      custom_requirements: '需要IP68防护等级', special_process: '', remarks: '老客户优惠',
      quote_validity: '30天', status: 'closed', material_cost: 7200, process_cost: 3000,
      accessory_cost: 1200, estimated_loss: 600, base_cost: 12000, profit_rate: 0.15,
      discount_rate: 0.1, final_price: 12240, quoted_at: '2024-02-06 09:00:00',
      follow_up_records: '已签约，预付款已收', lost_reason: '',
      created_at: '2024-02-05 14:00:00', updated_at: '2024-02-10 10:00:00'
    },
    {
      serial_number: 'XJ20240104001', customer_name: '广州智造科技', customer_source: '转介绍',
      sales_person: '李四', inquiry_time: '2024-02-10 11:00:00', delivery_date: '2024-04-01',
      external_model: 'PRO-D100', internal_model: 'INT-D001', product_category: '模块',
      power: '30W', configuration: '支持Modbus协议, 8路输入输出', quantity: 30,
      custom_requirements: '', special_process: '', remarks: '新客户首次合作',
      quote_validity: '15天', status: 'lost', material_cost: 1620, process_cost: 675,
      accessory_cost: 270, estimated_loss: 135, base_cost: 2700, profit_rate: 0.2,
      discount_rate: 0, final_price: 3240, quoted_at: '2024-02-11 10:00:00',
      follow_up_records: '客户选择了竞品', lost_reason: '价格偏高',
      created_at: '2024-02-10 11:00:00', updated_at: '2024-02-20 09:00:00'
    },
    {
      serial_number: 'XJ20240105001', customer_name: '杭州物联网公司', customer_source: '线上',
      sales_person: '张三', inquiry_time: '2024-03-01 16:00:00', delivery_date: '2024-04-15',
      external_model: 'PRO-A200', internal_model: 'INT-A002', product_category: '电源',
      power: '200W', configuration: '输入: AC100-240V, 输出: DC24V/8.3A', quantity: 80,
      custom_requirements: '需要过UL认证', special_process: 'UL认证费用另计', remarks: '',
      quote_validity: '30天', status: 'new', material_cost: 0, process_cost: 0,
      accessory_cost: 0, estimated_loss: 0, base_cost: 0, profit_rate: 0,
      discount_rate: 0, final_price: 0, quoted_at: null,
      follow_up_records: '', lost_reason: '',
      created_at: '2024-03-01 16:00:00', updated_at: '2024-03-01 16:00:00'
    },
    {
      serial_number: 'XJ20240106001', customer_name: '成都光电科技', customer_source: '展会',
      sales_person: '李四', inquiry_time: '2024-03-10 10:00:00', delivery_date: '2024-05-01',
      external_model: 'PRO-E200', internal_model: 'INT-E002', product_category: '电源',
      power: '500W', configuration: '输入: AC100-240V, 输出: DC48V/10.4A', quantity: 20,
      custom_requirements: '需要定制输出接口', special_process: '', remarks: '展会客户',
      quote_validity: '30天', status: 'sample', material_cost: 4800, process_cost: 1750,
      accessory_cost: 700, estimated_loss: 350, base_cost: 7600, profit_rate: 0.2,
      discount_rate: 0, final_price: 9120, quoted_at: '2024-03-11 09:00:00',
      follow_up_records: '客户已确认样品需求', lost_reason: '',
      created_at: '2024-03-10 10:00:00', updated_at: '2024-03-15 14:00:00'
    },
    {
      serial_number: 'XJ20240107001', customer_name: '武汉智能装备', customer_source: '老客户',
      sales_person: '张三', inquiry_time: '2024-03-15 11:00:00', delivery_date: '2024-05-15',
      external_model: 'PRO-F100', internal_model: 'INT-F001', product_category: '控制器',
      power: '80W', configuration: '支持以太网通信, 可编程逻辑控制', quantity: 15,
      custom_requirements: '需要定制通信协议', special_process: '协议开发', remarks: '老客户大单',
      quote_validity: '30天', status: 'project', material_cost: 1425, process_cost: 750,
      accessory_cost: 300, estimated_loss: 150, base_cost: 2625, profit_rate: 0.25,
      discount_rate: 0.05, final_price: 3117.19, quoted_at: '2024-03-16 10:00:00',
      follow_up_records: '已立项，工程团队对接中', lost_reason: '',
      created_at: '2024-03-15 11:00:00', updated_at: '2024-03-20 09:00:00'
    },
    {
      serial_number: 'XJ20240108001', customer_name: '南京精密仪器', customer_source: '线上',
      sales_person: '李四', inquiry_time: '2024-03-20 14:00:00', delivery_date: '2024-04-30',
      external_model: 'PRO-C100', internal_model: 'INT-C001', product_category: '传感器',
      power: '10W', configuration: '温度范围: -40~85°C, 精度: ±0.5%', quantity: 500,
      custom_requirements: '需要高精度版本 ±0.1%', special_process: '高精度校准', remarks: '',
      quote_validity: '15天', status: 'pending_pricing', material_cost: 0, process_cost: 0,
      accessory_cost: 0, estimated_loss: 0, base_cost: 0, profit_rate: 0,
      discount_rate: 0, final_price: 0, quoted_at: null,
      follow_up_records: '', lost_reason: '',
      created_at: '2024-03-20 14:00:00', updated_at: '2024-03-20 14:00:00'
    }
  ];
  inquiries.forEach(i => inqTable.insert(i));
  console.log('询价单数据初始化完成');
}

// 初始化状态变更记录
const statusTable = getTable('inquiry_status_changes');
if (statusTable.all().length === 0) {
  const changes = [
    { inquiry_id: 1, status: 'new', changed_by: '张三', changed_at: '2024-01-15 09:30:00', reason: '新建询价单' },
    { inquiry_id: 1, status: 'quoted', changed_by: '张三', changed_at: '2024-01-16 14:00:00', reason: '自动核价完成' },
    { inquiry_id: 2, status: 'new', changed_by: '李四', changed_at: '2024-01-20 10:00:00', reason: '新建询价单' },
    { inquiry_id: 2, status: 'quoted', changed_by: '李四', changed_at: '2024-01-21 11:00:00', reason: '自动核价完成' },
    { inquiry_id: 2, status: 'negotiating', changed_by: '李四', changed_at: '2024-01-22 16:00:00', reason: '客户进入谈判阶段' },
    { inquiry_id: 3, status: 'new', changed_by: '张三', changed_at: '2024-02-05 14:00:00', reason: '新建询价单' },
    { inquiry_id: 3, status: 'quoted', changed_by: '张三', changed_at: '2024-02-06 09:00:00', reason: '自动核价完成' },
    { inquiry_id: 3, status: 'closed', changed_by: '张三', changed_at: '2024-02-10 10:00:00', reason: '客户签约' },
    { inquiry_id: 4, status: 'new', changed_by: '李四', changed_at: '2024-02-10 11:00:00', reason: '新建询价单' },
    { inquiry_id: 4, status: 'quoted', changed_by: '李四', changed_at: '2024-02-11 10:00:00', reason: '自动核价完成' },
    { inquiry_id: 4, status: 'lost', changed_by: '李四', changed_at: '2024-02-20 09:00:00', reason: '价格偏高，客户选择竞品' },
    { inquiry_id: 5, status: 'new', changed_by: '张三', changed_at: '2024-03-01 16:00:00', reason: '新建询价单' },
    { inquiry_id: 6, status: 'new', changed_by: '李四', changed_at: '2024-03-10 10:00:00', reason: '新建询价单' },
    { inquiry_id: 6, status: 'quoted', changed_by: '李四', changed_at: '2024-03-11 09:00:00', reason: '自动核价完成' },
    { inquiry_id: 6, status: 'sample', changed_by: '李四', changed_at: '2024-03-15 14:00:00', reason: '客户确认样品需求' },
    { inquiry_id: 7, status: 'new', changed_by: '张三', changed_at: '2024-03-15 11:00:00', reason: '新建询价单' },
    { inquiry_id: 7, status: 'quoted', changed_by: '张三', changed_at: '2024-03-16 10:00:00', reason: '自动核价完成' },
    { inquiry_id: 7, status: 'project', changed_by: '张三', changed_at: '2024-03-20 09:00:00', reason: '已立项' },
    { inquiry_id: 8, status: 'new', changed_by: '李四', changed_at: '2024-03-20 14:00:00', reason: '新建询价单' },
    { inquiry_id: 8, status: 'pending_pricing', changed_by: '李四', changed_at: '2024-03-20 15:00:00', reason: '提交核价' }
  ];
  changes.forEach(c => statusTable.insert(c));
  console.log('状态变更记录初始化完成');
}

// 初始化评论/跟进记录
const commentTable = getTable('inquiry_comments');
if (commentTable.all().length === 0) {
  const comments = [
    { inquiry_id: 1, commenter: '张三', content: '客户已收到报价，正在内部评估中', created_at: '2024-01-17 10:00:00' },
    { inquiry_id: 1, commenter: '王工', content: '该型号物料齐套，可正常排产', created_at: '2024-01-17 14:30:00' },
    { inquiry_id: 2, commenter: '李四', content: '客户反馈价格偏高，要求再降5%', created_at: '2024-01-23 09:00:00' },
    { inquiry_id: 2, commenter: '李四', content: '已提交降价申请，等待审批', created_at: '2024-01-24 11:00:00' },
    { inquiry_id: 3, commenter: '张三', content: '老客户，已给予10%优惠', created_at: '2024-02-06 10:00:00' },
    { inquiry_id: 3, commenter: '张三', content: '客户确认签约，预付款30%已到账', created_at: '2024-02-10 10:00:00' },
    { inquiry_id: 4, commenter: '李四', content: '客户对比了3家供应商，最终选择竞品', created_at: '2024-02-20 09:00:00' },
    { inquiry_id: 6, commenter: '李四', content: '展会接触客户，对500W电源有强烈需求', created_at: '2024-03-10 16:00:00' },
    { inquiry_id: 6, commenter: '赵采购', content: '大功率变压器需定制，交期约2周', created_at: '2024-03-12 09:00:00' },
    { inquiry_id: 7, commenter: '张三', content: '客户需要定制Modbus TCP协议，已安排工程对接', created_at: '2024-03-16 14:00:00' },
    { inquiry_id: 7, commenter: '王工', content: '协议开发预计3天完成，已开始编码', created_at: '2024-03-17 10:00:00' }
  ];
  comments.forEach(c => commentTable.insert(c));
  console.log('评论数据初始化完成');
}

// 初始化RM消息记录
const msgTable = getTable('inquiry_messages');
if (msgTable.all().length === 0) {
  const messages = [
    { inquiry_id: 1, sender: '张三', content: '王工，PRO-A100的定制外壳需要多长时间？', msg_type: 'text', created_at: '2024-01-16 10:00:00' },
    { inquiry_id: 1, sender: '王工', content: '定制外壳大约需要5个工作日，不影响主体生产', msg_type: 'text', created_at: '2024-01-16 10:15:00' },
    { inquiry_id: 1, sender: '张三', content: '好的，我先跟客户确认交期', msg_type: 'text', created_at: '2024-01-16 10:20:00' },
    { inquiry_id: 2, sender: '李四', content: '赵采购，EMC测试费用大概多少？', msg_type: 'text', created_at: '2024-01-21 14:00:00' },
    { inquiry_id: 2, sender: '赵采购', content: 'EMC测试费用约5000元，可以计入报价', msg_type: 'text', created_at: '2024-01-21 14:30:00' },
    { inquiry_id: 6, sender: '李四', content: '大功率电源的散热方案确认了吗？', msg_type: 'text', created_at: '2024-03-11 10:00:00' },
    { inquiry_id: 6, sender: '王工', content: '散热方案已确认，使用铝基板+散热片组合', msg_type: 'text', created_at: '2024-03-11 10:30:00' },
    { inquiry_id: 7, sender: '张三', content: '@王工 以太网通信协议开发进度如何？', msg_type: 'text', created_at: '2024-03-18 09:00:00' },
    { inquiry_id: 7, sender: '王工', content: '协议开发已完成80%，预计明天完成调试', msg_type: 'text', created_at: '2024-03-18 09:30:00' }
  ];
  messages.forEach(m => msgTable.insert(m));
  console.log('RM消息数据初始化完成');
}

// 初始化操作日志
const logTable = getTable('operation_logs');
if (logTable.all().length === 0) {
  const logs = [
    { action: '创建询价', operator: '张三', detail: '新建询价单 XJ20240101001', inquiry_id: 1, created_at: '2024-01-15 09:30:00' },
    { action: '智能核价', operator: '张三', detail: '询价单 XJ20240101001 核价完成，报价 ¥9120', inquiry_id: 1, created_at: '2024-01-16 14:00:00' },
    { action: '创建询价', operator: '李四', detail: '新建询价单 XJ20240102001', inquiry_id: 2, created_at: '2024-01-20 10:00:00' },
    { action: '智能核价', operator: '李四', detail: '询价单 XJ20240102001 核价完成，报价 ¥6300', inquiry_id: 2, created_at: '2024-01-21 11:00:00' },
    { action: '状态变更', operator: '李四', detail: '询价单 XJ20240102001 状态变更为 negotiating', inquiry_id: 2, created_at: '2024-01-22 16:00:00' },
    { action: '创建询价', operator: '张三', detail: '新建询价单 XJ20240103001', inquiry_id: 3, created_at: '2024-02-05 14:00:00' },
    { action: '智能核价', operator: '张三', detail: '询价单 XJ20240103001 核价完成，报价 ¥12240', inquiry_id: 3, created_at: '2024-02-06 09:00:00' },
    { action: '状态变更', operator: '张三', detail: '询价单 XJ20240103001 状态变更为 closed', inquiry_id: 3, created_at: '2024-02-10 10:00:00' }
  ];
  logs.forEach(l => logTable.insert(l));
  console.log('操作日志初始化完成');
}

console.log('\n所有初始化数据完成！');
console.log('===== 默认账户（共8个角色） =====');
console.log('超级管理员：admin / admin123');
console.log('销售经理：  smgr01 / smgr123');
console.log('销售业务员：sales01 / sales123 | sales02 / sales123');
console.log('工程师：    engineer01 / eng123');
console.log('采购人员：  purchase01 / pur123');
console.log('财务专员：  finance01 / fin123');
console.log('只读账号：  viewer01 / view123');
console.log('===================================');

// 初始化考核周期
const cycleTable = getTable('assessment_cycles');
if (cycleTable.all().length === 0) {
  cycleTable.insert({
    name: '2024年Q1考核', start_date: '2024-01-01', end_date: '2024-03-31',
    targets: { conversion_rate: 30, timely_rate: 80, lost_rate: 20 },
    status: 'active', created_at: '2024-01-01 00:00:00'
  });
  cycleTable.insert({
    name: '2024年Q2考核', start_date: '2024-04-01', end_date: '2024-06-30',
    targets: { conversion_rate: 35, timely_rate: 85, lost_rate: 15 },
    status: 'planned', created_at: '2024-04-01 00:00:00'
  });
  console.log('考核周期初始化完成');
}

// 初始化培训计划
const trainTable = getTable('training_plans');
if (trainTable.all().length === 0) {
  trainTable.insert({
    title: '报价流程优化培训', target_persons: ['李四'], training_type: '流程优化',
    description: '针对报价响应慢的问题，优化核价流程，建立快速报价通道',
    deadline: '2024-04-30', status: 'planned', created_at: '2024-03-25 10:00:00'
  });
  trainTable.insert({
    title: '客户需求分析培训', target_persons: ['李四'], training_type: '销售技巧',
    description: '提升销售人员客户需求分析能力，降低流失率',
    deadline: '2024-05-15', status: 'planned', created_at: '2024-03-25 10:00:00'
  });
  trainTable.insert({
    title: '销售谈判技巧培训', target_persons: ['张三', '李四'], training_type: '销售技巧',
    description: '提升成交转化率，加强谈判能力',
    deadline: '2024-05-30', status: 'planned', created_at: '2024-03-25 10:00:00'
  });
  console.log('培训计划初始化完成');
}

// ===== 初始化角色和权限 =====
const roleTable = getTable('roles');
if (roleTable.all().length === 0) {
  const roles = [
    { name: '超级管理员', code: 'admin', description: '系统最高权限持有者，全模块最高配置权限', created_at: now(), updated_at: now() },
    { name: '销售经理', code: 'sales_manager', description: '销售团队管理、业务督导、无基础库修改权限', created_at: now(), updated_at: now() },
    { name: '销售业务员', code: 'sales', description: '业务执行岗，客户承接、询价跟进，无可核价/审核权限', created_at: now(), updated_at: now() },
    { name: '工程师（研发核价）', code: 'engineer', description: '产品参数维护、BOM管理、核价成本核算', created_at: now(), updated_at: now() },
    { name: '采购人员', code: 'purchase', description: '供应商管理、物料供应链对接，无可报价权限', created_at: now(), updated_at: now() },
    { name: '财务专员', code: 'finance', description: '财务对账查看、台账导出，无可操作权限', created_at: now(), updated_at: now() },
    { name: '项目经理', code: 'project_manager', description: '项目全流程管理：立项、进度、样品、订单与交付跟踪', created_at: now(), updated_at: now() },
    { name: '研发经理', code: 'rd_manager', description: '研发管理：产品/物料/BOM/核价/图纸/合规/测试全权管理', created_at: now(), updated_at: now() },
    { name: '只读账号', code: 'viewer', description: '稽核/审计，全模块只读查看+报表导出', created_at: now(), updated_at: now() }
  ];
  roles.forEach(r => roleTable.insert(r));
  console.log('角色数据初始化完成');
}

const permTable = getTable('permissions');
const existingPermCodes = new Set(permTable.all().filter(p => p.code).map(p => p.code));
const permissions = [
    // 仪表盘
    { name: '查看仪表盘', code: 'dashboard', module: '仪表盘', description: '查看首页仪表盘', created_at: now() },
    // 询价管理
    { name: '查看询价', code: 'inquiry:view', module: '询价管理', description: '查看询价列表和详情', created_at: now() },
    { name: '创建询价', code: 'inquiry:create', module: '询价管理', description: '新建询价单', created_at: now() },
    { name: '编辑询价', code: 'inquiry:edit', module: '询价管理', description: '修改询价信息', created_at: now() },
    { name: '删除询价', code: 'inquiry:delete', module: '询价管理', description: '删除询价单', created_at: now() },
    { name: '核价报价', code: 'inquiry:price', module: '询价管理', description: '对询价单进行核价和报价', created_at: now() },
    { name: '变更状态', code: 'inquiry:status', module: '询价管理', description: '变更询价单状态', created_at: now() },
    { name: '批量导入', code: 'inquiry:import', module: '询价管理', description: '批量导入询价单', created_at: now() },
    { name: '批量导出', code: 'inquiry:export', module: '询价管理', description: '批量导出询价单', created_at: now() },
    // 产品管理
    { name: '查看产品', code: 'product:view', module: '产品管理', description: '查看产品列表和详情', created_at: now() },
    { name: '创建产品', code: 'product:create', module: '产品管理', description: '新增产品', created_at: now() },
    { name: '编辑产品', code: 'product:edit', module: '产品管理', description: '修改产品信息', created_at: now() },
    { name: '删除产品', code: 'product:delete', module: '产品管理', description: '删除产品', created_at: now() },
    // 客户管理
    { name: '查看客户', code: 'customer:view', module: '客户管理', description: '查看客户列表和详情', created_at: now() },
    { name: '创建客户', code: 'customer:create', module: '客户管理', description: '新增客户', created_at: now() },
    { name: '编辑客户', code: 'customer:edit', module: '客户管理', description: '修改客户信息', created_at: now() },
    { name: '删除客户', code: 'customer:delete', module: '客户管理', description: '删除客户', created_at: now() },
    // 物料管理
    { name: '查看物料', code: 'material:view', module: '物料管理', description: '查看物料BOM列表', created_at: now() },
    { name: '创建物料', code: 'material:create', module: '物料管理', description: '新增物料', created_at: now() },
    { name: '编辑物料', code: 'material:edit', module: '物料管理', description: '修改物料信息', created_at: now() },
    { name: '删除物料', code: 'material:delete', module: '物料管理', description: '删除物料', created_at: now() },
    { name: '图纸预览', code: 'drawing:preview', module: '物料管理', description: '预览图纸文件', created_at: now() },
    { name: '图纸审批', code: 'drawing:approve', module: '物料管理', description: '审批图纸文件', created_at: now() },
    { name: '图纸上传', code: 'drawing:upload', module: '物料管理', description: '上传图纸文件', created_at: now() },
    { name: '图纸删除', code: 'drawing:delete', module: '物料管理', description: '删除图纸文件', created_at: now() },
    // 核价管理
    { name: '查看核价', code: 'pricing:view', module: '核价管理', description: '查看核价表和详情', created_at: now() },
    { name: '创建核价', code: 'pricing:create', module: '核价管理', description: '新增核价记录', created_at: now() },
    { name: '编辑核价', code: 'pricing:edit', module: '核价管理', description: '修改核价信息', created_at: now() },
    { name: '删除核价', code: 'pricing:delete', module: '核价管理', description: '删除核价记录', created_at: now() },
    // 供应商管理
    { name: '查看供应商', code: 'supplier:view', module: '供应商管理', description: '查看供应商列表和详情', created_at: now() },
    { name: '创建供应商', code: 'supplier:create', module: '供应商管理', description: '新增供应商', created_at: now() },
    { name: '编辑供应商', code: 'supplier:edit', module: '供应商管理', description: '修改供应商信息', created_at: now() },
    { name: '删除供应商', code: 'supplier:delete', module: '供应商管理', description: '删除供应商', created_at: now() },
    // BOM管理
    { name: '查看BOM', code: 'bom:view', module: 'BOM管理', description: '查看BOM列表和详情', created_at: now() },
    { name: '创建BOM', code: 'bom:create', module: 'BOM管理', description: '新增BOM', created_at: now() },
    { name: '编辑BOM', code: 'bom:edit', module: 'BOM管理', description: '修改BOM信息', created_at: now() },
    { name: '删除BOM', code: 'bom:delete', module: 'BOM管理', description: '删除BOM', created_at: now() },
    // 订单管理
    { name: '查看订单', code: 'order:view', module: '订单管理', description: '查看订单列表和详情', created_at: now() },
    { name: '创建订单', code: 'order:create', module: '订单管理', description: '新增订单', created_at: now() },
    { name: '编辑订单', code: 'order:edit', module: '订单管理', description: '修改订单信息', created_at: now() },
    { name: '删除订单', code: 'order:delete', module: '订单管理', description: '删除订单', created_at: now() },
    // 样品管理
    { name: '查看样品', code: 'sample:view', module: '样品管理', description: '查看样品列表和详情', created_at: now() },
    { name: '创建样品', code: 'sample:create', module: '样品管理', description: '新增样品', created_at: now() },
    { name: '编辑样品', code: 'sample:edit', module: '样品管理', description: '修改样品信息', created_at: now() },
    { name: '删除样品', code: 'sample:delete', module: '样品管理', description: '删除样品', created_at: now() },
    // 项目管理
    { name: '查看项目', code: 'project:view', module: '项目管理', description: '查看项目列表和详情', created_at: now() },
    { name: '创建项目', code: 'project:create', module: '项目管理', description: '新增项目', created_at: now() },
    { name: '编辑项目', code: 'project:edit', module: '项目管理', description: '修改项目信息', created_at: now() },
    { name: '删除项目', code: 'project:delete', module: '项目管理', description: '删除项目', created_at: now() },
    { name: '查看年度经营计划', code: 'annual-plan:view', module: '年度经营计划', description: '查看经营驾驶舱、年度目标和经营分析', created_at: now() },
    { name: '创建年度经营计划', code: 'annual-plan:create', module: '年度经营计划', description: '新增年度经营计划数据', created_at: now() },
    { name: '编辑年度经营计划', code: 'annual-plan:edit', module: '年度经营计划', description: '修改年度经营计划和进度', created_at: now() },
    { name: '删除年度经营计划', code: 'annual-plan:delete', module: '年度经营计划', description: '删除年度经营计划记录', created_at: now() },
    { name: 'AI经营分析', code: 'annual-plan:analyze', module: '年度经营计划', description: '使用AI经营助手分析和生成报告', created_at: now() },
    { name: '导出年度经营计划', code: 'annual-plan:export', module: '年度经营计划', description: '导出年度经营计划数据', created_at: now() },
    // BOM对比
    { name: '查看BOM对比', code: 'bom-compare:view', module: 'BOM对比', description: '查看BOM对比分析', created_at: now() },
    // 报价库
    { name: '查看报价库', code: 'quote:view', module: '报价库', description: '查看报价库列表', created_at: now() },
    { name: '管理报价库', code: 'quote:manage', module: '报价库', description: '管理报价库（创建/编辑/删除）', created_at: now() },
    // 产品配置表
    { name: '查看配置表', code: 'config:view', module: '产品配置表', description: '查看配置表列表和详情', created_at: now() },
    { name: '创建配置表', code: 'config:create', module: '产品配置表', description: '新增配置表', created_at: now() },
    { name: '编辑配置表', code: 'config:edit', module: '产品配置表', description: '修改配置表', created_at: now() },
    { name: '删除配置表', code: 'config:delete', module: '产品配置表', description: '删除配置表', created_at: now() },
    // 规格书库
    { name: '查看规格书', code: 'spec:view', module: '规格书库', description: '查看规格书列表', created_at: now() },
    { name: '管理规格书', code: 'spec:manage', module: '规格书库', description: '管理规格书（创建/编辑/删除）', created_at: now() },
    // 配置表库
    { name: '查看配置表库', code: 'config-lib:view', module: '配置表库', description: '查看配置表库', created_at: now() },
    { name: '管理配置表库', code: 'config-lib:manage', module: '配置表库', description: '管理配置表库', created_at: now() },
    // 数据报表
    { name: '查看报表', code: 'report:view', module: '数据报表', description: '查看数据报表和统计', created_at: now() },
    // 智能助手
    { name: '使用智能助手', code: 'ai:view', module: '智能助手', description: '使用智能助手功能', created_at: now() },
    // 流程规则
    { name: '查看流程规则', code: 'rules:view', module: '流程规则', description: '查看业务流程规则', created_at: now() },
    { name: '管理流程规则', code: 'rules:manage', module: '流程规则', description: '管理业务流程规则', created_at: now() },
    // 合规自检
    { name: '查看合规自检', code: 'compliance:view', module: '合规自检', description: '查看合规自检结果', created_at: now() },
    { name: '运行合规自检', code: 'compliance:run', module: '合规自检', description: '运行合规检查', created_at: now() },
    // 数据清洗
    { name: '查看数据清洗', code: 'data-clean:view', module: '数据清洗', description: '查看数据清洗功能', created_at: now() },
    { name: '执行数据清洗', code: 'data-clean:execute', module: '数据清洗', description: '执行数据清洗操作', created_at: now() },
    // 自动测试
    { name: '查看自动测试', code: 'test:view', module: '自动测试', description: '查看自动测试功能', created_at: now() },
    { name: '运行自动测试', code: 'test:run', module: '自动测试', description: '运行自动测试', created_at: now() },
    // 系统管理
    { name: '权限管理', code: 'system:permission', module: '系统管理', description: '管理角色和权限', created_at: now() },
    { name: '用户管理', code: 'system:user', module: '系统管理', description: '管理系统用户', created_at: now() },
    { name: '系统配置', code: 'system:config', module: '系统管理', description: '修改系统配置', created_at: now() },
    // 问题反馈
    { name: '提交反馈', code: 'feedback:create', module: '问题反馈', description: '提交问题反馈', created_at: now() },
    { name: '处理反馈', code: 'feedback:handle', module: '问题反馈', description: '处理和关闭反馈', created_at: now() }
  ];
  // 增量补充缺失的权限（保留已存在的权限和已分配的角色权限）
  let permsAdded = 0;
  permissions.forEach(p => {
    if (!existingPermCodes.has(p.code)) {
      permTable.insert(p);
      permsAdded++;
    }
  });
  if (permsAdded > 0) {
    console.log('权限数据补充完成，新增 ' + permsAdded + ' 条缺失权限');
  }

// 初始化角色权限关联
const rpTable = getTable('role_permissions');
if (rpTable.all().length === 0) {
  const allPerms = permTable.all();
  const roles = roleTable.all();

  // admin角色拥有所有权限
  const adminRole = roles.find(r => r.code === 'admin');
  if (adminRole) {
    allPerms.forEach(p => rpTable.insert({ role_id: adminRole.id, permission_id: p.id, granted_at: now() }));
  }

  function grantPerms(roleCode, permCodes) {
    const role = roles.find(r => r.code === roleCode);
    if (!role) return;
    permCodes.forEach(code => {
      const p = allPerms.find(pm => pm.code === code);
      if (p) rpTable.insert({ role_id: role.id, permission_id: p.id, granted_at: now() });
    });
  }

  // ===== 销售经理（团队管理+业务督导，无基础库修改） =====
  grantPerms('sales_manager', [
    // 询价：只读流程 + 状态管理 + 导入导出
    'inquiry:view','inquiry:status','inquiry:import','inquiry:export',
    // 客户：完全权限
    'customer:view','customer:create','customer:edit','customer:delete',
    // 产品：只读
    'product:view',
    // 物料：只读
    'material:view',
    // 供应商：只读
    'supplier:view',
    // BOM：只读
    'bom:view','bom-compare:view',
    // 核价：只读
    'pricing:view',
    // 报价库：完全
    'quote:view','quote:manage',
    // 订单：完全
    'order:view','order:create','order:edit',
    // 样品：完全
    'sample:view','sample:create','sample:edit',
    // 项目：完全
    'project:view','project:create','project:edit',
    'annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:delete','annual-plan:analyze','annual-plan:export',
    // 配置/规格：只读
    'config:view','spec:view','config-lib:view',
    // 报表：完全
    'report:view',
    // 权限：只读
    'system:permission',
    // 反馈：完全
    'feedback:create','feedback:handle',
    // 合规/测试/规则：只读
    'compliance:view','test:view','rules:view',
    // AI/通讯：完全
    'ai:view',
    // 数据清洗：只读
    'data-clean:view',
    // 图纸：只读
    'drawing:preview'
  ]);

  // ===== 销售业务员（业务执行岗，无可核价/审核/基础数据修改） =====
  grantPerms('sales', [
    // 询价：完全操作权限
    'inquiry:view','inquiry:create','inquiry:edit','inquiry:price','inquiry:status','inquiry:import','inquiry:export',
    // 客户：完全
    'customer:view','customer:create','customer:edit','customer:delete',
    // 产品：只读
    'product:view',
    // 物料：只读
    'material:view',
    // BOM：只读
    'bom:view','bom-compare:view',
    // 订单：完全
    'order:view','order:create','order:edit',
    // 样品：完全
    'sample:view','sample:create','sample:edit',
    // 项目：只读
    'project:view',
    'annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:analyze','annual-plan:export',
    // 报价库：完全
    'quote:view','quote:manage',
    // 配置/规格：只读
    'config:view','spec:view','config-lib:view',
    // 报表：完全
    'report:view',
    // AI/通讯：完全
    'ai:view',
    // 合规/测试/规则：只读
    'compliance:view','test:view','rules:view',
    // 反馈：完全（提交）
    'feedback:create',
    // 数据清洗：只读
    'data-clean:view',
    // 图纸：只读
    'drawing:preview'
  ]);

  // ===== 工程师（技术核价岗，无可客户业务/财务审核） =====
  grantPerms('engineer', [
    // 询价：查看+核价
    'inquiry:view','inquiry:price',
    // 客户：❌（无任何客户权限）
    // 产品：完全
    'product:view','product:create','product:edit','product:delete',
    // 物料：完全
    'material:view','material:create','material:edit','material:delete',
    // 供应商：只读
    'supplier:view',
    // BOM：完全
    'bom:view','bom:create','bom:edit','bom:delete','bom-compare:view',
    // 核价：完全
    'pricing:view','pricing:create','pricing:edit','pricing:delete',
    // 配置/规格：完全
    'config:view','config:create','config:edit','config:delete',
    'spec:view','spec:manage','config-lib:view','config-lib:manage',
    // 报价库：完全
    'quote:view','quote:manage',
    // 样品：只读
    'sample:view',
    // 项目：完全
    'project:view','project:create','project:edit',
    'annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:analyze','annual-plan:export',
    // 订单：只读
    'order:view',
    // 报表：完全
    'report:view',
    // AI：完全
    'ai:view',
    // 合规：完全
    'compliance:view','compliance:run',
    // 测试：完全
    'test:view','test:run',
    // 规则：只读
    'rules:view',
    // 反馈：完全（提交）
    'feedback:create',
    // 数据清洗：完全
    'data-clean:view','data-clean:execute',
    // 图纸：完全
    'drawing:preview','drawing:approve','drawing:upload','drawing:delete'
  ]);

  // ===== 采购人员（供应链岗，无可报价/无系统配置） =====
  grantPerms('purchase', [
    // 询价：只读
    'inquiry:view',
    // 客户：❌
    // 产品：只读
    'product:view',
    // 物料：完全
    'material:view','material:create','material:edit','material:delete',
    // 供应商：完全
    'supplier:view','supplier:create','supplier:edit','supplier:delete',
    // BOM：完全
    'bom:view','bom:create','bom:edit','bom-compare:view',
    // 核价：❌（不可查看核价成本）
    // 订单：完全
    'order:view','order:create','order:edit',
    // 样品：只读
    'sample:view',
    // 项目：只读
    'project:view',
    'annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:analyze','annual-plan:export',
    // 配置/规格：只读
    'config:view','spec:view','config-lib:view',
    // 报价库：❌
    // 报表：完全
    'report:view',
    // AI：完全
    'ai:view',
    // 合规/测试/规则：只读
    'compliance:view','test:view','rules:view',
    // 反馈：完全（提交）
    'feedback:create',
    // 数据清洗：只读
    'data-clean:view',
    // 图纸：只读+上传
    'drawing:preview','drawing:upload'
  ]);

  // ===== 财务人员（查看核对岗，无可新增/修改/审核/审批） =====
  grantPerms('finance', [
    // 询价/客户/产品/物料：只读
    'inquiry:view','product:view','customer:view','material:view',
    // 核价：只读
    'pricing:view',
    // 供应商：只读
    'supplier:view',
    // BOM：只读
    'bom:view','bom-compare:view',
    // 订单/样品/项目：只读
    'order:view','sample:view','project:view',
    'annual-plan:view','annual-plan:analyze','annual-plan:export',
    // 报价库：只读
    'quote:view',
    // 配置/规格：只读
    'config:view','spec:view','config-lib:view',
    // 报表：完全（含导出）
    'report:view',
    // AI/通讯：完全
    'ai:view',
    // 合规/测试/规则：只读
    'compliance:view','test:view','rules:view',
    // 数据清洗：只读
    'data-clean:view',
    // 图纸：只读
    'drawing:preview'
  ]);

  // ===== 只读用户（稽核/审计，全模块只读+报表导出，无可操作） =====
  grantPerms('viewer', [
    // 全模块只读
    'inquiry:view','product:view','customer:view','material:view',
    'pricing:view','supplier:view','bom:view','order:view',
    'sample:view','project:view','bom-compare:view',
    'annual-plan:view','annual-plan:export',
    'quote:view','config:view','spec:view','config-lib:view',
    'report:view','ai:view','rules:view','compliance:view',
    'test:view','data-clean:view',
    // 权限/系统：只读
    'system:permission','system:config',
    // 图纸：只读
    'drawing:preview'
  ]);

  // ===== 项目经理（项目全流程管理） =====
  grantPerms('project_manager', [
    'inquiry:view','inquiry:status','inquiry:export',
    'customer:view',
    'product:view','material:view','supplier:view',
    'bom:view','bom-compare:view','pricing:view',
    'quote:view',
    'order:view','order:create','order:edit',
    'sample:view','sample:create','sample:edit','sample:delete',
    'project:view','project:create','project:edit','project:delete',
    'annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:delete','annual-plan:analyze','annual-plan:export',
    'config:view','spec:view','config-lib:view',
    'report:view','ai:view','ai:delete',
    'system:permission',
    'feedback:create','feedback:handle','feedback:delete',
    'compliance:view','compliance:run','test:view','rules:view',
    'data-clean:view','drawing:preview'
  ]);

  // ===== 研发经理（研发全权管理） =====
  grantPerms('rd_manager', [
    'inquiry:view','inquiry:price','inquiry:status',
    'product:view','product:create','product:edit','product:delete',
    'material:view','material:create','material:edit','material:delete',
    'supplier:view',
    'bom:view','bom:create','bom:edit','bom:delete','bom-compare:view',
    'pricing:view','pricing:create','pricing:edit','pricing:delete',
    'config:view','config:create','config:edit','config:delete',
    'spec:view','spec:manage','spec:delete',
    'config-lib:view','config-lib:manage','config-lib:delete',
    'quote:view','quote:manage','quote:delete',
    'sample:view','sample:create','sample:edit','sample:delete',
    'order:view',
    'project:view','project:create','project:edit','project:delete',
    'annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:analyze','annual-plan:export',
    'report:view','ai:view','ai:delete',
    'compliance:view','compliance:run',
    'test:view','test:run',
    'rules:view','rules:manage','rules:delete',
    'feedback:create',
    'data-clean:view','data-clean:execute','data-clean:delete',
    'drawing:preview','drawing:approve','drawing:upload','drawing:delete'
  ]);

  console.log('角色权限关联初始化完成');
}

const annualRolePerms = {
  sales_manager: ['annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:delete','annual-plan:analyze','annual-plan:export'],
  sales: ['annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:analyze','annual-plan:export'],
  engineer: ['annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:analyze','annual-plan:export'],
  purchase: ['annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:analyze','annual-plan:export'],
  finance: ['annual-plan:view','annual-plan:analyze','annual-plan:export'],
  viewer: ['annual-plan:view','annual-plan:export'],
  project_manager: ['annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:delete','annual-plan:analyze','annual-plan:export'],
  rd_manager: ['annual-plan:view','annual-plan:create','annual-plan:edit','annual-plan:analyze','annual-plan:export']
};
let annualPermsAdded = 0;
Object.keys(annualRolePerms).forEach(roleCode => {
  const role = roleTable.all().find(r => r.code === roleCode);
  if (!role) return;
  annualRolePerms[roleCode].forEach(code => {
    const perm = permTable.all().find(p => p.code === code);
    if (!perm) return;
    const exists = rpTable.all().some(rp => rp.role_id === role.id && rp.permission_id === perm.id);
    if (!exists) {
      rpTable.insert({ role_id: role.id, permission_id: perm.id, granted_at: now() });
      annualPermsAdded++;
    }
  });
});
if (annualPermsAdded > 0) console.log('年度经营计划角色权限补充完成，新增 ' + annualPermsAdded + ' 条');

// 初始化用户角色关联
const urTable = getTable('user_roles');
if (urTable.all().length === 0) {
  const users = getTable('users').all();
  const roles = roleTable.all();

  users.forEach(u => {
    const role = roles.find(r => r.code === u.role);
    if (role) {
      urTable.insert({ user_id: u.id, role_id: role.id, assigned_at: now() });
    }
  });
  console.log('用户角色关联初始化完成');
}

// 初始化示例反馈
const fbTable = getTable('feedback');
if (fbTable.all().length === 0) {
  const feedbacks = [
    { title: '批量导入功能CSV编码问题', description: '导入CSV文件时中文乱码，需要支持UTF-8 BOM编码', type: 'bug', priority: 'high', module: '询价管理', submitter: '张三', assignee: '王工', status: 'resolved', resolution: '已修复，添加BOM头自动检测', resolved_at: now(), created_at: now(), updated_at: now() },
    { title: '希望增加报价单PDF导出', description: '当前只能导出TXT，希望能直接生成PDF格式报价单', type: 'feature', priority: 'medium', module: '询价管理', submitter: '李四', assignee: '', status: 'open', resolution: '', resolved_at: null, created_at: now(), updated_at: now() },
    { title: '产品列表搜索不够精确', description: '搜索产品型号时只能精确匹配，希望支持模糊搜索', type: 'improvement', priority: 'medium', module: '产品管理', submitter: '张三', assignee: '王工', status: 'processing', resolution: '', resolved_at: null, created_at: now(), updated_at: now() },
    { title: '如何设置批量修改状态？', description: '不清楚批量修改状态的操作流程', type: 'question', priority: 'low', module: '询价管理', submitter: '赵采购', assignee: '张三', status: 'closed', resolution: '已提供操作指南', resolved_at: now(), created_at: now(), updated_at: now() }
  ];
  feedbacks.forEach(f => fbTable.insert(f));
  console.log('反馈数据初始化完成');
}

// ===== 初始化核价表 =====
const bomTable = getTable('bom_pricing');
if (bomTable.all().length === 0) {
  const bomData = [
    { customer: '972', inquiry_no: '26-119', model: 'JFS24-B1WA100-Z-003', product_name: 'S系列100W带插座折叠支架工作灯', power: '100W',
      kit: 20.5, cable: 26.9, light_source: 15, driver: null, battery: null, bracket: 12, switch_type: 2, solar_panel: null, socket: 27, box: 8, manual: null, packaging: 5, accessories: null, labor: 4,
      total_cost: 120.4, pricer: '包跃', pricing_link: 'JFX20260512-119', price_rmb: 150.5, price_usd: 21.65, target_price: null, remarks: '模具费',
      created_at: now(), updated_at: now() },
    { customer: '972', inquiry_no: '26-119', model: 'JFS22-B1WA30-ZJ2-013-001', product_name: 'S系列30W双灯伞形三脚支架工作灯', power: '30W*2',
      kit: 22.6, cable: 22.6, light_source: 9, driver: null, battery: null, bracket: 33, switch_type: 4, solar_panel: null, socket: null, box: null, manual: null, packaging: 8, accessories: null, labor: 7,
      total_cost: 106.2, pricer: '包跃', pricing_link: 'JFX20260512-119', price_rmb: 132.75, price_usd: 19.10, target_price: 25000, remarks: '',
      created_at: now(), updated_at: now() },
    { customer: '972', inquiry_no: '26-119', model: 'HS004', product_name: '绿能工作灯', power: '10W',
      kit: 4.5, cable: 2, light_source: 5.4, driver: 4.5, battery: 7.6, bracket: null, switch_type: null, solar_panel: 5, socket: null, box: null, manual: 0.8, packaging: 1.5, accessories: 7, labor: 2,
      total_cost: 40.3, pricer: '包跃', pricing_link: 'JFX20260512-119', price_rmb: 50.38, price_usd: 7.25, target_price: null, remarks: '杆子模具可新开，增加挂钩功能',
      created_at: now(), updated_at: now() }
  ];
  bomData.forEach(b => bomTable.insert(b));
  console.log('核价表数据初始化完成');
}

// ===== 初始化流程规则（各模块功能开关） =====
const wfTable = getTable('workflow_rules');
if (wfTable.all().length === 0) {
  const featureRules = [
    // 询价管理
    { code: 'inquiry:inline_edit', name: '询价管理 - 行内编辑', category: 'inquiry', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"inquiry"}', created_at: now(), updated_at: now() },
    { code: 'inquiry:sort', name: '询价管理 - 排序', category: 'inquiry', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"inquiry"}', created_at: now(), updated_at: now() },
    { code: 'inquiry:filter', name: '询价管理 - 筛选', category: 'inquiry', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"inquiry"}', created_at: now(), updated_at: now() },
    { code: 'inquiry:import', name: '询价管理 - 批量导入', category: 'inquiry', type: 'feature', priority: 80, description: '允许Excel批量导入询价单', action: 'toggle_feature', action_params: '{"feature":"import","module":"inquiry"}', created_at: now(), updated_at: now() },
    { code: 'inquiry:export', name: '询价管理 - 批量导出', category: 'inquiry', type: 'feature', priority: 80, description: '允许批量导出Excel询价单', action: 'toggle_feature', action_params: '{"feature":"export","module":"inquiry"}', created_at: now(), updated_at: now() },
    { code: 'inquiry:batch_status', name: '询价管理 - 批量改状态', category: 'inquiry', type: 'feature', priority: 80, description: '允许批量修改询价单状态', action: 'toggle_feature', action_params: '{"feature":"batch","module":"inquiry"}', created_at: now(), updated_at: now() },
    { code: 'inquiry:dashboard', name: '询价管理 - 统计分析', category: 'inquiry', type: 'feature', priority: 80, description: '显示KPI卡片和图表统计', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"inquiry"}', created_at: now(), updated_at: now() },
    { code: 'inquiry:ocr', name: '询价管理 - OCR识别', category: 'inquiry', type: 'feature', priority: 80, description: '允许拍照识别客户信息', action: 'toggle_feature', action_params: '{"feature":"ocr","module":"inquiry"}', created_at: now(), updated_at: now() },
    { code: 'inquiry:email', name: '询价管理 - 发送邮件', category: 'inquiry', type: 'feature', priority: 80, description: '允许报价后发送邮件', action: 'toggle_feature', action_params: '{"feature":"email","module":"inquiry"}', created_at: now(), updated_at: now() },
    // 客户管理
    { code: 'customer:inline_edit', name: '客户管理 - 行内编辑', category: 'customer', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"customer"}', created_at: now(), updated_at: now() },
    { code: 'customer:sort', name: '客户管理 - 排序', category: 'customer', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"customer"}', created_at: now(), updated_at: now() },
    { code: 'customer:filter', name: '客户管理 - 筛选', category: 'customer', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"customer"}', created_at: now(), updated_at: now() },
    { code: 'customer:import', name: '客户管理 - 批量导入', category: 'customer', type: 'feature', priority: 80, description: '允许Excel批量导入客户', action: 'toggle_feature', action_params: '{"feature":"import","module":"customer"}', created_at: now(), updated_at: now() },
    { code: 'customer:export', name: '客户管理 - 批量导出', category: 'customer', type: 'feature', priority: 80, description: '允许批量导出客户数据', action: 'toggle_feature', action_params: '{"feature":"export","module":"customer"}', created_at: now(), updated_at: now() },
    { code: 'customer:batch_delete', name: '客户管理 - 批量删除', category: 'customer', type: 'feature', priority: 80, description: '允许批量删除客户', action: 'toggle_feature', action_params: '{"feature":"batch","module":"customer"}', created_at: now(), updated_at: now() },
    { code: 'customer:dashboard', name: '客户管理 - 统计分析', category: 'customer', type: 'feature', priority: 80, description: '显示客户统计报表', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"customer"}', created_at: now(), updated_at: now() },
    { code: 'customer:ocr', name: '客户管理 - OCR识别', category: 'customer', type: 'feature', priority: 80, description: '允许拍照识别客户名片', action: 'toggle_feature', action_params: '{"feature":"ocr","module":"customer"}', created_at: now(), updated_at: now() },
    // 产品管理
    { code: 'product:inline_edit', name: '产品管理 - 行内编辑', category: 'product', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"product"}', created_at: now(), updated_at: now() },
    { code: 'product:sort', name: '产品管理 - 排序', category: 'product', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"product"}', created_at: now(), updated_at: now() },
    { code: 'product:filter', name: '产品管理 - 筛选', category: 'product', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"product"}', created_at: now(), updated_at: now() },
    { code: 'product:import', name: '产品管理 - 批量导入', category: 'product', type: 'feature', priority: 80, description: '允许Excel批量导入产品', action: 'toggle_feature', action_params: '{"feature":"import","module":"product"}', created_at: now(), updated_at: now() },
    { code: 'product:export', name: '产品管理 - 批量导出', category: 'product', type: 'feature', priority: 80, description: '允许批量导出产品数据', action: 'toggle_feature', action_params: '{"feature":"export","module":"product"}', created_at: now(), updated_at: now() },
    { code: 'product:dashboard', name: '产品管理 - 统计分析', category: 'product', type: 'feature', priority: 80, description: '显示产品统计图表', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"product"}', created_at: now(), updated_at: now() },
    // 物料库
    { code: 'material:inline_edit', name: '物料库 - 行内编辑', category: 'material', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"material"}', created_at: now(), updated_at: now() },
    { code: 'material:sort', name: '物料库 - 排序', category: 'material', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"material"}', created_at: now(), updated_at: now() },
    { code: 'material:filter', name: '物料库 - 筛选', category: 'material', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"material"}', created_at: now(), updated_at: now() },
    { code: 'material:import', name: '物料库 - 批量导入', category: 'material', type: 'feature', priority: 80, description: '允许Excel批量导入物料', action: 'toggle_feature', action_params: '{"feature":"import","module":"material"}', created_at: now(), updated_at: now() },
    { code: 'material:export', name: '物料库 - 导出采购报表', category: 'material', type: 'feature', priority: 80, description: '允许导出采购报表', action: 'toggle_feature', action_params: '{"feature":"export","module":"material"}', created_at: now(), updated_at: now() },
    { code: 'material:sync', name: '物料库 - 同步外部库存', category: 'material', type: 'feature', priority: 80, description: '允许同步外部系统库存数据', action: 'toggle_feature', action_params: '{"feature":"sync","module":"material"}', created_at: now(), updated_at: now() },
    { code: 'material:dashboard', name: '物料库 - 统计分析', category: 'material', type: 'feature', priority: 80, description: '显示物料统计和库存预警', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"material"}', created_at: now(), updated_at: now() },
    // 供应商管理
    { code: 'supplier:inline_edit', name: '供应商管理 - 行内编辑', category: 'supplier', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"supplier"}', created_at: now(), updated_at: now() },
    { code: 'supplier:sort', name: '供应商管理 - 排序', category: 'supplier', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"supplier"}', created_at: now(), updated_at: now() },
    { code: 'supplier:filter', name: '供应商管理 - 筛选', category: 'supplier', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"supplier"}', created_at: now(), updated_at: now() },
    { code: 'supplier:import', name: '供应商管理 - 批量导入', category: 'supplier', type: 'feature', priority: 80, description: '允许Excel批量导入供应商', action: 'toggle_feature', action_params: '{"feature":"import","module":"supplier"}', created_at: now(), updated_at: now() },
    { code: 'supplier:export', name: '供应商管理 - 导出', category: 'supplier', type: 'feature', priority: 80, description: '允许导出供应商数据', action: 'toggle_feature', action_params: '{"feature":"export","module":"supplier"}', created_at: now(), updated_at: now() },
    { code: 'supplier:dashboard', name: '供应商管理 - 统计分析', category: 'supplier', type: 'feature', priority: 80, description: '显示供应商统计概览', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"supplier"}', created_at: now(), updated_at: now() },
    // BOM管理
    { code: 'bom:inline_edit', name: 'BOM管理 - 行内编辑', category: 'bom', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"bom"}', created_at: now(), updated_at: now() },
    { code: 'bom:sort', name: 'BOM管理 - 排序', category: 'bom', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"bom"}', created_at: now(), updated_at: now() },
    { code: 'bom:filter', name: 'BOM管理 - 筛选', category: 'bom', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"bom"}', created_at: now(), updated_at: now() },
    { code: 'bom:import', name: 'BOM管理 - 批量导入', category: 'bom', type: 'feature', priority: 80, description: '允许Excel批量导入BOM', action: 'toggle_feature', action_params: '{"feature":"import","module":"bom"}', created_at: now(), updated_at: now() },
    { code: 'bom:export', name: 'BOM管理 - 导出', category: 'bom', type: 'feature', priority: 80, description: '允许导出BOM数据', action: 'toggle_feature', action_params: '{"feature":"export","module":"bom"}', created_at: now(), updated_at: now() },
    { code: 'bom:dashboard', name: 'BOM管理 - 统计分析', category: 'bom', type: 'feature', priority: 80, description: '显示BOM统计图表', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"bom"}', created_at: now(), updated_at: now() },
    // 订单管理
    { code: 'order:inline_edit', name: '订单管理 - 行内编辑', category: 'order', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"order"}', created_at: now(), updated_at: now() },
    { code: 'order:sort', name: '订单管理 - 排序', category: 'order', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"order"}', created_at: now(), updated_at: now() },
    { code: 'order:filter', name: '订单管理 - 筛选', category: 'order', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"order"}', created_at: now(), updated_at: now() },
    { code: 'order:import', name: '订单管理 - 导入', category: 'order', type: 'feature', priority: 80, description: '允许导入订单数据', action: 'toggle_feature', action_params: '{"feature":"import","module":"order"}', created_at: now(), updated_at: now() },
    { code: 'order:export', name: '订单管理 - 导出', category: 'order', type: 'feature', priority: 80, description: '允许导出订单数据', action: 'toggle_feature', action_params: '{"feature":"export","module":"order"}', created_at: now(), updated_at: now() },
    { code: 'order:dashboard', name: '订单管理 - 统计分析', category: 'order', type: 'feature', priority: 80, description: '显示订单统计图表', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"order"}', created_at: now(), updated_at: now() },
    // 样品管理
    { code: 'sample:inline_edit', name: '样品管理 - 行内编辑', category: 'sample', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"sample"}', created_at: now(), updated_at: now() },
    { code: 'sample:sort', name: '样品管理 - 排序', category: 'sample', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"sample"}', created_at: now(), updated_at: now() },
    { code: 'sample:filter', name: '样品管理 - 筛选', category: 'sample', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"sample"}', created_at: now(), updated_at: now() },
    { code: 'sample:dashboard', name: '样品管理 - 统计分析', category: 'sample', type: 'feature', priority: 80, description: '显示样品统计图表', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"sample"}', created_at: now(), updated_at: now() },
    // 项目管理
    { code: 'project:inline_edit', name: '项目管理 - 行内编辑', category: 'project', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"project"}', created_at: now(), updated_at: now() },
    { code: 'project:sort', name: '项目管理 - 排序', category: 'project', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"project"}', created_at: now(), updated_at: now() },
    { code: 'project:filter', name: '项目管理 - 筛选', category: 'project', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"project"}', created_at: now(), updated_at: now() },
    { code: 'project:dashboard', name: '项目管理 - 统计分析', category: 'project', type: 'feature', priority: 80, description: '显示项目统计图表', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"project"}', created_at: now(), updated_at: now() },
    // 核价表
    { code: 'pricing:inline_edit', name: '核价表 - 行内编辑', category: 'pricing', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"pricing"}', created_at: now(), updated_at: now() },
    { code: 'pricing:sort', name: '核价表 - 排序', category: 'pricing', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"pricing"}', created_at: now(), updated_at: now() },
    { code: 'pricing:filter', name: '核价表 - 筛选', category: 'pricing', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"pricing"}', created_at: now(), updated_at: now() },
    { code: 'pricing:export', name: '核价表 - 导出', category: 'pricing', type: 'feature', priority: 80, description: '允许导出核价数据', action: 'toggle_feature', action_params: '{"feature":"export","module":"pricing"}', created_at: now(), updated_at: now() },
    { code: 'pricing:sync', name: '核价表 - 同步到报价库', category: 'pricing', type: 'feature', priority: 80, description: '允许同步核价数据到报价库', action: 'toggle_feature', action_params: '{"feature":"sync","module":"pricing"}', created_at: now(), updated_at: now() },
    { code: 'pricing:dashboard', name: '核价表 - 统计分析', category: 'pricing', type: 'feature', priority: 80, description: '显示核价统计图表', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"pricing"}', created_at: now(), updated_at: now() },
    // 报价库
    { code: 'quote:inline_edit', name: '报价库 - 行内编辑', category: 'quote', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"quote"}', created_at: now(), updated_at: now() },
    { code: 'quote:sort', name: '报价库 - 排序', category: 'quote', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"quote"}', created_at: now(), updated_at: now() },
    { code: 'quote:filter', name: '报价库 - 筛选', category: 'quote', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"quote"}', created_at: now(), updated_at: now() },
    { code: 'quote:export', name: '报价库 - 导出', category: 'quote', type: 'feature', priority: 80, description: '允许导出报价数据', action: 'toggle_feature', action_params: '{"feature":"export","module":"quote"}', created_at: now(), updated_at: now() },
    { code: 'quote:dashboard', name: '报价库 - 统计分析', category: 'quote', type: 'feature', priority: 80, description: '显示报价统计概览', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"quote"}', created_at: now(), updated_at: now() },
    // 产品配置表
    { code: 'config:inline_edit', name: '配置表 - 行内编辑', category: 'config', type: 'feature', priority: 80, description: '允许在列表直接点击编辑字段', action: 'toggle_feature', action_params: '{"feature":"inline_edit","module":"config"}', created_at: now(), updated_at: now() },
    { code: 'config:sort', name: '配置表 - 排序', category: 'config', type: 'feature', priority: 80, description: '允许按表头点击排序', action: 'toggle_feature', action_params: '{"feature":"sort","module":"config"}', created_at: now(), updated_at: now() },
    { code: 'config:filter', name: '配置表 - 筛选', category: 'config', type: 'feature', priority: 80, description: '显示高级搜索筛选栏', action: 'toggle_feature', action_params: '{"feature":"filter","module":"config"}', created_at: now(), updated_at: now() },
    { code: 'config:import', name: '配置表 - 导入', category: 'config', type: 'feature', priority: 80, description: '允许导入配置表', action: 'toggle_feature', action_params: '{"feature":"import","module":"config"}', created_at: now(), updated_at: now() },
    { code: 'config:export', name: '配置表 - 导出', category: 'config', type: 'feature', priority: 80, description: '允许导出配置表', action: 'toggle_feature', action_params: '{"feature":"export","module":"config"}', created_at: now(), updated_at: now() },
    { code: 'config:dashboard', name: '配置表 - 统计分析', category: 'config', type: 'feature', priority: 80, description: '显示配置表统计', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"config"}', created_at: now(), updated_at: now() },
    // 数据报表
    { code: 'report:dashboard', name: '报表 - 仪表盘图表', category: 'report', type: 'feature', priority: 80, description: '显示统计图表和分析仪表盘', action: 'toggle_feature', action_params: '{"feature":"dashboard","module":"report"}', created_at: now(), updated_at: now() },
    { code: 'report:export', name: '报表 - 导出', category: 'report', type: 'feature', priority: 80, description: '允许导出报表数据', action: 'toggle_feature', action_params: '{"feature":"export","module":"report"}', created_at: now(), updated_at: now() },
    // 仪表盘首页
    { code: 'dashboard:kpi_cards', name: '首页仪表盘 - KPI卡片', category: 'dashboard', type: 'feature', priority: 90, description: '显示首页KPI统计卡片', action: 'toggle_feature', action_params: '{"feature":"kpi_cards","module":"dashboard"}', created_at: now(), updated_at: now() },
    { code: 'dashboard:charts', name: '首页仪表盘 - 图表', category: 'dashboard', type: 'feature', priority: 90, description: '显示首页柱状图和饼图', action: 'toggle_feature', action_params: '{"feature":"charts","module":"dashboard"}', created_at: now(), updated_at: now() },
    { code: 'dashboard:quick_actions', name: '首页仪表盘 - 快捷操作', category: 'dashboard', type: 'feature', priority: 90, description: '显示首页快捷操作按钮', action: 'toggle_feature', action_params: '{"feature":"quick_actions","module":"dashboard"}', created_at: now(), updated_at: now() },
    { code: 'dashboard:activity', name: '首页仪表盘 - 最近活动', category: 'dashboard', type: 'feature', priority: 90, description: '显示最近操作活动记录', action: 'toggle_feature', action_params: '{"feature":"activity","module":"dashboard"}', created_at: now(), updated_at: now() },
    // 核心业务流程规则
    { code: 'inquiry:auto_pricing', name: '询价提交后自动核价', category: 'inquiry', type: 'core', priority: 100, description: '询价提交后系统自动匹配核价标准生成报价', action: 'auto_pricing', action_params: '{}', created_at: now(), updated_at: now() },
    { code: 'inquiry:status_flow', name: '询价7步标准流程', category: 'inquiry', type: 'core', priority: 100, description: '启用7步询价标准流程（发起→证书选型→生成配置→核价→报价→闭环）', action: 'status_flow', action_params: '{}', created_at: now(), updated_at: now() },
    { code: 'pricing:auto_sync', name: '核价库自动同步报价库', category: 'pricing', type: 'core', priority: 90, description: '核价完成后每5分钟自动同步到报价库', action: 'auto_sync', action_params: '{}', created_at: now(), updated_at: now() },
    { code: 'inquiry:cert_required', name: '证书选型检查', category: 'inquiry', type: 'core', priority: 90, description: '新建询价需关联认证证书合规属性', action: 'cert_check', action_params: '{}', created_at: now(), updated_at: now() }
  ];

  featureRules.forEach(r => wfTable.insert(r));
  console.log('流程规则初始化完成（共' + featureRules.length + '条）');
}
