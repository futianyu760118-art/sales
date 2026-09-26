# AEOS V7.2 — Accountable Owner 指定 V1

状态：P0 架构冻结交付物（W1）
上位基线：`architecture/SYSTEM_REGISTRY_V1.md`（M00–M12）、`docs/AEOS_V7.2_DATA_OWNERSHIP_V1.md`
责任模型来源：《EBMS_AEOS_V7.2_整改实施方案与12周行动计划_V1.0》§7 责任分工建议

## 1. Owner 角色模型

Owner 是「结果责任」，不是新增中层岗位。本表只做模块级 Accountable Owner 指定；
每个模块的**具名 Business Owner 与 System Lead** 需由业务方（付天宇）在 P0 Gate 签批时逐项确认（见 §4）。

| Owner 角色 | 主要责任 | 对应模块 |
|---|---|---|
| AEOS 架构 Owner | 冻结边界、审批跨域例外、ADR、Gate | M00、M11 |
| M01/M02 Owner | 共享内核、数据与证据契约 | M01、M02 |
| EBMS Owner | M03 管理闭环与用户体验、验收结果 | M03、M03A |
| 专业中心 Owner | 专业算法、专业事实源、Result/Exception 输出 | M04–M09（按中心拆分） |
| POMS Owner | 执行者工作面（1 Kernel + N Role Templates） | M10 |
| QA / DevSecOps Owner | 契约测试、回归、权限、异常、Evidence、发布门禁 | M12 |

## 2. M00–M12 模块级 Accountable Owner

| 编号 | 模块 | Accountable Owner（角色） | 具名人选 |
|---|---|---|---|
| M00 | 项目治理与架构控制 | AEOS 架构 Owner | 待业务确认 |
| M01 | AEOS Kernel | M01/M02 Owner | 待业务确认 |
| M02 | Enterprise Data & Evidence Platform | M01/M02 Owner | 待业务确认 |
| M03 | EBMS 企业经营管理与决策系统 | EBMS Owner | 待业务确认 |
| M03A | EBMS·产销自治模块 | EBMS Owner（M03 专业协同） | 待业务确认 |
| M04 | 研发自治中心 | 专业中心 Owner（研发） | 待业务确认 |
| M05 | 销售自治中心 | 专业中心 Owner（销售） | 待业务确认 |
| M06 | 交付自治中心 | 专业中心 Owner（交付） | 待业务确认 |
| M07 | 人才与后勤服务中心（恒聘通） | 专业中心 Owner（人才后勤） | 待业务确认 |
| M08 | 品控自治中心 | 专业中心 Owner（品控） | 待业务确认 |
| M09 | 财经自治中心 | 专业中心 Owner（财经） | 待业务确认 |
| M10 | POMS 岗位个人操作微系统 | POMS Owner | 待业务确认 |
| M11 | 集成与智能硬件接入 | AEOS 架构 Owner | 待业务确认 |
| M12 | DevSecOps / Observability / QA | QA / DevSecOps Owner | 待业务确认 |

## 3. EBMS 当前路由 → 目标模块 → Owner（完整登记表）

与 `backend/routes/index.js` 逐项一一对应（47 个挂载点，`/test` 仅开发环境挂载）。
Owner 列 = 目标模块对应的 Accountable Owner 角色。

