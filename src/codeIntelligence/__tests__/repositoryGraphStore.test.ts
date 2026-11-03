import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { PostgresRepositoryGraphDataSource } from '../repositoryGraphStore.js';

describe('Postgres repository graph authorization boundary', () => {
  it('filters snapshot identity in the same query by the caller bundle scope', async () => {
    const query = jest.fn(async (_config: unknown) => ({ rows: [] }));
    const source = new PostgresRepositoryGraphDataSource({ query } as unknown as pg.Pool);
    await expect(source.loadAuthorizedSnapshot(42, [3, 7])).resolves.toBeNull();
    const call = query.mock.calls[0]![0] as { text: string; values: unknown[] };
    expect(call.text).toContain('scope.bundle_id=ANY($2::int[])');
    expect(call.values).toEqual([42, [3, 7]]);
  });

  it('allows an explicitly unrestricted administrator without inventing bundle ids', async () => {
    const query = jest.fn(async (_config: unknown) => ({ rows: [{
      id: 42, repository_key: 'org/repo', branch_name: 'main', commit_sha: 'a'.repeat(40),
      source_graph_digest: 'b'.repeat(64), provider: 'graphify', parser_version: null,
      graph_schema_version: 'argus-graphify-v3', status: 'ready',
    }] }));
    const source = new PostgresRepositoryGraphDataSource({ query } as unknown as pg.Pool);
    await expect(source.loadAuthorizedSnapshot(42, null)).resolves.toMatchObject({
      id: '42', graphDigest: `sha256:${'b'.repeat(64)}`, immutable: true,
    });
    expect((query.mock.calls[0]![0] as { values: unknown[] }).values).toEqual([42, null]);
  });

  it('validates only requested provider edge types with a bounded SQL result', async () => {
    const query = jest.fn(async (_config: unknown) => ({ rows: [{ relation: 'calls' }] }));
    const source = new PostgresRepositoryGraphDataSource({ query } as unknown as pg.Pool);
    await expect(source.resolveKnownEdgeTypes(42, ['declares', 'calls', 'owns']))
      .resolves.toEqual(['declares', 'calls']);
    const call = query.mock.calls[0]![0] as { text: string; values: unknown[] };
    expect(call.text).toContain('lower(relation)=ANY($2::text[])');
    expect(call.values).toEqual([42, ['calls', 'owns']]);
  });

  it('uses the reserved wildcard only for a bounded initial graph overview', async () => {
    const query = jest.fn(async (_config: unknown) => ({ rows: [{
      node_type: 'file', id: 1, label: 'server.ts', file_path: 'src/server.ts', language: 'typescript',
      qualified_name: null, kind: null, start_line: null, end_line: null,
    }] }));
    const source = new PostgresRepositoryGraphDataSource({ query } as unknown as pg.Pool);
    await expect(source.resolveSeedNodes(42, { seed: null, search: '*', nodeTypes: ['file', 'symbol'] }))
      .resolves.toEqual([expect.objectContaining({ id: 'file:1', label: 'server.ts' })]);
    const call = query.mock.calls[0]![0] as { text: string; values: unknown[] };
    expect(call.text).toContain('$5::boolean');
    expect(call.text).toContain('LIMIT $4');
    expect(call.values).toEqual([42, '*', ['file', 'symbol'], 10, true]);
  });

  it('aggregates modules, language mix and cross-module dependencies within hard limits', async () => {
    const query = jest.fn(async (_config: unknown): Promise<{ rows: any[] }> => ({ rows: [] }))
      .mockResolvedValueOnce({ rows: [{
        module_path: 'src', file_count: '8', symbol_count: '48', document_count: '55', test_file_count: '2',
        total_module_count: '2', total_file_count: '10', total_symbol_count: '50', total_edge_count: '80',
        total_document_count: '60', total_test_file_count: '2',
      }, {
        module_path: 'docs', file_count: '2', symbol_count: '2', document_count: '5', test_file_count: '0',
        total_module_count: '2', total_file_count: '10', total_symbol_count: '50', total_edge_count: '80',
        total_document_count: '60', total_test_file_count: '2',
      }] })
      .mockResolvedValueOnce({ rows: [
        { module_path: 'src', language: 'typescript', file_count: '8' },
        { module_path: 'docs', language: 'markdown', file_count: '2' },
      ] })
      .mockResolvedValueOnce({ rows: [{
        source_module: 'src', target_module: 'docs', relation_count: '3', relations: ['references'], total_dependency_count: '1',
      }] });
    const source = new PostgresRepositoryGraphDataSource({ query } as unknown as pg.Pool);

    await expect(source.loadArchitectureOverview(42)).resolves.toMatchObject({
      totals: { files: 10, symbols: 50, edges: 80, documents: 60, testFiles: 2, modules: 2, dependencies: 1 },
      modules: [
        { id: 'module:c3Jj', path: 'src', languages: { typescript: 8 } },
        { id: 'module:ZG9jcw', path: 'docs', languages: { markdown: 2 } },
      ],
      dependencies: [{ source: 'module:c3Jj', target: 'module:ZG9jcw', relationCount: 3, relations: ['references'] }],
      truncated: false,
    });
    const calls = query.mock.calls.map(call => call[0] as { text: string; values: unknown[] });
    expect(calls[0]?.values).toEqual([42, 41]);
    expect(calls[1]?.values).toEqual([42, ['src', 'docs'], 8]);
    expect(calls[2]?.values).toEqual([42, ['src', 'docs'], 121]);
  });

  it('loads a compact full graph with implicit declaration capacity and stable indexes', async () => {
    const query = jest.fn(async (_config: unknown): Promise<{ rows: any[] }> => ({ rows: [] }))
      .mockResolvedValueOnce({ rows: [
        { id: '10', path: 'src/server.ts', language: 'typescript' },
        { id: '11', path: 'README.md', language: 'markdown' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { id: '20', file_id: '10', name: 'startServer', kind: 'function', start_line: '8', end_line: '30' },
        { id: '21', file_id: '10', name: 'stopServer', kind: 'function', start_line: '32', end_line: '40' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { source_symbol_id: '20', target_symbol_id: '21', relation: 'CALLS' },
      ] });
    const source = new PostgresRepositoryGraphDataSource({ query } as unknown as pg.Pool);

    await expect(source.loadFullGraph(42, { maxNodes: 5, maxEdges: 10 })).resolves.toEqual({
      files: [
        { id: '10', path: 'src/server.ts', language: 'typescript', module: 'src' },
        { id: '11', path: 'README.md', language: 'markdown', module: '(root)' },
      ],
      symbols: [
        { id: '20', fileId: '10', label: 'startServer', kind: 'function', startLine: 8, endLine: 30 },
        { id: '21', fileId: '10', label: 'stopServer', kind: 'function', startLine: 32, endLine: 40 },
      ],
      edges: [{ sourceSymbolId: '20', targetSymbolId: '21', type: 'calls' }],
      truncated: false,
      truncationReasons: [],
    });
    const calls = query.mock.calls.map(call => call[0] as { text: string; values: unknown[]; query_timeout: number });
    expect(calls[0]?.values).toEqual([42, 6]);
    expect(calls[1]?.values).toEqual([42, ['10', '11'], 4]);
    expect(calls[2]?.values).toEqual([42, ['10', '11'], 3, 9]);
    expect(calls.every(call => call.query_timeout === 15_000)).toBe(true);
  });
});
