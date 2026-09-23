# AEOS M03 — EBMS 企业经营管理与决策系统

本仓库是 AEOS V7.2 的 M03 管理者主工作面。核心职责是汇总经营目标、结果、异常、决策、行动、证据和复盘，不作为销售、研发、交付、财经等专业领域的第二事实源。

## M03 保留职责

- Target/Plan
- Result
- Gap/Exception
- Decision
- Action
- Evidence
- Review
- Dashboard/Report
- 受控的跨域聚合与证据追溯

管理闭环：`Target → Result → Gap/Exception → Decision → Action → Result → Evidence → Review`。

当前专业业务路由在 P0/P1 继续兼容运行，但不得继续扩大 M03 的专业执行职责。具体归属见：

- [系统边界](architecture/SYSTEM_BOUNDARY.md)
- [Current→Target 模块映射](architecture/CURRENT_TARGET_MAPPING.md)
- [数据所有权](architecture/DATA_OWNERSHIP.md)
- [Legacy 迁移登记](architecture/LEGACY_MIGRATION_REGISTER.md)

## 本地运行与测试

```bash
cd backend
npm ci
npm test
ENABLE_AEOS_M03=1 npm start
```

P1 阶段新接口默认关闭。启用后，管理闭环接口位于 `/api/aeos/management`，并继续执行 Bearer Token 鉴权。

## Docker

```bash
docker build -t ebms-aeos-p1 .
docker run --rm -p 3010:3010 -e ENABLE_AEOS_M03=0 ebms-aeos-p1
```

镜像健康检查使用现有 `/api/projects/stats` 路径。生产数据目录通过卷挂载，不在测试中迁移或重写。

## 受控基线

- 架构设计：`docs/superpowers/specs/2026-09-23-ebms-aeos-v7.2-alignment-design.md`
- 实施计划：`docs/superpowers/plans/2026-09-23-ebms-aeos-v7.2-alignment.md`
- Gate 清单：`docs/checklists/P0-P1_EXECUTION_CHECKLIST.md`

执行原则：先边界、后功能；先闭环、后扩展；代码完成不等于业务完成。
