const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { getTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const { resolveDataScope, isInScope } = require('../data-scope');
const { resolveDataScopeV2, buildScopeFilter, combineFilter, logDataPermission } = require('../data-scope-v2');

const upload = multer({ storage: multer.memoryStorage() });

// 客户附件存储目录
const custUploadDir = path.join(__dirname, '..', '..', 'uploads', 'customers');
if (!fs.existsSync(custUploadDir)) fs.mkdirSync(custUploadDir, { recursive: true });
const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, custUploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      const base = path.basename(file.originalname, ext).replace(/[^\w\u4e00-\u9fa5.\-]/g, '_').slice(0, 50);
      cb(null, `${Date.now()}_${base}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// 客户所有字段
const CUSTOMER_FIELDS = [
  'customer_code', 'name', 'former_name', 'parent_code',
  'decision_maker', 'decision_maker_position', 'decision_core_need',
  'contact_person', 'contact_position', 'phone', 'email', 'website',
  'wechat', 'whatsapp', 'skype', 'other_im',
  'customer_level', 'sales_mode', 'customer_status', 'sales_person',
  'last_trade_year', 'invoice_title', 'tax_id', 'bank_name', 'bank_account',
  'address', 'country_region', 'customer_source', 'remarks'
];

// 客户列表（分页+筛选）
router.get('/', requirePerm('customer:view'), (req, res) => {
  const { page = 1, limit = 15, keyword, customer_level, sales_mode, customer_status, sales_person } = req.query;
  const table = getTable('customers');
  const scope = resolveDataScopeV2(req);

  // 兼容模式：旧接口（resolveDataScope）也保留一份返回，确保原 UI 仍可见 owner 名称
  const scopeLegacy = resolveDataScope(req);

  // v2 数据权限过滤函数
  const scopeFilter = buildScopeFilter(scope, 'customers');

  // 预计算：客户的可访问销售员集合（兼容 v1 字符串匹配）
  //   - 直接：客户记录自身的 sales_person 字段
  //   - 间接：通过任意关联询价的 sales_person 反查
  let allowedByCustomer = null;
  if (scopeLegacy.enabled) {
    allowedByCustomer = new Map();
    const inqTable = getTable('inquiries');
    inqTable.all().forEach(iq => {
      const cn = String(iq.customer_name || '').trim();
      const sp = String(iq.sales_person || '').trim();
      if (!cn || !sp) return;
      if (!scopeLegacy.ownerNames.has(sp)) return;
      if (!allowedByCustomer.has(cn)) allowedByCustomer.set(cn, new Set());
      allowedByCustomer.get(cn).add(sp);
    });
  }

  // 旧匹配模式：当记录 owner_id / sales_id 未填时，按字符串 sales_person 兼容匹配
  const legacyMatch = (r) => {
    if (!scopeLegacy.enabled) return true;
    const cn = String(r.name || '').trim();
    const directSp = String(r.sales_person || '').trim();
    return (directSp && scopeLegacy.ownerNames.has(directSp)) ||
           (cn && allowedByCustomer && allowedByCustomer.has(cn));
  };

  const filter = combineFilter((r) => {
    if (customer_level && r.customer_level !== customer_level) return false;
    if (sales_mode && r.sales_mode !== sales_mode) return false;
    if (customer_status && r.customer_status !== customer_status) return false;
    if (sales_person && r.sales_person !== sales_person) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [
        r.name, r.customer_code, r.former_name, r.contact_person,
        r.decision_maker, r.phone, r.email, r.sales_person, r.remarks
      ].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  }, (r) => {
    // v2 数据权限启用时，完全以 v2 为准（owner_id / department_id / create_by）
    // 不再回退到旧字符串匹配——旧版基于 personnel.name 匹配 sales_person，
    // 会把同部门他人（如管丽艳）的数据误放行给当前用户。
    if (scope.enabled) {
      return scopeFilter(r);
    }
    // admin / 未受限用户：旧接口放行
    return legacyMatch(r);
  });
  const { records, total } = table.findWhere(filter, 'created_at', 'DESC', parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  logDataPermission(req, 'customer.list', { table: 'customers', count: total, scope_mode: scope.mode || 'all' });
  // 判定当前响应是否被数据权限过滤：scope.enabled = true 表示受限；否则 all（admin / 无需受限）
  const effectiveMode = scope.enabled ? scope.mode : (scope.mode === 'all' ? 'all' : 'none');
  res.json({
    data: records,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    scope: {
      mode: effectiveMode,
      label: labelOfMode(effectiveMode),
      enabled: scope.enabled,
      owner_count: scope.ownerIds ? scope.ownerIds.length : 0
    }
  });
});

function labelOfMode(mode) {
  return {
    all: '全部数据',
    self: '我的客户',
    dept: '本部门客户',
    dept_and_child: '本部门及下级部门客户',
    custom: '自定义范围客户',
    none: '全部数据'
  }[mode] || '全部数据';
}

// ===== Excel批量导入外贸客户资料 - 必须在 /:id 之前 =====
router.post('/import-xlsx', upload.single('file'), requirePerm('customer:create'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    if (data.length < 2) return res.status(400).json({ error: '文件为空' });

    // 表头映射：Excel列名 -> 数据库字段
    const headerMap = {
      '客户编号': 'customer_code',
      '客户全称': 'name',
      '客户曾用名': 'former_name',
      '母公司编号': 'parent_code',
      '决策人姓名': 'decision_maker',
      '决策人职位': 'decision_maker_position',
      '决策核心诉求': 'decision_core_need',
      '普通对接人': 'contact_person',
      '对接人职位': 'contact_position',
      '联系电话(含区号)': 'phone',
      '对接邮箱': 'email',
      '微信号': 'wechat',
      'WhatsApp': 'whatsapp',
      'Skype': 'skype',
      '其他即时联系方式': 'other_im',
      '客户等级': 'customer_level',
      '销售模式': 'sales_mode',
      '客户状态': 'customer_status',
      '所属业务员': 'sales_person',
      '最后交易年份': 'last_trade_year',
      '开票抬头': 'invoice_title',
      '纳税人识别号': 'tax_id',
      '开户银行': 'bank_name',
      '银行账号': 'bank_account',
      '地址': 'address',
      '国家/地区': 'country_region',
      '客户来源': 'customer_source',
      '备注说明': 'remarks'
    };

    const headers = data[0].map(h => String(h).trim());
    const colMap = {};
    headers.forEach((h, idx) => {
      if (headerMap[h]) colMap[idx] = headerMap[h];
    });

    const table = getTable('customers');
    table._invalidate();
    const existingNames = new Set(table.all().map(c => c.name));
    const existingCodes = new Set(table.all().map(c => c.customer_code).filter(c => c));

    let imported = 0, skipped = 0, results = [];

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (!row || row.length === 0) continue;

      const record = { created_at: now(), updated_at: now() };
      // 初始化所有字段
      CUSTOMER_FIELDS.forEach(f => { record[f] = ''; });

      for (const [colIdx, fieldName] of Object.entries(colMap)) {
        record[fieldName] = String(row[colIdx] || '').trim();
      }

      // 标准化客户等级
      if (record.customer_level) {
        record.customer_level = record.customer_level.replace(/\s+/g, '');
        if (record.customer_level.includes('A级') || record.customer_level.includes('A')) record.customer_level = 'A级（核心大客户）';
        else if (record.customer_level.includes('B级') || record.customer_level.includes('B')) record.customer_level = 'B级（普通大客户）';
        else if (record.customer_level.includes('C级') || record.customer_level.includes('C')) record.customer_level = 'C级（中小客户）';
        else if (record.customer_level.includes('D级') || record.customer_level.includes('D')) record.customer_level = 'D级（新客/休眠客）';
      }

      if (!record.name) { skipped++; results.push({ row: i + 1, status: 'skipped', reason: '客户名称为空' }); continue; }
      if (existingNames.has(record.name)) { skipped++; results.push({ row: i + 1, name: record.name, status: 'skipped', reason: '客户名称已存在' }); continue; }
      if (record.customer_code && existingCodes.has(record.customer_code)) { skipped++; results.push({ row: i + 1, name: record.name, status: 'skipped', reason: '客户编号已存在' }); continue; }

      table.insert(record);
      existingNames.add(record.name);
      if (record.customer_code) existingCodes.add(record.customer_code);
      imported++;
      results.push({ row: i + 1, name: record.name, status: 'imported' });
    }

    res.json({ imported, skipped, results });
  } catch (e) {
    console.error('导入客户资料失败:', e);
    res.status(500).json({ error: '导入失败: ' + e.message });
  }
});

// ===== 下载客户导入模板 - 必须在 /:id 之前 =====
router.get('/template/download', requirePerm('customer:view'), (req, res) => {
  const headers = ['客户编号','客户全称','客户曾用名','母公司编号','决策人姓名','决策人职位','决策核心诉求','普通对接人','对接人职位','联系电话(含区号)','对接邮箱','微信号','WhatsApp','Skype','其他即时联系方式','客户等级','销售模式','客户状态','所属业务员','最后交易年份','开票抬头','纳税人识别号','开户银行','银行账号','地址','国家/地区','客户来源','备注说明'];
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '客户资料导入模板');

  // 添加数据字典sheet
  const dictData = [
    ['字段名称', '选项代码/值', '含义描述'],
    ['客户等级', 'A级（核心大客户）', '核心大客户，交易频繁，贡献度高'],
    ['客户等级', 'B级（普通大客户）', '重要客户，交易稳定'],
    ['客户等级', 'C级（中小客户）', '普通客户，交易频次一般'],
    ['客户等级', 'D级（新客/休眠客）', '新客户或低频客户，需培育'],
    ['销售模式', '外销', '出口销售，通常外币结算'],
    ['销售模式', '内销', '国内销售，通常RMB结算'],
    ['销售模式', '外贸公司', '通过外贸公司间接出口'],
    ['客户状态', '大货合作客户', '当前有活跃交易'],
    ['客户状态', '样品单客户', '正在寄送样品或试单'],
    ['客户状态', '潜在客户', '已联系但未产生交易'],
    ['客户状态', '未合作休眠客户', '长期无交易'],
    ['客户来源', '网络推广', '通过网络推广获取'],
    ['客户来源', '展会', '通过展会获取'],
    ['客户来源', '老客户推荐', '老客户推荐介绍'],
    ['客户来源', '主动开发', '销售主动开发'],
    ['客户来源', '合作伙伴', '合作伙伴介绍'],
    ['客户来源', '其他', '其他渠道来源'],
    ['国家/地区', '中国', '国内客户'],
    ['国家/地区', '美国', '美国客户'],
    ['国家/地区', '德国', '德国客户'],
    ['国家/地区', '英国', '英国客户'],
    ['国家/地区', '法国', '法国客户'],
    ['国家/地区', '日本', '日本客户'],
    ['国家/地区', '韩国', '韩国客户'],
    ['国家/地区', '印度', '印度客户'],
    ['国家/地区', '巴西', '巴西客户'],
    ['国家/地区', '俄罗斯', '俄罗斯客户'],
    ['国家/地区', '澳大利亚', '澳大利亚客户'],
    ['国家/地区', '其他', '其他国家或地区'],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(dictData);
  XLSX.utils.book_append_sheet(wb, ws2, '填写说明与数据字典');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent('客户资料导入模板.xlsx'));
  res.send(buf);
});

// ===== 批量更新客户 - 必须在 /:id 之前 =====
router.put('/batch-update', requirePerm('customer:edit'), (req, res) => {
  const { ids, fields } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要修改的客户' });
  }
  if (!fields || Object.keys(fields).length === 0) {
    return res.status(400).json({ error: '请提供要修改的字段' });
  }

  const table = getTable('customers');
  const updateFields = { updated_at: now() };
  CUSTOMER_FIELDS.forEach(f => {
    if (fields[f] !== undefined) updateFields[f] = fields[f];
  });

  let updated = 0;
  ids.forEach(id => {
    const existing = table.findById(id);
    if (existing) {
      table.update(id, updateFields);
      updated++;
    }
  });

  const broadcast = req.app.get('broadcastDataChange');
  if (broadcast) broadcast('customers', 'batch_update', { ids, fields: updateFields, count: updated });

  res.json({ message: `批量更新完成，成功 ${updated} 条`, updated });
});

// ===== 拍照识别客户信息（OCR） =====
router.post('/ocr-recognize', upload.single('image'), requirePerm('customer:create'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传图片' });

  try {
    const Tesseract = require('tesseract.js');
    const result = await Tesseract.recognize(req.file.buffer, 'chi_sim+eng', {
      logger: () => {}
    });
    const text = result.data.text || '';
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const info = {
      name: '', former_name: '', contact_person: '', contact_position: '',
      decision_maker: '', phone: '', email: '', address: '',
      wechat: '', whatsapp: '', skype: '', other_im: '',
      country_region: '', sales_mode: '', customer_source: '拍照导入',
      invoice_title: '', remarks: '', raw_text: text
    };

    // ===== 第一步：按行解析，标签与值严格配对 =====
    // 已被占用的行号集合，避免重复提取
    const usedLines = new Set();

    // 每行尝试匹配：标签 + 值
    const lineLabels = [
      // 电话类（区分主电话/手机/传真）
      { regex: /^(?:手机|Mob(?:ile)?|Cell)[:\s：.]+(.+)/i, field: 'phone', type: 'mobile' },
      { regex: /^(?:电话|Tel(?:ephone)?|Phone|固话|座机|热线)[:\s：.]+(.+)/i, field: 'phone', type: 'tel' },
      { regex: /^(?:传真|Fax)[:\s：.]+(.+)/i, field: '_fax', type: 'fax' },
      // 联系人类
      { regex: /^(?:联系人|对接人|姓名|Name|Contact|Attn)[:\s：.]+(.+)/i, field: 'contact_person', type: 'contact' },
      { regex: /^(?:职位|职务|Position|Title|Job)[:\s：.]+(.+)/i, field: 'contact_position', type: 'position' },
      // 通讯类
      { regex: /^(?:邮箱|Email|E-mail|Mail)[:\s：.]+(.+)/i, field: 'email', type: 'email' },
      { regex: /^(?:微信|WeChat|Wechat|VX)[:\s：.]+(.+)/i, field: 'wechat', type: 'wechat' },
      { regex: /^(?:WhatsApp|Whatsapp|WA)[:\s：.]+(.+)/i, field: 'whatsapp', type: 'whatsapp' },
      { regex: /^(?:Skype|skype)[:\s：.]+(.+)/i, field: 'skype', type: 'skype' },
      // 地址类（支持OCR常见空格：地 址、Add ress）
      { regex: /^(?:地\s*址|Addr(?:ess)?|厂\s*址|公司地址|办公地址|Add)[:\s：.]+(.+)/i, field: 'address', type: 'address' },
      // 公司类
      { regex: /^(?:公司|Company|Co\.|公司名称)[:\s：.]+(.+)/i, field: 'name', type: 'company' },
      // 国家/地区
      { regex: /^(?:国家|地区|Country|Region|Nation)[:\s：.]+(.+)/i, field: 'country_region', type: 'country' },
      // 开票
      { regex: /^(?:开票|发票|抬头|Invoice|Tax)[:\s：.]+(.+)/i, field: 'invoice_title', type: 'invoice' },
      // 网址
      { regex: /^(?:网址|Web|Website|Site|Http|WWW)[:\s：.]+(.+)/i, field: '_web', type: 'web' },
    ];

    // 存储各类型匹配结果（可能多行匹配同一类型）
    const matched = {};
    const extraInfo = []; // 额外信息（传真、网址等）

    lines.forEach((line, idx) => {
      for (const label of lineLabels) {
        const m = line.match(label.regex);
        if (m) {
          const value = m[1].trim();
          if (!matched[label.type]) {
            matched[label.type] = { value, lineIdx: idx, field: label.field };
          } else {
            // 同类型已匹配过，存为额外信息
            extraInfo.push({ type: label.type, value, line: line });
          }
          usedLines.add(idx);
          break; // 一行只匹配一个标签
        }
      }
    });

    // ===== 补充：检测"标签独占一行，值在下一行"的情况 =====
    // OCR有时把标签和值分成两行，如 "地址" 一行，"浙江省xxx" 下一行
    const soloLabelPatterns = [
      { regex: /^地\s*址$/i, type: 'address' },
      { regex: /^Addr(?:ess)?$/i, type: 'address' },
      { regex: /^Add$/i, type: 'address' },
      { regex: /^联\s*系\s*人$/i, type: 'contact' },
      { regex: /^Name$/i, type: 'contact' },
      { regex: /^电\s*话$/i, type: 'tel' },
      { regex: /^Tel(?:ephone)?$/i, type: 'tel' },
      { regex: /^Phone$/i, type: 'tel' },
      { regex: /^手\s*机$/i, type: 'mobile' },
      { regex: /^Mob(?:ile)?$/i, type: 'mobile' },
      { regex: /^邮\s*箱$/i, type: 'email' },
      { regex: /^Email$/i, type: 'email' },
      { regex: /^E-mail$/i, type: 'email' },
      { regex: /^传\s*真$/i, type: 'fax' },
      { regex: /^Fax$/i, type: 'fax' },
      { regex: /^微\s*信$/i, type: 'wechat' },
      { regex: /^公\s*司$/i, type: 'company' },
    ];

    lines.forEach((line, idx) => {
      if (usedLines.has(idx)) return; // 已被匹配过
      for (const p of soloLabelPatterns) {
        if (p.regex.test(line)) {
          // 标签独占一行，取下一行作为值
          if (idx + 1 < lines.length && !usedLines.has(idx + 1)) {
            const nextLine = lines[idx + 1].trim();
            if (nextLine.length > 0) {
              if (!matched[p.type]) {
                matched[p.type] = { value: nextLine, lineIdx: idx + 1, field: '' };
              }
              usedLines.add(idx);     // 标记标签行
              usedLines.add(idx + 1); // 标记值行
            }
          }
          break;
        }
      }
    });

    // ===== 第二步：处理带标签的匹配结果 =====

    // 电话：优先手机，其次座机
    if (matched.mobile) {
      info.phone = cleanPhone(matched.mobile.value);
    } else if (matched.tel) {
      info.phone = cleanPhone(matched.tel.value);
    }
    // 座机也保存到备注（如果手机和座机都有）
    if (matched.mobile && matched.tel) {
      extraInfo.push({ type: 'tel', value: '座机: ' + cleanPhone(matched.tel.value) });
    }

    // 传真存入备注
    if (matched.fax || matched._fax) {
      const faxVal = matched._fax ? matched._fax.value : matched.fax.value;
      extraInfo.push({ type: 'fax', value: '传真: ' + cleanPhone(faxVal) });
    }

    // 联系人
    if (matched.contact) info.contact_person = matched.contact.value;
    // 职位
    if (matched.position) info.contact_position = matched.position.value;
    // 邮箱
    if (matched.email) info.email = matched.email.value;
    // 微信
    if (matched.wechat) info.wechat = matched.wechat.value;
    // WhatsApp
    if (matched.whatsapp) info.whatsapp = cleanPhone(matched.whatsapp.value);
    // Skype
    if (matched.skype) info.skype = matched.skype.value;
    // 地址（可能跨多行，收集后续未标记行）
    if (matched.address) {
      const addrLines = [matched.address.value];
      const addrIdx = matched.address.lineIdx;
      for (let i = addrIdx + 1; i < lines.length && i <= addrIdx + 5; i++) {
        if (usedLines.has(i)) break;
        if (!/^(?:电话|手机|Tel|Phone|Email|微信|WeChat|WhatsApp|Skype|传真|Fax|联系人|Name|职位|Position|公司|Company|网址|Web|Http)/i.test(lines[i])) {
          addrLines.push(lines[i]);
          usedLines.add(i);
        } else break;
      }
      info.address = addrLines.join(' ').substring(0, 300);
    }
    // 国家/地区
    if (matched.country) info.country_region = matched.country.value;
    // 开票抬头
    if (matched.invoice) info.invoice_title = matched.invoice.value;
    // 网址
    if (matched.web || matched._web) {
      const webVal = matched._web ? matched._web.value : matched.web.value;
      extraInfo.push({ type: 'web', value: '网址: ' + webVal });
    }
    // 公司名（带标签的）
    if (matched.company) info.name = matched.company.value;

    // ===== 第三步：处理未标记行（无标签的行） =====
    const unmarkedLines = [];
    lines.forEach((line, idx) => {
      if (!usedLines.has(idx)) unmarkedLines.push({ line, idx });
    });

    // 职位关键词（用于拆分"姓名+职位"同行）
    const posKw = /(?:总经理|副总经理|总监|经理|主管|工程师|主任|专员|助理|代表|秘书|顾问|VP|CEO|CTO|COO|CFO|Manager|Director|Engineer|Supervisor|Assistant|Representative|Consultant|President|Executive)/i;
    // 公司关键词
    const companyKw = /(?:公司|有限|集团|科技|实业|贸易|电子|光电|照明|电气|机械|化工|建材|Co\.|Ltd\.|Inc\.|Corp\.|GmbH|S\.A\.|B\.V\.|Pte\.|Pty\.|LLC|Group|Technology|Trading|Electronics|Lighting|Electric|Machinery|Manufacturing|Import|Export)/i;

    // 3a. 提取邮箱（未标记行中的独立邮箱）
    if (!info.email) {
      for (const item of unmarkedLines) {
        const emailMatch = item.line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        if (emailMatch) {
          info.email = emailMatch[1];
          usedLines.add(item.idx);
          break;
        }
      }
    }
    // 收集多余邮箱
    unmarkedLines.forEach(item => {
      if (usedLines.has(item.idx)) return;
      const emailMatch = item.line.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (emailMatch && emailMatch[1] !== info.email) {
        extraInfo.push({ type: 'email', value: '其他邮箱: ' + emailMatch[1] });
        usedLines.add(item.idx);
      }
    });

    // 3b. 提取电话（未标记行中的独立电话号码）
    if (!info.phone) {
      for (const item of unmarkedLines) {
        if (usedLines.has(item.idx)) continue;
        const phoneMatch = item.line.match(/((?:\+?\d{1,4}[-\s]?)?\(?\d{2,4}\)?[-\s]?\d{3,4}[-\s]?\d{3,4})/);
        if (phoneMatch) {
          info.phone = cleanPhone(phoneMatch[1]);
          usedLines.add(item.idx);
          break;
        }
      }
    }

    // 3c. 提取网址
    for (const item of unmarkedLines) {
      if (usedLines.has(item.idx)) continue;
      const webMatch = item.line.match(/(?:https?:\/\/|www\.)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*/i);
      if (webMatch) {
        extraInfo.push({ type: 'web', value: '网址: ' + webMatch[0] });
        usedLines.add(item.idx);
      }
    }

    // 3d. 提取地址（含地址关键词的行，排除公司名行）
    if (!info.address) {
      const addrKw = /省|市|区|镇|工业区|栋|县|路|街|号|楼|室|Room|Floor|Building|Road|Street|District|Zone|Industrial|Park|No\.|Zip|Post|开发区|工业园|科技园|产业|商务|大厦|广场|中心|小区|花园|新城|国际|公寓|酒店|商城|市场|口岸|港口|码头|机场|车站/i;
      const addrLines = [];
      let lastAddrIdx = -2;
      for (const item of unmarkedLines) {
        if (usedLines.has(item.idx)) continue;
        if (addrKw.test(item.line) && item.line.length >= 3) {
          // 排除公司名行
          if (companyKw.test(item.line)) continue;
          if (addrLines.length === 0 || Math.abs(item.idx - lastAddrIdx) <= 2) {
            addrLines.push(item.line);
            usedLines.add(item.idx);
            lastAddrIdx = item.idx;
          } else if (addrLines.length > 0) break;
        }
      }
      if (addrLines.length > 0) info.address = addrLines.join(' ').substring(0, 300);
    }

    // 3e. 提取公司名（含公司关键词的行）
    if (!info.name) {
      for (const item of unmarkedLines) {
        if (usedLines.has(item.idx)) continue;
        if (companyKw.test(item.line) && item.line.length >= 3 && item.line.length <= 120) {
          info.name = item.line;
          usedLines.add(item.idx);
          break;
        }
      }
    }

    // 3f. 提取联系人+职位拆分（处理"张三 销售经理"同行情况）
    if (!info.contact_person) {
      for (const item of unmarkedLines) {
        if (usedLines.has(item.idx)) continue;
        const line = item.line;

        // 中文姓名+职位同行：如"张三 销售经理"、"李四 副总经理"
        const cnNamePosMatch = line.match(/^([\u4e00-\u9fa5]{2,4})\s+([\u4e00-\u9fa5]+(?:经理|总监|主管|工程师|主任|专员|助理|代表|秘书|顾问|总裁|厂长))$/);
        if (cnNamePosMatch) {
          info.contact_person = cnNamePosMatch[1];
          if (!info.contact_position) info.contact_position = cnNamePosMatch[2];
          usedLines.add(item.idx);
          break;
        }

        // 英文姓名+职位同行
        const enNamePosMatch = line.match(/^((?:Mr\.|Mrs\.|Ms\.|Miss\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+((?:Sales|Marketing|General|Senior|Junior|Chief|Regional|Area|Business|Technical|Product|Project|Export|Import|Purchasing|Quality|Production|Operations|Finance|HR|Admin|After-sales|Service|R&D|Design)[A-Za-z\s]*(?:Manager|Director|Engineer|Supervisor|Assistant|Specialist|Coordinator|Consultant|Officer|Executive|President|Representative|Head|Leader))$/i);
        if (enNamePosMatch) {
          info.contact_person = enNamePosMatch[1].trim();
          if (!info.contact_position) info.contact_position = enNamePosMatch[2].trim();
          usedLines.add(item.idx);
          break;
        }

        // 英文名: Mr./Mrs./Ms. + 名字
        const enNameMatch = line.match(/^(?:Mr\.|Mrs\.|Ms\.|Miss)\s*([a-zA-Z\s]{2,20})$/i);
        if (enNameMatch) {
          info.contact_person = enNameMatch[0].trim();
          usedLines.add(item.idx);
          break;
        }
        // 中文名: 2-4个纯中文字
        const cnNameMatch = line.match(/^([\u4e00-\u9fa5]{2,4})$/);
        if (cnNameMatch) {
          info.contact_person = cnNameMatch[1];
          usedLines.add(item.idx);
          break;
        }
        // 英文全名: 2-3个英文单词，首字母大写
        const enFullName = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})$/);
        if (enFullName) {
          info.contact_person = enFullName[1];
          usedLines.add(item.idx);
          break;
        }
        // 中文名+英文名组合
        const mixedName = line.match(/^([\u4e00-\u9fa5]{2,4}(?:\s+[A-Z][a-z]+)?)$/);
        if (mixedName && !companyKw.test(line)) {
          info.contact_person = mixedName[1];
          usedLines.add(item.idx);
          break;
        }
      }
    }

    // 3g. 提取职位（含职位关键词的行）
    if (!info.contact_position) {
      for (const item of unmarkedLines) {
        if (usedLines.has(item.idx)) continue;
        if (posKw.test(item.line) && item.line.length <= 50) {
          info.contact_position = item.line;
          usedLines.add(item.idx);
          break;
        }
      }
    }

    // 3h. 启发式公司名（仍未找到时，取名片顶部未标记行）
    if (!info.name) {
      for (const item of unmarkedLines) {
        if (usedLines.has(item.idx)) continue;
        const line = item.line;
        if (line.length < 3 || line.length > 80) continue;
        if (/^\d+$/.test(line)) continue;
        if (line.includes('@')) continue;
        if (/^\+?\d/.test(line) && line.replace(/[\d\s\-+()]/g, '').length < 3) continue;
        if (/^[\u4e00-\u9fa5]{2,4}$/.test(line) && item.idx > 2) continue;
        info.name = line;
        usedLines.add(item.idx);
        break;
      }
    }

    // ===== 第四步：后处理 =====
    // 手机和WhatsApp号码去重
    if (info.whatsapp && info.phone) {
      const phoneDigits = info.phone.replace(/[^\d]/g, '');
      const waDigits = info.whatsapp.replace(/[^\d]/g, '');
      if (phoneDigits.length >= 8 && waDigits.length >= 8) {
        const phoneTail = phoneDigits.slice(-8);
        const waTail = waDigits.slice(-8);
        if (phoneTail === waTail) {
          info.whatsapp = '';
        }
      }
    }

    // 从邮箱域名推断国家
    if (!info.country_region && info.email) {
      const domainCountryMap = {
        '.de': '德国', '.fr': '法国', '.it': '意大利', '.es': '西班牙',
        '.nl': '荷兰', '.pl': '波兰', '.ru': '俄罗斯', '.uk': '英国',
        '.br': '巴西', '.in': '印度', '.jp': '日本', '.kr': '韩国',
        '.au': '澳大利亚', '.ca': '加拿大', '.mx': '墨西哥',
        '.tr': '土耳其', '.sa': '沙特阿拉伯', '.ae': '阿联酋',
        '.za': '南非', '.eg': '埃及', '.th': '泰国', '.vn': '越南',
        '.id': '印尼', '.my': '马来西亚', '.ph': '菲律宾', '.sg': '新加坡'
      };
      for (const [suffix, country] of Object.entries(domainCountryMap)) {
        if (info.email.endsWith(suffix)) { info.country_region = country; break; }
      }
    }

    // 推断销售模式
    if (/外贸|Export|Import|Overseas|International/i.test(text)) {
      info.sales_mode = '外贸';
    } else if (/内销|Domestic|国内/i.test(text)) {
      info.sales_mode = '内销';
    }

    // ===== 第五步：组装备注 =====
    const remarkParts = extraInfo.map(e => e.value);
    if (remarkParts.length > 0) {
      info.remarks = (info.remarks ? info.remarks + '; ' : '') + remarkParts.join('; ');
    }
    if (info.remarks) info.remarks = info.remarks.substring(0, 300);

    res.json({ message: '识别完成', data: info });
  } catch (e) {
    console.error('OCR识别失败:', e.message);
    res.status(500).json({ error: '识别失败: ' + e.message });
  }
});

// ===== 文本测试接口（不需要图片，直接传OCR文本测试解析） =====
router.post('/ocr-test', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '请提供text字段' });

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const info = {
    name: '', former_name: '', contact_person: '', contact_position: '',
    decision_maker: '', phone: '', email: '', address: '',
    wechat: '', whatsapp: '', skype: '', other_im: '',
    country_region: '', sales_mode: '', customer_source: '拍照导入',
    invoice_title: '', remarks: '', raw_text: text
  };

  const usedLines = new Set();
  const lineLabels = [
    { regex: /^(?:手机|Mob(?:ile)?|Cell)[:\s：.]+(.+)/i, field: 'phone', type: 'mobile' },
    { regex: /^(?:电话|Tel(?:ephone)?|Phone|固话|座机|热线)[:\s：.]+(.+)/i, field: 'phone', type: 'tel' },
    { regex: /^(?:传真|Fax)[:\s：.]+(.+)/i, field: '_fax', type: 'fax' },
    { regex: /^(?:联系人|对接人|姓名|Name|Contact|Attn)[:\s：.]+(.+)/i, field: 'contact_person', type: 'contact' },
    { regex: /^(?:职位|职务|Position|Title|Job)[:\s：.]+(.+)/i, field: 'contact_position', type: 'position' },
    { regex: /^(?:邮箱|Email|E-mail|Mail)[:\s：.]+(.+)/i, field: 'email', type: 'email' },
    { regex: /^(?:微信|WeChat|Wechat|VX)[:\s：.]+(.+)/i, field: 'wechat', type: 'wechat' },
    { regex: /^(?:WhatsApp|Whatsapp|WA)[:\s：.]+(.+)/i, field: 'whatsapp', type: 'whatsapp' },
    { regex: /^(?:Skype|skype)[:\s：.]+(.+)/i, field: 'skype', type: 'skype' },
    { regex: /^(?:地\s*址|Addr(?:ess)?|厂\s*址|公司地址|办公地址|Add)[:\s：.]+(.+)/i, field: 'address', type: 'address' },
    { regex: /^(?:公司|Company|Co\.|公司名称)[:\s：.]+(.+)/i, field: 'name', type: 'company' },
    { regex: /^(?:国家|地区|Country|Region|Nation)[:\s：.]+(.+)/i, field: 'country_region', type: 'country' },
    { regex: /^(?:开票|发票|抬头|Invoice|Tax)[:\s：.]+(.+)/i, field: 'invoice_title', type: 'invoice' },
    { regex: /^(?:网址|Web|Website|Site|Http|WWW)[:\s：.]+(.+)/i, field: '_web', type: 'web' },
  ];

  const matched = {};
  const extraInfo = [];
  const debugLog = [];

  // 职位关键词（用于拆分"姓名+职位"同行）
  const posKw = /(?:总经理|副总经理|总监|经理|主管|工程师|主任|专员|助理|代表|秘书|顾问|VP|CEO|CTO|COO|CFO|Manager|Director|Engineer|Supervisor|Assistant|Representative|Consultant|President|Executive)/i;
  // 公司关键词
  const companyKw = /(?:公司|有限|集团|科技|实业|贸易|电子|光电|照明|电气|机械|化工|建材|Co\.|Ltd\.|Inc\.|Corp\.|GmbH|S\.A\.|B\.V\.|Pte\.|Pty\.|LLC|Group|Technology|Trading|Electronics|Lighting|Electric|Machinery|Manufacturing|Import|Export)/i;

  // ===== 第一步：标签+值配对 =====
  lines.forEach((line, idx) => {
    for (const label of lineLabels) {
      const m = line.match(label.regex);
      if (m) {
        const value = m[1].trim();
        if (!matched[label.type]) {
          matched[label.type] = { value, lineIdx: idx, field: label.field };
        } else {
          extraInfo.push({ type: label.type, value, line: line });
        }
        usedLines.add(idx);
        debugLog.push(`[行${idx}] 标签匹配: ${label.type} = "${value}" (原文: "${line}")`);
        break;
      }
    }
  });

  // ===== 第二步：独占标签检测（标签一行，值在下一行） =====
  const soloLabelPatterns = [
    { regex: /^地\s*址$/i, type: 'address' },
    { regex: /^Addr(?:ess)?$/i, type: 'address' },
    { regex: /^Add$/i, type: 'address' },
    { regex: /^联\s*系\s*人$/i, type: 'contact' },
    { regex: /^Name$/i, type: 'contact' },
    { regex: /^电\s*话$/i, type: 'tel' },
    { regex: /^Tel(?:ephone)?$/i, type: 'tel' },
    { regex: /^Phone$/i, type: 'tel' },
    { regex: /^手\s*机$/i, type: 'mobile' },
    { regex: /^Mob(?:ile)?$/i, type: 'mobile' },
    { regex: /^邮\s*箱$/i, type: 'email' },
    { regex: /^Email$/i, type: 'email' },
    { regex: /^E-mail$/i, type: 'email' },
    { regex: /^传\s*真$/i, type: 'fax' },
    { regex: /^Fax$/i, type: 'fax' },
    { regex: /^微\s*信$/i, type: 'wechat' },
    { regex: /^公\s*司$/i, type: 'company' },
  ];

  lines.forEach((line, idx) => {
    if (usedLines.has(idx)) return;
    for (const p of soloLabelPatterns) {
      if (p.regex.test(line)) {
        if (idx + 1 < lines.length && !usedLines.has(idx + 1)) {
          const nextLine = lines[idx + 1].trim();
          if (nextLine.length > 0 && !matched[p.type]) {
            matched[p.type] = { value: nextLine, lineIdx: idx + 1, field: '' };
            usedLines.add(idx);
            usedLines.add(idx + 1);
            debugLog.push(`[行${idx}] 独占标签: ${p.type}, 下一行值: "${nextLine}"`);
          }
        }
        break;
      }
    }
  });

  // ===== 第三步：处理matched结果 =====
  // 手机优先座机
  if (matched.mobile) info.phone = cleanPhone(matched.mobile.value);
  else if (matched.tel) info.phone = cleanPhone(matched.tel.value);
  // 座机也保存到备注（如果手机和座机都有）
  if (matched.mobile && matched.tel) {
    info.remarks = (info.remarks ? info.remarks + '; ' : '') + '座机: ' + cleanPhone(matched.tel.value);
  }
  if (matched.contact) info.contact_person = matched.contact.value;
  if (matched.position) info.contact_position = matched.position.value;
  if (matched.email) info.email = matched.email.value;
  if (matched.wechat) info.wechat = matched.wechat.value;
  if (matched.whatsapp) info.whatsapp = cleanPhone(matched.whatsapp.value);
  if (matched.skype) info.skype = matched.skype.value;
  if (matched.address) {
    const addrLines = [matched.address.value];
    const addrIdx = matched.address.lineIdx;
    for (let i = addrIdx + 1; i < lines.length && i <= addrIdx + 5; i++) {
      if (usedLines.has(i)) break;
      if (!/^(?:电话|手机|Tel|Phone|Email|微信|WeChat|WhatsApp|Skype|传真|Fax|联系人|Name|职位|Position|公司|Company|网址|Web|Http)/i.test(lines[i])) {
        addrLines.push(lines[i]);
        usedLines.add(i);
      } else break;
    }
    info.address = addrLines.join(' ').substring(0, 300);
  }
  if (matched.country) info.country_region = matched.country.value;
  if (matched.invoice) info.invoice_title = matched.invoice.value;
  if (matched.company) info.name = matched.company.value;

  // ===== 第四步：未标记行处理 =====
  const unmarkedLines = [];
  lines.forEach((line, idx) => {
    if (!usedLines.has(idx)) unmarkedLines.push({ line, idx });
  });
  debugLog.push(`未标记行: ${JSON.stringify(unmarkedLines.map(i => `[${i.idx}]${i.line}`))}`);

  // 4a: 邮箱（未标记行中的邮箱格式）
  if (!info.email) {
    for (const item of unmarkedLines) {
      if (usedLines.has(item.idx)) continue;
      const emailMatch = item.line.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
      if (emailMatch) { info.email = emailMatch[0]; usedLines.add(item.idx); break; }
    }
  }

  // 4b: 电话号码（未标记行中的电话格式）
  if (!info.phone) {
    for (const item of unmarkedLines) {
      if (usedLines.has(item.idx)) continue;
      const phoneMatch = item.line.match(/^[\+]?[\d\s\-()]{7,20}$/);
      if (phoneMatch) { info.phone = cleanPhone(item.line); usedLines.add(item.idx); break; }
    }
  }

  // 4c: 网址
  for (const item of unmarkedLines) {
    if (usedLines.has(item.idx)) continue;
    if (/^https?:\/\//i.test(item.line) || /^www\./i.test(item.line)) {
      usedLines.add(item.idx);
    }
  }

  // 4d: 地址（关键词匹配，排除公司名行）
  if (!info.address) {
    const addrKw = /省|市|区|镇|工业区|栋|县|路|街|号|楼|室|Room|Floor|Building|Road|Street|District|Zone|Industrial|Park|No\.|Zip|Post|开发区|工业园|科技园|产业|商务|大厦|广场|中心|小区|花园|新城|国际|公寓|酒店|商城|市场|口岸|港口|码头|机场|车站/i;
    const addrLines = [];
    let lastAddrIdx = -2;
    for (const item of unmarkedLines) {
      if (usedLines.has(item.idx)) continue;
      if (addrKw.test(item.line) && item.line.length >= 3) {
        // 排除公司名行
        if (companyKw.test(item.line)) {
          debugLog.push(`[行${item.idx}] 地址关键词匹配但含公司关键词，跳过: "${item.line}"`);
          continue;
        }
        if (addrLines.length === 0 || Math.abs(item.idx - lastAddrIdx) <= 2) {
          addrLines.push(item.line);
          usedLines.add(item.idx);
          lastAddrIdx = item.idx;
          debugLog.push(`[行${item.idx}] 地址匹配: "${item.line}"`);
        } else if (addrLines.length > 0) break;
      }
    }
    if (addrLines.length > 0) info.address = addrLines.join(' ').substring(0, 300);
  }

  // 4e: 公司名
  if (!info.name) {
    for (const item of unmarkedLines) {
      if (usedLines.has(item.idx)) continue;
      if (companyKw.test(item.line) && item.line.length >= 3 && item.line.length <= 120) {
        info.name = item.line;
        usedLines.add(item.idx);
        break;
      }
    }
  }

  // 4f: 联系人+职位拆分（关键改进：处理"张三 销售经理"同行情况）
  if (!info.contact_person) {
    for (const item of unmarkedLines) {
      if (usedLines.has(item.idx)) continue;
      const line = item.line;

      // 中文姓名+职位同行：如"张三 销售经理"、"李四 副总经理"
      const cnNamePosMatch = line.match(/^([\u4e00-\u9fa5]{2,4})\s+([\u4e00-\u9fa5]+(?:经理|总监|主管|工程师|主任|专员|助理|代表|秘书|顾问|总裁|厂长))$/);
      if (cnNamePosMatch) {
        info.contact_person = cnNamePosMatch[1];
        if (!info.contact_position) info.contact_position = cnNamePosMatch[2];
        usedLines.add(item.idx);
        debugLog.push(`[行${item.idx}] 联系人+职位拆分: 姓名="${cnNamePosMatch[1]}", 职位="${cnNamePosMatch[2]}"`);
        break;
      }

      // 英文姓名+职位同行：如"Zhang San Sales Manager"
      const enNamePosMatch = line.match(/^((?:Mr\.|Mrs\.|Ms\.|Miss\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+((?:Sales|Marketing|General|Senior|Junior|Chief|Regional|Area|Business|Technical|Product|Project|Export|Import|Purchasing|Quality|Production|Operations|Finance|HR|Admin|After-sales|Service|R&D|Design)[A-Za-z\s]*(?:Manager|Director|Engineer|Supervisor|Assistant|Specialist|Coordinator|Consultant|Officer|Executive|President|Representative|Head|Leader))$/i);
      if (enNamePosMatch) {
        info.contact_person = enNamePosMatch[1].trim();
        if (!info.contact_position) info.contact_position = enNamePosMatch[2].trim();
        usedLines.add(item.idx);
        debugLog.push(`[行${item.idx}] 英文联系人+职位拆分: 姓名="${enNamePosMatch[1]}", 职位="${enNamePosMatch[2]}"`);
        break;
      }

      // 纯中文名
      const cnNameMatch = line.match(/^([\u4e00-\u9fa5]{2,4})$/);
      if (cnNameMatch) { info.contact_person = cnNameMatch[1]; usedLines.add(item.idx); break; }

      // 英文称呼+名
      const enNameMatch = line.match(/^(?:Mr\.|Mrs\.|Ms\.|Miss)\s*([a-zA-Z\s]{2,20})$/i);
      if (enNameMatch) { info.contact_person = enNameMatch[0].trim(); usedLines.add(item.idx); break; }

      // 英文全名
      const enFullName = line.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})$/);
      if (enFullName) { info.contact_person = enFullName[1]; usedLines.add(item.idx); break; }

      // 中文名+英文名
      const mixedName = line.match(/^([\u4e00-\u9fa5]{2,4}(?:\s+[A-Z][a-z]+)?)$/);
      if (mixedName && !companyKw.test(line)) {
        info.contact_person = mixedName[1]; usedLines.add(item.idx); break;
      }
    }
  }

  // 4g: 职位（未标记行中独立的职位行）
  if (!info.contact_position) {
    for (const item of unmarkedLines) {
      if (usedLines.has(item.idx)) continue;
      if (posKw.test(item.line) && item.line.length <= 50) {
        info.contact_position = item.line; usedLines.add(item.idx); break;
      }
    }
  }

  // 4h: 兜底公司名
  if (!info.name) {
    for (const item of unmarkedLines) {
      if (usedLines.has(item.idx)) continue;
      const line = item.line;
      if (line.length < 3 || line.length > 80) continue;
      if (/^\d+$/.test(line)) continue;
      if (line.includes('@')) continue;
      if (/^\+?\d/.test(line) && line.replace(/[\d\s\-+()]/g, '').length < 3) continue;
      if (/^[\u4e00-\u9fa5]{2,4}$/.test(line) && item.idx > 2) continue;
      info.name = line; usedLines.add(item.idx); break;
    }
  }

  // ===== 第五步：后处理 =====
  // 手机和WhatsApp号码去重
  if (info.whatsapp && info.phone) {
    const phoneDigits = info.phone.replace(/[^\d]/g, '');
    const waDigits = info.whatsapp.replace(/[^\d]/g, '');
    // 如果WhatsApp号码和手机号后8位以上相同，清空WhatsApp避免重复
    if (phoneDigits.length >= 8 && waDigits.length >= 8) {
      const phoneTail = phoneDigits.slice(-8);
      const waTail = waDigits.slice(-8);
      if (phoneTail === waTail) {
        debugLog.push(`WhatsApp号码与手机号重复，清空WhatsApp: ${info.whatsapp}`);
        info.whatsapp = '';
      }
    }
  }

  // 从邮箱域名推断国家
  if (!info.country_region && info.email) {
    const domainCountryMap = {
      '.de': '德国', '.fr': '法国', '.it': '意大利', '.es': '西班牙',
      '.nl': '荷兰', '.pl': '波兰', '.ru': '俄罗斯', '.uk': '英国',
      '.br': '巴西', '.in': '印度', '.jp': '日本', '.kr': '韩国',
      '.au': '澳大利亚', '.ca': '加拿大', '.mx': '墨西哥',
      '.tr': '土耳其', '.sa': '沙特阿拉伯', '.ae': '阿联酋',
      '.za': '南非', '.eg': '埃及', '.th': '泰国', '.vn': '越南',
      '.id': '印尼', '.my': '马来西亚', '.ph': '菲律宾', '.sg': '新加坡'
    };
    for (const [suffix, country] of Object.entries(domainCountryMap)) {
      if (info.email.endsWith(suffix)) { info.country_region = country; break; }
    }
  }

  // 推断销售模式
  if (!info.sales_mode) {
    if (/外贸|Export|Import|Overseas|International/i.test(text)) {
      info.sales_mode = '外贸';
    } else if (/内销|Domestic|国内/i.test(text)) {
      info.sales_mode = '内销';
    }
  }

  if (info.remarks) info.remarks = info.remarks.substring(0, 300);

  res.json({ message: '解析完成', data: info, debug: debugLog, lines: lines });
});

// 清理电话号码格式
function cleanPhone(str) {
  if (!str) return '';
  return str.replace(/[^\d+\-()\s]/g, '').trim();
}

// ===== 批量删除客户 - 必须在 /:id 之前 =====
router.post('/batch-delete', requirePerm('customer:delete'), (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要删除的客户' });
  }

  const table = getTable('customers');
  let deleted = 0;
  ids.forEach(id => {
    const existing = table.findById(id);
    if (existing) {
      table.delete(id);
      deleted++;
    }
  });

  res.json({ message: `批量删除完成，成功 ${deleted} 条`, deleted });
});

router.get('/search-by-code', requirePerm('customer:view'), (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 1) return res.json([]);
  const table = getTable('customers');
  const kw = q.trim().toLowerCase();
  const results = table.all().filter(c => {
    if (!c.customer_code) return false;
    return c.customer_code.toLowerCase().includes(kw) || (c.name && c.name.toLowerCase().includes(kw));
  }).slice(0, 20).map(c => ({
    customer_code: c.customer_code,
    name: c.name,
    country_region: c.country_region || '',
    customer_source: c.customer_source || c.source || '',
    sales_person: c.sales_person || '',
    contact_person: c.contact_person || c.contact || '',
    phone: c.phone || '',
    email: c.email || ''
  }));
  res.json(results);
});

router.get('/generate-code', requirePerm('customer:view'), (req, res) => {
  const table = getTable('customers');
  const existingCodes = table.all().map(c => c.customer_code).filter(c => c);
  const prefix = 'KH';
  let maxNum = 0;
  existingCodes.forEach(code => {
    const m = code.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) maxNum = Math.max(maxNum, parseInt(m[1]));
  });
  const nextNum = maxNum + 1;
  const newCode = `${prefix}${String(nextNum).padStart(4, '0')}`;
  res.json({ code: newCode });
});

// 创建客户
router.post('/', requirePerm('customer:create'), (req, res) => {
  const { name, customer_code } = req.body;
  if (!name) return res.status(400).json({ error: '客户名称为必填项' });

  const table = getTable('customers');
  const existing = table.all().find(c => c.name === name || (customer_code && c.customer_code === customer_code));
  if (existing) return res.status(400).json({ error: '客户名称或编号已存在' });

  const record = { created_at: now(), updated_at: now() };
  CUSTOMER_FIELDS.forEach(f => {
    record[f] = req.body[f] || '';
  });
  if (!record.customer_code) record.customer_code = '';
  if (!record.sales_mode) record.sales_mode = '外销';
  if (!record.customer_status) record.customer_status = '潜在客户';

  // 数据权限相关字段
  const operatorId = Number(req.body.user_id || req.headers['x-user-id'] || req.headers['x-user']) || null;
  if (operatorId) {
    record.create_by = operatorId;
    // 若前端未指定 owner_id / department_id，则默认为创建人
    if (record.owner_id === undefined || record.owner_id === '') {
      record.owner_id = operatorId;
    }
    if ((!record.sales_person) && operatorId) {
      const operatorUser = getTable('users').findById(operatorId);
      record.sales_person = operatorUser ? (operatorUser.name || operatorUser.username) : '';
    }
  }
  if ((record.department_id === undefined || record.department_id === '' || record.department_id == null) && record.owner_id) {
    const personnel = getTable('org_personnel').all().find(p => Number(p.linked_user_id) === Number(record.owner_id));
    if (personnel && personnel.department_id) {
      record.department_id = Number(personnel.department_id);
    }
  }

  const result = table.insert(record);
  const created = table.findById(result.lastID);

  logDataPermission(req, 'customer.create', { table: 'customers', record_id: created.id, scope_mode: 'self' });

  // 通知所有PC端客户端数据变更
  const broadcast = req.app.get('broadcastDataChange');
  if (broadcast) broadcast('customers', 'create', created);

  res.json({ message: '客户创建成功', data: created });
});

router.get('/export', requirePerm('customer:view'), (req, res) => {
  const { keyword, customer_level, sales_mode, customer_status, sales_person, ids } = req.query;
  const table = getTable('customers');
  const filter = (r) => {
    if (ids) {
      const idList = ids.split(',').map(Number);
      return idList.includes(r.id);
    }
    if (customer_level && r.customer_level !== customer_level) return false;
    if (sales_mode && r.sales_mode !== sales_mode) return false;
    if (customer_status && r.customer_status !== customer_status) return false;
    if (sales_person && r.sales_person !== sales_person) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const searchStr = [
        r.name, r.customer_code, r.former_name, r.contact_person,
        r.decision_maker, r.phone, r.email, r.sales_person, r.remarks
      ].join(' ').toLowerCase();
      if (!searchStr.includes(kw)) return false;
    }
    return true;
  };
  const records = table.all().filter(filter);

  const headers = ['客户编号','客户全称','客户曾用名','母公司编号','决策人姓名','决策人职位','决策核心诉求','普通对接人','对接人职位','联系电话(含区号)','对接邮箱','微信号','WhatsApp','Skype','其他即时联系方式','客户等级','销售模式','客户状态','所属业务员','最后交易年份','开票抬头','纳税人识别号','开户银行','银行账号','地址','国家/地区','客户来源','备注说明'];
  const fieldOrder = CUSTOMER_FIELDS;

  const rows = records.map(r => fieldOrder.map(f => r[f] || ''));
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length * 2, 12) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '客户资料');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const dateStr = new Date().toISOString().substring(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(`客户资料导出_${dateStr}.xlsx`));
  res.send(buf);
});

// ===== 客户多维度分析仪表盘 =====  必须在 /:id 之前
router.get('/analytics', requirePerm('customer:view'), (req, res) => {
  const { sales_person, customer_level, customer_status, sales_mode, customer_source, country_region } = req.query;
  const allCustomers = getTable('customers').all();

  // 多维度过滤
  const dimensionFilter = (r) => {
    if (sales_person && r.sales_person !== sales_person) return false;
    if (customer_level) {
      const lv = (r.customer_level || '').trim();
      if (lv !== customer_level && !lv.includes(customer_level)) return false;
    }
    if (customer_status && r.customer_status !== customer_status) return false;
    if (sales_mode && r.sales_mode !== sales_mode) return false;
    if (customer_source && r.customer_source !== customer_source) return false;
    if (country_region && r.country_region !== country_region) return false;
    return true;
  };
  const customers = sales_person || customer_level || customer_status || sales_mode || customer_source || country_region
    ? allCustomers.filter(dimensionFilter) : allCustomers;

  // 按某字段聚合计数
  const groupBy = (arr, field) => {
    const m = {};
    arr.forEach(r => {
      const v = (r[field] || '').toString().trim();
      if (v) m[v] = (m[v] || 0) + 1;
    });
    return m;
  };
  // 对象转有序数组（按值降序）
  const toSorted = (m, limit) => Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit || 9999)
    .map(([label, value]) => ({ label, value }));

  // 过滤后的客户名集合（用于关联表筛选）
  const customerNames = new Set(customers.map(c => c.name).filter(Boolean));

  const byLevelRaw = groupBy(customers, 'customer_level');
  // 规范化客户等级（合并 A/B/C/D 的各种写法），便于图表展示
  const normLevel = (v) => {
    const s = String(v || '').replace(/\s+/g, '');
    if (s.includes('A级') || /^A/.test(s) && !/B|C|D/.test(s)) return 'A级（核心大客户）';
    if (s.includes('B级') || /^B/.test(s) && !/C|D/.test(s)) return 'B级（普通大客户）';
    if (s.includes('C级') || /^C/.test(s) && !/D/.test(s)) return 'C级（中小客户）';
    if (s.includes('D级') || /^D/.test(s)) return 'D级（新客/休眠客）';
    return s || '未分级';
  };
  const byLevel = {};
  Object.entries(byLevelRaw).forEach(([k, v]) => {
    const nk = normLevel(k);
    byLevel[nk] = (byLevel[nk] || 0) + v;
  });
  const byStatus = groupBy(customers, 'customer_status');
  const byMode = groupBy(customers, 'sales_mode');
  const bySource = groupBy(customers, 'customer_source');
  const byRegion = groupBy(customers, 'country_region');
  const bySales = groupBy(customers, 'sales_person');

  // 询价聚合（按 customer_name 关联）
  const bizNames = new Set(); // 有任意业务往来（询价/订单/样品）的客户名并集
  const inquiry = { total: 0, byStatus: {}, customerCount: 0, topByCustomer: [] };
  try {
    const inqByCust = {};
    getTable('inquiries').all().forEach(i => {
      const cn = (i.customer_name || '').toString().trim();
      if (customerNames.size && !customerNames.has(cn)) return;
      inquiry.total++;
      const st = i.status || 'unknown';
      inquiry.byStatus[st] = (inquiry.byStatus[st] || 0) + 1;
      if (cn) { inqByCust[cn] = (inqByCust[cn] || 0) + 1; bizNames.add(cn); }
    });
    inquiry.customerCount = Object.keys(inqByCust).length;
    inquiry.topByCustomer = Object.entries(inqByCust)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([label, value]) => ({ label, value }));
  } catch (e) { console.error('analytics inquiry:', e.message); }

  // 订单聚合
  const order = { total: 0, byStatus: {}, totalAmount: 0, customerCount: 0, topByCustomer: [] };
  try {
    const amtByCust = {};
    getTable('orders').all().forEach(o => {
      const cn = (o.customer_name || '').toString().trim();
      if (customerNames.size && !customerNames.has(cn)) return;
      order.total++;
      const st = o.status || 'unknown';
      order.byStatus[st] = (order.byStatus[st] || 0) + 1;
      order.totalAmount += Number(o.order_amount) || 0;
      if (cn) { amtByCust[cn] = (amtByCust[cn] || 0) + (Number(o.order_amount) || 0); bizNames.add(cn); }
    });
    order.customerCount = Object.keys(amtByCust).length;
    order.topByCustomer = Object.entries(amtByCust)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([label, value]) => ({ label, value: Math.round(value) }));
    order.totalAmount = Math.round(order.totalAmount);
  } catch (e) { console.error('analytics order:', e.message); }

  // 样品聚合
  const sample = { total: 0, byStatus: {}, customerCount: 0 };
  try {
    const custSet = new Set();
    getTable('samples').all().forEach(s => {
      const cn = (s.customer_name || '').toString().trim();
      if (customerNames.size && !customerNames.has(cn)) return;
      sample.total++;
      const st = s.status || 'unknown';
      sample.byStatus[st] = (sample.byStatus[st] || 0) + 1;
      if (cn) { custSet.add(cn); bizNames.add(cn); }
    });
    sample.customerCount = custSet.size;
  } catch (e) { console.error('analytics sample:', e.message); }

  // 业务活跃度：有任意业务往来的客户数 / 无业务往来的客户数
  const activeBusiness = bizNames.size;
  const noBusiness = Math.max(0, customers.length - activeBusiness);

  // 关键指标
  const kpi = {
    total: customers.length,
    inquiryCustomers: inquiry.customerCount,
    orderCustomers: order.customerCount,
    sampleCustomers: sample.customerCount,
    activeCustomers: byStatus['大货合作客户'] || 0,
    activeBusiness,
    noBusiness,
    inquiryTotal: inquiry.total,
    orderTotal: order.total,
    sampleTotal: sample.total,
    orderAmount: order.totalAmount
  };

  res.json({
    kpi,
    filters: { sales_person, customer_level, customer_status, sales_mode, customer_source, country_region },
    byLevel: toSorted(byLevel),
    byStatus: toSorted(byStatus),
    byMode: toSorted(byMode),
    bySource: toSorted(bySource),
    byRegion: toSorted(byRegion, 12),
    bySales: toSorted(bySales, 12),
    inquiry, order, sample
  });
});

// ===== 客户附件（图片/文件）：上传/列表/预览/下载/删除 =====  必须在 /:id 之前
// 上传附件（文件）
router.post('/:id/attachments', attachmentUpload.single('file'), requirePerm('customer:edit'), (req, res) => {
  const table = getTable('customers');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '客户不存在' });
  if (!req.file) return res.status(400).json({ error: '请上传文件' });
  const attTable = getTable('customer_attachments');
  // 修正 multer 把 UTF-8 文件名当 Latin-1 读取导致的中文乱码
  const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const result = attTable.insert({
    customer_id: Number(req.params.id),
    type: 'file',
    file_name: fileName,
    file_path: req.file.path,
    size: req.file.size,
    mime: req.file.mimetype,
    uploaded_at: now()
  });
  res.json({ message: '上传成功', id: result.lastID, file_name: fileName, size: req.file.size });
});

// 添加链接附件（复制粘贴网址）
router.post('/:id/attachments/link', requirePerm('customer:edit'), (req, res) => {
  const table = getTable('customers');
  if (!table.findById(req.params.id)) return res.status(404).json({ error: '客户不存在' });
  const url = (req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: '请提供链接地址' });
  const attTable = getTable('customer_attachments');
  const result = attTable.insert({
    customer_id: Number(req.params.id),
    type: 'link',
    file_name: (req.body.title || '').trim() || url,
    url,
    uploaded_at: now()
  });
  res.json({ message: '添加成功', id: result.lastID, url });
});

// 附件列表
router.get('/:id/attachments', requirePerm('customer:view'), (req, res) => {
  const list = getTable('customer_attachments').all()
    .filter(a => a.customer_id === Number(req.params.id))
    .sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''))
    .map(a => {
      const isLink = a.type === 'link';
      const isImg = isLink ? /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(a.url || '') : /^image\//.test(a.mime || '');
      return { id: a.id, type: a.type || 'file', file_name: a.file_name, url: a.url || '', size: a.size, mime: a.mime, uploaded_at: a.uploaded_at, is_image: isImg, is_link: isLink };
    });
  res.json(list);
});

// 预览（图片/PDF 内联，其他直接下载）
router.get('/attachments/:attId/preview', requirePerm('customer:view'), (req, res) => {
  const att = getTable('customer_attachments').findById(req.params.attId);
  if (!att) return res.status(404).json({ error: '附件不存在' });
  if (!att.file_path || !fs.existsSync(att.file_path)) return res.status(404).json({ error: '文件已丢失' });
  const mime = att.mime || '';
  if (/^image\//.test(mime) || mime === 'application/pdf') {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(att.file_path).pipe(res);
  } else {
    res.download(att.file_path, att.file_name);
  }
});

// 下载
router.get('/attachments/:attId/download', requirePerm('customer:view'), (req, res) => {
  const att = getTable('customer_attachments').findById(req.params.attId);
  if (!att) return res.status(404).json({ error: '附件不存在' });
  if (!att.file_path || !fs.existsSync(att.file_path)) return res.status(404).json({ error: '文件已丢失' });
  res.download(att.file_path, att.file_name);
});

// 删除附件
router.delete('/attachments/:attId', requirePerm('customer:edit'), (req, res) => {
  const attTable = getTable('customer_attachments');
  const att = attTable.findById(req.params.attId);
  if (!att) return res.status(404).json({ error: '附件不存在' });
  try { if (att.file_path && fs.existsSync(att.file_path)) fs.unlinkSync(att.file_path); } catch (e) {}
  attTable.delete(req.params.attId);
  res.json({ message: '已删除' });
});

// 客户详情
router.get('/:id', requirePerm('customer:view'), (req, res) => {
  const table = getTable('customers');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '客户不存在' });
  const scope = resolveDataScopeV2(req);
  if (scope.enabled) {
    const scopeFilter = buildScopeFilter(scope, 'customers');
    let inScope = scopeFilter(row);
    if (!inScope) {
      // v1 兼容：sales_person 字符串匹配
      const scopeLegacy = resolveDataScope(req);
      if (scopeLegacy.enabled) {
        const directSp = String(row.sales_person || '').trim();
        inScope = directSp && scopeLegacy.ownerNames.has(directSp);
        if (!inScope) {
          const cn = String(row.name || '').trim();
          if (cn) {
            const inqTable = getTable('inquiries');
            inScope = inqTable.all().some(iq =>
              String(iq.customer_name || '').trim() === cn &&
              scopeLegacy.ownerNames.has(String(iq.sales_person || '').trim())
            );
          }
        }
      }
    }
    if (!inScope) return res.status(403).json({ error: '无访问该客户的权限', code: 'DATA_SCOPE_DENIED' });
  }
  logDataPermission(req, 'customer.detail', { table: 'customers', record_id: row.id, scope_mode: scope.mode || 'none' });
  res.json(row);
});

// 更新客户
router.put('/:id', requirePerm('customer:edit'), (req, res) => {
  const table = getTable('customers');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '客户不存在' });

  const fields = { updated_at: now() };
  CUSTOMER_FIELDS.forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  table.update(req.params.id, fields);
  const updated = table.findById(req.params.id);
  const broadcast = req.app.get('broadcastDataChange');
  if (broadcast) broadcast('customers', 'update', updated);
  res.json({ message: '客户更新成功' });
});

// 删除客户
router.delete('/:id', requirePerm('customer:delete'), (req, res) => {
  const table = getTable('customers');
  const result = table.delete(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '客户不存在' });
  const broadcast = req.app.get('broadcastDataChange');
  if (broadcast) broadcast('customers', 'delete', { id: parseInt(req.params.id) });
  res.json({ message: '客户删除成功' });
});

// 获取客户关联的询价单
router.get('/:id/inquiries', requirePerm('customer:view'), (req, res) => {
  const custTable = getTable('customers');
  const customer = custTable.findById(req.params.id);
  if (!customer) return res.status(404).json({ error: '客户不存在' });

  const inqTable = getTable('inquiries');
  let { records } = inqTable.findWhere(r => r.customer_name === customer.name, 'inquiry_time', 'DESC');
  const scope = resolveDataScope(req);
  if (scope.enabled) {
    records = records.filter(r => isInScope(scope, r, { ownerField: 'sales_person' }));
  }
  res.json(records);
});

// 客户管理 → 发起立项申请书（预填客户信息）
router.post('/:id/create-initiation', requirePerm('initiation:apply'), (req, res) => {
  const table = getTable('customers');
  const customer = table.findById(req.params.id);
  if (!customer) return res.status(404).json({ error: '客户不存在' });
  const initTable = getTable('rd_project_initiation');
  const b = req.body || {};
  const result = initTable.insert({
    project_no: b.project_no || '',
    project_name: b.project_name || (customer.name + ' 立项'),
    project_type: b.project_type || '客制',
    start_date: now().substring(0, 10),
    department: '研发中心',
    owner: b.owner || '',
    cooperators: '',
    other_info: '',
    // 客户信息预填
    customer_no: customer.customer_code || customer.name || '',
    customer_type: customer.customer_type || customer.sales_mode || '',
    customer_level: customer.customer_level || '',
    customer_win_rate: '',
    market_status: customer.country_region || '',
    customer_pain: '',
    key_success: '',
    has_competitor: '',
    competitor_status: '',
    purchase_cycle: '',
    dev_type: '定制开发',
    // 子表JSON空值
    product_specs: '', feasibility: '', sales_forecast: '', special_reqs: '',
    // 审批
    applicant: b.applicant || (customer.sales_person || ''),
    apply_date: now().substring(0, 10),
    approval_status: 'draft',
    approver: '', approval_date: '', approval_opinion: '',
    // 5阶段流程：发起阶段
    workflow_stage: 'apply',
    step1_applicant: b.applicant || (customer.sales_person || ''),
    step1_apply_date: now().substring(0, 10),
    remarks: '由客户管理发起（客户：' + (customer.name || '') + '）',
    created_at: now(),
    updated_at: now()
  });
  res.json({ message: '立项申请书已创建', id: result.lastID, data: initTable.findById(result.lastID) });
});

module.exports = router;
