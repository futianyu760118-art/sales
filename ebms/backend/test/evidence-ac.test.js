'use strict';

// PAND-81（F3 证据关联）AC 逐条验证。
// 运行：npm test（需 PostgreSQL 可连，见 .env；测试库会被重置为夹具数据）

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrate } = require('../src/db/migrate');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const { EVIDENCE_TYPE_CODES } = require('../src/domain/evidence/evidence-types');

const REASON_WITH_EVIDENCE = 'aaaaaaaa-0001-4000-8000-000000000001';
const REASON_WITHOUT_EVIDENCE = 'aaaaaaaa-0002-4000-8000-000000000002';
const CONTRACT_EVIDENCE = 'bbbbbbbb-0001-4000-8000-000000000001';
const DOC_EVIDENCE = 'bbbbbbbb-0002-4000-8000-000000000002';
const MANUAL_NOTE_EVIDENCE = 'bbbbbbbb-0004-4000-8000-000000000004';

let baseUrl;
let server;
let token;

async function api(pathname, { method = 'GET', body, auth = true, raw = false } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const json = await res.json();
  return { status: res.status, json };
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

// ------------------------------------------------------------------ 判定标准

test('判定标准：证据类型取值仅限预定义枚举四类（单据/合同/系统记录/人工说明）', async () => {
  const { status, json } = await api('/evidence-types');
  assert.equal(status, 200);
  assert.deepEqual(
    json.data.map((t) => t.code).sort(),
    ['contract', 'document', 'manual_note', 'system_record']
  );
  assert.deepEqual(
    json.data.map((t) => t.label).sort(),
    ['人工说明', '合同', '单据', '系统记录'].sort()
  );
  assert.deepEqual(json.data.length, 4);
});

test('判定标准：非法证据类型被拒绝，且返回允许的枚举值', async () => {
  const { status, json } = await api('/evidences', {
    method: 'POST',
    body: { type: 'email', title: '非法类型', formedAt: '2026-09-01T00:00:00Z', owner: '测试' },
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'EVIDENCE_TYPE_INVALID');
  assert.deepEqual(json.error.details.allowed, EVIDENCE_TYPE_CODES);
});

test('判定标准：标题为空 / 形成时间为空 均被拒绝', async () => {
  const blankTitle = await api('/evidences', {
    method: 'POST',
    body: { type: 'document', title: '   ', formedAt: '2026-09-01T00:00:00Z', owner: '测试' },
  });
  assert.equal(blankTitle.status, 400);
  assert.equal(blankTitle.json.error.code, 'EVIDENCE_TITLE_REQUIRED');

  const missingFormedAt = await api('/evidences', {
    method: 'POST',
    body: { type: 'document', title: '有标题', formedAt: '', owner: '测试' },
  });
  assert.equal(missingFormedAt.status, 400);
  assert.equal(missingFormedAt.json.error.code, 'EVIDENCE_FORMED_AT_REQUIRED');

  const invalidFormedAt = await api('/evidences', {
    method: 'POST',
    body: { type: 'document', title: '有标题', formedAt: 'not-a-date', owner: '测试' },
  });
  assert.equal(invalidFormedAt.status, 400);
  assert.equal(invalidFormedAt.json.error.code, 'EVIDENCE_FORMED_AT_INVALID');
});

test('判定标准：每条证据的 标题、形成时间 均非空（列表逐条校验）', async () => {
  const { json } = await api(`/reasons/${REASON_WITH_EVIDENCE}/evidences`);
  assert.ok(json.data.items.length > 0);
  for (const item of json.data.items) {
    assert.equal(typeof item.title, 'string');
    assert.ok(item.title.trim().length > 0, `标题非空：${item.id}`);
    assert.ok(item.formedAt, `形成时间非空：${item.id}`);
    assert.ok(!Number.isNaN(new Date(item.formedAt).getTime()), `形成时间合法：${item.id}`);
    assert.ok(EVIDENCE_TYPE_CODES.includes(item.type), `类型在枚举内：${item.id}`);
  }
});

// ------------------------------------------------------------------ 场景 1

test('场景 1：原因项下展示证据列表，每条含 证据类型/标题/形成时间/责任人/详情入口', async () => {
  const { status, json } = await api(`/reasons/${REASON_WITH_EVIDENCE}/evidences`);
  assert.equal(status, 200);
  const data = json.data;

  assert.equal(data.reason.id, REASON_WITH_EVIDENCE);
  assert.equal(data.total, 4);
  assert.equal(data.evidenceStatus, 'HAS_EVIDENCE');

  const expectedFields = ['type', 'typeLabel', 'title', 'formedAt', 'owner'];
  for (const item of data.items) {
    for (const field of expectedFields) {
      assert.ok(item[field] !== undefined && item[field] !== null, `字段 ${field} 存在：${item.id}`);
    }
    // 详情入口：前端以 id 调用 GET /evidences/{id}
    assert.ok(item.id);
    const detail = await api(`/evidences/${item.id}`);
    assert.equal(detail.status, 200, `详情入口可达：${item.title}`);
  }
});

// ------------------------------------------------------------------ 场景 2

test('场景 2：点击证据可查看内容（文本说明必可查看）', async () => {
  const { status, json } = await api(`/evidences/${MANUAL_NOTE_EVIDENCE}`);
  assert.equal(status, 200);
  assert.equal(json.data.type, 'manual_note');
  assert.equal(json.data.typeLabel, '人工说明');
  assert.equal(json.data.contentViewable, true);
  assert.equal(json.data.hasContent, true);
  assert.ok(json.data.content.includes('技改'));
});

test('场景 2：带附件的证据可预览（inline）或下载（attachment）', async () => {
  const detail = await api(`/evidences/${CONTRACT_EVIDENCE}`);
  assert.ok(detail.json.data.attachmentCount > 0);
  const attachment = detail.json.data.attachments[0];
  assert.ok(attachment.url && attachment.filename);

  const preview = await api(attachment.url.replace('/api/v1', ''), { raw: true });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-disposition'), /^inline;/);
  const previewBody = Buffer.from(await preview.arrayBuffer());
  assert.ok(previewBody.length > 0);
  assert.equal(previewBody.subarray(0, 5).toString(), '%PDF-');

  const download = await api(`${attachment.url.replace('/api/v1', '')}?download=1`, { raw: true });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
});

test('场景 2：越界附件下标返回 404，不泄漏文件系统路径', async () => {
  const res = await api(`/evidences/${CONTRACT_EVIDENCE}/attachments/99`, { raw: true });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'ATTACHMENT_NOT_FOUND');
});

// ------------------------------------------------------------------ 场景 3

test('场景 3：新增证据产生留痕（操作人 + 时间）', async () => {
  const { status, json } = await api('/evidences', {
    method: 'POST',
    body: {
      type: 'system_record',
      title: '新增测试证据',
      formedAt: '2026-09-21T09:00:00+08:00',
      owner: '测试责任人',
      content: '内容',
    },
  });
  assert.equal(status, 201);
  assert.equal(json.data.audit.action, 'evidence.create');
  assert.ok(json.data.audit.actor, '留痕含操作人 id');
  assert.equal(json.data.audit.actorName, '李责任（管理责任人）', '留痕含可读操作人名称');
  assert.ok(json.data.audit.at, '留痕含时间');
  assert.equal(json.data.evidence.createdBy, '李责任（管理责任人）', '录入人展示为可读名称');

  const { rows } = await pool.query(
    `SELECT actor, action, at FROM audit_log WHERE entity_id = $1 AND action = 'evidence.create'`,
    [json.data.evidence.id]
  );
  assert.equal(rows.length, 1, '留痕已落库');
});

test('场景 3：关联已有证据产生留痕；重复关联幂等且不新增留痕', async () => {
  const first = await api(`/reasons/${REASON_WITHOUT_EVIDENCE}/evidences`, {
    method: 'POST',
    body: { evidenceId: DOC_EVIDENCE },
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.data.changed, true);
  assert.equal(first.json.data.audit.action, 'evidence.link');
  assert.ok(first.json.data.audit.actor && first.json.data.audit.at);

  const replay = await api(`/reasons/${REASON_WITHOUT_EVIDENCE}/evidences`, {
    method: 'POST',
    body: { evidenceId: DOC_EVIDENCE },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.changed, false);
  assert.equal(replay.json.data.alreadyLinked, true);
  assert.equal(replay.json.data.audit, null);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE reason_id = $1 AND entity_id = $2 AND action = 'evidence.link'`,
    [REASON_WITHOUT_EVIDENCE, DOC_EVIDENCE]
  );
  assert.equal(rows[0].n, 1, '重复关联不产生第二条留痕');
});

test('场景 3：解除关联产生留痕，且不删除证据本身', async () => {
  const before = await api(`/evidences/${DOC_EVIDENCE}`);
  assert.equal(before.status, 200);

  const { status, json } = await api(
    `/reasons/${REASON_WITHOUT_EVIDENCE}/evidences/${DOC_EVIDENCE}`,
    { method: 'DELETE' }
  );
  assert.equal(status, 200);
  assert.equal(json.data.changed, true);
  assert.equal(json.data.audit.action, 'evidence.unlink');
  assert.ok(json.data.audit.actor && json.data.audit.at);

  const after = await api(`/evidences/${DOC_EVIDENCE}`);
  assert.equal(after.status, 200, '解除关联后证据实体仍可访问');

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM reason_evidences WHERE reason_id = $1 AND evidence_id = $2`,
    [REASON_WITHOUT_EVIDENCE, DOC_EVIDENCE]
  );
  assert.equal(rows[0].n, 0, '关联关系已解除');
});

test('场景 3：未关联的证据无法解除关联（返回 409，不产生留痕）', async () => {
  const { status, json } = await api(
    `/reasons/${REASON_WITHOUT_EVIDENCE}/evidences/${MANUAL_NOTE_EVIDENCE}`,
    { method: 'DELETE' }
  );
  assert.equal(status, 409);
  assert.equal(json.error.code, 'EVIDENCE_NOT_LINKED');

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE reason_id = $1 AND entity_id = $2 AND action = 'evidence.unlink'`,
    [REASON_WITHOUT_EVIDENCE, MANUAL_NOTE_EVIDENCE]
  );
  assert.equal(rows[0].n, 0);
});

test('场景 3：新增并同时关联（reasonId）时，新增与关联留痕齐全', async () => {
  const { status, json } = await api('/evidences', {
    method: 'POST',
    body: {
      type: 'contract',
      title: '新增并关联的合同',
      formedAt: '2026-09-19T00:00:00+08:00',
      owner: '供应链中心 / 王采购',
      reasonId: REASON_WITHOUT_EVIDENCE,
    },
  });
  assert.equal(status, 201);
  const evidenceId = json.data.evidence.id;

  const { rows } = await pool.query(
    `SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at`,
    [evidenceId]
  );
  assert.deepEqual(rows.map((r) => r.action), ['evidence.create', 'evidence.link']);
});

// ------------------------------------------------------------------ 边界

test('边界：原因项无证据时标注「无证据支撑」并醒目提示', async () => {
  const reasonId = 'aaaaaaaa-0003-4000-8000-000000000099';
  const { rows } = await pool.query(
    `INSERT INTO result_reasons (id, name, direction, owner) VALUES ($1, '临时无证据原因项', 'negative', '测试')
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [reasonId]
  );
  assert.equal(rows.length <= 1, true);

  const { status, json } = await api(`/reasons/${reasonId}/evidences`);
  assert.equal(status, 200);
  assert.equal(json.data.hasEvidence, false);
  assert.equal(json.data.evidenceStatus, 'NO_EVIDENCE');
  assert.equal(json.data.evidenceStatusLabel, '无证据支撑');
  assert.equal(json.data.total, 0);
  assert.deepEqual(json.data.items, []);

  await pool.query('DELETE FROM result_reasons WHERE id = $1', [reasonId]);
});

test('边界：原因项不存在时返回 404，而非误导性的空列表', async () => {
  const { status, json } = await api('/reasons/aaaaaaaa-0000-4000-8000-000000000000/evidences');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'REASON_NOT_FOUND');
});

test('边界：写操作缺少 token 时返回 401（操作人不可缺省，留痕必须可归属）', async () => {
  const { status, json } = await api('/evidences', {
    method: 'POST',
    auth: false,
    body: { type: 'document', title: 'x', formedAt: '2026-09-01T00:00:00Z', owner: 'y' },
  });
  assert.equal(status, 401);
  assert.equal(json.error.code, 'AUTH_REQUIRED');
});

test('边界：非法 token 被拒绝', async () => {
  const res = await fetch(`${baseUrl}/evidences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer forged.token' },
    body: JSON.stringify({ type: 'document', title: 'x', formedAt: '2026-09-01T00:00:00Z', owner: 'y' }),
  });
  assert.equal(res.status, 401);
});
