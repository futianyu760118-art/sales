# S&OP 产销协调会系统 — AI编程交付包

> 可直接喂给 Cursor / Copilot / Claude Code / Windsurf 等AI编程工具，生成完整可运行代码。
> **已集成 IM 即时通讯模块**：消息对话、实时推送、@提及、已读回执、群聊、会议聊天室、企业微信/钉钉/短信/邮件多通道推送。

## 📂 文件清单（按阅读顺序）

| 序号 | 文件 | 给AI的指令示例 |
|:---:|:---|:---|
| 00 | `00_PROJECT_OVERVIEW.md` | "先读这个了解全貌" |
| 01 | `01_DATABASE_DDL.sql` | "执行这个SQL建库建表(含IM的6张表)" |
| 02 | `02_DATA_SEED.sql` | "插入种子数据(含IM通知偏好)" |
| 03 | `03_API_SPEC.yaml` | "根据OpenAPI规范生成后端接口(含17个IM端点)" |
| 04 | `04_BUSINESS_RULES.json` | "实现预警规则引擎和硬拦截逻辑" |
| 05 | `05_FORM_SPEC.json` | "根据表单规格生成前端表单组件" |
| 06 | `06_PERMISSION_MATRIX.json` | "实现RBAC权限控制中间件" |
| 07 | `07_UI_COMPONENTS.yaml` | "根据组件描述生成React页面(含IM三栏布局)" |
| 08 | `08_AUTO_FETCH_SPEC.json` | "实现数据自动获取开关和定时任务" |
| 09 | `09_ACTION_TODO_ENGINE.json` | "实现Action待办引擎+会议助手同步" |
| 10 | `10_SELF_CHECK_ENGINE.json` | "实现每周自检引擎" |
| 11 | `11_IM_MESSAGING.json` | "实现IM即时通讯模块(消息/群聊/推送/已读回执/外部通道)" |

## 🚀 快速开始（给AI编程工具）

### 方式一：整体喂入（推荐）
```
请将 /SOP_System_AI_Code_Package/ 目录下所有文件作为上下文，
按编号顺序阅读，然后：
1. 执行01_DATABASE_DDL.sql创建数据库(14张业务表 + 6张IM表)
2. 执行02_DATA_SEED.sql插入种子数据
3. 根据03_API_SPEC.yaml生成FastAPI后端项目骨架(含WebSocket)
4. 根据11_IM_MESSAGING.json实现IM模块(消息/群聊/推送/已读回执)
5. 根据07_UI_COMPONENTS.yaml生成React前端页面(含IM三栏布局)
6. 根据04/09/10的JSON规则实现业务引擎
```

### 方式二：分模块生成
```
步骤1 → 只给AI: 00 + 01 + 02 → "帮我建好数据库(含IM表)"
步骤2 → 只给AI: 03 + 06 + 11 → "帮我生成后端API+WebSocket+IM接口"
步骤3 → 只给AI: 05 + 07 + 11 → "帮我生成前端页面(含IM聊天界面)"
步骤4 → 只给AI: 04 + 09 + 10 → "帮我实现业务规则引擎"
步骤5 → 只给AI: 08 → "帮我实现数据获取模块"
```

## 🔑 核心设计决策（AI需要知道的）

1. **时间窗口**：所有数据统计以"上月16日~当月15日"为周期，不是自然月
2. **硬拦截不可绕过**：模具未归档/图纸未更新 → 直接阻断MPS下发，UI弹模态框，无Override按钮
3. **数据获取开关**：每个数据源独立AUTO/MANUAL开关，切换需审计留痕
4. **Action自动生成**：KPI红灯/产能超载/物料短缺/异常超时 → 系统自动建Action并推送会议助手
5. **自检每周一自动跑**：10项检查，未通过自动建Action，Grade D抄送总经理
6. **PSI三月亮滚动**：M锁定/M+1弹性/M+2参考，期末库存=期初+生产-销售，颜色R/Y/G自动算
7. **RAPID表决**：每个议题5角色(I/R/A/D/P)，表决结果写入审计日志
8. **IM实时通讯**：WebSocket长连接 + Redis缓存热消息 + 多通道外部推送
9. **消息免打扰**：每日22:00~08:00默认免打扰，但@提及/BLOCK/硬拦截可突破
10. **已读回执**：单聊显示✓✓已读；群聊显示N/M已读，点击查看已读列表

