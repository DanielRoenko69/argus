import { describe, expect, it } from '@jest/globals';
import { aggregateDisplayStatus, allowedRunActions, directDisplayStatus, statusBucket } from '../presentation.js';

const empty = { running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };

describe('run presentation state', () => {
  it('distinguishes approval, external wait and terminal states', () => {
    expect(directDisplayStatus('waiting_for_approval')).toBe('action_required');
    expect(directDisplayStatus('waiting_for_external')).toBe('waiting');
    expect(directDisplayStatus('completed')).toBe('succeeded');
    expect(directDisplayStatus('cancelled')).toBe('cancelled');
  });

  it('aggregates authorized descendant state with deterministic priority', () => {
    expect(aggregateDisplayStatus('running', { ...empty, waiting: 1 }, true)).toBe('action_required');
    expect(aggregateDisplayStatus('completed', { ...empty, failed: 1 })).toBe('failed');
    expect(aggregateDisplayStatus('completed', { ...empty, waiting: 1 })).toBe('waiting');
    expect(aggregateDisplayStatus('running', empty, false, true)).toBe('stale');
  });

  it('keeps stale children in the active count bucket', () => {
    expect(statusBucket('stale')).toBe('running');
  });

  it('derives actions from server-side execution and approval permissions', () => {
    expect(allowedRunActions(
      { kind: 'workflow', status: 'waiting_for_approval' },
      'action_required',
      { canRunAgents: false, canRunWorkflows: true, canReviewApprovals: true },
    )).toEqual(['open', 'cancel', 'review_approval']);
    expect(allowedRunActions(
      { kind: 'agent', status: 'running' },
      'active',
      { canRunAgents: false, canRunWorkflows: true, canReviewApprovals: true },
    )).toEqual(['open']);
  });
});
