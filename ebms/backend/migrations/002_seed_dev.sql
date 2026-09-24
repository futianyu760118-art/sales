-- 开发/验收用种子数据（非生产数据）。覆盖 PAND-80 的场景与边界：
--   1) revenue    营业收入  负偏差 + 完全归因（三层原因）
--   2) gross_margin 毛利率  负偏差 + 部分归因（顶层合计 70%）
--   3) on_time_delivery 订单交付率 负偏差 + 无关联原因（「未归因」边界）
--   4) headcount_cost 人力成本 中性偏差（未超阈值）

BEGIN;

INSERT INTO result_metrics (id, code, name, dimension, unit, period_type, period_value,
                            target, actual, deviation_abs, deviation_pct, threshold_pct, data_status, as_of)
VALUES
  ('m-revenue-202608', 'revenue', '营业收入', 'finance', '万元', 'month', '2026-08',
   1000.0000, 880.0000, -120.0000, -12.0000, 5.0000, 'ok', '2026-09-05T00:00:00+08:00'),
  ('m-gross-margin-202608', 'gross_margin', '毛利率', 'finance', '%', 'month', '2026-08',
   32.0000, 25.6000, -6.4000, -20.0000, 5.0000, 'ok', '2026-09-05T00:00:00+08:00'),
  ('m-otd-202608', 'on_time_delivery', '订单交付率', 'business', '%', 'month', '2026-08',
   100.0000, 87.0000, -13.0000, -13.0000, 5.0000, 'ok', '2026-09-05T00:00:00+08:00'),
  ('m-headcount-cost-202608', 'headcount_cost', '人力成本', 'finance', '万元', 'month', '2026-08',
   300.0000, 305.0000, 5.0000, 1.6700, 5.0000, 'ok', '2026-09-05T00:00:00+08:00')
ON CONFLICT (id) DO NOTHING;

-- 场景 2：完全归因，顶层合计 = 45 + 35 + 20 = 100%（误差 0 ≤ 1%）
INSERT INTO result_reasons (id, metric_id, parent_id, name, direction, contribution_pct, impact_value,
                            owner, owner_type, order_no, note)
VALUES
  ('r-rev-1', 'm-revenue-202608', NULL, '主力产品单价下调', 'negative', 45.00, -54.00, '销售中心', 'center', 1, NULL),
  ('r-rev-2', 'm-revenue-202608', NULL, '华东区订单流失', 'negative', 35.00, -42.00, '销售中心-华东大区', 'department', 2, NULL),
  ('r-rev-3', 'm-revenue-202608', NULL, '汇率折算影响', 'negative', 20.00, -24.00, '财务中心', 'center', 3, NULL),
  -- 场景 3：Reason 层多级展开（L2 → L3）
  ('r-rev-2-1', 'm-revenue-202608', 'r-rev-2', '大客户 A 转投竞品', 'negative', 20.00, -24.00, '销售中心-华东大区', 'department', 1, NULL),
  ('r-rev-2-2', 'm-revenue-202608', 'r-rev-2', '区域渠道库存积压', 'negative', 15.00, -18.00, '生产交付中心', 'center', 2, NULL),
  ('r-rev-2-1-1', 'm-revenue-202608', 'r-rev-2-1', '竞品降价 8% 且账期延长 30 天', 'negative', 12.00, -14.40, '销售中心-华东大区', 'department', 1, NULL),
  ('r-rev-2-1-2', 'm-revenue-202608', 'r-rev-2-1', '我方交付周期由 30 天延长至 45 天', 'negative', 8.00, -9.60, '生产交付中心', 'center', 2, NULL),
  -- 部分归因：顶层合计 70%，未归因 30%
  ('r-gm-1', 'm-gross-margin-202608', NULL, '原材料采购价上涨', 'negative', 40.00, -2.56, '供应链中心', 'center', 1, NULL),
  ('r-gm-2', 'm-gross-margin-202608', NULL, '低毛利产品占比上升', 'negative', 20.00, -1.28, '销售中心', 'center', 2, NULL),
  ('r-gm-3', 'm-gross-margin-202608', NULL, '生产效率改善带来的成本下降', 'positive', 10.00, 0.64, '生产交付中心', 'center', 3, NULL)
ON CONFLICT (id) DO NOTHING;

-- m-otd-202608 故意不插入任何原因项 —— 覆盖「未归因」边界
-- m-headcount-cost-202608 偏差 1.67% 未超阈值 5%，属正常波动，不强制归因

COMMIT;
