// 接口级验收自检：以真实 HTTP 请求逐条验证 PAND-80 的场景、边界与判定标准。
// 使用 node:test + 内置 fetch，不依赖本地 PostgreSQL（数据层走 repository 的内存实现）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryRepositories } from '../src/repositories/memory/memoryRepositories.js';

const SEED = {
  metrics: [
    {
      id: 'm-revenue',
      code: 'revenue',
      name: '营业收入',
      dimension: 'finance',
      unit: '万元',
      period_type: 'month',
      period_value: '2026-08',
      target: 1000,
      actual: 880,
      deviation_abs: -120,
      deviation_pct: -12,
      threshold_pct: 5,
      data_status: 'ok',
      as_of: '2026-09-05T00:00:00+08:00',
    },
    {
      id: 'm-otd',
      code: 'on_time_delivery',
      name: '订单交付率',
      dimension: 'business',
      unit: '%',
      period_type: 'month',
      period_value: '2026-08',
      target: 100,
      actual: 87,
      deviation_abs: -13,
      deviation_pct: -13,
      threshold_pct: 5,
      data_status: 'ok',
      as_of: '2026-09-05T00:00:00+08:00',
    },
  ],
  reasons: [
    { id: 'r-1', metric_id: 'm-revenue', parent_id: null, name: '主力产品单价下调', direction: 'negative', contribution_pct: 45, impact_value: -54, owner: '销售中心', order_no: 1 },
    { id: 'r-2', metric_id: 'm-revenue', parent_id: null, name: '华东区订单流失', direction: 'negative', contribution_pct: 35, impact_value: -42, owner: '销售中心-华东大区', order_no: 2 },
    { id: 'r-2-1', metric_id: 'm-revenue', parent_id: 'r-2', name: '大客户 A 转投竞品', direction: 'negative', contribution_pct: 20, impact_value: -24, owner: '销售中心-华东大区', order_no: 1 },
    { id: 'r-2-1-1', metric_id: 'm-revenue', parent_id: 'r-2-1', name: '竞品降价 8%', direction: 'negative', contribution_pct: 12, impact_value: -14.4, owner: '销售中心-华东大区', order_no: 1 },
    { id: 'r-2-2', metric_id: 'm-revenue', parent_id: 'r-2', name: '渠道库存积压', direction: 'negative', contribution_pct: 15, impact_value: -18, owner: '生产交付中心', order_no: 2 },
    { id: 'r-3', metric_id: 'm-revenue', parent_id: null, name: '汇率折算影响', direction: 'neutral', contribution_pct: 20, impact_value: -24, owner: '财务中心', order_no: 3 },
  ],
};

async function withServer(fn, seed = SEED) {
  const repos = createMemoryRepositories(seed);
  const app = createApp({ ...repos, logger: { error() {} } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    await fn({ base, repos });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('AC 场景 1：从指标可打开原因列表，每条含名称/影响方向/贡献占比/责任方', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/results/m-revenue/reasons`);
    assert.equal(res.status, 200);
    const body = await res.json();

    // 判定标准：列表非空（原因项 ≥ 1）
    assert.ok(body.reasons.length >= 1);
    assert.equal(body.attribution.reason_count, 6);

    for (const item of body.reasons) {
      assert.ok(item.name, '原因名称非空');
      assert.ok(['正向', '负向', '中性'].includes(item.direction_label), '影响方向为三者之一');
      assert.ok(item.contribution_pct !== null || item.impact_value !== null, '影响量或贡献占比至少一项');
      assert.ok(item.owner, '责任方非空');
    }
    const rev = body.reasons.find((r) => r.id === 'r-3');
    assert.equal(rev.direction_label, '中性');
    assert.equal(rev.contribution_pct, 20);
    assert.equal(rev.impact_value, -24);
    assert.equal(rev.owner, '财务中心');
  });
});

test('AC 场景 2：完全归因时各原因贡献占比合计 = 100%（误差 ≤ 1%）', async () => {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/results/m-revenue/reasons`)).json();
    assert.equal(body.attribution.status, 'fully_attributed');
    assert.equal(body.attribution.status_label, '完全归因');
    assert.equal(body.attribution.total_contribution_pct, 100);
    assert.ok(Math.abs(100 - body.attribution.total_contribution_pct) <= 1);
    assert.equal(body.attribution.sums_to_100_within_tolerance, true);
    // 顶层 3 条 = 45 + 35 + 20
    assert.equal(body.attribution.root_reason_count, 3);
    assert.equal(body.attribution.unattributed_pct, 0);
  });
});

