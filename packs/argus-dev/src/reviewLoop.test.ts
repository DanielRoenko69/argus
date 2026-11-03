import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewAcceptanceContext,
  canRequestAnotherRevision,
  formatReviewDecision,
  normalizeDecisionEvidence,
  normalizeRevisionFeedback,
  parseReviewDecision,
} from './reviewLoop.js';

test('keeps the original ticket authoritative over an intermediate plan', () => {
  const context = buildReviewAcceptanceContext(
    'The final response must be verified.',
    'First create a draft response.',
  );
  assert.match(context, /Authoritative ticket acceptance criteria/);
  assert.match(context, /final response must be verified/);
  assert.match(context, /plan may sequence work, but it cannot weaken/);
  assert.match(context, /mentioned only by the plan is advisory and must not block approval/);
  assert.match(context, /request the remaining changes/);
  assert.match(context, /QA test design is supporting evidence/);
  assert.match(context, /report every known blocking finding together/);
  assert.match(context, /not one new criterion per revision/);
});

test('prevents a planner-only runtime command from becoming an acceptance criterion', () => {
  const context = buildReviewAcceptanceContext(
    'Fix the envvar hint and add a focused regression test.',
    'Run the test with a specific optional py3.13 tox environment.',
    {
      attempt: 2,
      priorReviews: [{
        verdict: 'REQUEST_CHANGES',
        summary: 'The optional py3.13 environment was unavailable.',
        requiredChanges: ['Provide py3.13 and rerun tox.'],
      }],
    },
  );
  assert.match(context, /plan.*cannot.*add final acceptance criteria/i);
  assert.match(context, /Do not perpetuate a prior rejection whose requirement is unsupported by the ticket/);
});

test('makes prior review decisions authoritative for attempt-relative ticket criteria', () => {
  const context = buildReviewAcceptanceContext(
    'Treat the first implementation as a draft and request one verified correction.',
    'Implement, review, revise, and approve.',
    {
      attempt: 2,
      priorReviews: [{
        verdict: 'REQUEST_CHANGES',
        summary: 'The first draft omitted response-header coverage.',
        requiredChanges: ['Assert the JSON response header.'],
      }],
    },
  );
  assert.match(context, /Current implementation attempt: 2/);
  assert.match(context, /Prior reviewer rejections: 1/);
  assert.match(context, /Assert the JSON response header/);
  assert.match(context, /already satisfied after a persisted prior REQUEST_CHANGES/);
  assert.match(context, /Do not repeat a process-only rejection/);
});

test('parses a tolerant fenced reviewer decision', () => {
  const decision = parseReviewDecision(`Review complete.\n\`\`\`json
{"verdict":"REQUEST_CHANGES","summary":"One regression remains.","findings":[{"severity":"high","message":"Missing authorization check","file":"src/api.ts","line":42}],"required_changes":["Add the authorization check"]}
\`\`\``);
  assert.equal(decision.verdict, 'REQUEST_CHANGES');
  assert.equal(decision.findings[0]?.file, 'src/api.ts');
  assert.match(formatReviewDecision(decision), /VERDICT: REJECTED/);
  assert.match(formatReviewDecision(decision), /Add the authorization check/);
});

test('rejects an ambiguous free-form reviewer answer', () => {
  assert.throws(() => parseReviewDecision('Looks good to me'), /JSON object/);
});

test('prevents contradictory approvals and unactionable change requests', () => {
  assert.throws(() => parseReviewDecision(JSON.stringify({
    verdict: 'APPROVE', summary: 'Looks good', findings: [], required_changes: ['Fix it'],
  })), /APPROVE cannot contain required changes/);
  assert.throws(() => parseReviewDecision(JSON.stringify({
    verdict: 'REQUEST_CHANGES', summary: 'Not ready', findings: [], required_changes: [],
  })), /requires at least one concrete change/);
});

test('enforces the global revision budget boundary', () => {
  assert.equal(canRequestAnotherRevision(3, 4), true);
  assert.equal(canRequestAnotherRevision(4, 4), false);
  assert.equal(canRequestAnotherRevision(5, 4), false);
});

test('turns an empty rejection into bounded actionable retry state', () => {
  assert.equal(normalizeRevisionFeedback(true, 'approval rationale', 'fallback'), '');
  assert.equal(normalizeRevisionFeedback(false, '  Add a test.  ', 'fallback'), 'Add a test.');
  assert.equal(normalizeRevisionFeedback(false, '', 'No details supplied.'), 'No details supplied.');
});

test('preserves an approval rationale as decision evidence without making it retry feedback', () => {
  assert.equal(normalizeDecisionEvidence('  CI passed; create the PR only.  '), 'CI passed; create the PR only.');
  assert.equal(normalizeDecisionEvidence('', 'Rejected without details.'), 'Rejected without details.');
  assert.equal(normalizeRevisionFeedback(true, 'CI passed; create the PR only.', 'fallback'), '');
});
