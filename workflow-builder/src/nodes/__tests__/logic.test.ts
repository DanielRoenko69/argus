import { describe, expect, it } from 'vitest';
import '../logic';
import { getNodeDefinition } from '../registry';

describe('portable branching nodes', () => {
  it('exposes explicit true and false targets for Condition', () => {
    const condition = getNodeDefinition('logic.condition');
    expect(condition?.fields.map(field => field.name)).toEqual([
      'condition', 'true_target', 'false_target',
    ]);
  });

  it('exposes value mapping and fallback target for Router', () => {
    const router = getNodeDefinition('logic.router');
    expect(router?.fields.map(field => field.name)).toEqual([
      'route_on', 'routes', 'default_route',
    ]);
  });
});
