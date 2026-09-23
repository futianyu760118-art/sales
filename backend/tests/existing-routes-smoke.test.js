const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function loadRoutes(enabled) {
  process.env.ENABLE_AEOS_M03 = enabled ? '1' : '0';
  delete require.cache[require.resolve('../routes')];
  return require('../routes');
}

async function withApp(enabled, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api', loadRoutes(enabled));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}

test('feature flag disabled leaves AEOS management API unavailable', async () => {
  await withApp(false, async base => {
    const response = await fetch(base + '/api/aeos/management/closures/DEC-001');
    assert.equal(response.status, 404);
  });
});

test('existing protected user route remains mounted and returns 401', async () => {
  await withApp(false, async base => {
    const response = await fetch(base + '/api/users');
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.code, 'UNAUTHORIZED');
  });
});

test('feature flag enabled mounts AEOS API and keeps Bearer-only protection', async () => {
  await withApp(true, async base => {
    const response = await fetch(base + '/api/aeos/management/closures/DEC-001');
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });
});
