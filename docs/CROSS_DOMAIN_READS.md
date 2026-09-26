# CROSS_DOMAIN_READS — 跨域直接读取清单

状态：P0 架构冻结交付物（W1）
上位基线：`docs/AEOS_V7.2_DATA_OWNERSHIP_V1.md`
口径：本清单统计「路由直接读本模块以外 Owner 的 JSON 表」的行为。当前全部为同一 Node/Express/JSON 库内的直读（`getTable(...)`），属于迁移期技术债；**不得继续扩大**，新增字段/逻辑必须先标注 Owner。

## 1. 红线

- 禁止新增跨域直接写表（存量写表见 `LEGACY_REGISTRY.md`）。
- 管理面（M03/M03A）禁止用原始专业表重算专业算法；关键指标必须由 Owner 模块通过 Result Contract 提供 `calculation_version` + `evidence_ids`。
- 每个跨域直读条目必须有：读取方、被读表、表 Owner、迁移目标（Contract/API/Event）、目标 Gate。

## 2. M03/M03A 管理面直读专业事实（高危，优先整改）

这些是 EBMS 以「查询方便」为由重算专业结果的入口，是 P0 后首要收缩对象。

| 读取方 | 直读表 | 表 Owner | 读取性质 | 替代路径 | 目标 Gate |
|---|---|---|---|---|---|
| `/api/annual-plan/*`（经营驾驶舱/年度分析） | orders | M05/M06 | 重算销售额/利润/完成率 | `AEOS.Result.V1`（M09 毛利 Result、M05 销售 Result） | P1 |
| 同上 | materials | M06 | 重算库存风险 | M06 Result / Exception | P2 |
| 同上 | projects | M04 | 项目计划归集 | M04 Result | P2 |
| `/api/reports/*`（销售/绩效/询价分析） | customers, inquiries, inquiry_comments, inquiry_status_changes | M05 | 销售报表直读 | M05 Result | P2 |
| 同上 | operation_logs | M02 | 操作日志报表 | M02 Audit/Event | P2 |
| 同上 | training_plans, assessment_cycles | M07 | 培训/绩效直读 | M07 Result | P2 |
| `/api/order-analysis/*`（订单分析 v2） | orders, order_bom_details, order_products, bom_items | M04/M05/M06 | 成本/交付分析重算 | M06/M09 Result | P1（毛利试点） |
| 同上 | materials | M06 | 物料成本直读 | M06 Result | P2 |
| 同上 | expenses, labor | M09 | 费用/工价直读 | M09 Result | P2 |
| 同上 | material_issues, order_check_issues | M08 | 品质异常直读 | M08 Exception | P2 |
| `/api/sop/*`（S&OP 产销协调） | demand_forecasts, supply_capacities, supply_mrps, psi_headers, psi_lines | M06 | 产销计划直读 | M06/M03A Result | P2 |
| 同上 | md_boms | M04 | BOM 直读 | M04 Result | P2 |
| `dashboard.html` → `/api/order-analysis/report/summary` | 见 order-analysis 行 | 跨域 | 管理驾驶舱聚合 | Result/Exception/Decision/Evidence | P1 |

## 3. 专业域互读清单（Legacy，随模块下沉逐步消除）

专业域路由在迁移前仍跨读其他专业域的表，随「专业能力下沉到 M04–M09」逐项关停。

