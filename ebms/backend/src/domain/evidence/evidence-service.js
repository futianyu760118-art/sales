'use strict';

const { withTransaction } = require('../../db/pool');
const { badRequest, notFound, conflict } = require('../../http/errors');
const { isValidEvidenceType, listEvidenceTypes, labelOf, EVIDENCE_TYPE_CODES } = require('./evidence-types');
const evidenceRepo = require('./evidence-repository');
const reasonRepo = require('../../domain/reason/reason-repository');
const auditRepo = require('../audit/audit-repository');

// ---------------------------------------------------------------- 序列化

function serializeEvidence(row) {
  const attachments = Array.isArray(row.attachment_refs) ? row.attachment_refs : [];
  return {
    id: row.id,
    type: row.type,
    typeLabel: labelOf(row.type),
    title: row.title,
    formedAt: row.formed_at,
    owner: row.owner,
    content: row.content ?? null,
    attachmentCount: attachments.length,
    attachments: attachments.map((a, index) => ({
      index,
      filename: a.filename,
      sizeBytes: a.size_bytes ?? null,
      // 带附件的证据可预览或下载：由后端流式返回，不直接暴露存储路径
      url: `/api/v1/evidences/${row.id}/attachments/${index}`,
    })),
    createdBy: row.created_by_name || row.created_by,
    createdById: row.created_by,
    createdAt: row.created_at,
    linkedBy: row.linked_by ?? null,
    linkedAt: row.linked_at ?? null,
  };
}

function serializeAudit(row) {
  return {
    id: String(row.id),
    actor: row.actor,
    actorName: row.actor_name,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reasonId: row.reason_id,
    at: row.at,
    before: row.before,
    after: row.after,
  };
}

// ---------------------------------------------------------------- 校验

function normalizeAttachments(attachmentRefs) {
  if (attachmentRefs === undefined || attachmentRefs === null) return [];
  if (!Array.isArray(attachmentRefs)) {
    throw badRequest('EVIDENCE_ATTACHMENTS_INVALID', '附件引用必须是数组');
  }
  return attachmentRefs.map((ref, i) => {
    if (!ref || typeof ref !== 'object' || typeof ref.filename !== 'string' || ref.filename.trim() === '') {
      throw badRequest('EVIDENCE_ATTACHMENT_INVALID', `第 ${i + 1} 个附件缺少文件名`);
    }
    return {
      filename: ref.filename.trim(),
      storage_key: ref.storageKey || ref.filename.trim(),
      size_bytes: Number.isFinite(ref.sizeBytes) ? ref.sizeBytes : null,
    };
  });
}

/**
 * 一次性校验新增证据的全部字段。
 * 返回的 fields 描述每个字段的错误，供前端逐项提示；
 * 首个错误同时以专属 code 抛出，便于调用方精确判定失败原因。
 */
function validateCreateInput(input) {
  const fields = {};
  const payload = {};

  // 证据类型
  if (!isValidEvidenceType(input.type)) {
    fields.type = '证据类型不在预定义枚举内';
  } else {
    payload.type = input.type;
  }

  // 标题
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    fields.title = '证据标题不能为空';
  } else {
    payload.title = input.title.trim();
  }

  // 形成时间
  if (input.formedAt === undefined || input.formedAt === null || input.formedAt === '') {
    fields.formedAt = '证据形成时间不能为空';
  } else {
    const parsed = new Date(input.formedAt);
    if (Number.isNaN(parsed.getTime())) fields.formedAt = '证据形成时间不是合法的日期时间';
    else payload.formedAt = parsed.toISOString();
  }

  // 责任人
  if (typeof input.owner !== 'string' || input.owner.trim() === '') {
    fields.owner = '证据责任人不能为空';
  } else {
    payload.owner = input.owner.trim();
  }

  if (Object.keys(fields).length === 0) return payload;

  const details = { fields };
  if (fields.type) {
    details.received = input.type ?? null;
    details.allowed = EVIDENCE_TYPE_CODES;
  }

  const [field] = Object.keys(fields);
  const codes = {
    type: 'EVIDENCE_TYPE_INVALID',
    title: 'EVIDENCE_TITLE_REQUIRED',
    formedAt:
      input.formedAt === undefined || input.formedAt === null || input.formedAt === ''
        ? 'EVIDENCE_FORMED_AT_REQUIRED'
        : 'EVIDENCE_FORMED_AT_INVALID',
    owner: 'EVIDENCE_OWNER_REQUIRED',
  };
  throw badRequest(codes[field], fields[field], details);
}

