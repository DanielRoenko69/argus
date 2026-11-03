import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { CustomBackendRow } from '../backends/customBackends.js';
import type { ExecutionGrantClaims } from '../solutionPacks/executionGrant.js';
import { DevGitError, gitReferenceSchema, gitTarget } from './devGitBroker.js';

const origin = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch { return false; }
});
const job = z.string().min(1).max(200).regex(/^[\w-]+$/);
export const devCiPolicySchema = z.object({
  kind: z.literal('jenkins'),
  dev_ci: z.object({
    version: z.literal(1),
    credential_source: z.literal('argus-dev-dispatcher'),
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    git_origin: origin,
    job,
    branch_prefix: z.string().regex(/^feature\/[A-Za-z0-9-]+-$/),
    verification_mode: z.literal('review-only-image').optional(),
  }).strict(),
}).strict();
export const ciReferenceSchema = z.object({
  version: z.literal(1), bundleId: z.number().int().positive(), backendId: z.number().int().positive(),
  job, apiOrigin: origin, repository: z.string(), branchPrefix: z.string(),
  authMode: z.literal('service-account'), credentialSource: z.literal('argus-dev-dispatcher'),
  binding: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const ciAuthorizationSchema = z.object({
  reference: gitReferenceSchema, job, apiOrigin: origin,
  phase: z.enum(['prepare', 'dispatch']), ciReference: ciReferenceSchema.optional(),
  branch: z.string().max(200).optional(), commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  codeApproved: z.literal(true).optional(), testsPassed: z.literal(true).optional(), reviewPassed: z.literal(true).optional(),
  verificationMode: z.literal('review-only-image').optional(),
}).strict().superRefine((input, ctx) => {
  if (input.phase === 'dispatch' && (!input.ciReference || !input.branch || !input.commitSha || !input.baseSha
    || input.commitSha === input.baseSha || !input.codeApproved
    || (!input.testsPassed && input.verificationMode !== 'review-only-image') || !input.reviewPassed
    || (input.testsPassed && input.verificationMode))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Frozen CI binding and approved exact source required.' });
  }
});
export type CiAuthorization = z.infer<typeof ciAuthorizationSchema>;

/** Policy metadata only. The trusted Dev dispatcher retains its explicitly
 * configured service credential; this is not a personal OAuth adapter or a
 * general MCP write tool. Check live membership and freeze the exact target.
 */
export async function authorizeDevCi(pool: pg.Pool, secret: string, grant: ExecutionGrantClaims,
  gitBackend: CustomBackendRow, input: CiAuthorization) {
  const target = gitTarget(gitBackend);
  const repository = `${target.project_key || target.user_slug}/${target.repo_slug}`;
  const result = await pool.query<CustomBackendRow>(`SELECT b.* FROM mcp_backends b
    JOIN mcp_backend_bundles bb ON bb.backend_id=b.id
    WHERE bb.bundle_id=$1 AND b.enabled=true AND b.config->>'kind'='jenkins'
    AND b.config->'dev_ci'->>'job'=$2 ORDER BY b.id LIMIT 2`, [input.reference.bundleId, input.job]);
  if (result.rows.length !== 1) throw new DevGitError('ci_binding_missing',
    'Select a repository Bundle with exactly one enabled binding for this Jenkins job.', 403);
  const backend = result.rows[0]!;
  const parsed = devCiPolicySchema.safeParse(backend.config);
  if (!parsed.success || backend.backend_type !== 'http' || backend.auth_mode !== 'service-account'
    || backend.base_url !== input.apiOrigin || backend.tls_skip_verify) {
    throw new DevGitError('ci_binding_invalid', 'The configured CI binding or authentication mode is not supported.', 403);
  }
  const policy = parsed.data.dev_ci;
  if (policy.verification_mode !== input.verificationMode) {
    throw new DevGitError('ci_verification_mode_denied', 'Select a Jenkins job with the matching verification policy.', 403);
  }
  if (policy.repository !== repository || policy.git_origin !== target.base_url) {
    throw new DevGitError('ci_repository_denied', 'The Jenkins job is not authorized for this repository.', 403);
  }
  const metadata = { version: 1 as const, bundleId: input.reference.bundleId, backendId: backend.id,
    job: input.job, apiOrigin: backend.base_url, repository, branchPrefix: policy.branch_prefix,
    authMode: 'service-account' as const, credentialSource: policy.credential_source };
  const binding = createHmac('sha256', secret).update(JSON.stringify(['dev-ci-v1', input.reference,
    grant.principalKind, grant.principalId, grant.rootTraceId, grant.workspaceRoot, metadata])).digest('hex');
  const reference = { ...metadata, binding };
  if (input.phase === 'dispatch') {
    if (JSON.stringify(ciReferenceSchema.parse(input.ciReference)) !== JSON.stringify(reference)) {
      throw new DevGitError('ci_binding_changed', 'The CI binding changed after this run started. Configure a new attempt.', 409);
    }
    if (!input.branch!.startsWith(policy.branch_prefix) || !/^feature\/[A-Za-z0-9-]+$/.test(input.branch!)) {
      throw new DevGitError('ci_branch_denied', 'The branch is outside the configured Jenkins binding.', 403);
    }
  }
  return reference;
}
