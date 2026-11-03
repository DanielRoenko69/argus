import { describe, expect, it } from 'vitest';
import type { DistributedTraceRun, SolutionPackRevisionEvidence } from '../types';
import { bindCodingActivity, codingProgressPresentation } from './codingActivityPresentation';

it('review-only progress never implies passing automated tests', () => {
  const result = codingProgressPresentation({ state: 'TASK_STATE_INPUT_REQUIRED', canceling: false,
    evidence: { currentStage: 'human_approval', verificationMode: 'review-only-image', testsPassed: false } });
  expect(result.checks).toContain('tests intentionally skipped');
  expect(result.detail).toContain('Automated tests');
});
import { reviewOutcome } from './backlogReviewPresentation';

it('response validation stops are not presented as product questions or missing scientific evidence', () => {
  const stopped = { state: 'TASK_STATE_INPUT_REQUIRED', canceling: false, technicalBlocked: true, responseFailure: true,
    evidence: { currentStage: 'requirements_input' } };
  expect(codingProgressPresentation(stopped).title).toBe('Agent response error — no answer required');
  expect(codingProgressPresentation(stopped).detail).toContain('No automatic retry or approval');
  expect(codingProgressPresentation({ ...stopped, state: 'TASK_STATE_CANCELED' }).title).toBe('Run canceled');
  expect(codingProgressPresentation({ ...stopped, canceling: true }).title).toBe('Cancellation requested');
});

const qa = 'Read-only evidence: repository inspected before implementation. Independent deterministic test cases cover scalar parity and per-row lifecycle.';
const run = (id: string, outputPreview: string, taskType = 'review'): DistributedTraceRun => ({
  id, kind: 'agent', title: 'reviewer', subtitle: 'Codex', taskType, status: 'completed',
  startedAt: '2026-09-27T19:00:00Z', endedAt: '2026-09-27T19:01:00Z', durationMs: 60000,
  parentTraceId: null, parentSpanId: null, outputPreview,
});
const revision: SolutionPackRevisionEvidence = {
  attempt: 3, retryCount: 2, trigger: 'tests', triggerFeedback: '', startedAt: '2026-09-27T19:00:00Z',
  coder: { traceId: 'coder-3', output: 'Implemented', recordedAt: '2026-09-27T19:01:00Z' },
  tests: { passed: true, output: '12 passed', profiles: [], recordedAt: '2026-09-27T19:01:01Z' },
  reviewer: { traceId: 'review-1', verdict: 'REQUEST_CHANGES', summary: 'Missing lifecycle coverage', findings: [], requiredChanges: ['Add lifecycle test'], output: 'VERDICT: REJECTED', recordedAt: '2026-09-27T19:02:00Z' },
  humanDecisions: [], fileDiffs: [],
};

