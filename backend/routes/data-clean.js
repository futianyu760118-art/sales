const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('clean_rules');
ensureTable('clean_logs');

function getRulesTable() {
  const t = getTable('clean_rules');
  t._invalidate();
  return t;
}

function getLogsTable() {
  const t = getTable('clean_logs');
  t._invalidate();
  return t;
}

const SUPPORTED_TABLES = [
  { name: 'inquiries', label: '询价单' },
  { name: 'customers', label: '客户' },
  { name: 'products', label: '产品' },
  { name: 'materials', label: '物料' },
  { name: 'bom_pricing', label: '核价库' },
  { name: 'quote_library', label: '报价库' },
  { name: 'product_configs', label: '产品配置' },
  { name: 'quotations', label: '报价记录' },
  { name: 'operation_logs', label: '操作日志' },
  { name: 'inquiry_status_changes', label: '状态变更' },
  { name: 'customers', label: '客户' },
  { name: 'feedback', label: '问题反馈' },
  { name: 'spec_sheets', label: '规格书' },
  { name: 'config_sheets', label: '配置表' }
];

const RULE_TYPES = [
  { value: 'trim', label: '去除空白', desc: '去除字段值首尾空白字符' },
  { value: 'fill_default', label: '填充默认值', desc: '空值字段填充指定默认值' },
  { value: 'replace', label: '替换文本', desc: '将字段值中的指定文本替换为新文本' },
  { value: 'regex_replace', label: '正则替换', desc: '使用正则表达式匹配并替换' },
  { value: 'format_date', label: '格式化日期', desc: '统一日期字段格式' },
  { value: 'format_number', label: '格式化数字', desc: '统一数字字段精度和格式' },
  { value: 'deduplicate', label: '去重', desc: '按指定字段去重，保留最新/最早记录' },
  { value: 'delete_orphan', label: '清理孤立记录', desc: '删除关联字段指向不存在记录的数据行' },
  { value: 'delete_invalid', label: '删除无效记录', desc: '删除满足指定条件的无效数据' },
  { value: 'uppercase', label: '转大写', desc: '将字段值转为大写' },
  { value: 'lowercase', label: '转小写', desc: '将字段值转为小写' },
  { value: 'enum_fix', label: '枚举修正', desc: '将不在枚举范围内的值修正为指定默认值' }
];

router.get('/tables', requirePerm('data-clean:view'), (req, res) => {
  res.json(SUPPORTED_TABLES);
});

router.get('/table-fields/:tableName', requirePerm('data-clean:view'), (req, res) => {
  const tableName = req.params.tableName;
  const supported = SUPPORTED_TABLES.find(t => t.name === tableName);
  if (!supported) return res.status(400).json({ error: '不支持的数据表' });
  const table = getTable(tableName);
  const records = table.all();
  if (records.length === 0) return res.json([]);
  const fields = Object.keys(records[0]);
  const fieldStats = fields.map(f => {
    const values = records.map(r => r[f]).filter(v => v !== undefined && v !== null && v !== '');
    const emptyCount = records.length - values.length;
    const sampleValues = [...new Set(values)].slice(0, 5);
    return {
      name: f,
      type: typeof values[0] || 'undefined',
      total: records.length,
      filled: values.length,
      empty: emptyCount,
      empty_rate: records.length > 0 ? ((emptyCount / records.length) * 100).toFixed(1) + '%' : '0%',
      sample: sampleValues
    };
  });
  res.json(fieldStats);
});

router.get('/rule-types', requirePerm('data-clean:view'), (req, res) => {
  res.json(RULE_TYPES);
});

router.get('/rules', requirePerm('data-clean:view'), (req, res) => {
  const table = getRulesTable();
  let rules = table.all();
  const { table_name, enabled } = req.query;
  if (table_name) rules = rules.filter(r => r.table_name === table_name);
  if (enabled !== undefined) rules = rules.filter(r => r.enabled === (enabled === 'true'));
  rules.sort((a, b) => (a.priority || 50) - (b.priority || 50));
  res.json(rules);
});