/** 留痕中的操作人既留 id（可追溯），也留可读名称（可展示）。 */
function actorNameOf(actor) {
  return actor.displayName || actor.username || actor.id;
}

async function requireReason(reasonId) {
  const reason = await reasonRepo.findById(reasonId);
  if (!reason) {
    throw notFound('REASON_NOT_FOUND', `原因项不存在：${reasonId}`);
  }
  return reason;
}

// ---------------------------------------------------------------- 用例

/**
 * 场景 1 + 边界：原因项下的证据列表，无证据时标明「无证据支撑」。
 */
async function listEvidencesByReason(reasonId) {
  const reason = await requireReason(reasonId);
  const rows = await evidenceRepo.listByReason(reasonId);
  const audits = await auditRepo.listByReason(reasonId);

  return {
    reason: {
      id: reason.id,
      name: reason.name,
      direction: reason.direction,
      contributionPct: reason.contribution_pct === null ? null : Number(reason.contribution_pct),
      owner: reason.owner,
    },
    // 边界：醒目提示由前端依据该状态渲染
    hasEvidence: rows.length > 0,
    evidenceStatus: rows.length > 0 ? 'HAS_EVIDENCE' : 'NO_EVIDENCE',
    evidenceStatusLabel: rows.length > 0 ? '已有证据支撑' : '无证据支撑',
    total: rows.length,
    items: rows.map(serializeEvidence),
    auditTrail: audits.map(serializeAudit),
  };
}

/**
 * 「关联已有证据」的候选清单（不包含已关联到该原因项的证据）。
 */
async function listEvidenceCandidates({ q = null, unlinkedToReason = null, limit = 50 } = {}) {
  if (unlinkedToReason) await requireReason(unlinkedToReason);
  const rows = await evidenceRepo.listCandidates({
    q: typeof q === 'string' && q.trim() !== '' ? q.trim() : null,
    unlinkedToReason: unlinkedToReason || null,
    limit: Math.min(Number(limit) || 50, 200),
  });
  return { total: rows.length, items: rows.map(serializeEvidence) };
}

/**
 * 场景 2：证据详情（文本说明必可查看；带附件可预览或下载）。
 */
async function getEvidenceDetail(evidenceId) {
  const row = await evidenceRepo.findById(evidenceId);
  if (!row) {
    throw notFound('EVIDENCE_NOT_FOUND', `证据不存在：${evidenceId}`);
  }
  const detail = serializeEvidence(row);
  return {
    ...detail,
    // 文本说明的可读性标记：type=manual_note 必须有正文，否则视为数据不完整
    contentViewable: true,
    hasContent: typeof detail.content === 'string' && detail.content.trim() !== '',
    contentNotice:
      row.type === 'manual_note' && !(detail.content || '').trim()
        ? '人工说明类证据缺少文本说明内容'
        : null,
  };
}

/**
 * 场景 3-a：新增证据（可选同时关联到某原因项）。写入 + 留痕同事务。
 */