describe('coding workflow evidence', () => {
  it('separates recipe correction from code review and honors canceled/terminal state', () => {
    const evidence = { currentStage: 'code_generation_repair' };
    const bound = bindCodingActivity([{ ...run('recipe', 'repair'), status: 'running' as const }], [], evidence);
    expect(bound[0]?.workflowStepId).toBe('code_generation_repair');
    expect(bound[0]?.reviewVerdict).toBeUndefined();
    const active = codingProgressPresentation({ state: 'TASK_STATE_WORKING', canceling: false, evidence });
    expect(active.title).toContain('generator recipe'); expect(active.detail).toContain('At most two');
    expect(active.detail).toContain('Coder'); expect(active.detail).toContain('not an approval');
    expect(codingProgressPresentation({ state: 'TASK_STATE_CANCELED', canceling: false, evidence }).title).toBe('Run canceled');
    expect(codingProgressPresentation({ state: 'TASK_STATE_INPUT_REQUIRED', canceling: false, evidence }).title).not.toContain('Correcting');
  });
  it('does not present dependency repair as code review or a Coder retry', () => {
    const active = { ...run('repair', 'checking import'), status: 'running' as const };
    const bound = bindCodingActivity([active], [], { currentStage: 'qa_environment_repair' });
    expect(bound[0]?.workflowStepId).toBe('qa_environment_repair');
    expect(bound[0]?.reviewVerdict).toBeUndefined();
    const progress = codingProgressPresentation({ state: 'TASK_STATE_WORKING', canceling: false, evidence: { currentStage: 'qa_environment_repair' } });
    expect(progress.title).toBe('QA is checking a missing dependency');
    expect(progress.detail).toContain('not code review or approval');
  });
  it('keeps supplemental QA authoring distinct from approval, including active traces', () => {
    const active = { ...run('qa-author', 'writing tests'), status: 'running' as const };
    expect(bindCodingActivity([active], [], { currentStage: 'qa_author' })[0]?.workflowStepId).toBe('qa_author');
    const retained = bindCodingActivity([run('qa-author', 'ready')], [{ step: 'qa_author', traceId: 'qa-author', summary: 'Tests authored' }], {})[0];
    expect(retained?.workflowStepId).toBe('qa_author'); expect(retained?.reviewVerdict).toBeUndefined();
    const progress = codingProgressPresentation({ state: 'TASK_STATE_WORKING', canceling: false, evidence: { currentStage: 'qa_execute' } });
    expect(progress.title).toBe('Independent QA tests are running'); expect(progress.detail).toContain('not approval');
  });
  it('binds QA separately from real reviews and uses exact persisted verdicts even with truncated previews', () => {
    const executions = [run('qa', JSON.stringify({ status: 'ready', summary: qa })), run('review-1', '{"verdict":"REQUEST_CHANGES",...'), run('review-2', 'No retained verdict')];
    const result = bindCodingActivity(executions, [{ step: 'test_design', summary: qa }], { revisionHistory: [revision] });
    expect(result[0]?.workflowStepId).toBe('test_design');
    expect(result[0]?.reviewVerdict).toBeUndefined();
    expect(result[1]?.reviewVerdict).toBe('changes-requested');
    expect(result[2]?.reviewVerdict).toBeUndefined();
    expect(executions[0]?.workflowStepId).toBeUndefined();
  });
  it('uses explicit stage receipts and refuses ambiguous historical QA content matches', () => {
    const runs = [run('qa1', qa), run('qa2', qa)];
    expect(bindCodingActivity(runs, [{ step: 'test_design', summary: qa }], {}).every(x => !x.workflowStepId)).toBe(true);
    expect(bindCodingActivity(runs, [{ step: 'test_design', summary: qa, traceId: 'qa2' }], {})[1]?.workflowStepId).toBe('test_design');
  });
  it('recognizes structured verdicts without treating QA completion as approval', () => {
    expect(reviewOutcome(JSON.stringify({ verdict: 'REQUEST_CHANGES', required_changes: ['Fix parity'] }))).toBe('changes-requested');
    expect(reviewOutcome(JSON.stringify({ verdict: 'APPROVE', required_changes: [], findings: [] }))).toBe('approved');
    expect(reviewOutcome(JSON.stringify({ verdict: 'APPROVE', required_changes: ['Still broken'] }))).toBeNull();
    expect(reviewOutcome(JSON.stringify({ status: 'ready', summary: qa }))).toBeNull();
    expect(reviewOutcome('{"verdict":"APPROVE",...')).toBeNull();
  });
  it('explains green tests with changes requested instead of implying success', () => {
    const result = codingProgressPresentation({ state: 'TASK_STATE_WORKING', canceling: false, evidence: { currentStage: 'coder', revisionHistory: [revision] }, maxRevisions: 4 });
    expect(result.title).toBe('Changes requested — Coder is revising');
    expect(result.checks).toContain('tests passed; code review changes requested');
    expect(result.detail).toContain('not a restart of planning');
    expect(result.policy).toContain('4 correction rounds');
  });
  it.each(['TASK_STATE_CANCELED', 'TASK_STATE_FAILED'])('terminal %s overrides a retained coder node', state => {
    const result = codingProgressPresentation({ state, canceling: false, evidence: { currentStage: 'coder', revisionHistory: [revision] } });
    expect(result.title).not.toContain('revising');
    expect(result.detail).toContain('No ');
  });
  it('keeps pending cancellation, missing verdict and human approval separate', () => {
    expect(codingProgressPresentation({ state: 'TASK_STATE_WORKING', canceling: true, evidence: {} }).title).toBe('Cancellation requested');
    expect(codingProgressPresentation({ state: 'TASK_STATE_WORKING', canceling: false, evidence: {} }).checks).toContain('review not recorded');
    expect(codingProgressPresentation({ state: 'TASK_STATE_INPUT_REQUIRED', canceling: false, evidence: { currentStage: 'human_approval' } }).title).toContain('human approval required');
  });
  it('separates internal design work, clarification and approval', () => {
    expect(codingProgressPresentation({ state: 'TASK_STATE_WORKING', canceling: false, evidence: { currentStage: 'design_refinement' } }).title).toContain('resolving a design conflict');
    expect(codingProgressPresentation({ state: 'TASK_STATE_INPUT_REQUIRED', canceling: false, evidence: { currentStage: 'requirements_input' } }).title).toBe('Clarification needed — not an approval');
    expect(codingProgressPresentation({ state: 'TASK_STATE_CANCELED', canceling: false, evidence: { currentStage: 'design_refinement' } }).title).toBe('Run canceled');
  });
  it('shows investigation and technical stops without asking for product-owner clarification', () => {
    expect(codingProgressPresentation({ state: 'TASK_STATE_WORKING', canceling: false, evidence: { currentStage: 'technical_investigation' } }).title).toBe('Technical evidence investigation');
    const stopped = { state: 'TASK_STATE_INPUT_REQUIRED', canceling: false, technicalBlocked: true, evidence: { currentStage: 'requirements_input' } };
    expect(codingProgressPresentation(stopped).title).toBe('Technical work blocked');
    expect(codingProgressPresentation(stopped).detail).toContain('No product-owner answer');
    expect(codingProgressPresentation({ ...stopped, state: 'TASK_STATE_CANCELED' }).title).toBe('Run canceled');
  });
});
