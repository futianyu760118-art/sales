/**
 * PAND-84 反向链路查询 —— 逐条覆盖 AC（前置 / 场景 / 边界 / 判定标准）。
 *
 * 领域/服务层用内存库直测；接口层用真实 HTTP 打同一套应用。
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { createChainRepository } from '../src/repositories/chainRepository.js';
import { createAuditRepository } from '../src/repositories/auditRepository.js';
import { createTraceService } from '../src/services/traceService.js';
import { NAVIGATION_SEGMENTS, SOURCE_NOT_LABELLED } from '../src/domain/chain.js';

function buildService() {
  const db = openDatabase({ file: ':memory:' });
  return {
    db,
    service: createTraceService({
      chainRepository: createChainRepository(db),
      auditRepository: createAuditRepository(db),
    }),
  };
}

const { db, service } = buildService();

let server;
let baseUrl;

before(async () => {
  const app = createApp({ db, config: { corsOrigin: '*', port: 0 } });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const get = async (path) => {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
};

// ---------------------------------------------------------------------------
// 前置条件
// ---------------------------------------------------------------------------
describe('前置条件：存在至少 1 条已建立关联的链路数据', () => {
  test('底座含 Result / Exception / Evidence 及归因关联', () => {
    const counts = service.readOnlyAudit().rowCounts;
    assert.ok(counts.result_metrics >= 1, 'Result 至少 1 条');
    assert.ok(counts.exceptions >= 1, 'Exception 至少 1 条');
    assert.ok(counts.evidences >= 1, 'Evidence 至少 1 条');
    assert.ok(counts.attributions >= 1, '归因项至少 1 条');
    assert.ok(counts.attribution_evidences >= 1, '归因—证据关联至少 1 条');
  });

  test('Result 由专业 Owner 供给（source_system + calculation_version）', () => {
    for (const metric of service.forwardByMetric('M-GM') && [service.forwardByMetric('M-GM').metric]) {
      assert.ok(metric.sourceSystem, 'Result 必须标注来源模块');
      assert.ok(metric.calculationVersion, 'Result 必须带 Owner 的 calculation_version');
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 1
// ---------------------------------------------------------------------------
describe('场景 1：从某条 Evidence 出发，列出关联归因项与最终结果指标', () => {
  test('Evidence → 归因项 → 最终结果指标', () => {
    const payload = service.reverseByEvidence('EVD-BOM-001');
    assert.equal(payload.state, 'OK');
    assert.equal(payload.entry.type, 'evidence');
    assert.equal(payload.entry.anchorId, 'EVD-BOM-001');
    assert.ok(payload.attributions.length >= 1, '应列出关联归因项');
    assert.deepEqual(
      payload.results.map((item) => item.code),
      ['gross_margin'],
      '应列出该 Evidence 影响的最终结果指标',
    );
  });

  test('归因项携带 PAND-80 口径字段（reason_code / severity 或 M03 标注）', () => {
    const payload = service.reverseByEvidence('EVD-BOM-001');
    const exceptionBacked = payload.attributions.find((item) => item.kind.kind === 'exception');
    const m03Backed = payload.attributions.find((item) => item.kind.kind === 'm03_analysis');

    assert.ok(exceptionBacked, '应含映射至 Exception 的归因项');
    assert.equal(exceptionBacked.kind.reasonCode, 'BOM_COST_OVERRUN');
    assert.equal(exceptionBacked.kind.severity, 'high');

    assert.ok(m03Backed, '应含 M03 自有归因分析项');
    assert.equal(m03Backed.kind.label, 'M03 自有归因分析');
    assert.equal(m03Backed.reasonCode, null);
    assert.ok(m03Backed.name, 'M03 归因分析须带分析名');
  });

  test('归因项保留多级展开结构（parent_id / depth）', () => {
    const payload = service.reverseByEvidence('EVD-BOM-001');
    const child = payload.attributions.find((item) => item.parentId !== null);
    assert.ok(child, '多层展开的子项应被保留');
    assert.ok(child.depth >= 1, '子项 depth 应反映其相对顶层的层深');
    assert.ok(
      payload.attributions.some((item) => item.attributionId === child.parentId),
      '子项的父项应同时出现在反向结果中',
    );
  });

  test('一条 Evidence 可映射到多个最终结果指标', () => {
    const payload = service.reverseByEvidence('EVD-FIN-002');
    assert.equal(payload.state, 'OK');
    assert.deepEqual(
      [...payload.results.map((item) => item.code)].sort(),
      ['gross_margin', 'inventory_turnover_days'],
    );
  });

  test('不存在的 Evidence 返回 404', () => {
    assert.throws(
      () => service.reverseByEvidence('EVD-NOT-EXIST'),
      (err) => err.status === 404 && err.code === 'EVIDENCE_NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// 场景 2
// ---------------------------------------------------------------------------
describe('场景 2：从某个 source_system 出发，列出该来源下全部 Evidence、归因项与最终结果指标', () => {
  test('source_system → Evidence / 归因项 / 最终结果指标', () => {
    const payload = service.reverseBySourceSystem('MES');
    assert.equal(payload.state, 'OK');
    assert.equal(payload.entry.type, 'source_system');
    assert.equal(payload.entry.field, 'source_system');

    const evidenceIds = payload.evidences.map((item) => item.evidenceId).sort();
    assert.deepEqual(evidenceIds, ['EVD-BOM-001', 'EVD-MES-001', 'EVD-MES-002']);
    assert.ok(payload.attributions.length >= 3, '应列出该来源下全部归因项');
    assert.deepEqual(
      [...payload.results.map((item) => item.code)].sort(),
      ['gross_margin', 'on_time_delivery_rate'],
    );
  });

  test('每条归因项标注其经由的 Evidence（viaEvidenceId）', () => {
    const payload = service.reverseBySourceSystem('ERP-PROC');
    assert.ok(payload.attributions.length >= 1);
    for (const item of payload.attributions) {
      assert.ok(item.viaEvidenceId, '来自来源系统的归因项应标明经由的 Evidence');
      assert.ok(
        payload.evidences.some((v) => v.evidenceId === item.viaEvidenceId),
        'viaEvidenceId 应属于该来源系统下的 Evidence 集合',
      );
    }
  });

  test('来源系统取值筛选器可用', () => {
    const values = service.listSourceSystems();
    assert.ok(values.includes('MES'));
    assert.ok(!values.includes(null), '未标注来源不进入来源系统筛选器');
  });

  test('空 source_system 取值返回 400', () => {
    assert.throws(
      () => service.reverseBySourceSystem('   '),
      (err) => err.status === 400 && err.code === 'SOURCE_SYSTEM_REQUIRED',
    );
  });
});

// ---------------------------------------------------------------------------
// 场景 3
// ---------------------------------------------------------------------------
describe('场景 3：反向结果中每一项均可跳转到正向导航对应位置', () => {
  test('结果指标项跳转到正向第 1 段（Result）', () => {
    const payload = service.reverseByEvidence('EVD-BOM-001');
    for (const item of payload.results) {
      assert.equal(item.forwardTarget.view, 'forward');
      assert.equal(item.forwardTarget.segment, 1);
      assert.equal(item.forwardTarget.segmentKey, 'result');
      assert.equal(item.forwardTarget.contract, 'Result');
      assert.ok(item.forwardTarget.path.includes(item.code) || item.forwardTarget.path.includes(item.metricId));
    }
  });

  test('归因项跳转到正向第 2 段（原因（归因））', () => {
    const payload = service.reverseByEvidence('EVD-BOM-001');
    for (const item of payload.attributions) {
      assert.equal(item.forwardTarget.segment, 2);
      assert.equal(item.forwardTarget.segmentKey, 'reason');
      assert.equal(item.forwardTarget.segmentLabel, '原因（归因）');
      assert.equal(item.forwardTarget.contract, 'Exception');
      assert.equal(item.forwardTarget.params.attributionId, item.attributionId);
    }
  });

  test('Evidence 项跳转到正向第 3 段，来源项跳转到正向第 4 段', () => {
    const payload = service.reverseBySourceSystem('MES');
    for (const evidence of payload.evidences) {
      assert.equal(evidence.forwardTarget.segment, 3);
      assert.equal(evidence.forwardTarget.contract, 'Evidence');
    }
    const forward = service.forwardByMetric('M-GM');
    for (const source of forward.sources) {
      assert.equal(source.field, 'source_system');
      assert.equal(source.forwardTarget.segment, 4);
      assert.equal(source.forwardTarget.segmentKey, 'source');
    }
  });

  test('反向落点与正向导航段一一对应（第 4 段对齐 source_system 字段）', () => {
    const sourceSegment = NAVIGATION_SEGMENTS.find((item) => item.key === 'source');
    assert.equal(sourceSegment.contract, 'Evidence.source_system');
    assert.equal(sourceSegment.segment, 4);
  });
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------
describe('边界：空态保留当前位置，且不回落到专业原始表', () => {
  test('Evidence 未关联任何归因项时显示空态', () => {
    const payload = service.reverseByEvidence('EVD-ORPHAN-001');
    assert.equal(payload.state, 'EMPTY');
    assert.equal(payload.empty.code, 'NO_ATTRIBUTION');
    assert.deepEqual(payload.attributions, []);
    assert.deepEqual(payload.results, []);
  });

  test('空态保留当前位置（锚点与面包屑不丢失）', () => {
    const payload = service.reverseByEvidence('EVD-ORPHAN-001');
    assert.equal(payload.keepPosition, true);
    assert.equal(payload.position.anchorType, 'evidence');
    assert.equal(payload.position.anchorId, 'EVD-ORPHAN-001');
    assert.equal(payload.position.breadcrumb.length, 3);
    assert.equal(payload.position.breadcrumb[0].contract, 'Evidence');
  });

  test('source_system 无关联归因项时空态同样保留当前位置', () => {
    const payload = service.reverseBySourceSystem('PLM');
    assert.equal(payload.state, 'EMPTY');
    assert.equal(payload.keepPosition, true);
    assert.equal(payload.position.anchorType, 'source_system');
    assert.equal(payload.position.anchorId, 'PLM');
    assert.equal(payload.position.breadcrumb.length, 4);
  });

  test('空态不回落到专业原始表查询', () => {
    const payload = service.reverseByEvidence('EVD-ORPHAN-001');
    assert.equal(payload.fallbackQueried, false);
    assert.equal(payload.fallbackPolicy, 'none');
  });

  test('Evidence 缺失 source_system 时展示「来源未标注」，不回落原始表', () => {
    const payload = service.reverseByEvidence('EVD-NOSRC-001');
    assert.equal(payload.state, 'OK');
    const evidence = payload.evidences[0];
    assert.equal(evidence.sourceSystem, null);
    assert.equal(evidence.sourceLabel, SOURCE_NOT_LABELLED);
    assert.equal(evidence.sourceLabelled, false);
    assert.ok(
      payload.notices.some((notice) => notice.code === 'SOURCE_NOT_LABELLED'),
      '应给出「来源未标注」提示',
    );
    assert.equal(payload.fallbackQueried, false);
  });

  test('接口层同样返回空态而非错误', async () => {
    const { status, body } = await get('/trace/reverse/by-evidence/EVD-ORPHAN-001');
    assert.equal(status, 200);
    assert.equal(body.state, 'EMPTY');
    assert.equal(body.keepPosition, true);
  });
});

describe('边界：反向只读', () => {
  test('反向查询前后各表行数与 audit_log 水位不变', () => {
    const before_ = service.readOnlyAudit();

    service.reverseByEvidence('EVD-BOM-001');
    service.reverseBySourceSystem('MES');
    service.reverseByEvidence('EVD-ORPHAN-001');
    service.forwardByMetric('M-GM');
    service.consistencySample(10);
    service.attributionCompliance();
    service.contractObjects();

    const after_ = service.readOnlyAudit();
    assert.deepEqual(after_.rowCounts, before_.rowCounts, '反向查询不得新增/修改任何行');
    assert.equal(after_.auditCount, before_.auditCount, '反向查询不得产生留痕');
    assert.equal(after_.auditMaxId, before_.auditMaxId);
  });

  test('反向响应统一声明 readOnly', () => {
    assert.equal(service.reverseByEvidence('EVD-BOM-001').readOnly, true);
    assert.equal(service.reverseBySourceSystem('MES').readOnly, true);
    assert.equal(service.reverseByEvidence('EVD-ORPHAN-001').readOnly, true);
  });

  test('仓储层不暴露任何写方法（结构性只读）', () => {
    const repo = createChainRepository(db);
    const writers = Object.keys(repo).filter((key) => /^(insert|update|delete|create|save|put|upsert|write)/i.test(key));
    assert.deepEqual(writers, [], '链路读模型仓储不得包含写方法');
  });
});

// ---------------------------------------------------------------------------
// 判定标准
// ---------------------------------------------------------------------------
describe('判定标准 1：反向查询结果与正向导航的关联关系一致（抽样 ≥ 10 条，无差异）', () => {
  test('抽样 10 条双向比对无差异', () => {
    const result = service.consistencySample(10);
    assert.ok(result.compared >= 10, `实际比对 ${result.compared} 条，应不少于 10 条`);
    assert.equal(result.consistent, true);
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.meetsAcMinimum, true);
  });

  test('逐条样本双向均命中', () => {
    const result = service.consistencySample(10);
    for (const sample of result.samples) {
      assert.equal(sample.reverseContainsResult, true, `反向 ${sample.evidenceId} → ${sample.metricId} 应命中`);
      assert.equal(sample.forwardContainsEvidence, true, `正向 ${sample.metricId} → ${sample.evidenceId} 应命中`);
    }
  });

  test('接口层可自证一致性', async () => {
    const { status, body } = await get('/trace/reverse/consistency?sample=10');
    assert.equal(status, 200);
    assert.equal(body.consistent, true);
    assert.ok(body.compared >= 10);
  });
});

describe('判定标准 2：100% 归因项符合 PAND-80 口径', () => {
  test('无未归类归因项', () => {
    const result = service.attributionCompliance();
    assert.ok(result.total >= 1);
    assert.equal(result.compliantPct, 100);
    assert.deepEqual(result.violations, []);
  });

  test('映射至 Exception 的条目 100% 带 reason_code 与 severity', () => {
    const result = service.attributionCompliance();
    assert.ok(result.exceptionBackedCount >= 1);
    assert.equal(result.exceptionWithReasonCodeAndSeverity, result.exceptionBackedCount);
  });

  test('M03 自有归因分析条目被显式标记且不挂专业维度', () => {
    const result = service.attributionCompliance();
    assert.ok(result.m03AnalysisCount >= 1);
    for (const row of result.rows.filter((item) => item.kind === 'm03_analysis')) {
      assert.ok(row.analysisName, 'M03 自有归因分析必须有分析名');
      assert.equal(row.reasonCode, null, 'M03 自有归因分析不挂专业 reason_code');
      assert.equal(row.severity, null, 'M03 自有归因分析不挂专业 severity');
      assert.equal(row.compliant, true);
    }
  });

  test('数据库层硬约束拒绝无归属的归因项', () => {
    assert.throws(
      () => db.prepare(`
        INSERT INTO attributions
          (id, metric_id, parent_id, kind, exception_id, analysis_name,
           direction, contribution_pct, owner, order_no, created_at)
        VALUES ('A-BAD', 'M-GM', NULL, 'm03_analysis', 'X-COST1', '既挂 Exception 又标 M03',
                'negative', 10, 'M03', 9, '2026-09-26T10:00:00+08:00')
      `).run(),
      /CHECK|constraint/i,
      'kind 与承载对象不一致时必须被数据库拒绝',
    );
  });
});

describe('判定标准 3：对象清点 = Result / Exception / Evidence + source_system 字段', () => {
  test('契约对象恰为三类，无额外对象或层级', () => {
    const payload = service.contractObjects();
    assert.deepEqual(payload.contractObjects, ['Result', 'Exception', 'Evidence']);
    assert.deepEqual(payload.extraContractObjects, []);
  });

  test('「来源」是 Evidence 字段而非独立契约对象', () => {
    const payload = service.contractObjects();
    assert.equal(payload.sourceField, 'source_system');
    assert.equal(payload.sourceIsContractObject, false);
    assert.deepEqual(payload.sourceTables, [], '不得存在独立来源表');
  });

  test('导航段固定 4 段，第 2 段为原因（归因）、第 4 段对齐 source_system', () => {
    const payload = service.contractObjects();
    assert.equal(payload.navigationSegmentCount, 4);
    assert.equal(payload.navigationSegments[1].label, '原因（归因）');
    assert.equal(payload.navigationSegments[1].contract, 'Exception');
    assert.equal(payload.navigationSegments[3].contract, 'Evidence.source_system');
  });

  test('数据底座中不存在独立来源表', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    for (const forbidden of ['sources', 'source_systems', 'source_entities', 'result_reasons']) {
      assert.ok(!tables.includes(forbidden), `不得存在独立表 ${forbidden}`);
    }
    assert.deepEqual(
      tables.filter((name) => !name.startsWith('sqlite_')),
      ['attribution_evidences', 'attributions', 'audit_log', 'evidences', 'exceptions', 'result_metrics'],
    );
  });

  test('接口层可自证对象清点', async () => {
    const { status, body } = await get('/trace/contract-objects');
    assert.equal(status, 200);
    assert.deepEqual(body.contractObjects, ['Result', 'Exception', 'Evidence']);
    assert.equal(body.sourceField, 'source_system');
  });
});

// ---------------------------------------------------------------------------
// 接口层契约
// ---------------------------------------------------------------------------
describe('接口层契约', () => {
  test('场景 1 接口返回反向结果', async () => {
    const { status, body } = await get('/trace/reverse/by-evidence/EVD-BOM-001');
    assert.equal(status, 200);
    assert.equal(body.state, 'OK');
    assert.equal(body.entry.anchorId, 'EVD-BOM-001');
    assert.ok(body.results.some((item) => item.code === 'gross_margin'));
  });

  test('场景 2 接口返回反向结果', async () => {
    const { status, body } = await get('/trace/reverse/by-source-system/MES');
    assert.equal(status, 200);
    assert.equal(body.state, 'OK');
    assert.equal(body.evidences.length, 3);
  });

  test('未知 Evidence 返回 404 与结构化错误', async () => {
    const { status, body } = await get('/trace/reverse/by-evidence/EVD-NOPE');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'EVIDENCE_NOT_FOUND');
  });

  test('正向导航接口固定 4 段且 ≤ 4 次下钻可达来源', async () => {
    const { status, body } = await get('/trace/forward/by-result/M-GM');
    assert.equal(status, 200);
    assert.equal(body.segmentCount, 4);
    assert.equal(body.drillStepsToSource, 3);
    assert.ok(body.drillStepsToSource <= body.maxDrillSteps);
    assert.ok(body.reachableEvidenceIds.length >= 1);
  });

  test('反向查询不存在写端点', async () => {
    const res = await fetch(`${baseUrl}/trace/reverse/by-evidence/EVD-BOM-001`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});
