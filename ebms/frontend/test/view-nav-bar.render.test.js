// F11（PAND-89）边界判定：入口置灰 + 「无关联」提示文案真的出现在渲染结果里。
// 用 Vite 的 SSR 模块加载器编译真实 SFC，再渲染成 HTML 断言，避免只测模型不测展示。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

import { buildNavModel, NO_LINK_HINT } from '../src/view-nav.js';

let vite;
let ViewNavBar;

test.before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  const mod = await vite.ssrLoadModule('/src/components/ViewNavBar.vue');
  ViewNavBar = mod.default;
});

test.after(async () => {
  await vite?.close();
});

function render(model) {
  return renderToString(createSSRApp(ViewNavBar, { model }));
}

/** 渲染结果中置灰的入口组数量（不依赖 class 顺序）。 */
function disabledGroupCount(html) {
  return (html.match(/<div class="[^"]*\bview-nav-group\b[^"]*"/g) || []).filter((tag) =>
    /\bdisabled\b/.test(tag)
  ).length;
}

/** 渲染结果中可点击落点按钮数量。 */
function linkButtonCount(html) {
  return (html.match(/class="view-nav-link"/g) || []).length;
}

/** 「无关联」在页面上可见（作为文本节点）的次数。 */
function visibleHintCount(html) {
  return (html.match(new RegExp(`>${NO_LINK_HINT}</span>`, 'g')) || []).length;
}

const NAV_PAYLOAD = {
  object: { type: 'report', id: 'cccccccc-0001-4000-8000-000000000001', typeLabel: 'REPORT', title: '9月经营月报' },
  total: 1,
  targets: [
    {
      targetType: 'todo',
      label: 'TODO',
      fullLabel: '待办事项',
      landingPath: '/todo',
      count: 1,
      disabled: false,
      hint: null,
      entries: [
        {
          id: 'dddddddd-0001-4000-8000-000000000001',
          code: 'TODO-2026-0901',
          title: '2号线排产调整以补产能缺口',
          badge: 'TODO',
          landingHref: '/todo/dddddddd-0001-4000-8000-000000000001',
        },
      ],
    },
    { targetType: 'decision', label: 'Decision', fullLabel: '决策', landingPath: '/decision', count: 0, disabled: true, hint: NO_LINK_HINT, entries: [] },
    { targetType: 'evidence', label: 'Evidence', fullLabel: '证据', landingPath: '/evidence', count: 0, disabled: true, hint: NO_LINK_HINT, entries: [] },
  ],
};

test('边界：无关联入口在渲染结果中置灰，且「无关联」提示文案出现', async () => {
  const html = await render(buildNavModel(NAV_PAYLOAD));

  assert.equal(disabledGroupCount(html), 2, '两个无关联入口应置灰');
  assert.equal(visibleHintCount(html), 2, '两个置灰入口应各显示一次「无关联」');
  assert.equal(linkButtonCount(html), 1, '只有一个可点击落点按钮（置灰入口无落点）');
  // 置灰入口同时带上可读的提示属性
  assert.equal(html.split(`title="${NO_LINK_HINT}"`).length - 1, 2);
});

test('场景 1：有关联入口渲染出可点击落点，落点标题与代码可见', async () => {
  const html = await render(buildNavModel(NAV_PAYLOAD));

  assert.ok(html.includes('2号线排产调整以补产能缺口'), '落点标题应渲染');
  assert.ok(html.includes('TODO-2026-0901'), '落点编号应渲染');
  assert.ok(html.includes('关联跳转'), '导航区标题应渲染');
});

test('边界：全部无关联时渲染出三个置灰入口', async () => {
  const empty = {
    object: { type: 'report', id: 'cccccccc-0002-4000-8000-000000000002', typeLabel: 'REPORT', title: '9月经营月报：渠道库存' },
    total: 0,
    targets: ['todo', 'decision', 'evidence'].map((t) => ({
      targetType: t,
      label: t.toUpperCase(),
      fullLabel: t,
      landingPath: `/${t}`,
      count: 0,
      disabled: true,
      hint: NO_LINK_HINT,
      entries: [],
    })),
  };

  const html = await render(buildNavModel(empty));
  assert.equal(disabledGroupCount(html), 3, '三个入口均应置灰');
  assert.equal(visibleHintCount(html), 3);
  assert.equal(linkButtonCount(html), 0, '不应渲染任何落点按钮');
});