| 读取方（目标模块） | 直读表 | 表 Owner | 替代路径 | 目标 Gate |
|---|---|---|---|---|
| `/api/inquiries`（M05） | materials, products | M06/M04 | 通过 Contract 引用，不复制 | P2 |
| `/api/inquiries`（M05） | bom_pricing | M09 | M09 报价 Result | P2 |
| `/api/pricing`（M05/M09） | products, customers, inquiries | M04/M05 | 拆分商务报价与成本算法 | P2 |
| `/api/quote`（M05） | bom_pricing, products | M09/M04 | 报价 Result 契约 | P2 |
| `/api/amiba`（M09） | materials | M06 | M06 成本数据供给 | P2 |
| `/api/amiba`（M09） | org_departments, org_personnel, users | M01 | M01 组织主数据引用 | P2 |
| `/api/product`（M04） | materials, bom_pricing | M06/M09 | 专业域契约 | P2 |
| `/api/bom`（M04） | materials, orders, order_summaries | M06/M05 | BOM 与订单解耦 | P2 |
| `/api/material`（M06） | orders, products, bom_items, product_bom | M05/M04 | 交付/研发契约 | P2 |
| `/api/material-costs`（M06/M09） | orders, materials | M05/M06 | M09 成本 Result | P2 |
| `/api/procurement`（M06） | materials | M06（同域） | —（同域，非跨域） | — |
| `/api/supplier`（M06） | materials | M06（同域） | — | — |
| `/api/customer`（M05） | inquiries, orders, samples, rd_project_initiation, org_personnel, users | M05/M06/M04/M01 | 客户经营聚合走 Contract | P2 |
| `/api/order`（M05/M06） | bom_items, inquiries, org_personnel | M04/M05/M01 | 订单/研发/组织解耦 | P2 |
| `/api/order-check`（M06/M08） | orders, order_bom_details | M05/M06 | 交付能力验证接口 | P2 |
| `/api/sample`（M04） | inquiries | M05 | 样品-询价关联契约 | P2 |
| `/api/tech-transfer`（M04） | projects, rd_project_progress, rd_project_reviews, users | M04/M01 | 组织引用下沉 M01 | P2 |
| `/api/compliance`（M08） | bom_items, bom_pricing, materials, customers, inquiries, products, quote_library, permissions, roles | 跨域 | 品控仅保留合规事实，跨读走 Contract | P2 |
| `/api/material-check`（M06/M08） | materials, bom_items, product_bom | M06/M04 | 来料检验数据契约 | P2 |
| `/api/material-issues`（M06/M08） | materials, orders | M06/M05 | 异常 Exception 契约 | P2 |
| `/api/config`（M04） | bom_pricing, inquiries | M09/M05 | 产品配置与报价解耦 | P2 |
| `/api/spec-library`（M04） | inquiries, config_sheets | M05/M04 | 规格书契约 | P2 |
| `/api/external-api`（M11） | customers, materials, orders, order_bom_details, order_products, products, suppliers | 跨域 | 连接器只经 Contract 出入 | P2 |
| `/api/external-sync`（M11） | 跨域多表（customers/materials/orders/products/purchase_*/org_*/personnel/suppliers/bom_items） | 跨域 | 同步收敛为 Connector | P2 |

## 4. 共享域（M01/M02）被跨读反向索引

Kernel / Data 表被专业路由广泛直读，是「第二套用户/组织/权限」风险的来源，P0 后必须收敛为「只经 Kernel Adapter / Data Contract 访问」。

| 共享表 | Owner | 主要直读方 |
|---|---|---|
| users | M01 | inquiry, customer, order, material-ext, amiba, compliance, chat, feedback, im, organization, permission, tech-transfer, test |
| org_* / personnel / organizations | M01 | amiba, customer, order-analysis, external-sync, organization, tech-transfer |
| roles / permissions / role_permissions / user_roles | M01 | compliance, material-ext, organization, permission, test |
| operation_logs / audit_logs | M02 | report, sop, compliance |
| system_settings / data_dictionary | M02 | chat, external-sync, pricing, quote, settings, test |
| ai_*（学习/计划/行动/复盘） | M01/M03 | ai-assistant, annual-plan, chat |

## 5. 迁移优先级

1. **P1（W3）**：`annual-plan` 销售/利润改为消费 M09 `AEOS.Result.V1`（订单毛利试点），不再重算原始 orders；`order-analysis` 毛利同源。
2. **P1（W4）**：交付风险改为消费 M06/M03A `AEOS.Exception.V1`，dashboard 只做展示。
3. **P2（W7–W9）**：M01/M02 表访问收敛为 Kernel Adapter / Data Contract；M05/M09 结果接口化。
4. **P3（W10）**：跨域直读数量进入持续下降曲线；新字段/新逻辑 100% 标注 Owner。
