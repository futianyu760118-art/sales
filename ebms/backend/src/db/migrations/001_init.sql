-- EBMS 数据底座 · 迁移 001
-- 范围：F3 证据域（PAND-81）所需最小可用切片 + 其依赖的 Result/Reason 锚点与通用留痕。
-- 说明：EBMS 只存「结论 / 归因 / 证据 / 来源 / 判断 / 视图」与留痕，不复制专业中心业务明细。

-- ---------------------------------------------------------------- Result / Reason
-- F1（PAND-79）/ F2（PAND-80）的完整字段由各自 issue 交付；此处仅建立 Evidence 的挂载锚点。
CREATE TABLE IF NOT EXISTS result_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  dimension     TEXT NOT NULL CHECK (dimension IN ('finance', 'business')),
  period_type   TEXT NOT NULL CHECK (period_type IN ('day', 'week', 'month')),
  period_value  TEXT NOT NULL,
  as_of         TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, period_type, period_value)
);

CREATE TABLE IF NOT EXISTS result_reasons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_id        UUID REFERENCES result_metrics(id) ON DELETE CASCADE,
  parent_id        UUID REFERENCES result_reasons(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('positive', 'negative', 'neutral')),
  contribution_pct NUMERIC(5, 2),
  owner            TEXT,
  order_no         INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_result_reasons_metric ON result_reasons (metric_id);
CREATE INDEX IF NOT EXISTS idx_result_reasons_parent ON result_reasons (parent_id);

-- ---------------------------------------------------------------- Evidence 证据域
-- 证据类型为预定义枚举，取值仅限已确认四类：单据 / 合同 / 系统记录 / 人工说明。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'evidence_type') THEN
    CREATE TYPE evidence_type AS ENUM ('document', 'contract', 'system_record', 'manual_note');
  END IF;
END
$$;

-- 证据类型的中文口径（枚举的唯一权威映射，接口与前端均取自此表）
CREATE TABLE IF NOT EXISTS evidence_type_dict (
  code     evidence_type PRIMARY KEY,
  label    TEXT NOT NULL
);

INSERT INTO evidence_type_dict (code, label) VALUES
  ('document',      '单据'),
  ('contract',      '合同'),
  ('system_record', '系统记录'),
  ('manual_note',   '人工说明')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

CREATE TABLE IF NOT EXISTS evidences (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             evidence_type NOT NULL,
  -- 判定标准：标题、形成时间均非空
  title            TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  formed_at        TIMESTAMPTZ NOT NULL,
  owner            TEXT NOT NULL CHECK (length(btrim(owner)) > 0),
  -- 文本说明：文本说明类证据必可查看
  content          TEXT,
  -- 附件引用：非空数组表示「带附件」，可预览或下载
  attachment_refs  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachment_refs) = 'array'),
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidences_type ON evidences (type);
CREATE INDEX IF NOT EXISTS idx_evidences_formed_at ON evidences (formed_at);

-- Reason ↔ Evidence 显式关联表：支撑正向列表（PAND-81）与后续反向查询（PAND-84）。
CREATE TABLE IF NOT EXISTS reason_evidences (
  reason_id   UUID NOT NULL REFERENCES result_reasons(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidences(id) ON DELETE CASCADE,
  linked_by   TEXT NOT NULL,
  linked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 幂等约束：同一对 Reason/Evidence 不会被重复关联
  PRIMARY KEY (reason_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_reason_evidences_evidence ON reason_evidences (evidence_id);

-- ---------------------------------------------------------------- 通用留痕
-- 覆盖「新增 / 关联 / 解除关联」三类操作，记录操作人与时间。
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  -- 操作人可读名称（快照留存，避免用户改名后历史留痕失去可读性）
  actor_name  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('evidence.create', 'evidence.link', 'evidence.unlink')),
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  reason_id   UUID,
  before      JSONB,
  after       JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_reason ON audit_log (reason_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id, at DESC);

-- ---------------------------------------------------------------- 操作人（本切片最小身份）
CREATE TABLE IF NOT EXISTS ebms_users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username     TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('decider', 'owner')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
