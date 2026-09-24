const assert = require('node:assert/strict');

const BASE_URL = process.env.EBMS_BASE_URL || 'http://127.0.0.1:3010';
const USER_ID = process.env.EBMS_USER_ID || '1';

async function timedGet(path) {
  const started = performance.now();
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'x-user-id': USER_ID }
  });
  await response.arrayBuffer();
  return {
    path,
    status: response.status,
    ms: performance.now() - started,
    cache: response.headers.get('x-ebms-cache')
  };
}

async function main() {
  const first = await timedGet('/api/materials/dashboard/stats');
  const second = await timedGet('/api/materials/dashboard/stats');

  assert.equal(first.status, 200, `${first.path} returned HTTP ${first.status}`);
  assert.equal(second.status, 200, `${second.path} returned HTTP ${second.status}`);
  assert.equal(second.cache, 'HIT', 'repeated dashboard stats request must hit the short TTL cache');
  assert.ok(second.ms < 1000, `cached dashboard stats took ${second.ms.toFixed(1)}ms`);

  console.log(JSON.stringify({ first, second }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
