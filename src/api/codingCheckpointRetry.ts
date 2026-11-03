import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { requireAuth, requirePermission, requireSameOrigin, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { resolveAuthorizedWorkspaceScope } from '../auth/workspaceScope.js';
import { verifyExecutionGrant, ExecutionGrantError, type ExecutionGrantIssuer } from '../solutionPacks/executionGrant.js';
import { LANGGRAPH_URL, WORKSPACE_SECRET } from '../config/env.js';
import { writeAdminAudit } from '../lib/adminAudit.js';

type Context = { threadId: string; executionGrant?: string; metadata: Record<string, unknown>;
  available: boolean; reason?: string; node?: string; checkpointId?: string; workspaceDigest?: string;
  reviewDigest?: string; sourceTraceId?: string; testPlan?: string; repairCount?: number;
  retryKind?: 'format' | 'missing_reviews'; missingDecisionIds?: string[] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Historical signature/provenance only; NEVER valid authorization for execution.
 * The route separately checks revocation, ownership and current policy and mints
 * a fresh grant. Ordinary grant verification remains expiry-strict everywhere. */
export function checkpointGrantProvenance(secret: string, token: string) {
  let issuedAt: unknown;
  try { issuedAt = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())['iat']; } catch { /* rejected below */ }
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt > Date.now() / 1000) {
    throw new ExecutionGrantError(403, 'checkpoint_provenance_invalid', 'Historical execution provenance is unavailable.');
  }
  return verifyExecutionGrant(secret, token, { packId: 'argus.dev', agentId: 'coding-orchestrator', executionSurface: 'agent' }, issuedAt * 1000);
}

export function checkpointRetryBody(body: unknown): { checkpointId: string; workspaceDigest: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ExecutionGrantError(400, 'invalid_checkpoint_retry', 'Reload retry options.');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'checkpointId,workspaceDigest'
    || typeof input['checkpointId'] !== 'string' || !uuid.test(input['checkpointId'])
    || typeof input['workspaceDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(input['workspaceDigest'])) {
    throw new ExecutionGrantError(400, 'invalid_checkpoint_retry', 'Continuation accepts only the reviewed checkpoint and workspace fingerprint; use a new attempt for changed inputs.');
  }
  return input as { checkpointId: string; workspaceDigest: string };
}

export function qaResponseRecheckBody(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ExecutionGrantError(400, 'invalid_qa_recheck', 'Recheck the saved QA response first.');
  const { reviewDigest, ...checkpoint } = body as Record<string, unknown>;
  if (typeof reviewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(reviewDigest)) throw new ExecutionGrantError(400, 'invalid_qa_recheck', 'The reviewed QA response fingerprint is required.');
  return { ...checkpointRetryBody(checkpoint), reviewDigest };
}

export function createCodingQaResponseRecheckRouter(pool: pg.Pool, issuer: ExecutionGrantIssuer, secret: string,
  fetchFn: typeof fetch = fetch): Router {
  return createCodingCheckpointRetryRouter(pool, issuer, secret, fetchFn, 'qa-response-recheck');
}

