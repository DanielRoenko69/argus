import { describe, expect, it } from 'vitest';
import '../more';
import { getNodeDefinition } from '../registry';

describe('For Each node', () => {
  it('exposes transform, sub-workflow and bounded execution controls', () => {
    const definition = getNodeDefinition('logic.for_each');
    expect(definition?.icon).toBe('Repeat2');
    expect(definition?.fields.map(field => field.name)).toEqual([
      'mode',
      'items',
      'function_code',
      'target_workflow_id',
      'child_inputs',
      'concurrency',
      'retries',
      'on_item_error',
    ]);
    expect(definition?.defaultData()).toMatchObject({
      mode: 'transform', concurrency: 4, retries: 0, on_item_error: 'stop',
    });
  });
});
