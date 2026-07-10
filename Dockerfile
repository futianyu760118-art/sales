FROM node:22-alpine
# [H3] 以非 root 用户运行（修复 H3 容器以 root 运行的 CVE 风险）
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# [H4] 加 tini 进程管理 + curl（HEALTHCHECK 依赖）+ 装到系统 PATH
RUN apk add --no-cache tini curl

# 利用层缓存：先仅复制 package 文件装依赖
COPY --chown=app:app backend/package*.json ./backend/
RUN cd backend && npm ci --only=production

# [H3] 显式指定文件属主
COPY --chown=app:app backend/ ./backend/
COPY --chown=app:app frontend/ ./frontend/
COPY --chown=app:app database/ ./database/

# uploads 运行时数据；显式创建并赋权
RUN mkdir -p /app/uploads && chown -R app:app /app/uploads

# [H3] 切到非 root 用户
USER app

EXPOSE 3010
ENV PORT=3010
ENV NODE_ENV=production

# 数据库与上传数据为运行时卷，不进镜像层
VOLUME ["/app/database", "/app/uploads"]

# [H4] 容器健康检查：每 30s 探测一次，超时 5s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3010/api/projects/stats || exit 1

WORKDIR /app/backend
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
