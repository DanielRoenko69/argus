import test from 'node:test';
import assert from 'node:assert/strict';
import { Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { WorkflowState } from './state.js';
import { requirementsInputNode } from './requirementsCheckpoint.js';
import { decisionRequest, designRefinementUpdate, digest, type DevelopmentFinding, validateDecisionReply } from './developmentDecisions.js';
import { applyTechnicalProposal, applyTechnicalReview, reserveTechnicalInvestigation, technicalContractFailure,
  technicalFindingRecords, technicalPlanningRoute, technicalResponseFailure, TECHNICAL_VERIFICATION_INSTRUCTION,
  TECHNICAL_PROPOSAL_INSTRUCTION, TECHNICAL_REVIEW_INSTRUCTION, type TechnicalDesignState } from './technicalDesign.js';

test('Planner and QA receive the same candidate-path and independent numerical evidence guidance', () => {
  for (const prompt of [TECHNICAL_PROPOSAL_INSTRUCTION, TECHNICAL_REVIEW_INSTRUCTION]) {
    assert.ok(prompt.includes(TECHNICAL_VERIFICATION_INSTRUCTION));
    assert.match(prompt, /path-coverage witness/);
    assert.match(prompt, /batch-size-one tests must exercise the same candidate algorithm/);
    assert.match(prompt, /proposed measurement is not an executed result or permission/);
    assert.match(prompt, /Do not assume a random trajectory must terminate/);
  }
});

const state = (): TechnicalDesignState & { development_contract_version: number } => ({
  development_contract_version: 2, technical_design_policy_version: 1, workflow_blockers: [], development_findings: [],
});
const decision = (id = 'api') => ({ id, topic: 'Public vector API', specification: 'BatchMotor(num_envs: int) exposes single and batched spaces.',
  rationale: 'Concrete implementation choice within the requested batch feature.', requirementRefs: ['Frozen issue criterion 5: documented batch contract'],
  evidence: ['Repository scalar API and installed VectorEnv interface inspected.'] });
const finding = (summary = 'Numeric comparison bound lacks independent justification.'): DevelopmentFinding => ({
  kind: 'design', source: 'proposal', summary, evidence: ['Frozen issue criterion 2', 'Proposal: numerical tolerance item'],
});
const outcome = (findings: DevelopmentFinding[] = []) => ({ version: 2, status: findings.length ? 'blocked' : 'ready',
  summary: 'Concrete independent technical reasoning.', blockers: findings });
const propose = (decisions: ReturnType<typeof decision>[] = [decision()], resolutions: unknown[] = [], findings: DevelopmentFinding[] = []) =>
  JSON.stringify({ outcome: outcome(findings), decisions, resolutions });
const testCase = (decisionId = 'api') => ({ id: 'empty_batch', decisionIds: [decisionId],
  scenario: 'Empty batch', input: 'BatchMotor(num_envs=0)', expected: 'ValueError',
  oracle: 'Positive-size contract excludes zero.', evidence: ['Frozen brief: positive batch size'], targetFiles: ['tests/test_batch.py'] });
const review = (s: TechnicalDesignState, findings: DevelopmentFinding[] = []) => JSON.stringify({ outcome: outcome(findings),
  testCases: findings.length ? [] : [testCase(s.technical_decisions?.[0]?.id)],
  reviews: (s.technical_decisions ?? []).map(d => ({ decisionId: d.id, digest: d.digest,
    verdict: findings.length ? 'revise' : 'accept', evidence: ['Independent contract and reference check.'] })) });

// Structural regression from the 2026-09-28 GEM Planner response. The text is a
// synthetic reproduction, not a new measurement or a trusted runtime receipt.
const sandboxFinding = { kind: 'environment', source: 'unknown',
  summary: 'The read-only environment cannot inspect the repository.',
  evidence: "Read-only inspection failed before execution: bwrap: Can't mount proc on /proc: Operation not permitted" };
test('Planner and legacy QA also record the strictly bounded trailing-closer repair', () => {
  const before = state(), raw = propose();
  const planned = applyTechnicalProposal(before, raw + '}');
  assert.deepEqual(planned.technical_design_history[0]!.responseRepairs, [{ kind: 'trailing_object_closer',
    originalSha256: digest(raw + '}'), normalizedSha256: digest(raw) }]);
  const s = { ...before, ...planned }, qa = review(s);
  const checked = applyTechnicalReview(s, qa + '}');
  assert.equal(checked.technical_design_history[0]!.responseRepairs.length, 1);
  const invalid = JSON.parse(qa); invalid.reviews[0].digest = '0'.repeat(64);
  assert.throws(() => applyTechnicalReview(s, JSON.stringify(invalid) + '}'), /stale/);
});
test('Planner and QA explicitly require array-shaped blocker evidence', () => {
  for (const prompt of [TECHNICAL_PROPOSAL_INSTRUCTION, TECHNICAL_REVIEW_INSTRUCTION]) {
    assert.match(prompt, /Blocker evidence must be a JSON array/);
    assert.match(prompt, /Never use a bare string, object or null/);
    assert.match(prompt, /"blockers":\[\{"kind":"environment"/);
    assert.match(prompt, /format example, not a finding about the current run/);
  }
});
test('single Planner evidence text is wrapped losslessly and still stops on the actual environment blocker', () => {
  const response = { outcome: { version: 2, status: 'blocked', summary: 'Inspection is unavailable.', blockers: [sandboxFinding] },
    decisions: [], resolutions: [] };
  const before = state();
  const update = applyTechnicalProposal(before, JSON.stringify(response));
  assert.deepEqual(update.development_findings, [{ ...sandboxFinding, evidence: [sandboxFinding.evidence] }]);
  assert.equal(update.technical_response_failure, null);
  assert.equal(technicalPlanningRoute({ ...before, ...update }, 'knowledge'), 'requirements_input');
  assert.equal(decisionRequest({ ...before, ...update }).kind, 'environment');
  assert.deepEqual(update.technical_decisions, []);
  assert.deepEqual(update.technical_design_history[0]?.responseRepairs,
    [{ kind: 'blocker_evidence_list', index: 0, originalSha256: digest(sandboxFinding.evidence) }]);
  assert.equal(typeof response.outcome.blockers[0]?.evidence, 'string');
  assert.deepEqual(before, state(), 'normalization cannot mutate a checkpoint');
  const canonical = applyTechnicalProposal(before, JSON.stringify({ ...response,
    outcome: { ...response.outcome, blockers: update.development_findings } }));
  assert.deepEqual(canonical.technical_design_history[0]?.responseRepairs, []);
  assert.deepEqual(canonical.development_findings, update.development_findings);
});
test('QA normalizes only supplied blocker text and cannot turn a revise verdict into acceptance', () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose()) };
  const response = JSON.parse(review(proposed, [finding()]));
  response.outcome.blockers[0] = sandboxFinding;
  const update = applyTechnicalReview(proposed, JSON.stringify(response));
  assert.deepEqual(update.development_findings, [{ ...sandboxFinding, evidence: [sandboxFinding.evidence] }]);
  assert.equal(update.technical_decisions[0]?.status, 'proposed');
  assert.deepEqual(update.technical_design_history[0]?.reviews, response.reviews);
  assert.equal(technicalPlanningRoute({ ...proposed, ...update }, 'coder'), 'requirements_input');
  assert.deepEqual(update.technical_design_history[0]?.responseRepairs,
    [{ kind: 'blocker_evidence_list', index: 0, originalSha256: digest(sandboxFinding.evidence) }]);
});
test('blocker evidence normalization never invents content, drops blockers or relaxes the rest of either schema', () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose()) };
  const proposal = { outcome: { version: 2, status: 'blocked', summary: 'Blocked.', blockers: [sandboxFinding] }, decisions: [], resolutions: [] };
  const qa = JSON.parse(review(proposed, [finding()])); qa.outcome.blockers = [sandboxFinding];
  for (const [payload, parse] of [[proposal, (raw: string) => applyTechnicalProposal(proposed, raw)],
    [qa, (raw: string) => applyTechnicalReview(proposed, raw)]] as const) {
    const reject = (change: (value: any) => void) => { const copy = structuredClone(payload); change(copy); assert.throws(() => parse(JSON.stringify(copy))); };
    for (const value of [undefined, null, '', ' ', 4, {}, ['source', null], 'x'.repeat(2001)]) {
      reject(copy => { copy.outcome.blockers[0].evidence = value; });
    }
    reject(copy => { copy.outcome.status = 'ready'; });
    reject(copy => { copy.outcome.blockers[0].kind = 'made_up'; });
    reject(copy => { copy.outcome.blockers[0].kind = 'requirement'; });
    reject(copy => { copy.outcome.blockers[0].approved = true; });
    reject(copy => { copy.outcome.blockers = Array.from({ length: 13 }, () => sandboxFinding); });
    reject(copy => { copy.approved = true; });
  }
  assert.throws(() => applyTechnicalProposal(proposed, JSON.stringify({ ...proposal,
    decisions: [{ ...decision(), evidence: 'not-a-list' }] })));
  qa.reviews[0].digest = '0'.repeat(64);
  assert.throws(() => applyTechnicalReview(proposed, JSON.stringify(qa)), /stale/);
});