router.get('/rules/:id', requirePerm('data-clean:view'), (req, res) => {
  const table = getRulesTable();
  const rule = table.all().find(r => r.id === Number(req.params.id));
  if (!rule) return res.status(404).json({ error: '规则不存在' });
  res.json(rule);
});

router.post('/rules', requirePerm('data-clean:execute'), (req, res) => {
  const table = getRulesTable();
  const { name, table_name, field, rule_type, params, enabled, priority, description } = req.body;
  if (!name || !table_name || !rule_type) return res.status(400).json({ error: '规则名称、数据表、规则类型为必填项' });
  const supported = SUPPORTED_TABLES.find(t => t.name === table_name);
  if (!supported) return res.status(400).json({ error: '不支持的数据表' });
  const ruleType = RULE_TYPES.find(t => t.value === rule_type);
  if (!ruleType) return res.status(400).json({ error: '不支持的规则类型' });
  const rule = {
    name,
    table_name,
    field: field || '',
    rule_type,
    params: params || {},
    enabled: enabled !== false,
    priority: priority || 50,
    description: description || '',
    created_at: now(),
    updated_at: now()
  };
  const result = table.insert(rule);
  res.json({ message: '清洗规则创建成功', data: { ...rule, id: result.lastID } });
});

router.put('/rules/:id', requirePerm('data-clean:execute'), (req, res) => {
  const table = getRulesTable();
  const id = Number(req.params.id);
  const existing = table.all().find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: '规则不存在' });
  const { name, table_name, field, rule_type, params, enabled, priority, description } = req.body;
  const updates = { updated_at: now() };
  if (name !== undefined) updates.name = name;
  if (table_name !== undefined) updates.table_name = table_name;
  if (field !== undefined) updates.field = field;
  if (rule_type !== undefined) updates.rule_type = rule_type;
  if (params !== undefined) updates.params = typeof params === 'object' ? params : JSON.parse(params);
  if (enabled !== undefined) updates.enabled = enabled;
  if (priority !== undefined) updates.priority = priority;
  if (description !== undefined) updates.description = description;
  table.update(id, updates);
  res.json({ message: '清洗规则更新成功' });
});

router.delete('/rules/:id', requirePerm('data-clean:delete'), (req, res) => {
  const table = getRulesTable();
  const id = Number(req.params.id);
  const existing = table.all().find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: '规则不存在' });
  table.delete(id);
  res.json({ message: '清洗规则已删除' });
});

