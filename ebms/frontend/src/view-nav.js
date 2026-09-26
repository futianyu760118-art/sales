// F11（PAND-89）四视图对象交叉跳转：纯逻辑层，不依赖 DOM，可直接单测。
// 类型口径（REPORT/TODO/Decision/Evidence）与置灰判定均以后端返回为准，
// 前端不自行维护类型清单，避免与后端枚举漂移。

/** 边界文案：无关联对象的目标入口置灰时展示。 */
export const NO_LINK_HINT = '无关联';

/** 无关联对象的默认落地页（进入任一视图时的初始对象）。 */
export function toNavEntry(target) {
  const count = Number(target?.count ?? 0);
  // 置灰以后端 disabled 为准，并用 count 兜底（无关联必然置灰）。
  const disabled = Boolean(target?.disabled) || count === 0;
  return {
    targetType: target?.targetType,
    label: target?.label ?? target?.targetType ?? '',
    fullLabel: target?.fullLabel ?? target?.label ?? '',
    landingPath: target?.landingPath ?? `/${target?.targetType ?? ''}`,
    count,
    disabled,
    hint: disabled ? NO_LINK_HINT : null,
    links: (target?.entries ?? []).map((e) => ({
      id: e.id,
      code: e.code ?? '',
      title: e.title ?? '',
      badge: e.badge ?? '',
      subtitle: e.subtitle ?? '',
      href: e.landingHref ?? `/${target.targetType}/${e.id}`,
    })),
  };
}

/** 后端 GET /objects/{type}/{id}/links 载荷 → 导航栏渲染模型。 */
export function buildNavModel(nav) {
  return {
    object: nav?.object ?? null,
    total: Number(nav?.total ?? 0),
    entries: (nav?.targets ?? []).map(toNavEntry),
  };
}

/** 入口可点击的前提：有关联对象（否则置灰）。 */
export function isNavigable(entry) {
  return Boolean(entry) && !entry.disabled && entry.links.length > 0;
}

/** 入口提示文案：有且仅有「无关联」一种置灰原因。 */
export function hintOf(entry) {
  return isNavigable(entry) ? null : NO_LINK_HINT;
}

/** 视图地址（后端下发的 landingHref）→ 应用内 hash 路由。 */
export function hashFor(landingHref) {
  return `#${landingHref}`;
}

/**
 * 解析 hash 为 { type, id }。
 * 仅识别形状；type 是否合法由后端 /objects/:type/:id 判定（非法即 4xx 提示）。
 */
export function parseHash(hash) {
  const match = String(hash ?? '')
    .replace(/^#/, '')
    .replace(/\/+$/, '')
    .match(/^\/([a-z][a-z_]*)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/);
  return match ? { type: match[1], id: match[2] } : null;
}
