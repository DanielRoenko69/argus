import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseStage3Options,
  rescoreStage3Report,
  scoreStage3Run,
  stage3EvidenceAdmission,
  stage3ResumeState,
  stage3SafeGitArgs,
  stage3VariantOrder,
  summarizeStage3Runs,
} from './code-intelligence-stage3-evaluation.mjs';

test('Stage-3 scopes Git ownership trust to the exact benchmark checkout', () => {
  const args = stage3SafeGitArgs('test-results/benchmarks/stage3/example/seed-repository', ['status', '--short']);
  assert.equal(args[0], '-c');
  assert.match(args[1], /^safe\.directory=.*\/test-results\/benchmarks\/stage3\/example\/seed-repository$/u);
  assert.deepEqual(args.slice(2), ['status', '--short']);
  assert.equal(args[1].includes('*'), false);
});

test('Stage-3 options default to one blinded paired infrastructure pilot', () => {
  assert.deepEqual(parseStage3Options([]), {
    caseId: 'pino-multistream-string-level',
    repetitions: 1,
    timeoutMinutes: 30,
    variants: ['baseline', 'candidate'],
    reportTag: null,
    resumeReport: false,
  });
  assert.throws(() => parseStage3Options(['--variant', 'gold']), /baseline, candidate, or both/u);
  assert.throws(() => parseStage3Options(['--repetitions', '0']), /integer from 1 to 10/u);
  assert.equal(parseStage3Options(['--report-tag', 'scope-policy-v1']).reportTag, 'scope-policy-v1');
  assert.equal(parseStage3Options(['--report-tag', 'scope-policy-v1', '--resume-report']).resumeReport, true);
  assert.throws(() => parseStage3Options(['--resume-report']), /requires --report-tag/u);
  assert.throws(() => parseStage3Options(['--report-tag', '../unsafe']), /2-64 lowercase/u);
});

test('Stage-3 resumes immutable pairs and safely completes only a partial final pair', () => {
  const options = {
    variants: ['baseline', 'candidate'],
    repetitions: 3,
  };
  const report = {
    schema: 'argus.code-intelligence-stage3-evaluation.v2',
    benchmark: { caseId: 'pino-redaction-prototype-keys' },
    controls: { variants: ['baseline', 'candidate'] },
    runs: [
      { repetition: 1, variant: 'baseline' },
      { repetition: 1, variant: 'candidate' },
    ],
  };
  const resumed = stage3ResumeState(report, options, 'pino-redaction-prototype-keys');
  assert.equal(resumed.completedRepetitions, 1);
  assert.equal(resumed.runs.length, 2);
  const resumedLegacyPartial = stage3ResumeState({ runs: report.runs }, options, 'pino-redaction-prototype-keys');
  assert.equal(resumedLegacyPartial.completedRepetitions, 1);
  assert.deepEqual(resumedLegacyPartial.runs, report.runs);
  const partialPair = stage3ResumeState({ ...report, runs: report.runs.slice(0, 1) }, options, 'pino-redaction-prototype-keys');
  assert.equal(partialPair.completedRepetitions, 0);
  assert.deepEqual(partialPair.runs, report.runs.slice(0, 1));
  assert.throws(() => stage3ResumeState({
    ...report,
    runs: [report.runs[0], { repetition: 2, variant: 'baseline' }],
  }, options, 'pino-redaction-prototype-keys'), /incomplete pair/u);
  assert.throws(() => stage3ResumeState(report, { ...options, repetitions: 1 }, 'pino-redaction-prototype-keys'), /must exceed/u);
});

test('Stage-3 alternates paired execution order', () => {
  assert.deepEqual(stage3VariantOrder(0, ['baseline', 'candidate']), ['baseline', 'candidate']);
  assert.deepEqual(stage3VariantOrder(1, ['baseline', 'candidate']), ['candidate', 'baseline']);
  assert.deepEqual(stage3VariantOrder(1, ['candidate']), ['candidate']);
});

test('Stage-3 scoring emphasizes the held-out oracle and runtime implementation boundary', () => {
  const scored = scoreStage3Run({
    goldChangedFiles: ['lib/multistream.js', 'test/multistream.test.js'],
    oraclePaths: ['test/multistream.test.js'],
    changedFiles: ['lib/multistream.js'],
    reachedApproval: true,
    workflowTestsPassed: true,
    reviewPassed: true,
    oraclePassed: true,
    traceCorrelated: true,
    remoteUnchanged: true,
  });
  assert.equal(scored.checks.implementation_file_recall, 1);
  assert.equal(scored.checks.gold_file_recall, 0.5);
  assert.equal(scored.checks.gold_file_precision, 1);
  assert.equal(scored.checks.unrelated_file_count, 0);
  assert.equal(scored.score, 0.975);
});

test('Stage-3 scoring exposes retrieval-driven scope expansion', () => {
  const scored = scoreStage3Run({
    goldChangedFiles: ['lib/multistream.js', 'test/multistream.test.js'],
    oraclePaths: ['test/multistream.test.js'],
    changedFiles: [
      'docs/api.md',
      'docs/transports.md',
      'lib/multistream.js',
      'lib/tools.js',
      'pino.js',
      'test/formatters.test.js',
      'test/transport/core.test.js',
    ],
    reachedApproval: true,
    workflowTestsPassed: true,
    reviewPassed: true,
    oraclePassed: true,
    traceCorrelated: true,
    remoteUnchanged: true,
  });
  assert.equal(scored.checks.implementation_file_recall, 1);
  assert.equal(scored.checks.gold_file_recall, 0.5);
  assert.equal(scored.checks.gold_file_precision, 1 / 7);
  assert.equal(scored.checks.unrelated_file_count, 6);
  assert.equal(scored.score, 0.9321);
});