function executeRule(rule, dryRun) {
  const table = getTable(rule.table_name);
  const records = table.all();
  const results = { affected: [], count: 0 };

  for (const record of records) {
    let modified = false;
    const updates = {};

    switch (rule.rule_type) {
      case 'trim': {
        const val = record[rule.field];
        if (typeof val === 'string' && val !== val.trim()) {
          updates[rule.field] = val.trim();
          modified = true;
        }
        break;
      }
      case 'fill_default': {
        const val = record[rule.field];
        if (val === undefined || val === null || val === '' || val === '/') {
          updates[rule.field] = rule.params.default_value ?? '';
          modified = true;
        }
        break;
      }
      case 'replace': {
        const val = record[rule.field];
        if (typeof val === 'string' && val.includes(rule.params.search || '')) {
          updates[rule.field] = val.replaceAll(rule.params.search, rule.params.replace || '');
          modified = true;
        }
        break;
      }
      case 'regex_replace': {
        const val = record[rule.field];
        if (typeof val === 'string' && rule.params.pattern) {
          try {
            const regex = new RegExp(rule.params.pattern, rule.params.flags || 'g');
            const newVal = val.replace(regex, rule.params.replace || '');
            if (newVal !== val) {
              updates[rule.field] = newVal;
              modified = true;
            }
          } catch (e) { /* skip invalid regex */ }
        }
        break;
      }
      case 'format_date': {
        const val = record[rule.field];
        if (val) {
          let d;
          if (typeof val === 'string') {
            d = new Date(val.replace(' ', 'T'));
            if (isNaN(d.getTime())) {
              const parts = val.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
              if (parts) d = new Date(parts[1], parts[2] - 1, parts[3]);
            }
          } else if (typeof val === 'number') {
            d = new Date(val);
          }
          if (d && !isNaN(d.getTime())) {
            const format = rule.params.format || 'YYYY-MM-DD HH:mm:ss';
            const pad = n => String(n).padStart(2, '0');
            const formatted = format
              .replace('YYYY', d.getFullYear())
              .replace('MM', pad(d.getMonth() + 1))
              .replace('DD', pad(d.getDate()))
              .replace('HH', pad(d.getHours()))
              .replace('mm', pad(d.getMinutes()))
              .replace('ss', pad(d.getSeconds()));
            if (formatted !== String(val)) {
              updates[rule.field] = formatted;
              modified = true;
            }
          }
        }
        break;
      }
      case 'format_number': {
        const val = record[rule.field];
        if (val !== undefined && val !== null && val !== '') {
          const num = Number(val);
          if (!isNaN(num)) {
            const decimals = rule.params.decimals ?? 2;
            const formatted = Number(num.toFixed(decimals));
            if (formatted !== Number(val)) {
              updates[rule.field] = formatted;
              modified = true;
            }
          }
        }
        break;
      }
      case 'deduplicate': {
        break;
      }
      case 'delete_orphan': {
        const val = record[rule.field];
        if (val && rule.params.ref_table && rule.params.ref_field) {
          try {
            const refTable = getTable(rule.params.ref_table);
            const refExists = refTable.all().some(r => String(r[rule.params.ref_field]) === String(val));
            if (!refExists) {
              updates._delete = true;
              modified = true;
            }
          } catch (e) { /* skip */ }
        }
        break;
      }
      case 'delete_invalid': {
        const val = record[rule.field];
        const condition = rule.params.condition;
        if (condition === 'empty' && (val === undefined || val === null || val === '')) {
          updates._delete = true;
          modified = true;
        } else if (condition === 'equals' && val === rule.params.value) {
          updates._delete = true;
          modified = true;
        } else if (condition === 'contains' && typeof val === 'string' && val.includes(rule.params.value || '')) {
          updates._delete = true;
          modified = true;
        }
        break;
      }
      case 'uppercase': {
        const val = record[rule.field];
        if (typeof val === 'string' && val !== val.toUpperCase()) {
          updates[rule.field] = val.toUpperCase();
          modified = true;
        }
        break;
      }
      case 'lowercase': {
        const val = record[rule.field];
        if (typeof val === 'string' && val !== val.toLowerCase()) {
          updates[rule.field] = val.toLowerCase();
          modified = true;
        }
        break;
      }
      case 'enum_fix': {
        const val = record[rule.field];
        const allowed = rule.params.allowed_values || [];
        if (allowed.length > 0 && !allowed.includes(val)) {
          updates[rule.field] = rule.params.default_value ?? allowed[0];
          modified = true;
        }
        break;
      }
    }

    if (modified) {
      results.affected.push({ id: record.id, before: { ...record }, updates: { ...updates } });
      results.count++;
      if (!dryRun) {
        if (updates._delete) {
          table.delete(record.id);
        } else {
          delete updates._delete;
          table.update(record.id, { ...updates, updated_at: now() });
        }
      }
    }
  }

  if (rule.rule_type === 'deduplicate') {
    const seen = {};
    const keep = rule.params.keep || 'latest';
    const sortedRecords = [...records].sort((a, b) => {
      const va = a[rule.field] || '';
      const vb = b[rule.field] || '';
      return keep === 'latest'
        ? (b.id - a.id)
        : (a.id - b.id);
    });
    for (const record of sortedRecords) {
      const key = String(record[rule.field] || '');
      if (seen[key]) {
        results.affected.push({ id: record.id, before: { ...record }, updates: { _delete: true } });
        results.count++;
        if (!dryRun) table.delete(record.id);
      } else {
        seen[key] = true;
      }
    }
  }

  return results;
}

