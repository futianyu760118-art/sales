/**
 * M03 经营指标注册表（视图层）——仅声明「指标归属哪个专业 Owner 模块」与「指标口径维度」。
 *
 * 边界（P0 红线）：
 *   - 指标**数值**一律由专业 Owner 模块以 Result 供给（收入/利润/成本 → M09；订单 → M05；
 *     交付/产能/库存 → M06），EBMS 只消费不计算；本注册表不含任何指标值。
 *   - 指标**目标值**归 M03 Management Goal。
 *   - 本文件只决定「某数据范围下哪些指标可见」，可见性来源为 M01 Kernel 的 data-scope。
 */

const SCOPE_ENTERPRISE = 'enterprise';
const SCOPE_DOMAIN = 'domain';

// domain: 责任域维度（与 M01 Kernel 责任域 domain_key 对齐）
const METRIC_CATALOG = [
  // ===== 企业级口径指标（仅企业级数据范围可见）=====
  { code: 'company_revenue',   name: '企业总收入',   owner_module: 'M09', scope_kind: SCOPE_ENTERPRISE },
  { code: 'company_profit',    name: '企业总利润',   owner_module: 'M09', scope_kind: SCOPE_ENTERPRISE },
  { code: 'company_cost',      name: '企业总成本',   owner_module: 'M09', scope_kind: SCOPE_ENTERPRISE },
  { code: 'company_cashflow',  name: '企业现金流',   owner_module: 'M09', scope_kind: SCOPE_ENTERPRISE },
  { code: 'company_gross_margin', name: '企业毛利率', owner_module: 'M09', scope_kind: SCOPE_ENTERPRISE },

  // ===== 责任域口径指标 =====
  { code: 'order_amount',      name: '订单金额',     owner_module: 'M05', scope_kind: SCOPE_DOMAIN, domain: 'sales' },
  { code: 'order_count',       name: '订单数',       owner_module: 'M05', scope_kind: SCOPE_DOMAIN, domain: 'sales' },
  { code: 'quote_win_rate',    name: '报价中标率',   owner_module: 'M05', scope_kind: SCOPE_DOMAIN, domain: 'sales' },
  { code: 'receivable_total',  name: '应收账款',     owner_module: 'M09', scope_kind: SCOPE_DOMAIN, domain: 'sales' },

  { code: 'delivery_ontime',   name: '准时交付率',   owner_module: 'M06', scope_kind: SCOPE_DOMAIN, domain: 'production' },
  { code: 'capacity_usage',    name: '产能利用率',   owner_module: 'M06', scope_kind: SCOPE_DOMAIN, domain: 'production' },
  { code: 'output_value',      name: '产值',         owner_module: 'M06', scope_kind: SCOPE_DOMAIN, domain: 'production' },

  { code: 'inventory_turnover', name: '库存周转',    owner_module: 'M06', scope_kind: SCOPE_DOMAIN, domain: 'supply' },
  { code: 'supplier_ontime',   name: '供应商准时率', owner_module: 'M06', scope_kind: SCOPE_DOMAIN, domain: 'supply' },
  { code: 'purchase_cost',     name: '采购成本',     owner_module: 'M06', scope_kind: SCOPE_DOMAIN, domain: 'supply' },

  { code: 'rd_project_progress', name: '研发项目进度', owner_module: 'M04', scope_kind: SCOPE_DOMAIN, domain: 'rd' },
  { code: 'bom_cost',          name: 'BOM 成本',     owner_module: 'M04', scope_kind: SCOPE_DOMAIN, domain: 'rd' },

  { code: 'expense_total',     name: '费用总额',     owner_module: 'M09', scope_kind: SCOPE_DOMAIN, domain: 'finance' },
  { code: 'labor_cost',        name: '人工成本',     owner_module: 'M09', scope_kind: SCOPE_DOMAIN, domain: 'finance' },
  { code: 'domain_gross_margin', name: '责任域毛利率', owner_module: 'M09', scope_kind: SCOPE_DOMAIN, domain: 'finance' }
];

function domainKeysOf(scope) {
  return new Set(Array.isArray(scope && scope.domain_keys) ? scope.domain_keys : []);
}

/**
 * 依据 M01 Kernel 数据范围过滤指标可见性。
 * 返回值只含「可见性元数据」，不含任何指标数值。
 */
function visibleMetrics(scope) {
  const scopeType = (scope && scope.scope_type) || 'none';
  const keys = domainKeysOf(scope);
  const enterpriseWide = scopeType === 'all' || keys.has('*');

  const metrics = METRIC_CATALOG.map(m => {
    let visible;
    if (scopeType === 'none') visible = false;
    else if (m.scope_kind === SCOPE_ENTERPRISE) visible = enterpriseWide;
    else visible = enterpriseWide || keys.has(m.domain);
    return {
      code: m.code,
      name: m.name,
      owner_module: m.owner_module,
      scope_kind: m.scope_kind,
      domain: m.domain || null,
      visible,
      // 数值与目标值来源声明：EBMS 不计算、不落库
      value_source: `${m.owner_module} Owner Result`,
      target_source: 'M03 Management Goal'
    };
  });

  return {
    scope_source: 'M01_KERNEL',
    scope_type: scopeType,
    scope_label: (scope && scope.scope_label) || '',
    domain_keys: [...keys],
    resource_ids: (scope && scope.resource_ids) || [],
    total: metrics.length,
    visible_count: metrics.filter(m => m.visible).length,
    metrics
  };
}

module.exports = { METRIC_CATALOG, SCOPE_ENTERPRISE, SCOPE_DOMAIN, visibleMetrics };
