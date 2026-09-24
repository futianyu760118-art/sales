'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const { pool } = require('./pool');

// 自检夹具：固定 UUID，便于测试逐条断言。
const IDS = {
  users: {
    decider: '11111111-1111-4111-8111-111111111111',
    owner: '22222222-2222-4222-8222-222222222222',
  },
  metric: '33333333-3333-4333-8333-333333333333',
  reasons: {
    capacity: 'aaaaaaaa-0001-4000-8000-000000000001', // 已挂载证据
    channel: 'aaaaaaaa-0002-4000-8000-000000000002',  // 无证据支撑（边界）
    material: 'aaaaaaaa-0003-4000-8000-000000000003', // 已挂载证据
  },
  evidences: {
    contract: 'bbbbbbbb-0001-4000-8000-000000000001',
    document: 'bbbbbbbb-0002-4000-8000-000000000002',
    systemRecord: 'bbbbbbbb-0003-4000-8000-000000000003',
    manualNote: 'bbbbbbbb-0004-4000-8000-000000000004',
    warehouse: 'bbbbbbbb-0005-4000-8000-000000000005',
  },
};

const CONTRACT_FILE = '采购框架合同_SC-2026-014.pdf';
const SEED_ACTOR_NAME = '李责任（管理责任人）';

function minimalPdf(text) {
  const body = `BT /F1 12 Tf 40 750 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

async function seed() {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const pdfBuffer = minimalPdf('EBMS fixture attachment');
  fs.writeFileSync(path.join(config.uploadDir, CONTRACT_FILE), pdfBuffer);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 幂等：本脚本是开发/自检夹具，先清空 EBMS 自有数据再灌入。
    await client.query('TRUNCATE reason_evidences, audit_log, evidences, result_reasons, result_metrics CASCADE');

    await client.query(
      `INSERT INTO ebms_users (id, username, display_name, role) VALUES
         ($1, 'decider', '张决策（决策者）', 'decider'),
         ($2, 'owner',   '李责任（管理责任人）', 'owner')
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [IDS.users.decider, IDS.users.owner]
    );

    await client.query(
      `INSERT INTO result_metrics (id, code, name, dimension, period_type, period_value, as_of)
       VALUES ($1, 'order_delivery', '订单交付', 'business', 'month', '2026-09', '2026-09-23T00:00:00+08:00')`,
      [IDS.metric]
    );

    await client.query(
      `INSERT INTO result_reasons (id, metric_id, name, direction, contribution_pct, owner, order_no) VALUES
         ($1, $4, '产能不足',     'negative', 40.00, '生产中心',   1),
         ($2, $4, '渠道压货',     'negative', 25.00, '销售中心',   2),
         ($3, $4, '原材料涨价',   'negative', 20.00, '供应链中心', 3)`,
      [IDS.reasons.capacity, IDS.reasons.channel, IDS.reasons.material, IDS.metric]
    );

    const evidenceRows = [
      {
        id: IDS.evidences.contract,
        type: 'contract',
        title: '采购框架合同 SC-2026-014',
        formedAt: '2026-08-15T00:00:00+08:00',
        owner: '供应链中心 / 王采购',
        content: '与 A 供应商签订的年度框架采购合同，附件为签署版扫描件。',
        attachments: [{ filename: CONTRACT_FILE, storage_key: CONTRACT_FILE, size_bytes: pdfBuffer.length }],
      },
      {
        id: IDS.evidences.document,
        type: 'document',
        title: '生产工单 GW-2026-0901',
        formedAt: '2026-09-01T00:00:00+08:00',
        owner: '生产中心 / 赵计划',
        content: '9 月首周生产工单，含计划产量与实际产量记录。',
        attachments: [],
      },
      {
        id: IDS.evidences.systemRecord,
        type: 'system_record',
        title: 'MES 产能达成率导出（2026-09）',
        formedAt: '2026-09-20T00:00:00+08:00',
        owner: '生产中心 / 系统',
        content: 'MES 导出的产能达成率明细：计划 1200 台，实际 1044 台，达成率 87%。',
        attachments: [],
      },
      {
        id: IDS.evidences.manualNote,
        type: 'manual_note',
        title: '产线技改停产说明',
        formedAt: '2026-09-10T00:00:00+08:00',
        owner: '生产中心 / 钱厂长',
        content: '2 号线于 9/8–9/12 进行技改停产，累计停产 5 天，折算影响产量约 180 台。',
        attachments: [],
      },
      {
        id: IDS.evidences.warehouse,
        type: 'system_record',
        title: 'WMS 库存周转导出（2026-09）',
        formedAt: '2026-09-18T00:00:00+08:00',
        owner: '供应链中心 / 系统',
        content: 'WMS 库存周转与呆滞物料导出，用于佐证原材料涨价的影响范围。',
        attachments: [],
      },
    ];

    for (const e of evidenceRows) {
      await client.query(
        `INSERT INTO evidences (id, type, title, formed_at, owner, content, attachment_refs, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [e.id, e.type, e.title, e.formedAt, e.owner, e.content, JSON.stringify(e.attachments), IDS.users.owner]
      );
    }

    const links = [
      [IDS.reasons.capacity, IDS.evidences.contract],
      [IDS.reasons.capacity, IDS.evidences.document],
      [IDS.reasons.capacity, IDS.evidences.systemRecord],
      [IDS.reasons.capacity, IDS.evidences.manualNote],
      [IDS.reasons.material, IDS.evidences.contract],
      [IDS.reasons.material, IDS.evidences.warehouse],
    ];
    for (const [reasonId, evidenceId] of links) {
      await client.query(
        `INSERT INTO reason_evidences (reason_id, evidence_id, linked_by) VALUES ($1, $2, $3)`,
        [reasonId, evidenceId, IDS.users.owner]
      );
      await client.query(
        `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id, reason_id, after)
         VALUES ($1, $2, 'evidence.link', 'evidence', $3, $4, $5::jsonb)`,
        [IDS.users.owner, SEED_ACTOR_NAME, evidenceId, reasonId, JSON.stringify({ reasonId, evidenceId })]
      );
    }
    // 为「已挂载」证据补一条新增留痕，使留痕时间线完整
    for (const e of evidenceRows) {
      await client.query(
        `INSERT INTO audit_log (actor, actor_name, action, entity_type, entity_id, reason_id, after)
         VALUES ($1, $2, 'evidence.create', 'evidence', $3, NULL, $4::jsonb)`,
        [IDS.users.owner, SEED_ACTOR_NAME, e.id, JSON.stringify({ type: e.type, title: e.title, formedAt: e.formedAt, owner: e.owner })]
      );
    }

    await client.query('COMMIT');
    console.log('[seed] done');
    console.log('[seed]   reason 已有证据 :', IDS.reasons.capacity, '(4 条)');
    console.log('[seed]   reason 无证据   :', IDS.reasons.channel, '(0 条 → 无证据支撑)');
    console.log('[seed]   reason 已有证据 :', IDS.reasons.material, '(2 条)');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('[seed] failed:', err.message);
      process.exit(1);
    });
}

module.exports = { seed, IDS, CONTRACT_FILE };
