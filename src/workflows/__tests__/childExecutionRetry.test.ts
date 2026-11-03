import { resolveRetryableForEachItem } from '../childExecutionRetry.js';
import type { StepResult } from '../types.js';

const stepResults: Record<string, StepResult> = {
  fanout: {
    status: 'completed',
    duration_ms: 12,
    result: {
      total: 2,
      succeeded: 1,
      failed: 1,
      values: ['ok', null],
      results: [
        { index: 0, status: 'completed', attempts: 1, value: 'ok' },
        {
          index: 1,
          status: 'failed',
          attempts: 2,
          error: 'child failed',
          evidence: { execution_id: 42, status: 'failed' },
          attempt_evidence: [{ execution_id: 41 }, { execution_id: 42 }],
        },
      ],
    },
  },
};

describe('resolveRetryableForEachItem', () => {
  it('returns the exact failed item checkpoint', () => {
    const checkpoint = resolveRetryableForEachItem(stepResults, 'fanout', 1);
    expect(checkpoint.item).toMatchObject({ index: 1, status: 'failed', attempts: 2 });
    expect(checkpoint.result.values).toEqual(['ok', null]);
  });

  it('does not retry an already successful item', () => {
    expect(() => resolveRetryableForEachItem(stepResults, 'fanout', 0)).toThrow('item 0 is not failed');
  });

  it('rejects malformed or missing item evidence', () => {
    expect(() => resolveRetryableForEachItem({}, 'fanout', 1)).toThrow('has no persisted result');
    expect(() => resolveRetryableForEachItem({ fanout: { status: 'completed', duration_ms: 0, result: 'not-json' } }, 'fanout', 1))
      .toThrow('has no persisted For Each item evidence');
  });
});
