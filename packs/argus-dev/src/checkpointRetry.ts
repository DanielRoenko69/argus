import { createHash } from 'node:crypto';
import type { PackExecutionGrant } from './executionGrant.js';
import { repositoryScopeViolations } from './repositoryScope.js';
import { stackHash, stackPlanSchema } from './stackEnvironment.js';
import { isCodegenImportRecovery } from './codegenRecovery.js';

type RecordValue = Record<string, unknown>;
export interface RetryState {
  thread_id: string; graph_id: string; status: string; error?: string | null;
  metadata: RecordValue; values?: RecordValue; next?: readonly string[];
  checkpoint_id?: string | null; interrupts?: unknown[];
}
export class CheckpointRetryError extends Error {
  readonly status = 409;
}
const fail = (message: string): never => { throw new CheckpointRetryError(message); };
const supportedNodes = new Set(['planner', 'knowledge', 'test_design', 'coder', 'tests', 'reviewer']);
/** Exact pre-dispatch Core authentication failure, NOT a provider/worker error.
 * Live recovery additionally requires a clean checkout, idle runtimes and only
 * the two recorded, completed Agent traces. No QA output can be overwritten. */
export function isPreQaGrantRecovery(state: RetryState): boolean {
  const v = state.values ?? {};
  const error = /^Argus code index authorization failed \(401\): (.+)$/.exec(state.error ?? '');
  let body: RecordValue = {};
  try { body = JSON.parse(error?.[1] ?? '{}'); } catch { return false; }
  const entries = v['log'] as Array<{ step?: string; traceId?: string }> | undefined;
  return body['code'] === 'execution_grant_expired'
    && body['error'] === 'execution grant is expired or has an invalid lifetime'
    && state.next?.join(',') === 'test_design' && v['qa_acceptance_policy_version'] === 1
    && typeof v['plan'] === 'string' && Boolean(v['plan']) && typeof v['context'] === 'string' && Boolean(v['context'])
    && v['qa_artifact'] === null && v['qa_receipt'] === null && v['qa_response_receipt'] === null
    && Array.isArray(v['qa_history']) && v['qa_history'].length === 0
    && Array.isArray(v['workflow_blockers']) && v['workflow_blockers'].length === 0
    && !['code', 'codex_thread_id', 'review', 'test_output', 'tests_passed', 'review_passed', 'retry_count',
      'qa_test_plan', 'qa_review_repair_pending', 'qa_review_repair_count', 'technical_response_failure'].some(key => Boolean(v[key]))
    && ['revision_history', 'file_diffs', 'test_profiles', 'failed_tests'].every(key => v[key] == null
      || Array.isArray(v[key]) && (v[key] as unknown[]).length === 0)
    && Array.isArray(entries) && entries.map(e => e.step).join(',') === 'setup_workspace,planner,knowledge'
    && entries.slice(1).every(e => /^[a-f0-9-]{36}$/.test(e.traceId ?? ''));
}

export function assertPreQaGrantTraces(state: RetryState, traces: Array<{ id: string; status: string }>): void {
  const expected = (state.values?.['log'] as Array<{ traceId?: string }>).slice(1).map(e => e.traceId);
  if (traces.length !== 2 || traces.some(t => t.status !== 'completed' || !expected.includes(t.id))
    || new Set(traces.map(t => t.id)).size !== 2) fail('Unexpected or incomplete Agent evidence; pre-QA authorization recovery is unavailable.');
}
/** Narrow crash recovery: installed stack reconciled separately, no test/QA
 * execution or delivery yet. Runtime evidence is additionally checked live. */
