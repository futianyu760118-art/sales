# EBMS M03 —— 反向链路查询（PAND-84）

从 Source 或 Evidence 反向查到其影响的原因项与最终结果指标。

## 契约口径（2026-09-26 P0 边界重核后统一）

反向查询沿契约链实现，与 PAND-83 的正向导航段一一对应：

```
Result  ←  Exception（归因）  ←  Evidence  ←  source_system
 第1段        第2段               第3段          第4段
```

- 正向四层 `Result → Reason → Evidence → Source` **仅作 M03 视图导航**，不是跨域契约层级。
- 反向查询**不新增契约对象或层级**：只有 `Result` / `Exception` / `Evidence` 三类契约对象。
- 「来源」以 `evidences.source_system` **字段**承载，不引入独立来源实体、不建独立来源表。
- 原因项口径与 PAND-80 一致：或为 `Exception`（含 `reason_code` / `severity`），或显式标记为
  **M03 自有归因分析**。

## 结构即口径

三条判定标准不是靠运行时检查兜住的，而是由数据结构保证：

| 判定标准 | 结构性保证 |
|---|---|
| 反向结果与正向导航一致（抽样 ≥ 10 条无差异） | 正反两向共用同一组关联表，反向只有一条关联路径 |
| 100% 归因项符合 PAND-80 口径 | `attributions` 的 `CHECK` 约束拒绝「既挂 Exception 又标 M03」及无归属行 |
| 对象清点 = Result/Exception/Evidence + `source_system`，无额外对象 | 库中只有这三个契约对象表，无独立来源表 |
| 反向只读 | `chainRepository` 只实现 SELECT；全库唯一写入口是 `db/seed.js` |

## 目录

```
ebms/
├── backend/                      Node.js 22 + Express（routes → services → repositories → domain）
│   ├── src/db/schema.sql         契约数据底座（node:sqlite，本地可运行/自检）
│   ├── src/db/postgres.sql       等价 PostgreSQL 15 生产 DDL
│   ├── src/db/seed.js            种子数据（全库唯一写入口）
│   ├── src/domain/chain.js       层级与契约对象口径的唯一真源（已冻结）
│   ├── src/domain/reverseQuery.js  反向查询（纯函数）
│   ├── src/domain/forwardQuery.js  正向导航 + 一致性双向比对（纯函数）
│   ├── src/services/traceService.js  应用层编排
│   └── test/                     47 项 AC 用例
└── frontend/                     Vue 3 + Vite
    ├── src/stores/reverseNavigation.js  视图状态（空态保留当前位置、正向跳转解析）
    ├── src/views → src/App.vue          反向查询主视图
    └── test/                     19 项口径单测
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/trace/reverse/by-evidence/:evidenceId` | 场景 1：Evidence → 归因项 + 最终结果指标 |
| GET | `/api/v1/trace/reverse/by-source-system/:sourceSystem` | 场景 2：来源系统 → 全部 Evidence / 归因项 / 结果指标 |
| GET | `/api/v1/trace/forward/by-result/:metricId` | 正向导航读模型（一致性基准） |
| GET | `/api/v1/trace/reverse/consistency?sample=10` | 自证：反向与正向逐对一致 |
| GET | `/api/v1/trace/reverse/attribution-compliance` | 自证：归因口径 100% 合规 |
| GET | `/api/v1/trace/contract-objects` | 自证：契约对象清点 |
| GET | `/api/v1/trace/source-systems` | 可用来源系统取值 |
| GET | `/api/v1/trace/read-only-check` | 自证：各表行数与留痕水位 |

全部为只读 GET，无写端点。

## 运行

```bash
cd backend  && npm install && npm test        # 47 项 AC 用例
cd frontend && npm install && npm test        # 19 项口径单测
cd frontend && npm run build                  # 前端构建

# 联调（后端 4100，前端 5100，前端已配置 /api 代理）
cd backend  && npm start
cd frontend && npm run dev
```

## 边界与口径落地

- **空态保留当前位置**：Evidence 或 `source_system` 未关联归因项时返回 `state: "EMPTY"`、
  `keepPosition: true`，并回传该锚点的 `position`（含面包屑）。界面据此原样保留当前位置，
  输入内容不清空。
- **不回落专业原始表**：响应固定携带 `fallbackQueried: false` / `fallbackPolicy: "none"`；
  仓储层对专业原始表没有访问路径。
- **来源未标注**：Evidence 缺失 `source_system` 时展示「来源未标注」并给出提示，不回落原始表。
- **只读**：反向查询前后全库内容指纹不变（`test/read-only.test.js` 比对整库哈希而非仅行数）。

## 与专业中心的边界

- Result 由专业中心 Owner 供给，记录其 `source_system` 与 `calculation_version`；EBMS 只消费不重算。
- 影响方向与贡献占比属 M03 归因元数据，基于消费到的专业 Result 判断得出，不自建专业事实源。
- 身份、角色与可见范围消费 M01 Kernel，本模块**不建**第二套身份/权限体系。
