import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyTechnicalProposal, createQaReviewBinding, technicalResponseFailure, MissingQaReviewsError, applyBoundTechnicalReview, applyMissingQaReviewCorrection } from './technicalDesign.js';
import { retainQaResponse, recheckQaResponse, prepareQaRetry, qaResponseBasis, assertQaWorkspaceIdle, withoutQaResponseReceipt, qaReviewCorrectionContext } from './qaResponseRecovery.js';
import { checkpointRetryNode } from './checkpointRetry.js';
import type { RetryState } from './checkpointRetry.js';

function fixture() {
  const threadId = randomUUID(), traceId = randomUUID();
  const proposal = applyTechnicalProposal({ workflow_blockers: [] }, JSON.stringify({ outcome: { version: 2, status: 'ready', summary: 'Plan', blockers: [] },
    decisions: [{ id: 'api', topic: 'API', specification: 'reject zero', rationale: 'positive size', requirementRefs: ['issue'], evidence: ['src/api.py:1'] }], resolutions: [] }));
  const values = { ...proposal, development_contract_version: 2, technical_design_policy_version: 1,
    workspace_dir: '/workspace/RECOVERY', argus_workspace_root: '/workspace/RECOVERY', repository_scope_policy: 'development-v1',
    base_commit_sha: 'a'.repeat(40), argus_execution_grant: 'private', design_refinement_count: 2, technical_investigation_count: 1 };
  const response = JSON.stringify({ outcome: { version: 2, status: 'ready', summary: 'QA', blockers: [] },
    reviews: [{ decisionId: 'api', digest: proposal.technical_decisions[0]!.digest, verdict: 'accept', evidence: ['independent reference'] }],
    testCases: [{ id: 'long_test_'.repeat(8), decisionIds: ['api'], scenario: 'zero size', input: 'API(0)', expected: 'ValueError', oracle: 'positive size requirement', evidence: ['issue'], targetFiles: ['tests/test_api.py'] }] });
  const state: RetryState = { thread_id: threadId, graph_id: 'coding_workflow', status: 'interrupted', checkpoint_id: randomUUID(),
    next: ['requirements_input'], interrupts: [{ stage: 'requirements_input' }],
    metadata: { source: 'a2a', execution_principal: 'user:3', execution_grant_id: randomUUID() },
    values: { ...values, ...technicalResponseFailure('qa', new SyntaxError()),
      log: [{ step: 'test_design', traceId }], qa_response_receipt: retainQaResponse(values, threadId, traceId, response) } };
  return state;
}
test('recheck is pure, deterministic and retains budgets while repairing only labels', () => {
  const state = fixture(), original = JSON.stringify(state);
  const a = recheckQaResponse(state), b = recheckQaResponse(state);
  assert.equal(a.reviewDigest, b.reviewDigest); assert.equal(JSON.stringify(state), original);
  assert.equal(a.update.technical_design_history[0]!.responseRepairs.length, 1);
  assert.equal(a.update.technical_decisions[0]!.status, 'qa_checked');
  assert.equal(state.values!.design_refinement_count, 2); assert.equal(state.values!.technical_investigation_count, 1);
  assert.ok(!Object.hasOwn(a.update, 'human_approved')); assert.ok(!Object.hasOwn(a.update, 'pr_approved'));
});
test('rejects legacy evidence gaps, changed provenance, scope, budgets, design, content and delivery', () => {
  const mutations: Array<(s: RetryState) => void> = [
    s => delete s.values!.qa_response_receipt, s => { s.status = 'canceled'; }, s => { s.next = ['approval']; },
    s => { s.values!.human_approved = true; }, s => { s.values!.ci_run = {}; }, s => { s.values!.plan = 'different'; },
    s => { s.values!.technical_investigation_count = 0; }, s => { s.values!.issue_snapshot = { sha256: 'changed' }; },
    s => { s.values!.operator_clarifications = ['new']; }, s => { s.values!.allowed_files = 'src/only'; },
    s => { s.values!.log = [{ step: 'test_design', traceId: randomUUID() }]; },
    s => { (s.values!.qa_response_receipt as any).response += ' '; },
    s => { (s.values!.qa_response_receipt as any).threadId = randomUUID(); },
    s => { s.values!.technical_response_failure = { phase: 'qa', category: 'integrity' }; },
  ];
  for (const mutate of mutations) { const s = fixture(); mutate(s); assert.throws(() => recheckQaResponse(s)); assert.throws(() => prepareQaRetry(s)); }
});
test('explicit QA retry validates provenance, not bad model hashes, and never changes old evidence', () => {
  const s = fixture(), receipt = s.values!.qa_response_receipt as any, response = JSON.parse(receipt.response);
  response.reviews[0].digest += 'e';
  s.values!.qa_response_receipt = retainQaResponse(s.values!, s.thread_id, receipt.traceId, JSON.stringify(response));
  const original = JSON.stringify(s), a = prepareQaRetry(s);
  assert.equal(a.reviewDigest, prepareQaRetry(s).reviewDigest);
  assert.equal(a.receipt.response, JSON.stringify(response));
  assert.equal(JSON.stringify(s), original); assert.throws(() => recheckQaResponse(s));
  s.checkpoint_id = randomUUID(); assert.notEqual(prepareQaRetry(s).reviewDigest, a.reviewDigest);
});
test('bound receipts recheck using the exact server binding; altered bindings cannot pass', () => {
  const s = fixture(), receipt = s.values!.qa_response_receipt as any, response = JSON.parse(receipt.response);
  response.version = 2; delete response.reviews[0].digest;
  const binding = createQaReviewBinding(s.values as any, qaResponseBasis(s.values!));
  s.values!.qa_response_receipt = retainQaResponse(s.values!, s.thread_id, receipt.traceId, JSON.stringify(response), binding);
  assert.equal(recheckQaResponse(s).update.technical_decisions[0]!.status, 'qa_checked');
  binding.decisions[0]!.digest = 'f'.repeat(64); assert.throws(() => recheckQaResponse(s));
});
test('saved domain blockers cannot be converted into a passing review', () => {
  const s = fixture(), receipt = s.values!.qa_response_receipt as any, response = JSON.parse(receipt.response);
  response.outcome.status = 'blocked'; response.outcome.blockers = [{ kind: 'design', source: 'proposal', summary: 'Unsupported oracle', evidence: ['issue criterion 2'] }];
  s.values!.qa_response_receipt = retainQaResponse(s.values!, s.thread_id, receipt.traceId, JSON.stringify(response));
  assert.throws(() => recheckQaResponse(s), /still contains/);
});
test('retained completion never overrides active or missing worker status', () => {
  const s = fixture(); assertQaWorkspaceIdle(s, [{ provider: 'codex', runs: [] }, { provider: 'claude', runs: [] }]);
  assert.throws(() => assertQaWorkspaceIdle(s, []));
  assert.throws(() => assertQaWorkspaceIdle(s, [{ provider: 'codex', runs: [{ cwd: '/workspace/RECOVERY' }] }, { provider: 'claude', runs: [] }]));
});
test('raw response is bounded and omitted from public projections', () => {
  const s = fixture(); assert.equal(withoutQaResponseReceipt(s.values!).qa_response_receipt, undefined);
  assert.equal(retainQaResponse({}, s.thread_id, randomUUID(), 'x'.repeat(128001)), null);
  assert.equal(retainQaResponse({}, s.thread_id, 'unknown', 'data'), null);
});

