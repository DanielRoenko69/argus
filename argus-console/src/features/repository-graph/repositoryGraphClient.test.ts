import { describe, expect, it, vi } from 'vitest';
import { createRepositoryFullGraphLoader, createRepositoryGraphLoader, createRepositoryGraphOverviewLoader, repositoryFullGraphUrl, repositoryGraphOverviewUrl, repositoryGraphRequestUrl } from './repositoryGraphClient';
import type { RepositoryGraphRequest } from './types';

const request: RepositoryGraphRequest = {
  snapshotId: 'snapshot/42',
  entry: { kind: 'search', value: 'src/agents runner' },
  nodeTypes: ['file', 'symbol'],
  edgeTypes: ['calls', 'declares'],
  direction: 'both',
  depth: 2,
  limit: 100,
  cursor: 'next-page',
};

describe('repositoryGraphClient', () => {
  it('maps the typed request to the bounded v1 query contract', () => {
    const url = repositoryGraphRequestUrl(request);
    expect(url).toContain('/repository-snapshots/snapshot%2F42/graph?');
    const params = new URL(url, 'http://argus.local').searchParams;
    expect(params.get('q')).toBe('src/agents runner');
    expect(params.get('seed')).toBeNull();
    expect(params.get('node_types')).toBe('file,symbol');
    expect(params.get('edge_types')).toBe('calls,declares');
    expect(params.get('direction')).toBe('both');
    expect(params.get('depth')).toBe('2');
    expect(params.get('limit')).toBe('100');
    expect(params.get('cursor')).toBe('next-page');
  });

  it('surfaces a server error without accepting malformed success payloads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'Snapshot is not readable.' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    const loader = createRepositoryGraphLoader(fetcher);
    await expect(loader(request, new AbortController().signal)).rejects.toThrow('Snapshot is not readable.');

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ nodes: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(loader(request, new AbortController().signal)).rejects.toThrow('invalid response');
  });

  it('loads a validated architecture overview from the immutable snapshot endpoint', async () => {
    expect(repositoryGraphOverviewUrl('snapshot/42')).toBe('/api/ui/knowledge/repository-snapshots/snapshot%2F42/overview');
    const payload = {
      schemaVersion: 1,
      snapshot: { id: '42' },
      totals: { modules: 1 },
      modules: [],
      dependencies: [],
      truncated: false,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const loader = createRepositoryGraphOverviewLoader(fetcher);

    await expect(loader('snapshot/42', new AbortController().signal)).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(repositoryGraphOverviewUrl('snapshot/42'), expect.objectContaining({ credentials: 'same-origin' }));

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ modules: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(loader('42', new AbortController().signal)).rejects.toThrow('invalid response');
  });

  it('loads the compact complete graph from one snapshot-bound endpoint', async () => {
    expect(repositoryFullGraphUrl('snapshot/42')).toBe('/api/ui/knowledge/repository-snapshots/snapshot%2F42/full-graph');
    const payload = {
      schemaVersion: 1,
      snapshot: { id: '42' },
      files: [['1', 'src/index.ts', 'typescript', 'src']],
      symbols: [['11', 'start', 'function', 0, 1, 3]],
      relationTypes: ['calls'],
      edges: [[0, 0, 0]],
      truncated: false,
      truncationReasons: [],
      appliedLimits: { returnedNodes: 2, returnedEdges: 2 },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const loader = createRepositoryFullGraphLoader(fetcher);

    await expect(loader('snapshot/42', new AbortController().signal)).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(repositoryFullGraphUrl('snapshot/42'), expect.objectContaining({ credentials: 'same-origin' }));
  });
});
