/**
 * M03 EBMS · Evidence 视图（证据独立检索与浏览）
 * ------------------------------------------------------------------
 * 对应功能点：PAND-88 / F10「Evidence 视图支持按证据维度独立检索与浏览」
 * AEOS 定位：M03 管理者工作面的 EVIDENCE 层（契约 AEOS.Evidence.V1）
 *
 * 边界：
 *   - 只做结论汇聚层的证据检索与浏览，不重算任何专业中心内部算法；
 *   - 证据的来源字段（source_system / object_id / source_data_time / provider）
 *     对齐 PAND-82（F4）Source 标注契约，不另建第二套事实源；
 *   - 结果/原因关联字段为「跨结果、跨原因独立检索」提供入口，未实现关联写路径时留空。
 *
 * 检索维度：时间范围、证据类型、责任人、来源系统（AC 场景 1）
 * 证据类型：单据、合同、系统记录、人工说明（AC 场景 2）
 * 分页：默认单页 20 条，可配置（AC 场景 3）
 */
const express = require('express');
const router = express.Router();
const { getTable, ensureTable, now } = require('../db');
const { requirePerm } = require('../auth-middleware');
const rules = require('../lib/evidence-rules');

ensureTable('evidences');

const {
  EVIDENCE_TYPES, DEFAULT_PAGE_SIZE, ALLOWED_PAGE_SIZES, ALLOWED_SORT_FIELDS,
  str, parsePage, parsePageSize, toCodeList, buildFilter, normalizeEvidence, genEvidenceCode
} = rules;

// ===== 列表（独立检索 + 分页）=====
router.get('/', requirePerm('evidence:view'), (req, res) => {
  const table = getTable('evidences');
  table._invalidate();
  const filter = buildFilter(req.query);
  const sortBy = ALLOWED_SORT_FIELDS.indexOf(str(req.query.sort_by)) >= 0 ? str(req.query.sort_by) : 'occurred_at';
  const sortOrder = str(req.query.sort_order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const page = parsePage(req.query.page);
  const limit = parsePageSize(req.query.limit);

  const { records, total } = table.findWhere(filter, sortBy, sortOrder, limit, (page - 1) * limit);
  res.json({
    data: records,
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    page_size_options: ALLOWED_PAGE_SIZES
  });
});

// ===== 筛选项可选值（下拉数据源）=====
router.get('/meta/filter-options', requirePerm('evidence:view'), (req, res) => {
  const table = getTable('evidences');
  table._invalidate();
  const all = table.all();
  const uniq = key => [...new Set(all.map(r => str(r[key])).filter(Boolean))];
  const ownerMap = {};
  all.forEach(r => {
    const name = str(r.owner_name);
    if (name && !ownerMap[name]) ownerMap[name] = str(r.owner_id) || '';
  });
  res.json({
    evidence_types: EVIDENCE_TYPES,
    // 来源系统按现有数据取值，不新造第二套枚举（来源口径归 PAND-82 Source 契约）
    source_systems: uniq('source_system').sort(),
    owners: Object.keys(ownerMap).sort().map(name => ({ name, id: ownerMap[name] })),
    result_codes: [...new Set(all.flatMap(r => toCodeList(r.result_codes)))].sort(),
    reason_codes: [...new Set(all.flatMap(r => toCodeList(r.reason_codes)))].sort(),
    default_page_size: DEFAULT_PAGE_SIZE,
    page_size_options: ALLOWED_PAGE_SIZES
  });
});

// ===== 统计（与列表同一检索口径，保证「返回条数与数据源匹配」）=====
router.get('/stats', requirePerm('evidence:view'), (req, res) => {
  const table = getTable('evidences');
  table._invalidate();
  const matched = table.all().filter(buildFilter(req.query));
  const byType = {};
  EVIDENCE_TYPES.forEach(t => { byType[t] = 0; });
  const bySource = {};
  matched.forEach(r => {
    byType[r.evidence_type] = (byType[r.evidence_type] || 0) + 1;
    const s = str(r.source_system) || '未标注';
    bySource[s] = (bySource[s] || 0) + 1;
  });
  const noSource = matched.filter(r => !str(r.source_system)).length;
  res.json({
    total: matched.length,
    by_type: byType,
    by_source: Object.entries(bySource).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    missing_source_count: noSource,
    missing_source_rate: matched.length ? Math.round(noSource / matched.length * 1000) / 10 : 0
  });
});

// ===== 详情（放在具名单段路径之后，避免 /:id 抢占）=====
router.get('/:id', requirePerm('evidence:view'), (req, res) => {
  const table = getTable('evidences');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '证据不存在' });
  res.json(row);
});

// ===== 新增证据（登记入口，供挂载/来源补录使用）=====
// 表写操作经 withTableLock 串行化，返回 Promise，必须 await 后才能读到 lastID/落盘结果。
router.post('/', requirePerm('evidence:create'), async (req, res) => {
  const table = getTable('evidences');
  table._invalidate();
  const { record, error } = normalizeEvidence(req.body || {});
  if (error) return res.status(400).json({ error });

  const code = record.evidence_code || genEvidenceCode(table.all(), now().substring(0, 7));
  if (table.all().some(r => str(r.evidence_code) === code)) {
    return res.status(400).json({ error: '证据编码已存在：' + code });
  }
  record.evidence_code = code;
  record.created_at = now();
  record.updated_at = record.created_at;
  const info = await table.insert(record);
  res.json({ id: info.lastID, message: '证据已登记', data: table.findById(info.lastID) });
});

// ===== 修改证据 =====
router.put('/:id', requirePerm('evidence:edit'), async (req, res) => {
  const table = getTable('evidences');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '证据不存在' });

  const { record, error } = normalizeEvidence(req.body || {}, row);
  if (error) return res.status(400).json({ error });

  if (record.evidence_code && record.evidence_code !== str(row.evidence_code)
      && table.all().some(r => Number(r.id) !== Number(row.id) && str(r.evidence_code) === record.evidence_code)) {
    return res.status(400).json({ error: '证据编码已存在：' + record.evidence_code });
  }
  record.updated_at = now();
  await table.update(row.id, record);
  res.json({ message: '证据已更新', data: table.findById(row.id) });
});

// ===== 删除证据 =====
router.delete('/:id', requirePerm('evidence:delete'), async (req, res) => {
  const table = getTable('evidences');
  const row = table.findById(req.params.id);
  if (!row) return res.status(404).json({ error: '证据不存在' });
  await table.delete(row.id);
  res.json({ message: '证据已删除' });
});

module.exports = router;
