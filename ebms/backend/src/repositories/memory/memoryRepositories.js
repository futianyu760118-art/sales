// 内存实现：同一 repository 契约的测试/离线替身。
// 架构方案以 repository 抽象保证数据层可迁移（PostgreSQL ↔ SQLite/内存），
// 验收自检与单测即通过本实现驱动全链路，无需本地 PostgreSQL 实例。

export function createMemoryRepositories({
  metrics: metricSeed = [],
  reasons: reasonSeed = [],
  conclusions: conclusionSeed = [],
  judgments: judgmentSeed = [],
} = {}) {
  const metrics = new Map(metricSeed.map((m) => [m.id, { ...m }]));
  const reasons = new Map(reasonSeed.map((r) => [r.id, { ...r }]));
  const conclusions = new Map(conclusionSeed.map((c) => [c.id, { ...c }]));
  const judgments = new Map(judgmentSeed.map((j) => [`${j.period_type}|${j.period_value}|${j.rule_version}`, { ...j }]));
  const audits = [];

  const metricRepository = {
    async findById(id) {
      const found = metrics.get(id);
      return found ? { ...found } : null;
    },
    async list({ periodType, periodValue } = {}) {
      return [...metrics.values()].filter(
        (m) =>
          (!periodType || m.period_type === periodType) &&
          (!periodValue || m.period_value === periodValue),
      );
    },
  };

  const reasonRepository = {
    async findByMetricId(metricId) {
      return [...reasons.values()].filter((r) => r.metric_id === metricId).map((r) => ({ ...r }));
    },
    async findById(id) {
      const found = reasons.get(id);
      return found ? { ...found } : null;
    },
    async createMany(rows, _audit, { mode = 'append' } = {}) {
      const metricId = rows[0]?.metric_id;
      if (mode === 'replace') {
        for (const [id, row] of [...reasons.entries()]) {
          if (row.metric_id === metricId) reasons.delete(id);
        }
      }
      for (const row of rows) {
        reasons.set(row.id, {
          owner_type: 'center',
          order_no: 0,
          created_at: new Date().toISOString(),
          ...row,
        });
      }
      return rows.map((r) => ({ ...reasons.get(r.id) }));
    },
    async update(id, patch, audit) {
      const current = reasons.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, updated_at: new Date().toISOString() };
      reasons.set(id, next);
      if (audit) audits.push({ ...audit, entity_id: id, before: current, after: next });
      return { ...next };
    },
    async remove(id, audit) {
      const current = reasons.get(id);
      if (!current) return false;
      // 级联删除子项（与 PostgreSQL ON DELETE CASCADE 语义一致）
      const stack = [id];
      while (stack.length) {
        const cursor = stack.pop();
        reasons.delete(cursor);
        for (const [childId, row] of [...reasons.entries()]) {
          if (row.parent_id === cursor) stack.push(childId);
        }
      }
      if (audit) audits.push({ ...audit, entity_id: id, before: current, after: null });
      return true;
    },
    async listAudits() {
      return audits.map((a) => ({ ...a }));
    },
  };

  // 结论快照：粒度 = (中心, 周期类型, 周期值)，重报以最新版本覆盖（保留 version/as_of 供追溯）
  const conclusionRepository = {
    async upsertMany(rows, audit) {
      const saved = [];
      for (const row of rows) {
        const key = `${row.center}|${row.period_type}|${row.period_value}`;
        const prev = [...conclusions.values()].find(
          (c) => `${c.center}|${c.period_type}|${c.period_value}` === key,
        );
        if (prev) conclusions.delete(prev.id);
        conclusions.set(row.id, { ...row });
        saved.push({ ...row });
      }
      if (audit) {
        audits.push({ ...audit, entity_id: rows[0]?.period_value ?? null, before: null, after: saved.map((r) => r.id) });
      }
      return saved;
    },
    async findById(id) {
      const found = conclusions.get(id);
      return found ? { ...found } : null;
    },
    async list({ periodType, periodValue, center } = {}) {
      return [...conclusions.values()]
        .filter(
          (c) =>
            (!periodType || c.period_type === periodType) &&
            (!periodValue || c.period_value === periodValue) &&
            (!center || c.center === center),
        )
        .map((c) => ({ ...c }));
    },
    async removeByPeriod({ periodType, periodValue, center }) {
      let removed = 0;
      for (const [id, row] of [...conclusions.entries()]) {
        if (
          row.period_type === periodType &&
          row.period_value === periodValue &&
          (!center || row.center === center)
        ) {
          conclusions.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };

  const judgmentRepository = {
    async upsert(row, audit) {
      const key = `${row.period_type}|${row.period_value}|${row.rule_version}`;
      const prev = judgments.get(key);
      const next = { ...row, id: prev?.id ?? row.id, generated_at: row.generated_at ?? new Date().toISOString() };
      judgments.set(key, next);
      if (audit) audits.push({ ...audit, entity_id: next.id, before: prev ?? null, after: next });
      return { ...next };
    },
    async findById(id) {
      for (const row of judgments.values()) if (row.id === id) return { ...row };
      return null;
    },
    async findByPeriod({ periodType, periodValue, ruleVersion }) {
      const key = `${periodType}|${periodValue}|${ruleVersion}`;
      const found = judgments.get(key);
      return found ? { ...found } : null;
    },
    async list({ periodType, periodValue } = {}) {
      return [...judgments.values()]
        .filter(
          (j) =>
            (!periodType || j.period_type === periodType) &&
            (!periodValue || j.period_value === periodValue),
        )
        .map((j) => ({ ...j }));
    },
  };

  return { metricRepository, reasonRepository, conclusionRepository, judgmentRepository };
}
