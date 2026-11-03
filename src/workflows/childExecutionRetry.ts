import type { ForEachItemResult, ForEachResult } from './dataTransforms.js';
import type { StepResult } from './types.js';

export interface RetryableForEachItem {
  stepId: string;
  itemIndex: number;
  item: ForEachItemResult;
  result: ForEachResult;
}

/**
 * Resolves an item-level recovery checkpoint without changing the immutable
 * parent result. The retry execution itself is persisted as another child run
 * with the same parent step/item lineage.
 */
export function resolveRetryableForEachItem(
  stepResults: Record<string, StepResult>,
  stepId: string,
  itemIndex: number,
): RetryableForEachItem {
  if (!stepId.trim()) throw new Error('For Each step id is required');
  if (!Number.isInteger(itemIndex) || itemIndex < 0) throw new Error('For Each item index must be a non-negative integer');

  const stepResult = stepResults[stepId];
  if (!stepResult) throw new Error(`For Each step '${stepId}' has no persisted result`);
  const result = forEachResult(stepResult.result);
  if (!result) throw new Error(`Step '${stepId}' has no persisted For Each item evidence`);
  const item = result.results.find(candidate => candidate.index === itemIndex);
  if (!item) throw new Error(`For Each item ${itemIndex} was not settled in step '${stepId}'`);
  if (item.status !== 'failed') throw new Error(`For Each item ${itemIndex} is not failed`);
  return { stepId, itemIndex, item, result };
}

function forEachResult(value: unknown): ForEachResult | null {
  if (!isRecord(value) || !Array.isArray(value['results']) || !Array.isArray(value['values'])) return null;
  const results = value['results'].flatMap(entry => {
    if (!isRecord(entry)) return [];
    const index = Number(entry['index']);
    const attempts = Number(entry['attempts']);
    const status = entry['status'];
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(attempts) || attempts < 1
      || (status !== 'completed' && status !== 'failed')) return [];
    return [{
      index,
      attempts,
      status,
      ...(entry['value'] === undefined ? {} : { value: entry['value'] }),
      ...(typeof entry['error'] === 'string' ? { error: entry['error'] } : {}),
      ...(entry['evidence'] === undefined ? {} : { evidence: entry['evidence'] }),
      ...(Array.isArray(entry['attempt_evidence']) ? { attempt_evidence: entry['attempt_evidence'] } : {}),
    } satisfies ForEachItemResult];
  });
  if (results.length !== value['results'].length) return null;
  return {
    total: Number(value['total']),
    succeeded: Number(value['succeeded']),
    failed: Number(value['failed']),
    results,
    values: value['values'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
