import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNavModel,
  hashFor,
  hintOf,
  isNavigable,
  NO_LINK_HINT,
  parseHash,
  toNavEntry,
} from '../src/view-nav.js';

const REPORT_ID = 'cccccccc-0001-4000-8000-000000000001';
const TODO_ID = 'dddddddd-0001-4000-8000-000000000001';

const linkedTarget = {
  targetType: 'todo',
  label: 'TODO',
  fullLabel: '待办事项（TODO）',
  landingPath: '/todo',
  count: 1,
  disabled: false,
  hint: null,
  entries: [
    {
      id: TODO_ID,
      code: 'TODO-2026-0901',
      title: '2号线排产调整以补产能缺口',
      badge: '规则',
      subtitle: 'in_progress',
      landingHref: `/todo/${TODO_ID}`,
    },
  ],
};

const emptyTarget = {
  targetType: 'decision',
  label: 'Decision',
  fullLabel: '决策（Decision）',
  landingPath: '/decision',
  count: 0,
  disabled: true,
  hint: NO_LINK_HINT,
  entries: [],
};

test('场景 1：有关联时入口可点击，落点地址取自后端下发的 landingHref', () => {
  const entry = toNavEntry(linkedTarget);
  assert.equal(entry.disabled, false);
  assert.equal(entry.hint, null);
  assert.equal(entry.count, 1);
  assert.equal(entry.links.length, 1);
  assert.equal(entry.links[0].id, TODO_ID);
  assert.equal(entry.links[0].href, `/todo/${TODO_ID}`);
  assert.equal(hashFor(entry.links[0].href), `#/todo/${TODO_ID}`);
  assert.equal(isNavigable(entry), true);
  assert.equal(hintOf(entry), null);
});

test('边界：无关联时入口置灰并提示「无关联」', () => {
  const entry = toNavEntry(emptyTarget);
  assert.equal(entry.disabled, true);
  assert.equal(entry.hint, '无关联');
  assert.equal(entry.links.length, 0);
  assert.equal(isNavigable(entry), false);
  assert.equal(hintOf(entry), NO_LINK_HINT);
});

test('边界：后端只给 count=0 未标 disabled 时，前置仍置灰（不出现可点但无落点）', () => {
  const entry = toNavEntry({ targetType: 'evidence', label: 'Evidence', landingPath: '/evidence', count: 0 });
  assert.equal(entry.disabled, true);
  assert.equal(entry.hint, NO_LINK_HINT);
  assert.equal(isNavigable(entry), false);
});

test('边界：后端标 disabled 时即使 count>0 也置灰（以后端判定为准）', () => {
  const entry = toNavEntry({ ...linkedTarget, disabled: true });
  assert.equal(entry.disabled, true);
  assert.equal(entry.hint, '无关联');
  assert.equal(isNavigable(entry), false);
});

test('导航模型：三个目标入口齐备，且逐入口判定（部分关联）', () => {
  const model = buildNavModel({
    object: { type: 'report', id: REPORT_ID, typeLabel: 'REPORT', title: '9月经营月报' },
    total: 1,
    targets: [linkedTarget, emptyTarget, { ...emptyTarget, targetType: 'evidence', landingPath: '/evidence' }],
  });

  assert.equal(model.total, 1);
  assert.deepEqual(model.entries.map((e) => e.targetType), ['todo', 'decision', 'evidence']);
  assert.deepEqual(model.entries.map((e) => e.disabled), [false, true, true]);
  assert.deepEqual(model.entries.map((e) => e.hint), [null, '无关联', '无关联']);
  assert.equal(model.object.title, '9月经营月报');
});

test('导航模型：载荷缺失时退化为空模型而不是抛错', () => {
  const model = buildNavModel(undefined);
  assert.equal(model.total, 0);
  assert.equal(model.object, null);
  assert.deepEqual(model.entries, []);
});

test('路由：四类视图的落点地址均可解析回 { type, id }', () => {
  const ids = {
    report: 'cccccccc-0001-4000-8000-000000000001',
    todo: 'dddddddd-0001-4000-8000-000000000001',
    decision: 'eeeeeeee-0001-4000-8000-000000000001',
    evidence: 'bbbbbbbb-0001-4000-8000-000000000001',
  };
  for (const [type, id] of Object.entries(ids)) {
    const href = `/${type}/${id}`;
    assert.equal(hashFor(href), `#${href}`);
    assert.deepEqual(parseHash(`#${href}`), { type, id });
    assert.deepEqual(parseHash(hashFor(href)), { type, id });
  }
});

test('路由：非法 hash 返回 null（由调用方回落到默认对象）', () => {
  for (const bad of ['', '#', '#/', '#/report', '#/report/not-a-uuid', '#/report/1', 'report/' + REPORT_ID]) {
    assert.equal(parseHash(bad), null, `${bad} 应解析失败`);
  }
});
