import { describe, expect, it } from 'vitest';
import { backlogReviewPresentation, reviewOutcome } from './backlogReviewPresentation';

const rejected = { state: 'TASK_STATE_WORKING', canceling: false, stage: 'decompose_backlog',
  review: 'Define both terminal flags.\nVERDICT: REJECTED', passed: false, retries: 1, completedReviews: 1, maxAttempts: 2 };

describe('backlog review presentation', () => {
  it('explains the rejected review and same-run plan revision', () => {
    const result = backlogReviewPresentation(rejected)!;
    expect(result.title).toBe('Changes requested — revising plan · round 2/2');
    expect(result.detail).toContain('same run, not a full restart');
  });
  it('shows a new review as pending, not as approved by the previous result', () => {
    const result = backlogReviewPresentation({ ...rejected, stage: 'review_backlog' })!;
    expect(result.title).toBe('Reviewing revised plan · round 2/2');
    expect(result.detail).toContain('next verdict is still pending');
  });
  it('does not call the initial false default a rejected review', () => {
    expect(backlogReviewPresentation({ ...rejected, review: '' })).toBeNull();
  });
  it('preserves the distinction between passed review and human approval', () => {
    const result = backlogReviewPresentation({ ...rejected, state: 'TASK_STATE_INPUT_REQUIRED', stage: 'backlog_approval', passed: true })!;
    expect(result.title).toBe('Plan review passed — human approval required');
    expect(result.detail).toContain('does not approve implementation');
    expect(result.roundLabel).toBe('Round 1/2');
  });
  it('honors canceled state ahead of a retained next planner node', () => {
    const result = backlogReviewPresentation({ ...rejected, state: 'TASK_STATE_CANCELED' })!;
    expect(result.title).toBe('Run canceled');
    expect(result.detail).toContain('No plan revision is running');
    expect(result.roundLabel).toBe('Round 1/2');
  });
  it('does not claim progress while cancellation is pending', () => {
    expect(backlogReviewPresentation({ ...rejected, canceling: true })!.title).toBe('Cancellation requested');
  });
  it('does not mistake an earlier passed review for a pending human approval during revision', () => {
    const result = backlogReviewPresentation({ ...rejected, passed: true, humanChangeRequest: 'Clarify the benchmark' })!;
    expect(result.title).toBe('Human changes requested — revising plan · round 2');
    expect(result.detail).toContain('must be reviewed and approved separately');
  });
  it('does not show the automatic limit as a total cap on human-requested reviews', () => {
    const result = backlogReviewPresentation({ ...rejected, state: 'TASK_STATE_INPUT_REQUIRED', passed: true, completedReviews: 3, humanChangeRequest: 'Add tests' })!;
    expect(result.roundLabel).toBe('Round 3');
    expect(result.policy).toContain('Human-requested revisions may add review rounds');
  });
  it('explains exhaustion only when the retry counter reaches the published limit', () => {
    expect(backlogReviewPresentation({ ...rejected, state: 'TASK_STATE_FAILED' })!.title).toBe('Workflow stopped');
    const exhausted = backlogReviewPresentation({ ...rejected, state: 'TASK_STATE_FAILED', retries: 2, completedReviews: 2 })!;
    expect(exhausted.title).toBe('Review limit reached — changes still required');
    expect(exhausted.roundLabel).toBe('Round 2/2');
  });
  it('does not invent a limit for old or malformed catalogs', () => {
    for (const maxAttempts of [undefined, NaN, 0, 101]) {
      const result = backlogReviewPresentation({ ...rejected, maxAttempts })!;
      expect(result.roundLabel).toBe('Round 2');
      expect(result.policy).toBe('Automatic review limit unavailable.');
    }
  });
  it('does not infer a verdict from successful execution or quoted mentions', () => {
    expect(reviewOutcome('Agent completed')).toBeNull();
    expect(reviewOutcome('Example: VERDICT: APPROVED')).toBeNull();
    expect(reviewOutcome('VERDICT: APPROVED\nVERDICT: REJECTED')).toBeNull();
    expect(reviewOutcome('VERDICT: REJECTED')).toBe('changes-requested');
    expect(reviewOutcome('  VERDICT: APPROVED\n')).toBe('approved');
  });
});
