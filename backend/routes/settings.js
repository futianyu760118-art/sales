const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('system_settings');
ensureTable('data_dictionary');

// ===== 系统配置 =====

// 获取所有系统配置
router.get('/config', requirePerm('system:config'), (req, res) => {
  const table = getTable('system_settings');
  table._invalidate();
  const all = table.all();
  // 转为 key-value 对象
  const config = {};
  all.forEach(r => {
    try { config[r.key] = JSON.parse(r.value); } catch(e) { config[r.key] = r.value; }
  });
  res.json(config);
});

// 获取单个配置
router.get('/config/:key', requirePerm('system:config'), (req, res) => {
  const table = getTable('system_settings');
  const row = table.all().find(r => r.key === req.params.key);
  if (!row) return res.json(null);
  try { res.json(JSON.parse(row.value)); } catch(e) { res.json(row.value); }
});

// 批量保存配置
router.post('/config', requirePerm('system:config'), (req, res) => {
  const table = getTable('system_settings');
  table._invalidate();
  const entries = req.body;
  if (typeof entries !== 'object') return res.status(400).json({ error: '参数必须是对象' });

  Object.entries(entries).forEach(([key, value]) => {
    const existing = table.all().find(r => r.key === key);
    const val = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (existing) {
      table.update(existing.id, { value: val, updated_at: now() });
    } else {
      table.insert({ key, value: val, created_at: now(), updated_at: now() });
    }
  });

  res.json({ message: '配置保存成功' });
});

// ===== 数据字典 =====

// 获取所有字典分组
router.get('/dictionary/groups', requirePerm('system:config'), (req, res) => {
  const table = getTable('data_dictionary');
  table._invalidate();
  const all = table.all();
  const groups = {};
  all.forEach(r => {
    if (!groups[r.group_code]) {
      groups[r.group_code] = { code: r.group_code, name: r.group_name, items: [] };
    }
    groups[r.group_code].items.push({
      id: r.id,
      code: r.item_code,
      value: r.item_value,
      sort: r.sort || 0,
      enabled: r.enabled !== 0,
      remark: r.remark || ''
    });
  });
  // 排序
  Object.values(groups).forEach(g => {
    g.items.sort((a, b) => a.sort - b.sort);
  });
  res.json(Object.values(groups));
});

// 获取单个字典分组
router.get('/dictionary/:groupCode', requirePerm('system:config'), (req, res) => {
  const table = getTable('data_dictionary');
  table._invalidate();
  const items = table.all()
    .filter(r => r.group_code === req.params.groupCode)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map(r => ({
      id: r.id,
      code: r.item_code,
      value: r.item_value,
      sort: r.sort || 0,
      enabled: r.enabled !== 0,
      remark: r.remark || ''
    }));
  res.json(items);
});

// 新增字典项
router.post('/dictionary', requirePerm('system:config'), (req, res) => {
  const { group_code, group_name, item_code, item_value, sort, enabled, remark } = req.body;
  if (!group_code || !item_value) return res.status(400).json({ error: '分组编码和选项值为必填' });

  const table = getTable('data_dictionary');
  const result = table.insert({
    group_code,
    group_name: group_name || group_code,
    item_code: item_code || '',
    item_value,
    sort: sort || 0,
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : 1,
    remark: remark || '',
    created_at: now(),
    updated_at: now()
  });
  res.json({ message: '字典项创建成功', id: result.lastID });
});

// 更新字典项
router.put('/dictionary/:id', requirePerm('system:config'), (req, res) => {
  const table = getTable('data_dictionary');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '字典项不存在' });

  const fields = { updated_at: now() };
  ['group_code', 'group_name', 'item_code', 'item_value', 'sort', 'remark'].forEach(f => {
    if (req.body[f] !== undefined) fields[f] = req.body[f];
  });
  if (req.body.enabled !== undefined) fields.enabled = req.body.enabled ? 1 : 0;
  table.update(req.params.id, fields);
  res.json({ message: '字典项更新成功' });
});

// 删除字典项
router.delete('/dictionary/:id', requirePerm('system:config'), (req, res) => {
  const table = getTable('data_dictionary');
  const existing = table.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: '字典项不存在' });
  table.delete(req.params.id);
  res.json({ message: '字典项删除成功' });
});

