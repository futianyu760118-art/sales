-- 开发/验收用种子数据（非生产数据）· 覆盖 PAND-91 的场景与边界：
--   2026-08：销售 / 生产·交付 / 财务 / 供应链 四域齐全 → 场景 1（展示跨域判断 + 引用明细）
--            且四域均存在负向偏差 → 判断层级 critical；销售与生产共同上报 on_time_delivery → 跨域耦合
--            12 个指标 × 4 个取值字段 = 48 条可比对样本 → 判定标准（抽样不少于 10 条）
--   2026-09：供应链域缺失（timeout）→ 边界（标注「该域数据缺失」，其余三域仍可判断）
-- 取值口径与 002_seed_dev.sql 的 result_metrics 对齐（revenue / gross_margin / on_time_delivery）。
-- cross_domain_judgments 不在此预置：判断由结论接入事件或 GET /api/v1/judgments 依快照实时物化。

BEGIN;

INSERT INTO domain_conclusions (id, center, period_type, period_value, version, as_of, payload, missing, missing_reason, source_mode)
VALUES
  -- 销售中心
  ('dc-sales-202608', 'sales', 'month', '2026-08', 'v2026-08.3', '2026-09-05T00:00:00+08:00',
   '{"center":"sales","period":{"type":"month","value":"2026-08"},"as_of":"2026-09-05T00:00:00+08:00","version":"v2026-08.3","metrics":[{"code":"revenue","name":"营业收入","target":1000,"actual":880,"unit":"万元","deviation_abs":-120,"deviation_pct":-12,"threshold_pct":5,"data_status":"ok"},{"code":"on_time_delivery","name":"订单交付率","target":100,"actual":87,"unit":"%","deviation_abs":-13,"deviation_pct":-13,"threshold_pct":5,"data_status":"ok"},{"code":"new_order_amount","name":"新增订单金额","target":1200,"actual":1260,"unit":"万元","deviation_abs":60,"deviation_pct":5,"threshold_pct":5,"data_status":"ok"}],"reasons":[{"metric_code":"revenue","name":"主力产品单价下调","direction":"negative","contribution_pct":45,"owner":"销售中心"},{"metric_code":"revenue","name":"华东区订单流失","direction":"negative","contribution_pct":35,"owner":"销售中心-华东大区"},{"metric_code":"revenue","name":"汇率折算影响","direction":"negative","contribution_pct":20,"owner":"财务中心"}]}'::jsonb,
   false, NULL, 'api'),

  -- 生产/交付中心
  ('dc-production-202608', 'production', 'month', '2026-08', 'v2026-08.2', '2026-09-06T00:00:00+08:00',
   '{"center":"production","period":{"type":"month","value":"2026-08"},"as_of":"2026-09-06T00:00:00+08:00","version":"v2026-08.2","metrics":[{"code":"capacity_utilization","name":"产能利用率","target":85,"actual":78,"unit":"%","deviation_abs":-7,"deviation_pct":-8.24,"threshold_pct":5,"data_status":"ok"},{"code":"on_time_delivery","name":"订单交付率","target":100,"actual":87,"unit":"%","deviation_abs":-13,"deviation_pct":-13,"threshold_pct":5,"data_status":"ok"},{"code":"unit_cost","name":"单位生产成本","target":100,"actual":96,"unit":"元","deviation_abs":-4,"deviation_pct":-4,"threshold_pct":5,"data_status":"ok"}],"reasons":[{"metric_code":"on_time_delivery","name":"产能瓶颈","direction":"negative","contribution_pct":60,"owner":"生产交付中心"},{"metric_code":"capacity_utilization","name":"设备故障停机","direction":"negative","contribution_pct":40,"owner":"生产交付中心"}]}'::jsonb,
   false, NULL, 'api'),

  -- 财务中心
  ('dc-finance-202608', 'finance', 'month', '2026-08', 'v2026-08.1', '2026-09-07T00:00:00+08:00',
   '{"center":"finance","period":{"type":"month","value":"2026-08"},"as_of":"2026-09-07T00:00:00+08:00","version":"v2026-08.1","metrics":[{"code":"gross_margin","name":"毛利率","target":32,"actual":25.6,"unit":"%","deviation_abs":-6.4,"deviation_pct":-20,"threshold_pct":5,"data_status":"ok"},{"code":"expense_ratio","name":"期间费用率","target":18,"actual":17.2,"unit":"%","deviation_abs":-0.8,"deviation_pct":-4.44,"threshold_pct":5,"data_status":"ok"},{"code":"operating_cash_flow","name":"经营性现金流","target":500,"actual":520,"unit":"万元","deviation_abs":20,"deviation_pct":4,"threshold_pct":5,"data_status":"ok"}],"reasons":[{"metric_code":"gross_margin","name":"原材料采购价上涨","direction":"negative","contribution_pct":40,"owner":"供应链中心"}]}'::jsonb,
   false, NULL, 'api'),

  -- 供应链中心
  ('dc-supply-chain-202608', 'supply_chain', 'month', '2026-08', 'v2026-08.4', '2026-09-08T00:00:00+08:00',
   '{"center":"supply_chain","period":{"type":"month","value":"2026-08"},"as_of":"2026-09-08T00:00:00+08:00","version":"v2026-08.4","metrics":[{"code":"purchase_ontime_rate","name":"采购到货及时率","target":95,"actual":88,"unit":"%","deviation_abs":-7,"deviation_pct":-7.37,"threshold_pct":5,"data_status":"ok"},{"code":"purchase_price_index","name":"原材料采购价格指数","target":100,"actual":108,"unit":"指数","deviation_abs":8,"deviation_pct":8,"threshold_pct":5,"data_status":"ok"},{"code":"inventory_turnover_days","name":"库存周转天数","target":45,"actual":48,"unit":"天","deviation_abs":3,"deviation_pct":6.67,"threshold_pct":5,"data_status":"ok"}],"reasons":[{"metric_code":"purchase_ontime_rate","name":"供应商交付延迟","direction":"negative","contribution_pct":70,"owner":"供应链中心"}]}'::jsonb,
   false, NULL, 'api'),

  -- 边界：2026-09 供应链域缺失（拉取超时）→ 跨域判断须标注「该域数据缺失」且其余域仍可判断
  ('dc-sales-202609', 'sales', 'month', '2026-09', 'v2026-09.1', '2026-10-05T00:00:00+08:00',
   '{"center":"sales","period":{"type":"month","value":"2026-09"},"as_of":"2026-10-05T00:00:00+08:00","version":"v2026-09.1","metrics":[{"code":"revenue","name":"营业收入","target":1000,"actual":910,"unit":"万元","deviation_abs":-90,"deviation_pct":-9,"threshold_pct":5,"data_status":"ok"},{"code":"on_time_delivery","name":"订单交付率","target":100,"actual":89,"unit":"%","deviation_abs":-11,"deviation_pct":-11,"threshold_pct":5,"data_status":"ok"},{"code":"new_order_amount","name":"新增订单金额","target":1200,"actual":1150,"unit":"万元","deviation_abs":-50,"deviation_pct":-4.17,"threshold_pct":5,"data_status":"ok"}],"reasons":[{"metric_code":"revenue","name":"华东区订单流失","direction":"negative","contribution_pct":55,"owner":"销售中心-华东大区"}]}'::jsonb,
   false, NULL, 'api'),

  ('dc-production-202609', 'production', 'month', '2026-09', 'v2026-09.1', '2026-10-06T00:00:00+08:00',
   '{"center":"production","period":{"type":"month","value":"2026-09"},"as_of":"2026-10-06T00:00:00+08:00","version":"v2026-09.1","metrics":[{"code":"capacity_utilization","name":"产能利用率","target":85,"actual":80,"unit":"%","deviation_abs":-5,"deviation_pct":-5.88,"threshold_pct":5,"data_status":"ok"},{"code":"on_time_delivery","name":"订单交付率","target":100,"actual":89,"unit":"%","deviation_abs":-11,"deviation_pct":-11,"threshold_pct":5,"data_status":"ok"},{"code":"unit_cost","name":"单位生产成本","target":100,"actual":97,"unit":"元","deviation_abs":-3,"deviation_pct":-3,"threshold_pct":5,"data_status":"ok"}],"reasons":[{"metric_code":"on_time_delivery","name":"产能瓶颈","direction":"negative","contribution_pct":65,"owner":"生产交付中心"}]}'::jsonb,
   false, NULL, 'api'),

  ('dc-finance-202609', 'finance', 'month', '2026-09', 'v2026-09.1', '2026-10-07T00:00:00+08:00',
   '{"center":"finance","period":{"type":"month","value":"2026-09"},"as_of":"2026-10-07T00:00:00+08:00","version":"v2026-09.1","metrics":[{"code":"gross_margin","name":"毛利率","target":32,"actual":27,"unit":"%","deviation_abs":-5,"deviation_pct":-15.63,"threshold_pct":5,"data_status":"ok"},{"code":"expense_ratio","name":"期间费用率","target":18,"actual":17.4,"unit":"%","deviation_abs":-0.6,"deviation_pct":-3.33,"threshold_pct":5,"data_status":"ok"},{"code":"operating_cash_flow","name":"经营性现金流","target":500,"actual":530,"unit":"万元","deviation_abs":30,"deviation_pct":6,"threshold_pct":5,"data_status":"ok"}],"reasons":[{"metric_code":"gross_margin","name":"原材料采购价上涨","direction":"negative","contribution_pct":45,"owner":"供应链中心"}]}'::jsonb,
   false, NULL, 'api'),

  -- 缺失域：无 payload，仅记录缺失原因，便于跨域判断标注「该域数据缺失」
  ('dc-supply-chain-202609', 'supply_chain', 'month', '2026-09', NULL, NULL, NULL,
   true, 'timeout', 'api')
ON CONFLICT (center, period_type, period_value) DO NOTHING;

COMMIT;
