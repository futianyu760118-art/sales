# AEOS V7.2 — Current → Target Module Mapping V1

| 当前能力/路由 | 目标模块 | 当前处理 |
|---|---|---|
| dashboard | M03 EBMS | 保留并改造成 Result/Exception/Decision/Evidence 工作面 |
| annual-plan | M03 EBMS | 保留，目标与行动闭环化 |
| report | M03 EBMS | 保留 |
| sop | M03A 产销自治 | 逻辑隔离，后续独立服务 |
| order-analysis | M03/M03A | 只保留管理分析，专业算法下沉 |
| inquiry | M05 销售自治 | Legacy，停止在 M03 扩展 |
| customer | M05 | Legacy |
| quote | M05 | Legacy |
| pricing | M05/M09 | 拆分商务报价与成本算法 |
| order | M05/M06 | 拆分客户订单与交付执行 |
| product | M04 研发自治 | Legacy |
| project | M04 | Legacy |
| bom / bom-* | M04 | Legacy |
| sample | M04 | Legacy |
| tech-transfer | M04 | Legacy |
| material / material-* | M06/M02 | Legacy，明确主数据 Owner |
| procurement | M06 | Legacy |
| supplier | M06 | Legacy |
| expense | M09 财经自治 | Legacy |
| labor / product-labor-rate | M09 | Legacy |
| users / roles / permissions / organization | M01 AEOS Kernel | 迁移为共享内核能力 |
| ai-assistant | M01 + M03 | Agent/Skill/Memory 下沉，经营助手保留入口 |
| external-api / external-sync / external-service | M11 | 连接器化 |
| data-clean / audit/log | M02 | 数据与证据平台 |
| Docker / health / tests | M12 | DevSecOps/Observability |

## Gate
- P0：边界冻结、Mapping、Data Ownership
- P1：Contract 与管理闭环
- P2：M01/M02/M04/M05/M06/M09/M11 接口化
- P3：去跨域直读、物理拆分、规模化数据库迁移