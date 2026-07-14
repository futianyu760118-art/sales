// 物料库自检规则执行器（与路由解耦，便于调度器复用）
const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '..', '..', 'database', 'material_check_rules.json');

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch (e) {
    console.error('读取自检规则失败:', e.message);
    return { rules: [], severity_levels: {} };
  }
}

function runChecks(materials, bomItems, rulesDoc) {
  const rules = (rulesDoc.rules || []).filter(r => r.enabled !== false);
  const issues = [];
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // 重复编码
  const codeCount = {};
  materials.forEach(m => {
    const c = (m.material_code || '').trim();
    if (c) codeCount[c] = (codeCount[c] || 0) + 1;
  });
  const materialByCode = {};
  materials.forEach(m => { if (m.material_code) materialByCode[m.material_code] = m; });

  // BOM 中找不到的物料代码
  const orphanBom = {};
  bomItems.forEach(b => {
    const c = (b.material_code || '').trim();
    if (c && !materialByCode[c]) orphanBom[c] = (orphanBom[c] || 0) + 1;
  });

  for (const rule of rules) {
    if (rule.check_type === 'unique' && rule.scope === 'global') {
      for (const [code, cnt] of Object.entries(codeCount)) {
        if (cnt > 1) {
          for (let i = 0; i < cnt; i++) {
            issues.push({
              rule_id: rule.id,
              rule_name: rule.name,
              severity: rule.severity || 'critical',
              scope: 'material',
              target_id: null,
              target_code: code,
              description: `物料代码 ${code} 出现 ${cnt} 次，违反唯一性原则`,
              current_value: code,
              suggested_action: rule.remediation || '',
              status: 'open',
              assignee: '',
              due_date: '',
              detected_at: ts
            });
          }
        }
      }
      continue;
    }
    if (rule.check_type === 'bom_orphan_code' && rule.scope === 'bom') {
      for (const [code, cnt] of Object.entries(orphanBom)) {
        issues.push({
          rule_id: rule.id,
          rule_name: rule.name,
          severity: rule.severity || 'high',
          scope: 'bom',
          target_id: null,
          target_code: code,
          description: `BOM 引用 ${code} 共 ${cnt} 行，但物料库找不到对应物料`,
          current_value: code,
          suggested_action: rule.remediation || '',
          status: 'open',
          assignee: '',
          due_date: '',
          detected_at: ts
        });
      }
      continue;
    }
    for (const m of materials) {
      const code = m.material_code || '';
      const ok = (() => {
        if (rule.check_type === 'regex') {
          if (!code) return true;
          try { return new RegExp(rule.pattern).test(code); } catch (e) { return true; }
        }
        if (rule.check_type === 'length_range') {
          const n = m[rule.field] || '';
          const len = String(n).length;
          if (!n) return rule.empty_ok !== false;
          if (len < (rule.min || 0)) return false;
          if (len > (rule.max || 9999)) return false;
          return true;
        }
        if (rule.check_type === 'forbidden_contains') {
          const v = String(m[rule.field] || '');
          if (!v) return true;
          return !(rule.forbidden || []).some(w => v.includes(w));
        }
        if (rule.check_type === 'forbidden_chars') {
          const v = String(m[rule.field] || '');
          if (!v) return true;
          return !(rule.forbidden || []).some(c => v.includes(c));
        }
        if (rule.check_type === 'forbidden_value') {
          const v = m[rule.field];
          if (v === undefined || v === null || v === '') return true;
          return !(rule.forbidden_values || []).includes(String(v));
        }
        if (rule.check_type === 'enum') {
          const v = m[rule.field];
          if (rule.empty_ok === false && (!v || v === '')) return false;
          if (v === undefined || v === null || v === '') return true;
          return (rule.allowed || []).includes(String(v));
        }
        if (rule.check_type === 'field_present') {
          const v = m[rule.field];
          if (!v || v === '') return false;
          if (rule.expected_choices && !rule.expected_choices.includes(String(v))) return false;
          return true;
        }
        if (rule.check_type === 'numeric_gt') {
          const v = Number(m[rule.field]);
          if (isNaN(v)) return false;
          return v > rule.field_value;
        }
        if (rule.check_type === 'field_audit_only') return true;
        return true;
      })();
      if (!ok) {
        issues.push({
          rule_id: rule.id,
          rule_name: rule.name,
          severity: rule.severity || rulesDoc.default_severity || 'medium',
          scope: 'material',
          target_id: m.id || null,
          target_code: code,
          description: `物料 ${code}（${(m.material_name || '').substring(0, 20)}） 的 ${rule.field || ''} 不符合规则 ${rule.name}`,
          current_value: rule.field ? String(m[rule.field] || '') : '',
          suggested_action: rule.remediation || '',
          status: 'open',
          assignee: '',
          due_date: '',
          detected_at: ts
        });
      }
    }
  }
  return issues;
}

module.exports = { loadRules, runChecks };
