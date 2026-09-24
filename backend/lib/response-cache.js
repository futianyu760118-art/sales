// Short-lived cache for read-only aggregate endpoints.
// It removes duplicate dashboard reads without changing business data writes.
function responseCache(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 3000;
  const maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : 32;
  const cache = new Map();
  const makeKey = options.key || ((req) => req.originalUrl || req.url);

  function prune(now) {
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  const middleware = (req, res, next) => {
    const now = Date.now();
    prune(now);
    const key = String(makeKey(req));
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      res.setHeader('X-EBMS-Cache', 'HIT');
      return res.json(hit.body);
    }

    res.setHeader('X-EBMS-Cache', 'MISS');
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      cache.set(key, { body, expiresAt: Date.now() + ttlMs });
      prune(Date.now());
      res.setHeader('X-EBMS-Cache', 'MISS');
      return originalJson(body);
    };
    next();
  };
  // 主动失效：写操作后调用，避免 TTL 窗口内读到旧数据
  middleware.clear = () => cache.clear();
  return middleware;
}

module.exports = { responseCache };
