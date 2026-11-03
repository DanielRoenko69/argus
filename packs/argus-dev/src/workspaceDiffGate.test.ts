import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateWorkspaceDiffStatus,
  extractTicketFileTargets,
  WORKSPACE_GIT_STATUS_COMMAND,
} from './workspaceDiffGate.js';

test('blocks an empty workspace before the test agent is called', () => {
  const result = evaluateWorkspaceDiffStatus('  \n');

  assert.deepEqual(result, {
    passed: false,
    output:
      'NO_WORKSPACE_DIFF: The Coder completed without changing any files. ' +
      'Retry the implementation and use workspace_write before running tests.',
  });
});

test('accepts tracked and untracked workspace changes', () => {
  assert.equal(evaluateWorkspaceDiffStatus(' M src/math.js\n'), null);
  assert.equal(evaluateWorkspaceDiffStatus('?? test/math.test.js\n'), null);
});

test('requires expanded untracked paths before checking an explicit file target', () => {
  assert.equal(WORKSPACE_GIT_STATUS_COMMAND, 'git status --porcelain --untracked-files=all');
  const status = '?? docs/hermes-bridge-certification.md\n';
  assert.equal(evaluateWorkspaceDiffStatus(status, ['docs/hermes-bridge-certification.md']), null);
});

test('extracts explicit ticket file targets without treating endpoint paths as files', () => {
  assert.deepEqual(
    extractTicketFileTargets('Add GET /ready in `src/app.js` and tests in test/app.test.js.'),
    ['src/app.js', 'test/app.test.js'],
  );
});

test('does not require paths named inside a negated ticket clause', () => {
  assert.deepEqual(
    extractTicketFileTargets(
      'Modify the existing service; do not create a new app or src/index.js. ' +
      'In src/app.js add GET /ready. In test/app.test.js add an automated test.',
    ),
    ['src/app.js', 'test/app.test.js'],
  );
});

test('blocks a superficial diff when an explicitly required test file is unchanged', () => {
  assert.deepEqual(
    evaluateWorkspaceDiffStatus(' M src/app.js\n', ['src/app.js', 'test/app.test.js']),
    {
      passed: false,
      output:
        'REQUIRED_FILES_UNCHANGED: The ticket explicitly requires changes to: test/app.test.js. ' +
        'Implement those files and their tests before running the test suite.',
    },
  );
});

test('accepts a diff that covers all explicit ticket files', () => {
  assert.equal(evaluateWorkspaceDiffStatus(
    ' M src/app.js\n M test/app.test.js\n',
    ['src/app.js', 'test/app.test.js'],
  ), null);
});
