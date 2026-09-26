/**
 * 链路读模型仓储。
 *
 * 反向查询所需的全部数据都从本仓储读出。本模块**只实现 SELECT**：
 * 反向链路因此不可能产生跨域写操作（AC 边界：反向只读）——
 * 这是结构性保证，而不是靠调用方自觉。全库唯一的写入口是 seed.js。
 */

const METRIC_COLUMNS = `
  m.id, m.result_id, m.code, m.name, m.source_system, m.object_type, m.object_id,
  m.period_type, m.period_value, m.target, m.actual, m.unit,
  m.calculation_version, m.status, m.trace_id, m.occurred_at
`;

const ATTRIBUTION_COLUMNS = `
  a.id, a.metric_id, a.parent_id, a.kind, a.exception_id, a.analysis_name,
  a.direction, a.contribution_pct, a.impact_value, a.owner, a.order_no,
  e.exception_id AS exception_code, e.reason_code, e.severity,
  e.status AS exception_status, e.source_system AS exception_source_system,
  e.object_type AS exception_object_type, e.object_id AS exception_object_id
`;

const EVIDENCE_COLUMNS = `
  v.id, v.evidence_id, v.type, v.title, v.formed_at, v.owner, v.content,
  v.source_system, v.object_type, v.object_id, v.occurred_at
`;

/** 原因项行 → 领域对象（camelCase，附带归属判定所需的 Exception 字段）。 */
function mapAttribution(row) {
  if (!row) return null;
  return {
    id: row.id,
    metricId: row.metric_id,
    parentId: row.parent_id ?? null,
    kind: row.kind,
    exceptionId: row.exception_id ?? null,
    exceptionCode: row.exception_code ?? null,
    analysisName: row.analysis_name ?? null,
    name: row.analysis_name ?? row.reason_code ?? null,
    direction: row.direction,
    contributionPct: row.contribution_pct ?? null,
    impactValue: row.impact_value ?? null,
    owner: row.owner,
    orderNo: row.order_no,
    reasonCode: row.reason_code ?? null,
    severity: row.severity ?? null,
    exceptionStatus: row.exception_status ?? null,
    exceptionSourceSystem: row.exception_source_system ?? null,
    exceptionObjectType: row.exception_object_type ?? null,
    exceptionObjectId: row.exception_object_id ?? null,
  };
}

function mapMetric(row) {
  if (!row) return null;
  return {
    id: row.id,
    resultId: row.result_id,
    code: row.code,
    name: row.name,
    sourceSystem: row.source_system,
    objectType: row.object_type,
    objectId: row.object_id,
    periodType: row.period_type,
    periodValue: row.period_value,
    target: row.target ?? null,
    actual: row.actual ?? null,
    unit: row.unit ?? null,
    calculationVersion: row.calculation_version,
    status: row.status,
    traceId: row.trace_id ?? null,
    occurredAt: row.occurred_at,
  };
}

function mapEvidence(row) {
  if (!row) return null;
  return {
    id: row.id,
    evidenceId: row.evidence_id,
    type: row.type,
    title: row.title,
    formedAt: row.formed_at,
    owner: row.owner ?? null,
    content: row.content ?? null,
    // 「来源」= Evidence 上的 source_system 字段；为空即未标注
    sourceSystem: row.source_system ?? null,
    objectType: row.object_type ?? null,
    objectId: row.object_id ?? null,
    occurredAt: row.occurred_at,
  };
}

