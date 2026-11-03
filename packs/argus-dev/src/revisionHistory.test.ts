import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRevision,
  recordRevisionHumanDecision,
  recordRevisionReview,
  recordRevisionTests,
} from './revisionHistory.js';

test('retains immutable attempt-scoped coder, test and reviewer evidence', () => {
  const first = appendRevision([], {
    retryCount: 0,
    trigger: 'initial',
    triggerFeedback: '',
    coder: { output: 'draft', traceId: 'coder-1', recordedAt: '2026-08-20T10:00:00.000Z' },
  });
  const tested = recordRevisionTests(first, {
    passed: true, output: 'PASS', profiles: [], recordedAt: '2026-08-20T10:01:00.000Z',
  });
  const reviewed = recordRevisionReview(tested, {
    verdict: 'REQUEST_CHANGES', summary: 'Draft remains', findings: [{ severity: 'high', message: 'Use verified', file: 'src/app.js', line: 27 }],
    requiredChanges: ['Change draft to verified'], output: 'VERDICT: REJECTED', traceId: 'reviewer-1', recordedAt: '2026-08-20T10:02:00.000Z',
  }, [{ path: 'src/app.js', status: 'modified', additions: 1, deletions: 0, diff: '+ draft' }]);
  const second = appendRevision(reviewed, {
    retryCount: 1, trigger: 'reviewer', triggerFeedback: 'Change draft to verified',
    coder: { output: 'verified', traceId: 'coder-2', recordedAt: '2026-08-20T10:03:00.000Z' },
  });

  assert.equal(second.length, 2);
  assert.equal(second[0]?.reviewer?.verdict, 'REQUEST_CHANGES');
  assert.equal(second[0]?.fileDiffs[0]?.path, 'src/app.js');
  assert.equal(second[1]?.attempt, 2);
  assert.equal(second[1]?.trigger, 'reviewer');
  assert.equal(second[1]?.coder.traceId, 'coder-2');
});

test('records human decisions on the current revision without replacing earlier evidence', () => {
  const history = appendRevision([], {
    retryCount: 0, trigger: 'initial', triggerFeedback: '',
    coder: { output: 'done', recordedAt: '2026-08-20T10:00:00.000Z' },
  });
  const decided = recordRevisionHumanDecision(history, {
    stage: 'code', approved: false, feedback: 'Add a test', recordedAt: '2026-08-20T10:01:00.000Z',
  });
  assert.deepEqual(decided[0]?.humanDecisions[0], {
    stage: 'code', approved: false, feedback: 'Add a test', recordedAt: '2026-08-20T10:01:00.000Z',
  });
  assert.equal(history[0]?.humanDecisions.length, 0);
});
