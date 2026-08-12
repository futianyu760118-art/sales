const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '..', '..', 'database', 'order_check_rules.json');

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch (e) {
    console.error('读取订单自检规则失败:', e.message);
    return { rules: [], severity_levels: {} };
  }
}

function selectRules(rulesDoc, { ruleIds, categories, excludeRuleIds } = {}) {
  let rules = (rulesDoc.rules || []).filter(r => r.enabled !== false);
  if (Array.isArray(ruleIds) && ruleIds.length) {
    const set = new Set(ruleIds);
    rules = rules.filter(r => set.has(r.id));
  }
  if (Array.isArray(categories) && categories.length) {
    const set = new Set(categories);
    rules = rules.filter(r => r.category && set.has(r.category));
  }
  if (Array.isArray(excludeRuleIds) && excludeRuleIds.length) {
    const set = new Set(excludeRuleIds);
    rules = rules.filter(r => !set.has(r.id));
  }
  return rules;
}

function runChecks(orders, bomDetails, rulesDoc, select) {
  const rules = select ? selectRules(rulesDoc, select) : (rulesDoc.rules || []).filter(r => r.enabled !== false);
  const issues = [];
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const orderById = {};
  orders.forEach(o => { if (o.id) orderById[o.id] = o; });
  const bomByOrderId = {};
  bomDetails.forEach(b => {
    const oid = b.order_id;
    if (!bomByOrderId[oid]) bomByOrderId[oid] = [];
    bomByOrderId[oid].push(b);
  });

  const orderNumCount = {};
  orders.forEach(o => {
    const num = (o.order_number || '').trim();
    if (num) orderNumCount[num] = (orderNumCount[num] || 0) + 1;
  });

  for (const rule of rules) {
    if (rule.check_type === 'unique' && rule.scope === 'global') {
      for (const [num, cnt] of Object.entries(orderNumCount)) {
        if (cnt > 1) {
          for (let i = 0; i < cnt; i++) {
            issues.push({
              rule_id: rule.id, rule_name: rule.name,
              severity: rule.severity || 'critical', scope: 'order',
              target_id: null, target_code: num,
              description: `订单号 ${num} 出现 ${cnt} 次，违反唯一性原则`,
              current_value: num,
              suggested_action: rule.remediation || '',
              detected_at: ts
            });
          }
        }
      }
      continue;
    }
    if (rule.check_type === 'bom_missing') {
      for (const order of orders) {
        const boms = bomByOrderId[order.id] || [];
        if (boms.length === 0) {
          issues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'high', scope: 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: `订单 ${order.order_number || order.id} 没有BOM明细数据`,
            current_value: '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'missing_purchase_cost') {
      for (const bom of bomDetails) {
        if (!bom.purchase_confirm_cost || bom.purchase_confirm_cost <= 0) {
          issues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'high', scope: 'bom',
            target_id: bom.id, target_code: bom.material_code || '',
            description: `BOM行 ${bom.material_code || bom.id} 采购确认成本为空或为0`,
            current_value: bom.purchase_confirm_cost || '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'purchase_cost_zero_when_material_has_value') {
      for (const bom of bomDetails) {
        if ((bom.material_amount || 0) > 0 && (!bom.purchase_confirm_cost || bom.purchase_confirm_cost <= 0)) {
          issues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: 'bom',
            target_id: bom.id, target_code: bom.material_code || '',
            description: `BOM行 ${bom.material_code || bom.id} 物料成本为 ${bom.material_amount}，但采购确认成本未设置`,
            current_value: `物料成本: ${bom.material_amount}, 采购确认成本: ${bom.purchase_confirm_cost || 0}`,
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'actual_cost_zero') {
      for (const bom of bomDetails) {
        if (!bom.actual_cost || bom.actual_cost <= 0) {
          issues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: 'bom',
            target_id: bom.id, target_code: bom.material_code || '',
            description: `BOM行 ${bom.material_code || bom.id} 实际成本为空或为0`,
            current_value: bom.actual_cost || '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'cost_discrepancy_high') {
      const threshold = rule.threshold || 0.1;
      for (const bom of bomDetails) {
        const matCost = bom.material_amount || 0;
        const purCost = bom.purchase_confirm_cost || 0;
        if (matCost > 0 && purCost > 0) {
          const diff = Math.abs(purCost - matCost) / matCost;
          if (diff > threshold) {
            issues.push({
              rule_id: rule.id, rule_name: rule.name,
              severity: rule.severity || 'medium', scope: 'bom',
              target_id: bom.id, target_code: bom.material_code || '',
              description: `BOM行 ${bom.material_code || bom.id} 采购确认成本(${purCost})与物料成本(${matCost})差异超过 ${(threshold * 100).toFixed(0)}%`,
              current_value: `差异率: ${(diff * 100).toFixed(2)}%`,
              suggested_action: rule.remediation || '',
              detected_at: ts
            });
          }
        }
      }
      continue;
    }
    if (rule.check_type === 'missing_order_amount') {
      for (const order of orders) {
        if (!order.order_amount || order.order_amount <= 0) {
          issues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'high', scope: 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: `订单 ${order.order_number || order.id} 订单金额为空或为0`,
            current_value: order.order_amount || '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'missing_plan_cost') {
      for (const order of orders) {
        if (!order.plan_total_cost || order.plan_total_cost <= 0) {
          issues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: `订单 ${order.order_number || order.id} 计划成本为空或为0`,
            current_value: order.plan_total_cost || '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'bom_cost_mismatch_order') {
      for (const order of orders) {
        const boms = bomByOrderId[order.id] || [];
        const bomTotal = boms.reduce((sum, b) => sum + (b.material_amount || 0), 0);
        const planCost = order.plan_total_cost || 0;
        if (boms.length > 0 && planCost > 0 && Math.abs(bomTotal - planCost) > 0.01) {
          issues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: `订单 ${order.order_number || order.id} 的BOM物料成本合计(${bomTotal})与计划成本(${planCost})不一致`,
            current_value: `BOM合计: ${bomTotal}, 计划成本: ${planCost}`,
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    for (const order of orders) {
      const ok = (() => {
        if (rule.check_type === 'regex') {
          const code = order[rule.field] || '';
          if (!code) return true;
          try { return new RegExp(rule.pattern).test(code); } catch (e) { return true; }
        }
        if (rule.check_type === 'length_range') {
          const n = order[rule.field] || '';
          const len = String(n).length;
          if (!n) return rule.empty_ok !== false;
          if (len < (rule.min || 0)) return false;
          if (len > (rule.max || 9999)) return false;
          return true;
        }
        if (rule.check_type === 'forbidden_contains') {
          const v = String(order[rule.field] || '');
          if (!v) return true;
          return !(rule.forbidden || []).some(w => v.includes(w));
        }
        if (rule.check_type === 'forbidden_chars') {
          const v = String(order[rule.field] || '');
          if (!v) return true;
          return !(rule.forbidden || []).some(c => v.includes(c));
        }
        if (rule.check_type === 'field_present') {
          const v = order[rule.field];
          if (!v || v === '') return false;
          if (rule.expected_choices && !rule.expected_choices.includes(String(v))) return false;
          return true;
        }
        if (rule.check_type === 'numeric_gt') {
          const v = Number(order[rule.field]);
          if (isNaN(v)) return false;
          return v > rule.field_value;
        }
        return true;
      })();
      if (!ok) {
        issues.push({
          rule_id: rule.id, rule_name: rule.name,
          severity: rule.severity || 'medium', scope: rule.scope || 'order',
          target_id: order.id, target_code: order.order_number || '',
          description: rule.description.replace('{field}', rule.field).replace('{value}', String(order[rule.field])),
          current_value: String(order[rule.field]),
          suggested_action: rule.remediation || '',
          detected_at: ts
        });
      }
    }
  }
  return issues;
}

async function runChecksBatch(orders, bomDetails, rulesDoc, batchSize, select) {
  const rules = select ? selectRules(rulesDoc, select) : (rulesDoc.rules || []).filter(r => r.enabled !== false);
  const allIssues = [];
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);

  const orderById = {};
  orders.forEach(o => { if (o.id) orderById[o.id] = o; });
  const bomByOrderId = {};
  bomDetails.forEach(b => {
    const oid = b.order_id;
    if (!bomByOrderId[oid]) bomByOrderId[oid] = [];
    bomByOrderId[oid].push(b);
  });

  const orderNumCount = {};
  orders.forEach(o => {
    const num = (o.order_number || '').trim();
    if (num) orderNumCount[num] = (orderNumCount[num] || 0) + 1;
  });

  await new Promise(resolve => setTimeout(resolve, 0));

  for (const rule of rules) {
    if (rule.check_type === 'unique' && rule.scope === 'global') {
      for (const [num, cnt] of Object.entries(orderNumCount)) {
        if (cnt > 1) {
          for (let i = 0; i < cnt; i++) {
            allIssues.push({
              rule_id: rule.id, rule_name: rule.name,
              severity: rule.severity || 'critical', scope: 'order',
              target_id: null, target_code: num,
              description: `订单号 ${num} 出现 ${cnt} 次，违反唯一性原则`,
              current_value: num,
              suggested_action: rule.remediation || '',
              detected_at: ts
            });
          }
        }
      }
      continue;
    }
    if (rule.check_type === 'bom_missing') {
      for (const order of orders) {
        const boms = bomByOrderId[order.id] || [];
        if (boms.length === 0) {
          allIssues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'high', scope: 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: `订单 ${order.order_number || order.id} 没有BOM明细数据`,
            current_value: '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'missing_purchase_cost') {
      for (const bom of bomDetails) {
        if (!bom.purchase_confirm_cost || bom.purchase_confirm_cost <= 0) {
          allIssues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'high', scope: 'bom',
            target_id: bom.id, target_code: bom.material_code || '',
            description: `BOM行 ${bom.material_code || bom.id} 采购确认成本为空或为0`,
            current_value: bom.purchase_confirm_cost || '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'purchase_cost_zero_when_material_has_value') {
      for (const bom of bomDetails) {
        if ((bom.material_amount || 0) > 0 && (!bom.purchase_confirm_cost || bom.purchase_confirm_cost <= 0)) {
          allIssues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: 'bom',
            target_id: bom.id, target_code: bom.material_code || '',
            description: `BOM行 ${bom.material_code || bom.id} 物料成本为 ${bom.material_amount}，但采购确认成本未设置`,
            current_value: `物料成本: ${bom.material_amount}, 采购确认成本: ${bom.purchase_confirm_cost || 0}`,
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'actual_cost_zero') {
      for (const bom of bomDetails) {
        if (!bom.actual_cost || bom.actual_cost <= 0) {
          allIssues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: 'bom',
            target_id: bom.id, target_code: bom.material_code || '',
            description: `BOM行 ${bom.material_code || bom.id} 实际成本为空或为0`,
            current_value: bom.actual_cost || '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'cost_discrepancy_high') {
      const threshold = rule.threshold || 0.1;
      for (const bom of bomDetails) {
        const matCost = bom.material_amount || 0;
        const purCost = bom.purchase_confirm_cost || 0;
        if (matCost > 0 && purCost > 0) {
          const diff = Math.abs(purCost - matCost) / matCost;
          if (diff > threshold) {
            allIssues.push({
              rule_id: rule.id, rule_name: rule.name,
              severity: rule.severity || 'medium', scope: 'bom',
              target_id: bom.id, target_code: bom.material_code || '',
              description: `BOM行 ${bom.material_code || bom.id} 采购确认成本(${purCost})与物料成本(${matCost})差异超过 ${(threshold * 100).toFixed(0)}%`,
              current_value: `差异率: ${(diff * 100).toFixed(2)}%`,
              suggested_action: rule.remediation || '',
              detected_at: ts
            });
          }
        }
      }
      continue;
    }
    if (rule.check_type === 'missing_order_amount') {
      for (const order of orders) {
        if (!order.order_amount || order.order_amount <= 0) {
          allIssues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'high', scope: 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: `订单 ${order.order_number || order.id} 订单金额为空或为0`,
            current_value: order.order_amount || '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'missing_plan_cost') {
      for (const order of orders) {
        if (!order.plan_total_cost || order.plan_total_cost <= 0) {
          allIssues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: `订单 ${order.order_number || order.id} 计划成本为空或为0`,
            current_value: order.plan_total_cost || '0',
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    if (rule.check_type === 'bom_cost_mismatch_order') {
      for (const order of orders) {
        const boms = bomByOrderId[order.id] || [];
        const bomTotal = boms.reduce((sum, b) => sum + (b.material_amount || 0), 0);
        const planCost = order.plan_total_cost || 0;
        if (boms.length > 0 && planCost > 0 && Math.abs(bomTotal - planCost) > 0.01) {
          allIssues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: `订单 ${order.order_number || order.id} 的BOM物料成本合计(${bomTotal})与计划成本(${planCost})不一致`,
            current_value: `BOM合计: ${bomTotal}, 计划成本: ${planCost}`,
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      continue;
    }
    for (let i = 0; i < orders.length; i += batchSize) {
      const batch = orders.slice(i, i + batchSize);
      for (const order of batch) {
        const ok = (() => {
          if (rule.check_type === 'regex') {
            const code = order[rule.field] || '';
            if (!code) return true;
            try { return new RegExp(rule.pattern).test(code); } catch (e) { return true; }
          }
          if (rule.check_type === 'length_range') {
            const n = order[rule.field] || '';
            const len = String(n).length;
            if (!n) return rule.empty_ok !== false;
            if (len < (rule.min || 0)) return false;
            if (len > (rule.max || 9999)) return false;
            return true;
          }
          if (rule.check_type === 'forbidden_contains') {
            const v = String(order[rule.field] || '');
            if (!v) return true;
            return !(rule.forbidden || []).some(w => v.includes(w));
          }
          if (rule.check_type === 'forbidden_chars') {
            const v = String(order[rule.field] || '');
            if (!v) return true;
            return !(rule.forbidden || []).some(c => v.includes(c));
          }
          if (rule.check_type === 'field_present') {
            const v = order[rule.field];
            if (!v || v === '') return false;
            if (rule.expected_choices && !rule.expected_choices.includes(String(v))) return false;
            return true;
          }
          if (rule.check_type === 'numeric_gt') {
            const v = Number(order[rule.field]);
            if (isNaN(v)) return false;
            return v > rule.field_value;
          }
          return true;
        })();
        if (!ok) {
          allIssues.push({
            rule_id: rule.id, rule_name: rule.name,
            severity: rule.severity || 'medium', scope: rule.scope || 'order',
            target_id: order.id, target_code: order.order_number || '',
            description: rule.description.replace('{field}', rule.field).replace('{value}', String(order[rule.field])),
            current_value: String(order[rule.field]),
            suggested_action: rule.remediation || '',
            detected_at: ts
          });
        }
      }
      if (i + batchSize < orders.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
  }
  return allIssues;
}

module.exports = { loadRules, runChecks, runChecksBatch };