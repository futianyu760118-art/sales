/**
 * PAND-88 / F10「Evidence 视图支持按证据维度独立检索与浏览」回归测试
 * 运行： node scripts/evidence-view-regression.test.js
 *
 * 覆盖 AC：
 *   场景 1  可跨结果/原因独立检索证据；维度含 时间范围 / 证据类型 / 责任人 / 来源系统
 *   场景 2  证据类型枚举含已确认四类：单据、合同、系统记录、人工说明
 *   场景 3  结果可分页，单页条数可配置（默认 20）
 *   边界    无结果时显示空态并保留检索条件
 *   判定    各维度单独及组合均生效；返回条数与数据源匹配；默认单页 20 且可配置
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const rules = require(path.join(root, 'backend', 'lib', 'evidence-rules'));

// ===== 场景 2：证据类型枚举 = 已确认四类 =====
assert.deepEqual([...rules.EVIDENCE_TYPES], ['单据', '合同', '系统记录', '人工说明'],
  '证据类型枚举必须为业务方确认的四类');

// ===== 场景 3 / 判定：默认单页 20，且可配置 =====
assert.equal(rules.DEFAULT_PAGE_SIZE, 20, '默认单页条数必须为 20');
assert.equal(rules.parsePageSize(undefined), 20, '未传 limit 时回退默认 20');
assert.equal(rules.parsePageSize(''), 20, 'limit 为空时回退默认 20');
assert.equal(rules.parsePageSize('abc'), 20, 'limit 非法时回退默认 20');
assert.equal(rules.parsePageSize('0'), 20, 'limit 为 0 时回退默认 20');
assert.equal(rules.parsePageSize('50'), 50, 'limit 应可配置');
assert.equal(rules.parsePageSize(100), 100, 'limit 应可配置（数字入参）');
assert.equal(rules.parsePageSize('9999'), rules.MAX_PAGE_SIZE, 'limit 超上限应收敛到上限');

// 分页切片：返回条数与数据源匹配
const dataset = Array.from({ length: 45 }, (_, i) => ({ id: i + 1 }));
const p1 = rules.paginate(dataset, 1, 20);
assert.equal(p1.items.length, 20, '默认每页 20 条');
assert.equal(p1.total, 45, '返回总数应与数据源匹配');
assert.equal(p1.pages, 3, '45 条 / 每页 20 = 3 页');
assert.equal(p1.items[0].id, 1);

const p3 = rules.paginate(dataset, 3, 20);
assert.equal(p3.items.length, 5, '末页返回剩余 5 条');
assert.equal(p3.items[0].id, 41);

const p2custom = rules.paginate(dataset, 2, 10);
assert.equal(p2custom.items.length, 10, '自定义单页条数生效');
assert.equal(p2custom.items[0].id, 11, '自定义单页条数影响偏移');

// 空数据源：空态（total 0、无记录），不抛错
const empty = rules.paginate([], 1, undefined);
assert.deepEqual(empty.items, []);
assert.equal(empty.total, 0);
assert.equal(empty.page, 1);

// ===== 判定：各维度单独及组合均生效 =====
const rows = [
  { evidence_code: 'EVD202609-0001', title: '9月订单交付签收单', evidence_type: '单据',
    occurred_at: '2026-09-05', owner_name: '张三', owner_id: '11', source_system: '销售系统',
    source_data_time: '2026-09-04', object_id: 'SO-2026-001', provider: '', content: '订单交付签收',
    result_codes: ['order_delivery'], reason_codes: ['DELIVERY_RISK'] },
  { evidence_code: 'EVD202609-0002', title: '原材料采购合同', evidence_type: '合同',
    occurred_at: '2026-09-12', owner_name: '李四', owner_id: '12', source_system: '供应链系统',
    source_data_time: '2026-09-11', object_id: 'CT-2026-014', provider: '供应商甲', content: '采购合同扫描件',
    result_codes: ['material_cost'], reason_codes: ['MATERIAL_COST'] },
  { evidence_code: 'EVD202608-0003', title: '财务总账导出记录', evidence_type: '系统记录',
    occurred_at: '2026-08-20', owner_name: '王五', owner_id: '13', source_system: '财务系统',
    source_data_time: '2026-08-20', object_id: 'GL-202608', provider: '', content: '总账导出',
    result_codes: ['gross_margin'], reason_codes: ['EXPENSE_COST'] },
  { evidence_code: 'EVD202607-0004', title: '车间产能口头说明', evidence_type: '人工说明',
    occurred_at: '2026-07-15', owner_name: '张三', owner_id: '11', source_system: '',
    source_data_time: '', object_id: '', provider: '', content: '产能受限说明',
    result_codes: [], reason_codes: [] }
];

const match = (q) => rows.filter(rules.buildFilter(q)).map(r => r.evidence_code);

// 无条件下全部命中
assert.equal(match({}).length, 4, '无条件检索应返回全部证据');

// 维度 1：时间范围（单独生效）
assert.deepEqual(match({ date_from: '2026-09-01', date_to: '2026-09-30' }),
  ['EVD202609-0001', 'EVD202609-0002'], '时间范围维度应单独生效');
assert.deepEqual(match({ date_from: '2026-09-05' }), ['EVD202609-0001', 'EVD202609-0002'],
  '仅起始时间应生效');
assert.deepEqual(match({ date_to: '2026-08-31' }), ['EVD202608-0003', 'EVD202607-0004'],
  '仅结束时间应生效');
// 来源数据时间范围（独立维度）
assert.deepEqual(match({ data_time_from: '2026-09-01', data_time_to: '2026-09-30' }),
  ['EVD202609-0001', 'EVD202609-0002'], '来源数据时间范围应可独立检索');

// 维度 2：证据类型（单独生效，四类均可检索）
['单据', '合同', '系统记录', '人工说明'].forEach(t => {
  assert.equal(match({ evidence_type: t }).length, 1, '证据类型「' + t + '」应可单独检索');
});
assert.deepEqual(match({ evidence_type: '单据' }), ['EVD202609-0001']);

// 维度 3：责任人（单独生效；name 与 id 均可）
assert.deepEqual(match({ owner: '张三' }), ['EVD202609-0001', 'EVD202607-0004'], '责任人维度应单独生效');
assert.deepEqual(match({ owner: '12' }), ['EVD202609-0002'], '责任人可按 id 精确匹配');

// 维度 4：来源系统（单独生效）
assert.deepEqual(match({ source_system: '财务系统' }), ['EVD202608-0003'], '来源系统维度应单独生效');

// 组合：时间范围 + 证据类型
assert.deepEqual(match({ date_from: '2026-09-01', date_to: '2026-09-30', evidence_type: '合同' }),
  ['EVD202609-0002'], '时间范围 + 证据类型 组合应生效');
// 组合：责任人 + 来源系统
assert.deepEqual(match({ owner: '李四', source_system: '供应链系统' }),
  ['EVD202609-0002'], '责任人 + 来源系统 组合应生效');
// 组合：四维度全上
assert.deepEqual(match({ date_from: '2026-09-01', date_to: '2026-09-30', evidence_type: '单据',
  owner: '张三', source_system: '销售系统' }), ['EVD202609-0001'], '四维度组合应生效');
// 组合互斥：命中为空（空态来源）
assert.deepEqual(match({ evidence_type: '合同', source_system: '财务系统' }), [],
  '无交集条件应返回空结果（用于空态）');

// 跨结果 / 跨原因独立检索（场景 1：不依赖结果-原因上下文）
assert.deepEqual(match({ result_code: 'gross_margin' }), ['EVD202608-0003'], '应支持按关联结果独立检索');
assert.deepEqual(match({ reason_code: 'DELIVERY_RISK' }), ['EVD202609-0001'], '应支持按关联原因独立检索');

// 关键字
assert.deepEqual(match({ keyword: 'SO-2026-001' }), ['EVD202609-0001'], '关键字应匹配来源单据号');
assert.deepEqual(match({ keyword: '供应商甲' }), ['EVD202609-0002'], '关键字应匹配提供方');

// ===== 边界：来源缺失可识别（与 PAND-82 Source 契约一致，不新造事实源）=====
assert.equal(rows.filter(r => !rules.str(r.source_system)).length, 1, '来源缺失证据应可统计');

// ===== 记录归一化：枚举外取值必须被拒绝 =====
const okType = rules.normalizeEvidence({ evidence_type: '单据', title: 'T', occurred_at: '2026-09-01' });
assert.equal(okType.error, undefined, '合法证据类型应通过');
assert.equal(okType.record.contract_version, rules.CONTRACT_VERSION, '应写入 AEOS 契约版本');
assert.deepEqual(okType.record.evidence_ids, [], '契约字段 evidence_ids 应初始化为空数组');
assert.equal(okType.record.status, 'VERIFIED', '未传状态时应有默认状态');

const badType = rules.normalizeEvidence({ evidence_type: '邮件', title: 'T', occurred_at: '2026-09-01' });
assert.ok(badType.error && /枚举/.test(badType.error), '枚举外证据类型必须被拒绝');

assert.ok(rules.normalizeEvidence({ title: 'T', occurred_at: '2026-09-01' }).error, '证据类型必填');
assert.ok(rules.normalizeEvidence({ evidence_type: '单据', occurred_at: '2026-09-01' }).error, '标题必填');
assert.ok(rules.normalizeEvidence({ evidence_type: '单据', title: 'T' }).error, '形成时间必填');

// 关联结果/原因：数组与分隔字符串归一一致
assert.deepEqual(rules.normalizeEvidence({
  evidence_type: '单据', title: 'T', occurred_at: '2026-09-01', result_codes: 'a, b、c'
}).record.result_codes, ['a', 'b', 'c'], '关联结果应支持分隔字符串归一');

// 部分更新应保留既有字段
const merged = rules.normalizeEvidence({ title: 'T2' },
  { evidence_type: '合同', title: 'T', occurred_at: '2026-09-01', owner_name: '张三', object_id: 'CT-1' });
assert.equal(merged.error, undefined);
assert.equal(merged.record.evidence_type, '合同', '部分更新应保留原证据类型');
assert.equal(merged.record.owner_name, '张三', '部分更新应保留原责任人');

// ===== 证据编码生成 =====
assert.equal(rules.genEvidenceCode([], '2026-09'), 'EVD202609-0001', '空表应生成 0001 流水号');
assert.equal(rules.genEvidenceCode(
  [{ evidence_code: 'EVD202609-0001' }, { evidence_code: 'EVD202609-0007' }], '2026-09'
), 'EVD202609-0008', '应按同前缀最大流水号 +1');

// ===== 接入契约：路由已挂载 + 权限码齐备 =====
const indexSource = fs.readFileSync(path.join(root, 'backend', 'routes', 'index.js'), 'utf8');
assert.match(indexSource, /router\.use\('\/evidences'/, 'Evidence 路由必须挂载到 /evidences');
assert.match(indexSource, /M03 EBMS/, 'Evidence 路由应标注 M03 EBMS 目标模块');

const routeSource = fs.readFileSync(path.join(root, 'backend', 'routes', 'evidence.js'), 'utf8');
['evidence:view', 'evidence:create', 'evidence:edit', 'evidence:delete'].forEach(code => {
  assert.ok(routeSource.includes(code), '路由应使用权限码 ' + code);
});
assert.match(routeSource, /meta\/filter-options/, '应提供筛选项接口');
assert.match(routeSource, /default_page_size/, '应下发默认单页条数');

// 表写操作经 withTableLock 串行化 → 返回 Promise；不 await 会拿到 undefined，
// 表现为「登记成功但响应 data=null、id 缺失」。写路由必须 await。
['insert', 'update', 'delete'].forEach(m => {
  const sync = new RegExp('(?<!await )table\\.' + m + '\\(');
  assert.ok(!sync.test(routeSource), '写操作 table.' + m + ' 必须先 await（withTableLock 返回 Promise）');
});
// 三个写路由必须声明为 async
[/router\.post\('\/',\s*requirePerm\('evidence:create'\),\s*async/,
 /router\.put\('\/:id',\s*requirePerm\('evidence:edit'\),\s*async/,
 /router\.delete\('\/:id',\s*requirePerm\('evidence:delete'\),\s*async/].forEach((re, i) => {
  assert.match(routeSource, re, '写路由 ' + ['POST', 'PUT', 'DELETE'][i] + ' 必须为 async 处理器');
});

// ===== 前端页面：四维度检索入口 + 分页可配置 + 空态保留条件 =====
const pageSource = fs.readFileSync(path.join(root, 'frontend', 'evidence.html'), 'utf8');
assert.match(pageSource, /data-page-perm="evidence:view"/, '页面应受 evidence:view 准入控制');
['f_date_from', 'f_date_to', 'f_type', 'f_owner', 'f_source'].forEach(id => {
  assert.ok(pageSource.includes('id="' + id + '"'), '检索区应包含维度控件 ' + id);
});
assert.match(pageSource, /DEFAULT_PAGE_SIZE=20/, '前端默认单页应为 20');
assert.match(pageSource, /pageSizeSel/, '前端应提供单页条数配置入口');
assert.match(pageSource, /没有匹配的证据/, '无结果时应显示空态文案');
assert.match(pageSource, /条件已保留在筛选区/, '空态应说明检索条件被保留');
// 空态路径不得重置筛选项
assert.ok(!/if\(!d\.data\|\|!d\.data\.length\)\{[^}]*resetFilter/.test(pageSource),
  '空态不得重置检索条件');

// 前端导航登记
const navSource = fs.readFileSync(path.join(root, 'frontend', 'permission-check.js'), 'utf8');
assert.match(navSource, /href: 'evidence\.html'.*evidence:view/, 'Evidence 视图应登记到侧边栏');

// 权限种子齐备
const initSource = fs.readFileSync(path.join(root, 'backend', 'initData.js'), 'utf8');
['evidence:view', 'evidence:create', 'evidence:edit', 'evidence:delete'].forEach(code => {
  assert.ok(initSource.includes("'" + code + "'"), '权限种子应包含 ' + code);
});

console.log('evidence-view-regression: all assertions passed');
