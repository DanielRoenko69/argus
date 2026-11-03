import { describe, expect, it } from '@jest/globals';
import { diffSolutionPackManifests } from '../diff.js';

describe('Solution Pack upgrade diff', () => {
  it('returns stable nested changes and distinguishes additions/removals', () => {
    const changes = diffSolutionPackManifests(
      { metadata: { id: 'argus.dev', version: '0.4.0' }, spec: { components: { workflows: ['ticket-to-pull-request'] } } } as never,
      { metadata: { id: 'argus.dev', version: '0.5.0' }, spec: { components: { workflows: ['ticket-to-pull-request', 'pull-request-review'] } } } as never,
    );
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'metadata.version', kind: 'changed' }),
      expect.objectContaining({ path: 'spec.components.workflows', kind: 'changed' }),
    ]));
  });

  it('does not report a diff when no manifests are available', () => {
    expect(diffSolutionPackManifests(undefined, undefined)).toEqual([]);
  });
});