// 批量初始化默认字典数据
router.post('/dictionary/init-defaults', requirePerm('system:config'), (req, res) => {
  const table = getTable('data_dictionary');
  table._invalidate();

  const defaults = [
    // 产品品类
    { group_code: 'product_category', group_name: '产品品类', items: ['工作灯', '泛光灯', '投光灯', '隧道灯', '路灯', '工矿灯', '防爆灯', '应急灯', '手电筒', '头灯', '营地灯', '其他'] },
    // 客户来源
    { group_code: 'customer_source', group_name: '客户来源', items: ['线上', '线下', '老客户', '转介绍', '展会', '电话营销', '网络推广', '其他'] },
    { group_code: 'country_region', group_name: '国家/地区', items: ['中国', '美国', '德国', '英国', '法国', '日本', '韩国', '印度', '巴西', '俄罗斯', '澳大利亚', '加拿大', '意大利', '西班牙', '墨西哥', '印度尼西亚', '土耳其', '沙特阿拉伯', '泰国', '越南', '马来西亚', '菲律宾', '新加坡', '阿联酋', '南非', '尼日利亚', '埃及', '波兰', '荷兰', '比利时', '瑞典', '阿根廷', '智利', '哥伦比亚', '秘鲁', '巴基斯坦', '孟加拉国', '其他'] },
    // 证书等级
    { group_code: 'certificate_level', group_name: '证书等级', items: ['国标', '行标', '企标', '无证书'] },
    // 证书合规
    { group_code: 'certificate_compliant', group_name: '证书合规', items: ['是', '否'] },
    // 询价状态
    { group_code: 'inquiry_status', group_name: '询价状态', items: ['新建', '证书已选型', '配置表已生成', '待核价', '待报价', '已报价', '洽谈中', '转样品', '转项目', '已流失', '已成交'] },
    // 核价状态
    { group_code: 'pricing_status', group_name: '核价状态', items: ['待核价', '核价中', '已核价', '已过期'] },
    // 产品系列
    { group_code: 'product_series', group_name: '产品系列', items: ['S系列', 'P系列', 'T系列', 'F系列', 'L系列', 'R系列', 'M系列', '其他'] },
    // 防水等级
    { group_code: 'waterproof_level', group_name: '防水等级', items: ['IP20', 'IP44', 'IP54', 'IP65', 'IP66', 'IP67', 'IP68', 'IPX4', 'IPX6', 'IPX8'] },
    // 光源类型
    { group_code: 'light_source_type', group_name: '光源类型', items: ['SMD', 'COB', 'LED集成', '卤素灯', '荧光灯', '其他'] },
    // 开关类型
    { group_code: 'switch_type', group_name: '开关类型', items: ['ON/OFF', '调光', '感应', '遥控', '无开关', '其他'] },
    // 感应器类型
    { group_code: 'sensor_type', group_name: '感应器类型', items: ['微波感应', '红外感应', '雷达感应', '光控', '无', '其他'] },
    // 流失原因
    { group_code: 'lost_reason', group_name: '流失原因', items: ['价格过高', '客户取消', '竞争对手', '交期不满足', '技术不达标', '其他'] },
    // 币种
    { group_code: 'currency', group_name: '币种', items: ['RMB', 'USD', 'EUR', 'GBP', 'JPY'] },
    // 交货方式
    { group_code: 'delivery_method', group_name: '交货方式', items: ['快递', '物流', '自提', '海运', '空运', '其他'] },
    { group_code: 'sub_model_rule', group_name: '子型号命名规则', items: ['后缀格式:-NN', '流水号位数:2', '起始编号:01', '分隔符:-', '判断字段:power,input_voltage,battery,color_temp,luminous_flux,light_source,main_body,lampshade,reflector,cable,switch_type,usb,waterproof,sensor'] },
  ];

  let added = 0;
  defaults.forEach(group => {
    group.items.forEach((item, idx) => {
      const exists = table.all().find(r => r.group_code === group.group_code && r.item_value === item);
      if (!exists) {
        table.insert({
          group_code: group.group_code,
          group_name: group.group_name,
          item_code: `${group.group_code}_${idx + 1}`,
          item_value: item,
          sort: idx + 1,
          enabled: 1,
          remark: '',
          created_at: now(),
          updated_at: now()
        });
        added++;
      }
    });
  });

  res.json({ message: '默认字典初始化完成', added });
});

module.exports = router;
