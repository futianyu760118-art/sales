# EBMS 经营管理系统

EBMS 是**跨域结论汇聚 + 经营判断 + 追溯**层，面向决策者与管理责任人，支持 Result → Reason → Evidence → Source 四层穿透。EBMS **不重算、不复制**任何专业中心（销售/生产·交付/财务/供应链）的内部算法与业务明细，只存「结论 / 归因 / 证据 / 来源 / 判断 / 视图」及其留痕。

本目录是 EBMS 的代码库，按架构方案（PAND-77）落地：后端 Node.js + Express（router → service → repository 分层）+ PostgreSQL；前端 Vue 3 + Vite。

> 交付位置说明：EBMS 是独立系统，`sales.git` 是其要汇聚的四个专业中心之一。当前平台仅提供 `sales.git` 作为仓库，因此 EBMS 代码以**新增顶层目录 `ebms/`** 的形式提交，**未修改任何既有 sales 文件**。若团队希望拆分为独立仓库，可整体迁移本目录。

## 当前实现范围

本次交付 **F3 证据关联（PAND-81）** 与 **F11 四视图交叉跳转（PAND-89）** 两个完整切片，并包含其运行所需的**最小数据底座**（工程骨架、鉴权/RBAC 中的操作人识别、Result/Reason 锚点、通用留痕）。

| 功能 | 状态 |
|---|---|
| F3 原因项挂载并查看支撑证据（PAND-81） | ✅ 已实现 |
| F11 REPORT/TODO/Decision/Evidence 四视图互相跳转（PAND-89） | ✅ 已实现 |
| F1 结果指标集（PAND-79） | 锚点表 `result_metrics` 已建，接口未实现 |
| F2 归因穿透（PAND-80） | 锚点表 `result_reasons` + 只读清单已建，归因算法未实现 |
| F7 REPORT 视图（PAND-85）、F8 TODO 视图（PAND-86）、F9 Decision 视图（PAND-87）、F10 Evidence 检索（PAND-88）、F4 来源标注（PAND-82）、F5 四层下钻（PAND-83）等 | 未实现（后续 issue） |

### F11 四视图交叉跳转（PAND-89）说明

四视图口径：**REPORT = Result**、**TODO = Action**、**Decision**、**Evidence**。

- **关联模型**：`object_links` 一行 = 一条关联，**天然双向可达**。因此 Report↔TODO 一条记录即同时满足 `report→todo` 与 `todo→report`，6 组类型对即可覆盖 AC 要求的全部 12 个有向组合。
- **幂等**：写入时把两端规范化为 `pair_a`/`pair_b`（`"<type>:<id>"` 字典序），配合 `UNIQUE (pair_a, pair_b)`，同一对对象无论从哪端、方向如何建立都只留一行。
- **置灰边界**：无关联时入口**置灰**且提示「**无关联**」；判定按**入口**（目标类型）粒度，因此部分关联的对象只置灰没有关联的那几个入口。
- **视图对象锚点**：本切片只建「能被链接、能被解析出落点」的对象身份（`reports`/`todos`/`decisions`，`evidences` 见 001）。各视图的**完整业务字段由归属 issue 以 `ALTER TABLE` 追加**（PAND-85/86/87/88），本切片不臆造其业务列。
- **跳转落点**：前端 hash 路由 `#/report/<id>`、`#/todo/<id>`、`#/decision/<id>`、`#/evidence/<id>`，可直接作为直达链接，支持浏览器前进/后退。
- **不涵盖**：关联的新增/解除目前只有后端接口与留痕，前端未提供编辑入口（导航为本 issue 的 AC 范围）。

## 目录结构

