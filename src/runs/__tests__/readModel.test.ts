import { describe, expect, it } from '@jest/globals';
import type { RunReadModelQuery, RunSourceRecord } from '../types.js';
import { buildRunPageV2 } from '../readModel.js';
import { decodeRunCursor } from '../validation.js';

const policy = { canRunAgents: true, canRunWorkflows: true, canReviewApprovals: true };
const baseQuery: RunReadModelQuery = {
  view: 'root', includeChildren: 'summary', limit: 50, cursor: null,
  kinds: [], statuses: [], tagIds: [], query: '', hours: 2160,
};

function run(overrides: Partial<RunSourceRecord> = {}): RunSourceRecord {
  return {
    id: '1', kind: 'workflow', title: 'Root workflow', status: 'running',
    startedAt: '2026-09-07T12:00:00.000Z', updatedAt: '2026-09-07T12:00:01.000Z', durationMs: null,
    traceId: 'trace-root', rootTraceId: 'trace-root', parentTraceId: null,
    parentExecutionId: null, retryOfExecutionId: null, requestedParent: false, staleCandidate: false,
    attentionReason: null, currentPhase: 'plan', resourceRefs: [], evidenceCompleteness: 'missing',
    href: '/runs/workflow/1',
    ...overrides,
  };
}

describe('hierarchical run read model', () => {
  it('groups cross-runtime traces and retries below one visible root', () => {
    const page = buildRunPageV2([
      run(),
      run({
        id: 'agent-child', kind: 'agent', title: 'Planner', status: 'completed',
        traceId: 'trace-agent', rootTraceId: 'trace-root', parentTraceId: 'trace-root',
        requestedParent: true, href: '/runs/agent/trace-agent',
      }),
      run({
        id: '2', title: 'Retry', status: 'failed', traceId: 'trace-retry', rootTraceId: 'trace-root',
        retryOfExecutionId: '1', requestedParent: true, updatedAt: '2026-09-07T12:00:03.000Z',
        href: '/runs/workflow/2',
      }),
    ], baseQuery, policy, new Date('2026-09-07T12:01:00.000Z'));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: '1', displayStatus: 'active', updatedAt: '2026-09-07T12:00:03.000Z',
      childCounts: { running: 0, waiting: 0, completed: 1, failed: 1, cancelled: 0 },
    });
  });

  it('surfaces descendant approvals as action required', () => {
    const page = buildRunPageV2([
      run({ status: 'completed' }),
      run({
        id: 'approval-child', kind: 'agent', status: 'waiting_for_approval', traceId: 'approval-trace',
        parentTraceId: 'trace-root', rootTraceId: 'trace-root', requestedParent: true,
      }),
    ], baseQuery, policy);
    expect(page.items[0]?.displayStatus).toBe('action_required');
  });

  it('keeps inaccessible children out when the authorized source set excludes them', () => {
    const page = buildRunPageV2([run({ status: 'completed' })], baseQuery, policy);
    expect(page.items[0]).toMatchObject({ displayStatus: 'succeeded', childCounts: {
      running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0,
    } });
  });

  it('returns missing-parent history as an explicit orphan root', () => {
    const page = buildRunPageV2([
      run({ id: 'orphan', kind: 'agent', traceId: 'trace-orphan', rootTraceId: 'missing-root', requestedParent: true }),
    ], baseQuery, policy);
    expect(page.orphanCount).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: 'orphan', parentRunId: null, rootTraceId: 'trace-orphan', orphaned: true,
    });
  });

  it('embeds children only when explicitly requested', () => {
    const records = [
      run(),
      run({ id: 'child', kind: 'agent', traceId: 'child-trace', parentTraceId: 'trace-root', requestedParent: true }),
    ];
    expect(buildRunPageV2(records, baseQuery, policy).items[0]?.children).toBeUndefined();
    const full = buildRunPageV2(records, { ...baseQuery, includeChildren: 'full' }, policy);
    expect(full.items[0]?.children?.[0]).toMatchObject({ id: 'child', parentRunId: '1' });
  });

  it('filters root families by descendant tags and text', () => {
    const taggedChild = run({
      id: 'child', kind: 'agent', title: 'Payments reviewer', traceId: 'child-trace',
      parentTraceId: 'trace-root', requestedParent: true,
      resourceRefs: [{
        type: 'agent', id: '4', label: 'Payments reviewer', href: '/build/agents/4', version: null,
        tags: [{ id: '7', label: 'Payments', color: null }], capturedAt: '2026-09-07T12:00:00.000Z',
      }],
    });
    const page = buildRunPageV2(
      [run(), taggedChild],
      { ...baseQuery, query: 'reviewer', tagIds: ['7'] },
      policy,
    );
    expect(page.items.map(item => item.id)).toEqual(['1']);
  });

  it('uses a stable cursor across equal timestamps', () => {
    const records = [
      run({ id: '1', status: 'completed' }),
      run({ id: '2', status: 'completed', traceId: 'trace-2', rootTraceId: 'trace-2' }),
      run({ id: '3', status: 'completed', traceId: 'trace-3', rootTraceId: 'trace-3' }),
    ];
    const first = buildRunPageV2(records, { ...baseQuery, limit: 2 }, policy);
    expect(first.items.map(item => item.id)).toEqual(['1', '2']);
    expect(decodeRunCursor(first.nextCursor!)).toMatchObject({ id: 'workflow:2' });
    const second = buildRunPageV2(records, { ...baseQuery, limit: 2, cursor: first.nextCursor }, policy);
    expect(second.items.map(item => item.id)).toEqual(['3']);
  });
});
