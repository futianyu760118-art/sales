// 归因域（Reason）领域规则 — PAND-80 / F2
// 依据架构方案 3.3 数据模型（result_reasons）与已确认口径：
// 穿透链路固定为 Result → Reason → Evidence → Source 四层，Reason 层可多级展开。

export const CHAIN_LAYERS = ['RESULT', 'REASON', 'EVIDENCE', 'SOURCE'];

export const DIRECTION = Object.freeze({
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  NEUTRAL: 'neutral',
});

// AC 判定：影响方向取值仅限 正向 / 负向 / 中性 三者之一
export const DIRECTION_LABEL = Object.freeze({
  positive: '正向',
  negative: '负向',
  neutral: '中性',
});

export const DIRECTION_VALUES = Object.freeze(Object.values(DIRECTION));

// AC 判定：完全归因时贡献占比合计 = 100%（四舍五入误差 ≤ 1%）
export const CONTRIBUTION_TOLERANCE_PCT = 1.0;

export const CONTRIBUTION_SCALE = 2;

export const ATTRIBUTION_STATUS = Object.freeze({
  FULLY: 'fully_attributed',
  PARTIAL: 'partially_attributed',
  UNATTRIBUTED: 'unattributed',
});

export const ATTRIBUTION_LABEL = Object.freeze({
  fully_attributed: '完全归因',
  partially_attributed: '部分归因',
  unattributed: '未归因',
});

export const MAX_DEPTH = 10;

/** 统一取整策略：贡献占比保留 2 位小数，供合计与展示共用，避免各处取整不一致。 */
export function roundPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 由 result_metrics 的目标/实际值推导偏差；数据库中已落库的偏差优先。
 */
export function resolveDeviation(metric) {
  const target = num(metric.target);
  const actual = num(metric.actual);
  let abs = num(metric.deviation_abs);
  let pct = num(metric.deviation_pct);
  if (abs === null && target !== null && actual !== null) abs = actual - target;
  if (pct === null && target !== null && target !== 0 && abs !== null) {
    pct = (abs / Math.abs(target)) * 100;
  }
  return {
    deviation_abs: abs === null ? null : Number(abs.toFixed(4)),
    deviation_pct: pct === null ? null : roundPct(pct),
  };
}

export function isDeviated(metric, deviation) {
  const threshold = num(metric.threshold_pct);
  if (deviation.deviation_pct === null || threshold === null) return false;
  // 偏差绝对值超过阈值即视为存在偏差（阈值可配置，口径见 F1）
  return Math.abs(deviation.deviation_pct) > threshold;
}

/**
 * 判定归因状态：以顶层（parent_id 为空）原因项的贡献占比合计为准。
 * 多级原因是对父项贡献的细分，不重复计入合计，避免 100% 被重复累加。
 */
export function classifyAttribution(totalPct) {
  const total = totalPct === null || totalPct === undefined ? 0 : roundPct(totalPct);
  if (total === 0) {
    return {
      status: ATTRIBUTION_STATUS.UNATTRIBUTED,
      status_label: ATTRIBUTION_LABEL[ATTRIBUTION_STATUS.UNATTRIBUTED],
      total_contribution_pct: 0,
      unattributed_pct: 100,
    };
  }
  const gap = 100 - total;
  if (Math.abs(gap) <= CONTRIBUTION_TOLERANCE_PCT) {
    return {
      status: ATTRIBUTION_STATUS.FULLY,
      status_label: ATTRIBUTION_LABEL[ATTRIBUTION_STATUS.FULLY],
      total_contribution_pct: total,
      unattributed_pct: 0,
    };
  }
  if (gap > 0) {
    return {
      status: ATTRIBUTION_STATUS.PARTIAL,
      status_label: ATTRIBUTION_LABEL[ATTRIBUTION_STATUS.PARTIAL],
      total_contribution_pct: total,
      unattributed_pct: roundPct(gap),
    };
  }
  // 合计超出 100% 视为超归因，交由写入校验拦截；读取时如实暴露，不静默裁剪
  return {
    status: ATTRIBUTION_STATUS.PARTIAL,
    status_label: ATTRIBUTION_LABEL[ATTRIBUTION_STATUS.PARTIAL],
    total_contribution_pct: total,
    unattributed_pct: roundPct(gap),
  };
}