export function isStackSnapshotRecovery(state: RetryState): boolean {
  const v = state.values ?? {};
  const history = v['qa_history'] as RecordValue[] | undefined;
  const last = Array.isArray(history) ? history.at(-1) : undefined;
  return state.error === 'Continuation interrupted by server restart; worker reconciliation required. No automatic replay.'
    && state.next?.join(',') === 'tests' && v['qa_acceptance_policy_version'] === 1 && v['qa_environment_policy_version'] === 2
    && !v['stack_snapshot_recovery_pending'] && Number(v['stack_snapshot_recovery_count'] ?? 0) === 0
    && !v['qa_review_repair_pending'] && v['qa_artifact'] === null && v['qa_receipt'] === null && v['stack_result'] === null
    && !v['tests_passed'] && !v['review_passed'] && Boolean(v['code']) && Boolean(v['qa_test_plan'])
    && Array.isArray(v['workflow_blockers']) && v['workflow_blockers'].length === 0
    && stackPlanSchema.safeParse(v['stack_plan']).success && last?.['phase'] === 'stack_plan'
    && /^[a-f0-9]{64}$/.test(String(last['sourceSha256'])) && stackHash(last['plan']) === stackHash(v['stack_plan']);
}
// Server-owned graph predecessors, never caller-selected node jumps. Updating
// credentials without asNode lets LangGraph infer the pending node as the writer
// and can advance past it. Re-arm the exact failed node instead.
export const CHECKPOINT_PREDECESSOR: Record<string, string> = {
  planner: 'setup_workspace', knowledge: 'planner', test_design: 'knowledge',
  coder: 'test_design', tests: 'coder', reviewer: 'tests',
};

/** Intentionally excludes setup/reset, approval gates and every delivery node. */
export function checkpointRetryNode(state: RetryState): string {
  const values = state.values ?? {};
  if (isCodegenImportRecovery(state)) {
    // Reuse provenance/delivery guards, not the generic QA replay exception.
    verifyCheckpointProvenance({ ...state, status: 'failed', next: ['coder'], interrupts: [] });
    return 'code_generation';
  }
  if (values['qa_review_repair_pending'] || (state.next?.includes('test_design') && Number(values['qa_review_repair_count'] ?? 0) > 0)) {
    fail('The bounded QA correction cannot be replayed. Inspect its result or configure a new attempt.');
  }
  if (values['qa_acceptance_policy_version'] === 1 && !isStackSnapshotRecovery(state) && !isPreQaGrantRecovery(state)) fail('Independent QA runs require a configured new attempt after interruption; checkpoint replay is not yet certified for this policy.');
  return verifyCheckpointProvenance(state);
}

/** Saved responses and bounded omission corrections may reuse a clean pre-Coder
 * checkpoint. This is not permission to replay implementation or change policy. */
export function assertSavedQaRecoveryCheckpoint(state: RetryState, requirePreImplementation = false): void {
  const values = state.values ?? {};
  if (!requirePreImplementation && values['qa_acceptance_policy_version'] !== 1) { checkpointRetryNode(state); return; }
  if (state.next?.join(',') !== 'test_design') fail('Saved QA recovery must precede implementation.');
  if (values['qa_artifact'] !== null || values['qa_receipt'] !== null
    || !Array.isArray(values['qa_history']) || values['qa_history'].length) fail('Independent QA artifacts already exist or their provenance is incomplete.');
  const preImplementationSteps = new Set(['setup_workspace', 'planner', 'knowledge', 'test_design', 'design_refinement',
    'technical_resolution', 'technical_investigation', 'technical_experiment', 'technical_experiment_review']);
  const entries = values['log'] as Array<{ step?: string }> | undefined;
  if (!Array.isArray(entries) || !entries.length || entries.some(e => !e || !preImplementationSteps.has(e.step ?? ''))
    || !['setup_workspace', 'planner', 'knowledge', 'test_design'].every(step => entries.some(e => e.step === step))) {
    fail('Saved QA recovery requires complete pre-implementation phase evidence.');
  }
  if (['code', 'codex_thread_id', 'review', 'test_output', 'tests_passed', 'review_passed', 'retry_count', 'fix_output', 'fix_applied']
    .some(key => Boolean(values[key]))
    || ['revision_history', 'file_diffs', 'test_profiles', 'failed_tests'].some(key => values[key] != null
      && (!Array.isArray(values[key]) || (values[key] as unknown[]).length > 0))) {
    fail('Implementation or test evidence already exists; saved pre-implementation QA recovery is unavailable.');
  }
  verifyCheckpointProvenance(state);
}

