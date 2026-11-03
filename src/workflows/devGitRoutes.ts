import { Router, type Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type pg from 'pg';
import { assertExecutionGrantActive, verifyExecutionGrant, ExecutionGrantError, type ExecutionGrantClaims } from '../solutionPacks/executionGrant.js';
import { BackendAuthenticationError, resolveBackendAuthentication, type BackendAuthEvidence } from '../backends/backendAuthentication.js';
import { assertEgressAllowed, assertSsrfSafeResolved, type CustomBackendRow } from '../backends/customBackends.js';
import { withRequestContext } from '../lib/requestContext.js';
import { decrypt } from '../lib/encryption.js';
import { writeImmutableAudit } from '../audit/immutableAudit.js';
import { DevGitError, assertGitPrincipal, assertGitReference, bindGitReference, gitCloneUrl, gitOperationSchema,
  gitTarget, loadGitBackend, type GitOperation, type GitTarget } from './devGitBroker.js';
import { executeGitWriteOnce, type GitReceipt } from './devGitOperations.js';
import { authorizeDevCi, ciAuthorizationSchema } from './devCiBinding.js';

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing provider response');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 65_536) throw new Error('Provider response exceeds limit');
      chunks.push(part.value);
    }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid provider response');
    return result as Record<string, unknown>;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** No backend token is returned to the Pack. Only this trusted transport and the
 * fixed Workspace Git subprocess may hold it, transiently. Unsupported personal
 * provider adapters cannot fall back to a service identity.
 */
export async function gitAuthentication(backend: CustomBackendRow, target: GitTarget) {
  if (backend.auth_mode !== 'service-account' && target.kind !== 'gitea') {
    throw new BackendAuthenticationError('delegation_adapter_required', backend.id);
  }
  const resolved = await resolveBackendAuthentication(backend);
  const token = resolved.authorization ? resolved.authorization.slice('Bearer '.length) : decrypt(backend.auth_value);
  if (!token || /[\s\x00-\x1f\x7f]/.test(token)) throw new BackendAuthenticationError('connection_required', backend.id);
  const username = target.kind === 'github' ? 'x-access-token' : 'oauth2';
  return { evidence: resolved.evidence,
    gitHeader: target.kind === 'bitbucket' ? `Bearer ${token}` : `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`,
    apiHeader: resolved.authorization ?? `${target.kind === 'gitea' ? 'token' : 'Bearer'} ${token}` };
}

export function pullRequestTransport(target: GitTarget, input: GitOperation, authorization: string) {
  const owner = target.project_key || target.user_slug;
  const apiBase = target.kind === 'github' && target.base_url === 'https://github.com' ? 'https://api.github.com' : target.base_url;
  const url = target.kind === 'bitbucket'
    ? `${apiBase}/rest/api/1.0/${target.user_slug ? `users/${target.user_slug}` : `projects/${owner}`}/repos/${target.repo_slug}/pull-requests`
    : `${apiBase}${target.kind === 'gitea' ? '/api/v1' : ''}/repos/${owner}/${target.repo_slug}/pulls`;
  const repository = { slug: target.repo_slug, project: { key: target.user_slug ? `~${target.user_slug}` : owner } };
  const body = target.kind === 'bitbucket'
    ? { title: input.title, description: input.description, fromRef: { id: `refs/heads/${input.branch}`, repository }, toRef: { id: `refs/heads/${target.target_branch}`, repository } }
    : { title: input.title, body: input.description, head: input.branch, base: target.target_branch };
  return { url, body, headers: { 'content-type': 'application/json', accept: 'application/json', authorization } };
}

