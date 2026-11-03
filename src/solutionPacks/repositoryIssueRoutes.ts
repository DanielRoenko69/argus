import { randomUUID } from 'node:crypto';
import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import type { Config } from '../config/env.js';
import { requirePermission, requireSameOrigin, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import type { ExecutionGrantRequestState } from '../auth/executionGrantMiddleware.js';
import { loadRepositoryIssue } from './repositoryIssueService.js';
import { RepositoryIssueError } from './repositoryIssue.js';
import { startTelemetryTrace, finishTelemetryTrace } from '../observability/telemetryStore.js';

export function registerRepositoryIssueRoutes(app: Express, pool: pg.Pool, config: Config,
  requireAuth: RequestHandler, requireAuthOrApiKey: RequestHandler, load = loadRepositoryIssue) {
  const handler = (preview: boolean): RequestHandler => async (req, res) => {
    let previewTrace: ReturnType<typeof startTelemetryTrace> | undefined;
    try {
      const body = req.body ?? {};
      const keys = preview ? ['reference', 'bundleIds'] : ['reference', 'expectedSha256'];
      if (Object.keys(body).some(key => !keys.includes(key)) || typeof body.reference !== 'string'
        || !body.reference.trim() || body.reference.length > 512) {
        throw new RepositoryIssueError(400, 'Supply an issue URL/number and only the documented fields.');
      }
      const state = req as typeof req & ExecutionGrantRequestState;
      const user = (req as AuthenticatedRequest).user;
      let bundleIds: number[];
      let userId: number | undefined;
      let rootTraceId: string;
      if (preview) {
        if (!Array.isArray(body.bundleIds) || body.bundleIds.length < 1 || body.bundleIds.length > 32
          || body.bundleIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) < 1)) {
          throw new RepositoryIssueError(400, 'Select 1–32 execution bundles.');
        }
        bundleIds = [...new Set<number>(body.bundleIds)];
        if (!user || (user.allowed_bundles != null && bundleIds.some(id => !user.allowed_bundles!.includes(id)))) {
          throw new RepositoryIssueError(403, 'Selected bundles are not authorized for this user.');
        }
        userId = user.id;
        rootTraceId = randomUUID();
        previewTrace = startTelemetryTrace({ id: rootTraceId, name: 'Argus.Dev issue preview', kind: 'workflow', userId,
          metadata: { bundleIds, source: 'repository_issue_preview' } });
      } else {
        const grant = state.executionGrant;
        if (!grant?.workspaceRoot || !grant.coreAgentIds?.includes(Number(req.params.id))) {
          throw new RepositoryIssueError(403, 'A workspace-bound execution grant for this agent is required.');
        }
        if (typeof body.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedSha256)) {
          throw new RepositoryIssueError(400, 'Load and review the issue before starting.');
        }
        bundleIds = grant.bundleIds;
        userId = state.callingUser?.id;
        rootTraceId = grant.rootTraceId;
      }
      const snapshot = await load(pool, config, { bundleIds, reference: body.reference, rootTraceId, userId,
        userGroups: preview ? user?.entra_groups : state.callingUser?.entra_groups,
        ...(!preview ? { allowedTools: state.allowedTools ?? [], expectedSha256: body.expectedSha256 } : {}) });
      res.setHeader('Cache-Control', 'private, no-store');
      if (previewTrace) finishTelemetryTrace(previewTrace, { status: 'completed', output: { sha256: snapshot.sha256, number: snapshot.number } });
      res.json({ snapshot });
    } catch (error) {
      if (previewTrace) finishTelemetryTrace(previewTrace, { status: 'failed', error: 'repository_issue_preview_failed' });
      res.status(error instanceof RepositoryIssueError ? error.status : 502).json({ code: 'repository_issue_unavailable',
        error: error instanceof RepositoryIssueError ? error.message : 'Repository issue read failed. Check the selected Gitea connection and read-tool policy.' });
    }
  };
  app.post('/api/coding/repository-issue', requireAuth, requireSameOrigin, requirePermission('workflows.run'), handler(true));
  app.post('/api/agents/:id/repository-issue', requireAuthOrApiKey, handler(false));
}
