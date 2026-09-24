# EBMS 企业经营管理平台

## Docker 部署

确保 Docker Desktop 已启动，在项目根目录执行：

```bash
docker compose up -d --build
```

访问：<http://localhost:3010>

查看状态与日志：

```bash
docker compose ps
docker compose logs -f --tail=100
```

停止服务：

```bash
docker compose down
```

数据库和上传文件分别持久化到 `./database` 与 `./uploads`。升级代码后重新构建：

```bash
docker compose down
docker compose up -d --build
```

首次初始化默认管理员账号为 `admin`，请登录后立即修改默认密码。
