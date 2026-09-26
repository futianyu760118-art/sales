import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp({ config });

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[EBMS] PAND-84 反向链路服务已启动: http://localhost:${config.port}/api/v1/trace/health`);
});
