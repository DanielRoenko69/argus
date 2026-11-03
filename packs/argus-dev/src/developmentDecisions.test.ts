import test from 'node:test';
import assert from 'node:assert/strict';
import { StateGraph, MemorySaver, START, END, Command, interrupt } from '@langchain/langgraph';
import { WorkflowState } from './state.js';
import { requirementsInputNode } from './requirementsCheckpoint.js';
import { parseDevelopmentOutcome } from './developmentContract.js';
import { type DevelopmentFinding, DESIGN_REFINEMENT_WINDOW_MS, decisionRequest, designRefinementUpdate,
  effectiveFindings, mayRefineDesign, planningBlockerRoute, planningSources, refinementExpired,
  systemDevelopmentBlocker, validateDecisionReply, authoritativeDevelopmentBrief } from './developmentDecisions.js';

const finding: DevelopmentFinding = { kind: 'design', source: 'proposal',
  summary: 'Generated plan says (B,14), but scalar compatibility has 13 observable values.',
  evidence: ['Proposal revision 1: (B,14)', 'src/pmsm.py: state_names contains 13 observables'] };
const state = (f: DevelopmentFinding = finding) => ({ development_contract_version: 2,
  workflow_blockers: [f.summary], development_findings: [f], description: 'Match scalar behavior.', plan: 'Generated (B,14)', plan_revision: 1 });
const product: DevelopmentFinding = { kind: 'requirement', source: 'requirement', summary: 'Batch size is a product tradeoff.', evidence: ['issue#6'],
  question: 'Mehr Motoren gleichzeitig oder geringerer Speicherbedarf?', options: [
    { id: 'small', label: 'Weniger Speicher', consequence: 'Weniger Motoren pro Batch.' },
    { id: 'large', label: 'Mehr Motoren', consequence: 'Mehr Speicher wird benötigt.' },
  ], recommendedOptionId: 'small' };

test('strict v2 outcomes preserve findings and reject malformed, ambiguous or invented contracts', () => {
  const parsed = parseDevelopmentOutcome(JSON.stringify({ version: 2, status: 'blocked', summary: 'QA findings', blockers: [finding] }), 2);
  assert.deepEqual(parsed.findings, [finding]);
  assert.deepEqual(parsed.blockers, [finding.summary]);
  for (const body of [
    { status: 'ready', summary: 'Legacy', blockers: [] },
    { version: 2, status: 'ready', summary: 'Contradiction', blockers: [finding] },
    { version: 2, status: 'blocked', summary: 'Empty', blockers: [] },
    { version: 2, status: 'blocked', summary: 'Unknown kind', blockers: [{ ...finding, kind: 'auto_approve' }] },
    { version: 2, status: 'blocked', summary: 'No user question', blockers: [{ ...finding, kind: 'requirement' }] },
    { version: 2, status: 'blocked', summary: 'Unknown option', blockers: [{ ...product, recommendedOptionId: 'invented' }] },
    { version: 2, status: 'ready', summary: 'Extra authority', blockers: [], approved: true },
  ]) assert.throws(() => parseDevelopmentOutcome(JSON.stringify(body), 2));
  assert.equal(parseDevelopmentOutcome('{"status":"ready","summary":"Legacy retained","blockers":[]}').status, 'ready');
});

test('only evidenced design corrections get an internal round, not permissions or requirements', () => {
  assert.equal(planningBlockerRoute(state(), 'coder'), 'design_refinement');
  for (const kind of ['requirement', 'environment', 'authorization', 'scope', 'technical_review'] as const) {
    assert.equal(planningBlockerRoute(state({ ...finding, kind }), 'coder'), 'requirements_input');
  }
  for (const source of ['requirement', 'approved_plan', 'unknown'] as const) assert.equal(mayRefineDesign(state({ ...finding, source })), false);
  assert.equal(mayRefineDesign(state({ ...finding, evidence: [] })), false);
  assert.equal(mayRefineDesign({ ...state(), development_contract_version: 1 }), false);
  assert.equal(mayRefineDesign({ ...state(), workflow_blockers: ['A deterministic guard failed.'] }), false);
  assert.equal(effectiveFindings({ ...state(), workflow_blockers: ['Changed'] })[0]?.kind, 'technical_review');
  assert.equal(planningBlockerRoute({ ...state(), workflow_blockers: [], development_findings: [] }, 'coder'), 'coder');
  assert.equal(mayRefineDesign({ ...state(), workflow_blockers: [finding.summary, 'No access'],
    development_findings: [finding, { ...finding, kind: 'authorization', summary: 'No access' }] }), false);
});

test('internal correction budgets, repeated findings and time window survive state persistence', () => {
  const started = designRefinementUpdate(state(), 1000);
  assert.equal(started.design_refinement_count, 1);
  assert.equal(started.qa_test_plan, '');
  assert.equal(mayRefineDesign({ ...state(), ...started, ...state() }, 1100), false);
  const different = state({ ...finding, summary: 'A distinct API detail needs repair.' });
  assert.equal(mayRefineDesign({ ...different, ...started, ...different }, 1100), true);
  assert.equal(mayRefineDesign({ ...different, design_refinement_count: 2 }), false);
  assert.equal(mayRefineDesign({ ...different, design_refinement_started_at: 1000 }, 1000 + DESIGN_REFINEMENT_WINDOW_MS), false);
  assert.equal(refinementExpired({ ...state(), design_refinement_started_at: 1000 }, 1000 + DESIGN_REFINEMENT_WINDOW_MS), true);
  assert.throws(() => designRefinementUpdate({ ...state(), design_refinement_count: 2 }));
});