const overlongId = 'batch_benchmark_reports_raw_runtime_and_memory_against_four_single_envs';
test('GEM 71-character test ID is repaired once with full evidence and unchanged QA content', () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose()) };
  const before = structuredClone(proposed);
  const response = JSON.parse(review(proposed));
  response.testCases = Array.from({ length: 15 }, (_, i) => ({ ...testCase(), id: i === 14 ? overlongId : `case_${i}` }));
  const checked = applyTechnicalReview(proposed, JSON.stringify(response));
  const cases = JSON.parse(checked.qa_test_plan).testCases;
  assert.equal(overlongId.length, 71);
  assert.equal(cases[14].id, `tc_${digest(overlongId).slice(0, 61)}`);
  assert.equal(cases[14].id.length, 64);
  assert.deepEqual(cases.map((t: { id: string }, i: number) => ({ ...t, id: response.testCases[i].id })), response.testCases);
  assert.deepEqual(checked.technical_design_history[0].reviews, response.reviews);
  assert.deepEqual(checked.technical_design_history[0].responseRepairs, [{ index: 14, originalId: overlongId, normalizedId: cases[14].id }]);
  assert.deepEqual(applyTechnicalReview(proposed, JSON.stringify(response)), checked);
  assert.deepEqual(proposed, before, 'parser cannot mutate the checkpoint');
  assert.deepEqual(checked.workflow_blockers, []);
  assert.equal(checked.technical_decisions[0]?.digest, proposed.technical_decisions[0]?.digest);
  const canonical = applyTechnicalReview(proposed, JSON.stringify({ ...response, testCases: cases }));
  assert.deepEqual(canonical.technical_design_history[0].responseRepairs, []);
});

