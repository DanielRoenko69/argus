import { describe, expect, it } from '@jest/globals';
import { assertRuntimeWorkspacePath, assertRuntimeWorkspaceRoot } from '../runtimeWorkspace.js';

describe('managed runtime workspace scope', () => {
  it('accepts one exact ticket root and descendants', () => {
    expect(assertRuntimeWorkspaceRoot('/workspace/ARGUS-42')).toBe('/workspace/ARGUS-42');
    expect(assertRuntimeWorkspacePath('/workspace/ARGUS-42/src/index.ts', '/workspace/ARGUS-42'))
      .toBe('/workspace/ARGUS-42/src/index.ts');
  });

  it.each([
    '/workspace/ARGUS-42/../other/secret.txt',
    '/workspace/ARGUS-420/secret.txt',
    '/etc/passwd',
  ])('rejects a path outside the exact workspace: %s', candidate => {
    expect(() => assertRuntimeWorkspacePath(candidate, '/workspace/ARGUS-42')).toThrow('inside');
  });

  it.each(['/workspace', '/workspace/a/b', '/tmp/task', '/workspace/task/..'])
    ('rejects a non-ticket workspace root: %s', root => {
      expect(() => assertRuntimeWorkspaceRoot(root)).toThrow('one exact child');
    });
});
