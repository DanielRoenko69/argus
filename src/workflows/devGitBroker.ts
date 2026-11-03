import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { CustomBackendRow } from '../backends/customBackends.js';
import { executionGrantWorkspaceScope, type ExecutionGrantClaims } from '../solutionPacks/executionGrant.js';

export class DevGitError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export const gitBranch = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(s => !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.')
    && s.split('/').every(p => !p.startsWith('.') && !p.endsWith('.lock')));
const segment = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/).refine(s => s !== '.' && s !== '..');
export const gitReferenceSchema = z.object({ version: z.literal(1), bundleId: z.number().int().positive(),
  backendId: z.number().int().positive(), binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const gitOperationSchema = z.object({ reference: gitReferenceSchema,
  operation: z.enum(['clone', 'fetch', 'push', 'pull-request', 'inspect-pr']), branch: gitBranch,
  commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  // Follow-up delivery is compare-and-swap against the reviewed predecessor.
  // Ordinary new-branch pushes must never claim an existing remote head.
  expectedRemoteSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  title: z.string().min(1).max(240).optional(), description: z.string().max(16_000).optional(),
  // Attestation from the trusted Pack, not a browser or model approval API.
  codeApproved: z.literal(true).optional(), prApproved: z.literal(true).optional(),
  testsPassed: z.literal(true).optional(), reviewPassed: z.literal(true).optional(), ciPassed: z.literal(true).optional(),
  verificationMode: z.literal('review-only-image').optional(),
}).strict().superRefine((v, ctx) => {
  if (v.expectedRemoteSha && v.operation !== 'push') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected remote SHA is only valid for a branch update' });
  }
  if (v.operation === 'inspect-pr') {
    if (!v.commitSha || !v.branch.startsWith('feature/') || !v.pullRequestNumber) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pinned PR identity and head required' });
    }
  } else if (v.pullRequestNumber) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PR number is only valid for inspection' });
  }
  if (v.operation === 'push' || v.operation === 'pull-request') {
    if (!v.commitSha || !v.branch.startsWith('feature/') || !v.codeApproved || (!v.testsPassed && v.verificationMode !== 'review-only-image') || !v.reviewPassed
      || (v.testsPassed && v.verificationMode)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Approved feature-branch delivery evidence required' });
    }
  }
  if (v.operation === 'pull-request' && (!v.prApproved || !v.ciPassed || !v.title || v.description === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Post-CI PR approval required' });
  }
});
export type GitOperation = z.infer<typeof gitOperationSchema>;
export interface GitTarget {
  kind: 'gitea' | 'github' | 'bitbucket'; base_url: string; project_key: string; user_slug: string;
  repo_slug: string; target_branch: string;
}

export function gitTarget(backend: CustomBackendRow): GitTarget {
  const c = backend.config ?? {};
  const kind = ['gitea', 'github', 'bitbucket'].find(k => c.kind ? c.kind === k : backend.name.toLowerCase().includes(k));
  if (!kind) throw new DevGitError('git_provider_unsupported', 'Unsupported Git provider.');
  const url = new URL(backend.base_url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /[%\s\\]/.test(backend.base_url)) throw new DevGitError('git_target_invalid', 'Invalid configured Git origin.');
  const user = String(c.user_slug ?? '');
  const owner = String(c.project_key ?? c.owner ?? user);
  const repo = String(c.repo_slug ?? c.repo ?? '');
  if (!segment.safeParse(owner || user).success || (user && !segment.safeParse(user).success) || !segment.safeParse(repo).success) {
    throw new DevGitError('git_target_invalid', 'Configure a concrete Git owner and repository.');
  }
  const branch = gitBranch.parse(c.default_target_branch ?? c.target_branch ?? 'master');
  return { kind: kind as GitTarget['kind'], base_url: url.toString().replace(/\/+$/, ''),
    project_key: owner, user_slug: user, repo_slug: repo, target_branch: branch };
}