export function createDevGitRouter(pool: pg.Pool, secret: string, options: {
  enabled?: () => boolean; workspaceSecret?: () => string; fetchFn?: typeof fetch;
  checkUrl?: (url: string) => Promise<void>;
  authentication?: typeof gitAuthentication; writeOnce?: typeof executeGitWriteOnce;
  auditIdentity?: (grant: ExecutionGrantClaims, evidence: BackendAuthEvidence) => void;
  auditCi?: (grant: ExecutionGrantClaims, detail: string, allowed: boolean) => void;
} = {}) {
  const router = Router();
  const fetchFn = options.fetchFn ?? fetch;
  const workspaceSecret = options.workspaceSecret ?? (() => process.env['WORKSPACE_SECRET'] ?? '');
  const checkUrl = options.checkUrl ?? (async (url: string) => {
    await assertSsrfSafeResolved(url, lookup, { failClosedOnDnsError: true }); assertEgressAllowed(url);
  });
  const authenticate = async (req: Request, bundleId: number): Promise<ExecutionGrantClaims> => {
    if (!(options.enabled?.() ?? process.env['ARGUS_DEV_GIT_BROKER_ENABLED'] === 'true')) {
      throw new DevGitError('git_broker_disabled', 'The Core-owned Git adapter is not enabled. No legacy credential fallback was used.', 503);
    }
    const provided = Buffer.from(req.header('x-workspace-secret') ?? '');
    const expected = Buffer.from(workspaceSecret());
    if (expected.length < 16 || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new DevGitError('git_orchestrator_required', 'A trusted Dev orchestrator is required.', 401);
    }
    const rootTraceId = req.header('x-argus-root-trace-id') ?? '';
    if (!rootTraceId) throw new DevGitError('git_trace_required', 'The original run trace is required.', 401);
    const header = req.header('authorization') ?? '';
    const claims = verifyExecutionGrant(secret, header.startsWith('Bearer ') ? header.slice(7) : '', {
      packId: 'argus.dev', agentId: 'coding-orchestrator', executionSurface: 'agent', bundleId, rootTraceId,
    });
    if (!claims.workspaceRoot) throw new DevGitError('git_workspace_required', 'A workspace-bound Dev grant is required.', 403);
    await assertExecutionGrantActive(pool, claims.jti);
    await assertGitPrincipal(pool, claims, bundleId);
    return claims;
  };
  const workspace = async (grant: ExecutionGrantClaims, target: GitTarget, input: GitOperation, authorization: string, operation: GitOperation['operation'] | 'verify' = input.operation): Promise<GitReceipt> => {
    const response = await fetchFn(`${process.env['AGENT_WORKSPACE_URL'] ?? 'http://agent-workspace:3001'}/git/remote`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(135_000),
      headers: { 'content-type': 'application/json', 'x-workspace-secret': workspaceSecret() },
      body: JSON.stringify({ operation, workspaceRoot: grant.workspaceRoot, url: gitCloneUrl(target),
        branch: input.branch, commitSha: input.commitSha, expectedRemoteSha: input.expectedRemoteSha, authorization }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new DevGitError('git_transport_uncertain', 'Workspace Git did not return a verified terminal receipt. Do not automatically replay.'); }
    const value = await safeJson(response);
    if (typeof value.ok !== 'boolean' || (value.commitSha !== undefined && !/^[a-f0-9]{40}$/.test(String(value.commitSha)))) throw new Error('Invalid Git receipt');
    return { ok: value.ok, ...(typeof value.commitSha === 'string' ? { commitSha: value.commitSha } : {}),
      ...(!value.ok ? { code: 'git_operation_failed' } : {}) };
  };
  const fail = (res: import('express').Response, error: unknown) => {
    if (error instanceof DevGitError || error instanceof ExecutionGrantError || error instanceof BackendAuthenticationError) {
      res.status(error instanceof BackendAuthenticationError ? 409 : error.status).json({ error: error.message, code: error.code }); return;
    }
    // Provider response/error objects can carry credentials. Never log or reflect them.
    res.status(503).json({ error: 'Git broker unavailable or outcome uncertain. No automatic retry was performed.', code: 'git_broker_unavailable' });
  };
  router.get('/api/internal/dev-git/:bundleId/reference', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const bundleId = Number(req.params.bundleId);
      if (!Number.isSafeInteger(bundleId) || bundleId < 1) throw new DevGitError('git_bundle_invalid', 'Invalid repository Bundle.', 400);
      const grant = await authenticate(req, bundleId);
      const backend = await loadGitBackend(pool, bundleId);
      if (!backend) { res.status(404).json({ code: 'git_backend_missing', error: 'No Git backend in this Bundle.' }); return; }
      // Discovery is metadata-only; never exchange or refresh credentials here.
      res.json({ ...gitTarget(backend), token: null, reference: bindGitReference(secret, grant, bundleId, backend) });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/internal/dev-git/operate', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const parsed = gitOperationSchema.safeParse(req.body);
      if (!parsed.success) throw new DevGitError('git_operation_invalid', 'Invalid or unapproved Git operation.', 400);
      const input = parsed.data;
      const grant = await authenticate(req, input.reference.bundleId);
      const followUp = grant.runtimeSelection?.workflowId === 'ticket-follow-up-image-pull-request';
      if (input.operation === 'inspect-pr' && !followUp) {
        throw new DevGitError('follow_up_workflow_required', 'PR inspection requires the signed follow-up workflow.', 403);
      }
      if (input.expectedRemoteSha && (!followUp || input.operation !== 'push')) {
        throw new DevGitError('follow_up_workflow_required', 'Updating an existing branch requires the signed follow-up workflow.', 403);
      }
      if (followUp && input.operation === 'push' && !input.expectedRemoteSha) {
        throw new DevGitError('follow_up_base_required', 'The reviewed remote predecessor is required for follow-up delivery.', 403);
      }
      if (input.verificationMode === 'review-only-image'
        && !['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(grant.runtimeSelection?.workflowId ?? '')) {
        throw new DevGitError('review_only_workflow_required', 'Review-only Git delivery requires the signed image workflow.', 403);
      }
      const backend = await loadGitBackend(pool, input.reference.bundleId);
      if (!backend) throw new DevGitError('git_backend_missing', 'The configured Git backend is no longer available.');
      assertGitReference(input.reference, bindGitReference(secret, grant, input.reference.bundleId, backend));
      const target = gitTarget(backend);
      if ((input.operation === 'push' || input.operation === 'pull-request') && input.branch === target.target_branch) {
        throw new DevGitError('git_target_branch_protected', 'Delivery must not overwrite the target branch.', 403);
      }
      await checkUrl(gitCloneUrl(target));
      const auth = await withRequestContext({ callingUser: { id: Number(grant.principalId), entra_groups: [] } },
        () => (options.authentication ?? gitAuthentication)(backend, target));
      if (options.auditIdentity) options.auditIdentity(grant, auth.evidence);
      else writeImmutableAudit(pool, { eventType: 'upstream_auth_selected', apiKeyPrefix: `user__${grant.principalId}`,
        userId: Number(grant.principalId), requestId: grant.rootTraceId, model: '', riskLevel: 'low',
        errorType: `backend:${backend.id}:identity:${auth.evidence.mode}:dev_git:${input.operation}` });
      const perform = async (): Promise<GitReceipt> => {
        // Recheck revocation immediately before dispatch, after possible refresh.
        await assertExecutionGrantActive(pool, grant.jti);
        if (input.operation === 'inspect-pr') {
          if (target.kind !== 'gitea') throw new DevGitError('follow_up_provider_unsupported', 'Follow-up PR verification currently supports Gitea.', 409);
          const owner = target.project_key || target.user_slug;
          const url = `${target.base_url}/api/v1/repos/${owner}/${target.repo_slug}/pulls/${input.pullRequestNumber}`;
          await checkUrl(url);
          const response = await fetchFn(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
            headers: { accept: 'application/json', authorization: auth.apiHeader } });
          if (!response.ok) { await response.body?.cancel(); throw new DevGitError('git_pr_unavailable', 'The existing PR could not be verified.', 409); }
          const payload = await safeJson(response);
          const head = payload.head && typeof payload.head === 'object' ? payload.head as Record<string, unknown> : {};
          const base = payload.base && typeof payload.base === 'object' ? payload.base as Record<string, unknown> : {};
          if (payload.state !== 'open' || payload.merged === true || head.ref !== input.branch
            || head.sha !== input.commitSha || base.ref !== target.target_branch) {
            return { ok: false, code: 'git_pr_changed' };
          }
          return { ok: true, commitSha: input.commitSha,
            prUrl: `${target.base_url}/${owner}/${target.repo_slug}/pulls/${input.pullRequestNumber}` };
        }
        if (input.operation !== 'pull-request') return workspace(grant, target, input, auth.gitHeader);
        const verified = await workspace(grant, target, input, auth.gitHeader, 'verify');
        if (!verified.ok || verified.commitSha !== input.commitSha) return { ok: false, code: 'git_remote_commit_changed' };
        const request = pullRequestTransport(target, input, auth.apiHeader);
        await checkUrl(request.url);
        const response = await fetchFn(request.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
          headers: request.headers, body: JSON.stringify(request.body) });
        if (!response.ok) { await response.body?.cancel(); throw new DevGitError('git_pr_outcome_uncertain', 'PR creation did not return confirmed success. Inspect the provider before retrying.'); }
        const payload = await safeJson(response);
        const number = target.kind === 'bitbucket' ? payload.id : payload.number;
        if (!Number.isSafeInteger(number) || Number(number) < 1) throw new Error('Missing PR identity');
        const webBase = target.kind === 'github' && target.base_url === 'https://api.github.com' ? 'https://github.com' : target.base_url;
        const prUrl = target.kind === 'bitbucket'
          ? `${webBase}/${target.user_slug ? `users/${target.user_slug}` : `projects/${target.project_key}`}/repos/${target.repo_slug}/pull-requests/${number}`
          : `${webBase}/${target.project_key || target.user_slug}/${target.repo_slug}/${target.kind === 'gitea' ? 'pulls' : 'pull'}/${number}`;
        return { ok: true, commitSha: input.commitSha, prUrl };
      };
      const receipt = input.operation === 'push' || input.operation === 'pull-request'
        ? await (options.writeOnce ?? executeGitWriteOnce)(pool, grant, input, auth.evidence, perform)
        : await perform();
      res.json({ ...receipt, authentication: auth.evidence satisfies BackendAuthEvidence });
    } catch (error) { fail(res, error); }
  });
  router.post('/api/internal/dev-git/ci-authorization', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    let principal: ExecutionGrantClaims | undefined;
    const audit = (grant: ExecutionGrantClaims, detail: string, allowed: boolean) => {
      if (options.auditCi) options.auditCi(grant, detail, allowed);
      else writeImmutableAudit(pool, { eventType: allowed ? 'request_success' : 'request_failure',
        apiKeyPrefix: `user__${grant.principalId}`, userId:Number(grant.principalId), requestId:grant.rootTraceId,
        model:'',riskLevel:'low',errorType:`dev_ci_authorization:${detail}` });
    };
    try {
      const parsed = ciAuthorizationSchema.safeParse(req.body);
      if (!parsed.success) throw new DevGitError('ci_request_invalid', 'Invalid CI authorization request.', 400);
      const input = parsed.data;
      const grant = await authenticate(req, input.reference.bundleId);
      if (input.verificationMode === 'review-only-image'
        && !['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(grant.runtimeSelection?.workflowId ?? '')) {
        throw new DevGitError('review_only_workflow_required', 'Review-only CI requires the signed image workflow.', 403);
      }
      principal = grant;
      const backend = await loadGitBackend(pool, input.reference.bundleId);
      if (!backend) throw new DevGitError('git_backend_missing', 'The repository binding is unavailable.', 403);
      assertGitReference(input.reference, bindGitReference(secret, grant, input.reference.bundleId, backend));
      const ciReference = await authorizeDevCi(pool, secret, grant, backend, input);
      // No provider call, credentials, approval or write intent is created here.
      // The dispatcher must repeat this check immediately before provider I/O.
      await assertExecutionGrantActive(pool, grant.jti);
      audit(grant, `bundle:${ciReference.bundleId}:backend:${ciReference.backendId}:phase:${input.phase}:allowed`, true);
      res.json({ ciReference });
    } catch (error) {
      if (principal) audit(principal, error instanceof DevGitError ? error.code : 'unavailable', false);
      fail(res, error);
    }
  });
  return router;
}
