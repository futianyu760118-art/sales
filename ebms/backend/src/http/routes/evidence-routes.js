'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('../../config/env');
const service = require('../../domain/evidence/evidence-service');
const reasonRepo = require('../../domain/reason/reason-repository');
const { requireActor } = require('../middleware/actor');
const { notFound } = require('../errors');

const router = express.Router();

// 证据类型枚举（前端下拉 / 判定标准取值来源）
router.get('/evidence-types', (_req, res) => {
  res.json({ ok: true, data: service.listEvidenceTypes() });
});

// 原因项清单（进入 F3 证据页的导航锚点；完整归因由 F2/PAND-80 交付）
router.get('/reasons', async (_req, res, next) => {
  try {
    const rows = await reasonRepo.listAll();
    res.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        direction: r.direction,
        contributionPct: r.contribution_pct === null ? null : Number(r.contribution_pct),
        owner: r.owner,
        evidenceCount: r.evidence_count,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// 「关联已有证据」的候选清单（排除已关联到该原因项的证据）
router.get('/evidences', async (req, res, next) => {
  try {
    res.json({
      ok: true,
      data: await service.listEvidenceCandidates({
        q: req.query.q,
        unlinkedToReason: req.query.unlinkedToReason,
        limit: req.query.limit,
      }),
    });
  } catch (err) {
    next(err);
  }
});

// F3 场景 1 + 边界：原因项下的证据列表（含「无证据支撑」状态）
router.get('/reasons/:reasonId/evidences', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await service.listEvidencesByReason(req.params.reasonId) });
  } catch (err) {
    next(err);
  }
});

// F3 场景 3-b：关联已有证据到原因项
router.post('/reasons/:reasonId/evidences', requireActor, async (req, res, next) => {
  try {
    const result = await service.linkEvidence(req.actor, {
      reasonId: req.params.reasonId,
      evidenceId: req.body?.evidenceId,
    });
    res.status(result.changed ? 201 : 200).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// F3 场景 3-c：解除关联
router.delete('/reasons/:reasonId/evidences/:evidenceId', requireActor, async (req, res, next) => {
  try {
    const result = await service.unlinkEvidence(req.actor, {
      reasonId: req.params.reasonId,
      evidenceId: req.params.evidenceId,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// F3 场景 3-a：新增证据（body.reasonId 可选，给出即同时建立关联）
router.post('/evidences', requireActor, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, data: await service.createEvidence(req.actor, req.body || {}) });
  } catch (err) {
    next(err);
  }
});

// F3 场景 2：证据详情（文本说明必可查看）
router.get('/evidences/:evidenceId', async (req, res, next) => {
  try {
    res.json({ ok: true, data: await service.getEvidenceDetail(req.params.evidenceId) });
  } catch (err) {
    next(err);
  }
});

// F3 场景 2：附件预览 / 下载（同一路由，?download=1 触发下载语义）
router.get('/evidences/:evidenceId/attachments/:index', async (req, res, next) => {
  try {
    const detail = await service.getEvidenceDetail(req.params.evidenceId);
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= detail.attachments.length) {
      return next(notFound('ATTACHMENT_NOT_FOUND', '附件不存在'));
    }
    const attachment = detail.attachments[index];
    const stored = path.join(config.uploadDir, path.basename(attachment.filename));
    if (!fs.existsSync(stored)) {
      return next(notFound('ATTACHMENT_FILE_MISSING', '附件文件缺失'));
    }
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
    );
    return res.sendFile(stored);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
