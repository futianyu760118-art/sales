# S&OP产销协调会系统 — AI编程交付包

## 技术栈建议
- 后端: Python FastAPI / Node.js NestJS (二选一)
- 数据库: MySQL 8.0+ / PostgreSQL 14+
- 前端: React 18 + TypeScript + Ant Design 5
- 实时推送: WebSocket / Socket.IO (IM消息+预警+待办)
- 定时任务: Celery (Python) / Bull (Node.js)
- 报表引擎: Apache Superset 嵌入 / 自研ECharts看板
- IM通讯: WebSocket + Redis(消息缓存) + MinIO(文件/语音/图片)
- 外部推送: 企业微信Webhook / 钉钉OpenAPI / 阿里云短信 / SMTP邮件

## 目录结构
```
SOP_System_AI_Code_Package/
├── 00_PROJECT_OVERVIEW.md       ← 本文件
├── 01_DATABASE_DDL.sql          ← 完整建表SQL(含IM表)
├── 02_DATA_SEED.sql             ← 初始化种子数据(含IM配置)
├── 03_API_SPEC.yaml             ← RESTful API接口定义(含IM端点)
├── 04_BUSINESS_RULES.json      ← 预警规则+升级路径+硬拦截逻辑
├── 05_FORM_SPEC.json            ← 所有操作表单的字段/控件/校验定义
├── 06_PERMISSION_MATRIX.json    ← RBAC权限矩阵
├── 07_UI_COMPONENTS.yaml       ← 前端页面/组件布局描述(含IM布局)
├── 08_AUTO_FETCH_SPEC.json     ← 数据自动获取开关+映射规则
├── 09_ACTION_TODO_ENGINE.json  ← 待办生成+会议助手对接规则
├── 10_SELF_CHECK_ENGINE.json   ← 自检待办引擎规则
└── 11_IM_MESSAGING.json        ← IM即时通讯模块(消息/群聊/推送/已读回执)
```

## AI编程使用方式
1. 将整个文件夹作为上下文喂给Cursor/Copilot/Claude Code
2. 按编号顺序读取: 先DDL建表 → 再API → 再前端组件
3. 每个文件独立可编译/可执行
4. 所有JSON/YAML均通过格式校验
