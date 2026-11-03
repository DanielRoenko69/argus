import { describe, expect, it } from '@jest/globals';
import { loadRepositoryFullGraph, loadRepositoryGraphNeighborhood, loadRepositoryGraphOverview } from '../repositoryGraphService.js';
import type { RepositoryGraphDataSource } from '../repositoryGraphStore.js';
import type {
  RepositoryGraphEdge,
  RepositoryGraphNode,
  RepositoryGraphOverviewData,
  RepositoryGraphQuery,
  RepositoryGraphSnapshot,
} from '../repositoryGraphTypes.js';
import { parseRepositoryGraphQuery } from '../repositoryGraphValidation.js';

const graphNodes: RepositoryGraphNode[] = [
  { id: 'file:1', type: 'file', label: 'a.ts', href: null, metadata: { path: 'src/a.ts' } },
  { id: 'symbol:11', type: 'symbol', label: 'alpha', href: null, metadata: { kind: 'function' } },
  { id: 'symbol:12', type: 'symbol', label: 'beta', href: null, metadata: { kind: 'function' } },
  { id: 'symbol:13', type: 'symbol', label: 'gamma', href: null, metadata: { kind: 'function' } },
];

const graphEdges: RepositoryGraphEdge[] = [
  { id: 'declares:1:11', source: 'file:1', target: 'symbol:11', type: 'declares' },
  { id: 'edge:1', source: 'symbol:11', target: 'symbol:12', type: 'calls' },
  { id: 'edge:2', source: 'symbol:12', target: 'symbol:11', type: 'calls' },
  { id: 'edge:3', source: 'symbol:12', target: 'symbol:12', type: 'calls' },
  { id: 'edge:4', source: 'symbol:12', target: 'symbol:13', type: 'imports' },
];

function snapshot(status: RepositoryGraphSnapshot['status'] = 'ready'): RepositoryGraphSnapshot {
  return {
    id: '42', repository: 'org/repo', branch: 'main', commitSha: 'a'.repeat(40),
    graphDigest: `sha256:${'b'.repeat(64)}`, provider: 'graphify', parserVersion: 'v1',
    schemaVersion: 'argus-graphify-v3', status, immutable: true,
  };
}

function source(options: { status?: RepositoryGraphSnapshot['status']; missing?: boolean } = {}): RepositoryGraphDataSource {
  return {
    async loadAuthorizedSnapshot() { return options.missing ? null : snapshot(options.status); },
    async resolveKnownEdgeTypes(_snapshotId, requested) {
      return requested.filter(type => ['declares', 'calls', 'imports'].includes(type));
    },
    async resolveSeedNodes(_snapshotId, input) {
      if (input.seed != null) return graphNodes.filter(node => node.id === input.seed && input.nodeTypes.includes(node.type));
      return graphNodes.filter(node => input.nodeTypes.includes(node.type)
        && (node.label.includes(input.search ?? '') || String(node.metadata['path'] ?? '').includes(input.search ?? '')));
    },
    async expand(_snapshotId, frontier, input) {
      const selectedTypes = new Set(input.nodeTypes);
      const selectedEdges = graphEdges.filter(edge => {
        if (input.edgeTypes.length > 0 && !input.edgeTypes.includes(edge.type)) return false;
        const sourceNode = graphNodes.find(node => node.id === edge.source)!;
        const targetNode = graphNodes.find(node => node.id === edge.target)!;
        if (!selectedTypes.has(sourceNode.type) || !selectedTypes.has(targetNode.type)) return false;
        return (input.direction !== 'inbound' && frontier.includes(edge.source))
          || (input.direction !== 'outbound' && frontier.includes(edge.target));
      });
      const page = selectedEdges.slice(0, input.limit);
      const ids = new Set(page.flatMap(edge => [edge.source, edge.target]));
      return {
        edges: page,
        nodes: graphNodes.filter(node => ids.has(node.id)),
        truncated: selectedEdges.length > page.length,
      };
    },
    async loadArchitectureOverview(): Promise<RepositoryGraphOverviewData> {
      return {
        totals: { files: 4, symbols: 3, edges: 4, documents: 7, testFiles: 1, modules: 2, dependencies: 1 },
        modules: [
          { id: 'module:c3Jj', path: 'src', fileCount: 3, symbolCount: 3, documentCount: 6, testFileCount: 1, languages: { typescript: 3 } },
          { id: 'module:ZG9jcw', path: 'docs', fileCount: 1, symbolCount: 0, documentCount: 1, testFileCount: 0, languages: { markdown: 1 } },
        ],
        dependencies: [{ id: 'module-edge:c3Jj:ZG9jcw', source: 'module:c3Jj', target: 'module:ZG9jcw', relationCount: 2, relations: ['references'] }],
        truncated: false,
      };
    },
    async loadFullGraph() {
      return {
        files: [{ id: '1', path: 'src/a.ts', language: 'typescript', module: 'src' }],
        symbols: graphNodes.filter(node => node.type === 'symbol').map((node, index) => ({
          id: node.id.slice('symbol:'.length), fileId: '1', label: node.label,
          kind: 'function', startLine: index + 1, endLine: index + 1,
        })),
        edges: graphEdges.filter(edge => edge.id.startsWith('edge:')).map(edge => ({
          sourceSymbolId: edge.source.slice('symbol:'.length),
          targetSymbolId: edge.target.slice('symbol:'.length),
          type: edge.type,
        })),
        truncated: false,
        truncationReasons: [],
      };
    },
  };
}

