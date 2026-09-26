// 进程入口：装配 PostgreSQL 连接池与 repository 后启动 HTTP 服务。
import { createApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db/pool.js';
import { createPgRepositories } from './repositories/pg/pgRepositories.js';
import { createAdapters } from './ingest/centerAdapters.js';

const pool = createPool(config.database);
const { metricRepository, reasonRepository, conclusionRepository, judgmentRepository } = createPgRepositories(pool);
// 四域 adapter 按环境变量配置装配；未配置 base URL 的域走人工/导入兜底
const adapters = createAdapters({ centerConfig: config.centers });
const app = createApp({
  metricRepository,
  reasonRepository,
  conclusionRepository,
  judgmentRepository,
  adapters,
  enforceAuth: config.enforceAuth,
});

const server = app.listen(config.port, () => {
  console.log(`[ebms] backend listening on http://localhost:${config.port}`);
});

// 交接说明：本服务不随本轮运行常驻，启停方式见 issue 回帖。
async function shutdown(signal) {
  console.log(`[ebms] ${signal} received, shutting down`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
