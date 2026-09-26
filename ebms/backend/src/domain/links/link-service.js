'use strict';

const { withTransaction } = require('../../db/pool');
const linkRepo = require('./link-repository');
const viewRepo = require('../views/view-object-repository');
const auditRepo = require('../audit/audit-repository');
const {
  VIEW_OBJECT_TYPE_CODES,
  isValidViewObjectType,
  otherViewObjectTypes,
  landingHref,
} = require('../views/view-object-types');
const { badRequest, notFound, conflict } = require('../../http/errors');

// AC 边界固定文案：无关联对象时入口置灰并提示「无关联」。
const NO_LINK_HINT = '无关联';
const RELATION_TYPES = Object.freeze(['related', 'derived_from', 'evidences', 'executes']);

function assertViewObjectType(type, field) {
  if (!isValidViewObjectType(type)) {
    throw badRequest('VIEW_OBJECT_TYPE_INVALID', `非法的视图对象类型：${field}`, {
      field,
      allowed: VIEW_OBJECT_TYPE_CODES,
    });
  }
}

function assertRelationType(relationType) {
  if (!RELATION_TYPES.includes(relationType)) {
    throw badRequest('VIEW_LINK_RELATION_INVALID', `非法的关联语义：${relationType}`, {
      allowed: RELATION_TYPES,
    });
  }
}

async function requireObject(type, id) {
  const object = await viewRepo.findByTypeAndId(type, id);
  if (!object) {
    throw notFound('VIEW_OBJECT_NOT_FOUND', `${type} 对象不存在：${id}`);
  }
  return object;
}

/**
 * 交叉跳转导航入口 —— PAND-89 的核心读模型。
 *
 * 返回当前对象 + 其余三类视图的入口，每个入口自带：
 *   count / disabled / hint —— 无关联时 disabled=true 且 hint='无关联'（AC 边界）；
 *   entries                —— 有关联的目标对象，含 landingHref（AC「跳转落点正确」）。
 */
async function getNavigation({ type, id }) {
  assertViewObjectType(type, 'type');
  const object = await requireObject(type, id);

  const targets = [];
  for (const targetType of otherViewObjectTypes(type)) {
    const neighbours = await linkRepo.listNeighborsByType(type, id, targetType.code);
    const objects = await viewRepo.findByTypeAndIds(
      targetType.code,
      neighbours.map((n) => n.otherId)
    );
    const relationByObjectId = new Map(neighbours.map((n) => [n.otherId, n.relationType]));
    const entries = objects.map((o) => ({
      ...o,
      relationType: relationByObjectId.get(o.id) || 'related',
    }));
    const disabled = entries.length === 0;
    targets.push({
      targetType: targetType.code,
      label: targetType.label,
      fullLabel: targetType.fullLabel,
      landingPath: targetType.landingPath,
      count: entries.length,
      disabled,
      hint: disabled ? NO_LINK_HINT : null,
      entries,
    });
  }

  return {
    object,
    targets,
    total: targets.reduce((sum, t) => sum + t.count, 0),
  };
}

/** 某对象到指定类型（缺省=全部三类）的关联对象清单。 */
async function listLinks({ type, id, targetType }) {
  await getNavigation({ type, id }); // 复用存在性校验
  if (targetType !== undefined) assertViewObjectType(targetType, 'target_type');

  const neighbours = await linkRepo.listNeighbors(type, id);
  const scoped = targetType
    ? neighbours.filter((n) => n.otherType === targetType)
    : neighbours;

  const byType = new Map();
  for (const n of scoped) {
    if (!byType.has(n.otherType)) byType.set(n.otherType, []);
    byType.get(n.otherType).push(n);
  }

  const links = [];
  for (const [otherType, items] of byType) {
    const objects = await viewRepo.findByTypeAndIds(
      otherType,
      items.map((i) => i.otherId)
    );
    const metaById = new Map(items.map((i) => [i.otherId, i]));
    for (const object of objects) {
      const meta = metaById.get(object.id);
      links.push({
        type: otherType,
        typeLabel: object.typeLabel,
        id: object.id,
        object,
        relationType: meta.relationType,
        createdBy: meta.createdBy,
        createdAt: meta.createdAt,
        // 落点：前端据此路由，AC「有关联时跳转落点正确」的判定字段
        landingHref: landingHref(otherType, object.id),
      });
    }
  }
  return links;
}

/** 建立关联（幂等）；写数据与留痕同事务提交。 */
async function createLink(actor, { fromType, fromId, toType, toId, relationType = 'related' }) {
  assertViewObjectType(fromType, 'fromType');
  assertViewObjectType(toType, 'toType');
  assertRelationType(relationType);

  if (fromType === toType && fromId === toId) {
    throw badRequest('VIEW_LINK_SELF_FORBIDDEN', '不能把对象关联到自身');
  }

  const fromObject = await requireObject(fromType, fromId);
  const toObject = await requireObject(toType, toId);

  const result = await withTransaction(async (client) => {
    const { link, created } = await linkRepo.insert(client, {
      fromType,
      fromId,
      toType,
      toId,
      relationType,
      createdBy: actor.id,
    });
    // 幂等命中不重复记账，保证留痕条数 = 实际变更次数
    if (created) {
      await auditRepo.record(client, {
        actor: actor.id,
        actorName: actor.displayName || actor.username || actor.id,
        action: 'view_link.create',
        entityType: 'object_link',
        entityId: String(link.id),
        before: null,
        after: { fromType, fromId, toType, toId, relationType },
      });
    }
    return { link, created };
  });

  return {
    created: result.created,
    link: {
      id: result.link.id,
      fromType: result.link.from_type,
      fromId: result.link.from_id,
      toType: result.link.to_type,
      toId: result.link.to_id,
      relationType: result.link.relation_type,
      createdBy: result.link.created_by,
      createdAt: result.link.created_at,
    },
    from: fromObject,
    to: toObject,
    landingHref: landingHref(toType, toId),
  };
}

/** 解除关联；写数据与留痕同事务提交。未关联时返回 409（与 F3 解除关联口径一致）。 */
async function removeLink(actor, { fromType, fromId, toType, toId }) {
  assertViewObjectType(fromType, 'fromType');
  assertViewObjectType(toType, 'toType');
  await requireObject(fromType, fromId);

  const removed = await withTransaction(async (client) => {
    const link = await linkRepo.remove(client, { fromType, fromId, toType, toId });
    if (!link) return null;
    await auditRepo.record(client, {
      actor: actor.id,
      actorName: actor.displayName || actor.username || actor.id,
      action: 'view_link.delete',
      entityType: 'object_link',
      entityId: String(link.id),
      before: {
        fromType: link.from_type,
        fromId: link.from_id,
        toType: link.to_type,
        toId: link.to_id,
        relationType: link.relation_type,
      },
      after: null,
    });
    return link;
  });

  if (!removed) {
    throw conflict('VIEW_LINK_NOT_FOUND', '关联不存在或已解除');
  }
  return {
    id: removed.id,
    fromType: removed.from_type,
    fromId: removed.from_id,
    toType: removed.to_type,
    toId: removed.to_id,
  };
}

module.exports = {
  NO_LINK_HINT,
  RELATION_TYPES,
  getNavigation,
  listLinks,
  createLink,
  removeLink,
};
