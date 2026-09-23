const express = require('express');
const { createClosureService, AeosError } = require('../aeos/closure-service');
const { createContext } = require('../aeos/context');
const { extractUserId, getUserPermissions } = require('../auth-middleware');

function defaultAuthorize(permission) {
  return (req, res, next) => {
    const userId = extractUserId(req);
    const traceId = req.aeosContext.traceId;
    if (!userId) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '未登录或会话已过期' }, trace_id: traceId });
    const { isAdmin, perms } = getUserPermissions(userId);
    if (!isAdmin && (!perms || !perms.has(permission))) {
      return res.status(403).json({ error: { code: 'PERMISSION_DENIED', message: '无权限：' + permission }, trace_id: traceId });
    }
    req.user = { id: userId };
    req.aeosContext = createContext(req);
    next();
  };
}

function createAeosManagementRouter({ service = createClosureService(), authorize = defaultAuthorize } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { req.aeosContext = createContext(req); next(); });

  const run = operation => async (req, res) => {
    const context = req.aeosContext;
    try {
      const data = await operation(req, context);
      const status = data && data._created === true ? 201 : 200;
      res.status(status).json({ data, trace_id: context.traceId });
    } catch (caught) {
      if (caught instanceof AeosError || (caught && caught.code && caught.httpStatus)) {
        return res.status(caught.httpStatus || 400).json({
          error: { code: caught.code, message: caught.message, details: caught.details || [] },
          trace_id: context.traceId
        });
      }
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' }, trace_id: context.traceId });
    }
  };

  router.post('/decisions', authorize('annual-plan:edit'), run((req, context) => service.createDecision(req.body, context)));
  router.post('/actions', authorize('annual-plan:edit'), run((req, context) => service.createAction(req.body, context)));
  router.post('/actions/:id/complete', authorize('annual-plan:edit'), run((req, context) => service.completeAction(req.params.id, req.body, context)));
  router.post('/results/:id/evidence', authorize('annual-plan:edit'), run((req, context) => service.attachEvidence(req.params.id, req.body, context)));
  router.post('/results/:id/verify', authorize('annual-plan:analyze'), run((req, context) => service.verifyResult(req.params.id, context)));
  router.get('/closures/:decisionId', authorize('annual-plan:view'), run((req, context) => service.getClosure(req.params.decisionId, context)));
  return router;
}

module.exports = createAeosManagementRouter();
module.exports.createAeosManagementRouter = createAeosManagementRouter;
