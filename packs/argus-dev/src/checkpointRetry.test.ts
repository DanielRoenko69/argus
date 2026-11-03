import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpointRetryNode, isStackSnapshotRecovery, isPreQaGrantRecovery, assertPreQaGrantTraces, assertCheckpointGrant, assertStoppedWorker, stoppedWorkerReceipt, workspaceRetryDigest, type RetryState } from './checkpointRetry.js';
import type { PackExecutionGrant } from './executionGrant.js';
const worker = '935b2a13-cd6a-498b-adcb-59577b977faa';
const state = (): RetryState => ({ thread_id: 'thread', graph_id: 'coding_workflow', status: 'failed',
  error: `Codex runtime request failed (run ${worker}, implement_ticket): fetch failed`, checkpoint_id: 'checkpoint', next: ['coder'], interrupts: [],
  metadata: { source: 'a2a', execution_principal: 'user:3', execution_grant_id: 'grant', execution_bundle_ids: [3, 47] },
  values: { argus_execution_grant: 'old', workspace_dir: '/workspace/TICKET', argus_workspace_root: '/workspace/TICKET', base_commit_sha: 'a'.repeat(40), repository_scope_policy: 'development-v1' } });
test('only failed pre-delivery checkpoints with complete provenance', () => {
  assert.equal(checkpointRetryNode(state()), 'coder');
  for (const status of ['running', 'queued', 'canceling', 'canceled', 'completed', 'interrupted']) assert.throws(() => checkpointRetryNode({ ...state(), status }));
  for (const node of ['setup_workspace', 'human_approval', 'finalize_build', 'external_ci', 'finalize_pr', 'finalize']) assert.throws(() => checkpointRetryNode({ ...state(), next: [node] }));
  for (const key of ['human_approved', 'pr_approved', 'branch_pushed', 'commit_sha', 'ci_run', 'pr_url']) {
    const s = state(); s.values![key] = true; assert.throws(() => checkpointRetryNode(s));
  }
  assert.throws(() => checkpointRetryNode({ ...state(), next: ['coder', 'tests'] }));
  assert.throws(() => checkpointRetryNode({ ...state(), metadata: {} }));
  assert.throws(() => checkpointRetryNode({ ...state(), interrupts: [{}] }));
});
test('fresh grants cannot change principal, Bundle, workspace or runtime', () => {
  const grant = { token: 'fresh', claims: { principalKind: 'user', principalId: '3', workspaceRoot: '/workspace/TICKET', rootTraceId: 'thread', bundleIds: [47, 3] } } as PackExecutionGrant;
  assert.doesNotThrow(() => assertCheckpointGrant(state(), grant));
  for (const change of [{ principalId: '7' }, { bundleIds: [47, 3, 9] }, { workspaceRoot: '/workspace/OTHER' }, { rootTraceId: 'other' }, { runtimeProfileOverrides: [{}] }]) {
    assert.throws(() => assertCheckpointGrant(state(), { ...grant, claims: { ...grant.claims, ...change } } as PackExecutionGrant));
  }
});
test('independent QA checkpoints cannot silently replay through the legacy retry path', () => {
  const s = state(); s.values!.qa_acceptance_policy_version = 1;
  assert.throws(() => checkpointRetryNode(s), /configured new attempt/);
  s.values!.qa_acceptance_policy_version = 0;
  assert.equal(checkpointRetryNode(s), 'coder');
});
test('pre-QA expired authorization is recoverable only before any QA dispatch or implementation', () => {
  const s = state(); s.next = ['test_design'];
  s.error = 'Argus code index authorization failed (401): {"error":"execution grant is expired or has an invalid lifetime","code":"execution_grant_expired"}';
  const planner = '11111111-1111-4111-8111-111111111111', knowledge = '22222222-2222-4222-8222-222222222222';
  Object.assign(s.values!, { qa_acceptance_policy_version: 1, plan: 'frozen plan', context: 'frozen knowledge', qa_artifact: null,
    qa_receipt: null, qa_response_receipt: null, qa_history: [], workflow_blockers: [],
    log: [{ step: 'setup_workspace' }, { step: 'planner', traceId: planner }, { step: 'knowledge', traceId: knowledge }] });
  assert.equal(isPreQaGrantRecovery(s), true); assert.equal(checkpointRetryNode(s), 'test_design');
  const traces = [{ id: planner, status: 'completed' }, { id: knowledge, status: 'completed' }];
  assert.doesNotThrow(() => assertPreQaGrantTraces(s, traces));
  for (const wrong of [[], [traces[0], traces[0]], [...traces, { id: worker, status: 'failed' }], [traces[0], { ...traces[1], status: 'running' }]]) {
    assert.throws(() => assertPreQaGrantTraces(s, wrong));
  }
  for (const delta of [{ code: 'changed' }, { qa_test_plan: 'existing' }, { qa_response_receipt: {} }, { qa_artifact: {} },
    { qa_history: [{}] }, { qa_review_repair_count: 1 }, { plan: '' }, { workflow_blockers: ['stop'] },
    { log: [...s.values!.log as unknown[], { step: 'test_design' }] }]) {
    assert.throws(() => checkpointRetryNode({ ...s, values: { ...s.values, ...delta } }));
  }
  for (const error of ['fetch failed', s.error.replace('401', '403'), s.error.replace('execution_grant_expired', 'execution_grant_revoked')]) {
    assert.throws(() => checkpointRetryNode({ ...s, error }));
  }
});
test('independent QA snapshot exception is pre-test, crash-only and one-shot; all delivery guards remain', () => {
  const plan={version:1,summary:'fixture',setup:'install',start:'start',test:'frozen-tests',python:'/bin/python'};
  const s=state(); s.next=['tests']; s.error='Continuation interrupted by server restart; worker reconciliation required. No automatic replay.';
  Object.assign(s.values!,{qa_acceptance_policy_version:1,qa_environment_policy_version:2,qa_artifact:null,qa_receipt:null,stack_result:null,
    code:'saved',qa_test_plan:'saved',workflow_blockers:[],stack_plan:plan,qa_history:[{phase:'stack_plan',plan,sourceSha256:'c'.repeat(64)}]});
  assert.equal(isStackSnapshotRecovery(s),true); assert.equal(checkpointRetryNode(s),'tests');
  for(const delta of [{qa_artifact:{}},{qa_receipt:{}},{stack_result:{}},{tests_passed:true},{review_passed:true},
    {qa_environment_policy_version:1},{stack_snapshot_recovery_count:1},{stack_snapshot_recovery_pending:true},
    {qa_review_repair_pending:true},{workflow_blockers:[{}]},{code:''},{qa_history:[]}]) {
    assert.throws(()=>checkpointRetryNode({...s,values:{...s.values,...delta}}));
  }
  for(const key of ['human_approved','branch_pushed','commit_sha','pr_url','ci_run'])
    assert.throws(()=>checkpointRetryNode({...s,values:{...s.values,[key]:true}}));
  assert.throws(()=>checkpointRetryNode({...s,error:'timeout'}));
  assert.throws(()=>checkpointRetryNode({...s,next:['qa_execute']}));
});
test('empty status or unrelated receipt is not terminal proof; active peers block', () => {
  const receipt = { id: worker, cwd: '/workspace/TICKET', finishedAt: new Date().toISOString() };
  assert.doesNotThrow(() => assertStoppedWorker(state(), [{ provider: 'codex', runs: [receipt] }]));
  for (const runs of [[], [{ ...receipt, finishedAt: undefined }], [{ ...receipt, id: 'other' }], [{ ...receipt, cwd: '/workspace/OTHER' }], [receipt, { id: 'other', cwd: '/workspace/TICKET' }]]) {
    assert.throws(() => assertStoppedWorker(state(), [{ provider: 'codex', runs }]));
  }
});
test('base/origin/protected files fail closed; content changes invalidate preview', () => {
  const evidence = { head: 'a'.repeat(40), origin: 'https://fixture/repo.git', expectedOrigin: 'https://fixture/repo.git', status: ' M src/main.py\n?? tests/test_main.py\n', contentHashes: 'one' };
  const digest = workspaceRetryDigest(state(), evidence);
  assert.notEqual(digest, workspaceRetryDigest(state(), { ...evidence, contentHashes: 'two' }));
  for (const change of [{ head: 'b'.repeat(40) }, { origin: 'https://fixture/other.git' }, { status: ' M Jenkinsfile\n' }, { status: "?? test';whoami\n" }]) {
    assert.throws(() => workspaceRetryDigest(state(), { ...evidence, ...change }));
  }
});

test('persisted terminal proof outlives retention, but never overrides a live worker or another attempt', () => {
  const s = state();
  s.metadata['checkpoint_worker_receipt'] = stoppedWorkerReceipt(s, [{ provider: 'codex', runs: [{ id: worker, cwd: '/workspace/TICKET', finishedAt: new Date().toISOString() }] }]);
  assert.doesNotThrow(() => assertStoppedWorker(s, [{ provider: 'codex', runs: [] }]));
  assert.throws(() => assertStoppedWorker(s, [{ provider: 'codex', runs: [{ id: 'other', cwd: '/workspace/TICKET' }] }]));
  assert.throws(() => assertStoppedWorker({ ...s, thread_id: 'other' }, []));
  assert.throws(() => assertStoppedWorker({ ...s, error: 'Unknown worker result' }, []));
});
