import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import { executionGrantWorkspaceScope, type ExecutionGrantClaims } from '../solutionPacks/executionGrant.js';
import { DevGitError, type GitOperation } from './devGitBroker.js';
import type { BackendAuthEvidence } from '../backends/backendAuthentication.js';

export interface GitReceipt { ok: boolean; commitSha?: string; prUrl?: string; code?: string }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Reserve and audit before dispatch. A lost HTTP response or restarted process
 * leaves a durable unknown intent, never permission to retry a provider write.
 * A completed replay still goes through current auth in the route first.
 */
export async function executeGitWriteOnce(pool: pg.Pool, grant: ExecutionGrantClaims,
  input: GitOperation, identity: BackendAuthEvidence, perform: () => Promise<GitReceipt>): Promise<GitReceipt> {
  const scope = { ...executionGrantWorkspaceScope(grant), environment: process.env['ARGUS_ENVIRONMENT'] || 'local' };
  const key = hash([input.reference.backendId, input.operation, input.branch, input.commitSha, input.expectedRemoteSha]);
  const requestHash = hash(input);
  const params = [scope.tenantKey, scope.workspaceKey, scope.environment, grant.rootTraceId, key];
  const evidence = { backendId: input.reference.backendId, bundleId: input.reference.bundleId,
    operation: input.operation, operationKey: key, requestSha256: requestHash, identityMode: identity.mode,
    verificationMode: input.verificationMode ?? 'tests-passed' };
  const audit = (phase: 'started' | 'result', receipt?: GitReceipt) => ({
    ...scope, solution: 'argus.dev', actor: { type: 'human' as const, id: grant.principalId,
      authMethod: 'execution_grant', effectiveRoles: [] },
    action: `dev_git.${phase}`, outcome: receipt?.ok === false ? 'failure' as const : 'success' as const,
    risk: 'high' as const, resource: { type: 'dev_git_operation', id: key, revision: requestHash },
    policy: { id: 'argus.dev.git-broker', version: '1', decision: 'allow' as const },
    correlation: { rootRunId: grant.rootTraceId, traceId: grant.rootTraceId },
    payload: { after: { ...evidence, ...(receipt ? { receiptSha256: hash(receipt), ok: receipt.ok } : {}) } },
  });
  const started = await executeCanonicalAuditedMutation(pool,
    { name: 'argus.dev.git-broker', eventId: `${grant.rootTraceId}:${key}:started` }, scope,
    async client => {
      await client.query(`INSERT INTO argus_dev_git_operations
        (tenant_key,workspace_key,environment,root_trace_id,operation_key,request_sha256,backend_id,principal_id,operation,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'started')`, [...params, requestHash, input.reference.backendId, grant.principalId, input.operation]);
      return true;
    }, () => audit('started'));
  if (started.replayed) {
    const { rows } = await pool.query<{ request_sha256: string; principal_id: string; status: string; receipt: GitReceipt | null }>(
      `SELECT request_sha256,principal_id,status,receipt FROM argus_dev_git_operations
       WHERE tenant_key=$1 AND workspace_key=$2 AND environment=$3 AND root_trace_id=$4 AND operation_key=$5`, params);
    const row = rows[0];
    if (!row || row.request_sha256 !== requestHash || row.principal_id !== grant.principalId) {
      throw new DevGitError('git_operation_conflict', 'This provider operation already has a different frozen request.');
    }
    if (row.status !== 'completed' || !row.receipt) throw new DevGitError('git_operation_uncertain', 'A previous provider write has no terminal receipt. Reconcile it; do not retry automatically.');
    return row.receipt;
  }
  const receipt = await perform(); // Unknown exceptions deliberately retain started.
  await executeCanonicalAuditedMutation(pool,
    { name: 'argus.dev.git-broker', eventId: `${grant.rootTraceId}:${key}:result` }, scope,
    async client => {
      const changed = await client.query(`UPDATE argus_dev_git_operations SET status='completed', receipt=$6::jsonb, completed_at=now()
        WHERE tenant_key=$1 AND workspace_key=$2 AND environment=$3 AND root_trace_id=$4 AND operation_key=$5 AND status='started'`, [...params, JSON.stringify(receipt)]);
      if (changed.rowCount !== 1) throw new Error('Git receipt could not be committed');
      return true;
    }, () => audit('result', receipt));
  return receipt;
}
