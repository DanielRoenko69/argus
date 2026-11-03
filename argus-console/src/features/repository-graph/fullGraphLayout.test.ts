import { describe, expect, it } from 'vitest';
import { fullGraphNodeId, layoutRepositoryFullGraph } from './fullGraphLayout';
import type { RepositoryFullGraph } from './types';

const graph: RepositoryFullGraph = {
  schemaVersion: 1,
  snapshot: { id: '42', repository: 'org/repo', branch: 'main', commitSha: 'a'.repeat(40), graphDigest: `sha256:${'b'.repeat(64)}`, provider: 'graphify', parserVersion: null, schemaVersion: 'v1', status: 'ready', immutable: true },
  files: [['1', 'src/a.ts', 'typescript', 'src'], ['2', 'tests/a.test.ts', 'typescript', 'tests']],
  symbols: [['11', 'alpha', 'function', 0, 1, 3], ['12', 'beta', 'function', 0, 5, 8]],
  relationTypes: ['calls'],
  edges: [[0, 1, 0]],
  truncated: false,
  truncationReasons: [],
  appliedLimits: { maxNodes: 50_000, maxEdges: 150_000, maxResponseBytes: 1, returnedNodes: 4, returnedEdges: 3, elapsedMs: 1 },
};

describe('layoutRepositoryFullGraph', () => {
  it('places every file and symbol deterministically and counts implicit declarations', () => {
    const first = layoutRepositoryFullGraph(graph);
    const second = layoutRepositoryFullGraph(graph);
    expect([...first.x]).toEqual([...second.x]);
    expect([...first.y]).toEqual([...second.y]);
    expect(first.x).toHaveLength(4);
    expect(first.modules.map(module => module.name)).toEqual(['src', 'tests']);
    expect([...first.degree]).toEqual([2, 0, 2, 2]);
    expect(fullGraphNodeId(graph, 0)).toBe('file:1');
    expect(fullGraphNodeId(graph, 3)).toBe('symbol:12');
  });
});
