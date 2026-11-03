import { CheckpointRetryError, type RetryState } from './checkpointRetry.js';
import { codegenHash, parseCodegenAuthority, parseCodegenDecision, parseCodegenRequest, validateCodegenReceipt } from './codeGenerationContract.js';
import { qaBasis } from './qaAcceptance.js';
import { parseFileScope } from './developmentContract.js';

/** The first, wholly unapplied Policy-3 import only; no generic checkpoint jump. */
export function isCodegenImportRecovery(state: RetryState): boolean {
  const v = state.values ?? {}, log = v['log'] as Array<{ step?: string; summary?: string; traceId?: string }> | undefined;
  const history = v['qa_history'] as Array<Record<string, unknown>> | undefined;
  return state.status === 'interrupted' && !state.error && state.next?.join(',') === 'requirements_input'
    && v['qa_acceptance_policy_version'] === 1 && v['qa_environment_policy_version'] === 3 && v['code_generation_policy_version'] === 1
    && !v['code_generation_recovery_count'] && !v['code_generation_receipt'] && !v['code_generation_failure']
    && !v['code_generation_repair_count'] && !v['code_generation_repair_pending'] && !v['code_generation_needs_repair']
    && v['qa_artifact'] === null && v['qa_receipt'] === null && v['stack_result'] === null && v['stack_plan'] === null
    && !['tests_passed', 'review_passed', 'retry_count', 'fix_applied', 'fix_output', 'review', 'test_output', 'human_approved',
      'pr_approved', 'branch_pushed', 'commit_sha', 'pr_url', 'ci_run'].some(k => Boolean(v[k]))
    && ['plan', 'context', 'qa_test_plan', 'code'].every(k => typeof v[k] === 'string' && Boolean(v[k]))
    && Array.isArray(log) && log.map(x => x.step).join(',') === 'setup_workspace,planner,knowledge,test_design,generation_plan,coder,code_generation'
    && log.slice(1, 6).every(x => /^[a-f0-9-]{36}$/.test(x.traceId ?? ''))
    && log.at(-1)?.summary?.startsWith('[codegen_source_changed] ') === true
    && Array.isArray(v['workflow_blockers']) && v['workflow_blockers'].length === 1 && v['workflow_blockers'][0] === log.at(-1)?.summary
    && Array.isArray(history) && history.at(-1)?.phase === 'code_generation_rejected' && history.at(-1)?.code === 'codegen_source_changed';
}

export async function previewCodegenImport(state: RetryState, fetchFn: typeof fetch = fetch) {
  if (!isCodegenImportRecovery(state)) throw new CheckpointRetryError('No eligible unapplied generator import.');
  const v = state.values!;
  const decision = parseCodegenDecision(JSON.stringify(v['code_generation_decision']), parseFileScope(String(v['allowed_files'] ?? '')));
  if (decision.status !== 'ready') throw new CheckpointRetryError('The frozen generator plan is missing.');
  // Routing only; Core verifies original provenance and renews exact authority.
  const claims = JSON.parse(Buffer.from(String(v['argus_execution_grant']).split('.')[1] ?? '', 'base64url').toString());
  const authority = parseCodegenAuthority(claims.codeGeneration);
  if (claims.testEnvironmentPolicy !== 'workspace-session-v1' || claims.rootTraceId !== state.thread_id
    || claims.workspaceRoot !== v['workspace_dir']) throw new CheckpointRetryError('Generator authority does not match this workspace.');
  const base = process.env['AGENT_WORKSPACE_URL'] ?? 'http://agent-workspace:3001';
  const privateCall = async (route: string, body: unknown) => {
    const response = await fetchFn(base + route, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-workspace-secret': process.env['WORKSPACE_SECRET'] ?? '' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new CheckpointRetryError('Completed generator/import evidence is missing, changed, active or already consumed. No replay was started.');
    return await response.json() as Record<string, unknown>;
  };
  const basisSha256 = qaBasis(v);
  const snapshot = await privateCall('/stack-tests', { action: 'inspect', threadId: state.thread_id, workspaceRoot: v['workspace_dir'],
    baseCommitSha: v['base_commit_sha'], basisSha256, executionMode: 'workspace-session-v1' });
  const input = parseCodegenRequest({ action: 'generate', baseCommitSha: v['base_commit_sha'], basisSha256,
    sourceSha256: snapshot['sourceSha256'], plan: decision.plan, executionMode: 'workspace-session-v1' }, authority.allowedPaths);
  const request = { ...input, threadId: state.thread_id, workspaceRoot: v['workspace_dir'], allowedPaths: authority.allowedPaths };
  const proof = await privateCall('/code-generation/recovery-preview', request);
  if (proof['version'] !== 1 || proof['requestSha256'] !== codegenHash(request) || proof['sourceSha256'] !== input.sourceSha256
    || proof['planSha256'] !== codegenHash(input.plan) || !/^[a-f0-9]{64}$/.test(String(proof['recoveryDigest']))
    || !/^[a-f0-9]{64}$/.test(String(proof['brokerRequestSha256']))) throw new CheckpointRetryError('Invalid completed generator proof.');
  return { input, proof, authority };
}

export async function recoverCodegenImport(state: RetryState, grant: string, checked: Awaited<ReturnType<typeof previewCodegenImport>>, fetchFn: typeof fetch = fetch) {
  const claims = JSON.parse(Buffer.from(grant.split('.')[1] ?? '', 'base64url').toString());
  const reviewer = claims.coreAgents?.find((a: { name: string }) => a.name === 'reviewer');
  if (!reviewer || codegenHash(parseCodegenAuthority(claims.codeGeneration)) !== codegenHash(checked.authority)
    || claims.testEnvironmentPolicy !== 'workspace-session-v1') throw new CheckpointRetryError('Fresh generator capability changed.');
  const response = await fetchFn((process.env['ARGUS_URL'] ?? 'http://mcp-server:3000') + `/api/agents/${reviewer.id}/code-generation/recover`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + grant, 'x-argus-root-trace-id': state.thread_id },
    body: JSON.stringify({ ...checked.input, recoveryDigest: checked.proof['recoveryDigest'] }), signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new CheckpointRetryError('Import recovery was not confirmed. Inspect evidence; no automatic replay.');
  const receipt = validateCodegenReceipt(checked.input, state.thread_id, await response.json());
  if (receipt.requestSha256 !== checked.proof['requestSha256'] || receipt.brokerRequestSha256 !== checked.proof['brokerRequestSha256'])
    throw new CheckpointRetryError('Recovered import receipt changed.');
  return receipt;
}
