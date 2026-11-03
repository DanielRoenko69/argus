import { Router } from 'express';
import type { Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { requireAuth, requirePermission, requireSameOrigin, type AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { resolveAuthorizedWorkspaceScope } from '../auth/workspaceScope.js';
import { checkpointGrantProvenance } from './codingCheckpointRetry.js';
import { ExecutionGrantError, type ExecutionGrantIssuer } from '../solutionPacks/executionGrant.js';
import { LANGGRAPH_URL, WORKSPACE_SECRET } from '../config/env.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import { canonicalAuditDigest, redactCanonicalAuditPayload } from '../audit/canonicalAuditRedaction.js';
import { assertGitPrincipal } from '../workflows/devGitBroker.js';
import { submitHumanFeedback } from '../observability/feedbackStore.js';
import { flushTelemetryWrites } from '../observability/telemetryStore.js';
import { redact } from '../lib/redaction.js';
import { logger } from '../lib/logger.js';

const decisionSchema = z.object({ approved: z.boolean(), feedback: z.string().max(8000).optional(), rationale: z.string().max(8000).optional() }).strict();
const recoverySchema = z.object({ checkpointId: z.string().uuid() }).strict();
function decisionDigest(checkpointId: string, approved: boolean, feedback: string, rationale: string): string {
  return createHash('sha256').update(JSON.stringify([checkpointId, approved, feedback, rationale])).digest('hex');
}
export const gitApprovalContextSchema = z.object({ broker: z.literal(true), threadId: z.string().uuid(),
  checkpointId: z.string().uuid(), stage: z.enum(['human_approval','human_approval_pr']), executionGrant: z.string().max(16_384),
  principal: z.string(), grantId: z.string().uuid(), ticketId: z.string(), branch: z.string(), commitSha: z.string(),
  retryCount: z.number().int().nonnegative(),
}).strict();

/** Human resume renews the original actor's authority, never the approver's
 * backend identity. Version-1 broker runs cannot use the permissive legacy proxy.
 */
export function createDevGitApprovalRouter(pool: pg.Pool, issuer: ExecutionGrantIssuer, secret: string, fetchFn: typeof fetch = fetch) {
  const router = Router();
  let localDispatchFailureConsumed = false;
  const pack = async (path: string, body?: unknown) => {
    const response = await fetchFn(`${LANGGRAPH_URL}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new ExecutionGrantError(409, 'git_approval_changed', 'The approval checkpoint is unavailable or changed. Reload the run.');
    return response.json() as Promise<Record<string, unknown>>;
  };
  const authorizedContext = async (req: Request, id: string, raw?: Record<string, unknown>) => {
    const context = gitApprovalContextSchema.parse(raw ?? await pack(`/threads/${id}/git-approval-context`));
    const user = (req as AuthenticatedRequest).user!;
    const scope = resolveAuthorizedWorkspaceScope(req, user);
    const claims = checkpointGrantProvenance(secret, context.executionGrant);
    if (context.threadId !== id || claims.rootTraceId !== id || claims.principalKind !== 'user'
      || claims.principalId !== String(user.id) || context.principal !== `user:${user.id}` || context.grantId !== claims.jti
      || (claims.tenantKey ?? 'default') !== scope.tenantKey || (claims.workspaceKey ?? 'default') !== scope.workspaceKey) {
      throw new ExecutionGrantError(404, 'git_approval_not_found', 'Approval is not available for this principal/workspace.');
    }
    const stored = await pool.query(`SELECT status FROM argus_execution_grants WHERE grant_id=$1 AND principal_kind='user'
      AND principal_id=$2 AND root_trace_id=$3 AND tenant_key=$4 AND workspace_key=$5`,
    [claims.jti, claims.principalId, id, scope.tenantKey, scope.workspaceKey]);
    if (stored.rows[0]?.status !== 'active' || !claims.coreAgents?.length || !claims.workspaceRoot) {
      throw new ExecutionGrantError(403, 'git_approval_revoked', 'Original execution authority was revoked or is incomplete.');
    }
    for (const bundle of claims.bundleIds) await assertGitPrincipal(pool, claims, bundle);
    await issuer.assertRepositoryCheckout(claims.bundleIds);
    const capabilities = await issuer.checkBundleCapabilities(claims.bundleIds, ['repository','repository-checkout','ci']);
    if (!capabilities.ok) throw new ExecutionGrantError(409, 'git_approval_scope_unavailable', 'Original repository/CI scope is not ready.');
    return { context, user, scope, claims };
  };
  const freshGrant = async (id: string, authorized: Awaited<ReturnType<typeof authorizedContext>>) => {
    const { user, scope, claims } = authorized;
    const messageId = randomUUID();
    const fresh = await issuer.issueWithClaims({ packId: 'argus.dev', agentId: 'coding-orchestrator',
      principalKind: 'user', principalId: claims.principalId, ...scope, principalAllowedBundleIds: user.allowed_bundles,
      requestedBundleIds: claims.bundleIds, requestedToolNames: claims.toolNames, coreAgentNames: (claims.coreAgents ?? []).map(a => a.name),
      messageId, rootTraceId: id, workspaceRoot: claims.workspaceRoot, workspaceAccess: claims.workspaceAccess,
      testEnvironmentPolicy: claims.testEnvironmentPolicy, codeGeneration: claims.codeGeneration, codeContextVariant: claims.codeContextVariant,
      runtimeMode: claims.runtimeSelection?.effectiveMode ?? 'default', runtimeSelection: claims.runtimeSelection });
    return { messageId, fresh };
  };
  router.post('/threads/:id/resume', (req, res, next) => {
    if (process.env['ARGUS_DEV_GIT_BROKER_ENABLED'] !== 'true') { next('route'); return; }
    next();
  }, requireAuth, requireSameOrigin, requirePermission('approvals.review'), async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const raw = await pack(`/threads/${id}/git-approval-context`);
      if (raw.broker === false) { next(); return; }
      const authorized = await authorizedContext(req, id, raw);
      const { context, user, scope } = authorized;
      const decision = decisionSchema.parse(req.body);
      const { messageId, fresh } = await freshGrant(id, authorized);
      const auditScope = { ...scope, environment: process.env['ARGUS_ENVIRONMENT'] || 'local' };
      const gate = context.stage === 'human_approval' ? 'code_approval' : 'functional_approval';
      const rationale = decision.rationale ?? decision.feedback ?? '';
      const feedback = decision.feedback ?? '';
      const digest = decisionDigest(context.checkpointId, decision.approved, feedback, rationale);
      const recorded = await executeCanonicalAuditedMutation(pool, { name: 'argus.dev.git-approval', eventId: `${id}:${context.checkpointId}` }, auditScope,
        async client => {
          await client.query(`INSERT INTO mcp_agent_approvals
            (thread_id,ticket_id,workflow_type,gate_type,approved,approver_user_id,approver_username,rationale,branch_name,commit_sha,retry_count,row_hash,checkpoint_id,decision_feedback)
            VALUES ($1,$2,'coding_workflow',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id,context.ticketId,gate,decision.approved,user.id,user.username,rationale,context.branch,context.commitSha,context.retryCount,digest,context.checkpointId,feedback]);
          return true;
        }, () => ({ ...auditScope, solution: 'argus.dev', actor: { type: 'human', id: String(user.id), authMethod: user.auth_method ?? 'session', effectiveRoles: [user.role] },
          action: 'dev_git.approval', outcome: 'success', risk: 'high', resource: { type: 'dev_git_approval', id, revision: context.checkpointId },
          policy: { id: 'argus.dev.git-broker', version: '1', decision: 'allow' }, correlation: { rootRunId: id, traceId: id },
          payload: { after: { gate, approved: decision.approved, decisionSha256: digest } } }));
      if (recorded.replayed) throw new ExecutionGrantError(409, 'git_approval_already_recorded', 'This checkpoint already has a recorded decision. Reconcile its dispatch instead of submitting again.');
      // Preserve the existing quality-feedback projection. Canonical approval
      // evidence above is mandatory; this derived projection is best-effort.
      try {
        await flushTelemetryWrites();
        await submitHumanFeedback(pool, { traceId: id, label: gate, score: decision.approved ? 1 : 0,
          sentiment: decision.approved ? 'positive' : 'negative', comment: rationale ? redact(rationale).text : null,
          tags: ['human-approval', gate], userId: user.id });
      } catch { logger.warn({ threadId: id }, 'Git approval feedback projection unavailable; canonical decision retained'); }
      // Local fault injection is scoped to one explicit thread and gate. It
      // exercises the real persisted-decision recovery path without allowing
      // an untrusted request or a production deployment to arm it.
      if (!localDispatchFailureConsumed
        && process.env['ARGUS_ENVIRONMENT'] === 'local'
        && process.env['ARGUS_PUBLIC_URL'] === 'http://localhost:3000'
        && process.env['ARGUS_DEV_GIT_APPROVAL_TEST_FAIL_ONCE'] === `${id}:${context.stage}`) {
        localDispatchFailureConsumed = true;
        logger.warn({ threadId: id, stage: context.stage }, 'Local Git approval dispatch failure injected after canonical audit');
        throw new ExecutionGrantError(503, 'git_approval_demo_dispatch_interrupted',
          'Local test: approval was recorded but dispatch was interrupted. Reload the run and resume the recorded decision.');
      }
      await pack(`/threads/${id}/runs`, { command: { resume: { approved: decision.approved, feedback: decision.feedback ?? '' } },
        gitApproval: { grant: fresh.token, messageId, checkpointId: context.checkpointId, stage: context.stage } });
      res.json({ ok: true });
    } catch (error) {
      const known = error instanceof ExecutionGrantError;
      res.status(known ? error.status : 409).json({ code: known ? error.code : 'git_approval_unavailable',
        error: known ? error.message : 'Approval could not be verified. Reload the run; no automatic resume was attempted.' });
    }
  });
  for (const method of ['get', 'post'] as const) router[method]('/threads/:id/approval-recovery',
    requireAuth, ...(method === 'post' ? [requireSameOrigin] : []), requirePermission('approvals.review'), async (req, res) => {
      try {
        const id = z.string().uuid().parse(req.params.id);
        const selected = method === 'post' ? recoverySchema.parse(req.body) : null;
        const authorized = await authorizedContext(req, id);
        const { context, user, scope } = authorized;
        if (selected && selected.checkpointId !== context.checkpointId) {
          throw new ExecutionGrantError(409, 'git_approval_changed', 'The approval checkpoint changed. Reload the run.');
        }
        const gate = context.stage === 'human_approval' ? 'code_approval' : 'functional_approval';
        const auditScope = { ...scope, environment: process.env['ARGUS_ENVIRONMENT'] || 'local' };
        const recorded = await pool.query<{ approved: boolean; rationale: string; decision_feedback: string | null;
          row_hash: string; approver_user_id: number }>(`SELECT approved,rationale,decision_feedback,row_hash,approver_user_id
          FROM mcp_agent_approvals WHERE thread_id=$1 AND checkpoint_id=$2 AND gate_type=$3`, [id, context.checkpointId, gate]);
        const row = recorded.rows[0];
        if (!row) {
          if (method === 'post') throw new ExecutionGrantError(409, 'git_approval_not_recorded', 'No recorded decision exists for this checkpoint.');
          res.json({ available: false }); return;
        }
        const digest = decisionDigest(context.checkpointId, row.approved, row.decision_feedback ?? '', row.rationale);
        const evidence = await pool.query<{ actor_id: string; resource_revision: string; payload_summary: Record<string, unknown>;
          after_digest: string | null }>(
          `SELECT actor_id,resource_revision,payload_summary,after_digest FROM mcp_canonical_audit_events
            WHERE tenant_key=$1 AND workspace_key=$2 AND environment=$3 AND producer_name='argus.dev.git-approval'
              AND producer_event_id=$4`, [auditScope.tenantKey, auditScope.workspaceKey, auditScope.environment,
            `${id}:${context.checkpointId}`]);
        const event = evidence.rows[0];
        const after = event?.payload_summary?.['after'] as Record<string, unknown> | undefined;
        // Canonical audit redaction intentionally sanitizes values that resemble
        // phone numbers. A hexadecimal decision digest may therefore be changed
        // in payload_summary. Bind recovery to the immutable after_digest, which
        // is computed over that exact redacted projection, instead of comparing
        // the projected string with the unredacted approval-row digest.
        const expectedAfterDigest = canonicalAuditDigest(redactCanonicalAuditPayload({
          gate, approved: row.approved, decisionSha256: digest,
        }));
        if (row.approver_user_id !== user.id || row.row_hash !== digest || row.decision_feedback == null
          || event?.actor_id !== String(user.id) || event.resource_revision !== context.checkpointId
          || event.after_digest !== expectedAfterDigest || after?.['gate'] !== gate || after?.['approved'] !== row.approved) {
          throw new ExecutionGrantError(409, 'git_approval_evidence_mismatch', 'The recorded decision cannot be reconciled safely.');
        }
        if (method === 'get') {
          res.json({ available: true, checkpointId: context.checkpointId, stage: context.stage, approved: row.approved });
          return;
        }
        const { messageId, fresh } = await freshGrant(id, authorized);
        await pack(`/threads/${id}/runs`, { command: { resume: { approved: row.approved, feedback: row.decision_feedback } },
          gitApproval: { grant: fresh.token, messageId, checkpointId: context.checkpointId, stage: context.stage } });
        res.json({ ok: true, recovered: true });
      } catch (error) {
        const known = error instanceof ExecutionGrantError;
        res.status(known ? error.status : 409).json({ code: known ? error.code : 'git_approval_recovery_unavailable',
          error: known ? error.message : 'Recorded approval could not be reconciled. Reload the run; no automatic replay was attempted.' });
      }
    });
  return router;
}