test('ID repair cannot alter verdicts, normalize references, hide duplicate labels or invent test content', () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose()) };
  const response = JSON.parse(review(proposed));
  response.testCases[0].id = overlongId;
  const reject = (change: (r: typeof response) => void) => {
    const copy = structuredClone(response); change(copy);
    assert.throws(() => applyTechnicalReview(proposed, JSON.stringify(copy)));
  };
  reject(r => { r.reviews[0].digest = '0'.repeat(64); });
  reject(r => { r.reviews[0].decisionId = overlongId; });
  reject(r => { r.testCases[0].decisionIds = [overlongId]; });
  reject(r => { r.testCases[0].expected = ''; });
  reject(r => { delete r.testCases[0].oracle; });
  reject(r => { r.testCases[0].id = 'x'.repeat(513); });
  reject(r => { r.testCases[0].id = 'Invalid Name'; });
  reject(r => { r.testCases.push(structuredClone(r.testCases[0])); });
  reject(r => { r.testCases.push({ ...testCase(), id: `tc_${digest(overlongId).slice(0, 61)}` }); });
  reject(r => { r.approved = true; });
  reject(r => { r.reviews = []; });
  const blocked = { ...response, outcome: outcome([finding()]) };
  blocked.reviews[0].verdict = 'revise';
  const result = applyTechnicalReview(proposed, JSON.stringify(blocked));
  assert.equal(result.technical_decisions[0]?.status, 'proposed');
  assert.deepEqual(result.development_findings, [finding()]);
  assert.equal(result.technical_response_failure, null);
});

