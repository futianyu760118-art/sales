/**
 * 反向只读边界（AC）：反向查询过程不产生新的跨域写操作。
 *
 * 比对的是全库内容指纹而非仅行数 —— 行数相同但字段被改写同样算写操作。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { openDatabase } from '../src/db/index.js';
import { createChainRepository } from '../src/repositories/chainRepository.js';
import { createAuditRepository } from '../src/repositories/auditRepository.js';
import { createTraceService } from '../src/services/traceService.js';

const TABLES = [
  'result_metrics',
  'exceptions',
  'evidences',
  'attributions',
  'attribution_evidences',
  'audit_log',
];

function fingerprint(db) {
  const payload = [];
  for (const table of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    payload.push([table, rows]);
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function freshService() {
  const db = openDatabase({ file: ':memory:' });
  return {
    db,
    service: createTraceService({
      chainRepository: createChainRepository(db),
      auditRepository: createAuditRepository(db),
    }),
  };
}

describe('反向链路只读边界', () => {
  test('穷举全部读端点后，全库内容指纹不变', () => {
    const { db, service } = freshService();
    const before = fingerprint(db);

    for (const metricId of ['M-GM', 'M-OTD', 'M-INV']) {
      service.forwardByMetric(metricId);
      service.forwardByMetric(metricId);
    }
    for (const evidenceId of ['EVD-BOM-001', 'EVD-ORPHAN-001', 'EVD-NOSRC-001', 'EVD-FIN-002']) {
      service.reverseByEvidence(evidenceId);
    }
    for (const sourceSystem of ['MES', 'ERP-PROC', 'PLM', 'OA']) {
      service.reverseBySourceSystem(sourceSystem);
    }
    service.consistencySample(10);
    service.attributionCompliance();
    service.contractObjects();
    service.listSourceSystems();
    service.readOnlyAudit();

    assert.equal(fingerprint(db), before, '反向查询链路不得改写任何一行');
  });

  test('反复查询不会累积状态（幂等）', () => {
    const { service } = freshService();
    const first = JSON.stringify(service.reverseByEvidence('EVD-BOM-001'));
    for (let i = 0; i < 5; i += 1) {
      assert.equal(JSON.stringify(service.reverseByEvidence('EVD-BOM-001')), first);
    }
  });

  test('空态查询同样不写库', () => {
    const { db, service } = freshService();
    const before = fingerprint(db);
    service.reverseByEvidence('EVD-ORPHAN-001');
    service.reverseBySourceSystem('PLM');
    assert.equal(fingerprint(db), before);
  });

  test('audit_log 水位在只读过程中保持为种子写入值', () => {
    const { service } = freshService();
    const before = service.readOnlyAudit();
    service.reverseBySourceSystem('ERP-PROC');
    const after = service.readOnlyAudit();
    assert.equal(after.auditMaxId, before.auditMaxId);
    assert.equal(after.auditCount, before.auditCount);
  });
});

describe('契约对象边界', () => {
  test('底座不存在独立来源表或独立原因表', () => {
    const { db } = freshService();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, [
      'attribution_evidences',
      'attributions',
      'audit_log',
      'evidences',
      'exceptions',
      'result_metrics',
    ]);
  });

  test('「来源」只能经 Evidence 的 source_system 字段取得', () => {
    const { db } = freshService();
    const columns = db.prepare('PRAGMA table_info(evidences)').all().map((row) => row.name);
    assert.ok(columns.includes('source_system'), 'source_system 必须是 Evidence 的字段');
  });
});