function independentQaFixture() {
  const s = fixture(), old = s.values!.qa_response_receipt as any, response = JSON.parse(old.response);
  response.version = 2; delete response.reviews[0].digest;
  Object.assign(s.values!, { qa_acceptance_policy_version: 1, qa_artifact: null, qa_receipt: null, qa_history: [],
    log: ['setup_workspace', 'planner', 'knowledge'].map(step => ({ step })).concat([{ step: 'test_design', traceId: old.traceId }] as any) });
  const binding = createQaReviewBinding(s.values as any, qaResponseBasis(s.values!));
  s.values!.qa_response_receipt = retainQaResponse(s.values!, s.thread_id, old.traceId, JSON.stringify(response) + '}', binding);
  return s;
}
test('policy-1 saved QA recheck fixes syntax without replay, state mutation, budget or policy changes', () => {
  const s = independentQaFixture(), before = JSON.stringify(s), result = recheckQaResponse(s);
  assert.equal(JSON.stringify(s), before);
  assert.equal(result.update.technical_design_history[0]!.responseRepairs.length, 2);
  assert.ok(result.update.technical_design_history[0]!.responseRepairs.some(r => 'kind' in r && r.kind === 'trailing_object_closer'));
  assert.equal(result.update.technical_decisions[0]!.status, 'qa_checked');
  assert.ok(!Object.hasOwn(result.update, 'qa_acceptance_policy_version'));
  assert.ok(!Object.hasOwn(result.update, 'human_approved'));
  assert.throws(() => prepareQaRetry(s), /configured new attempt/);
});
test('policy-1 recovery refuses prior Coder/QA activity, missing evidence, delivery and stale provenance', () => {
  const mutations: Array<(s: RetryState) => void> = [
    s => { s.values!.qa_artifact = {}; }, s => { s.values!.qa_receipt = {}; }, s => { s.values!.qa_history = [{}]; },
    s => { delete s.values!.qa_history; }, s => { delete s.values!.qa_artifact; },
    s => { s.values!.code = 'existing implementation'; }, s => { s.values!.codex_thread_id = 'old-worker'; },
    s => { s.values!.retry_count = 1; }, s => { s.values!.revision_history = [{}]; }, s => { s.values!.file_diffs = [{}]; },
    s => { s.values!.tests_passed = true; }, s => { s.values!.log = [{ step: 'test_design' }]; },
    s => { (s.values!.log as any[]).push({ step: 'coder' }); }, s => { s.values!.human_approved = true; },
    s => { s.values!.ci_run = {}; }, s => { s.values!.plan = 'changed'; }, s => { s.metadata = {}; },
    s => { (s.values!.qa_response_receipt as any).binding = undefined; },
  ];
  for (const mutate of mutations) { const s = independentQaFixture(); mutate(s); assert.throws(() => recheckQaResponse(s)); }
});

