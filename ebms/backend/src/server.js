'use strict';

const fs = require('fs');
const config = require('./config/env');
const { createApp } = require('./app');
const { migrate } = require('./db/migrate');

async function main() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  await migrate();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[ebms] backend listening on http://127.0.0.1:${config.port} (env=${config.nodeEnv})`);
  });
}

main().catch((err) => {
  console.error('[ebms] failed to start:', err.message);
  process.exit(1);
});
