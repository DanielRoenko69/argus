import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import { resolveAuthorizedWorkspaceScope, WorkspaceScopeAccessError } from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import { GlobalSearchInputError, normalizeGlobalSearchInput, searchWorkspaceResources } from './globalSearch.js';

export function registerGlobalSearchRoutes(app: Express, pool: pg.Pool, requireAuth: RequestHandler): void {
  app.get('/api/ui/search/v1', requireAuth, async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' });
      return;
    }
    if (!evaluatePermission({ role: user.role }, 'workspace.search').allowed) {
      res.status(403).json({ error: 'Workspace search is not permitted', code: 'WORKSPACE_SEARCH_FORBIDDEN' });
      return;
    }

    try {
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const input = normalizeGlobalSearchInput(req.query['q'], req.query['limit']);
      res.set('Cache-Control', 'private, no-store');
      res.json(await searchWorkspaceResources(pool, user, scope, input));
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof GlobalSearchInputError) {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      logger.error({ err: error, userId: user.id }, 'Workspace resource search failed');
      res.status(500).json({ error: 'Workspace search is temporarily unavailable', code: 'WORKSPACE_SEARCH_UNAVAILABLE' });
    }
  });
}
