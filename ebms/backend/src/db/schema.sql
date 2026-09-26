-- EBMS 反向链路数据底座（PAND-84）
--
-- 契约口径（2026-09-26 P0 边界重核后统一）：反向查询沿
--     Result ← Exception（归因）← Evidence ← source_system
-- 实现，与 PAND-83 正向导航段一一对应。
--
-- 结构约束即口径约束：
--   * 只有三个契约对象表：result_metrics(Result) / exceptions(Exception) / evidences(Evidence)；
--   * 「来源」是 evidences.source_system 字段，不是独立表、不是独立层级；
--   * 反向链路只有一条关联路径（attribution_evidences → attributions → result_metrics），
--     「反向结果 == 正向导航」因此是结构性成立，而非依赖两套查询偶然对齐。

PRAGMA foreign_keys = ON;

-- ===========================================================================
-- 契约对象 1/3：Result —— 由专业中心 Owner 供给，M03 只消费不重算
-- ===========================================================================
CREATE TABLE IF NOT EXISTS result_metrics (
  id                  TEXT PRIMARY KEY,
  result_id           TEXT NOT NULL UNIQUE,
  contract_version    TEXT NOT NULL DEFAULT 'AEOS.Result.V1',
  code                TEXT NOT NULL,
  name                TEXT NOT NULL,
  source_system       TEXT NOT NULL,            -- Owner 模块（M05/M06/M09/M11…）
  object_type         TEXT NOT NULL DEFAULT 'BusinessMetric',
  object_id           TEXT NOT NULL,
  period_type         TEXT NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
  period_value        TEXT NOT NULL,
  target              REAL,
  actual              REAL,
  unit                TEXT,
  calculation_version TEXT NOT NULL,            -- Owner 提供，EBMS 不得自造
  status              TEXT NOT NULL DEFAULT 'VERIFIED'
                        CHECK (status IN ('VERIFIED', 'PENDING', 'STALE')),
  trace_id            TEXT,
  occurred_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (code, period_type, period_value)
);

CREATE INDEX IF NOT EXISTS idx_result_metrics_period
  ON result_metrics (period_type, period_value);

-- ===========================================================================
-- 契约对象 2/3：Exception —— 原因项的契约承载，必含 reason_code / severity
-- ===========================================================================
CREATE TABLE IF NOT EXISTS exceptions (
  id               TEXT PRIMARY KEY,
  exception_id     TEXT NOT NULL UNIQUE,
  contract_version TEXT NOT NULL DEFAULT 'AEOS.Exception.V1',
  source_system    TEXT NOT NULL,
  object_type      TEXT NOT NULL,
  object_id        TEXT NOT NULL,
  reason_code      TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACK', 'CLOSED')),
  trace_id         TEXT,
  occurred_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exceptions_reason_code ON exceptions (reason_code);

-- ===========================================================================
-- 契约对象 3/3：Evidence —— source_system 即「来源」入口（字段化）
-- ===========================================================================
CREATE TABLE IF NOT EXISTS evidences (
  id               TEXT PRIMARY KEY,
  evidence_id      TEXT NOT NULL UNIQUE,
  contract_version TEXT NOT NULL DEFAULT 'AEOS.Evidence.V1',
  type             TEXT NOT NULL
                     CHECK (type IN ('document', 'contract', 'system_record', 'manual_note')),
  title            TEXT NOT NULL,
  formed_at        TEXT NOT NULL,
  owner            TEXT,
  content          TEXT,
  -- 「来源」按契约字段化承载；允许为空（PAND-83 边界：显示「来源未标注」）
  source_system    TEXT,
  object_type      TEXT,
  object_id        TEXT,
  occurred_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidences_source_system ON evidences (source_system);

-- ===========================================================================
-- M03 归因元数据（Reason 层）—— 影响方向 / 贡献占比归 M03，
-- 但每条必须可判定归属：Exception 或 M03 自有归因分析（PAND-80 口径）
-- ===========================================================================
CREATE TABLE IF NOT EXISTS attributions (
  id               TEXT PRIMARY KEY,
  metric_id        TEXT NOT NULL REFERENCES result_metrics (id) ON DELETE CASCADE,
  parent_id        TEXT REFERENCES attributions (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('exception', 'm03_analysis')),
  exception_id     TEXT REFERENCES exceptions (id) ON DELETE RESTRICT,
  analysis_name    TEXT,
  direction        TEXT NOT NULL CHECK (direction IN ('positive', 'negative', 'neutral')),
  contribution_pct REAL
                     CHECK (contribution_pct IS NULL
                            OR (contribution_pct > 0 AND contribution_pct <= 100)),
  impact_value     REAL,
  owner            TEXT NOT NULL,
  order_no         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  -- PAND-80 口径硬约束：不存在无归属字段的原因项
  CHECK (
    (kind = 'exception'    AND exception_id IS NOT NULL AND analysis_name IS NULL)
    OR
    (kind = 'm03_analysis' AND exception_id IS NULL     AND analysis_name IS NOT NULL)
  ),
  -- AC：每条原因须含影响方向与「影响量或贡献占比」至少一项
  CHECK (contribution_pct IS NOT NULL OR impact_value IS NOT NULL),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_attributions_metric
  ON attributions (metric_id, parent_id, order_no);
CREATE INDEX IF NOT EXISTS idx_attributions_exception
  ON attributions (exception_id);

-- ===========================================================================
-- 归因项 ← Evidence 关联（反向查询的入口关系）
-- ===========================================================================
CREATE TABLE IF NOT EXISTS attribution_evidences (
  attribution_id TEXT NOT NULL REFERENCES attributions (id) ON DELETE CASCADE,
  evidence_id    TEXT NOT NULL REFERENCES evidences (id) ON DELETE CASCADE,
  linked_by      TEXT,
  linked_at      TEXT NOT NULL,
  PRIMARY KEY (attribution_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_attribution_evidences_evidence
  ON attribution_evidences (evidence_id);

-- ===========================================================================
-- 留痕：仅由写操作产生。反向查询为只读，不得写入本表。
-- ===========================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  detail      TEXT,
  at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id, at);

-- 顶层贡献占比汇总（口径：仅顶层计入合计，子项是对父项的细分）
CREATE VIEW IF NOT EXISTS result_attribution_summary AS
SELECT m.id                       AS metric_id,
       m.code                     AS metric_code,
       COUNT(a.id)                AS attribution_count,
       COALESCE(SUM(a.contribution_pct) FILTER (WHERE a.parent_id IS NULL), 0)
                                  AS root_contribution_pct
FROM result_metrics m
       LEFT JOIN attributions a ON a.metric_id = m.id
GROUP BY m.id, m.code;
