# EBMS 经营管理系统

EBMS 是**跨域结论汇聚 + 经营判断 + 追溯**层，面向决策者与管理责任人，支持 Result → Reason → Evidence → Source 四层穿透。EBMS **不重算、不复制**任何专业中心（销售/生产·交付/财务/供应链）的内部算法与业务明细，只存「结论 / 归因 / 证据 / 来源 / 判断 / 视图」及其留痕。

本目录是 EBMS 的代码库，按架构方案（PAND-77）落地：后端 Node.js + Express（router → service → repository 分层）+ PostgreSQL；前端 Vue 3 + Vite。

> 交付位置说明：EBMS 是独立系统，`sales.git` 是其要汇聚的四个专业中心之一。当前平台仅提供 `sales.git` 作为仓库，因此 EBMS 代码以**新增顶层目录 `ebms/`** 的形式提交，**未修改任何既有 sales 文件**。若团队希望拆分为独立仓库，可整体迁移本目录。

## 当前实现范围

本次交付 **F3 证据关联（PAND-81）** 的完整切片，并包含其运行所需的**最小数据底座**（工程骨架、鉴权/RBAC 中的操作人识别、Result/Reason 锚点、通用留痕）。

| 功能 | 状态 |
|---|---|
| F3 原因项挂载并查看支撑证据（PAND-81） | ✅ 已实现 |
| F1 结果指标集（PAND-79） | 锚点表 `result_metrics` 已建，接口未实现 |
| F2 归因穿透（PAND-80） | 锚点表 `result_reasons` + 只读清单已建，归因算法未实现 |
| F4 来源标注（PAND-82）、F5 四层下钻（PAND-83）、F10 Evidence 检索（PAND-88）等 | 未实现（后续 issue） |

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
        seed.js                   自检/联调夹具（含 1 个「无证据支撑」原因项）
        migrations/001_init.sql   数据模型
      domain/
        evidence/                 证据域：类型枚举 / 仓储 / 服务（校验+用例）
        reason/                   原因项锚点（只读）
        audit/                    通用留痕仓储
      http/
        routes/                   证据路由、开发登录路由
        middleware/               操作人识别、错误处理
      lib/token.js                HMAC-SHA256 签名 token
    test/evidence-ac.test.js      AC 逐条自动化验证（node:test）
  frontend/
    src/
      App.vue                     登录 + 原因项导航
      views/ReasonEvidenceView.vue 证据列表 / 无证据支撑提示 / 留痕
      components/                 详情面板、新增弹层、关联弹层
      api/client.js               API 客户端
```

## 数据模型（本切片）

- `evidences` —— 证据：`type`（枚举）、`title`、`formed_at`、`owner`、`content`、`attachment_refs`。
  约束：`title` / `formed_at` / `owner` 非空；`type` 为 `evidence_type` 枚举。
- `evidence_type_dict` —— 证据类型中文口径的唯一权威映射。
- `reason_evidences` —— Reason ↔ Evidence 关联，主键 `(reason_id, evidence_id)` 保证关联幂等。
- `audit_log` —— 通用留痕：`actor`（id）+ `actor_name`（可读名）+ `action` + `entity` + `at`。
- `result_metrics` / `result_reasons` —— Evidence 的挂载锚点（F1/F2 的完整字段由各自 issue 交付）。
- `ebms_users` —— 本切片最小操作人身份。

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
cd ebms/backend && npm test        # 17 项：AC 场景/边界/判定标准逐条断言
cd ebms/frontend && npm run build  # 前端构建
```

浏览器端 AC 走查（真实浏览器 23 项检查）见 PAND-81 评论中的验证结果。

## 关键约定

- **留痕与业务同事务**：新增/关联/解除关联的写入与其留痕在同一事务内提交，避免「操作生效但无留痕」。
- **关联幂等**：重复关联不产生第二条留痕；解除未关联的关系返回 409 而非静默成功。
- **无证据支撑**：接口返回 `evidenceStatus: NO_EVIDENCE`，前端渲染醒目告警 + 列表内显式提示。
- **附件不暴露存储路径**：附件经后端流式返回，路径以 `basename` 收敛，避免目录穿越。
- **不写入密钥**：`EBMS_AUTH_SECRET` 等由部署环境注入，`.env` 不入库。
