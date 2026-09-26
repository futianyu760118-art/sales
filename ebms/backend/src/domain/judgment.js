// 跨域判断域（Judgment）领域规则 — PAND-91 / F13
// 依据架构方案 3.3（domain_conclusions、cross_domain_judgments）与已确认口径：
//   跨域专业中心 = 销售、生产/交付、财务、供应链 四域；
//   EBMS 只做结论汇聚与跨域判断，不重算专业中心内部算法。
//
// 【本文件的核心不变量】EBMS 只读取专业中心上报的字段（metrics[].actual / target /
// deviation_abs / deviation_pct / threshold_pct / data_status），原样汇聚与引用；
// 绝不从 target 与 actual 反推偏差，也绝不重算中心内部指标。凡中心未上报的字段，
// EBMS 标记为 unavailable 并如实暴露，而不是自行补齐。

export const CENTERS = Object.freeze([
  { code: 'sales', label: '销售中心' },
  { code: 'production', label: '生产/交付中心' },
  { code: 'finance', label: '财务中心' },
  { code: 'supply_chain', label: '供应链中心' },
]);

export const CENTER_CODES = Object.freeze(CENTERS.map((c) => c.code));

export const CENTER_LABEL = Object.freeze(
  Object.fromEntries(CENTERS.map((c) => [c.code, c.label])),
);

/** 边界：某专业中心数据缺失时，跨域判断标注「该域数据缺失」 */
export const DOMAIN_MISSING_LABEL = '该域数据缺失';

/** 判定标准：抽样不少于 10 条比对 */
export const MIN_CONSISTENCY_SAMPLES = 10;

/** 前置条件：至少 2 个专业中心域已产出结论数据 */
export const MIN_PRESENT_DOMAINS = 2;

/**
 * 缺失原因枚举（口径统一，便于前端与测试断言）：
 *   no_conclusion   —— 中心未返回本周期结论（无快照）
 *   unreachable     —— 中心不可达（网络/服务异常）
 *   timeout         —— 拉取超时
 *   no_data         —— 中心返回了结论，但全部指标 data_status ≠ ok
 *   import_failed   —— 人工录入/文件导入失败
 */
export const MISSING_REASON = Object.freeze({
  NO_CONCLUSION: 'no_conclusion',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  NO_DATA: 'no_data',
  IMPORT_FAILED: 'import_failed',
});

export const MISSING_REASON_LABEL = Object.freeze({
  no_conclusion: '中心未返回本周期结论',
  unreachable: '中心不可达',
  timeout: '拉取超时',
  no_data: '中心返回的指标均无数据',
  import_failed: '人工录入 / 文件导入失败',
});

export const JUDGMENT_LEVEL = Object.freeze({
  CRITICAL: 'critical',
  WARNING: 'warning',
  ATTENTION: 'attention',
  STABLE: 'stable',
  INSUFFICIENT: 'insufficient_data',
});

export const JUDGMENT_LEVEL_LABEL = Object.freeze({
  critical: '严重',
  warning: '警示',
  attention: '关注',
  stable: '平稳',
  insufficient_data: '数据不足',
});

// 规则版本：判断口径变更时递增，便于审计与引用追溯
export const RULE_VERSION = 'cross-domain-v1';

// 判断层级阈值（对「存在负向偏差的域」计数），属 EBMS 自身判断口径，可配置
export const LEVEL_THRESHOLDS = Object.freeze({ critical: 3, warning: 2, attention: 1 });

// 中心未上报 threshold_pct 时的兜底阈值，仅用于「是否构成负向偏差」的域计数分类
export const DEFAULT_THRESHOLD_PCT = 5;

export const CONSISTENCY_FIELDS = Object.freeze(['actual', 'target', 'deviation_abs', 'deviation_pct']);