test('invalid responses produce bounded safe diagnostics, not owner questions or design retries', () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose()) };
  for (const phase of ['planner', 'qa'] as const) {
    const invalid = JSON.parse(review(proposed));
    invalid.testCases[0].expected = '';
    let schemaError: unknown;
    try { applyTechnicalReview(proposed, JSON.stringify(invalid)); } catch (error) { schemaError = error; }
    for (const [error, category] of [[schemaError, 'format'], [new SyntaxError('PRIVATE_VALUE'), 'format'],
      [new Error('PRIVATE_VALUE'), 'integrity']] as const) {
      const failure = technicalResponseFailure(phase, error);
      assert.equal(failure.technical_response_failure.category, category);
      assert.ok(!JSON.stringify(failure).includes('PRIVATE_VALUE'));
      const failed = { ...proposed, ...failure };
      assert.equal(technicalPlanningRoute(failed, 'coder'), 'requirements_input');
      const card = decisionRequest(failed);
      assert.equal(card.title, `Agent response ${category} error`);
      assert.equal(card.canClarify, false);
      assert.throws(() => validateDecisionReply({ decisionId: card.id, requirements: 'Continue anyway.' }, card), /blocked/);
      const recovered = applyTechnicalReview(failed, review(failed));
      assert.equal(recovered.technical_response_failure, null);
    }
    assert.ok(technicalResponseFailure(phase, schemaError).technical_response_failure.diagnostics[0]?.includes('testCases.[0].expected'));
  }
});

test('incremental proposals preserve accepted choices; an actual change invalidates only its QA receipt', () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose([decision(), decision('benchmark')])) };
  const checked = { ...proposed, ...applyTechnicalReview(proposed, review(proposed)) };
  const unchanged = applyTechnicalProposal(checked, propose([]));
  assert.equal(unchanged.technical_decisions.length, 2);
  assert.ok(unchanged.technical_decisions.every(d => d.status === 'qa_checked'));
  const changed = applyTechnicalProposal(checked, propose([{ ...decision(), specification: 'BatchMotor(batch_size: int)' }]));
  assert.equal(changed.technical_decisions[0]?.status, 'proposed');
  assert.equal(changed.technical_decisions[0]?.revision, 2);
  assert.equal(changed.technical_decisions[1]?.status, 'qa_checked');
  assert.equal(changed.technical_decisions[1]?.revision, 1);
  assert.throws(() => applyTechnicalReview({ ...checked, ...changed }, review(checked)), /stale/);
});

test('ready plans must address every prior finding and retain the evidence for independent QA', () => {
  const open = technicalFindingRecords([finding()]);
  const before = { ...state(), technical_open_findings: open };
  assert.throws(() => applyTechnicalProposal(before, propose()), /unresolved/);
  assert.throws(() => applyTechnicalProposal(before, propose([decision()], [{ findingId: 'invented', decisionIds: ['api'], evidence: ['claimed'] }])), /Unknown finding/);
  assert.throws(() => applyTechnicalProposal(before, propose([decision()], [{ findingId: open[0]!.id, decisionIds: ['absent'], evidence: ['claimed'] }])), /unknown decision/);
  const resolved = applyTechnicalProposal(before, propose([decision()], [{ findingId: open[0]!.id, decisionIds: ['api'], evidence: ['New independently justified protocol.'] }]));
  assert.deepEqual(resolved.technical_open_findings, []);
  assert.equal(resolved.technical_resolution_evidence[0]?.finding.finding.summary, finding().summary);
  assert.equal(resolved.technical_decisions[0]?.status, 'proposed');
  const blocked = applyTechnicalProposal(before, propose([], [], [finding('Another missing detail.')]));
  assert.equal(blocked.technical_open_findings.length, 2);
});

test('QA cannot skip decision checks, approve stale content or create authority fields', () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose()) };
  assert.throws(() => applyTechnicalReview(proposed, JSON.stringify({ outcome: outcome(), reviews: [], testCases: [] })), /every current/);
  const valid = JSON.parse(review(proposed));
  assert.throws(() => applyTechnicalReview(proposed, JSON.stringify({ ...valid, approved: true })));
  assert.throws(() => applyTechnicalReview(proposed, JSON.stringify({ ...valid, reviews: [...valid.reviews, ...valid.reviews] })), /Duplicate/);
  assert.throws(() => applyTechnicalProposal(state(), propose([])), /concrete/);
  assert.throws(() => applyTechnicalProposal(state(), propose([decision(), decision()])), /Duplicate/);
  assert.throws(() => applyTechnicalProposal(state(), 'x'.repeat(128_001)), /bounded/);
});