router.post('/rules/preview/:id', requirePerm('data-clean:execute'), (req, res) => {
  const rulesTable = getRulesTable();
  const rule = rulesTable.all().find(r => r.id === Number(req.params.id));
  if (!rule) return res.status(404).json({ error: '规则不存在' });
  if (!rule.enabled) return res.status(400).json({ error: '规则已禁用' });
  try {
    const results = executeRule(rule, true);
    res.json({
      rule_id: rule.id,
      rule_name: rule.name,
      table_name: rule.table_name,
      affected_count: results.count,
      preview: results.affected.slice(0, 20),
      total_in_table: getTable(rule.table_name).all().length
    });
  } catch (e) {
    res.status(500).json({ error: '预览失败: ' + e.message });
  }
});

router.post('/rules/execute/:id', requirePerm('data-clean:execute'), (req, res) => {
  const rulesTable = getRulesTable();
  const rule = rulesTable.all().find(r => r.id === Number(req.params.id));
  if (!rule) return res.status(404).json({ error: '规则不存在' });
  if (!rule.enabled) return res.status(400).json({ error: '规则已禁用' });
  try {
    const results = executeRule(rule, false);
    const logEntry = {
      rule_id: rule.id,
      rule_name: rule.name,
      table_name: rule.table_name,
      affected_count: results.count,
      operator: req.headers['x-user'] || 'admin',
      executed_at: now(),
      details: JSON.stringify(results.affected.slice(0, 50))
    };
    getLogsTable().insert(logEntry);
    res.json({
      message: `清洗完成，影响${results.count}条记录`,
      rule_id: rule.id,
      rule_name: rule.name,
      affected_count: results.count,
      affected: results.affected.slice(0, 20)
    });
  } catch (e) {
    res.status(500).json({ error: '执行失败: ' + e.message });
  }
});

router.post('/execute-batch', requirePerm('data-clean:execute'), (req, res) => {
  const { table_name, rule_ids } = req.body;
  const rulesTable = getRulesTable();
  let rules;
  if (rule_ids && rule_ids.length > 0) {
    rules = rulesTable.all().filter(r => rule_ids.includes(r.id) && r.enabled);
  } else if (table_name) {
    rules = rulesTable.all().filter(r => r.table_name === table_name && r.enabled);
  } else {
    rules = rulesTable.all().filter(r => r.enabled);
  }
  rules.sort((a, b) => (a.priority || 50) - (b.priority || 50));
  const batchResults = [];
  let totalAffected = 0;
  for (const rule of rules) {
    try {
      const results = executeRule(rule, false);
      totalAffected += results.count;
      batchResults.push({ rule_id: rule.id, rule_name: rule.name, affected: results.count, status: 'success' });
      getLogsTable().insert({
        rule_id: rule.id,
        rule_name: rule.name,
        table_name: rule.table_name,
        affected_count: results.count,
        operator: req.headers['x-user'] || 'admin',
        executed_at: now(),
        details: JSON.stringify(results.affected.slice(0, 20))
      });
    } catch (e) {
      batchResults.push({ rule_id: rule.id, rule_name: rule.name, affected: 0, status: 'error', error: e.message });
    }
  }
  res.json({
    message: `批量清洗完成，共${rules.length}条规则，影响${totalAffected}条记录`,
    total_rules: rules.length,
    total_affected: totalAffected,
    results: batchResults
  });
});

