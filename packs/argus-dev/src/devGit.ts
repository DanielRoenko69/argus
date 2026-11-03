import type { GitCreds, WorkflowState } from './state.js';
import { assertWorkflowNotCanceled } from './workflowCancellation.js';
import { isImageReviewDelivery } from './reviewOnlyDelivery.js';

type State = typeof WorkflowState.State;
export interface DevGitReceipt { ok: boolean; commitSha?: string; prUrl?: string; code?: string;
  authentication?: { mode: 'user-oauth' | 'service-account'; userId?: number; backendId: number } }

function headers(grant: string, trace: string): Record<string, string> {
  const secret = process.env['WORKSPACE_SECRET'] ?? '';
  if (!grant || !trace || !secret) throw new Error('Core-bound Git execution is unavailable. Start a new governed run.');
  return { 'content-type': 'application/json', authorization: `Bearer ${grant}`,
    'x-argus-root-trace-id': trace, 'x-workspace-secret': secret };
}
async function read(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    // Never reflect arbitrary provider / reverse-proxy responses in checkpoints.
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof body?.code === 'string' && /^[a-z_]{1,80}$/.test(body.code) ? body.code : 'git_broker_unavailable';
    throw new Error(`Core Git authorization/transport stopped (${code}, HTTP ${response.status}). Check Connections or the run grant. No credential fallback or automatic retry was used.`);
  }
  return await response.json() as Record<string, unknown>;
}

/** Metadata-only resolution: never accept a token-bearing legacy response. */
export async function fetchGitReference(bundleId: number, grant: string, trace: string): Promise<GitCreds | null> {
  const response = await fetch(`${process.env['ARGUS_URL'] ?? 'http://mcp-server:3000'}/api/internal/dev-git/${bundleId}/reference`, {
    headers: headers(grant, trace), redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    const body = await response.json().catch(() => null) as { code?: string } | null;
    if (body?.code === 'git_backend_missing') return null;
    throw new Error('Core Git adapter is not installed. No legacy credential fallback was used.');
  }
  const body = await read(response);
  const ref = body.reference as GitCreds['reference'];
  if (body.token !== null || !ref || ref.version !== 1 || ref.bundleId !== bundleId || !Number.isSafeInteger(ref.backendId)
    || ref.backendId < 1 || !/^[a-f0-9]{64}$/.test(ref.binding)
    || !['gitea','github','bitbucket'].includes(String(body.kind))
    || ['base_url','project_key','user_slug','repo_slug','target_branch'].some(key => typeof body[key] !== 'string')) {
    throw new Error('Invalid metadata-only repository reference.');
  }
  return { kind: body.kind as GitCreds['kind'], base_url: body.base_url as string, token: null,
    project_key: body.project_key as string, user_slug: body.user_slug as string, repo_slug: body.repo_slug as string,
    target_branch: body.target_branch as string, reference: { version: 1, bundleId, backendId: ref.backendId, binding: ref.binding } };
}

export function assertGitDeliveryApproval(state: State, pr = false): void {
  if (state.workflow_blockers.length || !state.human_approved || (!state.tests_passed && !isImageReviewDelivery(state.delivery_mode)) || !state.review_passed) {
    throw new Error(isImageReviewDelivery(state.delivery_mode)
      ? 'Image delivery requires code review, human approval and no unresolved blockers; automated tests remain skipped.'
      : 'Delivery requires passing tests, review, human approval and no unresolved blockers.');
  }
  if (pr && (!state.pr_approved || !state.branch_pushed || state.delivery_status !== 'ci_passed'
    || state.ci_run?.status !== 'success' || state.ci_run.commit_sha !== state.commit_sha
    || state.ci_run.branch !== state.branch_name)) throw new Error('PR delivery requires human PR approval and successful CI for the exact pushed branch and commit.');
}

export async function devGitOperation(state: State, trace: string, creds: GitCreds,
  operation: 'clone' | 'fetch' | 'push' | 'pull-request' | 'inspect-pr', branch: string,
  options: { commitSha?: string; expectedRemoteSha?: string; pullRequestNumber?: number; title?: string; description?: string } = {}): Promise<DevGitReceipt> {
  assertWorkflowNotCanceled();
  if (!creds.reference || creds.token !== null) throw new Error('This legacy run has no token-free Git reference. Configure a new attempt; old credentials were not reused.');
  const write = operation === 'push' || operation === 'pull-request';
  if (write) assertGitDeliveryApproval(state, operation === 'pull-request');
  const response = await fetch(`${process.env['ARGUS_URL'] ?? 'http://mcp-server:3000'}/api/internal/dev-git/operate`, {
    method: 'POST', headers: headers(state.argus_execution_grant, trace), redirect: 'error', signal: AbortSignal.timeout(175_000),
    body: JSON.stringify({ reference: creds.reference, operation, branch, ...options,
      ...(write ? { codeApproved: true, reviewPassed: true,
        ...(isImageReviewDelivery(state.delivery_mode) ? { verificationMode: 'review-only-image' } : { testsPassed: true }) } : {}),
      ...(operation === 'pull-request' ? { prApproved: true, ciPassed: true } : {}),
    }),
  });
  const result = await read(response);
  assertWorkflowNotCanceled();
  if (typeof result.ok !== 'boolean' || (result.commitSha !== undefined && !/^[a-f0-9]{40}$/.test(String(result.commitSha)))) throw new Error('Invalid Core Git receipt.');
  if (!result.ok) throw new Error('Core Git operation failed. Inspect the provider receipt; no automatic retry was performed.');
  if (write && result.commitSha !== options.commitSha) throw new Error('Core Git receipt does not match the approved commit.');
  return result as unknown as DevGitReceipt;
}