test('ready QA must persist independent concrete cases, not merely approve proposed tests', () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose()) };
  const valid = JSON.parse(review(proposed));
  const { testCases, ...summaryOnly } = valid;
  assert.throws(() => applyTechnicalReview(proposed, JSON.stringify(summaryOnly)));
  assert.throws(() => applyTechnicalReview(proposed, JSON.stringify({ ...valid, testCases: [] })), /concrete independent/);
  for (const field of ['scenario', 'input', 'expected', 'oracle']) {
    assert.throws(() => applyTechnicalReview(proposed, JSON.stringify({ ...valid, testCases: [{ ...testCase(), [field]: '' }] })));
  }
  assert.throws(() => applyTechnicalReview(proposed, JSON.stringify({ ...valid, testCases: [testCase('unknown')] })), /unknown decision/);
  assert.throws(() => applyTechnicalReview(proposed, JSON.stringify({ ...valid, testCases: [testCase(), testCase()] })), /Duplicate/);
  const checked = applyTechnicalReview(proposed, JSON.stringify(valid));
  assert.deepEqual(JSON.parse(checked.qa_test_plan).testCases, testCases);
  assert.deepEqual(checked.technical_design_history[0].testCases, testCases);
  assert.doesNotThrow(() => applyTechnicalReview(proposed, review(proposed, [finding()])));
});

test('all four real GEM conflict classes stay technical after the correction limit, not owner questions', () => {
  const findings = ['Tolerance rationale', 'VectorEnv public contract', 'Deterministic mixed termination', 'Reproducible benchmark protocol'].map(finding);
  const stopped = { ...state(), workflow_blockers: findings.map(f => f.summary), development_findings: findings, design_refinement_count: 2 };
  assert.equal(technicalPlanningRoute(stopped, 'coder'), 'technical_resolution');
  const reserved = { ...stopped, ...reserveTechnicalInvestigation(stopped) };
  assert.equal(reserved.technical_investigation_count, 1);
  assert.throws(() => reserveTechnicalInvestigation(reserved), /not eligible/);
  assert.equal(technicalPlanningRoute({ ...reserved, technical_investigation_pending: false }, 'coder'), 'requirements_input');
  const card = decisionRequest(reserved);
  assert.equal(card.kind, 'technical_review');
  assert.equal(card.title, 'Technical work blocked');
  assert.equal(card.canClarify, false);
  assert.throws(() => validateDecisionReply({ decisionId: card.id, requirements: 'Use atol=0.1 and continue.' }, card), /blocked/);
});

test('only sourced product choices accept input; uncertainty and permissions never enter the investigation', () => {
  const product: DevelopmentFinding = { kind: 'requirement', source: 'requirement', summary: 'Compatibility tradeoff in brief.',
    evidence: ['Issue: choose whether to support custom configurations'], question: 'Soll die erste Version auch Sonderkonfigurationen unterstützen?' };
  const withFinding = (f: DevelopmentFinding) => ({ ...state(), workflow_blockers: [f.summary], development_findings: [f] });
  assert.equal(technicalPlanningRoute(withFinding(product), 'coder'), 'requirements_input');
  assert.equal(decisionRequest(withFinding(product)).canClarify, true);
  for (const source of ['unknown', 'proposal', 'repository'] as const) {
    assert.equal(decisionRequest(withFinding({ ...product, source })).canClarify, false);
  }
  for (const kind of ['environment', 'authorization', 'scope'] as const) {
    assert.equal(technicalPlanningRoute(withFinding({ ...finding(), kind }), 'coder'), 'requirements_input');
    assert.throws(() => reserveTechnicalInvestigation(withFinding({ ...finding(), kind })));
  }
  const mixed = [finding(), { ...finding('Unavailable test environment'), kind: 'environment' as const }];
  assert.equal(decisionRequest({ ...state(), workflow_blockers: mixed.map(f => f.summary), development_findings: mixed }).canClarify, false);
  assert.equal(technicalPlanningRoute({ ...state(), ...technicalContractFailure('Invalid response') }, 'coder'), 'requirements_input');
  const legacy = { ...withFinding(finding()), technical_design_policy_version: 0, design_refinement_count: 2 };
  assert.equal(technicalPlanningRoute(legacy, 'coder'), 'requirements_input');
  assert.equal(decisionRequest(legacy).canClarify, true);
});

