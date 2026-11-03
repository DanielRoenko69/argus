import { describe, expect, it } from '@jest/globals';
import { findCopilotGraphIssues } from '../copilotRoutes.js';

const node = (id: string, type = 'trigger.manual') => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id },
});

describe('findCopilotGraphIssues', () => {
  it('accepts new edges that connect existing and proposed nodes', () => {
    expect(findCopilotGraphIssues(
      [node('existing')],
      [node('generated', 'logic.response')],
      [{ source: 'existing', target: 'generated' }],
    )).toEqual([]);
  });

  it('rejects node id collisions and dangling generated edges', () => {
    expect(findCopilotGraphIssues(
      [node('existing')],
      [node('existing', 'logic.response')],
      [{ source: 'existing', target: 'missing' }],
    )).toEqual([
      'existing: proposed node id collides with an existing or proposed node',
      'existing -> missing: edge references a missing node',
    ]);
  });
});