router.post('/smart-scan', requirePerm('data-clean:execute'), (req, res) => {
  const { table_name } = req.body;
  if (!table_name) return res.status(400).json({ error: '请指定数据表' });
  const supported = SUPPORTED_TABLES.find(t => t.name === table_name);
  if (!supported) return res.status(400).json({ error: '不支持的数据表' });

  const table = getTable(table_name);
  const records = table.all();
  if (records.length === 0) return res.json({ suggestions: [], total: 0 });

  const suggestions = [];
  const fields = Object.keys(records[0]);

  for (const field of fields) {
    if (['id', 'created_at', 'updated_at'].includes(field)) continue;
    const values = records.map(r => r[field]);
    const emptyCount = values.filter(v => v === undefined || v === null || v === '' || v === '/').length;

    if (emptyCount > 0 && emptyCount < records.length) {
      suggestions.push({
        rule_type: 'fill_default',
        field,
        reason: `${field}有${emptyCount}条空值（占比${((emptyCount / records.length) * 100).toFixed(1)}%）`,
        params: { default_value: '' },
        priority: emptyCount > records.length * 0.5 ? 'high' : 'medium'
      });
    }

    const stringValues = values.filter(v => typeof v === 'string');
    const trimmedIssues = stringValues.filter(v => v !== v.trim());
    if (trimmedIssues.length > 0) {
      suggestions.push({
        rule_type: 'trim',
        field,
        reason: `${field}有${trimmedIssues.length}条值含首尾空白`,
        params: {},
        priority: 'low'
      });
    }

    const dateFields = ['_at', '_date', 'deadline', 'created_at', 'updated_at', 'found_at', 'fix_at', 'closed_at', 'executed_at', 'quoted_at', 'date'];
    if (dateFields.some(k => field === k || field.toLowerCase().endsWith('_at') || field.toLowerCase().endsWith('_date'))) {
      const dateFormats = new Set();
      stringValues.forEach(v => {
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) dateFormats.add('datetime');
        else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) dateFormats.add('date');
        else if (/^\d{4}\/\d{1,2}\/\d{1,2}/.test(v)) dateFormats.add('slash');
        else if (v && !/^\d{4}/.test(v)) dateFormats.add('nonstandard');
      });
      if (dateFormats.size > 1 || dateFormats.has('nonstandard') || dateFormats.has('slash')) {
        suggestions.push({
          rule_type: 'format_date',
          field,
          reason: `${field}存在${dateFormats.size}种日期格式，需统一`,
          params: { format: 'YYYY-MM-DD HH:mm:ss' },
          priority: 'medium'
        });
      }
    }

    const enumFields = ['status', 'type', 'level', 'category', 'source', 'module', 'priority'];
    if (enumFields.includes(field)) {
      const uniqueVals = [...new Set(values.filter(v => v !== undefined && v !== null && v !== ''))];
      if (uniqueVals.length > 0 && uniqueVals.length <= 20) {
        const nonStandard = uniqueVals.filter(v => v !== v.trim() || v !== v.toLowerCase());
        if (nonStandard.length > 0) {
          suggestions.push({
            rule_type: 'enum_fix',
            field,
            reason: `${field}枚举值存在大小写/空白不一致: [${uniqueVals.join(', ')}]`,
            params: { allowed_values: uniqueVals.map(v => v.trim()), default_value: uniqueVals[0]?.trim() },
            priority: 'medium'
          });
        }
      }
    }

    const numberFields = ['price', 'cost', 'amount', 'quantity', 'qty', 'rate', 'discount', 'weight', 'validity_days'];
    if (numberFields.some(k => field.toLowerCase().includes(k))) {
      const numVals = values.filter(v => v !== undefined && v !== null && v !== '');
      const inconsistent = numVals.filter(v => {
        const n = Number(v);
        return !isNaN(n) && String(n) !== String(v);
      });
      if (inconsistent.length > 0) {
        suggestions.push({
          rule_type: 'format_number',
          field,
          reason: `${field}有${inconsistent.length}条数字格式不一致`,
          params: { decimals: 2 },
          priority: 'low'
        });
      }
    }
  }

  res.json({ suggestions, total: records.length, table: table_name });
});

router.get('/logs', requirePerm('data-clean:view'), (req, res) => {
  const table = getLogsTable();
  let logs = table.all();
  const { table_name, rule_id, limit } = req.query;
  if (table_name) logs = logs.filter(l => l.table_name === table_name);
  if (rule_id) logs = logs.filter(l => l.rule_id === Number(rule_id));
  logs.sort((a, b) => b.id - a.id);
  if (limit) logs = logs.slice(0, Number(limit));
  res.json(logs);
});

module.exports = router;
