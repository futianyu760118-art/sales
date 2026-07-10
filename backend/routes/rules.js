const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');

ensureTable('workflow_rules');

function getRulesTable() {
  const t = getTable('workflow_rules');
  t._invalidate();
  return t;
}

router.get('/', requirePerm('rules:view'), (req, res) => {
  const table = getRulesTable();
  let rules = table.all();
  const { category, type, enabled } = req.query;
  if (category) rules = rules.filter(r => r.category === category);
  if (type) rules = rules.filter(r => r.type === type);
  if (enabled !== undefined) rules = rules.filter(r => r.enabled === (enabled === 'true'));
  rules.sort((a, b) => {
    if (a.type === 'core' && b.type !== 'core') return -1;
    if (a.type !== 'core' && b.type === 'core') return 1;
    return (b.priority || 0) - (a.priority || 0);
  });
  res.json(rules);
});

router.get('/:id', requirePerm('rules:view'), (req, res) => {
  const table = getRulesTable();
  const rule = table.all().find(r => r.id === Number(req.params.id));
  if (!rule) return res.status(404).json({ error: '规则不存在' });
  res.json(rule);
});

router.post('/', requirePerm('rules:manage'), (req, res) => {
  const table = getRulesTable();
  const { code, name, category, type, priority, description, condition, action, action_params, enabled } = req.body;
  if (!code || !name) return res.status(400).json({ error: '规则编码和名称为必填项' });
  const exists = table.all().find(r => r.code === code);
  if (exists) return res.status(400).json({ error: '规则编码已存在' });
  const rule = {
    code, name,
    category: category || 'inquiry',
    type: type || 'basic',
    priority: priority || 50,
    description: description || '',
    condition: condition || '',
    action: action || '',
    action_params: action_params || '{}',
    enabled: enabled !== false,
    created_at: now(), updated_at: now()
  };
  const result = table.insert(rule);
  res.json({ message: '规则创建成功', data: { ...rule, id: result.lastID } });
});

router.put('/:id', requirePerm('rules:manage'), (req, res) => {
  const table = getRulesTable();
  const id = Number(req.params.id);
  const existing = table.all().find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: '规则不存在' });
  const { code, name, category, type, priority, description, condition, action, action_params, enabled } = req.body;
  if (code && code !== existing.code) {
    const dup = table.all().find(r => r.code === code && r.id !== id);
    if (dup) return res.status(400).json({ error: '规则编码已存在' });
  }
  const updates = { updated_at: now() };
  if (code !== undefined) updates.code = code;
  if (name !== undefined) updates.name = name;
  if (category !== undefined) updates.category = category;
  if (type !== undefined) updates.type = type;
  if (priority !== undefined) updates.priority = priority;
  if (description !== undefined) updates.description = description;
  if (condition !== undefined) updates.condition = condition;
  if (action !== undefined) updates.action = action;
  if (action_params !== undefined) updates.action_params = typeof action_params === 'object' ? JSON.stringify(action_params) : action_params;
  if (enabled !== undefined) updates.enabled = enabled;
  table.update(id, updates);
  res.json({ message: '规则更新成功' });
});

router.delete('/:id', requirePerm('rules:delete'), (req, res) => {
  const table = getRulesTable();
  const id = Number(req.params.id);
  const existing = table.all().find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: '规则不存在' });
  table.delete(id);
  res.json({ message: '规则删除成功' });
});

router.post('/toggle/:id', requirePerm('rules:manage'), (req, res) => {
  const table = getRulesTable();
  const id = Number(req.params.id);
  const existing = table.all().find(r => r.id === id);
  if (!existing) return res.status(404).json({ error: '规则不存在' });
  table.update(id, { enabled: !existing.enabled, updated_at: now() });
  res.json({ message: existing.enabled ? '规则已禁用' : '规则已启用' });
});