## 💬 IM模块核心能力

### 消息类型
| 类型 | 说明 | 触发场景 |
|:---|:---|:---|
| TEXT | 文本消息 | 日常沟通 |
| IMAGE/FILE/VOICE/VIDEO | 图片/文件/语音/视频 | 证据上传/讨论 |
| SYSTEM | 系统通知 | 自动推送的预警/Action/会议 |
| ALERT | 预警卡片 | 规则引擎触发 |
| ACTION_REMINDER | 待办提醒卡片 | Action创建/逾期/升级 |
| MEETING_INVITE | 会议邀请卡片 | 会议创建/变更 |
| RAPID_VOTE | 表决消息 | 会议中RAPID投票 |
| QUOTE_REPLY | 引用回复 | 对话线索 |
| EMOJI_REACTION | Emoji反应 | 快速反馈 |

### 推送通道优先级（可配置）
```
第1优先: WebSocket实时推送(在线用户)
第2优先: 企业微信/钉钉 Webhook(组织群/个人)
第3优先: 短信SMS(紧急: P0 Action逾期/硬拦截)
第4优先: 邮件Email(报告/纪要/周报)
```

### 外部系统集成
| 平台 | 用途 | 配置方式 |
|:---|:---|:---|
| 企业微信 | 消息推送/小程序审批 | AppID + Secret + CorpID |
| 钉钉 | 工作通知/群机器人 | AppKey + AppSecret |
| 飞书 | 消息卡片 | App ID + Verification Token |
| 阿里云短信 | P0逾期/硬拦截通知 | AccessKey + 模板ID |
| SMTP | 会议纪要/周报/月报 | 邮箱+授权码 |

## 🛠️ 技术栈建议

```
后端: Python FastAPI + SQLAlchemy + Celery
数据库: MySQL 8.0+
前端: React 18 + TypeScript + Ant Design 5
实时: WebSocket (Socket.IO兼容模式)
缓存: Redis (热消息/在线状态/会话缓存)
文件: MinIO / 阿里云OSS (图片/文件/语音)
搜索: Elasticsearch / MeiliSearch (消息全文检索)
定时: Celery Beat (数据获取Cron / 自检每周一 / 推送重试)
报表: Apache ECharts (驾驶舱图表)
认证: JWT + RBAC中间件
IM协议: WebSocket + 自定义JSON消息格式
```

## ⚠️ 开发注意事项

1. 所有表均有 `created_at` 和 `updated_at` 自动维护
2. PSI的 `inventory_end` 和 `color_status` 用数据库触发器自动计算（见DDL）
3. 审计日志 `audit_log` 对所有关键表INSERT/UPDATE/DELETE全量记录
4. 预警引擎 `alert_engine` 独立运行，扫描间隔建议30秒
5. 硬拦截检查在MPS下发API的入口处做前置校验
6. 时间窗口"16th-15th"需在应用层统一封装工具函数 `get_current_sop_period()`
7. **WebSocket连接**: `ws://host:port/ws/im/{user_id}?token={jwt}`，心跳30秒，指数退避重连
8. **消息存储**: MySQL持久化 + Redis缓存最近7天热消息（减少DB查询）
9. **外部推送失败重试**: 指数退避(1s→2s→4s→8s，最多3次)，写im_push_log
10. **免打扰**: 检查quiet_hours时段，但ALERT/BLOCK/@提及可突破

## 📋 实施里程碑

| 里程碑 | 交付物 | 验收标准 |
|:---:|:---|:---|
| M1-第1月 | 数据库就绪+数据获取开关+16个取数配置 | 8类数据可自动拉取，准确率>95% |
| M2-第2~3月 | PSI表单+MRP+硬拦截+预警引擎+IM基础 | 两个硬拦截生效；IM单聊/群聊/系统通知可用 |
| M3-第4月 | 会议管理+RAPID+Action引擎+会议助手同步+IM推送 | 全流程线上会议；Action逾期率<20%；企微推送打通 |
| M4-第5~6月 | KPI驾驶舱+自检引擎+移动端+IM高级功能 | 29个KPI全上线；语音/Emoji/搜索/已读回执全可用 |