function omissionFixture() {
  const s = independentQaFixture(), values = s.values!, old = values.qa_response_receipt as any;
  const decisions = values.technical_decisions as any[];
  values.technical_decisions = Array.from({ length: 8 }, (_, index) => ({ ...decisions[0], id: `decision_${index}` }));
  const response = { version: 2, outcome: { version: 2, status: 'ready', summary: 'QA', blockers: [] },
    reviews: (values.technical_decisions as any[]).slice(0, 7).map(d => ({ decisionId: d.id, verdict: 'accept', evidence: ['Independent evidence'] })),
    testCases: Array.from({ length: 13 }, (_, i) => ({ id: `test_${i}`, decisionIds: [`decision_${i % 8}`],
      scenario: 'boundary', input: 'API(0)', expected: 'ValueError', oracle: 'Positive requirement', evidence: ['issue'], targetFiles: ['tests/test_api.py'] })) };
  const binding = createQaReviewBinding(values as any, qaResponseBasis(values));
  Object.assign(values, technicalResponseFailure('qa', new Error('historical generic integrity error')));
  values.qa_response_receipt = retainQaResponse(values, s.thread_id, old.traceId, JSON.stringify(response), binding);
  return s;
}
function original(s: RetryState) { return JSON.parse((s.values!.qa_response_receipt as any).response); }
function replaceResponse(s: RetryState, response: any) {
  const old = s.values!.qa_response_receipt as any;
  s.values!.qa_response_receipt = retainQaResponse(s.values!, s.thread_id, old.traceId, JSON.stringify(response), old.binding);
}
test('exact 8 decisions / 7 reviews / 13 tests omission is eligible without mutating the historical checkpoint', () => {
  const s = omissionFixture(), before = JSON.stringify(s), preview = prepareQaRetry(s);
  assert.equal(preview.retryKind, 'missing_reviews'); assert.deepEqual(preview.missingDecisionIds, ['decision_7']);
  assert.equal(JSON.stringify(s), before); assert.equal(s.values!.qa_acceptance_policy_version, 1);
  assert.throws(() => applyBoundTechnicalReview(s.values as any, preview.receipt.response, preview.receipt.binding!, qaResponseBasis(s.values!)), MissingQaReviewsError);
  assert.throws(() => recheckQaResponse(s), /explicit bounded correction/);
});
test('omission repair rejects other integrity failures, invalid tests, domain findings and contradictory verdicts', () => {
  const mutations = [
    (r: any) => { r.reviews[0].decisionId = 'unknown'; },
    (r: any) => { r.reviews.push(r.reviews[0]); },
    (r: any) => { r.reviews[0].verdict = 'revise'; },
    (r: any) => { r.testCases = []; },
    (r: any) => { r.testCases[0].decisionIds = ['unknown']; },
    (r: any) => { delete r.testCases[0].expected; },
    (r: any) => { r.outcome.status = 'blocked'; r.outcome.blockers = [{ kind: 'environment', source: 'repository', summary: 'Missing', evidence: ['repo'] }]; },
  ];
  for (const mutate of mutations) { const s = omissionFixture(), response = original(s); mutate(response); replaceResponse(s, response); assert.throws(() => prepareQaRetry(s)); }
});
test('omission repair is bound to original provenance, pre-implementation state and one persisted reservation', () => {
  const mutations: Array<(s: RetryState) => void> = [
    s => { s.values!.qa_review_repair_count = 1; }, s => { s.values!.qa_review_repair_pending = true; },
    s => { s.values!.qa_artifact = {}; }, s => { s.values!.code = 'code'; }, s => { s.values!.qa_history = [{}]; },
    s => { s.values!.plan = 'changed'; }, s => { s.values!.human_approved = true; }, s => { s.values!.ci_run = {}; },
    s => { s.metadata = {}; }, s => { s.values!.log = []; },
    s => { (s.values!.qa_response_receipt as any).binding.decisions[0].digest = 'e'.repeat(64); },
    s => { (s.values!.qa_response_receipt as any).threadId = randomUUID(); },
    s => { (s.values!.qa_response_receipt as any).response += ' '; },
  ];
  for (const mutate of mutations) { const s = omissionFixture(); mutate(s); assert.throws(() => prepareQaRetry(s)); }
  const s = omissionFixture(); s.values!.qa_acceptance_policy_version = 0; s.values!.code = 'code';
  assert.throws(() => prepareQaRetry(s), /Implementation/);
});
test('correction preserves all seven verdicts and thirteen tests; the missing verdict can accept or reject', () => {
  const s = omissionFixture(), receipt = prepareQaRetry(s).receipt;
  const corrected = original(s); corrected.reviews.push({ decisionId: 'decision_7', verdict: 'accept', evidence: ['Independent final check'] });
  const apply = (r: any) => applyMissingQaReviewCorrection(s.values as any, receipt.response, JSON.stringify(r), receipt.binding!, qaResponseBasis(s.values!));
  const accepted = apply(corrected);
  assert.equal(accepted.technical_decisions.filter(d => d.status === 'qa_checked').length, 8);
  assert.equal(JSON.parse(accepted.qa_test_plan).testCases.length, 13);
  for (const mutate of [
    (r: any) => { r.reviews.pop(); }, (r: any) => { r.reviews[0].evidence = ['rewritten']; },
    (r: any) => { r.testCases.pop(); }, (r: any) => { r.testCases[0].expected = 'anything'; },
    (r: any) => { r.reviews.push(r.reviews[0]); },
  ]) { const r = structuredClone(corrected); mutate(r); assert.throws(() => apply(r)); }
  corrected.reviews[7].verdict = 'revise'; corrected.outcome.status = 'blocked';
  corrected.outcome.blockers = [{ kind: 'environment', source: 'repository', summary: 'Independent evidence unavailable', evidence: ['repository check'] }];
  const rejected = apply(corrected); assert.equal(rejected.workflow_blockers.length, 1);
  assert.equal(rejected.technical_decisions[7]!.status, 'proposed');
  assert.deepEqual(JSON.parse(rejected.qa_test_plan).testCases, original(s).testCases);
});
test('reserved correction prompt revalidates source and cannot be replayed after a worker/transport failure', () => {
  const s = omissionFixture(); assert.equal(qaReviewCorrectionContext(s.values!, s.thread_id), null);
  Object.assign(s.values!, { qa_review_repair_count: 1, qa_review_repair_pending: true });
  const context = qaReviewCorrectionContext(s.values!, s.thread_id)!;
  assert.deepEqual(context.missingDecisionIds, ['decision_7']); assert.match(context.prompt, /untrusted prior QA output/);
  assert.match(context.prompt, /all existing reviews and testCases unchanged/);
  assert.throws(() => prepareQaRetry(s), /already been reserved/);
  s.values!.qa_acceptance_policy_version = 0;
  assert.throws(() => checkpointRetryNode({ ...s, status: 'failed', next: ['test_design'] }), /cannot be replayed/);
  s.values!.plan = 'drift'; assert.throws(() => qaReviewCorrectionContext(s.values!, s.thread_id), /original evidence/);
});
