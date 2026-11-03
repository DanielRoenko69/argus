import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBenchmarkOptions,
  profileOrder,
  scoreBenchmarkRun,
  summarizeBenchmark,
} from './benchmark-codex-runtime-profiles.mjs';

test('runtime benchmark defaults to three paired Spark versus Deep tasks', () => {
  assert.deepEqual(parseBenchmarkOptions([]), {
    taskIds: ['docs-only', 'readiness-endpoint', 'default-tier-cross-file'],
    profiles: ['spark', 'deep'],
    timeoutMinutes: 20,
    reportTag: null,
    dryRun: false,
    resumeReports: [],
  });
  assert.equal(parseBenchmarkOptions(['--dry-run']).dryRun, true);
  assert.deepEqual(parseBenchmarkOptions(['--resume-reports', 'a.json,b.json']).resumeReports, ['a.json', 'b.json']);
  assert.throws(() => parseBenchmarkOptions(['--profiles', 'spark,unknown']), /Unknown benchmark profiles/u);
  assert.throws(() => parseBenchmarkOptions(['--tasks', 'docs-only,docs-only']), /must not contain duplicates/u);
});

test('runtime benchmark alternates paired profile order', () => {
  assert.deepEqual(profileOrder(0, ['spark', 'deep']), ['spark', 'deep']);
  assert.deepEqual(profileOrder(1, ['spark', 'deep']), ['deep', 'spark']);
});

test('runtime benchmark requires governed evidence, exact scope, runtime identity, and immutable remote for a perfect score', () => {
  const run = {
    expectedFiles: ['src/app.js', 'test/app.test.js'],
    changedFiles: ['src/app.js', 'test/app.test.js'],
    expectedModel: 'gpt-example',
    stage: 'human_approval',
    taskState: 'TASK_STATE_INPUT_REQUIRED',
    testsPassed: true,
    reviewPassed: true,
    remoteBefore: 'abc',
    remoteAfter: 'abc',
    trace: {
      agents: ['planner', 'knowledge', 'coder', 'reviewer'].map(agent => ({
        agent, model: 'gpt-example', status: 'completed',
      })),
    },
  };
  assert.deepEqual(scoreBenchmarkRun(run), {
    score: 1,
    checks: {
      approvalGateReached: true,
      testsPassed: true,
      reviewPassed: true,
      expectedFileRecall: 1,
      scopePrecision: 1,
      modelMatch: true,
      remoteUnchanged: true,
    },
  });
  assert.equal(scoreBenchmarkRun({ ...run, changedFiles: [...run.changedFiles, 'README.md'] }).score, 0.9667);
  assert.equal(scoreBenchmarkRun({ ...run, remoteAfter: 'def' }).score, 0.95);
});

test('runtime benchmark summary remains a directional pilot after one pair', () => {
  const makeRun = (profile, taskId, score, wallDurationMs, inputTokens, retryCount = 0) => ({
    profile,
    taskId,
    scoring: { score },
    wallDurationMs,
    retryCount,
    trace: { inputTokens, outputTokens: 100 },
  });
  const summary = summarizeBenchmark([
    makeRun('spark', 'easy', 1, 1_000, 2_000),
    makeRun('deep', 'easy', 1, 2_000, 3_000),
  ]);
  assert.equal(summary.interpretation, 'single-pair-local-pilot');
  assert.equal(summary.promotionDecisionAllowed, false);
  assert.equal(summary.comparisons[0].observedWinner, 'spark');
  assert.equal(summary.profiles.spark.meanInputTokens, 2_000);
});