test('a valid product clarification invalidates technical QA receipts without changing delivery authority', async () => {
  const proposed = { ...state(), ...applyTechnicalProposal(state(), propose()) };
  const checked = { ...proposed, ...applyTechnicalReview(proposed, review(proposed)) };
  const product: DevelopmentFinding = { kind: 'requirement', source: 'requirement', summary: 'Actual unresolved product behavior.',
    evidence: ['Issue criterion 5'], question: 'Soll die vorhandene Schnittstelle weiterhin funktionieren?' };
  const graph = new StateGraph(WorkflowState).addNode('requirements_input', requirementsInputNode)
    .addEdge(START, 'requirements_input').addEdge('requirements_input', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'technical-basis-change' } };
  await graph.invoke({ ...checked, workflow_blockers: [product.summary], development_findings: [product], argus_bundle_ids: [7] }, config);
  const paused = await graph.getState(config), card = decisionRequest(paused.values as typeof WorkflowState.State);
  await graph.invoke(new Command({ resume: { decisionId: card.id, requirements: 'Vorhandene Aufrufe sollen weiterhin funktionieren.' } }), config);
  const saved = await graph.getState(config);
  assert.equal(saved.values.technical_decisions[0].status, 'proposed');
  assert.deepEqual(saved.values.technical_decisions[0].reviewEvidence, []);
  assert.equal(saved.values.human_approved, false); assert.equal(saved.values.pr_approved, false);
  assert.deepEqual(saved.values.argus_bundle_ids, [7]);
});

for (const investigationSucceeds of [false, true]) test(`checkpointed graph bounds the investigation and ${investigationSucceeds ? 'retains human approval' : 'blocks without owner input'}`, async () => {
  let plans = 0, investigations = 0, qa = 0, coder = 0, workspace = 0;
  const graph = new StateGraph(WorkflowState)
    .addNode('workspace', () => { workspace++; return {}; })
    .addNode('planner', s => {
      plans++;
      return applyTechnicalProposal(s, propose([{ ...decision(), specification: `Concrete API proposal ${plans}` }],
        s.technical_open_findings.map(f => ({ findingId: f.id, decisionIds: ['api'], evidence: ['Targeted resolution candidate.'] }))));
    })
    .addNode('test_design', s => {
      qa++;
      const findings = investigations && investigationSucceeds ? [] : [finding(`Unresolved technical evidence ${qa}`)];
      return { ...applyTechnicalReview(s, review(s, findings)), design_refinement_pending: false };
    })
    .addNode('design_refinement', s => designRefinementUpdate(s))
    .addNode('technical_resolution', s => reserveTechnicalInvestigation(s))
    .addNode('technical_investigation', s => {
      investigations++;
      assert.equal(s.technical_investigation_count, 1);
      assert.equal(s.technical_investigation_pending, true);
      return { ...applyTechnicalProposal(s, propose([{ ...decision(), specification: 'Evidence-backed concrete contract' }],
        s.technical_open_findings.map(f => ({ findingId: f.id, decisionIds: ['api'], evidence: ['Independent repository/reference evidence.'] })))), technical_investigation_pending: false };
    })
    .addNode('coder', () => { coder++; return {}; })
    .addNode('human_approval', () => { interrupt({ stage: 'human_approval' }); return {}; })
    .addNode('requirements_input', requirementsInputNode)
    .addEdge(START, 'workspace').addEdge('workspace', 'planner')
    .addConditionalEdges('planner', s => technicalPlanningRoute(s, 'test_design'))
    .addConditionalEdges('test_design', s => technicalPlanningRoute(s, 'coder'))
    .addEdge('design_refinement', 'planner').addEdge('technical_resolution', 'technical_investigation')
    .addConditionalEdges('technical_investigation', s => technicalPlanningRoute(s, 'test_design'))
    .addEdge('coder', 'human_approval').addEdge('human_approval', END).addEdge('requirements_input', END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: `technical-investigation-${investigationSucceeds}` }, recursionLimit: 40 };
  await graph.invoke({ ...state(), allowed_files: 'src/new.py', argus_bundle_ids: [7], description: 'Immutable issue scope.' }, config);
  const paused = await graph.getState(config);
  assert.deepEqual([workspace, plans, investigations, qa, coder], [1, 3, 1, 4, investigationSucceeds ? 1 : 0]);
  assert.deepEqual(paused.next, [investigationSucceeds ? 'human_approval' : 'requirements_input']);
  assert.equal(paused.values.human_approved, false);
  assert.equal(paused.values.pr_approved, false);
  assert.equal(paused.values.allowed_files, 'src/new.py');
  assert.deepEqual(paused.values.argus_bundle_ids, [7]);
  assert.equal(paused.values.description, 'Immutable issue scope.');
  assert.equal(paused.values.technical_investigation_count, 1);
  if (!investigationSucceeds) {
    const card = decisionRequest(paused.values as typeof WorkflowState.State);
    await assert.rejects(graph.invoke(new Command({ resume: { decisionId: card.id, requirements: 'Some technical answer.' } }), config), /blocked/);
    assert.equal(investigations, 1);
  }
});
