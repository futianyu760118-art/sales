'use strict';

// PAND-89（F11 四视图对象交叉跳转）AC 逐条验证。
// 运行：npm test（需 PostgreSQL 可连，见 .env；测试库会被重置为夹具数据）

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrate } = require('../src/db/migrate');
const { seed, IDS } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const {
  VIEW_OBJECT_TYPE_CODES,
  VIEW_OBJECT_TYPES,
} = require('../src/domain/views/view-object-types');

const NO_LINK_HINT = '无关联';

let baseUrl;
let server;
let token;

async function api(pathname, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** 每个类型的「无关联」对象 id（边界夹具）。 */
const ORPHAN_OBJECT = {
  report: IDS.reports.orphan,
  todo: IDS.todos.orphan,
  decision: IDS.decisions.orphan,
  evidence: IDS.evidences.warehouse,
};

/** 取某对象的交叉跳转读模型：{ object, targets[], total }。 */
async function nav(type, id) {
  const { status, json } = await api(`/objects/${type}/${id}/links`);
  assert.equal(status, 200, `GET /objects/${type}/${id}/links 应返回 200`);
  return json.data;
}

function targetOf(navResult, type) {
  const found = navResult.targets.find((t) => t.targetType === type);
  assert.ok(found, `导航结果中应包含 ${type} 入口`);
  return found;
}

/** 某类型的全部对象（用于「两两可达」的全量扫描）。 */
async function objectsOfType(type) {
  const { status, json } = await api(`/objects/${type}`);
  assert.equal(status, 200);
  return json.data;
}

test.before(async () => {
  await migrate();
  await seed();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const login = await fetch(`${baseUrl}/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'owner' }),
  });
  token = (await login.json()).data.token;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

// ------------------------------------------------------------------ 前置：类型口径

test('前置：四视图类型枚举 = REPORT / TODO / Decision / Evidence', async () => {
  const { status, json } = await api('/view-object-types');
  assert.equal(status, 200);
  assert.deepEqual(json.data.map((t) => t.code).sort(), [
    'decision',
    'evidence',
    'report',
    'todo',
  ]);
  assert.deepEqual(json.data.map((t) => t.label).sort(), [
    'Decision',
    'Evidence',
    'REPORT',
    'TODO',
  ]);
});

// ------------------------------------------------------------------ 判定标准：两两可达

test('判定标准：四类视图两两之间的可达路径均存在（全部 12 个有向组合）', async () => {
  const cache = new Map();
  const listOf = async (type) => {
    if (!cache.has(type)) cache.set(type, await objectsOfType(type));
    return cache.get(type);
  };

  for (const fromType of VIEW_OBJECT_TYPE_CODES) {
    for (const toType of VIEW_OBJECT_TYPE_CODES) {
      if (fromType === toType) continue;

      // 只要存在「某 fromType 对象可跳到某 toType 对象」即该有向组合可达
      let reachable = null;
      for (const object of await listOf(fromType)) {
        const result = await nav(fromType, object.id);
        const entry = targetOf(result, toType);
        if (!entry.disabled && entry.count > 0) {
          reachable = { from: object, entry };
          break;
        }
      }

      assert.ok(
        reachable,
        `缺少可达路径：${fromType} → ${toType}（四类视图两两之间的有向组合应全部可用）`
      );
      assert.equal(reachable.entry.landingPath, `/${toType}`);
      assert.equal(reachable.entry.hint, null, '有关联时不应出现「无关联」提示');

      // 该入口的每个落点都应能解析回对应视图的对象（跳转落点存在）
      for (const hit of reachable.entry.entries) {
        assert.equal(hit.landingHref, `/${toType}/${hit.id}`);
        const landed = await api(`/objects/${toType}/${hit.id}`);
        assert.equal(landed.status, 200, `落点 ${hit.landingHref} 应可解析`);
        assert.equal(landed.json.data.id, hit.id);
      }
    }
  }
});

// ------------------------------------------------------------------ 场景 1：正向与反向跳转

test('场景 1：Report 可跳转至对应 TODO / Decision / Evidence', async () => {
  const result = await nav('report', IDS.reports.linked);
  assert.equal(result.object.id, IDS.reports.linked);
  assert.equal(result.object.typeLabel, 'REPORT');

  const todo = targetOf(result, 'todo');
  const decision = targetOf(result, 'decision');
  const evidence = targetOf(result, 'evidence');

  assert.deepEqual(todo.entries.map((e) => e.id), [IDS.todos.linked]);
  assert.deepEqual(decision.entries.map((e) => e.id), [IDS.decisions.linked]);
  assert.deepEqual(evidence.entries.map((e) => e.id), [IDS.evidences.contract]);

  // 三个入口均可用，且各自落到对应视图的地址上
  for (const [target, expectedId] of [
    [todo, IDS.todos.linked],
    [decision, IDS.decisions.linked],
    [evidence, IDS.evidences.contract],
  ]) {
    assert.equal(target.disabled, false);
    assert.equal(target.count, 1);
    assert.equal(target.entries[0].landingHref, `/${target.targetType}/${expectedId}`);
  }
  assert.equal(result.total, 3);
});

test('场景 1（反向）：TODO / Decision / Evidence 均可跳回 Report', async () => {
  for (const [type, id] of [
    ['todo', IDS.todos.linked],
    ['decision', IDS.decisions.linked],
    ['evidence', IDS.evidences.contract],
  ]) {
    const result = await nav(type, id);
    const report = targetOf(result, 'report');
    assert.equal(report.disabled, false, `${type} 应能反向跳回 report`);
    assert.deepEqual(report.entries.map((e) => e.id), [IDS.reports.linked]);
    assert.equal(report.entries[0].landingHref, `/report/${IDS.reports.linked}`);
  }
});

// ------------------------------------------------------------------ 判定标准：跳转落点正确

test('判定标准：有关联时跳转落点正确（落点对象与关联对象一致）', async () => {
  const result = await nav('report', IDS.reports.linked);
  const todoEntry = targetOf(result, 'todo').entries[0];

  // 落点地址 → 解析该地址对应的对象，应与入口指向的对象完全一致
  const landed = await api(`/objects/todo/${todoEntry.id}`);
  assert.equal(landed.status, 200);
  assert.equal(landed.json.data.id, todoEntry.id);
  assert.equal(landed.json.data.title, todoEntry.title);
  assert.equal(landed.json.data.landingHref, todoEntry.landingHref);

  // 从落点对象出发应可回到起点（跳转可逆，落点未错位）
  const back = await nav('todo', todoEntry.id);
  const backToReport = targetOf(back, 'report');
  assert.deepEqual(backToReport.entries.map((e) => e.id), [IDS.reports.linked]);
  assert.equal(backToReport.entries[0].landingHref, `/report/${IDS.reports.linked}`);
});

// ------------------------------------------------------------------ 边界：无关联 → 置灰 + 「无关联」

test('边界：无关联对象的三个入口均置灰并提示「无关联」', async () => {
  for (const type of VIEW_OBJECT_TYPE_CODES) {
    const orphanId = ORPHAN_OBJECT[type];
    const result = await nav(type, orphanId);

    assert.equal(result.total, 0, `${type} 孤儿对象不应有关联`);
    assert.equal(result.targets.length, 3, '入口应覆盖其余三类视图');

    for (const target of result.targets) {
      assert.equal(target.count, 0);
      assert.equal(target.disabled, true, `${type} → ${target.targetType} 入口应置灰`);
      assert.equal(target.hint, NO_LINK_HINT, '置灰入口应提示「无关联」');
      assert.deepEqual(target.entries, []);
    }
  }
});

test('边界：部分关联时按入口分别置灰（只有无关联的入口提示「无关联」）', async () => {
  const result = await nav('todo', IDS.todos.partial);

  const evidence = targetOf(result, 'evidence');
  assert.equal(evidence.disabled, false);
  assert.equal(evidence.hint, null);
  assert.deepEqual(evidence.entries.map((e) => e.id), [IDS.evidences.manualNote]);

  for (const type of ['report', 'decision']) {
    const target = targetOf(result, type);
    assert.equal(target.disabled, true, `todo → ${type} 无关联，入口应置灰`);
    assert.equal(target.hint, NO_LINK_HINT);
  }
});

test('边界：无关联对象按 target_type 查询返回空清单', async () => {
  const { status, json } = await api(
    `/objects/report/${IDS.reports.orphan}/links?target_type=todo`
  );
  assert.equal(status, 200);
  assert.deepEqual(json.data, []);
});

// ------------------------------------------------------------------ 写入：幂等与校验

test('写入：建立关联幂等（重复建立不产生第二条），解除后再查即「无关联」', async () => {
  const create = () =>
    api(`/objects/report/${IDS.reports.orphan}/links`, {
      method: 'POST',
      auth: true,
      body: { targetType: 'evidence', targetId: IDS.evidences.warehouse, relationType: 'evidences' },
    });

  const first = await create();
  assert.equal(first.status, 201);
  assert.equal(first.json.data.created, true);
  assert.equal(first.json.data.landingHref, `/evidence/${IDS.evidences.warehouse}`);

  const second = await create();
  assert.equal(second.status, 200, '重复建立应幂等命中');
  assert.equal(second.json.data.created, false);
  assert.equal(second.json.data.link.id, first.json.data.link.id);

  const afterCreate = await nav('report', IDS.reports.orphan);
  assert.equal(afterCreate.total, 1, '重复建立后关联数仍应为 1');
  assert.equal(targetOf(afterCreate, 'evidence').disabled, false);

  // 反方向也能查到（关联双向可达）
  const reverse = await nav('evidence', IDS.evidences.warehouse);
  assert.deepEqual(targetOf(reverse, 'report').entries.map((e) => e.id), [IDS.reports.orphan]);

  // 解除（用与建立时相反的方向删除，验证规范化配对）
  const del = await api(
    `/objects/evidence/${IDS.evidences.warehouse}/links/report/${IDS.reports.orphan}`,
    { method: 'DELETE', auth: true }
  );
  assert.equal(del.status, 200);

  const afterDelete = await nav('report', IDS.reports.orphan);
  assert.equal(afterDelete.total, 0);
  for (const target of afterDelete.targets) {
    assert.equal(target.disabled, true);
    assert.equal(target.hint, NO_LINK_HINT);
  }

  const delAgain = await api(
    `/objects/evidence/${IDS.evidences.warehouse}/links/report/${IDS.reports.orphan}`,
    { method: 'DELETE', auth: true }
  );
  assert.equal(delAgain.status, 409, '解除未关联关系应返回 409');
});

test('写入：非法类型 / 自关联 / 对象不存在 / 未认证 均被拒绝', async () => {
  const badType = await api(`/objects/invoice/${IDS.reports.linked}/links`);
  assert.equal(badType.status, 400);
  assert.equal(badType.json.error.code, 'VIEW_OBJECT_TYPE_INVALID');
  assert.deepEqual(
    badType.json.error.details.allowed.sort(),
    ['decision', 'evidence', 'report', 'todo']
  );

  const self = await api(`/objects/report/${IDS.reports.linked}/links`, {
    method: 'POST',
    auth: true,
    body: { targetType: 'report', targetId: IDS.reports.linked },
  });
  assert.equal(self.status, 400);
  assert.equal(self.json.error.code, 'VIEW_LINK_SELF_FORBIDDEN');

  const missing = await api(`/objects/report/${IDS.reports.linked}/links`, {
    method: 'POST',
    auth: true,
    body: { targetType: 'todo', targetId: '00000000-0000-4000-8000-000000000000' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'VIEW_OBJECT_NOT_FOUND');

  const anonymous = await api(`/objects/report/${IDS.reports.linked}/links`, {
    method: 'POST',
    body: { targetType: 'todo', targetId: IDS.todos.orphan },
  });
  assert.equal(anonymous.status, 401, '建立关联需要可归属的操作人');
});

test('写入：新增与解除关联产生留痕（条数 = 实际变更次数）', async () => {
  const before = await pool.query(
    "SELECT count(*)::int AS c FROM audit_log WHERE action = 'view_link.create'"
  );

  await api(`/objects/report/${IDS.reports.orphan}/links`, {
    method: 'POST',
    auth: true,
    body: { targetType: 'todo', targetId: IDS.todos.orphan },
  });
  await api(`/objects/report/${IDS.reports.orphan}/links`, {
    method: 'POST',
    auth: true,
    body: { targetType: 'todo', targetId: IDS.todos.orphan },
  });

  const after = await pool.query(
    "SELECT count(*)::int AS c FROM audit_log WHERE action = 'view_link.create'"
  );
  assert.equal(after.rows[0].c, before.rows[0].c + 1, '幂等重复建立不应重复记账');

  const removedBefore = await pool.query(
    "SELECT count(*)::int AS c FROM audit_log WHERE action = 'view_link.delete'"
  );

  await api(`/objects/report/${IDS.reports.orphan}/links/todo/${IDS.todos.orphan}`, {
    method: 'DELETE',
    auth: true,
  });
  const removed = await pool.query(
    "SELECT count(*)::int AS c FROM audit_log WHERE action = 'view_link.delete'"
  );
  assert.equal(removed.rows[0].c, removedBefore.rows[0].c + 1, '解除关联应记一条留痕');

  const restored = await nav('report', IDS.reports.orphan);
  assert.equal(restored.total, 0, '留痕用例结束后应恢复夹具原状');
});

// ------------------------------------------------------------------ 一致性：类型表与数据库枚举

test('一致性：类型注册表覆盖数据库 view_object_type 枚举的全部取值', async () => {
  const { rows } = await pool.query(
    "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'view_object_type' ORDER BY e.enumsortorder"
  );
  assert.deepEqual(rows.map((r) => r.enumlabel), VIEW_OBJECT_TYPE_CODES);
  assert.deepEqual(VIEW_OBJECT_TYPE_CODES, ['report', 'todo', 'decision', 'evidence']);
  assert.equal(VIEW_OBJECT_TYPES.report.landingPath, '/report');
});