async function createEvidence(actor, input) {
  const payload = {
    ...validateCreateInput(input),
    content: typeof input.content === 'string' ? input.content : null,
    attachmentRefs: normalizeAttachments(input.attachmentRefs),
  };

  const reasonId = input.reasonId ?? null;
  if (reasonId) await requireReason(reasonId);

  const createdId = await withTransaction(async (client) => {
    const created = await evidenceRepo.insert(client, { ...payload, createdBy: actor.id });

    const createAudit = await auditRepo.record(client, {
      actor: actor.id,
      actorName: actorNameOf(actor),
      action: 'evidence.create',
      entityType: 'evidence',
      entityId: created.id,
      reasonId,
      after: { type: created.type, title: created.title, formedAt: created.formed_at, owner: created.owner },
    });

    if (reasonId) {
      await evidenceRepo.link(client, { reasonId, evidenceId: created.id, linkedBy: actor.id });
      // 「新增并关联」同时构成一次关联操作，需独立留痕，保证三类操作均留痕。
      createAudit.linkAudit = await auditRepo.record(client, {
        actor: actor.id,
        actorName: actorNameOf(actor),
        action: 'evidence.link',
        entityType: 'evidence',
        entityId: created.id,
        reasonId,
        after: { reasonId, evidenceId: created.id },
      });
    }

    return created.id;
  });

  // 事务提交后回读，使响应与列表/详情一致（含录入人展示名等派生字段）
  const [created, audits] = await Promise.all([
    evidenceRepo.findById(createdId),
    auditRepo.listByEntity('evidence', createdId),
  ]);

  const createAudit = audits.find((a) => a.action === 'evidence.create') || null;
  const linkAudit = audits.find((a) => a.action === 'evidence.link') || null;

  return {
    evidence: serializeEvidence(created),
    linkedToReasonId: reasonId,
    audit: createAudit ? serializeAudit(createAudit) : null,
    linkAudit: linkAudit ? serializeAudit(linkAudit) : null,
  };
}

/**
 * 场景 3-b：关联已有证据到原因项（幂等）。
 */
async function linkEvidence(actor, { reasonId, evidenceId }) {
  await requireReason(reasonId);

  const existing = await evidenceRepo.findById(evidenceId);
  if (!existing) {
    throw notFound('EVIDENCE_NOT_FOUND', `证据不存在：${evidenceId}`);
  }

  return withTransaction(async (client) => {
    const linked = await evidenceRepo.link(client, { reasonId, evidenceId, linkedBy: actor.id });

    if (!linked) {
      // 幂等：已关联则不再写留痕，避免留痕噪声
      return { changed: false, alreadyLinked: true, reasonId, evidenceId, audit: null };
    }

    const audit = await auditRepo.record(client, {
      actor: actor.id,
      actorName: actorNameOf(actor),
      action: 'evidence.link',
      entityType: 'evidence',
      entityId: evidenceId,
      reasonId,
      after: { reasonId, evidenceId },
    });

    return { changed: true, alreadyLinked: false, reasonId, evidenceId, audit: serializeAudit(audit) };
  });
}

/**
 * 场景 3-c：解除关联（不删除证据本身）。
 */
async function unlinkEvidence(actor, { reasonId, evidenceId }) {
  await requireReason(reasonId);

  const existing = await evidenceRepo.findById(evidenceId);
  if (!existing) {
    throw notFound('EVIDENCE_NOT_FOUND', `证据不存在：${evidenceId}`);
  }

  return withTransaction(async (client) => {
    const removed = await evidenceRepo.unlink(client, { reasonId, evidenceId });
    if (!removed) {
      throw conflict('EVIDENCE_NOT_LINKED', '该证据未关联到此原因项，无法解除关联');
    }

    const audit = await auditRepo.record(client, {
      actor: actor.id,
      actorName: actorNameOf(actor),
      action: 'evidence.unlink',
      entityType: 'evidence',
      entityId: evidenceId,
      reasonId,
      before: { reasonId, evidenceId },
    });

    const remaining = await evidenceRepo.countByReason(reasonId);
    return {
      changed: true,
      reasonId,
      evidenceId,
      remainingEvidenceCount: remaining,
      evidenceStatus: remaining > 0 ? 'HAS_EVIDENCE' : 'NO_EVIDENCE',
      audit: serializeAudit(audit),
    };
  });
}

module.exports = {
  listEvidenceTypes,
  listEvidenceCandidates,
  listEvidencesByReason,
  getEvidenceDetail,
  createEvidence,
  linkEvidence,
  unlinkEvidence,
  serializeEvidence,
};
