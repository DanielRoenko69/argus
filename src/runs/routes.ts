import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import type { ActiveSession } from '../agents/activeSessions.js';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import type { SessionUser } from '../auth/userAuth.js';
import {
  resolveAuthorizedWorkspaceScope,
  type AuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import { buildRunPageV2 } from './readModel.js';
import { loadActiveRunSources, loadTelemetryRunSources, loadWorkflowRunSources } from './store.js';
import type { RunSourceRecord } from './types.js';
import { parseRunReadModelQuery, RunReadModelValidationError } from './validation.js';

export interface RunReadModelLoaders {
  workflows(
    pool: pg.Pool,
    user: SessionUser,
    observeAll: boolean,
    scope: AuthorizedWorkspaceScope,
    hours: number,
    now: Date,
  ): Promise<RunSourceRecord[]>;
  telemetry(
    pool: pg.Pool,
    user: SessionUser,
    observeAll: boolean,
    scope: AuthorizedWorkspaceScope,
    hours: number,
    now: Date,
  ): Promise<{
    records: RunSourceRecord[];
    sessionIds: Set<string>;
  }>;
  active(
    pool: pg.Pool,
    user: SessionUser,
    observeAll: boolean,
    sessions: ActiveSession[],
    persistedSessionIds: Set<string>,
    scope: AuthorizedWorkspaceScope,
    now: Date,
  ): Promise<RunSourceRecord[]>;
}

const defaultLoaders: RunReadModelLoaders = {
  workflows: loadWorkflowRunSources,
  telemetry: loadTelemetryRunSources,
  active: loadActiveRunSources,
};

export function registerRunReadModelRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  listActiveSessions: () => ActiveSession[],
  loaders: RunReadModelLoaders = defaultLoaders,
): void {
  app.get('/api/ui/runs/v2', requireAuth, requirePermission('runs.read_own'), async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      const query = parseRunReadModelQuery(req.query as Record<string, unknown>);
      const observeAll = evaluatePermission({ role: user.role }, 'runs.read_all').allowed;
      const now = new Date();
      const [workflows, telemetry] = await Promise.all([
        loaders.workflows(pool, user, observeAll, scope, query.hours, now),
        loaders.telemetry(pool, user, observeAll, scope, query.hours, now),
      ]);
      const active = await loaders.active(
        pool,
        user,
        observeAll,
        listActiveSessions(),
        telemetry.sessionIds,
        scope,
        now,
      );
      res.json(buildRunPageV2(
        [...workflows, ...telemetry.records, ...active],
        query,
        {
          canRunAgents: evaluatePermission({ role: user.role }, 'agents.run').allowed,
          canRunWorkflows: evaluatePermission({ role: user.role }, 'workflows.run').allowed,
          canReviewApprovals: evaluatePermission({ role: user.role }, 'approvals.review').allowed,
        },
        now,
      ));
    } catch (error) {
      if (error instanceof RunReadModelValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      logger.error({ err: error }, 'Run read model v2 request failed');
      res.status(500).json({ error: 'Runs konnten nicht geladen werden' });
    }
  });
}