```
ebms/
  backend/
    src/
      app.js                      Express 装配（CORS、路由、错误处理）
      server.js                   启动入口（自动执行迁移）
      config/env.js               环境变量（.env 不入库）
      db/
        pool.js                   连接池 + withTransaction（写数据与留痕同事务）
        migrate.js                迁移执行器
        seed.js                   自检/联调夹具（含「无证据支撑」原因项、四视图关联/无关联对象）
        migrations/001_init.sql   数据模型（证据 / 原因项 / 留痕）
        migrations/002_view_links.sql  四视图对象锚点 + object_links（F11）
      domain/
        evidence/                 证据域：类型枚举 / 仓储 / 服务（校验+用例）
        views/                    四视图对象注册表（唯一类型口径）+ 对象仓储（F11）
        links/                    交叉跳转关联：规范化配对 / 仓储 / 导航服务（F11）
        reason/                   原因项锚点（只读）
        audit/                    通用留痕仓储
      http/
        routes/                   证据路由、四视图对象路由、开发登录路由
        middleware/               操作人识别、错误处理
      lib/token.js                HMAC-SHA256 签名 token
    test/evidence-ac.test.js      AC 逐条自动化验证（node:test）
    test/view-links-ac.test.js    F11 AC 逐条验证（可达性 / 落点 / 置灰 / 幂等 / 留痕）
  frontend/
    src/
      App.vue                     登录 + 模块切换（原因项证据 / 四视图导航）
      views/ReasonEvidenceView.vue 证据列表 / 无证据支撑提示 / 留痕
      views/ViewExplorer.vue      F11 四视图外壳：类型切换、对象清单、hash 路由
      views/ViewObjectDetail.vue  F11 对象落地页 + 交叉跳转入口
      components/                 详情面板、新增弹层、关联弹层、四视图导航栏
      view-nav.js                 F11 导航纯逻辑（置灰判定 / 落点地址 / hash 解析）
      api/client.js               API 客户端
    test/                         F11 前端单测（导航模型 + SSR 渲染断言）
```

## 数据模型（本切片）

- `evidences` —— 证据：`type`（枚举）、`title`、`formed_at`、`owner`、`content`、`attachment_refs`。
  约束：`title` / `formed_at` / `owner` 非空；`type` 为 `evidence_type` 枚举。
- `evidence_type_dict` —— 证据类型中文口径的唯一权威映射。
- `reason_evidences` —— Reason ↔ Evidence 关联，主键 `(reason_id, evidence_id)` 保证关联幂等。
- `audit_log` —— 通用留痕：`actor`（id）+ `actor_name`（可读名）+ `action` + `entity` + `at`。
- `result_metrics` / `result_reasons` —— Evidence 的挂载锚点（F1/F2 的完整字段由各自 issue 交付）。
- `ebms_users` —— 本切片最小操作人身份。

**F11 四视图（PAND-89，迁移 002）**

- `view_object_type` —— 枚举 `report | todo | decision | evidence`，交叉跳转的类型唯一取值来源。
- `reports` / `todos` / `decisions` —— 视图对象**锚点表**（含 `code` 唯一与最小展示字段）。
  约定与 `result_metrics`/`result_reasons` 一致：**各视图的完整业务字段由归属 issue 以 `ALTER TABLE` 追加**（PAND-85/86/87），本切片只保证「可被链接、可被解析出落点」。
- `object_links` —— 四视图对象之间的关联：`from_type/from_id`、`to_type/to_id`、`relation_type`
  （`related | derived_from | evidences | executes`）、`created_by`。
  约束：`pair_a`/`pair_b`（规范化的 `"<type>:<id>"` 字典序两端）+ `UNIQUE (pair_a, pair_b)` 保证
  **同一对对象只留一行**（关联幂等 + 双向可达）；`CHECK (pair_a <= pair_b)` 杜绝正反两行；
  `CHECK (NOT (from_type = to_type AND from_id = to_id))` 禁止自关联。
- `audit_log.action` 扩展 `view_link.create` / `view_link.delete`。

**证据类型枚举**（业务方 2026-09-23 确认口径，唯一取值来源）：

| code | label |
|---|---|
| `document` | 单据 |
| `contract` | 合同 |
| `system_record` | 系统记录 |
| `manual_note` | 人工说明 |