export function gitCloneUrl(t: GitTarget): string {
  return t.kind === 'bitbucket' ? `${t.base_url}/scm/${t.user_slug ? `~${t.user_slug}` : t.project_key}/${t.repo_slug}.git`
    : `${t.base_url}/${t.project_key || t.user_slug}/${t.repo_slug}.git`;
}

/** A non-secret MAC binds a reference to the original owner/run/workspace and
 * reviewed repository configuration. Grant renewal may change jti, never owner.
 * OAuth rotation does not invalidate it; changing identity policy/config does.
 */
export function bindGitReference(secret: string, grant: ExecutionGrantClaims, bundleId: number, backend: CustomBackendRow) {
  const scope = executionGrantWorkspaceScope(grant);
  const material = JSON.stringify(['dev-git-v1', scope.tenantKey, scope.workspaceKey, grant.principalKind,
    grant.principalId, grant.rootTraceId, grant.workspaceRoot, bundleId, backend.id, gitTarget(backend),
    backend.auth_mode, backend.oauth_client_id, backend.oauth_token_url, [...(backend.oauth_scopes ?? [])].sort()]);
  return { version: 1 as const, bundleId, backendId: backend.id, binding: createHmac('sha256', secret).update(material).digest('hex') };
}
export function assertGitReference(actual: z.infer<typeof gitReferenceSchema>, expected: z.infer<typeof gitReferenceSchema>) {
  if (actual.backendId !== expected.backendId || actual.bundleId !== expected.bundleId
    || !timingSafeEqual(Buffer.from(actual.binding, 'hex'), Buffer.from(expected.binding, 'hex'))) {
    throw new DevGitError('git_reference_changed', 'Repository, identity policy or run binding changed. Configure a new attempt.');
  }
}

export async function loadGitBackend(pool: pg.Pool, bundleId: number): Promise<CustomBackendRow | null> {
  const result = await pool.query<CustomBackendRow>(`SELECT b.* FROM mcp_backends b
    JOIN mcp_backend_bundles bb ON bb.backend_id=b.id WHERE bb.bundle_id=$1 AND b.enabled=true
    AND (b.config->>'kind' IN ('gitea','github','bitbucket') OR b.name ILIKE '%gitea%'
      OR b.name ILIKE '%github%' OR b.name ILIKE '%bitbucket%') ORDER BY b.id LIMIT 2`, [bundleId]);
  if (result.rows.length > 1) throw new DevGitError('git_target_ambiguous', 'Select exactly one Git backend in the repository Bundle.');
  return result.rows[0] ?? null;
}

/** Recheck current human access, not just historical Bundle membership in a grant. */
export async function assertGitPrincipal(pool: pg.Pool, grant: ExecutionGrantClaims, bundleId: number) {
  if (grant.principalKind !== 'user' || !/^[1-9]\d*$/.test(grant.principalId)) {
    throw new DevGitError('git_user_required', 'This Dev Git adapter requires an original human execution principal.', 403);
  }
  const id = Number(grant.principalId);
  const { rows } = await pool.query<{ id: number; allowed_bundles: number[] | null }>(
    'SELECT id, allowed_bundles FROM mcp_users WHERE id=$1 AND enabled=true', [id]);
  if (!rows[0] || (rows[0].allowed_bundles !== null && !rows[0].allowed_bundles.includes(bundleId))) {
    throw new DevGitError('git_bundle_denied', 'The original user no longer has access to this repository Bundle.', 403);
  }
  const scope = executionGrantWorkspaceScope(grant);
  if (scope.tenantKey !== 'default' || scope.workspaceKey !== 'default') {
    const membership = await pool.query('SELECT 1 FROM mcp_workspace_memberships WHERE user_id=$1 AND tenant_key=$2 AND workspace_key=$3',
      [id, scope.tenantKey, scope.workspaceKey]);
    if (!membership.rows[0]) throw new DevGitError('git_workspace_denied', 'Workspace membership is no longer available.', 403);
  }
  return id;
}