export function createChainRepository(db) {
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const one = (sql, ...params) => db.prepare(sql).get(...params) ?? null;

  return {
    // -------- 锚点 --------
    getMetric(id) {
      return mapMetric(one(`SELECT ${METRIC_COLUMNS} FROM result_metrics m WHERE m.id = ?`, id));
    },

    getMetricByCode(code) {
      return mapMetric(
        one(
          `SELECT ${METRIC_COLUMNS} FROM result_metrics m
            WHERE m.code = ? ORDER BY m.period_value DESC LIMIT 1`,
          code,
        ),
      );
    },

    listMetrics() {
      return all(`SELECT ${METRIC_COLUMNS} FROM result_metrics m ORDER BY m.code, m.period_value`)
        .map(mapMetric);
    },

    getEvidence(id) {
      return mapEvidence(
        one(
          `SELECT ${EVIDENCE_COLUMNS} FROM evidences v WHERE v.id = ? OR v.evidence_id = ?`,
          id,
          id,
        ),
      );
    },

    listEvidencesBySourceSystem(sourceSystem) {
      return all(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidences v
          WHERE v.source_system = ? ORDER BY v.formed_at, v.id`,
        sourceSystem,
      ).map(mapEvidence);
    },

    listSourceSystems() {
      return all(
        `SELECT DISTINCT v.source_system AS source_system FROM evidences v
          WHERE v.source_system IS NOT NULL ORDER BY v.source_system`,
      ).map((row) => row.source_system);
    },

    // -------- 正向：Result → 归因项 → Evidence --------
    listAttributionsByMetric(metricId) {
      return all(
        `SELECT ${ATTRIBUTION_COLUMNS}
           FROM attributions a
           LEFT JOIN exceptions e ON e.id = a.exception_id
          WHERE a.metric_id = ?
          ORDER BY a.parent_id IS NOT NULL, a.order_no, a.id`,
        metricId,
      ).map(mapAttribution);
    },

    listEvidencesByAttribution(attributionId) {
      return all(
        `SELECT ${EVIDENCE_COLUMNS}
           FROM attribution_evidences ae
           JOIN evidences v ON v.id = ae.evidence_id
          WHERE ae.attribution_id = ?
          ORDER BY v.formed_at, v.id`,
        attributionId,
      ).map(mapEvidence);
    },

    // -------- 反向：Evidence → 归因项 → Result --------
    listAttributionsByEvidence(evidenceId) {
      return all(
        `SELECT ${ATTRIBUTION_COLUMNS}
           FROM attribution_evidences ae
           JOIN attributions a ON a.id = ae.attribution_id
           LEFT JOIN exceptions e ON e.id = a.exception_id
          WHERE ae.evidence_id = ?
          ORDER BY a.metric_id, a.parent_id IS NOT NULL, a.order_no, a.id`,
        evidenceId,
      ).map(mapAttribution);
    },

    listAttributionsByEvidenceIds(evidenceIds) {
      if (evidenceIds.length === 0) return [];
      const marks = evidenceIds.map(() => '?').join(', ');
      return all(
        `SELECT ${ATTRIBUTION_COLUMNS}, v.evidence_id AS via_evidence_id
           FROM attribution_evidences ae
           JOIN evidences v ON v.id = ae.evidence_id
           JOIN attributions a ON a.id = ae.attribution_id
           LEFT JOIN exceptions e ON e.id = a.exception_id
          WHERE ae.evidence_id IN (${marks})
          ORDER BY v.evidence_id, a.metric_id, a.parent_id IS NOT NULL, a.order_no, a.id`,
        ...evidenceIds,
      ).map((row) => ({ ...mapAttribution(row), viaEvidenceId: row.via_evidence_id }));
    },

    getMetricByIds(metricIds) {
      if (metricIds.length === 0) return [];
      const marks = metricIds.map(() => '?').join(', ');
      return all(
        `SELECT ${METRIC_COLUMNS} FROM result_metrics m WHERE m.id IN (${marks}) ORDER BY m.code`,
        ...metricIds,
      ).map(mapMetric);
    },

    // -------- 清点与自检 --------
    countAttributions() {
      return one('SELECT COUNT(*) AS n FROM attributions').n;
    },

    /**
     * 口径合规抽检：逐条归因项判定归属。
     * kind='exception' 必须挂到含 reason_code + severity 的 Exception；
     * kind='m03_analysis' 必须显式标注为 M03 自有归因分析。
     */
    listAttributionCompliance() {
      return all(
        `SELECT a.id, a.kind, a.analysis_name, a.metric_id,
                e.exception_id AS exception_code, e.reason_code, e.severity
           FROM attributions a
           LEFT JOIN exceptions e ON e.id = a.exception_id
          ORDER BY a.metric_id, a.id`,
      ).map((row) => {
        const violations = [];
        if (row.kind === 'exception') {
          if (!row.exception_code) violations.push('exception_missing');
          if (!row.reason_code) violations.push('reason_code_missing');
          if (!row.severity) violations.push('severity_missing');
        } else if (row.kind === 'm03_analysis') {
          if (!row.analysis_name) violations.push('m03_analysis_unlabelled');
        } else {
          violations.push('unknown_kind');
        }
        return {
          attributionId: row.id,
          metricId: row.metric_id,
          kind: row.kind,
          reasonCode: row.reason_code ?? null,
          severity: row.severity ?? null,
          analysisName: row.analysis_name ?? null,
          compliant: violations.length === 0,
          violations,
        };
      });
    },

    /** 只读自检用：各表行数快照。 */
    rowCounts() {
      const tables = ['result_metrics', 'exceptions', 'evidences', 'attributions', 'attribution_evidences', 'audit_log'];
      const counts = {};
      for (const table of tables) {
        counts[table] = one(`SELECT COUNT(*) AS n FROM ${table}`).n;
      }
      return counts;
    },

    /**
     * 反向链路可达的 (evidence, metric) 关联对，供一致性抽样比对。
     * 统一以对外 evidence_id 标识，避免与内部主键混用导致比对假阴性。
     */
    listEvidenceMetricLinks() {
      return all(
        `SELECT DISTINCT v.evidence_id AS evidence_code, a.metric_id AS metric_id
           FROM attribution_evidences ae
           JOIN evidences v ON v.id = ae.evidence_id
           JOIN attributions a ON a.id = ae.attribution_id
          ORDER BY v.evidence_id, a.metric_id`,
      ).map((row) => ({ evidenceId: row.evidence_code, metricId: row.metric_id }));
    },
  };
}
