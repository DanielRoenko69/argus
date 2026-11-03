import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { requirePermission, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import type { SessionUser } from '../auth/userAuth.js';
import {
  resolveAuthorizedWorkspaceScope,
  type AuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import type { SolutionPackDiscoveryState } from '../solutionPacks/discovery.js';
import {
  WorkflowExecutionStartError,
  type StartWorkflowExecutionInput,
  type StartWorkflowExecutionResult,
} from '../workflows/executeRoutes.js';
import {
  buildGoldenPathPreflight,
  loadGoldenPathDeploymentProfile,
  parseGoldenPathPreflightQuery,
  GoldenPathPreflightValidationError,
  type GoldenPathPreflightQuery,
} from './preflight.js';
import { loadGoldenPathPreflightSnapshot } from './store.js';
import {
  goldenPathRunStartSchema,
  type GoldenPathPreflight,
  type GoldenPathRun,
} from './contracts.js';
import {
  attachGoldenPathExecution,
  claimGoldenPathRun,
  failGoldenPathRun,
  goldenPathStartReceipt,
  goldenPathTriggerEvidence,
  goldenPathWorkflowInputs,
  GoldenPathRunConflictError,
  loadGoldenPathRun,
  reloadGoldenPathRunRow,
  type GoldenPathRunClaim,
} from './runStore.js';

export interface GoldenPathRouteDependencies {
  auditEvidenceEnabled: boolean;
  environment?: NodeJS.ProcessEnv;
  requireSameOrigin: RequestHandler;
  loadPackState: (packId: string) => Promise<{ state: SolutionPackDiscoveryState; version: string | null } | null>;
  loadPreflight?: (
    pool: pg.Pool,
    user: SessionUser,
    query: GoldenPathPreflightQuery,
    scope?: AuthorizedWorkspaceScope,
  ) => Promise<GoldenPathPreflight>;
  resolveScope?: (req: Parameters<RequestHandler>[0], user: SessionUser) => AuthorizedWorkspaceScope;
  claimRun?: (pool: pg.Pool, user: SessionUser, preflight: GoldenPathPreflight, idempotencyKey: string) => Promise<GoldenPathRunClaim>;
  attachExecution?: (pool: pg.Pool, runId: string, executionId: number) => Promise<void>;
  failRun?: (pool: pg.Pool, runId: string, code: string, message: string) => Promise<void>;
  reloadRunRow?: typeof reloadGoldenPathRunRow;
  loadRun?: (pool: pg.Pool, runId: string, scope: GoldenPathPreflight['scope']) => Promise<GoldenPathRun | null>;
  startWorkflow?: (input: StartWorkflowExecutionInput) => Promise<StartWorkflowExecutionResult>;
}

function idempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (key.length < 8 || key.length > 200 || /[^\x21-\x7e]/.test(key)) {
    throw new GoldenPathPreflightValidationError('Idempotency-Key must contain 8-200 visible ASCII characters');
  }
  return key;
}

async function loadPreflight(
  pool: pg.Pool,
  user: SessionUser,
  query: GoldenPathPreflightQuery,
  scope: AuthorizedWorkspaceScope,
  dependencies: GoldenPathRouteDependencies,
): Promise<GoldenPathPreflight> {
  return dependencies.loadPreflight
    ? dependencies.loadPreflight(pool, user, query, scope)
    : buildGoldenPathPreflight(
        await loadGoldenPathPreflightSnapshot(
          pool,
          user,
          query,
          { ...loadGoldenPathDeploymentProfile(query.mode, dependencies.environment), ...scope },
          dependencies,
        ),
        query,
      );
}

export function registerGoldenPathRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  dependencies: GoldenPathRouteDependencies,
): void {
  const resolveScope = dependencies.resolveScope ?? resolveAuthorizedWorkspaceScope;
  app.get('/api/ui/golden-path/v1/preflight', requireAuth, requirePermission('workflows.read'), async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const query = parseGoldenPathPreflightQuery(req.query as Record<string, unknown>);
      const result = await loadPreflight(pool, user, query, resolveScope(req, user), dependencies);
      res.json(result);
    } catch (error) {
      if (error instanceof GoldenPathPreflightValidationError || error instanceof WorkspaceScopeAccessError) {
        res.status(error.status).json({
          error: error.message,
          code: error instanceof WorkspaceScopeAccessError ? error.code : 'GOLDEN_PATH_PREFLIGHT_INVALID',
        });
        return;
      }
      logger.error({ err: error }, 'Golden Path preflight failed');
      res.status(500).json({ error: 'Golden Path preflight could not be loaded', code: 'GOLDEN_PATH_PREFLIGHT_FAILED' });
    }
  });

  app.post(
    '/api/ui/golden-path/v1/runs',
    requireAuth,
    requirePermission('workflows.run'),
    dependencies.requireSameOrigin,
    async (req, res) => {
      let claimedRunId: string | null = null;
      try {
        const parsed = goldenPathRunStartSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: 'Golden Path run request is invalid', code: 'GOLDEN_PATH_RUN_INVALID', issues: parsed.error.issues });
          return;
        }
        const user = (req as AuthenticatedRequest).user!;
        const key = idempotencyKey(req.get('idempotency-key'));
        const query: GoldenPathPreflightQuery = parsed.data;
        const preflight = await loadPreflight(pool, user, query, resolveScope(req, user), dependencies);
        if (preflight.state !== 'ready' || !preflight.allowedActions.includes('start')) {
          res.status(409).json({ error: 'Golden Path preflight is not ready', code: 'GOLDEN_PATH_PREFLIGHT_BLOCKED', preflight });
          return;
        }
        const workflowId = Number(preflight.workflow.id);
        if (!Number.isSafeInteger(workflowId) || workflowId <= 0) {
          res.status(409).json({ error: 'Golden Path workflow binding is invalid', code: 'GOLDEN_PATH_WORKFLOW_INVALID' });
          return;
        }

        const claim = await (dependencies.claimRun ?? claimGoldenPathRun)(pool, user, preflight, key);
        claimedRunId = claim.row.id;
        if (!claim.created) {
          res.status(200).json(goldenPathStartReceipt(claim.row, true));
          return;
        }
        if (!dependencies.startWorkflow) {
          await (dependencies.failRun ?? failGoldenPathRun)(pool, claim.row.id, 'GOLDEN_PATH_EXECUTOR_UNAVAILABLE', 'Golden Path workflow execution is not configured.');
          res.status(503).json({ error: 'Golden Path workflow execution is not configured', code: 'GOLDEN_PATH_EXECUTOR_UNAVAILABLE', runId: claim.row.id });
          return;
        }

        const keySha256 = claim.row.idempotency_key_sha256;
        const started = await dependencies.startWorkflow({
          workflowId,
          scope: preflight.scope,
          inputs: { ...goldenPathWorkflowInputs(preflight, claim.row.id), idempotency_key_sha256: keySha256 },
          mockMode: false,
          user,
          source: 'golden-path',
          triggerEvidence: goldenPathTriggerEvidence(preflight, claim.row.id, keySha256),
        });
        await (dependencies.attachExecution ?? attachGoldenPathExecution)(pool, claim.row.id, started.executionId);
        const row = await (dependencies.reloadRunRow ?? reloadGoldenPathRunRow)(pool, claim.row.id);
        res.status(202).json(goldenPathStartReceipt(row, started.replayed));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof WorkflowExecutionStartError
          ? error.code
          : error instanceof GoldenPathRunConflictError ? error.code : 'GOLDEN_PATH_RUN_START_FAILED';
        const failedExecutionId = error instanceof WorkflowExecutionStartError
          && Number.isSafeInteger(Number(error.details?.['executionId']))
          ? Number(error.details?.['executionId'])
          : null;
        if (claimedRunId && failedExecutionId && failedExecutionId > 0) {
          await (dependencies.attachExecution ?? attachGoldenPathExecution)(pool, claimedRunId, failedExecutionId).catch(failure => {
            logger.error({ err: failure, runId: claimedRunId }, 'Golden Path blocked-execution mapping failed');
          });
        }
        if (claimedRunId && !(error instanceof GoldenPathRunConflictError)) {
          await (dependencies.failRun ?? failGoldenPathRun)(pool, claimedRunId, code, message).catch(failure => {
            logger.error({ err: failure, runId: claimedRunId }, 'Golden Path failed-state persistence failed');
          });
        }
        if (error instanceof GoldenPathPreflightValidationError || error instanceof GoldenPathRunConflictError || error instanceof WorkspaceScopeAccessError) {
          res.status(error.status).json({
            error: message,
            code: error instanceof WorkspaceScopeAccessError
              ? error.code
              : error instanceof GoldenPathRunConflictError ? error.code : 'GOLDEN_PATH_RUN_INVALID',
          });
          return;
        }
        if (error instanceof WorkflowExecutionStartError) {
          res.status(error.status).json({ error: message, code: error.code, runId: claimedRunId, ...error.details });
          return;
        }
        logger.error({ err: error, runId: claimedRunId }, 'Golden Path run start failed');
        res.status(500).json({ error: 'Golden Path run could not be started', code, runId: claimedRunId });
      }
    },
  );

  app.get('/api/ui/golden-path/v1/runs/:runId', requireAuth, requirePermission('workflows.read'), async (req, res) => {
    const runId = String(req.params['runId'] ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      res.status(400).json({ error: 'invalid Golden Path run id', code: 'GOLDEN_PATH_RUN_ID_INVALID' });
      return;
    }
    try {
      const user = (req as AuthenticatedRequest).user!;
      const profile = loadGoldenPathDeploymentProfile('certification', dependencies.environment);
      const result = await (dependencies.loadRun ?? loadGoldenPathRun)(pool, runId, {
        ...resolveScope(req, user),
        environment: profile.environment,
      });
      if (!result) {
        res.status(404).json({ error: 'Golden Path run not found', code: 'GOLDEN_PATH_RUN_NOT_FOUND' });
        return;
      }
      res.json(result);
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      logger.error({ err: error, runId }, 'Golden Path run projection failed');
      res.status(500).json({ error: 'Golden Path run could not be loaded', code: 'GOLDEN_PATH_RUN_LOAD_FAILED' });
    }
  });

  app.post(
    '/api/ui/golden-path/v1/runs/:runId/retry',
    requireAuth,
    requirePermission('workflows.run'),
    dependencies.requireSameOrigin,
    async (req, res) => {
      const runId = String(req.params['runId'] ?? '').trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
        res.status(400).json({ error: 'invalid Golden Path run id', code: 'GOLDEN_PATH_RUN_ID_INVALID' });
        return;
      }
      if (req.body && typeof req.body === 'object' && Object.keys(req.body as Record<string, unknown>).length > 0) {
        res.status(400).json({
          error: 'Golden Path retries always reuse the frozen original inputs',
          code: 'GOLDEN_PATH_RETRY_INPUT_FORBIDDEN',
        });
        return;
      }
      try {
        const user = (req as AuthenticatedRequest).user!;
        const profile = loadGoldenPathDeploymentProfile('certification', dependencies.environment);
        const run = await (dependencies.loadRun ?? loadGoldenPathRun)(pool, runId, {
          ...resolveScope(req, user),
          environment: profile.environment,
        });
        if (!run) {
          res.status(404).json({ error: 'Golden Path run not found', code: 'GOLDEN_PATH_RUN_NOT_FOUND' });
          return;
        }
        if (run.status !== 'failed' || !run.allowedActions.includes('retry')) {
          res.status(409).json({
            error: `Golden Path run '${runId}' is not retryable in status '${run.status}'`,
            code: 'GOLDEN_PATH_RETRY_NOT_ALLOWED',
          });
          return;
        }
        const workflowId = Number(run.workflow.id);
        const executionId = Number(run.correlation.runId);
        if (!Number.isSafeInteger(workflowId) || workflowId <= 0 || !Number.isSafeInteger(executionId) || executionId <= 0) {
          res.status(409).json({ error: 'Golden Path retry lineage is incomplete', code: 'GOLDEN_PATH_RETRY_LINEAGE_INVALID' });
          return;
        }
        const location = `/api/workflows/${workflowId}/runs/${executionId}/retry`;
        res.status(307).setHeader('Location', location).json({
          runId,
          retryOfExecutionId: executionId,
          frozenInputs: true,
          location,
        });
      } catch (error) {
        if (error instanceof WorkspaceScopeAccessError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        logger.error({ err: error, runId }, 'Golden Path retry handoff failed');
        res.status(500).json({ error: 'Golden Path retry could not be prepared', code: 'GOLDEN_PATH_RETRY_FAILED' });
      }
    },
  );
}
