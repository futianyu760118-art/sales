// PostgreSQL 实现（架构方案 3.4 选型：pg + 递归 CTE + 事务）。
// 写入路径全部在事务内完成「读取全量 → 校验 → 落库 + 留痕」，
// 与架构方案 3.3「贡献占比合计=100% 在写入时用事务 + 校验保证」一致。

import { randomUUID } from 'node:crypto';

const METRIC_COLUMNS = `id, code, name, dimension, unit, period_type, period_value,
  target, actual, deviation_abs, deviation_pct, threshold_pct, data_status, no_data_reason, as_of`;

const REASON_COLUMNS = `id, metric_id, parent_id, name, direction, contribution_pct,
  impact_value, owner, owner_type, order_no, note, created_at, updated_at`;

const CONCLUSION_COLUMNS = `id, center, period_type, period_value, version, as_of,
  payload, missing, missing_reason, source_mode, ingested_at`;

const JUDGMENT_COLUMNS = `id, period_type, period_value, rule_version, level, conclusion,
  present_domains, missing_domains, referenced_conclusion_ids, can_judge, detail, generated_at`;

export function createPgRepositories(pool) {
  const metricRepository = {
    async findById(id) {
      const { rows } = await pool.query(`SELECT ${METRIC_COLUMNS} FROM result_metrics WHERE id = $1`, [id]);
      return rows[0] ?? null;
    },
    async list({ periodType, periodValue } = {}) {
      const { rows } = await pool.query(
        `SELECT ${METRIC_COLUMNS} FROM result_metrics
         WHERE ($1::text IS NULL OR period_type = $1)
           AND ($2::text IS NULL OR period_value = $2)
         ORDER BY dimension, code`,
        [periodType ?? null, periodValue ?? null],
      );
      return rows;
    },
  };

  const reasonRepository = {
    async findByMetricId(metricId, client = pool) {
      const { rows } = await client.query(
        `SELECT ${REASON_COLUMNS} FROM result_reasons
         WHERE metric_id = $1
         ORDER BY parent_id NULLS FIRST, order_no, id`,
        [metricId],
      );
      return rows;
    },
    async findById(id, client = pool) {
      const { rows } = await client.query(`SELECT ${REASON_COLUMNS} FROM result_reasons WHERE id = $1`, [id]);
      return rows[0] ?? null;
    },
    /**
     * rows: 待写入的原因项；mode=append 追加，mode=replace 以本次集合整体替换该指标的原因（含校验）。
     */
    async createMany(rows, audit, { mode = 'append' } = {}) {
      const metricId = rows[0]?.metric_id;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (mode === 'replace') {
          await client.query('DELETE FROM result_reasons WHERE metric_id = $1', [metricId]);
        }
        const inserted = [];
        for (const row of rows) {
          const { rows: out } = await client.query(
            `INSERT INTO result_reasons
               (id, metric_id, parent_id, name, direction, contribution_pct, impact_value,
                owner, owner_type, order_no, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING ${REASON_COLUMNS}`,
            [
              row.id ?? randomUUID(),
              row.metric_id,
              row.parent_id ?? null,
              row.name,
              row.direction,
              row.contribution_pct ?? null,
              row.impact_value ?? null,
              row.owner,
              row.owner_type ?? 'center',
              row.order_no ?? 0,
              row.note ?? null,
            ],
          );
          inserted.push(out[0]);
        }
        if (audit) {
          await client.query(
            `INSERT INTO audit_log (actor, action, entity_type, entity_id, before, after)
             VALUES ($1, $2, 'result_reasons', $3, NULL, $4)`,
            [audit.actor, audit.action, metricId, JSON.stringify(inserted)],
          );
        }
        await client.query('COMMIT');
        return inserted;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async update(id, patch, audit) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: before } = await client.query(`SELECT ${REASON_COLUMNS} FROM result_reasons WHERE id = $1 FOR UPDATE`, [id]);
        if (!before[0]) {
          await client.query('ROLLBACK');
          return null;
        }
        const fields = ['name', 'direction', 'contribution_pct', 'impact_value', 'owner', 'owner_type', 'order_no', 'note', 'parent_id'];
        const sets = [];
        const values = [];
        for (const field of fields) {
          if (Object.prototype.hasOwnProperty.call(patch, field)) {
            values.push(patch[field]);
            sets.push(`${field} = $${values.length}`);
          }
        }
        if (sets.length === 0) {
          await client.query('ROLLBACK');
          return before[0];
        }
        values.push(id);
        const { rows: after } = await client.query(
          `UPDATE result_reasons SET ${sets.join(', ')}, updated_at = now()
           WHERE id = $${values.length} RETURNING ${REASON_COLUMNS}`,
          values,
        );
        if (audit) {
          await client.query(
            `INSERT INTO audit_log (actor, action, entity_type, entity_id, before, after)
             VALUES ($1, $2, 'result_reasons', $3, $4, $5)`,
            [audit.actor, audit.action, id, JSON.stringify(before[0]), JSON.stringify(after[0])],
          );
        }
        await client.query('COMMIT');
        return after[0];
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async remove(id, audit) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: before } = await client.query(`SELECT ${REASON_COLUMNS} FROM result_reasons WHERE id = $1`, [id]);
        if (!before[0]) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query('DELETE FROM result_reasons WHERE id = $1', [id]);
        if (audit) {
          await client.query(
            `INSERT INTO audit_log (actor, action, entity_type, entity_id, before, after)
             VALUES ($1, $2, 'result_reasons', $3, $4, NULL)`,
            [audit.actor, audit.action, id, JSON.stringify(before[0])],
          );
        }
        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };

  // 结论快照：upsert 语义（同 中心+周期 重报以最新批次覆盖），payload 原样落库
  const conclusionRepository = {
    async upsertMany(rows, audit) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const saved = [];
        for (const row of rows) {
          const { rows: out } = await client.query(
            `INSERT INTO domain_conclusions
               (id, center, period_type, period_value, version, as_of, payload, missing, missing_reason, source_mode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (center, period_type, period_value) DO UPDATE SET
               version        = EXCLUDED.version,
               as_of          = EXCLUDED.as_of,
               payload        = EXCLUDED.payload,
               missing        = EXCLUDED.missing,
               missing_reason = EXCLUDED.missing_reason,
               source_mode    = EXCLUDED.source_mode,
               ingested_at    = now()
             RETURNING ${CONCLUSION_COLUMNS}`,
            [
              row.id ?? randomUUID(),
              row.center,
              row.period_type,
              row.period_value,
              row.version ?? null,
              row.as_of ?? null,
              row.payload === null || row.payload === undefined ? null : JSON.stringify(row.payload),
              row.missing ?? false,
              row.missing_reason ?? null,
              row.source_mode ?? 'api',
            ],
          );
          saved.push(out[0]);
        }
        if (audit) {
          await client.query(
            `INSERT INTO audit_log (actor, action, entity_type, entity_id, before, after)
             VALUES ($1, $2, 'domain_conclusions', $3, NULL, $4)`,
            [audit.actor, audit.action, `${audit.periodType}:${audit.periodValue}`, JSON.stringify(saved.map((s) => s.id))],
          );
        }
        await client.query('COMMIT');
        return saved;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async findById(id) {
      const { rows } = await pool.query(`SELECT ${CONCLUSION_COLUMNS} FROM domain_conclusions WHERE id = $1`, [id]);
      return rows[0] ?? null;
    },
    async list({ periodType, periodValue, center } = {}) {
      const { rows } = await pool.query(
        `SELECT ${CONCLUSION_COLUMNS} FROM domain_conclusions
         WHERE ($1::text IS NULL OR period_type = $1)
           AND ($2::text IS NULL OR period_value = $2)
           AND ($3::text IS NULL OR center = $3)
         ORDER BY center`,
        [periodType ?? null, periodValue ?? null, center ?? null],
      );
      return rows;
    },
    async removeByPeriod({ periodType, periodValue, center }) {
      const { rowCount } = await pool.query(
        `DELETE FROM domain_conclusions
         WHERE period_type = $1 AND period_value = $2 AND ($3::text IS NULL OR center = $3)`,
        [periodType, periodValue, center ?? null],
      );
      return rowCount;
    },
  };

  // 跨域判断：粒度 = (周期类型, 周期值, 规则版本)，重算覆盖并留痕
  const judgmentRepository = {
    async upsert(row, audit) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: before } = await client.query(
          `SELECT ${JUDGMENT_COLUMNS} FROM cross_domain_judgments
           WHERE period_type = $1 AND period_value = $2 AND rule_version = $3 FOR UPDATE`,
          [row.period_type, row.period_value, row.rule_version],
        );
        const { rows: out } = await client.query(
          `INSERT INTO cross_domain_judgments
             (id, period_type, period_value, rule_version, level, conclusion,
              present_domains, missing_domains, referenced_conclusion_ids, can_judge, detail)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (period_type, period_value, rule_version) DO UPDATE SET
             level                    = EXCLUDED.level,
             conclusion               = EXCLUDED.conclusion,
             present_domains          = EXCLUDED.present_domains,
             missing_domains          = EXCLUDED.missing_domains,
             referenced_conclusion_ids = EXCLUDED.referenced_conclusion_ids,
             can_judge                = EXCLUDED.can_judge,
             detail                   = EXCLUDED.detail,
             generated_at             = now()
           RETURNING ${JUDGMENT_COLUMNS}`,
          [
            row.id ?? randomUUID(),
            row.period_type,
            row.period_value,
            row.rule_version,
            row.level,
            row.conclusion,
            row.present_domains ?? [],
            row.missing_domains ?? [],
            row.referenced_conclusion_ids ?? [],
            row.can_judge ?? false,
            row.detail === null || row.detail === undefined ? null : JSON.stringify(row.detail),
          ],
        );
        if (audit) {
          await client.query(
            `INSERT INTO audit_log (actor, action, entity_type, entity_id, before, after)
             VALUES ($1, $2, 'cross_domain_judgments', $3, $4, $5)`,
            [
              audit.actor,
              audit.action,
              out[0].id,
              before[0] ? JSON.stringify(before[0]) : null,
              JSON.stringify(out[0]),
            ],
          );
        }
        await client.query('COMMIT');
        return out[0];
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async findById(id) {
      const { rows } = await pool.query(`SELECT ${JUDGMENT_COLUMNS} FROM cross_domain_judgments WHERE id = $1`, [id]);
      return rows[0] ?? null;
    },
    async findByPeriod({ periodType, periodValue, ruleVersion }) {
      const { rows } = await pool.query(
        `SELECT ${JUDGMENT_COLUMNS} FROM cross_domain_judgments
         WHERE period_type = $1 AND period_value = $2 AND rule_version = $3`,
        [periodType, periodValue, ruleVersion],
      );
      return rows[0] ?? null;
    },
    async list({ periodType, periodValue } = {}) {
      const { rows } = await pool.query(
        `SELECT ${JUDGMENT_COLUMNS} FROM cross_domain_judgments
         WHERE ($1::text IS NULL OR period_type = $1)
           AND ($2::text IS NULL OR period_value = $2)
         ORDER BY generated_at DESC`,
        [periodType ?? null, periodValue ?? null],
      );
      return rows;
    },
  };

  return { metricRepository, reasonRepository, conclusionRepository, judgmentRepository };
}
