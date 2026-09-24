# EBMS企业经营管理系统

企业经营管理平台（Enterprise Business Management System），涵盖客户、询价、报价、核价、订单、采购、BOM、研发项目、阿米巴经营、年度经营计划等全流程管理。

## 快速开始

```bash
# 启动后端（http://localhost:3010）
start-backend.bat

# 默认账号：admin / admin123
```

也可使用 Docker 部署：

```bash
docker build -t ebms:latest .
docker compose up -d
```

## 目录结构

- `frontend/` 前端页面
- `backend/` Node.js 后端服务
- `database/` 数据文件