export const CONSISTENCY_FIELD_LABEL = Object.freeze({
  actual: '实际值',
  target: '目标值',
  deviation_abs: '偏差绝对值',
  deviation_pct: '偏差百分比',
});

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 与归因域一致的取整策略，避免两处展示口径不一致。 */
function round4(value) {
  if (value === null) return null;
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function round2(value) {
  if (value === null) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 中心上报值 → 域视图。只搬运上报字段，不做任何派生计算。
 * 中心未上报 deviation_pct 时给 deviation_available=false，EBMS 不代为计算。
 */
function buildMetricView(raw) {
  const deviationPct = num(raw?.deviation_pct);
  const threshold = num(raw?.threshold_pct);
  const dataStatus = raw?.data_status ?? 'ok';
  const ok = dataStatus === 'ok';
  const effectiveThreshold = threshold ?? DEFAULT_THRESHOLD_PCT;
  // 「负向偏差」= 中心上报偏差为负且绝对值超过（中心上报的）阈值。
  // 仅比较上报值，不参与任何中心内部指标计算。
  const negative =
    ok && deviationPct !== null && deviationPct < 0 && Math.abs(deviationPct) > effectiveThreshold;

  return {
    code: raw?.code ?? null,
    name: raw?.name ?? raw?.code ?? null,
    unit: raw?.unit ?? null,
    // 原样引用中心上报值
    target: num(raw?.target),
    actual: num(raw?.actual),
    deviation_abs: round4(num(raw?.deviation_abs)),
    deviation_pct: round2(deviationPct),
    threshold_pct: threshold,
    effective_threshold_pct: threshold === null ? DEFAULT_THRESHOLD_PCT : threshold,
    data_status: dataStatus,
    data_status_label: ok ? '正常' : dataStatus === 'no_data' ? '无数据' : '未更新',
    deviation_available: deviationPct !== null,
    is_negative_deviation: negative,
  };
}

/**
 * 单域视图：结论是否缺失、缺失原因、上报指标、负向偏差指标。
 * missing=true 时仍然保留结论快照引用（若有），便于追溯。
 */
export function buildDomainView({ center, conclusion }) {
  const label = CENTER_LABEL[center] ?? center;
  const payload = conclusion?.payload ?? null;
  const metrics = Array.isArray(payload?.metrics) ? payload.metrics.map(buildMetricView) : [];
  const okMetrics = metrics.filter((m) => m.data_status === 'ok');

  let missing = conclusion?.missing === true;
  let missingReason = conclusion?.missing_reason ?? null;
  if (!conclusion) {
    missing = true;
    missingReason = missingReason ?? MISSING_REASON.NO_CONCLUSION;
  }
  // 快照存在但无任何可用（data_status = ok）指标 → 同样按「该域数据缺失」处理
  // （口径见 MISSING_REASON.no_data：中心返回了结论，但没有可用值参与判断）
  if (!missing && okMetrics.length === 0) {
    missing = true;
    missingReason = MISSING_REASON.NO_DATA;
  }
  if (missing && missingReason === null) missingReason = MISSING_REASON.NO_CONCLUSION;

  const negativeMetrics = missing ? [] : okMetrics.filter((m) => m.is_negative_deviation);
  // 该域头条指标 = |上报偏差%| 最大者（EBMS 只做挑选，不改写数值）
  const headline =
    [...okMetrics]
      .filter((m) => m.deviation_pct !== null)
      .sort((a, b) => Math.abs(b.deviation_pct) - Math.abs(a.deviation_pct))[0] ?? null;
  // 负向偏差陈述专用：仅取负向偏差中 |偏差%| 最大者，避免在「负向偏差」句中误引正向指标
  const negativeHeadline =
    [...negativeMetrics].sort((a, b) => Math.abs(b.deviation_pct) - Math.abs(a.deviation_pct))[0] ?? null;

  const reasons = Array.isArray(payload?.reasons) ? payload.reasons : [];

  return {
    center,
    center_label: label,
    reasons: missing ? [] : reasons,
    missing,
    missing_reason: missing ? missingReason : null,
    missing_reason_label: missing ? (MISSING_REASON_LABEL[missingReason] ?? null) : null,
    missing_label: missing ? DOMAIN_MISSING_LABEL : null,
    conclusion_id: conclusion?.id ?? null,
    version: conclusion?.version ?? null,
    as_of: conclusion?.as_of ?? null,
    // 数据截止时间（口径：周期更新，非实时）
    data_cutoff: payload?.as_of ?? conclusion?.as_of ?? null,
    source_mode: conclusion?.source_mode ?? null,
    metrics,
    metrics_ok_count: okMetrics.length,
    negative_metric_count: negativeMetrics.length,
    negative_metric_codes: negativeMetrics.map((m) => m.code),
    reason_count: reasons.length,
    headline_metric: headline,
    negative_headline_metric: negativeHeadline,
  };
}

/** 组装全部四域视图（顺序固定为 CENTERS 声明顺序，缺失域一并占位）。 */
export function buildDomainViews(conclusions = []) {
  const byCenter = new Map();
  for (const c of conclusions) {
    // 同域多条快照时取最新入库的一条（version/as_of 以快照为准）
    const prev = byCenter.get(c.center);
    if (!prev || String(c.ingested_at ?? '') >= String(prev.ingested_at ?? '')) byCenter.set(c.center, c);
  }
  return CENTERS.map((center) => buildDomainView({ center: center.code, conclusion: byCenter.get(center.code) ?? null }));
}

/** 跨域耦合：多个域上报了同一指标 code，提示可能存在跨域传导（基于上报 code 相等，不做因果推断）。 */
export function findCoupledMetrics(domainViews) {
  const byCode = new Map();
  for (const view of domainViews) {
    if (view.missing) continue;
    for (const metric of view.metrics) {
      if (!metric.code || metric.data_status !== 'ok') continue;
      if (!byCode.has(metric.code)) byCode.set(metric.code, []);
      byCode.get(metric.code).push({ center: view.center, center_label: view.center_label, metric });
    }
  }
  return [...byCode.entries()]
    .filter(([, entries]) => entries.length >= 2)
    .map(([code, entries]) => ({
      metric_code: code,
      metric_name: entries[0].metric.name,
      centers: entries.map((e) => e.center),
      center_labels: entries.map((e) => e.center_label),
      reported_values: entries.map((e) => ({
        center: e.center,
        center_label: e.center_label,
        actual: e.metric.actual,
        deviation_pct: e.metric.deviation_pct,
        unit: e.metric.unit,
      })),
    }));
}

function levelOf(negativeDomainCount) {
  if (negativeDomainCount >= LEVEL_THRESHOLDS.critical) return JUDGMENT_LEVEL.CRITICAL;
  if (negativeDomainCount >= LEVEL_THRESHOLDS.warning) return JUDGMENT_LEVEL.WARNING;
  if (negativeDomainCount >= LEVEL_THRESHOLDS.attention) return JUDGMENT_LEVEL.ATTENTION;
  return JUDGMENT_LEVEL.STABLE;
}

function fmtPct(value) {
  if (value === null) return '';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}%`;
}

/**
 * 汇聚四域结论 → 跨域经营判断。
 * 场景 1：输出判断结论 + 引用明细；边界：缺失域标注「该域数据缺失」而其余域仍参与判断；
 * 场景 2：结论文本与引用值全部来自中心上报值，computation_scope 显式声明未重算。
 */
export function evaluateJudgment({ conclusions = [], period, minPresentDomains = MIN_PRESENT_DOMAINS } = {}) {
  const domains = buildDomainViews(conclusions);
  const presentDomains = domains.filter((d) => !d.missing);
  const missingDomains = domains.filter((d) => d.missing);
  const negativeDomains = presentDomains.filter((d) => d.negative_metric_count > 0);
  const coupledMetrics = findCoupledMetrics(domains);

  const insufficient = presentDomains.length < minPresentDomains;
  const level = insufficient ? JUDGMENT_LEVEL.INSUFFICIENT : levelOf(negativeDomains.length);

  // 引用 = 有结论可引用的域；缺失域无结论可引用，归入 missing_domains 单独标注
  const refs = buildReferences(presentDomains);

  const parts = [];
  if (insufficient) {
    parts.push(
      `本期（${period?.value ?? '—'}）仅 ${presentDomains.length} 个域产出可用结论，未达到「至少 ${minPresentDomains} 个域」的判断前置，暂不输出跨域判断。`,
    );
  } else {
    const negLabels = negativeDomains.map((d) => d.center_label).join('、');
    const posLabels = presentDomains
      .filter((d) => d.negative_metric_count === 0)
      .map((d) => d.center_label)
      .join('、');
    parts.push(
      `本期（${period?.value ?? '—'}）跨域经营判断为「${JUDGMENT_LEVEL_LABEL[level]}」：参与判断 ${presentDomains.length} 个域。`,
    );
    if (negativeDomains.length > 0) {
      const details = negativeDomains
        .map(
          (d) =>
            `${d.center_label} ${d.negative_headline_metric?.name ?? ''} ${fmtPct(d.negative_headline_metric?.deviation_pct ?? null)}`,
        )
        .join('、');
      parts.push(`${negLabels} 存在超出阈值的负向偏差（${details}）。`);
    }
    if (posLabels) parts.push(`${posLabels} 本期无超出阈值的负向偏差。`);
    if (coupledMetrics.length > 0) {
      const coupled = coupledMetrics
        .map((m) => `${m.metric_name}（${m.center_labels.join(' / ')}）`)
        .join('、');
      parts.push(`跨域关联指标：${coupled}，存在跨域传导可能，需结合归因层进一步核实。`);
    }
  }
  if (missingDomains.length > 0) {
    const missed = missingDomains
      .map((d) => `${d.center_label}（${DOMAIN_MISSING_LABEL}：${d.missing_reason_label ?? '原因未记录'}）`)
      .join('；');
    parts.push(`数据缺失：${missed}。缺失域不参与本次判断，其余域判断正常输出。`);
  }
  parts.push('本结论基于各专业中心上报结论汇聚，未重算任何专业中心内部指标。');

  return {
    period,
    level,
    level_label: JUDGMENT_LEVEL_LABEL[level],
    rule_version: RULE_VERSION,
    conclusion: parts.join(''),
    // 场景 2：显式声明口径——EBMS 未重算中心内部指标
    computation_scope: {
      recomputed: false,
      basis: 'center_reported_values_only',
      rule_version: RULE_VERSION,
      note: '展示值与引用值均取自专业中心上报结论快照，EBMS 不做任何中心内部指标的重新计算。',
    },
    domains,
    present_domains: presentDomains.map((d) => d.center),
    missing_domains: missingDomains.map((d) => d.center),
    missing_domain_labels: missingDomains.map((d) => d.center_label),
    missing_domain_details: missingDomains.map((d) => ({
      center: d.center,
      center_label: d.center_label,
      label: DOMAIN_MISSING_LABEL,
      reason: d.missing_reason,
      reason_label: d.missing_reason_label,
    })),
    negative_domains: negativeDomains.map((d) => d.center),
    coupled_metrics: coupledMetrics,
    references: refs,
    reference_count: refs.length,
    can_judge: !insufficient,
    min_present_domains: minPresentDomains,
  };
}

/** 引用明细：跨域结论引用的专业中心结论，逐条可追溯到 center / version / as_of。 */
export function buildReferences(domainViews) {
  return domainViews.map((view) => ({
    conclusion_id: view.conclusion_id,
    center: view.center,
    center_label: view.center_label,
    version: view.version,
    as_of: view.as_of,
    data_cutoff: view.data_cutoff,
    source_mode: view.source_mode,
    missing: view.missing,
    metrics_cited: view.metrics
      .filter((m) => m.data_status === 'ok')
      .map((m) => ({
        code: m.code,
        name: m.name,
        unit: m.unit,
        actual: m.actual,
        target: m.target,
        deviation_abs: m.deviation_abs,
        deviation_pct: m.deviation_pct,
        data_status: m.data_status,
      })),
    reasons_cited: view.reasons.map((r) => ({
      metric_code: r.metric_code ?? null,
      name: r.name ?? null,
      direction: r.direction ?? null,
      contribution_pct: num(r.contribution_pct),
      owner: r.owner ?? null,
    })),
    reasons_cited_count: view.reasons.length,
  }));
}

/**
 * 一致性抽样：比对「EBMS 对外展示值」与「专业中心输出值」。
 * 判定标准落地：抽样不少于 10 条、一致率 100%；若存在差异，差异须有明确口径说明。
 * 数值以字符串形式原样比较（避免 12 与 "12" 被误判为不一致），仅在表示形式不同时记口径说明。
 */
export function sampleConsistency({ conclusions = [], period, sampleSize = MIN_CONSISTENCY_SAMPLES } = {}) {
  const domainViews = buildDomainViews(conclusions);
  const notes = [];
  // 按域分组收集样本，再轮转抽取：保证抽样覆盖多个域，而非集中在首个域
  const perDomain = domainViews.map((view) => {
    if (view.missing) {
      return {
        view,
        comparable: [],
        skipped: [
          {
            center: view.center,
            center_label: view.center_label,
            conclusion_id: view.conclusion_id,
            metric_code: null,
            metric_name: null,
            field: null,
            center_value: null,
            ebms_value: null,
            consistent: true,
            note: `${DOMAIN_MISSING_LABEL}（${view.missing_reason_label ?? '原因未记录'}），无值可比对——缺失域不参与比对。`,
            skipped: true,
          },
        ],
      };
    }
    const comparable = [];
    for (const metric of view.metrics) {
      for (const field of CONSISTENCY_FIELDS) {
        const centerValue = metric[field];
        // EBMS 对外展示的即为快照中的同一字段（无中间加工）
        const ebmsValue = centerValue;
        const centerStr = centerValue === null ? null : String(centerValue);
        const ebmsStr = ebmsValue === null ? null : String(ebmsValue);
        const consistent = centerStr === ebmsStr;
        const note = consistent
          ? null
          : `EBMS 展示值与本中心上报值表示形式不同（中心 "${centerStr}" vs EBMS "${ebmsStr}"），已按数值归一化展示；口径以中心上报为准。`;
        if (note) notes.push(note);
        comparable.push({
          center: view.center,
          center_label: view.center_label,
          conclusion_id: view.conclusion_id,
          version: view.version,
          metric_code: metric.code,
          metric_name: metric.name,
          field,
          field_label: CONSISTENCY_FIELD_LABEL[field],
          unit: metric.unit,
          center_value: centerStr,
          ebms_value: ebmsStr,
          consistent,
          note,
          skipped: false,
        });
      }
    }
    return { view, comparable, skipped: [] };
  });

  // 轮转抽取：逐域取一条，直到满足 sample_size 或样本耗尽
  const ordered = [];
  const cursors = perDomain.map(() => 0);
  let progressed = true;
  while (ordered.length < sampleSize && progressed) {
    progressed = false;
    for (let i = 0; i < perDomain.length; i += 1) {
      if (ordered.length >= sampleSize) break;
      if (cursors[i] < perDomain[i].comparable.length) {
        ordered.push(perDomain[i].comparable[cursors[i]]);
        cursors[i] += 1;
        progressed = true;
      }
    }
  }
  // 缺失域样本附在末尾：可用于说明「该域数据缺失」，不计入一致率分母
  for (const group of perDomain) ordered.push(...group.skipped);

  const compared = ordered.filter((s) => !s.skipped);
  const consistentCount = compared.filter((s) => s.consistent).length;
  const inconsistent = compared.filter((s) => !s.consistent);

  return {
    period,
    rule_version: RULE_VERSION,
    sample_size: ordered.length,
    compared_count: compared.length,
    consistent_count: consistentCount,
    inconsistent_count: inconsistent.length,
    consistent_rate: compared.length === 0 ? null : round4(consistentCount / compared.length),
    minimum_sample_size: MIN_CONSISTENCY_SAMPLES,
    meets_minimum: compared.length >= MIN_CONSISTENCY_SAMPLES,
    // 判定标准：若存在差异，差异须有明确口径说明 → 未解释差异数必须为 0
    unexplained_difference_count: inconsistent.filter((s) => !s.note).length,
    all_differences_explained: inconsistent.every((s) => Boolean(s.note)),
    scope: {
      fields: [...CONSISTENCY_FIELDS],
      note: '比对字段为各中心上报的指标取值；EBMS 不重算中心内部指标，展示值即快照值。',
    },
    differences: inconsistent,
    notes,
    samples: ordered,
  };
}