export function createCodingCheckpointRetryRouter(pool: pg.Pool, issuer: ExecutionGrantIssuer, secret: string,
  fetchFn: typeof fetch = fetch, action: 'checkpoint-retry' | 'qa-response-recheck' | 'qa-retry' = 'checkpoint-retry'): Router {
  const qaRecheck = action !== 'checkpoint-retry';
  const qaRetry = action === 'qa-retry';
  const router = Router();
  const pack = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetchFn(`${LANGGRAPH_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new ExecutionGrantError(response.status === 409 ? 409 : 502, 'checkpoint_retry_unavailable', 'Checkpoint continuation was not accepted. Reload retry options to inspect the current state.');
    return response.json() as Promise<T>;
  };
  for (const method of ['get', 'post'] as const) router[method](`/threads/:id/${action}`,
    requireAuth, requirePermission('workflows.run'),
    ...(method === 'post' ? [requireSameOrigin] : []), async (req, res) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const id = String(req.params['id']);
        if (!uuid.test(id)) throw new ExecutionGrantError(400, 'invalid_thread_id', 'Invalid workflow ID.');
        const selected = method === 'post' ? (qaRecheck ? qaResponseRecheckBody(req.body) : checkpointRetryBody(req.body)) : null;
        const scope = resolveAuthorizedWorkspaceScope(req, user);
        const context = await pack<Context>(`/threads/${id}/${action}`);
        const claims = checkpointGrantProvenance(secret, context.executionGrant ?? '');
        if (context.threadId !== id || claims.rootTraceId !== id || claims.principalKind !== 'user' || claims.principalId !== String(user.id)
          || context.metadata['execution_principal'] !== `user:${user.id}`
          || (claims.tenantKey ?? 'default') !== scope.tenantKey || (claims.workspaceKey ?? 'default') !== scope.workspaceKey) {
          throw new ExecutionGrantError(404, 'checkpoint_not_found', 'Workflow continuation was not found.');
        }
        const stored = await pool.query(`SELECT status FROM argus_execution_grants WHERE grant_id=$1 AND principal_kind='user'
          AND principal_id=$2 AND root_trace_id=$3 AND tenant_key=$4 AND workspace_key=$5`, [claims.jti, String(user.id), id, scope.tenantKey, scope.workspaceKey]);
        if (stored.rows[0]?.status !== 'active' || context.metadata['execution_grant_id'] !== claims.jti) {
          throw new ExecutionGrantError(403, 'checkpoint_grant_revoked', 'Original execution authority was revoked or cannot be verified.');
        }
        const allowedBundles = user.allowed_bundles;
        if (allowedBundles !== null && claims.bundleIds.some(bundle => !allowedBundles.includes(bundle))) {
          throw new ExecutionGrantError(403, 'bundle_scope_denied', 'The original Bundles are no longer authorized.');
        }
        const preview = { available: context.available, reason: context.reason, node: context.node,
          checkpointId: context.checkpointId, workspaceDigest: context.workspaceDigest,
          ...(qaRecheck ? { reviewDigest: context.reviewDigest, sourceTraceId: context.sourceTraceId,
            testPlan: context.testPlan, repairCount: context.repairCount,
            ...(qaRetry ? { retryKind: context.retryKind, missingDecisionIds: context.missingDecisionIds } : {}) } : {}) };
        res.setHeader('Cache-Control', 'private, no-store');
        if (!selected) { res.json(preview); return; }
        if (!context.available || selected.checkpointId !== context.checkpointId || selected.workspaceDigest !== context.workspaceDigest
          || (qaRecheck && (!('reviewDigest' in selected) || selected.reviewDigest !== context.reviewDigest))) {
          throw new ExecutionGrantError(409, 'checkpoint_changed', context.reason ?? 'Checkpoint or workspace changed. Reload retry options.');
        }
        await issuer.assertRepositoryCheckout(claims.bundleIds);
        const capabilities = await issuer.checkBundleCapabilities(claims.bundleIds, ['repository', 'repository-checkout', 'ci']);
        if (!capabilities.ok) throw new ExecutionGrantError(409, 'checkpoint_scope_unavailable', 'The original repository Bundle is no longer ready.');
        if (!claims.coreAgents?.length || !claims.workspaceRoot) throw new ExecutionGrantError(409, 'checkpoint_provenance_invalid', 'Original Agent/workspace provenance is incomplete.');
        const messageId = randomUUID();
        // Record the request before any dispatch. Never put the signed bearer or
        // source/issue content into audit or the browser response.
        if (!await writeAdminAudit(pool, req, qaRetry ? 'workflow_qa_retry_requested' : qaRecheck ? 'workflow_qa_response_recovery_requested' : 'workflow_checkpoint_retry_requested', 'argus_langgraph_threads', id,
          qaRetry ? 'Repeat independent QA with frozen plan and Knowledge' : qaRecheck ? 'Continue after retained QA response recheck' : 'Continue failed node', undefined,
          { checkpoint: selected.checkpointId, workspace_sha256: selected.workspaceDigest, node: context.node, request_id: messageId,
            ...(qaRecheck ? { review_sha256: context.reviewDigest, source_trace_id: context.sourceTraceId } : {}),
            ...(qaRetry ? { retry_kind: context.retryKind, missing_decision_ids: context.missingDecisionIds } : {}) })) {
          throw new ExecutionGrantError(503, 'checkpoint_audit_unavailable', 'Audit is unavailable; continuation was not started.');
        }
        const fresh = await issuer.issueWithClaims({ packId: 'argus.dev', agentId: 'coding-orchestrator',
          principalKind: 'user', principalId: String(user.id), ...scope, principalAllowedBundleIds: user.allowed_bundles,
          requestedBundleIds: claims.bundleIds, requestedToolNames: claims.toolNames,
          coreAgentNames: claims.coreAgents.map(agent => agent.name), messageId, rootTraceId: id,
          workspaceRoot: claims.workspaceRoot, workspaceAccess: claims.workspaceAccess,
          ...(claims.testEnvironmentPolicy ? { testEnvironmentPolicy: claims.testEnvironmentPolicy } : {}),
          ...(claims.codeGeneration ? { codeGeneration: claims.codeGeneration } : {}),
          codeContextVariant: claims.codeContextVariant, runtimeMode: claims.runtimeSelection?.effectiveMode ?? 'default',
          runtimeSelection: claims.runtimeSelection,
        });
        const result = await pack<{ thread_id: string; run_id: string; node: string; status: string }>(`/threads/${id}/${action}`,
          { ...selected, grant: fresh.token, messageId });
        res.status(202).json({ thread_id: result.thread_id, run_id: result.run_id, node: result.node, status: result.status });
      } catch (error) {
        const known = error instanceof ExecutionGrantError;
        res.status(known ? error.status : 503).json({ error: known ? error.message : 'Checkpoint verification unavailable. No automatic retry was started.',
          code: known ? error.code : 'checkpoint_retry_unavailable' });
      }
    });
  return router;
}
