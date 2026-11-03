import assert from 'node:assert/strict';
import test from 'node:test';
import { backlogReviewFeedback, backlogReviewPrompt, BACKLOG_PLANNING_BOUNDARY } from './backlogReviewFeedback.js';

test('first planning pass has no invented reviewer findings', () => {
  assert.equal(backlogReviewFeedback({}), '');
  assert.equal(backlogReviewFeedback({ review: 'APPROVED', review_passed: true }), '');
});

test('planning reviewer receives original scope and accepts tracked, unfulfilled CI prerequisites', () => {
  const prompt = backlogReviewPrompt({ issue_title: 'GEM batch', issue_body: 'PMSM scope', backlog_constraints: 'No builds or writes', backlog_audience: 'Owners', context: 'Repository evidence', backlog_tasks: 'CI setup is prerequisite 0' });
  for (const text of ['GEM batch', 'PMSM scope', 'No builds or writes', 'Owners', 'CI setup is prerequisite 0']) assert.ok(prompt.includes(text));
  assert.ok(prompt.startsWith(BACKLOG_PLANNING_BOUNDARY));
  assert.match(prompt, /Do not require their actual provisioning/);
  assert.match(prompt, /Do not reject solely/);
  assert.match(prompt, /Reject substantive contradictions, unsafe proposals/);
  assert.match(prompt, /Human planning approval remains separate/);
  assert.match(prompt, /Do not invent a named owner/);
});
test('rejected review reaches the planner with its previous plan and bounded evidence', () => {
  const prompt = backlogReviewFeedback({ review: 'REJECTED: specify numeric tolerances', backlog_tasks: '1. Vectorize PMSM', review_passed: false });
  assert.match(prompt, /numeric tolerances/);
  assert.match(prompt, /Vectorize PMSM/);
  assert.match(prompt, /not authorization/);
  assert.ok(backlogReviewFeedback({ review: 'a'.repeat(50_000), backlog_tasks: 'b'.repeat(50_000) }).length < 33_000);
});
