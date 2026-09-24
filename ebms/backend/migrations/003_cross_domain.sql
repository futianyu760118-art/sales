-- EBMS 数据底座 · 跨域判断域（PAND-91 / F13）
-- 依据架构方案 3.3 数据模型核心表：domain_conclusions、cross_domain_judgments。

BEGIN;

-- 专业中心结论快照：payload 原样落库（EBMS 不加工），保证「展示值与中心输出值一致」。
-- 粒度 = (中心, 周期类型, 周期值)；中心重报时以最新批次覆盖（version/as_of 随快照更新）。
CREATE TABLE IF NOT EXISTS domain_conclusions (
  id             TEXT        PRIMARY KEY,
  center         TEXT        NOT NULL
                   CHECK (center IN ('sales', 'production', 'finance', 'supply_chain')),
  period_type    TEXT        NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
  period_value   TEXT        NOT NULL,
  version        TEXT,
  as_of          TIMESTAMPTZ,
  payload        JSONB,
  missing        BOOLEAN     NOT NULL DEFAULT false,
  -- 缺失原因枚举：与 domain/judgment.js MISSING_REASON 一致
  missing_reason TEXT
                   CHECK (missing_reason IN ('no_conclusion', 'unreachable', 'timeout', 'no_data', 'import_failed')),
  source_mode    TEXT        NOT NULL DEFAULT 'api' CHECK (source_mode IN ('api', 'manual', 'file')),
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 有结论则必须有 payload；缺失域允许空 payload（「该域数据缺失」）
  CONSTRAINT domain_conclusions_payload_present CHECK (missing = true OR payload IS NOT NULL),
  CONSTRAINT domain_conclusions_missing_reason CHECK (
    (missing = false AND missing_reason IS NULL) OR (missing = true AND missing_reason IS NOT NULL)
  ),
  UNIQUE (center, period_type, period_value)
);

CREATE INDEX IF NOT EXISTS idx_domain_conclusions_period
  ON domain_conclusions (period_type, period_value, center);

-- 跨域经营判断：粒度 = (周期类型, 周期值, 规则版本)。
-- detail 保存完整评估结果（引用明细、域视图、耦合指标等），摘要列供查询与审计。
CREATE TABLE IF NOT EXISTS cross_domain_judgments (
  id                        TEXT        PRIMARY KEY,
  period_type               TEXT        NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
  period_value              TEXT        NOT NULL,
  rule_version              TEXT        NOT NULL,
  level                     TEXT        NOT NULL
                              CHECK (level IN ('critical', 'warning', 'attention', 'stable', 'insufficient_data')),
  conclusion                TEXT        NOT NULL,
  present_domains           TEXT[]      NOT NULL DEFAULT '{}',
  missing_domains           TEXT[]      NOT NULL DEFAULT '{}',
  -- 引用快照 id 列表：跨域结论 → 专业中心结论的可追溯锚点
  referenced_conclusion_ids TEXT[]      NOT NULL DEFAULT '{}',
  can_judge                 BOOLEAN     NOT NULL DEFAULT false,
  detail                    JSONB,
  generated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period_type, period_value, rule_version)
);

CREATE INDEX IF NOT EXISTS idx_cross_domain_judgments_period
  ON cross_domain_judgments (period_type, period_value, generated_at DESC);

COMMIT;