function sumContribution(rows) {
  return roundPct(rows.reduce((acc, row) => acc + (num(row.contribution_pct) || 0), 0)) ?? 0;
}

/**
 * 扁平原因行 → 多级树。同一 metric 内按 parent_id 组树，order_no 决定同级顺序。
 */
export function buildReasonTree(rows, { maxDepth = MAX_DEPTH } = {}) {
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      metric_id: row.metric_id,
      parent_id: row.parent_id || null,
      name: row.name,
      direction: row.direction,
      direction_label: DIRECTION_LABEL[row.direction] || null,
      contribution_pct: num(row.contribution_pct),
      impact_value: num(row.impact_value),
      owner: row.owner,
      owner_type: row.owner_type || 'center',
      order_no: row.order_no ?? 0,
      note: row.note ?? null,
      level: 1,
      path: [row.id],
      // Reason 层允许逐级展开
      expandable: false,
      child_count: 0,
      children: [],
    });
  }

  const roots = [];
  const orphans = [];
  for (const node of byId.values()) {
    if (!node.parent_id) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(node.parent_id);
    // 父项缺失时不静默补位为顶层，而是标记为孤儿，避免合计口径被悄悄放大
    if (parent) parent.children.push(node);
    else orphans.push(node.id);
  }

  const sortNodes = (nodes) =>
    nodes.sort((a, b) => a.order_no - b.order_no || String(a.id).localeCompare(String(b.id)));

  const walk = (nodes, level, parentPath) => {
    for (const node of sortNodes(nodes)) {
      node.level = level;
      node.path = [...parentPath, node.id];
      node.depth_truncated = level >= maxDepth && node.children.length > 0;
      if (node.children.length > 0) {
        node.expandable = true;
        node.child_count = node.children.length;
        if (!node.depth_truncated) walk(node.children, level + 1, node.path);
        else node.children = [];
      } else {
        node.children = [];
      }
      // 子项是对本项贡献的细分：给出已细分比例与未细分余量
      if (node.expandable) {
        const childSum = sumContribution(node.children);
        node.decomposed_pct = childSum;
        node.undecomposed_pct = node.contribution_pct === null ? null : roundPct(node.contribution_pct - childSum);
      }
      node.affected_pct = node.contribution_pct;
    }
  };
  walk(roots, 1, []);

  return { tree: roots, orphans, nodeCount: byId.size };
}

export function flattenTree(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children || []);
    }
  };
  walk(tree);
  return out;
}

export function findNode(tree, id) {
  return flattenTree(tree).find((node) => node.id === id) || null;
}

/**
 * 写入校验：AC 判定标准的可执行形式。
 * 单条写入时把「本次写入后的全量集合」交给本函数，保证合计口径始终成立。
 */
