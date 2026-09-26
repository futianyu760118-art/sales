/**
 * M03 EBMS 主体功能入口 —— 默认落地视图与可见指标范围。
 *
 * 身份 / 角色 / 权限 / 数据范围全部消费 M01 Kernel（只读）。
 * 红线：本路由不提供任何角色 / 权限 / 数据范围的配置入口或存储；
 *       M01 Kernel 不可用时拒绝加载并明确提示，不回落到本地配置。
 */
const express = require('express');
const router = express.Router();
const { extractUserId } = require('../auth-middleware');
const kernelClient = require('../lib/kernel-client');
const viewLayer = require('../lib/m03/view-layer');
const metricCatalog = require('../lib/m03/metric-catalog');

/**
 * 解析 EBMS 入口状态（身份 → 视图层 → 数据范围 → 可见指标）。
 * @returns {{status:number, body:object}}
 */
function resolveEntry(req) {
  const userId = extractUserId(req);
  if (!userId) return { status: 401, body: { error: '未登录或会话已过期', code: 'UNAUTHORIZED' } };

  // 1) M01 Kernel 可用性 —— 不可用即拒绝加载，不做任何本地兜底
  const health = kernelClient.health();
  if (!health.available) {
    return {
      status: 503,
      body: {
        code: 'M01_KERNEL_UNAVAILABLE',
        gate: { allowed: false, reason: 'M01_KERNEL_UNAVAILABLE' },
        error: 'M01 Kernel 不可用，已拒绝加载 EBMS 主体功能（不回落到 EBMS 本地角色 / 权限 / 数据范围配置）',
        kernel: health
      }
    };
  }

  let identity;
  let scope;
  try {
    identity = kernelClient.getIdentity(userId);
    scope = kernelClient.resolveDataScope(userId);
  } catch (e) {
    return {
      status: 503,
      body: {
        code: 'M01_KERNEL_UNAVAILABLE',
        gate: { allowed: false, reason: 'M01_KERNEL_UNAVAILABLE' },
        error: 'M01 Kernel 不可用，已拒绝加载 EBMS 主体功能（不回落到 EBMS 本地配置）',
        kernel: { available: false, version: kernelClient.health().version, reason: e.message }
      }
    };
  }

  // 2) Kernel 中无身份
  if (!identity) {
    return {
      status: 403,
      body: {
        code: 'NO_KERNEL_IDENTITY',
        gate: { allowed: false, reason: 'NO_KERNEL_IDENTITY' },
        error: 'M01 Kernel 中不存在该用户，无法进入 EBMS 主体功能'
      }
    };
  }

  // 3) Kernel 中无角色
  if (!identity.role_codes.length) {
    return {
      status: 403,
      body: {
        code: 'NO_KERNEL_ROLE',
        gate: { allowed: false, reason: 'NO_KERNEL_ROLE' },
        error: '您在 M01 Kernel 中尚未分配任何角色，无法进入 EBMS 主体功能；请联系管理员在 M01 Kernel 中配置角色与数据范围'
      }
    };
  }

  // 4) 未被授权访问 EBMS
  const resolved = viewLayer.resolveViewLayer(identity);
  if (!resolved.authorized) {
    return {
      status: 403,
      body: {
        code: 'NO_EBMS_ACCESS',
        gate: { allowed: false, reason: 'NO_EBMS_ACCESS' },
        error: '当前 Kernel 角色未被授权访问 EBMS 主体功能，请联系管理员授予 M03 进入权限',
        identity: { user_id: identity.user_id, role_codes: identity.role_codes }
      }
    };
  }

  // 5) 可见指标范围由 M01 Kernel 的 data-scope 决定
  const metrics = metricCatalog.visibleMetrics(scope);

  return {
    status: 200,
    body: {
      kernel: { available: true, version: health.version, source: 'M01_KERNEL' },
      gate: { allowed: true, reason: 'OK' },
      identity: {
        user_id: identity.user_id,
        username: identity.username,
        name: identity.name,
        role_codes: identity.role_codes,
        is_admin: identity.is_admin
      },
      view_layer: { concepts: resolved.concepts, landing: resolved.landing },
      data_scope: scope,
      metrics
    }
  };
}

// EBMS 主体功能入口：默认落地视图 + 可见范围
router.get('/entry', (req, res) => {
  const { status, body } = resolveEntry(req);
  res.status(status).json(body);
});

// 默认落地视图（供登录后跳转使用；未授权时前端据此提示）
router.get('/landing', (req, res) => {
  const { status, body } = resolveEntry(req);
  if (status !== 200) return res.status(status).json(body);
  res.json({
    gate: body.gate,
    landing: body.view_layer.landing,
    concepts: body.view_layer.concepts
  });
});

// 当前用户名下可见的指标范围（可见性元数据，不含指标数值）
router.get('/metrics', (req, res) => {
  const { status, body } = resolveEntry(req);
  if (status !== 200) return res.status(status).json(body);
  res.json(body.metrics);
});

// 视图层配置（经营角色概念 → 默认落地视图）；声明其映射目标为 M01 Kernel 权限码
router.get('/view-layer', (req, res) => {
  res.json({
    source: 'M03_VIEW_LAYER',
    note: '经营角色概念仅为 M03 视图层映射，角色 / 权限 / 数据范围一律以 M01 Kernel 为准',
    permissions_owner: 'M01_KERNEL',
    entry_permission: viewLayer.ENTRY_PERMISSION,
    concepts: viewLayer.VIEW_CONCEPTS,
    views: viewLayer.VIEWS
  });
});

module.exports = router;
