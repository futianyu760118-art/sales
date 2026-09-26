# LEGACY_REGISTRY — Legacy 功能登记与替代路径

状态：P0 架构冻结交付物（W1）
上位基线：`docs/AEOS_V7.2_EBMS_DOMAIN_BOUNDARY_V1.md`、`architecture/EBMS_GUARDRAILS_V1.md`
口径：Legacy = 当前在 EBMS 内继续运行、但按 AEOS 边界应归属其他模块（M04–M09/M01/M02/M11/M12）的专业能力。**Legacy 只维护不扩张**；每条必须有 Owner、替代模块、目标 Gate。

## 1. Legacy 功能登记（按专业域分组）

| 专业域 | Legacy 功能/路由 | 当前 Owner | 替代模块 | 目标 Gate | 处理策略 |
|---|---|---|---|---|---|
| 销售 | `/inquiries` 询价管理 | 专业中心（销售） | M05 销售自治 | P2（W9） | 冻结，停止在 M03 扩展；迁移后走 Result Contract |
| 销售 | `/customers` 客户管理 | 专业中心（销售） | M05 销售自治 | P2 | 冻结 |
| 销售 | `/quote` 报价管理 | 专业中心（销售） | M05 销售自治 | P2 | 冻结 |
| 销售 | `/pricing` 商务报价（拆分成本算法） | 专业中心（销售/财经） | M05 商务 / M09 成本 | P2 | 拆分 |
| 销售 | `/rules` 商务流程规则（workflow_rules） | 专业中心（销售） | M01 Guard / M05 规则 | P2 | 下沉 |
| 研发 | `/products` 产品管理 | 专业中心（研发） | M04 研发自治 | P2 | 冻结 |
| 研发 | `/projects` 项目管理 | 专业中心（研发） | M04 研发自治 | P2 | 冻结 |
| 研发 | `/bom` `/products/bom-types` `/products/bom-issues` BOM 管理 | 专业中心（研发） | M04 研发自治 | P2 | 冻结 |
| 研发 | `/samples` 样品管理 | 专业中心（研发） | M04 研发自治 | P2 | 冻结 |
| 研发 | `/tech` 技术转移 | 专业中心（研发） | M04 研发自治 | P2 | 冻结 |
| 研发 | `/spec-library` 规格书库 | 专业中心（研发） | M04 研发自治 | P2 | 冻结 |
| 研发 | `/configs` 产品配置 | 专业中心（研发） | M04 研发自治 | P2 | 冻结 |
| 研发 | `/import` 研发导入工具 | 专业中心（研发） | M04 研发自治 | P2 | 冻结 |
| 交付 | `/materials` 物料库（主数据规则归 M02） | 专业中心（交付）+ M01/M02 Owner | M06 交付自治 / M02 MDM | P2 | 冻结，主数据 Owner 化 |
| 交付 | `/materials-ext` `/material-costs` 物料扩展/成本 | 专业中心（交付/财经） | M06/M09 | P2 | 冻结 |
| 交付 | `/procurement` 采购管理 | 专业中心（交付） | M06 交付自治 | P2 | 冻结 |
| 交付 | `/suppliers` 供应商管理 | 专业中心（交付） | M06 交付自治 | P2 | 冻结 |
| 交付 | `/orders` 订单（拆分商务/交付执行） | 专业中心（销售/交付） | M05 商务 / M06 交付 | P2 | 拆分 |
| 交付 | `/order-check` `/material-issues` `/material-check` 交付检查/异常 | 专业中心（交付/品控） | M06/M08 | P2 | 冻结 |
| 品控 | `/compliance` 合规检查 | 专业中心（品控） | M08 品控自治 | P2 | 冻结 |
| 财经 | `/amiba` 阿米巴成本核算 | 专业中心（财经） | M09 财经自治 | P2 | 冻结，算法下沉 |
| 财经 | `/expenses` 费用管理 | 专业中心（财经） | M09 财经自治 | P2 | 冻结 |
| 财经 | `/labor` `/product-labor-rate` 人工/工价 | 专业中心（财经） | M09 财经自治 | P2 | 冻结 |
| Kernel | `/users` `/permissions` `/organization` `/data-scope` 身份/权限/组织 | M01/M02 Owner | M01 AEOS Kernel | P2（W7） | 迁移为共享内核，冻结扩建 |
| Kernel | `/im` 即时通讯 | M01/M02 Owner | M01 Kernel（协作） | P2 | 下沉 |
| Kernel | `/chat` 会话（Agent/Skill/Memory 下沉，经营助手留入口） | M01/M02 Owner + EBMS Owner | M01 + M03 | P2 | 拆分 |
| Kernel | `/ai-assistant` AI 助手（Agent/Skill/Memory 下沉） | M01/M02 Owner + EBMS Owner | M01 + M03 | P2 | 拆分 |
| Data | `/settings` 系统设置 | M01/M02 Owner | M02 Data & Evidence | P2 | 下沉 |
| Data | `/data-clean` 数据清理 | M01/M02 Owner | M02 Data & Evidence | P2 | 下沉 |
| 集成 | `/external-api` `/external-sync` `/external` 外部对接/同步 | AEOS 架构 Owner | M11 集成 | P2（W9） | 连接器化 |
| QA | `/test` 测试端点（仅开发环境） | QA Owner | M12 DevSecOps/QA | P2 | 下沉 |

## 2. 重复事实源清单（本次确认的重复目录/副本）

| 重复项 | 事实源判定 | 处理 | 目标 Gate |
|---|---|---|---|
| `frontend/frontend/`（37 文件，其中 35 个与根目录版本内容分歧） | 唯一生产事实源 = 根目录 `frontend/`（`backend/server.js:165` 只 serve `../frontend`） | **本次已删除** `frontend/frontend/` 目录 | P0（W1）✅ |
| `orders` 被 annual-plan / report / order-analysis 重算销售额/利润 | Owner = M05 商务事实 + M09 毛利 Result | 收敛为 `AEOS.Result.V1`，不再多副本重算 | P1 |
| 成本事实多源：`bom_pricing` / `pricing_standards` / `product_labor_rate` / `order_cost_snapshots` | Owner = M09 | 统一成本 Result，`calculation_version` + `evidence_ids` | P2 |
| 身份事实多源：`users` / `personnel` / `org_personnel` | Owner = M01 | 收敛为 Kernel 单一主数据 | P2 |
| `materials` 被 `/external-api` 同步写入副本 | Owner = M06（主数据规则 M02） | 同步收敛为 M11 Connector，禁止第二事实源 | P2 |

## 3. 治理规则

- 任何 Legacy 路由**不得新增跨域专业 CRUD**；改动须先登记本条目的替代路径与到期日。
- 新增字段/新逻辑必须先标注 Owner（见 `docs/AEOS_V7.2_DATA_OWNERSHIP_V1.md` 临时规则）。
- 每个 Gate 的放行都要求：Owner 确认 + 替代路径落地 + 测试/UAT/Evidence。