| # | 路由挂载点 | 文件 | 当前域 | 目标模块 | Accountable Owner |
|---|---|---|---|---|---|
| 1 | `/inquiries` | routes/inquiry.js | 销售 | M05 销售自治 | 专业中心（销售） |
| 2 | `/products` | routes/product.js | 研发 | M04 研发自治 | 专业中心（研发） |
| 3 | `/customers` | routes/customer.js | 销售 | M05 销售自治 | 专业中心（销售） |
| 4 | `/materials` | routes/material.js | 交付/主数据 | M06/M02 | 专业中心（交付）+ M01/M02 Owner |
| 5 | `/material-costs` | routes/material-costs.js | 交付/财经 | M06/M09 | 专业中心（交付/财经） |
| 6 | `/materials-ext` | routes/material-ext.js | 交付/主数据 | M06/M02 | 专业中心（交付）+ M01/M02 Owner |
| 7 | `/procurement` | routes/procurement.js | 交付 | M06 交付自治 | 专业中心（交付） |
| 8 | `/suppliers` | routes/supplier.js | 交付 | M06 交付自治 | 专业中心（交付） |
| 9 | `/external-api` | routes/external-api.js | 集成 | M11 集成 | AEOS 架构 Owner |
| 10 | `/orders` | routes/order.js | 销售/交付 | M05/M06 | 专业中心（销售/交付） |
| 11 | `/samples` | routes/sample.js | 研发 | M04 研发自治 | 专业中心（研发） |
| 12 | `/projects` | routes/project.js | 研发 | M04 研发自治 | 专业中心（研发） |
| 13 | `/annual-plan` | routes/annual-plan.js | 管理 | M03 EBMS | EBMS Owner |
| 14 | `/amiba` | routes/amiba.js | 财经 | M09 财经自治 | 专业中心（财经） |
| 15 | `/products/bom-types` | routes/bom-type.js | 研发 | M04 研发自治 | 专业中心（研发） |
| 16 | `/products/bom-issues` | routes/bom-issue.js | 研发/品控 | M04/M08 | 专业中心（研发/品控） |
| 17 | `/pricing` | routes/pricing.js | 销售/财经 | M05/M09 | 专业中心（销售/财经） |
| 18 | `/quote` | routes/quote.js | 销售 | M05 销售自治 | 专业中心（销售） |
| 19 | `/users` | routes/user.js | Kernel | M01 Kernel | M01/M02 Owner |
| 20 | `/reports` | routes/report.js | 管理 | M03 EBMS | EBMS Owner |
| 21 | `/import` | routes/import.js | 研发/工具 | M04 研发自治 | 专业中心（研发） |
| 22 | `/permissions` | routes/permission.js | Kernel | M01 Kernel | M01/M02 Owner |
| 23 | `/feedback` | routes/feedback.js | 执行者 | M10 POMS | POMS Owner |
| 24 | `/settings` | routes/settings.js | 数据 | M02 Data & Evidence | M01/M02 Owner |
| 25 | `/test` | routes/test.js | QA | M12 DevSecOps/QA | QA Owner |
| 26 | `/compliance` | routes/compliance.js | 品控 | M08 品控自治 | 专业中心（品控） |
| 27 | `/configs` | routes/config.js | 研发 | M04 研发自治 | 专业中心（研发） |
| 28 | `/chat` | routes/chat.js | Kernel+管理 | M01 + M03 | M01/M02 Owner + EBMS Owner |
| 29 | `/rules` | routes/rules.js | Kernel | M01 Kernel（规则/Guard） | M01/M02 Owner |
| 30 | `/spec-library` | routes/spec-library.js | 研发 | M04 研发自治 | 专业中心（研发） |
| 31 | `/data-clean` | routes/data-clean.js | 数据 | M02 Data & Evidence | M01/M02 Owner |
| 32 | `/ai-assistant` | routes/ai-assistant.js | Kernel+管理 | M01 + M03 | M01/M02 Owner + EBMS Owner |
| 33 | `/bom` | routes/bom.js | 研发 | M04 研发自治 | 专业中心（研发） |
| 34 | `/external-sync` | routes/external-sync.js | 集成 | M11 集成 | AEOS 架构 Owner |
| 35 | `/external` | routes/external-service.js | 集成 | M11 集成 | AEOS 架构 Owner |
| 36 | `/tech` | routes/tech-transfer.js | 研发 | M04 研发自治 | 专业中心（研发） |
| 37 | `/organization` | routes/organization.js | Kernel | M01 Kernel | M01/M02 Owner |
| 38 | `/data-scope` | routes/data-scope.js | Kernel | M01 Kernel（数据权限） | M01/M02 Owner |
| 39 | `/material-check` | routes/material-check.js | 品控/交付 | M06/M08 | 专业中心（交付/品控） |
| 40 | `/expenses` | routes/expense.js | 财经 | M09 财经自治 | 专业中心（财经） |
| 41 | `/labor` | routes/labor.js | 财经 | M09 财经自治 | 专业中心（财经） |
| 42 | `/product-labor-rate` | routes/product-labor-rate.js | 财经 | M09 财经自治 | 专业中心（财经） |
| 43 | `/material-issues` | routes/material-issue.js | 品控/交付 | M06/M08 | 专业中心（交付/品控） |
| 44 | `/order-analysis` | routes/order-analysis.js | 管理 | M03/M03A | EBMS Owner |
| 45 | `/order-check` | routes/order-check.js | 交付/品控 | M06/M08 | 专业中心（交付/品控） |
| 46 | `/sop` | routes/sop.js | 产销协同 | M03A 产销自治 | EBMS Owner |
| 47 | `/im` | routes/im.js | Kernel/协作 | M01 Kernel（协作/消息） | M01/M02 Owner |

补充说明：
- `dashboard` 不是后端路由，是前端入口页（`frontend/dashboard.html`），数据来自 `/api/report/*`、`/api/annual-plan/dashboard`、`/api/order-analysis/report/summary` 三处，归属 M03 EBMS。
- 路由内部存在跨域直读的，见 `CROSS_DOMAIN_READS.md`；已冻结不再扩展的，见 `LEGACY_REGISTRY.md`。

## 4. 待签批事项（P0 Gate 收口前必须补齐）

1. 为 M00–M12 逐项确认具名 **Accountable Business Owner + System Lead**（当前仅到角色层）。
2. 每个「专业中心 Owner（销售/研发/交付/品控/财经/人才后勤）」对应到一个真实责任人。
3. 确认后回填本文件 §2 的「具名人选」列，P0 Gate 方可签字。
