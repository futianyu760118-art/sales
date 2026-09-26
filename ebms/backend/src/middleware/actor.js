/**
 * 操作人解析中间件。
 *
 * 身份、角色与可见范围一律消费 M01 Kernel（PAND-93 红线：EBMS 不自建第二套
 * 身份/权限体系）。本中间件只把 Kernel 下发的操作人标识落到 req.actor，
 * 不做任何角色判定、不维护任何本地用户/权限表。
 */

export function createActorMiddleware() {
  return function actor(req, res, next) {
    const id = req.get('x-actor-id');
    req.actor = { id: id && id.trim() ? id.trim() : 'anonymous', identityProvider: 'M01-Kernel' };
    next();
  };
}