test('Stage-3 rejects generated harness artifacts instead of scoring them as model scope', () => {
  assert.deepEqual(stage3EvidenceAdmission({
    changedFiles: ['browser.js', 'graphify-out/graph.json', 'graphify-out/cache/manifest.json'],
    captureError: null,
  }), {
    admitted: false,
    reasons: ['generated_infrastructure_in_patch'],
    generatedInfrastructureFiles: ['graphify-out/graph.json', 'graphify-out/cache/manifest.json'],
  });
  assert.equal(stage3EvidenceAdmission({ changedFiles: ['browser.js'], captureError: null }).admitted, true);
  assert.deepEqual(stage3EvidenceAdmission({ changedFiles: [], captureError: 'sidecar output truncated' }).reasons, [
    'workspace_capture_failed',
  ]);
});

test('Stage-3 refuses a promotion conclusion from a single pair', () => {
  const run = (variant, repetition = 1, score = variant === 'candidate' ? 1 : 0.5) => ({
    variant,
    repetition,
    startedAt: `2026-08-16T00:0${repetition}:00.000Z`,
    finishedAt: `2026-08-16T00:0${repetition + 1}:00.000Z`,
    workflow: { retryCount: 0 },
    patch: { changedFiles: variant === 'candidate' ? ['lib/multistream.js'] : [] },
    trace: {
      inputTokens: variant === 'candidate' ? 800 : 1_000,
      outputTokens: variant === 'candidate' ? 80 : 100,
    },
    scoring: {
      score,
      checks: {
        approval_gate_reached: true,
        workflow_tests_passed: true,
        reviewer_passed: true,
        hidden_oracle_passed: variant === 'candidate',
        implementation_file_recall: variant === 'candidate' ? 1 : 0,
        gold_file_precision: variant === 'candidate' ? 1 : 0,
        unrelated_file_count: 0,
      },
    },
  });
  const pilot = summarizeStage3Runs([run('baseline'), run('candidate')], 1);
  assert.equal(pilot.candidate_minus_baseline, 0.5);
  assert.equal(pilot.interpretation, 'infrastructure-pilot-only');
  assert.equal(pilot.promotion_decision_allowed, false);

  const replicated = summarizeStage3Runs([
    run('baseline', 1, 0.95), run('candidate', 1, 1),
    run('candidate', 2, 1), run('baseline', 2, 1),
    run('baseline', 3, 0.95), run('candidate', 3, 1),
  ], 3);
  assert.equal(replicated.promotion_decision_allowed, true);
  assert.deepEqual(replicated.paired_score_outcomes, {
    candidate_wins: 2,
    baseline_wins: 0,
    ties: 1,
    pairs: 3,
  });
  assert.equal(replicated.variants.candidate.mean_input_tokens, 800);
  assert.equal(replicated.variants.baseline.mean_input_tokens, 1_000);
  assert.equal(replicated.observed_gate_checks.token_reduction_at_least_20_percent, true);
  assert.equal(replicated.observed_gate_checks.p95_runtime_within_1_5x, true);
});

test('Stage-3 can rescore immutable v1 evidence with scope-aware v2 metrics', () => {
  const completeChecks = {
    approval_gate_reached: true,
    workflow_tests_passed: true,
    reviewer_passed: true,
    hidden_oracle_passed: true,
    trace_correlated: true,
    remote_unchanged: true,
  };
  const report = {
    schema: 'argus.code-intelligence-stage3-evaluation.v1',
    benchmark: { caseId: 'pino-multistream-string-level' },
    controls: { repetitions: 1 },
    runs: [
      { variant: 'baseline', patch: { changedFiles: ['lib/multistream.js', 'test/multistream.test.js'] }, workflow: { retryCount: 1 }, scoring: { checks: completeChecks } },
      { variant: 'candidate', patch: { changedFiles: ['lib/multistream.js', 'docs/api.md'] }, workflow: { retryCount: 1 }, scoring: { checks: completeChecks } },
    ],
  };
  const rescored = rescoreStage3Report(report, {
    goldChangedFiles: ['lib/multistream.js', 'test/multistream.test.js'],
    oraclePaths: ['test/multistream.test.js'],
  }, '2026-08-16T00:00:00.000Z');
  assert.equal(rescored.schema, 'argus.code-intelligence-stage3-evaluation.v2');
  assert.equal(rescored.rescoredAt, '2026-08-16T00:00:00.000Z');
  assert.equal(rescored.runs[0].scoring.score, 1);
  assert.equal(rescored.runs[1].scoring.checks.gold_file_precision, 0.5);
  assert.equal(rescored.summary.promotion_decision_allowed, false);
});

test('Stage-3 source keeps the oracle withheld until after the approval gate', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(
    new URL('./code-intelligence-stage3-evaluation.mjs', import.meta.url),
    'utf8',
  ));
  assert.match(source, /reachedApproval\s*\? await evaluateHiddenOracle/u);
  assert.match(source, /codeContextVariant: variant/u);
  assert.match(source, /modelVisibleVariantLabel: false/u);
  assert.match(source, /tasks\/\$\{taskId\}:cancel/u);
  assert.match(source, /const workspace = await captureWorkspaceSafely/u);
  assert.match(source, /projected === null \|\| projected\.state === 'TASK_STATE_INPUT_REQUIRED'/u);
  assert.match(source, /FINALIZATION_GRACE_MS = 60_000/u);
  assert.match(source, /already captured; skipping/u);
  assert.match(source, /GITEA_BRANCH_READ_ATTEMPTS = 10/u);
  assert.match(source, /\[404, 500, 502, 503\]\.includes\(response\.status\)/u);
});
