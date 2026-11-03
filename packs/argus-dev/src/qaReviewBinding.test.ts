import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTechnicalProposal, applyTechnicalReview, applyBoundTechnicalReview, createQaReviewBinding, technicalDesignContext, technicalPlanningRoute } from './technicalDesign.js';
import { digest } from './developmentDecisions.js';
import { qaResponseBasis } from './qaResponseRecovery.js';

function fixture() {
  const state = { ...applyTechnicalProposal({ workflow_blockers: [] }, JSON.stringify({ outcome: { version: 2, status: 'ready', summary: 'Plan', blockers: [] },
    decisions: [{ id: 'api', topic: 'API', specification: 'reject zero', rationale: 'positive size', requirementRefs: ['issue'], evidence: ['api.py:1'] }], resolutions: [] })), technical_design_policy_version: 1 };
  const response = { version: 2, outcome: { version: 2, status: 'ready', summary: 'QA', blockers: [] as unknown[] },
    reviews: [{ decisionId: 'api', verdict: 'accept', evidence: ['independent reference'] }],
    testCases: [{ id: 'zero_size', decisionIds: ['api'], scenario: 'zero size', input: 'API(0)', expected: 'ValueError', oracle: 'positive-size requirement', evidence: ['issue'], targetFiles: ['tests/test_api.py'] }] };
  const basis = qaResponseBasis(state), binding = createQaReviewBinding(state, basis);
  return { state, response, basis, binding };
}
test('one redundant final object closer is repaired losslessly with original and normalized digests', () => {
  const f = fixture();
  // Same defect as the retained GEM response: a complete object followed by one }.
  f.response.testCases[0]!.input = 'Literal braces { } and an escaped quote " stay unchanged.';
  const clean = JSON.stringify(f.response), raw = clean + '}', original = JSON.stringify(f.state);
  const result = applyBoundTechnicalReview(f.state, raw, f.binding, f.basis);
  assert.deepEqual(JSON.parse(result.qa_test_plan).testCases, f.response.testCases);
  assert.deepEqual(result.technical_design_history[0]!.responseRepairs, [{ kind: 'trailing_object_closer',
    originalSha256: digest(raw), normalizedSha256: digest(clean) }]);
  assert.equal(JSON.stringify(f.state), original);
  assert.equal(result.technical_decisions[0]!.status, 'qa_checked');
  assert.deepEqual(applyBoundTechnicalReview(f.state, raw, f.binding, f.basis), result);
  assert.equal(applyBoundTechnicalReview(f.state, clean, f.binding, f.basis).technical_design_history[0]!.responseRepairs.length, 0);
  assert.equal(applyBoundTechnicalReview(f.state, '```json\n' + raw + '\n```', f.binding, f.basis).technical_design_history[0]!.responseRepairs.length, 1);
});
test('closer repair never extracts JSON, invents missing syntax, discards content or relaxes contracts', () => {
  const f = fixture(), clean = JSON.stringify(f.response);
  for (const raw of [clean + '}}', clean + '{}', clean + ' trailing text', clean.slice(0, -1),
    'Answer: ' + clean + '}', '[' + clean + ']}', clean.replace('"version":2', '"version":2,') + '}',
    clean + ' '.repeat(128001) + '}']) {
    assert.throws(() => applyBoundTechnicalReview(f.state, raw, f.binding, f.basis));
  }
  for (const change of [(r: any) => { r.reviews[0].decisionId = 'unknown'; },
    (r: any) => { r.testCases[0].expected = ''; }, (r: any) => { r.approved = true; },
    (r: any) => { r.reviews = []; }, (r: any) => { r.reviews[0].digest = 'a'.repeat(64); }]) {
    const r = structuredClone(f.response); change(r);
    assert.throws(() => applyBoundTechnicalReview(f.state, JSON.stringify(r) + '}', f.binding, f.basis));
  }
  assert.throws(() => applyBoundTechnicalReview(f.state, clean + '}', f.binding, 'f'.repeat(64)));
  f.response.outcome.status = 'blocked';
  f.response.outcome.blockers = [{ kind: 'environment', source: 'repository', summary: 'Missing reference', evidence: ['fixture'] }];
  f.response.reviews[0]!.verdict = 'revise'; f.response.testCases = [];
  const blocked = applyBoundTechnicalReview(f.state, JSON.stringify(f.response) + '}', f.binding, f.basis);
  assert.equal(blocked.technical_decisions[0]!.status, 'proposed');
  assert.deepEqual(blocked.development_findings, f.response.outcome.blockers);
});
test('fresh review binds server-owned digests without exposing them in the QA ledger', () => {
  const f = fixture(), before = JSON.stringify(f.state);
  const result = applyBoundTechnicalReview(f.state, JSON.stringify(f.response), f.binding, f.basis);
  assert.equal(result.technical_decisions[0]!.status, 'qa_checked');
  assert.deepEqual(result.technical_design_history[0]!.reviewBinding, f.binding);
  assert.equal(result.technical_design_history[0]!.reviews[0]!.digest, f.state.technical_decisions[0]!.digest);
  assert.ok(!technicalDesignContext(f.state, true).includes(f.state.technical_decisions[0]!.digest));
  assert.equal(JSON.stringify(f.state), before);
});
test('rejects injected hashes, stale/unknown/duplicate/missing references and old wire responses', () => {
  const f = fixture();
  for (const response of [
    { ...f.response, version: undefined },
    { ...f.response, reviews: [{ ...f.response.reviews[0], digest: 'a'.repeat(64) }] },
    { ...f.response, reviews: [{ ...f.response.reviews[0], decisionId: 'unknown' }] },
    { ...f.response, reviews: [...f.response.reviews, ...f.response.reviews] },
    { ...f.response, reviews: [] },
  ]) assert.throws(() => applyBoundTechnicalReview(f.state, JSON.stringify(response), f.binding, f.basis));
  assert.throws(() => applyBoundTechnicalReview(f.state, JSON.stringify(f.response), f.binding, 'f'.repeat(64)));
  f.state.technical_decisions[0]!.digest = '0'.repeat(64);
  assert.throws(() => applyBoundTechnicalReview(f.state, JSON.stringify(f.response), f.binding, f.basis));
});
test('legacy hash mismatches are never repaired; new calls still route genuine findings normally', () => {
  const f = fixture(), { version: _version, ...legacy } = f.response;
  for (const digest of ['0'.repeat(64), f.binding.decisions[0]!.digest + 'e']) {
    assert.throws(() => applyTechnicalReview(f.state, JSON.stringify({ ...legacy, reviews: [{ ...legacy.reviews[0], digest }] })));
  }
  f.response.outcome.status = 'blocked';
  f.response.outcome.blockers = [{ kind: 'design', source: 'proposal', summary: 'Oracle needs measurement', evidence: ['issue criterion 2'] }];
  f.response.reviews[0]!.verdict = 'revise'; f.response.testCases = [];
  const result = applyBoundTechnicalReview(f.state, JSON.stringify(f.response), f.binding, f.basis);
  assert.equal(result.technical_decisions[0]!.status, 'proposed');
  assert.equal(result.workflow_blockers.length, 1);
  assert.notEqual(technicalPlanningRoute({ ...f.state, ...result, development_contract_version: 2 } as any, 'coder'), 'coder');
});