function verifyCheckpointProvenance(state: RetryState): string {
  const values = state.values ?? {};
  if (state.status !== 'failed') fail('Only a failed, stopped workflow can continue.');
  if (state.graph_id !== 'coding_workflow') fail('Checkpoint continuation currently supports Ticket to pull request only.');
  if (!state.checkpoint_id || state.next?.length !== 1 || !supportedNodes.has(state.next[0]!)) {
    fail('No supported pre-delivery checkpoint. Configure a new attempt instead.');
  }
  if (state.interrupts?.length || values['human_approved'] || values['pr_approved']
    || values['branch_pushed'] || values['commit_sha'] || values['pr_url'] || values['ci_run']) {
    fail('Approvals or delivery evidence already exist. This continuation cannot replay external writes.');
  }
  if (state.metadata['source'] !== 'a2a' || typeof state.metadata['execution_principal'] !== 'string'
    || !state.metadata['execution_grant_id'] || !values['argus_execution_grant']) fail('Verified execution provenance is missing.');
  if (!/^\/workspace\/[A-Za-z0-9-]+$/.test(String(values['workspace_dir'] ?? ''))
    || values['workspace_dir'] !== values['argus_workspace_root']
    || !/^[a-f0-9]{40}$/.test(String(values['base_commit_sha'] ?? ''))
    || values['repository_scope_policy'] !== 'development-v1') fail('Workspace/base-commit provenance is incomplete.');
  return state.next![0]!;
}

export function assertCheckpointGrant(state: RetryState, grant: PackExecutionGrant): void {
  const ids = (value: unknown) => Array.isArray(value) ? [...value].sort((a, b) => Number(a) - Number(b)).join(',') : '';
  if (`${grant.claims.principalKind}:${grant.claims.principalId}` !== state.metadata['execution_principal']
    || grant.claims.workspaceRoot !== state.values?.['workspace_dir']
    || grant.claims.rootTraceId !== state.thread_id
    || ids(grant.claims.bundleIds) !== ids(state.metadata['execution_bundle_ids'])
    || JSON.stringify(grant.claims.runtimeProfileOverrides ?? []) !== JSON.stringify(state.metadata['execution_runtime_overrides'] ?? [])) {
    fail('Fresh execution grant does not match the frozen owner, workspace, Bundles and runtime.');
  }
}

export type WorkerStatus = { provider: string; runs?: RecordValue[] };
export function stoppedWorkerReceipt(state: RetryState, statuses: WorkerStatus[]): RecordValue | undefined {
  const match = /(?:Codex|Claude(?: Code)?) runtime.*?\(run ([a-f0-9-]{36})[,)]/i.exec(state.error ?? '');
  if (!match) return undefined;
  for (const status of statuses) {
    const run = status.runs?.find(item => item['id'] === match[1] && item['cwd'] === state.values?.['workspace_dir']
      && typeof item['finishedAt'] === 'string' && Number.isFinite(Date.parse(item['finishedAt'])));
    if (run) return { id: run['id'], cwd: run['cwd'], finishedAt: run['finishedAt'], provider: status.provider, threadId: state.thread_id };
  }
  return undefined;
}

/** Lost connections require an exact terminal worker receipt, not just an empty queue. */
export function assertStoppedWorker(state: RetryState, statuses: WorkerStatus[]): void {
  const runs: RecordValue[] = statuses.flatMap(status => (status.runs ?? []).map(run => ({ ...run, provider: status.provider })));
  const active = runs.some(run => run['cwd'] === state.values?.['workspace_dir'] && !run['finishedAt']);
  if (active) fail('A worker is still using this workspace. Wait for its terminal result.');
  const saved = state.metadata['checkpoint_worker_receipt'] as RecordValue | undefined;
  const savedStatuses = saved && saved['threadId'] === state.thread_id ? [{ provider: String(saved['provider']), runs: [saved] }] : [];
  if (!stoppedWorkerReceipt(state, statuses) && !stoppedWorkerReceipt(state, savedStatuses)) {
    fail('The failed worker’s terminal receipt is unavailable. Configure a new attempt; an uncertain worker cannot be replayed.');
  }
}

export function workspaceRetryDigest(state: RetryState, evidence: { head: string; origin: string; expectedOrigin: string; status: string; contentHashes: string }): string {
  if (evidence.head.trim() !== state.values?.['base_commit_sha']
    || evidence.origin.trim().replace(/\.git$/, '') !== evidence.expectedOrigin.replace(/\.git$/, '')) {
    fail('The workspace repository or base commit changed. Configure a new attempt.');
  }
  if (repositoryScopeViolations(evidence.status, String(state.values?.['allowed_files'] ?? '')).length) {
    fail('The workspace contains changes outside the approved development scope.');
  }
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
