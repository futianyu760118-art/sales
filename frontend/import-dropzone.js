/**
 * 批量导入拖拽上传组件 - 支持表头映射匹配
 * 支持 Excel(.xlsx/.xls)、CSV(.csv)、TSV(.tsv)、ODS(.ods) 格式
 * 使用方式: ImportDropzone.init(containerId, tableName, onSuccess)
 */
const ImportDropzone = {
  API: window.location.origin + '/api',
  currentTable: '',
  onSuccessCallback: null,
  _styleInjected: false,
  _pendingFiles: null,
  _xlsxLib: null,

  _injectStyle() {
    if (this._styleInjected) return;
    this._styleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .import-dropzone-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.5); z-index: 10000;
        display: flex; align-items: center; justify-content: center;
      }
      .import-dropzone-modal {
        background: white; border-radius: 16px; padding: 0;
        width: 560px; max-width: 90vw; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        overflow: hidden; animation: importSlideIn 0.3s ease;
      }
      .import-dropzone-modal.wide { width: 760px; }
      @keyframes importSlideIn {
        from { transform: translateY(-20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .import-dropzone-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 18px 24px; border-bottom: 1px solid #eee;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      }
      .import-dropzone-header h3 {
        margin: 0; color: white; font-size: 16px; font-weight: 600;
      }
      .import-close-btn {
        background: none; border: none; color: white; font-size: 24px;
        cursor: pointer; padding: 0; line-height: 1; opacity: 0.8;
      }
      .import-close-btn:hover { opacity: 1; }
      .import-dropzone-area {
        margin: 24px; padding: 40px 20px; border: 2px dashed #d0d5dd;
        border-radius: 12px; text-align: center; cursor: pointer;
        transition: all 0.3s ease; background: #fafbff;
      }
      .import-dropzone-area.drag-over {
        border-color: #667eea; background: #f0f0ff;
        transform: scale(1.02); box-shadow: 0 4px 20px rgba(102,126,234,0.15);
      }
      .import-dropzone-icon { margin-bottom: 12px; }
      .import-dropzone-text {
        font-size: 14px; color: #344054; margin: 8px 0;
      }
      .import-browse-label {
        color: #667eea; font-weight: 600; cursor: pointer;
        text-decoration: underline;
      }
      .import-browse-label:hover { color: #764ba2; }
      .import-dropzone-hint {
        font-size: 12px; color: #98a2b3; margin: 4px 0 0;
      }
      .import-progress {
        margin: 0 24px; padding: 16px; background: #f9fafb;
        border-radius: 8px;
      }
      .import-progress-bar {
        height: 6px; background: #e5e7eb; border-radius: 3px;
        overflow: hidden; margin-bottom: 8px;
      }
      .import-progress-fill {
        height: 100%; background: linear-gradient(90deg, #667eea, #764ba2);
        border-radius: 3px; transition: width 0.3s ease; width: 0%;
      }
      .import-progress p { margin: 0; font-size: 13px; color: #667eea; }
      .import-result {
        margin: 0 24px; padding: 16px; border-radius: 8px;
        font-size: 13px;
      }
      .import-result.success { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
      .import-result.error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
      .import-result.warning { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
      .import-actions {
        display: flex; gap: 10px; padding: 16px 24px;
        border-top: 1px solid #eee; background: #f9fafb;
      }
      .import-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 8px 16px; border-radius: 8px; font-size: 13px;
        cursor: pointer; border: 1px solid #d0d5dd; background: white;
        color: #344054; transition: all 0.2s;
      }
      .import-btn:hover { background: #f0f0ff; border-color: #667eea; color: #667eea; }
      .import-btn-template svg { flex-shrink: 0; }
      .mapping-section {
        margin: 0 24px 16px; max-height: 50vh; overflow-y: auto;
      }
      .mapping-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .mapping-table th {
        background: #f5f6fa; padding: 10px 12px; text-align: left;
        font-weight: 600; color: #555; border-bottom: 2px solid #eee;
        position: sticky; top: 0; z-index: 1;
      }
      .mapping-table td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; }
      .mapping-table tr.unmatched { background: #fff8f0; }
      .mapping-table select {
        padding: 5px 8px; border: 1px solid #ddd; border-radius: 4px;
        font-size: 13px; background: white; min-width: 130px;
      }
      .mapping-table select:focus { border-color: #667eea; outline: none; }
      .mapping-match-badge {
        display: inline-block; padding: 2px 8px; border-radius: 10px;
        font-size: 11px; font-weight: 600;
      }
      .mapping-match-badge.matched { background: #d4edda; color: #155724; }
      .mapping-match-badge.unmatched { background: #fff3cd; color: #856404; }
      .mapping-preview { margin: 0 24px 12px; }
      .mapping-preview h4 { font-size: 13px; color: #555; margin-bottom: 8px; }
      .mapping-preview-table {
        width: 100%; border-collapse: collapse; font-size: 12px;
        max-height: 120px; overflow: auto; display: block;
      }
      .mapping-preview-table th, .mapping-preview-table td {
        padding: 4px 8px; border: 1px solid #eee; white-space: nowrap;
      }
      .mapping-preview-table th { background: #f5f6fa; font-weight: 500; }
    `;
    document.head.appendChild(style);
  },

  init(containerId, tableName, onSuccess) {
    this.currentTable = tableName;
    this._defaultTable = tableName;
    this.onSuccessCallback = onSuccess;
    this._injectStyle();

    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = `
      <div class="import-dropzone-overlay" id="importOverlay" style="display:none;">
        <div class="import-dropzone-modal" id="importModal">
          <div class="import-dropzone-header">
            <h3>批量导入${this.getTableLabel(tableName)}</h3>
            <button class="import-close-btn" onclick="ImportDropzone.close()">&times;</button>
          </div>
          <div id="dropzoneContent">
            <div class="import-dropzone-area" id="dropZone"
                 ondragover="ImportDropzone.handleDragOver(event)"
                 ondragleave="ImportDropzone.handleDragLeave(event)"
                 ondrop="ImportDropzone.handleDrop(event)">
              <div class="import-dropzone-icon">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#667eea" stroke-width="1.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <p class="import-dropzone-text">将文件拖拽到此处，或 <label class="import-browse-label">点击选择文件<input type="file" id="fileInput" accept=".xlsx,.xls,.csv,.tsv,.ods" style="display:none;" onchange="ImportDropzone.handleFileSelect(event)" multiple></label></p>
              <p class="import-dropzone-hint">支持 Excel(.xlsx/.xls)、CSV(.csv)、TSV(.tsv)、ODS(.ods) 格式，单文件最大10MB</p>
            </div>
          </div>
          <div id="mappingContent" style="display:none;"></div>
          <div class="import-progress" id="importProgress" style="display:none;">
            <div class="import-progress-bar"><div class="import-progress-fill" id="progressFill"></div></div>
            <p id="progressText">正在导入...</p>
          </div>
          <div class="import-result" id="importResult" style="display:none;"></div>
          <div class="import-actions" id="importActions">
            <button class="import-btn import-btn-template" onclick="ImportDropzone.downloadTemplate('xlsx')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              下载Excel模板
            </button>
            <button class="import-btn import-btn-template" onclick="ImportDropzone.downloadTemplate('csv')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              下载CSV模板
            </button>
          </div>
        </div>
      </div>
    `;
  },

  getTableLabel(tableName) {
    const labels = { inquiries: '询价单', inquiry_pricing: '报价库信息', customers: '客户', products: '产品', materials: '物料', bom_pricing: '核价', projects: '研发项目', project_progress: '项目进度', project_supply_issues: '品质异常', project_sales_promotion: '推广进度', project_reviews: '项目复盘', project_initiation: '立项申请书', expenses: '费用', labor: '人工', product_labor_rate: '成品工价' };
    return labels[tableName] || tableName;
  },

  // 字段映射（中文表头 → 数据库字段），用于前端自动匹配
  getFieldMappings() {
    return {
      inquiries: [
        ['询价单号','serial_number'],['单号','serial_number'],['客户名称','customer_name'],['客户','customer_name'],
        ['客户来源','customer_source'],['来源','customer_source'],['销售员','sales_person'],['销售','sales_person'],['负责人','sales_person'],
        ['询价时间','inquiry_time'],['交货日期','delivery_date'],['交期','delivery_date'],
        ['外部型号','external_model'],['产品型号','external_model'],['型号','external_model'],['内部型号','internal_model'],
        ['产品品类','product_category'],['品类','product_category'],['功率','power'],['配置','configuration'],['数量','quantity'],
        ['定制要求','custom_requirements'],['特殊工艺','special_process'],['备注','remarks'],
        ['报价有效期','quote_validity'],['状态','status'],['物料成本','material_cost'],['加工成本','process_cost'],
        ['辅料成本','accessory_cost'],['预计损耗','estimated_loss'],['基础成本','base_cost'],
        ['利润率','profit_rate'],['优惠率','discount_rate'],['最终报价','final_price'],['报价','final_price'],['流失原因','lost_reason']
      ],
      inquiry_pricing: [
        ['询价单号','serial_number'],['单号','serial_number'],['询价号','serial_number'],['询价编号','serial_number'],
        ['物料成本','material_cost'],['材料成本','material_cost'],
        ['加工成本','process_cost'],['加工费','process_cost'],['工艺成本','process_cost'],['工艺费','process_cost'],
        ['辅料成本','accessory_cost'],['配件费','accessory_cost'],['配件成本','accessory_cost'],
        ['预计损耗','estimated_loss'],['损耗','estimated_loss'],
        ['基础成本','base_cost'],['成本合计','base_cost'],['合计成本','base_cost'],['总成本','base_cost'],
        ['利润率','profit_rate'],['利润','profit_rate'],
        ['优惠率','discount_rate'],['折扣率','discount_rate'],['折扣','discount_rate'],
        ['最终报价','final_price'],['报价','final_price'],['金额','final_price'],['人民币报价','final_price'],['报价(RMB)','final_price'],
        ['美元报价','quoted_price_usd'],['报价(USD)','quoted_price_usd'],['报价USD','quoted_price_usd'],['美金报价','quoted_price_usd']
      ],
      customers: [
        ['客户编号','customer_code'],['编号','customer_code'],['序号','customer_code'],['展位号','customer_code'],['展商编号','customer_code'],
        ['客户全称','name'],['客户名称','name'],['客户','name'],['名称','name'],['公司名称','name'],['公司','name'],['企业名称','name'],['客户名','name'],['参展商','name'],
        ['客户曾用名','former_name'],['曾用名','former_name'],['母公司编号','parent_code'],
        ['决策人姓名','decision_maker'],['决策人','decision_maker'],['决策人职位','decision_maker_position'],['决策核心诉求','decision_core_need'],
        ['普通对接人','contact_person'],['联系人','contact_person'],['对接人','contact_person'],['联系人姓名','contact_person'],['客户联系人','contact_person'],['业务联系人','contact_person'],
        ['对接人职位','contact_position'],['职位','contact_position'],['职务','contact_position'],
        ['联系电话(含区号)','phone'],['联系电话','phone'],['电话','phone'],['手机','phone'],['手机号','phone'],['联系方式','phone'],['电话号码','phone'],['座机','phone'],['固话','phone'],['Tel','phone'],['Phone','phone'],['Mobile','phone'],
        ['对接邮箱','email'],['邮箱','email'],['电子邮件','email'],['电子邮箱','email'],['客户邮箱','email'],['E-mail','email'],['EMAIL','email'],['Email','email'],['Mail','email'],
        ['微信号','wechat'],['微信','wechat'],['WeChat','wechat'],
        ['WhatsApp','whatsapp'],['Whatsapp','whatsapp'],['WA','whatsapp'],
        ['Skype','skype'],['skype','skype'],['QQ','other_im'],['QQ号','other_im'],['其他即时联系方式','other_im'],
        ['客户等级','customer_level'],['等级','customer_level'],
        ['销售模式','sales_mode'],['模式','sales_mode'],
        ['客户状态','customer_status'],['状态','customer_status'],['合作状态','customer_status'],
        ['所属业务员','sales_person'],['销售员','sales_person'],['销售','sales_person'],['负责人','sales_person'],['业务员','sales_person'],['业务代表','sales_person'],
        ['最后交易年份','last_trade_year'],['交易年份','last_trade_year'],
        ['开票抬头','invoice_title'],['抬头','invoice_title'],
        ['纳税人识别号','tax_id'],['统一社会信用代码','tax_id'],['信用代码','tax_id'],['税号','tax_id'],
        ['开户银行','bank_name'],['银行','bank_name'],['开户行','bank_name'],
        ['银行账号','bank_account'],['账号','bank_account'],
        ['地址','address'],['详细地址','address'],['通讯地址','address'],['公司地址','address'],
        ['国家','country_region'],['国家/地区','country_region'],['地区','country_region'],['国家地区','country_region'],['所在地区','country_region'],['省份','country_region'],['城市','country_region'],
        ['客户来源','customer_source'],['来源','customer_source'],['信息来源','customer_source'],['获客渠道','customer_source'],
        ['备注说明','remarks'],['备注','remarks'],['说明','remarks'],['跟进备注','remarks']
      ],
      products: [
        ['产品名称','name'],['名称','name'],['外部型号','external_model'],['产品型号','external_model'],['型号','external_model'],
        ['内部型号','internal_model'],['品类','category'],['产品品类','category'],['类别','category'],
        ['功率','power'],['配置','configuration'],['单位','unit'],['状态','status'],['备注','remarks']
      ],
      materials: [
        ['物料名称','material_name'],['名称','material_name'],['物料编码','material_code'],['编码','material_code'],['物料编号','material_code'],
        ['分类','category'],['物料分类','category'],['规格参数','specs'],['规格','specs'],
        ['材质','material_type'],['材料','material_type'],['单位','unit'],['标准成本','standard_cost'],['成本','standard_cost'],
        ['加工费','processing_cost'],['加工损耗','processing_loss'],['损耗','processing_loss'],
        ['供应商','supplier'],['状态','status'],['物料状态','status'],['证书要求','certificate_required'],['单价','unit_price'],['价格','unit_price'],
        ['数量','quantity'],['库存数量','inventory_qty'],['库存','inventory_qty'],
        ['最低库存','min_inventory'],['月用量','monthly_usage'],
        ['总价','total_amount'],['金额','total_amount'],['小计','total_amount'],
        ['入库时间','stock_date'],['入库日期','stock_date'],['日期','stock_date'],
        ['备注','remarks']
      ],
      bom_pricing: [
        ['客户编号','customer'],['客户','customer'],['询价单号','inquiry_no'],['产品型号','model'],['型号','model'],
        ['产品名称','product_name'],['名称','product_name'],['功率','power'],['产品系列','product_series'],['系列','product_series'],
        ['证书合规','certificate_compliant'],['证书是否符合标准','certificate_compliant'],['证书等级','certificate_level'],
        ['套件','kit'],['电缆线','cable'],['光源','light_source'],['驱动','driver'],['电池','battery'],['支架','bracket'],
        ['开关','switch_type'],['太阳能板','solar_panel'],['插座','socket'],['盒子','box'],['说明书','manual'],['包装','packaging'],
        ['配件','accessories'],['人工','labor'],['合计成本','total_cost'],['成本合计','total_cost'],
        ['人工加工费','labor_cost'],['加工费','labor_cost'],['工艺成本','process_cost'],['工艺费','process_cost'],
        ['预估损耗','estimated_loss'],['损耗','estimated_loss'],['最低限价','min_price'],['限价','min_price'],
        ['核价人','pricer'],['核价链接','pricing_link'],['报价(RMB)','price_rmb'],['报价RMB','price_rmb'],['人民币报价','price_rmb'],
        ['报价(USD)','price_usd'],['报价USD','price_usd'],['美元报价','price_usd'],['目标价','target_price'],
        ['核价版本','pricing_version'],['版本','pricing_version'],['备注','remarks']
      ],
      product_labor_rate: [
        ['BOM编号','bom_no'],['BOM','bom_no'],['bom_no','bom_no'],['编号','bom_no'],
        ['产品编码','product_code'],['编码','product_code'],
        ['产品名称','product_name'],['名称','product_name'],
        ['工价(元/台)','labor_rate'],['工价','labor_rate'],['单台工价','labor_rate'],['成品工价','labor_rate'],
        ['计价方式','labor_rate_type'],['工价类型','labor_rate_type'],['类型','labor_rate_type'],
        ['工艺成本','process_cost'],
        ['生效日','effective_date'],['生效日期','effective_date'],
        ['失效日','expire_date'],['失效日期','expire_date'],
        ['来源','source'],['数据来源','source'],
        ['审核状态','audit_status'],['状态','audit_status'],
        ['审核人','approved_by'],
        ['备注','remarks'],['说明','remarks']
      ],
      expenses: [
        ['费用编码','expense_code'],['编码','expense_code'],['编号','expense_code'],
        ['费用名称','expense_name'],['名称','expense_name'],['摘要','expense_name'],
        ['费用大类','expense_category'],['大类','expense_category'],['费用类别','expense_category'],
        ['费用细类','expense_type'],['细类','expense_type'],['子类','expense_type'],
        ['所属部门','department'],['部门','department'],
        ['关联项目','project'],['项目','project'],
        ['收款方','payee'],['供应商','supplier'],
        ['发生日期','occur_date'],['日期','occur_date'],
        ['归属账期','account_period'],['账期','account_period'],['月份','account_period'],
        ['金额','amount'],
        ['税率','tax_rate'],['税额','tax_amount'],
        ['价税合计','total_amount'],['合计','total_amount'],['含税金额','total_amount'],
        ['币种','currency'],
        ['支付方式','payment_method'],
        ['支付状态','payment_status'],
        ['经办人','payee'],['报销人','payee'],
        ['发票号','invoice_no'],['发票号码','invoice_no'],
        ['发票类型','invoice_type'],
        ['数据来源','source'],['来源','source'],
        ['备注','remarks'],['说明','remarks']
      ],
      labor: [
        ['人工编码','labor_code'],['编码','labor_code'],
        ['员工姓名','employee_name'],['姓名','employee_name'],['人员','employee_name'],
        ['工号','employee_no'],['员工编号','employee_no'],
        ['部门','department'],['岗位','position'],['职务','position'],
        ['人工类型','labor_type'],['类型','labor_type'],['计薪方式','labor_type'],
        ['工作日期','work_date'],['日期','work_date'],
        ['归属月份','work_month'],['月份','work_month'],
        ['工时','hours'],['加班工时','overtime_hours'],
        ['件数','pieces'],['单价','unit_price'],['时薪','unit_price'],
        ['基本工资','base_amount'],['底薪','base_amount'],
        ['加班费','overtime_pay'],['补贴','subsidy'],['奖金','bonus'],
        ['社保','social_insurance'],['公积金','housing_fund'],
        ['合计金额','total_amount'],['合计','total_amount'],
        ['关联项目','project'],['项目','project'],
        ['数据来源','source'],['来源','source'],
        ['备注','remarks']
      ],
      projects: [
        ['项目编号','project_no'],['编号','project_no'],['项目名称','project_name'],['名称','project_name'],
        ['客户名称','customer_name'],['客户','customer_name'],['项目类型','project_type'],['类型','project_type'],
        ['项目等级','project_level'],['等级','project_level'],['紧急程度','urgency'],
        ['负责人','owner'],['项目负责人','owner'],['责任单位','department'],['部门','department'],
        ['立项时间','start_date'],['开始日期','start_date'],['目标时间','target_date'],['目标日期','target_date'],
        ['结案时间','close_date'],['结束日期','close_date'],['目前阶段','current_stage'],['阶段','current_stage'],
        ['进度情况','progress_note'],['进度','progress_note'],['投入金额','invest_amount'],['投入','invest_amount'],
        ['订单金额','order_amount'],['订单','order_amount'],['年订单','annual_order'],
        ['上市时间','market_date'],['上市日期','market_date'],['状态','status'],
        ['稽核状态','audit_status'],['稽核','audit_status'],['甘特图链接','gantt_link'],['资料链接','doc_link'],['备注','remarks']
      ],
      project_progress: [
        ['项目编号','project_no'],['编号','project_no'],['项目名称','project_name'],['名称','project_name'],
        ['计划表','plan'],['BOM','bom'],['规格书','spec'],['配置表','config'],
        ['模具图纸','mold_drawing'],['开模评审','mold_review'],['手样','hand_sample'],
        ['模具','mold'],['模样','mold_sample'],['包装设计','packaging'],
        ['电试','elec_trial'],['研试','rd_trial'],['工试','eng_trial'],
        ['生试','prod_trial'],['测试报告','test_report'],['技转','tech_transfer'],
        ['出货','shipment'],['复盘','review'],['其他','other']
      ],
      project_supply_issues: [
        ['发生日期','occur_date'],['日期','occur_date'],['提出人','proposer'],
        ['产品名称','product_name'],['产品','product_name'],['单号','order_no'],
        ['项目号','project_no'],['项目编号','project_no'],['问题描述','problem_desc'],['描述','problem_desc'],
        ['临时措施','temp_measure'],['原因分析','cause_analysis'],['长期措施','long_term_measure'],
        ['长期措施完成时间','long_term_date'],['责任人','responsible_person'],['责任部门','responsible_dept'],['部门','responsible_dept'],
        ['计划完成时间','plan_complete_date'],['计划完成','plan_complete_date'],['稽核','audit'],['闭环','closed'],['备注','remarks']
      ],
      project_sales_promotion: [
        ['产品型号','product_model'],['型号','product_model'],['业务员','salesperson'],['销售','salesperson'],
        ['客户','customer'],['外观','appearance'],['外观反馈','appearance'],
        ['价格','price'],['价格反馈','price'],['性能','performance'],['性能反馈','performance'],
        ['功能','function_feedback'],['功能反馈','function_feedback'],['目前进度','progress'],['进度','progress'],['备注','remarks']
      ],
      project_reviews: [
        ['项目编号','project_no'],['编号','project_no'],['项目名称','project_name'],['名称','project_name'],
        ['回顾目标','goal_original'],['当初目的','goal_original'],['里程碑','goal_milestone'],['回顾目标-里程碑','goal_milestone'],
        ['Highlights','result_highlights'],['评估结果-Highlights','result_highlights'],
        ['Lowlights','result_lowlights'],['评估结果-Lowlights','result_lowlights'],
        ['评估结果-实际','result_actual'],['实际','result_actual'],['成功因素','success_factors'],['成功关键因素','success_factors'],
        ['失败原因','failure_causes'],['失败根本原因','failure_causes'],['总结规律','insights'],['经验规律','experience'],
        ['行动计划','action_plan'],['备注','remarks']


      ],
      project_initiation: [
        ['项目编号','project_no'],['编号','project_no'],['项目名称','project_name'],['名称','project_name'],
        ['项目类型','project_type'],['类型','project_type'],['起始时间','start_date'],['部门','department'],
        ['主要负责人','owner'],['负责人','owner'],['配合人员','cooperators'],
        ['客户编号','customer_no'],['客户类型','customer_type'],['客户等级','customer_level'],
        ['客户赢率','customer_win_rate'],['市场状况','market_status'],['客户痛点识别','customer_pain'],
        ['关键成功要素','key_success'],['竞争对手','has_competitor'],['采购周期','purchase_cycle'],
        ['定制开发类型','dev_type'],
        ['产品规格','product_specs'],['可实现性评估','feasibility'],
        ['销售预测','sales_forecast'],['特殊要求','special_reqs'],
        ['申请人','applicant'],['申请日期','apply_date'],['审批状态','approval_status'],
        ['审批人','approver'],['审批日期','approval_date'],['审批意见','approval_opinion'],
        ['备注','remarks']

      ]
    }[this.currentTable] || [];
  },

  // 数据库字段 → 中文标签（用于映射下拉框显示，便于用户理解）
  getFieldLabels() {
    const common = { remarks: '备注', status: '状态', name: '名称' };
    const labels = {
      customers: {
        customer_code:'客户编号', name:'客户全称/名称', former_name:'客户曾用名', parent_code:'母公司编号',
        decision_maker:'决策人姓名', decision_maker_position:'决策人职位', decision_core_need:'决策核心诉求',
        contact_person:'普通对接人/联系人', contact_position:'对接人职位',
        phone:'联系电话', email:'对接邮箱', wechat:'微信号', whatsapp:'WhatsApp', skype:'Skype', other_im:'其他即时联系方式',
        customer_level:'客户等级', sales_mode:'销售模式', customer_status:'客户状态', sales_person:'所属业务员',
        last_trade_year:'最后交易年份', invoice_title:'开票抬头', tax_id:'纳税人识别号', bank_name:'开户银行', bank_account:'银行账号',
        address:'地址', country_region:'国家/地区', customer_source:'客户来源', remarks:'备注说明'
      },
      inquiries: {
        serial_number:'询价单号', customer_name:'客户名称', customer_source:'客户来源', country_region:'国家/地区',
        sales_person:'销售员', inquiry_time:'询价时间', delivery_date:'交货日期',
        external_model:'外部型号', internal_model:'内部型号', product_category:'产品品类', power:'功率',
        configuration:'配置', quantity:'数量', custom_requirements:'定制要求', special_process:'特殊工艺',
        quote_validity:'报价有效期', material_cost:'物料成本', process_cost:'加工成本', accessory_cost:'辅料成本',
        estimated_loss:'预计损耗', base_cost:'基础成本', profit_rate:'利润率', discount_rate:'优惠率',
        final_price:'最终报价', lost_reason:'流失原因', remarks:'备注', status:'状态'
      },
      inquiry_pricing: {
        serial_number:'询价单号(匹配键)', material_cost:'物料成本', process_cost:'加工费/工艺成本',
        accessory_cost:'配件费/辅料成本', estimated_loss:'预计损耗', base_cost:'成本合计/基础成本',
        profit_rate:'利润率(>1自动转小数)', discount_rate:'优惠率/折扣率',
        final_price:'最终报价(RMB)', quoted_price_usd:'美元报价(USD)'
      },
      products: {
        name:'产品名称', external_model:'外部型号', internal_model:'内部型号', category:'品类',
        power:'功率', configuration:'配置', unit:'单位', status:'状态', remarks:'备注'
      },
      materials: {
        material_name:'物料名称', material_code:'物料编码', category:'分类', specs:'规格参数',
        material_type:'材质', unit:'单位', standard_cost:'标准成本', processing_cost:'加工费',
        processing_loss:'加工损耗', supplier:'供应商', status:'状态', certificate_required:'证书要求',
        product_id:'产品ID', unit_price:'单价', quantity:'数量', inventory_qty:'库存数量',
        min_inventory:'最低库存', monthly_usage:'月用量', total_amount:'总价', stock_date:'入库时间', remarks:'备注'
      },
      bom_pricing: {
        customer:'客户', inquiry_no:'询价单号', model:'产品型号', product_name:'产品名称', power:'功率',
        product_series:'产品系列', certificate_compliant:'证书合规', certificate_level:'证书等级',
        kit:'套件', cable:'电缆线', light_source:'光源', driver:'驱动', battery:'电池', bracket:'支架',
        switch_type:'开关', solar_panel:'太阳能板', socket:'插座', box:'盒子', manual:'说明书', packaging:'包装',
        accessories:'配件', labor:'人工', total_cost:'合计成本', labor_cost:'人工加工费', process_cost:'工艺成本',
        estimated_loss:'预估损耗', min_price:'最低限价', pricer:'核价人', pricing_link:'核价链接',
        price_rmb:'报价(RMB)', price_usd:'报价(USD)', target_price:'目标价', pricing_version:'核价版本', remarks:'备注'
      },
      projects: {
        project_no:'项目编号', project_name:'项目名称', customer_name:'客户名称', project_type:'项目类型',
        project_level:'项目等级', urgency:'紧急程度', owner:'负责人', department:'责任单位',
        start_date:'立项时间', target_date:'目标时间', close_date:'结案时间', current_stage:'目前阶段',
        progress_note:'进度情况', invest_amount:'投入金额', order_amount:'订单金额', annual_order:'年订单',
        market_date:'上市时间', status:'状态', audit_status:'稽核状态', gantt_link:'甘特图链接',
        doc_link:'资料链接', remarks:'备注'
      },
      project_progress: { project_no:'项目编号', project_name:'项目名称', plan:'计划表', bom:'BOM', spec:'规格书', config:'配置表', mold_drawing:'模具图纸', mold_review:'开模评审', hand_sample:'手样', mold:'模具', mold_sample:'模样', packaging:'包装设计', elec_trial:'电试', rd_trial:'研试', eng_trial:'工试', prod_trial:'生试', test_report:'测试报告', tech_transfer:'技转', shipment:'出货', review:'复盘', other:'其他' },
      project_supply_issues: { occur_date:'发生日期', proposer:'提出人', product_name:'产品名称', order_no:'单号', project_no:'项目号', problem_desc:'问题描述', temp_measure:'临时措施', cause_analysis:'原因分析', long_term_measure:'长期措施', long_term_date:'长期措施完成时间', responsible_person:'责任人', responsible_dept:'责任部门', plan_complete_date:'计划完成时间', audit:'稽核', closed:'闭环', remarks:'备注' },
      project_sales_promotion: { product_model:'产品型号', salesperson:'业务员', customer:'客户', appearance:'外观', price:'价格', performance:'性能', function_feedback:'功能', progress:'目前进度', remarks:'备注' },
      project_reviews: { project_no:'项目编号', project_name:'项目名称', goal_original:'回顾目标', goal_milestone:'里程碑', result_highlights:'Highlights', result_lowlights:'Lowlights', result_actual:'评估结果-实际', success_factors:'成功因素', failure_causes:'失败原因', insights:'总结规律', experience:'经验规律', action_plan:'行动计划', remarks:'备注' },
      project_initiation: { project_no:'项目编号', project_name:'项目名称', background:'立项背景', necessity:'必要性分析', market_analysis:'市场分析', rd_objectives:'研发目标', rd_content:'研发内容', key_innovation:'关键技术', tech_solution:'技术方案', tech_route:'技术路线', plan_summary:'研发计划概述', milestones:'关键里程碑', expected_outcome:'预期成果', economic_benefit:'经济效益', target_market:'目标市场', budget_total:'预算总额', budget_detail:'预算明细', team_requirement:'团队需求', risk_analysis:'风险分析', risk_measures:'风险对策', applicant:'申请人', apply_date:'申请日期', approval_status:'审批状态', approver:'审批人', approval_date:'审批日期', approval_opinion:'审批意见', remarks:'备注' }
    };
    return labels[this.currentTable] || common;
  },

  // HTML转义（防止表头含特殊字符破坏映射界面）
  escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },

  open() {
    const overlay = document.getElementById('importOverlay');
    if (!overlay) return;
    this._customEndpoint = null;
    this._resetModal();
    overlay.style.display = 'flex';
  },

  // 报价库信息批量回填询价单（按询价单号匹配，走专用接口）
  openForPricingImport(callback) {
    this.currentTable = 'inquiry_pricing';
    this._syncMode = false;
    if (callback) this.onSuccessCallback = callback;
    this.open();
    this._customEndpoint = '/inquiries/import-pricing';
  },

  // 指定子表导入
  openForTable(tableName, callback) {
    this.currentTable = tableName;
    if (callback) this.onSuccessCallback = callback;
    this._syncMode = false;
    this.open();
  },

  // 库存同步模式（更新已有物料）
  openForSync(callback) {
    this.currentTable = 'materials';
    if (callback) this.onSuccessCallback = callback;
    this._syncMode = true;
    this.open();
  },

  _resetModal() {
    document.getElementById('dropzoneContent').style.display = 'block';
    const mc = document.getElementById('mappingContent');
    if (mc) { mc.style.display = 'none'; mc.innerHTML = ''; }
    const progress = document.getElementById('importProgress');
    const result = document.getElementById('importResult');
    if (progress) progress.style.display = 'none';
    if (result) result.style.display = 'none';
    document.getElementById('importActions').style.display = 'flex';
    this._pendingFiles = null;
  },

  close() {
    const overlay = document.getElementById('importOverlay');
    if (overlay) overlay.style.display = 'none';
    this._pendingFiles = null;
    this._customEndpoint = null;
    if (this._defaultTable) this.currentTable = this._defaultTable;
  },

  handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    const dz = document.getElementById('dropZone');
    if (dz) dz.classList.add('drag-over');
  },

  handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    const dz = document.getElementById('dropZone');
    if (dz) dz.classList.remove('drag-over');
  },

  handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const dz = document.getElementById('dropZone');
    if (dz) dz.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      this.prepareImport(files);
    }
  },

  handleFileSelect(e) {
    const files = e.target.files;
    if (files.length > 0) {
      this.prepareImport(files);
    }
    e.target.value = '';
  },

  // ===== 第一步：读取文件，解析表头和数据预览，显示映射界面 =====
  async prepareImport(files) {
    const validExts = ['.xlsx', '.xls', '.csv', '.tsv', '.ods'];
    const validFiles = Array.from(files).filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      return validExts.includes(ext);
    });

    if (validFiles.length === 0) {
      const resultDiv = document.getElementById('importResult');
      resultDiv.style.display = 'block';
      resultDiv.className = 'import-result error';
      resultDiv.innerHTML = '没有有效的文件格式，请上传 Excel(.xlsx/.xls)、CSV(.csv)、TSV(.tsv) 或 ODS(.ods) 文件';
      return;
    }

    this._pendingFiles = validFiles;

    const file = validFiles[0];
    const ext = '.' + file.name.split('.').pop().toLowerCase();

    try {
      const { headers, previewRows, totalRows, sampleRows } = await this.parseHeadersAndPreview(file, ext);
      this.showMappingUI(file.name, headers, previewRows, totalRows, sampleRows);
    } catch (e) {
      const resultDiv = document.getElementById('importResult');
      resultDiv.style.display = 'block';
      resultDiv.className = 'import-result error';
      resultDiv.innerHTML = '文件解析失败: ' + e.message;
    }
  },

  // 解析文件表头 + 前3行预览
  async parseHeadersAndPreview(file, ext) {
    if (ext === '.csv' || ext === '.tsv') {
      return await this.parseCsvData(file, ext === '.tsv' ? '\t' : ',');
    } else {
      return await this.parseExcelData(file);
    }
  },

  // 解析CSV（表头+预览行）
  parseCsvData(file, separator) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function(e) {
        const text = e.target.result.replace(/^\uFEFF/, '');
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length === 0) { reject(new Error('文件为空')); return; }
        const headers = lines[0].split(separator).map(h => h.replace(/^"|"$/g, '').trim());
        const previewRows = [];
        for (let i = 1; i < Math.min(lines.length, 4); i++) {
          previewRows.push(lines[i].split(separator).map(c => c.replace(/^"|"$/g, '').trim()));
        }
        const sampleRows = [];
        for (let i = 1; i < Math.min(lines.length, 61); i++) {
          sampleRows.push(lines[i].split(separator).map(c => c.replace(/^"|"$/g, '').trim()));
        }
        resolve({ headers, previewRows, totalRows: lines.length - 1, sampleRows });
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsText(file, 'UTF-8');
    });
  },

  // 解析Excel（表头+预览行）
  async parseExcelData(file) {
    const XLSX = await this.loadXlsxLib();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          if (data.length === 0) { reject(new Error('文件中没有数据')); return; }
          const headers = data[0].map(h => String(h).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, ''));
          const previewRows = data.slice(1, 4).map(row =>
            row.map(c => c !== undefined && c !== null ? String(c).trim() : '')
          );
          const sampleRows = data.slice(1, 61).map(row =>
            row.map(c => c !== undefined && c !== null ? String(c).trim() : '')
          );
          resolve({ headers, previewRows, totalRows: data.length - 1, sampleRows });
        } catch (err) { reject(new Error('Excel解析失败: ' + err.message)); }
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsArrayBuffer(file);
    });
  },

  // 加载XLSX库
  loadXlsxLib() {
    if (this._xlsxLib) return Promise.resolve(this._xlsxLib);
    if (typeof XLSX !== 'undefined') { this._xlsxLib = XLSX; return Promise.resolve(XLSX); }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.onload = () => { this._xlsxLib = window.XLSX; resolve(window.XLSX); };
      script.onerror = () => reject(new Error('XLSX库加载失败'));
      document.head.appendChild(script);
    });
  },

  // ===== 第二步：显示表头映射界面 + 数据预览 =====
  showMappingUI(fileName, headers, previewRows, totalRows, sampleRows) {
    // 表头匹配 + 内容兜底识别（询价单/客户模块）
    const { result: matchedMap, allDbFields } = this._matchHeaders(this.currentTable, headers, sampleRows || []);
    const unmatchedHeaders = headers.filter(h => !matchedMap[h].field);
    const contentMatchedCount = headers.filter(h => matchedMap[h].source === 'content').length;

    // 构建映射表HTML（含数据预览）
    let mappingHtml = `
      <div class="mapping-section">
        <p style="font-size:13px;color:#555;margin-bottom:8px;">
          文件: <strong>${fileName}</strong> &nbsp;|&nbsp;
          共 <strong>${headers.length}</strong> 列，<strong>${totalRows}</strong> 行数据 &nbsp;|&nbsp;
          自动匹配 <strong>${headers.length - unmatchedHeaders.length}</strong> 列，
          未匹配 <strong>${unmatchedHeaders.length}</strong> 列${contentMatchedCount > 0 ? `（其中 <strong>${contentMatchedCount}</strong> 列由内容智能识别）` : ''}
        </p>
        <div style="max-height:25vh;overflow-y:auto;margin-bottom:12px;">
        <table class="mapping-table">
          <thead><tr>
            <th>文件表头</th><th style="width:160px;">→ 对应字段</th><th>匹配状态</th>
          </tr></thead>
          <tbody>`;

    headers.forEach(h => {
      const m = matchedMap[h];
      const isMatched = !!m.field;
      const rowClass = isMatched ? '' : 'unmatched';
      let badge;
      if (!isMatched) {
        badge = '<span class="mapping-match-badge unmatched">! 未匹配</span>';
      } else if (m.source === 'content') {
        badge = '<span class="mapping-match-badge" style="background:#e0e7ff;color:#3730a3;">✦ 内容识别</span>';
      } else {
        badge = '<span class="mapping-match-badge matched">√ 已匹配</span>';
      }

      const labels = this.getFieldLabels();
      const fieldOpts = allDbFields.map(f => {
        const label = labels[f] ? `${labels[f]}（${f}）` : f;
        return `<option value="${f}" ${m.field === f ? 'selected' : ''}>${label}</option>`;
      }).join('');
      const selectHtml = `<select class="mapping-field-select" data-header="${this.escHtml(h)}">
        <option value="">-- 跳过 --</option>
        ${fieldOpts}
      </select>`;

      mappingHtml += `<tr class="${rowClass}">
        <td><b>${this.escHtml(h)}</b></td>
        <td>${selectHtml}</td>
        <td>${badge}</td>
      </tr>`;
    });

    mappingHtml += `</tbody></table></div>`;

    // 数据预览：只显示已匹配列的前3行
    if (previewRows.length > 0) {
      const matchedHeaders = headers.filter(h => matchedMap[h].field);
      const labels = this.getFieldLabels();
      if (matchedHeaders.length > 0) {
        mappingHtml += `
        <div style="margin:0 24px 12px;">
          <h4 style="font-size:13px;color:#555;margin-bottom:6px;">数据预览（前 ${Math.min(previewRows.length,3)} 行，仅显示已匹配的 ${matchedHeaders.length} 列）</h4>
          <div style="max-height:18vh;overflow:auto;border:1px solid #eee;border-radius:6px;">
          <table class="mapping-table" style="font-size:12px;">
            <thead><tr>
              ${matchedHeaders.map(h => `<th>${this.escHtml(h)}<br><span style="font-weight:400;color:#667eea;font-size:10px;">→ ${labels[matchedMap[h].field] || matchedMap[h].field}</span></th>`).join('')}
            </tr></thead>
            <tbody>`;
        const previewCount = Math.min(previewRows.length, 3);
        for (let r = 0; r < previewCount; r++) {
          const row = previewRows[r] || [];
          mappingHtml += '<tr>';
          headers.forEach((h, idx) => {
            if (matchedMap[h].field) {
              mappingHtml += `<td>${this.escHtml(row[idx] || '')}</td>`;
            }
          });
          mappingHtml += '</tr>';
        }
        mappingHtml += `</tbody></table></div></div>`;
      }
    }
    mappingHtml += `</div>`;

    // 操作按钮
    mappingHtml += `
      <div class="import-actions" style="border-top:none;">
        <button class="import-btn" onclick="ImportDropzone.backToDropzone()">← 返回重选文件</button>
        <button class="import-btn" style="background:#667eea;color:white;border-color:#667eea;margin-left:auto;"
                onclick="ImportDropzone.confirmImport()">确认导入</button>
      </div>`;

    // 切换到映射界面
    document.getElementById('importModal').classList.add('wide');
    document.getElementById('dropzoneContent').style.display = 'none';
    document.getElementById('importActions').style.display = 'none';
    document.getElementById('importResult').style.display = 'none';
    const mc = document.getElementById('mappingContent');
    mc.innerHTML = mappingHtml;
    mc.style.display = 'block';
  },

  backToDropzone() {
    document.getElementById('importModal').classList.remove('wide');
    document.getElementById('dropzoneContent').style.display = 'block';
    document.getElementById('mappingContent').style.display = 'none';
    document.getElementById('mappingContent').innerHTML = '';
    document.getElementById('importActions').style.display = 'flex';
    document.getElementById('importResult').style.display = 'none';
    this._pendingFiles = null;
  },

  // ===== 第三步：确认导入 =====
  confirmImport() {
    // 收集映射关系
    const selects = document.querySelectorAll('.mapping-field-select');
    const fieldMapping = {};
    selects.forEach(sel => {
      if (sel.value) {
        fieldMapping[sel.dataset.header] = sel.value;
      }
    });

    if (Object.keys(fieldMapping).length === 0) {
      alert('至少需要选择一个字段进行映射');
      return;
    }

    // 保存映射配置供下次使用
    try { localStorage.setItem('_import_map_' + this.currentTable, JSON.stringify(fieldMapping)); } catch(e) {}

    // 隐藏映射界面，显示进度
    document.getElementById('mappingContent').style.display = 'none';
    document.getElementById('importModal').classList.remove('wide');

    const progressDiv = document.getElementById('importProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const resultDiv = document.getElementById('importResult');

    progressDiv.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = '正在导入...';

    const files = this._pendingFiles;
    const total = files.length;
    let uploaded = 0;
    let totalImported = 0;
    let totalSkipped = 0;
    let totalErrors = [];
    const self = this;

    files.forEach((file, idx) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('fieldMapping', JSON.stringify(fieldMapping));
      if (self._syncMode) formData.append('syncMode', 'true');

      progressFill.style.width = `${(idx / total) * 100}%`;
      progressText.textContent = `正在导入: ${file.name} (${idx + 1}/${total})...`;

      const endpoint = self._customEndpoint || `/import/${self.currentTable}`;
      fetch(`${self.API}${endpoint}`, {
        method: 'POST',
        body: formData
      })
      .then(r => r.json())
      .then(data => {
        uploaded++;
        if (data.imported !== undefined) {
          totalImported += data.imported;
          totalSkipped += data.skipped;
          if (data.errors && data.errors.length > 0) {
            totalErrors = totalErrors.concat(data.errors.map(e => `${file.name}: 第${e.row}行 - ${e.errors.join(', ')}`));
          }
        }

        progressFill.style.width = `${(uploaded / total) * 100}%`;

        if (uploaded === total) {
          progressText.textContent = '导入完成';
          setTimeout(() => { progressDiv.style.display = 'none'; }, 500);

          resultDiv.style.display = 'block';
          let resultHtml = '';
          if (totalSkipped === 0 && totalErrors.length === 0) {
            resultDiv.className = 'import-result success';
            resultHtml = `导入成功！共导入 <strong>${totalImported}</strong> 条${self.getTableLabel(self.currentTable)}数据`;
          } else {
            resultDiv.className = 'import-result warning';
            resultHtml = `导入完成：成功 <strong>${totalImported}</strong> 条，跳过 <strong>${totalSkipped}</strong> 条`;
            if (totalErrors.length > 0) {
              resultHtml += `<div style="margin-top:8px;font-size:12px;max-height:120px;overflow-y:auto;">`;
              totalErrors.slice(0, 10).forEach(e => { resultHtml += `<div style="padding:2px 0;">${e}</div>`; });
              if (totalErrors.length > 10) resultHtml += `<div>...还有${totalErrors.length - 10}条错误</div>`;
              resultHtml += '</div>';
            }
          }
          resultHtml += `<div style="margin-top:10px;text-align:center;"><button class="import-btn" style="background:#667eea;color:white;border-color:#667eea;padding:6px 20px;" onclick="ImportDropzone.close()">关闭并查看列表</button></div>`;
          resultDiv.innerHTML = resultHtml;

          if (self.onSuccessCallback) self.onSuccessCallback();
          self._pendingFiles = null;

          // 导入顺利完成时自动关闭弹窗，避免遮挡列表（编辑/询价/删除等操作按钮）
          if (totalSkipped === 0 && totalErrors.length === 0) {
            setTimeout(() => { self.close(); }, 1200);
          }
        }
      })
      .catch(err => {
        uploaded++;
        totalSkipped++;
        resultDiv.style.display = 'block';
        resultDiv.className = 'import-result error';
        resultDiv.innerHTML = `文件 ${file.name} 导入失败: ${err.message}`;

        if (uploaded === total) {
          if (self.onSuccessCallback) self.onSuccessCallback();
          self._pendingFiles = null;
        }
      });
    });
  },

  downloadTemplate(format) {
    const a = document.createElement('a');
    a.href = `${this.API}/import/template/${this.currentTable}?format=${format}`;
    a.download = `${this.currentTable}_import_template.${format === 'csv' ? 'csv' : 'xlsx'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  // ===== 多Sheet导入（自动匹配子表） =====
  async openMultiSheetImport(callback) {
    // 创建文件选择器
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const XLSX = await this.loadXlsxLib();
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            const wb = XLSX.read(ev.target.result, { type: 'array' });
            const sheets = wb.SheetNames;
            if (sheets.length <= 1) {
              alert('此文件只有一个Sheet，请使用普通批量导入');
              return;
            }

            // 子表类型定义
            const subTableDefs = [
              { key: 'project_progress', label: '项目进度跟踪', headers: ['计划表','BOM','规格书','技转','手样','模具','电试','研试','出货','复盘','其他'] },
              { key: 'project_supply_issues', label: '供应链品质异常', headers: ['问题描述','临时措施','原因分析','长期措施','责任人','责任部门','闭环'] },
              { key: 'project_sales_promotion', label: '销售推广进度', headers: ['产品型号','业务员','外观','价格','性能','功能'] },
              { key: 'project_reviews', label: '项目复盘', headers: ['回顾目标','评估结果','成功因素','失败原因','经验规律','行动计划'] },
      { key: 'project_initiation', label: '立项申请书', headers: ['立项背景','研发目标','技术方案','研发计划','预期成果','预算总额','风险分析','审批状态'] }
            ];

            // 解析每个Sheet的表头并自动匹配
            const sheetMappings = [];
            for (const sn of sheets) {
              const ws = wb.Sheets[sn];
              const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
              if (data.length === 0) continue;
              const headers = data[0].map(h => String(h).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, ''));
              const rowCount = data.length - 1;

              // 自动匹配子表类型
              let bestMatch = null;
              let bestScore = 0;
              for (const def of subTableDefs) {
                let score = 0;
                for (const h of def.headers) {
                  if (headers.some(h2 => h2.includes(h) || h.includes(h2))) score++;
                }
                if (score > bestScore) { bestScore = score; bestMatch = def; }
              }

              // 也检查是否匹配主项目表
              const mainHeaders = ['项目名称','项目编号','项目类型','负责人','立项时间','目标时间'];
              let mainScore = 0;
              for (const h of mainHeaders) {
                if (headers.some(h2 => h2.includes(h) || h.includes(h2))) mainScore++;
              }

              const matchedType = mainScore > bestScore && mainScore >= 3 ? 'projects' : (bestScore >= 2 ? bestMatch.key : '');
              const matchedLabel = mainScore > bestScore && mainScore >= 3 ? '研发项目数据库' : (bestMatch && bestScore >= 2 ? bestMatch.label : '');

              sheetMappings.push({ sheetName: sn, headers: headers.slice(0, 6).join(', '), rowCount, matchedType, matchedLabel, data });
            }

            // 显示映射UI
            this._showMultiSheetUI(file, sheetMappings, subTableDefs, callback);
          } catch (err) { alert('解析失败: ' + err.message); }
        };
        reader.readAsArrayBuffer(file);
      } catch (err) { alert('读取失败: ' + err.message); }
    };
    input.click();
  },

  _showMultiSheetUI(file, sheetMappings, subTableDefs, callback) {
    // 构建Sheet映射界面
    let html = `<div class="import-dropzone-overlay" id="msOverlay" style="display:flex;">
      <div class="import-dropzone-modal wide" style="width:820px;">
        <div class="import-dropzone-header">
          <h3>多Sheet导入 - ${file.name}</h3>
          <button class="import-close-btn" onclick="document.getElementById('msOverlay').remove()">&times;</button>
        </div>
        <div style="padding:16px 24px;max-height:60vh;overflow-y:auto;">
          <p style="font-size:13px;color:#555;margin-bottom:12px;">共 <b>${sheetMappings.length}</b> 个Sheet，已自动匹配子模块：</p>
          <table class="mapping-table"><thead><tr>
            <th>Sheet名称</th><th>表头预览</th><th style="width:80px;">行数</th><th style="width:160px;">导入到</th>
          </tr></thead><tbody>`;

    sheetMappings.forEach((sm, i) => {
      const options = [{ key: '', label: '-- 跳过 --' }, { key: 'projects', label: '研发项目数据库' }, ...subTableDefs.map(d => ({ key: d.key, label: d.label }))];
      const selectHtml = options.map(o =>
        `<option value="${o.key}" ${sm.matchedType === o.key ? 'selected' : ''}>${o.label}</option>`
      ).join('');
      html += `<tr>
        <td><b>${sm.sheetName}</b></td>
        <td style="font-size:12px;color:#888;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sm.headers}</td>
        <td>${sm.rowCount}行</td>
        <td><select class="ms-sheet-type" data-sheet="${i}">${selectHtml}</select></td>
      </tr>`;
    });

    html += `</tbody></table></div>
        <div class="import-actions">
          <button class="import-btn" onclick="document.getElementById('msOverlay').remove()">取消</button>
          <button class="import-btn" style="background:#667eea;color:white;border-color:#667eea;margin-left:auto;"
                  onclick="ImportDropzone._doMultiSheetImport('${file.name.replace(/'/g, "\\'")}', ${JSON.stringify(sheetMappings.map(s => ({ sheetName: s.sheetName }))).replace(/"/g, '&quot;')})">确认导入全部</button>
        </div>
      </div>
    </div>`;

    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
    // 保存数据引用
    this._msData = { file, sheetMappings, callback };
  },

  async _doMultiSheetImport(fileName, sheetRefs) {
    const { file, sheetMappings, callback } = this._msData || {};
    if (!file || !sheetMappings) return;

    // 获取用户选择
    const selects = document.querySelectorAll('.ms-sheet-type');
    const selections = [];
    selects.forEach(sel => {
      if (sel.value) selections.push({ sheetIdx: parseInt(sel.dataset.sheet), tableType: sel.value });
    });

    if (selections.length === 0) { alert('至少选择一个Sheet导入'); return; }

    // 隐藏映射UI，显示进度
    const overlay = document.getElementById('msOverlay');
    if (overlay) overlay.querySelector('.import-dropzone-modal').innerHTML = `
      <div class="import-dropzone-header"><h3>正在导入...</h3></div>
      <div class="import-progress" style="display:block;margin:24px;">
        <div class="import-progress-bar"><div class="import-progress-fill" id="msProgressFill" style="width:0%"></div></div>
        <p id="msProgressText">准备中...</p>
      </div>
      <div class="import-result" id="msResult" style="display:none;"></div>`;

    const XLSX = await this.loadXlsxLib();
    const reader = new FileReader();

    reader.onload = async (ev) => {
      const wb = XLSX.read(ev.target.result, { type: 'array' });
      let totalOk = 0, totalSkip = 0;
      const allErrors = [];
      const self = this;

      for (let i = 0; i < selections.length; i++) {
        const sel = selections[i];
        const sm = sheetMappings[sel.sheetIdx];
        if (!sm) continue;

        document.getElementById('msProgressFill').style.width = `${(i / selections.length) * 100}%`;
        document.getElementById('msProgressText').textContent = `正在导入: ${sm.sheetName} → ${self.getTableLabel(sel.tableType)}...`;

        // 读取该Sheet数据
        const ws = wb.Sheets[sm.sheetName];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (data.length < 2) continue;

        const headers = data[0].map(h => String(h).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, ''));
        const fieldMappings = self.getFieldMappingsFor(sel.tableType);

        // 构建映射
        const fieldMapping = {};
        headers.forEach(h => {
          for (const [cn, db] of fieldMappings) {
            if (h === cn || h.toLowerCase() === cn.toLowerCase()) {
              fieldMapping[h] = db;
              break;
            }
          }
        });

        // 发送导入请求
        for (let r = 1; r < data.length; r++) {
          const rowData = data[r];
          const mapped = {};
          for (const [h, dbField] of Object.entries(fieldMapping)) {
            const colIdx = headers.indexOf(h);
            if (colIdx >= 0 && rowData[colIdx] !== undefined && rowData[colIdx] !== null && rowData[colIdx] !== '') {
              let val = rowData[colIdx];
              // Excel日期序列号转换（>40000的数字是日期）
              if (typeof val === 'number' && val > 40000 && val < 100000) {
                const d = new Date((val - 25569) * 86400 * 1000);
                val = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
              }
              // 绿色背景检测（通过原始Sheet单元格样式）
              if (sel.tableType === 'project_progress') {
                const cellRef = XLSX.utils.encode_cell({r: r, c: colIdx});
                const rawCell = ws[cellRef];
                if (rawCell && rawCell.s && rawCell.s.fill && rawCell.s.fill.fgColor) {
                  const rgb = rawCell.s.fill.fgColor.rgb || '';
                  if (rgb && (rgb.includes('92D050') || rgb.includes('00B050') || rgb.includes('00FF00') || rgb.includes('C6EFCE'))) {
                    // 绿色背景 → 标记为完成
                    val = 'V';
                  }
                }
              }
              mapped[dbField] = val;
            }
          }
          if (Object.keys(mapped).length === 0) continue;

          try {
            const endpoint = self._getImportEndpoint(sel.tableType);
            const res = await fetch(`${self.API}${endpoint}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(mapped)
            });
            if (res.ok) totalOk++;
            else { totalSkip++; allErrors.push(`${sm.sheetName} 第${r+1}行: ${(await res.json()).error || '导入失败'}`); }
          } catch (e) {
            totalSkip++;
            allErrors.push(`${sm.sheetName} 第${r+1}行: ${e.message}`);
          }
        }
      }

      // 显示结果
      document.getElementById('msProgressFill').style.width = '100%';
      document.getElementById('msProgressText').textContent = '导入完成';
      const resultDiv = document.getElementById('msResult');
      resultDiv.style.display = 'block';
      resultDiv.className = 'import-result success';
      let html = `导入完成：成功 <strong>${totalOk}</strong> 条，跳过 <strong>${totalSkip}</strong> 条`;
      if (allErrors.length > 0) {
        html += `<div style="margin-top:8px;font-size:12px;max-height:100px;overflow-y:auto;">`;
        allErrors.slice(0, 10).forEach(e => { html += `<div>${e}</div>`; });
        if (allErrors.length > 10) html += `<div>...还有${allErrors.length - 10}条</div>`;
        html += '</div>';
      }
      html += `<div style="margin-top:10px;text-align:center;"><button class="import-btn" style="background:#667eea;color:white;border-color:#667eea;padding:6px 20px;" onclick="document.getElementById('msOverlay').remove();ImportDropzone.close();">关闭</button></div>`;
      resultDiv.innerHTML = html;

      if (callback) callback();
    };
    reader.readAsArrayBuffer(file);
  },

  _getImportEndpoint(tableType) {
    const map = {
      projects: '/projects',
      project_progress: '/projects/progress',
      project_supply_issues: '/projects/supply-issues',
      project_sales_promotion: '/projects/sales-promotion',
      project_reviews: '/projects/reviews',
      project_initiation: '/projects/initiation'
    };
    return map[tableType] || `/import/${tableType}`;
  },

  getFieldMappingsFor(tableType) {
    const all = {
      projects: [
        ['项目编号','project_no'],['项目名称','project_name'],['客户名称','customer_name'],
        ['项目类型','project_type'],['项目等级','project_level'],['负责人','owner'],
        ['责任单位','department'],['立项时间','start_date'],['目标时间','target_date'],
        ['目前阶段','current_stage'],['投入金额','invest_amount'],['订单金额','order_amount'],
        ['年订单','annual_order'],['状态','status'],['备注','remarks']
      ],
      project_progress: [
        ['项目编号','project_no'],['项目名称','project_name'],['负责人','owner'],
        ['计划表','plan'],['BOM','bom'],['规格书','spec'],['配置表','config'],
        ['模具图纸','mold_drawing'],['开模评审','mold_review'],['手样','hand_sample'],
        ['模具','mold'],['模样','mold_sample'],['包装设计','packaging'],
        ['电试','elec_trial'],['研试','rd_trial'],['工试','eng_trial'],['生试','prod_trial'],
        ['测试报告','test_report'],['技转','tech_transfer'],['出货','shipment'],['复盘','review'],['其他','other']
      ],
      project_supply_issues: [
        ['发生日期','occur_date'],['提出人','proposer'],['产品名称','product_name'],
        ['单号','order_no'],['项目号','project_no'],['问题描述','problem_desc'],
        ['临时措施','temp_measure'],['原因分析','cause_analysis'],['长期措施','long_term_measure'],
        ['责任人','responsible_person'],['责任部门','responsible_dept'],
        ['计划完成时间','plan_complete_date'],['稽核','audit'],['闭环','closed'],['备注','remarks']
      ],
      project_sales_promotion: [
        ['产品型号','product_model'],['业务员','salesperson'],['客户','customer'],
        ['外观','appearance'],['价格','price'],['性能','performance'],
        ['功能','function_feedback'],['目前进度','progress'],['备注','remarks']
      ],
      project_reviews: [
        ['项目编号','project_no'],['项目名称','project_name'],
        ['回顾目标','goal_original'],['里程碑','goal_milestone'],
        ['Highlights','result_highlights'],['Lowlights','result_lowlights'],
        ['评估结果-实际','result_actual'],['成功因素','success_factors'],
        ['失败原因','failure_causes'],['总结规律','insights'],
        ['经验规律','experience'],['行动计划','action_plan'],['备注','remarks']
      ]
    };
    return all[tableType] || this.getFieldMappings();
  },

  // ===== 表头匹配 + 内容兜底识别 =====
  // 返回 { result: {header: {field, source}}, allDbFields }
  // source: 'saved'(历史记忆) | 'header'(表头名称) | 'content'(内容智能识别) | ''
  _matchHeaders(table, headers, sampleRows) {
    const mappings = this.getFieldMappings();
    const allDbFields = [...new Set(mappings.map(m => m[1]))];

    const savedKey = '_import_map_' + table;
    let savedMap = {};
    try { savedMap = JSON.parse(localStorage.getItem(savedKey) || '{}'); } catch(e) {}

    const result = {};
    const usedFields = new Set();

    // 1. 优先使用历史记忆映射
    headers.forEach(h => {
      if (savedMap[h] && allDbFields.includes(savedMap[h])) {
        result[h] = { field: savedMap[h], source: 'saved' };
        usedFields.add(savedMap[h]);
      }
    });

    // 2. 表头名称匹配
    headers.forEach(h => {
      if (result[h]) return;
      for (const [cn, db] of mappings) {
        if (h === cn || h.toLowerCase() === cn.toLowerCase()) {
          result[h] = { field: db, source: 'header' };
          usedFields.add(db);
          return;
        }
      }
    });

    // 3. 内容兜底识别（仅询价单/客户模块）：表头对不齐时按列内容特征推断
    if (table === 'inquiries' || table === 'customers') {
      headers.forEach((h, idx) => {
        if (result[h] && result[h].field) return;
        const colValues = (sampleRows || []).map(r => r[idx]).filter(v => v !== undefined && v !== null && v !== '');
        const detected = this._detectFieldByContent(table, colValues);
        if (detected && !usedFields.has(detected)) {
          result[h] = { field: detected, source: 'content' };
          usedFields.add(detected);
        }
      });
    }

    // 补全未匹配项
    headers.forEach(h => { if (!result[h]) result[h] = { field: '', source: '' }; });
    return { result, allDbFields };
  },

  // 按列内容特征推断字段（返回得分最高的字段名，低于阈值返回 null）
  _detectFieldByContent(table, values) {
    const vals = (values || []).map(v => String(v == null ? '' : v).trim()).filter(v => v);
    if (vals.length < 2) return null; // 数据太少不推断
    const ratio = (pred) => vals.filter(pred).length / vals.length;
    const C = []; // 候选 {field, score}

    const push = (field, score) => { if (score > 0) C.push({ field, score }); };

    if (table === 'customers') {
      push('email', ratio(v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(v)) > 0.5 ? ratio(v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(v)) : 0);
      const phoneR = ratio(v => /^[\+\d][\d\s\-\(\)]{6,}$/.test(v) && (v.match(/\d/g) || []).length >= 7 && (v.match(/\d/g) || []).length <= 15);
      push('phone', phoneR > 0.6 ? phoneR * 0.85 : 0);
      const waR = ratio(v => /^\+\d{6,14}$/.test(v));
      push('whatsapp', waR > 0.7 ? waR : 0);
      const wxR = ratio(v => /^wxid[_a-zA-Z0-9]+$/.test(v) || /^[a-zA-Z][a-zA-Z0-9_\-]{5,19}$/.test(v));
      push('wechat', wxR > 0.6 ? wxR * 0.7 : 0);
      const taxR = ratio(v => /^[0-9A-HJ-NPQRTUWXY]{18}$/.test(v) || /^\d{15}$/.test(v));
      push('tax_id', taxR > 0.6 ? taxR * 0.85 : 0);
      const bankR = ratio(v => /^\d{16,19}$/.test(v));
      push('bank_account', bankR > 0.6 ? bankR * 0.8 : 0);
      const lvlR = ratio(v => /^[A-D]级?$/.test(v));
      push('customer_level', lvlR > 0.5 ? lvlR : 0);
      const stR = ratio(v => /活跃|潜在|休眠|合作|样品|active|dormant|sample/i.test(v));
      push('customer_status', stR > 0.5 ? stR * 0.9 : 0);
      const smR = ratio(v => /外销|内销|出口|进口|export|domestic|trade/i.test(v));
      push('sales_mode', smR > 0.5 ? smR * 0.9 : 0);
      const yrR = ratio(v => /^(19|20)\d{2}$/.test(v));
      push('last_trade_year', yrR > 0.6 ? yrR : 0);
      const countryR = ratio(v => /中国|美国|德国|英国|法国|日本|韩国|印度|巴西|俄罗斯|意大利|西班牙|荷兰|澳大利亚|加拿大|墨西哥|越南|泰国|印尼|马来西亚|菲律宾|新加坡|土耳其|沙特|阿联酋|波兰|南非|阿根廷|智利|埃及|国$/.test(v));
      push('country_region', countryR > 0.5 ? countryR * 0.7 : 0);
      const addrR = ratio(v => v.length > 6 && /省|市|区|县|镇|路|街|号|村|大道|工业园|工业区|Address|Street|Road|Ave|Blvd/i.test(v));
      push('address', addrR > 0.5 ? addrR * 0.8 : 0);
      const compR = ratio(v => /公司|有限|集团|有限?公司|股份|厂|Co\.|Ltd\.|Inc\.|GmbH|S\.A\.|LLC/i.test(v));
      push('name', compR > 0.5 ? compR * 0.85 : 0);
      const personR = ratio(v => /^[\u4e00-\u9fa5·]{2,5}$/.test(v) && !/公司|有限|集团|厂|部|室|中心/.test(v));
      push('contact_person', personR > 0.6 ? personR * 0.45 : 0);
    }

    if (table === 'inquiries') {
      const qtyR = ratio(v => /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 1000000);
      push('quantity', qtyR > 0.6 ? qtyR * 0.8 : 0);
      const pwR = ratio(v => /^\d+(\.\d+)?\s*W$/i.test(v));
      push('power', pwR > 0.5 ? pwR : 0);
      const dateR = ratio(v => /^\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}/.test(v) || /^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/.test(v));
      push('inquiry_time', dateR > 0.6 ? dateR * 0.55 : 0);
      const stR = ratio(v => /new|quoted|pricing|pending|negotiat|closed|won|lost|sample|project|新建|核价|报价|谈判|闭环|丢单|样品|项目/i.test(v));
      push('status', stR > 0.5 ? stR * 0.85 : 0);
      const rateR = ratio(v => /^0?\.\d{1,4}$/.test(v) || /^(100|[1-9]?\d)%$/.test(v));
      push('profit_rate', rateR > 0.6 ? rateR * 0.55 : 0);
      const numR = ratio(v => /^\d+(\.\d{1,4})?$/.test(v) && Number(v) > 0);
      push('final_price', numR > 0.7 ? numR * 0.38 : 0);
      const modelR = ratio(v => /^[A-Za-z0-9][A-Za-z0-9\-_./]{2,}$/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v) && /-/.test(v));
      push('external_model', modelR > 0.5 ? modelR * 0.6 : 0);
      const compR = ratio(v => /公司|有限|集团|股份|厂|Co\.|Ltd\.|Inc\.|GmbH|S\.A\.|LLC/i.test(v));
      push('customer_name', compR > 0.5 ? compR * 0.85 : 0);
    }

    if (C.length === 0) return null;
    C.sort((a, b) => b.score - a.score);
    return C[0].score >= 0.5 ? C[0].field : null;
  },

  // ===== 询价管理 - 多Sheet导入（按Sheet名路由子模块）=====
  // opts.onProductConfig(products): 配置表Sheet解析出的产品行 → 填入新建询价单
  // opts.onSuccess(): 导入完成回调（刷新列表）
  openInquiryMultiSheetImport(opts) {
    opts = opts || {};
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const XLSX = await this.loadXlsxLib();
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            const wb = XLSX.read(ev.target.result, { type: 'array' });
            const sheets = wb.SheetNames;
            if (!sheets || sheets.length === 0) { alert('文件没有Sheet'); return; }
            const sheetInfos = [];
            for (const sn of sheets) {
              const ws = wb.Sheets[sn];
              const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
              if (!data || data.length === 0) continue;
              const headers = data[0].map(h => String(h).trim().replace(/^\uFEFF/, '').replace(/\u200B/g, ''));
              const rowCount = data.length - 1;
              sheetInfos.push({ sheetName: sn, headers, rowCount, data, target: this._guessSheetTarget(sn, headers) });
            }
            if (sheetInfos.length === 0) { alert('未解析到有效数据'); return; }
            this._showInquiryMultiSheetUI(file.name, sheetInfos, opts);
          } catch (err) { alert('解析失败: ' + err.message); }
        };
        reader.readAsArrayBuffer(file);
      } catch (err) { alert('读取失败: ' + err.message); }
    };
    input.click();
  },

  // 按Sheet名+表头内容推断目标子模块
  _guessSheetTarget(sheetName, headers) {
    const name = String(sheetName);
    if (/询价/.test(name)) return 'inquiries';
    if (/配置表|配置/.test(name)) return 'product_config';
    if (/核价/.test(name)) return 'bom_pricing';
    // 兜底：按表头关键词推断
    const hStr = headers.join(',');
    const isPricing = /套件|电缆线|光源|驱动|太阳能板|合计成本|最低限价|核价人|核价链接/.test(hStr);
    if (isPricing) return 'bom_pricing';
    const isInquiry = /询价单号|客户名称|销售员|询价时间|交货日期|报价有效期/.test(hStr);
    if (isInquiry) return 'inquiries';
    const isConfig = /产品图|产品名称|输入电压|色温|光通量|防水等级|感应器|报价需时间/.test(hStr);
    if (isConfig) return 'product_config';
    return '';
  },

  _showInquiryMultiSheetUI(fileName, sheetInfos, opts) {
    const old = document.getElementById('iqMsOverlay');
    if (old) old.remove();
    const targets = [
      { key: '', label: '-- 跳过 --' },
      { key: 'inquiries', label: '询价管理（询价单）' },
      { key: 'product_config', label: '新建询价单 - 产品配置' },
      { key: 'bom_pricing', label: '核价表' }
    ];
    let html = `<div class="import-dropzone-overlay" id="iqMsOverlay" style="display:flex;">
      <div class="import-dropzone-modal wide" style="width:880px;">
        <div class="import-dropzone-header">
          <h3>多Sheet导入 - ${this.escHtml(fileName)}</h3>
          <button class="import-close-btn" onclick="document.getElementById('iqMsOverlay').remove()">&times;</button>
        </div>
        <div style="padding:12px 24px;max-height:62vh;overflow-y:auto;">
          <p style="font-size:13px;color:#555;margin-bottom:10px;">系统已按 <b>Sheet名称</b> 自动匹配目标模块，可手动调整后导入：</p>
          <table class="mapping-table"><thead><tr>
            <th>Sheet名称</th><th>表头预览</th><th style="width:70px;">行数</th><th style="width:200px;">导入到</th>
          </tr></thead><tbody>`;
    sheetInfos.forEach((si, i) => {
      const optsHtml = targets.map(t => `<option value="${t.key}" ${si.target === t.key ? 'selected' : ''}>${t.label}</option>`).join('');
      const preview = si.headers.slice(0, 6).join('，');
      html += `<tr>
        <td><b>${this.escHtml(si.sheetName)}</b></td>
        <td style="font-size:12px;color:#888;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this.escHtml(preview)}</td>
        <td>${si.rowCount}</td>
        <td><select class="iq-ms-sheet-type" data-idx="${i}">${optsHtml}</select></td>
      </tr>`;
    });
    html += `</tbody></table>
          <p style="font-size:12px;color:#98a2b3;margin-top:10px;">提示：「配置表」Sheet 将解析产品行并填入<b>新建询价单</b>的产品配置；「核价表」Sheet 导入到核价表模块；「询价」Sheet 导入到询价管理。</p>
        </div>
        <div class="import-actions">
          <button class="import-btn" onclick="document.getElementById('iqMsOverlay').remove()">取消</button>
          <button class="import-btn" style="background:#667eea;color:white;border-color:#667eea;margin-left:auto;" onclick="ImportDropzone._confirmInquiryMultiSheet()">确认导入</button>
        </div>
      </div>
    </div>`;
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
    this._iqMsData = { fileName, sheetInfos, opts };
  },

  async _confirmInquiryMultiSheet() {
    const { fileName, sheetInfos, opts } = this._iqMsData || {};
    if (!sheetInfos) return;

    const selections = [];
    document.querySelectorAll('.iq-ms-sheet-type').forEach(sel => {
      if (sel.value) selections.push({ idx: parseInt(sel.dataset.idx), target: sel.value });
    });
    if (selections.length === 0) { alert('请至少选择一个Sheet进行导入'); return; }

    const overlay = document.getElementById('iqMsOverlay');
    if (overlay) overlay.querySelector('.import-dropzone-modal').innerHTML = `
      <div class="import-dropzone-header"><h3>正在导入...</h3></div>
      <div class="import-progress" style="display:block;margin:24px;">
        <div class="import-progress-bar"><div class="import-progress-fill" id="iqMsProgFill" style="width:0%"></div></div>
        <p id="iqMsProgText">准备中...</p>
      </div>
      <div class="import-result" id="iqMsResult" style="display:none;"></div>`;

    let totalOk = 0, totalSkip = 0;
    const allErrors = [];
    const configProducts = [];
    const self = this;
    const labelMap = { inquiries: '询价管理', product_config: '产品配置', bom_pricing: '核价表' };

    for (let i = 0; i < selections.length; i++) {
      const sel = selections[i];
      const info = sheetInfos[sel.idx];
      if (!info) continue;
      const fillEl = document.getElementById('iqMsProgFill');
      const textEl = document.getElementById('iqMsProgText');
      if (fillEl) fillEl.style.width = `${(i / selections.length) * 100}%`;
      if (textEl) textEl.textContent = `正在导入: ${info.sheetName} → ${labelMap[sel.target] || sel.target}...`;

      if (sel.target === 'product_config') {
        configProducts.push(...self._parseProductConfigRows(info.data));
        continue;
      }
      try {
        const fileBlob = await self._buildSheetFile(info.data, `${sel.target}_${info.sheetName}`);
        const { fieldMapping } = self._computeSheetMapping(sel.target, info.headers, info.data);
        const fd = new FormData();
        fd.append('file', fileBlob);
        fd.append('fieldMapping', JSON.stringify(fieldMapping));
        const res = await fetch(`${self.API}/import/${sel.target}`, { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (data.imported !== undefined) {
          totalOk += data.imported; totalSkip += data.skipped;
          if (data.errors && data.errors.length) allErrors.push(...data.errors.map(e => `${info.sheetName} 第${e.row}行: ${e.errors.join(', ')}`));
        } else {
          totalSkip++;
          allErrors.push(`${info.sheetName}: ${data.error || '导入失败'}`);
        }
      } catch (e) {
        totalSkip++;
        allErrors.push(`${info.sheetName}: ${e.message}`);
      }
    }

    if (configProducts.length > 0 && opts && opts.onProductConfig) {
      try { opts.onProductConfig(configProducts); } catch (e) {}
    }

    const fillEl = document.getElementById('iqMsProgFill');
    const textEl = document.getElementById('iqMsProgText');
    if (fillEl) fillEl.style.width = '100%';
    if (textEl) textEl.textContent = '导入完成';
    const resultDiv = document.getElementById('iqMsResult');
    if (resultDiv) {
      resultDiv.style.display = 'block';
      let cls = 'import-result ';
      let msg = `导入完成：成功 <strong>${totalOk}</strong> 条`;
      if (configProducts.length) msg += `，产品配置 <strong>${configProducts.length}</strong> 行已填入新建询价单`;
      if (totalSkip) { msg += `，跳过 <strong>${totalSkip}</strong> 条`; cls += 'warning'; } else cls += 'success';
      resultDiv.className = cls;
      let h = msg;
      if (allErrors.length) {
        h += `<div style="margin-top:8px;font-size:12px;max-height:100px;overflow-y:auto;">`;
        allErrors.slice(0, 10).forEach(e => { h += `<div>${self.escHtml(e)}</div>`; });
        if (allErrors.length > 10) h += `<div>...还有${allErrors.length - 10}条</div>`;
        h += '</div>';
      }
      h += `<div style="margin-top:10px;text-align:center;"><button class="import-btn" style="background:#667eea;color:white;border-color:#667eea;padding:6px 20px;" onclick="document.getElementById('iqMsOverlay').remove();ImportDropzone.close();">关闭</button></div>`;
      resultDiv.innerHTML = h;
    }
    if (opts && opts.onSuccess) { try { opts.onSuccess(); } catch (e) {} }
    this._iqMsData = null;
  },

  // 由二维数据(含表头行)构建 xlsx File，用于上传到标准导入接口
  async _buildSheetFile(data, name) {
    const XLSX = await this.loadXlsxLib();
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '数据');
    const arr = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    return new File([arr], `${name}.xlsx`, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  },

  // 计算某Sheet的字段映射（复用表头+内容兜底识别）
  _computeSheetMapping(table, headers, data) {
    const sampleRows = data.slice(1, 61).map(r => (r || []).map(c => c !== undefined && c !== null ? String(c).trim() : ''));
    const { result } = this._matchHeaders(table, headers, sampleRows);
    const fieldMapping = {};
    headers.forEach(h => { if (result[h] && result[h].field) fieldMapping[h] = result[h].field; });
    return { fieldMapping };
  },

  // 解析"配置表"Sheet的产品行（与 handleTemplateFile 逻辑一致）
  _parseProductConfigRows(data) {
    if (!data || data.length < 2) return [];
    const headerRow = data[0];
    const colMap = {};
    const headerMapping = {
      '产品图': 'product_image', '产品型号': 'external_model', '产品名称': 'product_name',
      '功率': 'power', '输入电压': 'input_voltage', '电池': 'battery',
      '色温': 'color_temp', '光通量': 'luminous_flux', '光通量/光效': 'luminous_flux',
      '光源': 'light_source', '主体': 'main_body', '灯罩': 'lampshade',
      '反光罩': 'reflector', '电缆线': 'cable', '电缆': 'cable',
      '开关': 'switch_type', 'USB': 'usb', '防水等级': 'waterproof',
      '感应器': 'sensor', '感应': 'sensor', '报价': 'quote_price',
      '目标价': 'target_price', '需求数量': 'quantity', '数量': 'quantity',
      '报价需时间': 'quote_time_needed', '其他要求': 'custom_requirements', '序号': 'serial_no'
    };
    headerRow.forEach((h, idx) => {
      const key = headerMapping[String(h).trim()];
      if (key && colMap[key] === undefined) colMap[key] = idx;
    });
    const products = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;
      const item = {};
      Object.entries(colMap).forEach(([key, idx]) => {
        item[key] = row[idx] !== undefined && row[idx] !== null ? String(row[idx]).trim() : '';
      });
      if (!item.external_model && !item.product_name) continue;
      if (item.quantity) item.quantity = Number(item.quantity) || 0;
      if (item.target_price) item.target_price = Number(item.target_price) || 0;
      products.push(item);
    }
    return products;
  }
};