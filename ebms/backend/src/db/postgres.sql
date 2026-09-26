-- EBMS 反向链路数据底座 —— PostgreSQL 15 生产 DDL（PAND-84）
--
-- 与 schema.sql（node:sqlite 自检版）一一对应，约束口径完全一致：
-- 只含 Result / Exception / Evidence 三个契约对象表，「来源」是 evidences.source_system 字段。
-- 切换生产库只需替换 db/index.js 与 repositories 层实现，服务与接口契约不变。

BEGIN;

CREATE TABLE IF NOT EXISTS result_metrics (
  id                  TEXT PRIMARY KEY,
  result_id           TEXT NOT NULL UNIQUE,
  contract_version    TEXT NOT NULL DEFAULT 'AEOS.Result.V1',
  code                TEXT NOT NULL,
  name                TEXT NOT NULL,
  source_system       TEXT NOT NULL,
  object_type         TEXT NOT NULL DEFAULT 'BusinessMetric',
  object_id           TEXT NOT NULL,
  period_type         TEXT NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
  period_value        TEXT NOT NULL,
  target              NUMERIC(18, 4),
  actual              NUMERIC(18, 4),
  unit                TEXT,
  calculation_version TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'VERIFIED'
                        CHECK (status IN ('VERIFIED', 'PENDING', 'STALE')),
  trace_id            TEXT,
  occurred_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, period_type, period_value)
);

CREATE INDEX IF NOT EXISTS idx_result_metrics_period
  ON result_metrics (period_type, period_value);

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
  occurred_at      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exceptions_reason_code ON exceptions (reason_code);

-- 「来源」按契约字段化承载，允许为空（PAND-83 边界：显示「来源未标注」）
CREATE TABLE IF NOT EXISTS evidences (
  id               TEXT PRIMARY KEY,
  evidence_id      TEXT NOT NULL UNIQUE,
  contract_version TEXT NOT NULL DEFAULT 'AEOS.Evidence.V1',
  type             TEXT NOT NULL
                     CHECK (type IN ('document', 'contract', 'system_record', 'manual_note')),
  title            TEXT NOT NULL,
  formed_at        TIMESTAMPTZ NOT NULL,
  owner            TEXT,
  content          TEXT,
  source_system    TEXT,
  object_type      TEXT,
  object_id        TEXT,
  occurred_at      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidences_source_system ON evidences (source_system);

CREATE TABLE IF NOT EXISTS attributions (
  id               TEXT PRIMARY KEY,
  metric_id        TEXT NOT NULL REFERENCES result_metrics (id) ON DELETE CASCADE,
  parent_id        TEXT REFERENCES attributions (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('exception', 'm03_analysis')),
  exception_id     TEXT REFERENCES exceptions (id) ON DELETE RESTRICT,
  analysis_name    TEXT,
  direction        TEXT NOT NULL CHECK (direction IN ('positive', 'negative', 'neutral')),
  contribution_pct NUMERIC(6, 2)
                     CHECK (contribution_pct IS NULL
                            OR (contribution_pct > 0 AND contribution_pct <= 100)),
  impact_value     NUMERIC(18, 4),
  owner            TEXT NOT NULL,
  order_no         INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attributions_kind_carrier CHECK (
    (kind = 'exception'    AND exception_id IS NOT NULL AND analysis_name IS NULL)
    OR
    (kind = 'm03_analysis' AND exception_id IS NULL     AND analysis_name IS NOT NULL)
  ),
  CONSTRAINT attributions_has_magnitude
    CHECK (contribution_pct IS NOT NULL OR impact_value IS NOT NULL),
  CONSTRAINT attributions_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_attributions_metric
  ON attributions (metric_id, parent_id, order_no);
CREATE INDEX IF NOT EXISTS idx_attributions_exception
  ON attributions (exception_id);

CREATE TABLE IF NOT EXISTS attribution_evidences (
  attribution_id TEXT NOT NULL REFERENCES attributions (id) ON DELETE CASCADE,
  evidence_id    TEXT NOT NULL REFERENCES evidences (id) ON DELETE CASCADE,
  linked_by      TEXT,
  linked_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (attribution_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_attribution_evidences_evidence
  ON attribution_evidences (evidence_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  detail      TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id, at DESC);

CREATE OR REPLACE VIEW result_attribution_summary AS
SELECT m.id                       AS metric_id,
       m.code                     AS metric_code,
       COUNT(a.id)                AS attribution_count,
       COALESCE(SUM(a.contribution_pct) FILTER (WHERE a.parent_id IS NULL), 0)
                                  AS root_contribution_pct
FROM result_metrics m
       LEFT JOIN attributions a ON a.metric_id = m.id
GROUP BY m.id, m.code;

COMMIT;
