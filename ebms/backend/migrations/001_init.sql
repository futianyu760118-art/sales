-- EBMS 数据底座（阶段 0 地基）· 含 PAND-80 归因域
-- 依据架构方案 3.3 数据模型核心表。

BEGIN;

CREATE TABLE IF NOT EXISTS result_metrics (
  id             TEXT PRIMARY KEY,
  code           TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  dimension      TEXT        NOT NULL CHECK (dimension IN ('finance', 'business')),
  unit           TEXT,
  period_type    TEXT        NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
  period_value   TEXT        NOT NULL,
  target         NUMERIC(18, 4),
  actual         NUMERIC(18, 4),
  deviation_abs  NUMERIC(18, 4),
  deviation_pct  NUMERIC(10, 4),
  threshold_pct  NUMERIC(10, 4) NOT NULL DEFAULT 5,
  data_status    TEXT        NOT NULL DEFAULT 'ok' CHECK (data_status IN ('ok', 'no_data', 'stale')),
  no_data_reason TEXT CHECK (no_data_reason IN ('not_entered', 'not_synced')),
  as_of          TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, period_type, period_value)
);

-- 归因域：原因项，parent_id 自引用支撑 Reason 层多级展开；
-- 固定四层链路是逻辑层级，非表结构层级（Result→Reason→Evidence→Source）。
CREATE TABLE IF NOT EXISTS result_reasons (
  id               TEXT PRIMARY KEY,
  metric_id        TEXT        NOT NULL REFERENCES result_metrics (id) ON DELETE CASCADE,
  parent_id        TEXT        REFERENCES result_reasons (id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  direction        TEXT        NOT NULL CHECK (direction IN ('positive', 'negative', 'neutral')),
  contribution_pct NUMERIC(6, 2),
  impact_value     NUMERIC(18, 4),
  owner            TEXT        NOT NULL,
  owner_type       TEXT        NOT NULL DEFAULT 'center'
                     CHECK (owner_type IN ('center', 'department', 'role', 'external')),
  order_no         INTEGER     NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id <> parent_id),
  CHECK (contribution_pct IS NULL OR (contribution_pct > 0 AND contribution_pct <= 100)),
  -- AC：每条原因须含影响方向与「影响量或贡献占比」至少一项
  CHECK (contribution_pct IS NOT NULL OR impact_value IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_result_reasons_metric
  ON result_reasons (metric_id, parent_id, order_no);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT        NOT NULL,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  entity_id   TEXT        NOT NULL,
  before      JSONB,
  after       JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id, at DESC);

-- 归因汇总视图：顶层贡献占比合计（口径：仅顶层计入合计，子项是对父项的细分）
CREATE OR REPLACE VIEW result_attribution_summary AS
SELECT m.id                                                              AS metric_id,
       m.code                                                            AS metric_code,
       COALESCE(SUM(r.contribution_pct) FILTER (WHERE r.parent_id IS NULL), 0)::NUMERIC(8, 2)
                                                                         AS root_contribution_pct,
       COUNT(r.id)                                                       AS reason_count
FROM result_metrics m
       LEFT JOIN result_reasons r ON r.metric_id = m.id
GROUP BY m.id, m.code;

COMMIT;
