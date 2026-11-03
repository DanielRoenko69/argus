import assert from 'node:assert/strict';
import test from 'node:test';
import { extractHumanChangeRequest, formatHumanChangeRequestForReviewer } from './humanFeedback.js';

test('approval rationale is not treated as a code change request', () => {
  assert.equal(extractHumanChangeRequest({ approved: true, feedback: 'Looks good; note the deployment window.' }), '');
});

test('rejection feedback becomes an actionable coder request', () => {
  assert.equal(extractHumanChangeRequest({ approved: false, feedback: '  Add the version field to the response.  ' }), 'Add the version field to the response.');
});

test('reviewer receives an explicit human change request section', () => {
  assert.equal(
    formatHumanChangeRequestForReviewer('Add the version field.'),
    'Human change request (must be satisfied):\nAdd the version field.\n\n',
  );
  assert.equal(formatHumanChangeRequestForReviewer('  '), '');
});
