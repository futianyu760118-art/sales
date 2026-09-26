'use strict';

const express = require('express');
const linkService = require('../../domain/links/link-service');
const viewRepo = require('../../domain/views/view-object-repository');
const {
  isValidViewObjectType,
  listViewObjectTypes,
} = require('../../domain/views/view-object-types');
const { requireActor } = require('../middleware/actor');
const { badRequest, notFound } = require('../errors');

const router = express.Router();

function assertTypeOrThrow(type) {
  if (!isValidViewObjectType(type)) {
    throw badRequest('VIEW_OBJECT_TYPE_INVALID', `非法的视图对象类型：${type}`, {
      allowed: listViewObjectTypes().map((t) => t.code),
    });
  }
}

// 四视图类型清单（前端入口渲染的唯一取值来源）
router.get('/view-object-types', (_req, res) => {
  res.json({ ok: true, data: listViewObjectTypes() });
});

// 某类视图的对象清单（进入交叉跳转的起点选择器）
router.get('/objects/:type', async (req, res, next) => {
  try {
    assertTypeOrThrow(req.params.type);
    const data = await viewRepo.listByType(req.params.type, { limit: req.query.limit });
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// 对象解析 —— 交叉跳转的「落点」：按 (type,id) 返回该对象的可读身份与所属视图
router.get('/objects/:type/:id', async (req, res, next) => {
  try {
    assertTypeOrThrow(req.params.type);
    const object = await viewRepo.findByTypeAndId(req.params.type, req.params.id);
    if (!object) {
      return next(
        notFound('VIEW_OBJECT_NOT_FOUND', `对象不存在：${req.params.type}/${req.params.id}`)
      );
    }
    return res.json({ ok: true, data: object });
  } catch (err) {
    return next(err);
  }
});

// ===== F11 交叉跳转核心契约（PAND-77 架构方案 §3.2.2）=====
// GET /api/v1/objects/{type}/{id}/links?target_type=
// 返回其余三类视图的跳转入口：有关联→可跳转（entries 含 landingHref）；
// 无关联→入口置灰（disabled=true）并提示「无关联」。
router.get('/objects/:type/:id/links', async (req, res, next) => {
  try {
    if (req.query.target_type !== undefined && req.query.target_type !== '') {
      const data = await linkService.listLinks({
        type: req.params.type,
        id: req.params.id,
        targetType: req.query.target_type,
      });
      return res.json({ ok: true, data });
    }
    const data = await linkService.getNavigation({ type: req.params.type, id: req.params.id });
    return res.json({ ok: true, data });
  } catch (err) {
    return next(err);
  }
});

// 建立关联（幂等）
router.post('/objects/:type/:id/links', requireActor, async (req, res, next) => {
  try {
    const targetType = req.body?.targetType;
    const targetId = req.body?.targetId;
    if (typeof targetType !== 'string' || typeof targetId !== 'string') {
      return next(badRequest('VIEW_LINK_TARGET_REQUIRED', 'targetType 与 targetId 均为必填'));
    }
    const result = await linkService.createLink(req.actor, {
      fromType: req.params.type,
      fromId: req.params.id,
      toType: targetType,
      toId: targetId,
      relationType: req.body?.relationType,
    });
    return res.status(result.created ? 201 : 200).json({ ok: true, data: result });
  } catch (err) {
    return next(err);
  }
});

// 解除关联
router.delete('/objects/:type/:id/links/:targetType/:targetId', requireActor, async (req, res, next) => {
  try {
    const data = await linkService.removeLink(req.actor, {
      fromType: req.params.type,
      fromId: req.params.id,
      toType: req.params.targetType,
      toId: req.params.targetId,
    });
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
