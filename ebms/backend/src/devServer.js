// 开发/验收自检入口：以内存数据层启动，种子数据与 migrations/002_seed_dev.sql 一致。
// 生产入口为 src/server.js（PostgreSQL）。本文件不参与生产部署。
import { createApp } from './app.js';
import { config } from './config.js';
import { createMemoryRepositories } from './repositories/memory/memoryRepositories.js';
import { createAdapters } from './ingest/centerAdapters.js';
import { CENTER_PAYLOADS, DEV_PERIODS, buildSeedConclusions } from './dev/seedCrossDomain.js';

const METRICS = [
  { id: 'm-revenue-202608', code: 'revenue', name: '营业收入', dimension: 'finance', unit: '万元', period_type: 'month', period_value: '2026-08', target: 1000, actual: 880, deviation_abs: -120, deviation_pct: -12, threshold_pct: 5, data_status: 'ok', as_of: '2026-09-05T00:00:00+08:00' },
  { id: 'm-gross-margin-202608', code: 'gross_margin', name: '毛利率', dimension: 'finance', unit: '%', period_type: 'month', period_value: '2026-08', target: 32, actual: 25.6, deviation_abs: -6.4, deviation_pct: -20, threshold_pct: 5, data_status: 'ok', as_of: '2026-09-05T00:00:00+08:00' },
  { id: 'm-otd-202608', code: 'on_time_delivery', name: '订单交付率', dimension: 'business', unit: '%', period_type: 'month', period_value: '2026-08', target: 100, actual: 87, deviation_abs: -13, deviation_pct: -13, threshold_pct: 5, data_status: 'ok', as_of: '2026-09-05T00:00:00+08:00' },
  { id: 'm-headcount-cost-202608', code: 'headcount_cost', name: '人力成本', dimension: 'finance', unit: '万元', period_type: 'month', period_value: '2026-08', target: 300, actual: 305, deviation_abs: 5, deviation_pct: 1.67, threshold_pct: 5, data_status: 'ok', as_of: '2026-09-05T00:00:00+08:00' },
];

const REASONS = [
  { id: 'r-rev-1', metric_id: 'm-revenue-202608', parent_id: null, name: '主力产品单价下调', direction: 'negative', contribution_pct: 45, impact_value: -54, owner: '销售中心', owner_type: 'center', order_no: 1 },
  { id: 'r-rev-2', metric_id: 'm-revenue-202608', parent_id: null, name: '华东区订单流失', direction: 'negative', contribution_pct: 35, impact_value: -42, owner: '销售中心-华东大区', owner_type: 'department', order_no: 2 },
  { id: 'r-rev-3', metric_id: 'm-revenue-202608', parent_id: null, name: '汇率折算影响', direction: 'negative', contribution_pct: 20, impact_value: -24, owner: '财务中心', owner_type: 'center', order_no: 3 },
  { id: 'r-rev-2-1', metric_id: 'm-revenue-202608', parent_id: 'r-rev-2', name: '大客户 A 转投竞品', direction: 'negative', contribution_pct: 20, impact_value: -24, owner: '销售中心-华东大区', owner_type: 'department', order_no: 1 },
  { id: 'r-rev-2-2', metric_id: 'm-revenue-202608', parent_id: 'r-rev-2', name: '区域渠道库存积压', direction: 'negative', contribution_pct: 15, impact_value: -18, owner: '生产交付中心', owner_type: 'center', order_no: 2 },
  { id: 'r-rev-2-1-1', metric_id: 'm-revenue-202608', parent_id: 'r-rev-2-1', name: '竞品降价 8% 且账期延长 30 天', direction: 'negative', contribution_pct: 12, impact_value: -14.4, owner: '销售中心-华东大区', owner_type: 'department', order_no: 1 },
  { id: 'r-rev-2-1-2', metric_id: 'm-revenue-202608', parent_id: 'r-rev-2-1', name: '我方交付周期由 30 天延长至 45 天', direction: 'negative', contribution_pct: 8, impact_value: -9.6, owner: '生产交付中心', owner_type: 'center', order_no: 2 },
  { id: 'r-gm-1', metric_id: 'm-gross-margin-202608', parent_id: null, name: '原材料采购价上涨', direction: 'negative', contribution_pct: 40, impact_value: -2.56, owner: '供应链中心', owner_type: 'center', order_no: 1 },
  { id: 'r-gm-2', metric_id: 'm-gross-margin-202608', parent_id: null, name: '低毛利产品占比上升', direction: 'negative', contribution_pct: 20, impact_value: -1.28, owner: '销售中心', owner_type: 'center', order_no: 2 },
  { id: 'r-gm-3', metric_id: 'm-gross-margin-202608', parent_id: null, name: '生产效率改善带来的成本下降', direction: 'positive', contribution_pct: 10, impact_value: 0.64, owner: '生产交付中心', owner_type: 'center', order_no: 3 },
];

const repos = createMemoryRepositories({
  metrics: METRICS,
  reasons: REASONS,
  // 跨域结论快照预置（与 004_seed_cross_domain.sql 一致），使跨域判断开箱可见
  conclusions: buildSeedConclusions(),
});

// 四域 adapter：dev 环境走「人工录入 / 文件导入」兜底（三域接口未确认），
// 数据源为同一份种子，从而可完整演示 POST /api/v1/conclusions/ingest → 跨域判断刷新。
const centerConfig = {};
for (const center of ['sales', 'production', 'finance', 'supply_chain']) {
  centerConfig[center] = {
    mode: 'manual',
    loader: ({ center: c, periodValue }) => CENTER_PAYLOADS[`${c}|month|${periodValue}`] ?? null,
  };
}
const adapters = createAdapters({ centerConfig });

const app = createApp({ ...repos, adapters, enforceAuth: config.enforceAuth });

app.listen(config.port, () => {
  console.log(`[ebms] dev backend on http://localhost:${config.port}`);
  console.log('[ebms] 自检指标：m-revenue-202608（完全归因/多级）· m-gross-margin-202608（部分归因）· m-otd-202608（未归因）');
  console.log(
    `[ebms] 跨域判断自检周期：${DEV_PERIODS.map((p) => p.label).join(' · ')}`,
  );
  console.log(
    `[ebms] 例：GET /api/v1/judgments?period_type=month&period_value=2026-08（四域汇聚）· 2026-09（供应链域缺失）`,
  );
});