function query(input: Record<string, unknown>): RepositoryGraphQuery {
  return parseRepositoryGraphQuery(input);
}

describe('bounded repository graph service', () => {
  it('packs the complete file, symbol, declaration and provider graph by stable indexes', async () => {
    const result = await loadRepositoryFullGraph(source(), 42, { allowedBundleIds: [7] });
    expect(result).toMatchObject({
      schemaVersion: 1,
      snapshot: { id: '42', immutable: true },
      files: [['1', 'src/a.ts', 'typescript', 'src']],
      relationTypes: ['calls', 'imports'],
      truncated: false,
      appliedLimits: { returnedNodes: 4, returnedEdges: 7 },
    });
    expect(result.symbols).toEqual([
      ['11', 'alpha', 'function', 0, 1, 1],
      ['12', 'beta', 'function', 0, 2, 2],
      ['13', 'gamma', 'function', 0, 3, 3],
    ]);
    expect(result.edges).toContainEqual([0, 1, 0]);
    expect(result.edges).toContainEqual([1, 2, 1]);
  });

  it('returns a bounded architecture overview behind the same snapshot authorization', async () => {
    const result = await loadRepositoryGraphOverview(source(), 42, { allowedBundleIds: [7] });
    expect(result).toMatchObject({
      schemaVersion: 1,
      snapshot: { id: '42', immutable: true },
      totals: { modules: 2, dependencies: 1, testFiles: 1 },
      modules: expect.arrayContaining([expect.objectContaining({ path: 'src', languages: { typescript: 3 } })]),
      dependencies: [{ source: 'module:c3Jj', target: 'module:ZG9jcw', relationCount: 2 }],
      appliedLimits: { maxModules: 40, maxDependencies: 120, returnedModules: 2, returnedDependencies: 1 },
    });
    await expect(loadRepositoryGraphOverview(source({ missing: true }), 42, { allowedBundleIds: [999] }))
      .rejects.toMatchObject({ status: 404, message: 'repository snapshot not found' });
  });

  it('respects directed inbound, outbound, and bidirectional traversal', async () => {
    const outbound = await loadRepositoryGraphNeighborhood(source(), 42, query({
      seed: 'symbol:11', direction: 'outbound', depth: '1', limit: '20',
    }), { allowedBundleIds: [7] });
    expect(outbound.nodes.map(node => node.id)).toEqual(['symbol:11', 'symbol:12']);
    expect(outbound.edges.map(edge => edge.id)).toEqual(['edge:1']);

    const inbound = await loadRepositoryGraphNeighborhood(source(), 42, query({
      seed: 'symbol:11', direction: 'inbound', depth: '1', limit: '20',
    }), { allowedBundleIds: [7] });
    expect(inbound.nodes.map(node => node.id)).toEqual(['symbol:11', 'file:1', 'symbol:12']);
    expect(inbound.edges.map(edge => edge.id)).toEqual(['declares:1:11', 'edge:2']);

    const both = await loadRepositoryGraphNeighborhood(source(), 42, query({
      seed: 'symbol:11', direction: 'both', depth: '1', limit: '20',
    }), { allowedBundleIds: [7] });
    expect(both.nodes.map(node => node.id)).toEqual(['symbol:11', 'file:1', 'symbol:12']);
    expect(both.edges.map(edge => edge.id)).toEqual(['declares:1:11', 'edge:1', 'edge:2']);
  });

  it('deduplicates cycles and self edges while retaining their directed evidence', async () => {
    const result = await loadRepositoryGraphNeighborhood(source(), 42, query({
      seed: 'symbol:11', direction: 'both', depth: '3', limit: '20',
    }), { allowedBundleIds: null });
    expect(new Set(result.nodes.map(node => node.id)).size).toBe(result.nodes.length);
    expect(new Set(result.edges.map(edge => edge.id)).size).toBe(result.edges.length);
    expect(result.edges).toContainEqual(expect.objectContaining({ id: 'edge:3', source: 'symbol:12', target: 'symbol:12' }));
    expect(result.nodes.map(node => node.id)).toContain('symbol:13');
  });

  it('does not reveal missing or unauthorized snapshot metadata', async () => {
    await expect(loadRepositoryGraphNeighborhood(source({ missing: true }), 42, query({ seed: 'symbol:11' }), {
      allowedBundleIds: [999],
    })).rejects.toMatchObject({ status: 404, message: 'repository snapshot not found' });
  });

  it('rejects a missing exact seed and an unknown edge type', async () => {
    await expect(loadRepositoryGraphNeighborhood(source(), 42, query({ seed: 'symbol:999' }), {
      allowedBundleIds: null,
    })).rejects.toMatchObject({ status: 404 });
    await expect(loadRepositoryGraphNeighborhood(source(), 42, query({ seed: 'symbol:11', edge_types: 'owns' }), {
      allowedBundleIds: null,
    })).rejects.toMatchObject({ status: 400, message: 'unknown edge type: owns' });
  });

  it('keeps superseded immutable snapshots readable but rejects incomplete snapshots', async () => {
    const superseded = await loadRepositoryGraphNeighborhood(source({ status: 'superseded' }), 42, query({
      seed: 'symbol:11', depth: '0',
    }), { allowedBundleIds: null });
    expect(superseded.snapshot).toMatchObject({ status: 'superseded', immutable: true });
    await expect(loadRepositoryGraphNeighborhood(source({ status: 'building' }), 42, query({ seed: 'symbol:11' }), {
      allowedBundleIds: null,
    })).rejects.toMatchObject({ status: 409 });
  });

  it('produces a stable query-bound cursor and rejects cursor reuse with other filters', async () => {
    const first = await loadRepositoryGraphNeighborhood(source(), 42, query({
      q: 'a', direction: 'both', depth: '2', limit: '2',
    }), { allowedBundleIds: null });
    expect(first).toMatchObject({ truncated: true, truncationReasons: ['page_limit'] });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await loadRepositoryGraphNeighborhood(source(), 42, query({
      q: 'a', direction: 'both', depth: '2', limit: '2', cursor: first.nextCursor!,
    }), { allowedBundleIds: null });
    expect(second.nodes.map(node => node.id).some(id => first.nodes.some(node => node.id === id))).toBe(false);

    await expect(loadRepositoryGraphNeighborhood(source(), 42, query({
      q: 'a', direction: 'outbound', depth: '2', limit: '2', cursor: first.nextCursor!,
    }), { allowedBundleIds: null })).rejects.toMatchObject({ status: 400 });
  });

  it('never exceeds hard graph bounds even when a data source overproduces', async () => {
    const nodes: RepositoryGraphNode[] = Array.from({ length: 900 }, (_, index) => ({
      id: `symbol:${index + 1}`,
      type: 'symbol',
      label: `symbol-${index + 1}`,
      href: null,
      metadata: {},
    }));
    const excessive: RepositoryGraphDataSource = {
      async loadAuthorizedSnapshot() { return snapshot(); },
      async resolveKnownEdgeTypes(_snapshotId, requested) { return requested.filter(type => type === 'calls'); },
      async resolveSeedNodes() { return [nodes[0]!]; },
      async expand() {
        return {
          nodes,
          edges: nodes.slice(1).map((node, index) => ({
            id: `edge:${index + 1}`, source: 'symbol:1', target: node.id, type: 'calls',
          })),
          truncated: true,
        };
      },
      async loadArchitectureOverview() {
        return { totals: { files: 0, symbols: 0, edges: 0, documents: 0, testFiles: 0, modules: 0, dependencies: 0 }, modules: [], dependencies: [], truncated: false };
      },
      async loadFullGraph() {
        return { files: [], symbols: [], edges: [], truncated: false, truncationReasons: [] };
      },
    };
    const result = await loadRepositoryGraphNeighborhood(excessive, 42, query({
      seed: 'symbol:1', depth: '3', limit: '100',
    }), { allowedBundleIds: null });
    expect(result.appliedLimits.returnedNodes).toBeLessThanOrEqual(100);
    expect(result.appliedLimits.returnedEdges).toBeLessThanOrEqual(800);
    expect(result.truncationReasons).toContain('graph_limit');
  });

  it('validates bounded query inputs before traversal', () => {
    expect(() => query({})).toThrow('provide exactly one of seed or q');
    expect(() => query({ seed: 'symbol:11', q: 'alpha' })).toThrow('provide exactly one of seed or q');
    expect(() => query({ seed: 'symbol:abc' })).toThrow('seed must be an opaque');
    expect(() => query({ seed: 'symbol:11', depth: '4' })).toThrow('depth must be an integer from 0 to 3');
    expect(() => query({ seed: 'symbol:11', node_types: 'package' })).toThrow('unknown node type');
  });
});