export function validateReasons(rows, { tolerance = CONTRIBUTION_TOLERANCE_PCT } = {}) {
  const errors = [];
  const ids = new Set(rows.map((r) => r.id));

  for (const row of rows) {
    const where = { reason_id: row.id, name: row.name };
    if (!row.name || !String(row.name).trim()) {
      errors.push({ code: 'NAME_REQUIRED', message: '原因名称不能为空', ...where });
    }
    if (!DIRECTION_VALUES.includes(row.direction)) {
      errors.push({
        code: 'DIRECTION_INVALID',
        message: `影响方向仅限 正向/负向/中性，收到 ${row.direction}`,
        allowed: DIRECTION_VALUES,
        ...where,
      });
    }
    if (!row.owner || !String(row.owner).trim()) {
      errors.push({ code: 'OWNER_REQUIRED', message: '责任方不能为空', ...where });
    }
    const pct = num(row.contribution_pct);
    const impact = num(row.impact_value);
    if (pct === null && impact === null) {
      errors.push({ code: 'CONTRIBUTION_REQUIRED', message: '影响量或贡献占比至少填写一项', ...where });
    }
    if (pct !== null && (pct <= 0 || pct > 100)) {
      errors.push({ code: 'CONTRIBUTION_OUT_OF_RANGE', message: '贡献占比须在 (0, 100] 之间', ...where });
    }
    if (row.parent_id && !ids.has(row.parent_id)) {
      errors.push({ code: 'PARENT_NOT_FOUND', message: '父原因项不存在或不属于同一指标', parent_id: row.parent_id, ...where });
    }
  }

  // 环检测（parent_id 自引用或互引用）
  for (const row of rows) {
    const seen = new Set([row.id]);
    let cursor = row.parent_id;
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push({ code: 'PARENT_CYCLE', message: '原因层级存在环引用', reason_id: row.id });
        break;
      }
      seen.add(cursor);
      cursor = rows.find((r) => r.id === cursor)?.parent_id || null;
    }
  }

  if (errors.length === 0) {
    const roots = rows.filter((r) => !r.parent_id);
    const rootTotal = sumContribution(roots);
    if (roots.length > 0 && rootTotal > 100 + tolerance) {
      errors.push({
        code: 'CONTRIBUTION_OVER_100',
        message: `顶层原因贡献占比合计 ${rootTotal}% 超出 100%（容差 ±${tolerance}%）`,
        total_contribution_pct: rootTotal,
      });
    }
    const groups = new Map();
    for (const row of rows) {
      if (!row.parent_id) continue;
      const key = row.parent_id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const [parentId, children] of groups) {
      const parent = rows.find((r) => r.id === parentId);
      const childSum = sumContribution(children);
      const parentPct = num(parent?.contribution_pct);
      if (parentPct !== null && childSum > parentPct + tolerance) {
        errors.push({
          code: 'CHILD_CONTRIBUTION_OVER_PARENT',
          message: `子项贡献占比合计 ${childSum}% 超出父项 ${parentPct}%`,
          parent_id: parentId,
          child_total: childSum,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 组装接口响应 —— 场景 1 / 2 / 3 与边界「未归因」的对外形态。
 */
export function buildReasonListResponse({ metric, rows, maxDepth = MAX_DEPTH }) {
  const deviation = resolveDeviation(metric);
  const deviated = isDeviated(metric, deviation);
  const { tree, orphans } = buildReasonTree(rows, { maxDepth });
  // 合计口径与树一致：仅顶层计入，孤儿（父项缺失）不计入合计
  const attribution = classifyAttribution(sumContribution(tree));

  const unattributedEntry = {
    code: 'UNATTRIBUTED',
    title: '未归因',
    message: '该指标本期尚未关联任何原因项，无法完成偏差归因。',
    action: {
      label: '关联原因',
      method: 'POST',
      href: `/api/v1/results/${metric.id}/reasons`,
    },
  };

  const isUnattributed = rows.length === 0;

  return {
    // 场景 3：固定四层链路，原因层位于 Reason 层且允许多级展开
    chain: {
      layers: CHAIN_LAYERS,
      current: 'REASON',
      reason_expandable: true,
      max_depth: maxDepth,
    },
    result: {
      id: metric.id,
      code: metric.code,
      name: metric.name,
      dimension: metric.dimension,
      unit: metric.unit ?? null,
      period: { type: metric.period_type, value: metric.period_value },
      target: num(metric.target),
      actual: num(metric.actual),
      deviation_abs: deviation.deviation_abs,
      deviation_pct: deviation.deviation_pct,
      threshold_pct: num(metric.threshold_pct),
      is_deviated: deviated,
      data_status: metric.data_status ?? 'ok',
      as_of: metric.as_of ?? null,
    },
    attribution: {
      ...attribution,
      reason_count: rows.length,
      root_reason_count: tree.length,
      tolerance_pct: CONTRIBUTION_TOLERANCE_PCT,
      // 场景 2：完全归因时合计为 100%（误差 ≤ 1%）
      fully_attributed: attribution.status === ATTRIBUTION_STATUS.FULLY,
      sums_to_100_within_tolerance:
        attribution.status === ATTRIBUTION_STATUS.FULLY &&
        Math.abs(attribution.total_contribution_pct - 100) <= CONTRIBUTION_TOLERANCE_PCT,
    },
    // 边界：无关联原因时不得返回空列表，改为「未归因」+ 关联入口
    reasons: isUnattributed ? [] : tree,
    empty_state: isUnattributed ? unattributedEntry : null,
    integrity: {
      orphan_reason_ids: orphans,
      // 读取侧提示：合计超 100% 属于历史数据异常，需人工修正
      over_attributed:
        attribution.total_contribution_pct > 100 + CONTRIBUTION_TOLERANCE_PCT,
    },
  };
}