router.post('/resolve-conflict', requirePerm('rules:manage'), (req, res) => {
  const table = getRulesTable();
  const { rules: conflictRules, context } = req.body;
  if (!conflictRules || !Array.isArray(conflictRules) || conflictRules.length < 2) {
    return res.status(400).json({ error: '需要至少两条规则来检测冲突' });
  }
  const coreRules = conflictRules.filter(r => r.type === 'core').sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const basicRules = conflictRules.filter(r => r.type === 'basic').sort((a, b) => (b.priority || 0) - (a.priority || 0));
  const winner = coreRules.length > 0 ? coreRules[0] : basicRules[0];
  const reason = coreRules.length > 0
    ? `核心准则优先: [${winner.code}] ${winner.name} (优先级:${winner.priority})`
    : `优先级最高: [${winner.code}] ${winner.name} (优先级:${winner.priority})`;
  res.json({ winner, reason, core_rules: coreRules, basic_rules: basicRules });
});

// 获取模块功能开关（供前端 dynamic feature gating）
router.get('/features/:module?', requirePerm('rules:view'), (req, res) => {
  const table = getRulesTable();
  let rules = table.all().filter(r => r.type === 'feature' && r.enabled !== false);
  if (req.params.module) {
    rules = rules.filter(r => r.category === req.params.module);
  }
  const features = {};
  rules.forEach(r => {
    let params = {};
    try { params = JSON.parse(r.action_params || '{}'); } catch(e) {}
    const featureKey = params.feature || r.code.split(':')[1];
    features[featureKey] = { enabled: true, code: r.code, name: r.name };
  });
  const disabledRules = table.all().filter(r => r.type === 'feature' && r.enabled === false);
  if (req.params.module) {
    disabledRules.filter(r => r.category === req.params.module).forEach(r => {
      let params = {};
      try { params = JSON.parse(r.action_params || '{}'); } catch(e) {}
      features[params.feature || r.code.split(':')[1]] = { enabled: false, code: r.code, name: r.name };
    });
  }
  res.json({ module: req.params.module || 'all', features });
});

router.post('/evaluate', requirePerm('rules:manage'), (req, res) => {
  const table = getRulesTable();
  const { category, context } = req.body;
  let rules = table.all().filter(r => r.enabled);
  if (category) rules = rules.filter(r => r.category === category);
  rules.sort((a, b) => {
    if (a.type === 'core' && b.type !== 'core') return -1;
    if (a.type !== 'core' && b.type === 'core') return 1;
    return (b.priority || 0) - (a.priority || 0);
  });
  const results = rules.map(rule => {
    let matched = false;
    try {
      const ctx = context || {};
      const cond = rule.condition || '';
      if (!cond) { matched = false; }
      else if (cond.includes('quote_library.has_price == true')) { matched = ctx.has_quote_price === true; }
      else if (cond.includes('quote_library.has_price == false')) { matched = ctx.has_quote_price === false; }
      else if (cond.includes('product_config.has_pricing == true')) { matched = ctx.has_config_pricing === true; }
      else if (cond.includes('customer.not_exists == true')) { matched = ctx.customer_not_exists === true; }
      else if (cond.includes('product.exists == true')) { matched = ctx.product_exists === true; }
      else if (cond.includes('pricing.timeout == true')) { matched = ctx.pricing_timeout === true; }
      else if (cond.includes('status.changed == true')) { matched = ctx.status_changed === true; }
      else if (cond.includes('bom_pricing.status == completed')) { matched = ctx.bom_pricing_completed === true; }
      else if (cond.includes('quotation.expired == true')) { matched = ctx.quotation_expired === true; }
      else if (cond.includes('AND')) {
        const parts = cond.split('AND').map(p => p.trim());
        matched = parts.every(part => {
          if (part.includes('quote_library.has_price == true')) return ctx.has_quote_price === true;
          if (part.includes('product_config.has_pricing == true')) return ctx.has_config_pricing === true;
          return true;
        });
      }
    } catch(e) { matched = false; }
    let actionParams = {};
    try { actionParams = JSON.parse(rule.action_params || '{}'); } catch(e) {}
    return { id: rule.id, code: rule.code, name: rule.name, type: rule.type, priority: rule.priority, action: rule.action, action_params: actionParams, matched };
  });
  const matchedRules = results.filter(r => r.matched);
  const coreMatched = matchedRules.filter(r => r.type === 'core');
  const finalRules = coreMatched.length > 0 ? coreMatched : matchedRules;
  res.json({ all_rules: results, matched_rules: matchedRules, final_rules: finalRules, resolution: coreMatched.length > 0 ? '核心准则优先' : '基本规则匹配' });
});

module.exports = router;