## 接口（内部 BFF，前缀 `/api/v1`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/evidence-types` | 证据类型枚举 |
| GET | `/reasons` | 原因项清单（含证据计数，导航锚点） |
| GET | `/reasons/{reasonId}/evidences` | **F3 证据列表** + `无证据支撑` 状态 + 操作留痕 |
| POST | `/reasons/{reasonId}/evidences` | **关联**已有证据（幂等） |
| DELETE | `/reasons/{reasonId}/evidences/{evidenceId}` | **解除关联**（不删除证据实体） |
| GET | `/evidences/{id}` | 证据详情（文本说明 + 附件） |
| GET | `/evidences/{id}/attachments/{index}` | 附件预览（`?download=1` 为下载） |
| POST | `/evidences` | **新增**证据（带 `reasonId` 时同时关联） |
| GET | `/evidences?unlinkedToReason=&q=` | 关联候选清单（完整检索由 F10/PAND-88 交付） |
| GET | `/view-object-types` | **F11** 四视图类型枚举（REPORT/TODO/Decision/Evidence） |
| GET | `/objects/{type}` | **F11** 某视图的对象清单（导航用，`?limit=`） |
| GET | `/objects/{type}/{id}` | **F11** 对象落地页数据（跳转落点） |
| GET | `/objects/{type}/{id}/links` | **F11 交叉跳转入口**：不带 `target_type` 返回三类入口（含 `disabled` / `hint`「无关联」）；带 `target_type` 返回该类型的关联对象平铺清单 |
| POST | `/objects/{type}/{id}/links` | **F11** 建立关联（幂等；重复建立返回 200 且 `created=false`） |
| DELETE | `/objects/{type}/{id}/links/{targetType}/{targetId}` | **F11** 解除关联（与建立方向无关） |
| POST | `/auth/dev-login` | 开发环境签发操作人 token |

写操作均需 `Authorization: Bearer <token>`，并写入留痕（操作人 + 时间）。

响应统一为 `{ ok: true, data }` / `{ ok: false, error: { code, message, details } }`。
新增校验失败时 `error.details.fields` 给出**全部**字段错误，`error.code` 给出首个错误的专属码。

## 本地运行

```bash
# 1) 数据库（PostgreSQL）
docker run -d --name ebms-postgres \
  -e POSTGRES_USER=ebms -e POSTGRES_PASSWORD=<password> -e POSTGRES_DB=ebms \
  -p 5433:5432 postgres:15-alpine

# 2) 后端
cd ebms/backend
cp .env.example .env       # 填写 EBMS_DB_PASSWORD 与 EBMS_AUTH_SECRET
npm install
npm run migrate            # 建表
npm run seed               # 灌入自检夹具
npm start                  # http://127.0.0.1:3020

# 3) 前端
cd ../frontend
npm install
npm run dev                # http://127.0.0.1:5199（/api 已代理到后端）
```

开发环境账号：`decider`（决策者）、`owner`（管理责任人）。

## 自检

```bash
cd ebms/backend && npm test        # 29 项：F3 + F11 的 AC 场景/边界/判定标准逐条断言
cd ebms/frontend && npm test       # 11 项：F11 导航模型 + SSR 渲染断言（置灰/「无关联」文案）
cd ebms/frontend && npm run build  # 前端构建
```

F11 夹具覆盖：6 组类型对（→ 12 个有向组合）各 1 条关联；`report`/`todo`/`decision`/`evidence` 各 1 个**无关联**对象（入口置灰边界）；1 个**部分关联** TODO（逐入口置灰）。

浏览器端 AC 走查（真实浏览器 23 项检查）见 PAND-81 评论中的验证结果。

## 关键约定

- **留痕与业务同事务**：新增/关联/解除关联的写入与其留痕在同一事务内提交，避免「操作生效但无留痕」。
- **关联幂等**：重复关联不产生第二条留痕；解除未关联的关系返回 409 而非静默成功。
- **无证据支撑**：接口返回 `evidenceStatus: NO_EVIDENCE`，前端渲染醒目告警 + 列表内显式提示。
- **附件不暴露存储路径**：附件经后端流式返回，路径以 `basename` 收敛，避免目录穿越。
- **不写入密钥**：`EBMS_AUTH_SECRET` 等由部署环境注入，`.env` 不入库。