test('AC 场景 3：Reason 层位于固定四层链路且允许多级展开', async () => {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/results/m-revenue/reasons`)).json();
    assert.deepEqual(body.chain.layers, ['RESULT', 'REASON', 'EVIDENCE', 'SOURCE']);
    assert.equal(body.chain.current, 'REASON');
    assert.equal(body.chain.reason_expandable, true);

    const l1 = body.reasons.find((r) => r.id === 'r-2');
    const l2 = l1.children.find((c) => c.id === 'r-2-1');
    const l3 = l2.children[0];
    assert.deepEqual([l1.level, l2.level, l3.level], [1, 2, 3]);

    // 逐级下钻接口
    const childPayload = await (await fetch(`${base}/reasons/r-2/children`)).json();
    assert.equal(childPayload.layer, 'REASON');
    assert.equal(childPayload.reason_level, 2);
    assert.equal(childPayload.children.length, 2);
    assert.equal(childPayload.decomposition.children_contribution_pct, 35);
    assert.equal(childPayload.decomposition.undecomposed_pct, 0);
  });
});

test('AC 边界：指标无关联原因时返回「未归因」并给出关联入口，不得显示空列表', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/results/m-otd/reasons`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.attribution.status, 'unattributed');
    assert.equal(body.attribution.reason_count, 0);
    assert.ok(body.empty_state, '未归因必须带 empty_state');
    assert.equal(body.empty_state.title, '未归因');
    assert.equal(body.empty_state.action.label, '关联原因');
    assert.equal(body.empty_state.action.href, '/api/v1/results/m-otd/reasons');
    // 前端据此渲染「未归因」态而非空列表
    assert.equal(body.reasons.length, 0);
  });
});

test('关联入口可用：POST 关联后从未归因转为部分归因，再补齐为完全归因', async () => {
  await withServer(async ({ base }) => {
    const created = await fetch(`${base}/results/m-otd/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reasons: [{ name: '产能不足导致延期', direction: 'negative', contribution_pct: 60, owner: '生产交付中心' }],
      }),
    });
    assert.equal(created.status, 201);
    const afterFirst = (await created.json()).result;
    assert.equal(afterFirst.attribution.status, 'partially_attributed');
    assert.equal(afterFirst.attribution.unattributed_pct, 40);

    const second = await fetch(`${base}/results/m-otd/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reasons: [{ name: '来料质量波动', direction: 'negative', contribution_pct: 40, owner: '供应链中心' }],
      }),
    });
    const afterSecond = (await second.json()).result;
    assert.equal(afterSecond.attribution.status, 'fully_attributed');
    assert.equal(afterSecond.attribution.total_contribution_pct, 100);
    assert.equal(afterSecond.attribution.sums_to_100_within_tolerance, true);
  });
});

test('判定标准：影响方向仅限正向/负向/中性，非法值 422 被拒', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/results/m-otd/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reasons: [{ name: '方向非法', direction: 'up', contribution_pct: 100, owner: '销售中心' }] }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.equal(body.error.details.allowed_direction.length, 3);
  });
});

test('判定标准：合计超 100%（超出容差）时写入被拒，数据不被写坏', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/results/m-revenue/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reasons: [{ name: '超额原因', direction: 'negative', contribution_pct: 30, owner: '销售中心' }] }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error.details.errors[0].code, 'CONTRIBUTION_OVER_100');

    // 原有归因未被破坏
    const after = await (await fetch(`${base}/results/m-revenue/reasons`)).json();
    assert.equal(after.attribution.total_contribution_pct, 100);
    assert.equal(after.attribution.reason_count, 6);
  });
});

test('场景 2 容差边界：合计 100.5% 在 ±1% 容差内可写入并判定为完全归因', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/results/m-otd/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reasons: [
          { name: '产能不足', direction: 'negative', contribution_pct: 60, owner: '生产交付中心' },
          { name: '来料波动', direction: 'negative', contribution_pct: 40.5, owner: '供应链中心' },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.result.attribution.status, 'fully_attributed');
    assert.equal(body.result.attribution.total_contribution_pct, 100.5);
    assert.equal(body.result.attribution.sums_to_100_within_tolerance, true);
  });
});

