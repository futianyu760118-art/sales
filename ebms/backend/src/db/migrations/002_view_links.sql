-- EBMS 数据底座 · 迁移 002
-- 范围：F11 四视图对象交叉跳转（PAND-89）所需的「四类视图对象锚点 + object_links 关联」。
-- 说明：EBMS 只存「结论 / 归因 / 证据 / 来源 / 判断 / 视图」与留痕，不复制专业中心业务明细。

-- ---------------------------------------------------------------- 四视图对象类型
-- 四视图 = REPORT(=Result) / TODO(=Action) / Decision / Evidence（PAND-96 重核口径）。
-- 枚举为交叉跳转的唯一取值来源：任何链接两端的 type 必须落在本枚举内。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'view_object_type') THEN
    CREATE TYPE view_object_type AS ENUM ('report', 'todo', 'decision', 'evidence');
  END IF;
END
$$;

-- ---------------------------------------------------------------- 视图对象锚点表
-- PAND-89（F11）只需要「能被链接、能被解析出落点」的对象身份，因此这里只建锚点。
-- 约定（与 001 中 result_metrics / result_reasons 一致）：各视图的完整字段由
-- 归属 issue 以 ALTER TABLE 追加，本迁移不臆造其业务列：
--   reports   → F7 REPORT 视图  (PAND-85)
--   todos     → F8 TODO 视图    (PAND-86)
--   decisions → F9 Decision 视图(PAND-87)
--   evidences → F10 Evidence 视图(PAND-88，表结构见 001)
CREATE TABLE IF NOT EXISTS reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  conclusion   TEXT,
  period_type  TEXT CHECK (period_type IN ('day', 'week', 'month')),
  period_value TEXT,
  domain       TEXT,
  owner        TEXT,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS todos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  source     TEXT NOT NULL CHECK (source IN ('rule', 'manual')),
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
  owner      TEXT,
  due_at     TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decisions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  background TEXT,
  conclusion TEXT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'decided')),
  decider    TEXT,
  decided_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- 交叉跳转关联
-- PAND-77 架构方案 §3.3：object_links —— 四视图对象互相跳转
--   from_type/from_id、to_type/to_id（Report/TODO/Decision/Evidence 两两可达）
--
-- 语义：一行 = 一条「关联」，天然双向可达（Report↔TODO 一行即可正反两向跳转），
-- 因此用规范化唯一索引保证同一对对象只存在一行，避免正反各写一行导致的不一致。
-- AC「四类视图两两之间的可达路径均存在（全部有向组合均可用）」由「关联双向可达」满足。
CREATE TABLE IF NOT EXISTS object_links (
  id            BIGSERIAL PRIMARY KEY,
  from_type     view_object_type NOT NULL,
  from_id       UUID NOT NULL,
  to_type       view_object_type NOT NULL,
  to_id         UUID NOT NULL,
  -- 规范化配对键：应用写入时取 "<type>:<id>" 的字典序小/大两端。
  -- 同一对对象无论方向只占一行 → 既保证关联幂等，又天然双向可达。
  -- （不用表达式索引：enum::text 非 IMMUTABLE，无法进入索引表达式。）
  pair_a        TEXT NOT NULL,
  pair_b        TEXT NOT NULL,
  -- 关联语义：related（一般关联）/ derived_from（派生）/ evidences（佐证）/ executes（决策执行）
  relation_type TEXT NOT NULL DEFAULT 'related'
                CHECK (relation_type IN ('related', 'derived_from', 'evidences', 'executes')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 禁止自关联：同一对象不能与自己建立关联
  CONSTRAINT object_links_no_self CHECK (NOT (from_type = to_type AND from_id = to_id)),
  -- 配对键必须已按字典序归一，杜绝同一对出现正反两行
  CONSTRAINT object_links_pair_sorted CHECK (pair_a <= pair_b),
  CONSTRAINT object_links_pair_unique UNIQUE (pair_a, pair_b)
);

-- 两端各自建索引：交叉跳转查询以「对象」为入口，正反两个方向都要走索引
CREATE INDEX IF NOT EXISTS idx_object_links_from ON object_links (from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_object_links_to ON object_links (to_type, to_id);

-- ---------------------------------------------------------------- 留痕口径扩展
-- 架构方案 §3.2.2 统一约定「所有写操作过审计留痕」：新增/解除关联进入既有 audit_log。
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('evidence.create', 'evidence.link', 'evidence.unlink',
                    'view_link.create', 'view_link.delete'));