test('sources never upgrade generated proposals or unproven handoffs into authority', () => {
  const source = planningSources({ ...state(), planning_handoff: 'Unverified plan' });
  assert.match(source, /Approved planning handoff: NONE/);
  assert.match(source, /Previous generated proposal, revision 1 \(not authority\)/);
  assert.doesNotMatch(source, /Unverified plan/);
  assert.match(planningSources({ ...state(), planning_handoff: 'Reviewed plan', planning_provenance: { sha256: 'trusted upstream receipt' } }), /Approved planning handoff: Reviewed plan/);
  const brief = authoritativeDevelopmentBrief({ ...state(), operator_clarifications: [{ decisionId: 'bound', text: 'Preserve compatibility.' }] });
  assert.match(brief, /Preserve compatibility/);
  assert.doesNotMatch(brief, /Generated \(B,14\)/);
});

test('version-bound product answers cannot approve, forge options, grant scope or answer stale questions', () => {
  const decision = decisionRequest(state(product));
  const reply = { decisionId: decision.id, requirements: '', answers: { q1: 'small' } };
  assert.match(validateDecisionReply(reply, decision), /Weniger Speicher/);
  assert.throws(() => validateDecisionReply({ ...reply, answers: { q1: 'invented' } }, decision));
  assert.throws(() => validateDecisionReply({ ...reply, answers: { q2: 'small' } }, decision));
  assert.throws(() => validateDecisionReply({ ...reply, approved: true }, decision));
  for (const requirements of ['', 'yes', 'ja!', 'OK']) assert.throws(() => validateDecisionReply({ decisionId: decision.id, requirements }, decision));
  for (const change of [{ plan_revision: 2 }, { plan: 'new proposal' }, { base_commit_sha: 'new' },
    { issue_snapshot: { sha256: 'new' } }, { operator_clarifications: [{ decisionId: decision.id, text: 'previous' }] }]) {
    assert.throws(() => validateDecisionReply(reply, decisionRequest({ ...state(product), ...change })), /changed/);
  }
  const scope = decisionRequest({ ...state(), ...systemDevelopmentBlocker('scope', 'Protected file') });
  assert.equal(scope.canClarify, false);
  assert.throws(() => validateDecisionReply({ decisionId: scope.id, requirements: 'Allow all files.' }, scope), /cannot be changed/);
});

test('real graph corrects proposal internally, reruns QA, then still stops at human approval', async () => {
  let setup = 0; let planner = 0; let qa = 0; let coder = 0;
  const graph = new StateGraph(WorkflowState)
    .addNode('workspace', () => { setup++; return {}; })
    .addNode('planner', () => { planner++; return { plan: planner === 1 ? 'Generated (B,14)' : 'Scalar-compatible (B,13)',
      plan_revision: planner, workflow_blockers: [], development_findings: [] }; })
    .addNode('test_design', () => { qa++; return qa === 1 ? state() : { workflow_blockers: [], development_findings: [], design_refinement_pending: false }; })
    .addNode('design_refinement', s => designRefinementUpdate(s))
    .addNode('coder', () => { coder++; return {}; })
    .addNode('human_approval', () => { interrupt({ stage: 'human_approval' }); return {}; })
    .addNode('requirements_input', requirementsInputNode)
    .addEdge(START, 'workspace').addEdge('workspace', 'planner').addEdge('planner', 'test_design')
    .addConditionalEdges('test_design', s => planningBlockerRoute(s, 'coder'))
    .addEdge('design_refinement', 'planner').addEdge('coder', 'human_approval').addEdge('human_approval', END)
    .addEdge('requirements_input', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'bounded-design-fixture' } };
  await graph.invoke({ development_contract_version: 2, argus_bundle_ids: [7], allowed_files: 'src/new.py' }, config);
  const result = await graph.getState(config);
  assert.deepEqual([setup, planner, qa, coder], [1, 2, 2, 1]);
  assert.deepEqual(result.next, ['human_approval']);
  assert.equal(result.values.design_refinement_count, 1);
  assert.equal(result.values.retry_count, 0);
  assert.equal(result.values.human_approved, false);
  assert.equal(result.values.pr_approved, false);
  assert.equal(result.values.allowed_files, 'src/new.py');
  assert.deepEqual(result.values.argus_bundle_ids, [7]);
});

test('real v2 clarification checkpoint preserves immutable brief and permissions', async () => {
  const graph = new StateGraph(WorkflowState).addNode('requirements_input', requirementsInputNode)
    .addEdge(START, 'requirements_input').addEdge('requirements_input', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'versioned-clarification' } };
  await graph.invoke({ ...state(product), argus_bundle_ids: [7], allowed_files: 'src/new.py' }, config);
  const paused = await graph.getState(config);
  const decision = decisionRequest(paused.values as typeof WorkflowState.State);
  await graph.invoke(new Command({ resume: { decisionId: decision.id, requirements: '', answers: { q1: 'small' } } }), config);
  const result = await graph.getState(config);
  assert.equal(result.values.description, state(product).description);
  assert.match(result.values.operator_clarifications[0].text, /Weniger Speicher/);
  assert.equal(result.values.human_approved, false);
  assert.equal(result.values.pr_approved, false);
  assert.equal(result.values.allowed_files, 'src/new.py');
  assert.deepEqual(result.values.argus_bundle_ids, [7]);
});