test('多级原因：通过接口创建 L2 细分并保持顶层合计口径', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/results/m-revenue/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reasons: [
          { id: 'r-new-p', name: '新增大区下滑', direction: 'negative', contribution_pct: 10, owner: '销售中心', order_no: 4 },
          { id: 'r-new-c', parent_id: 'r-new-p', name: '该区渠道断货', direction: 'negative', contribution_pct: 10, owner: '供应链中心', order_no: 1 },
        ],
      }),
    });
    assert.equal(res.status, 422, '45+35+20+10+10 顶层 = 110% 超容差，应被拒');

    const ok = await fetch(`${base}/results/m-revenue/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reasons: [
          { id: 'r-new-p', name: '新增大区下滑', direction: 'negative', contribution_pct: 10, owner: '销售中心', order_no: 4 },
          { id: 'r-new-c', parent_id: 'r-new-p', name: '该区渠道断货', direction: 'negative', contribution_pct: 10, owner: '供应链中心', order_no: 1 },
        ],
        mode: 'replace',
      }),
    });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.result.attribution.total_contribution_pct, 10);
    assert.equal(body.result.attribution.status, 'partially_attributed');
    const parent = body.result.reasons.find((r) => r.id === 'r-new-p');
    assert.equal(parent.children.length, 1);
    assert.equal(parent.children[0].level, 2);
  });
});

test('原因项可修改与解除关联，改动后归因状态即时反映', async () => {
  await withServer(async ({ base }) => {
    const patched = await fetch(`${base}/reasons/r-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contribution_pct: 30 }),
    });
    assert.equal(patched.status, 200);
    const afterPatch = (await patched.json()).result;
    assert.equal(afterPatch.attribution.total_contribution_pct, 85);
    assert.equal(afterPatch.attribution.status, 'partially_attributed');
    assert.equal(afterPatch.attribution.unattributed_pct, 15);

    const del = await fetch(`${base}/reasons/r-2`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const afterDelete = (await del.json()).result;
    // r-2 及其 3 个子项一并解除关联
    assert.equal(afterDelete.attribution.reason_count, 2);
    assert.equal(afterDelete.attribution.total_contribution_pct, 50);
    assert.deepEqual(afterDelete.reasons.map((r) => r.id).sort(), ['r-1', 'r-3']);
  });
});

test('中文内容端到端往返一致（名称与责任方不被编码破坏）', async () => {
  await withServer(async ({ base }) => {
    const name = '产能不足导致延期';
    const owner = '生产交付中心';
    await fetch(`${base}/results/m-otd/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reasons: [{ name, direction: 'negative', contribution_pct: 60, owner }] }),
    });
    const body = await (await fetch(`${base}/results/m-otd/reasons`)).json();
    assert.equal(body.reasons[0].name, name);
    assert.equal(body.reasons[0].owner, owner);
    assert.equal(body.reasons[0].direction_label, '负向');
  });
});

test('写入健壮性：id 为主键，同指标与跨指标撞 id 均返回 422 而非 500', async () => {
  await withServer(async ({ base }) => {
    // 同指标内撞 id
    const sameMetric = await fetch(`${base}/results/m-revenue/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reasons: [{ id: 'r-1', name: '占位复用', direction: 'negative', contribution_pct: 10, owner: '销售中心' }] }),
    });
    assert.equal(sameMetric.status, 422);
    assert.equal((await sameMetric.json()).error.details.code, 'DUPLICATE_REASON_ID');

    // 跨指标撞 id（r-1 属于 m-revenue，此处写到 m-otd）
    const crossMetric = await fetch(`${base}/results/m-otd/reasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reasons: [{ id: 'r-1', name: '跨指标复用', direction: 'negative', contribution_pct: 100, owner: '销售中心' }] }),
    });
    assert.equal(crossMetric.status, 422);
    const detail = (await crossMetric.json()).error.details;
    assert.equal(detail.code, 'DUPLICATE_REASON_ID');
    assert.equal(detail.conflicts[0].held_by_metric, 'm-revenue');

    // 数据未被写坏
    const after = await (await fetch(`${base}/results/m-revenue/reasons`)).json();
    assert.equal(after.attribution.total_contribution_pct, 100);
    assert.equal(after.attribution.reason_count, 6);
  });
});

test('异常处理：指标不存在返回 404，未知路由返回 404', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/results/m-missing/reasons`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'METRIC_NOT_FOUND');

    const unknown = await fetch(`${base}/nope`);
    assert.equal(unknown.status, 404);
  });
});

test('接口契约与架构方案 3.2.2 一致：路径与字段命名', async () => {
  await withServer(async ({ base }) => {
    const body = await (await fetch(`${base}/results/m-revenue/reasons`)).json();
    for (const key of ['chain', 'result', 'attribution', 'reasons', 'empty_state']) {
      assert.ok(key in body, `响应须含 ${key}`);
    }
    assert.equal(body.result.period.type, 'month');
    assert.equal(body.result.period.value, '2026-08');
    assert.equal(body.result.data_status, 'ok');
  });
});
