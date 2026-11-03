import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  boundNativeCodeEvidence,
  buildNativeWorkspaceCodeContext,
  fetchWorkspaceCodeMetadata,
  fetchWorkspaceSource,
  resolveNativeCodeBundleAccess,
} from '../workspaceIndexer.js';
import type { CodeEvidence } from '../types.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('native workspace code index client', () => {
  it('shares the bounded source budget fairly across every ranked result', () => {
    const evidence = Array.from({ length: 4 }, (_, index): CodeEvidence => ({
      documentId: index + 1,
      snapshotId: 7,
      repositoryKey: 'argus/sample',
      branchName: 'main',
      commitSha: 'a'.repeat(40),
      filePath: `src/file-${index}.ts`,
      symbolId: null,
      symbolName: null,
      qualifiedName: null,
      symbolKind: null,
      startLine: 1,
      endLine: 100,
      chunkKind: 'file',
      content: 'x'.repeat(20_000),
      channels: ['graph'],
      scores: { graph: 1, fused: 1 },
      graphRelations: [],
    }));

    const bounded = boundNativeCodeEvidence(evidence, 12_000);

    expect(bounded.map(item => item.filePath)).toEqual(evidence.map(item => item.filePath));
    expect(bounded.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0))
      .toBeLessThanOrEqual(12_000);
    expect(bounded.every(item => item.truncated)).toBe(true);
  });

  it('requests Git metadata only for an exact workspace root', async () => {
    const fetchMock = jest.fn(async (_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> => new Response(JSON.stringify({
      commit_sha: 'a'.repeat(40), branch_name: 'main', repository_key: 'argus/sample',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const metadata = await fetchWorkspaceCodeMetadata('/workspace/ARGUS-42', 'feature/test');

    expect(metadata.branch_name).toBe('main');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_root: '/workspace/ARGUS-42', branch_hint: 'feature/test',
    });
    expect(init.headers as Record<string, string>).toHaveProperty('X-Workspace-Secret');
  });

  it('rejects shared, nested and traversal workspace roots before HTTP', async () => {
    const fetchMock = jest.fn(async (_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> => new Response());
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(fetchWorkspaceCodeMetadata('/workspace')).rejects.toThrow('exact child');
    await expect(fetchWorkspaceCodeMetadata('/workspace/ticket/nested')).rejects.toThrow('exact child');
    await expect(fetchWorkspaceCodeMetadata('/workspace/../etc')).rejects.toThrow('exact child');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('decodes source bytes and rejects an inconsistent size envelope', async () => {
    let request = 0;
    const fetchMock = jest.fn(async (_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> => {
      request += 1;
      return request === 1
        ? new Response(JSON.stringify({
          content: Buffer.from('export const ok = true;').toString('base64'), encoding: 'base64', size_bytes: 23,
        }), { status: 200 })
        : new Response(JSON.stringify({
          content: Buffer.from('x').toString('base64'), encoding: 'base64', size_bytes: 2,
        }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchWorkspaceSource('/workspace/ARGUS-42', 'src/app.ts'))
      .resolves.toEqual(Buffer.from('export const ok = true;'));
    await expect(fetchWorkspaceSource('/workspace/ARGUS-42', 'src/app.ts'))
      .rejects.toThrow('size does not match');
  });

  it('builds bounded context only when read, index and repository bundles share the grant', async () => {
    const commit = 'a'.repeat(40);
    const fetchMock = jest.fn(async (): Promise<Response> => new Response(JSON.stringify({
      commit_sha: commit, branch_name: 'main', repository_key: 'argus/sample',
    }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM mcp_service_bundles')) return { rows: [
        { id: 11, name: 'argus-code-intelligence-read' },
        { id: 12, name: 'argus-code-intelligence-index' },
        { id: 13, name: 'dev-repository' },
      ] };
      if (sql.includes('FROM mcp_backend_bundles bb') && !sql.includes('UNION ALL')) return { rows: [
        { bundle_id: 13, signal: 'gitea repository git' },
      ] };
      if (sql.includes('UNION ALL')) return { rows: [] };
      if (sql.includes('graph_schema_version=$5')) return { rows: [{
        id: 7, repository_key: 'argus/sample', branch_name: 'main', commit_sha: commit,
        provider: 'graphify', source_graph_digest: 'b'.repeat(64), parser_version: '0.9.32',
        graph_schema_version: 'argus-graphify-v2', embedding_model: null, status: 'ready',
        file_count: 3, symbol_count: 9, edge_count: 8, document_count: 12,
        error_message: null, metadata: {}, created_at: '2026-08-14T10:00:00.000Z',
        finished_at: '2026-08-14T10:00:01.000Z',
      }] };
      if (sql.includes('SELECT id FROM mcp_code_index_snapshots')) return { rows: [{ id: 7 }] };
      if (sql.includes('INSERT INTO mcp_code_index_snapshot_bundles')) return { rows: [] };
      if (sql.includes('SELECT s.*')) return { rows: [{
        id: 7, repository_key: 'argus/sample', branch_name: 'main', commit_sha: commit,
        provider: 'graphify', source_graph_digest: 'b'.repeat(64), parser_version: '0.9.32',
        graph_schema_version: 'argus-graphify-v2', embedding_model: null, embedding_dimension: null,
        status: 'ready', file_count: 3, symbol_count: 9, edge_count: 8, document_count: 12,
        error_message: null, metadata: {}, created_at: '2026-08-14T10:00:00.000Z',
        finished_at: '2026-08-14T10:00:01.000Z',
      }] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    const context = await buildNativeWorkspaceCodeContext(pool, {
      workspaceRoot: '/workspace/ARGUS-42', executionBundleIds: [11, 12, 13], query: 'createApp',
    });

    expect(context.snapshot).toMatchObject({ id: 7, repositoryKey: 'argus/sample', commitSha: commit });
    expect(context.channelsUsed).toEqual(['exact', 'lexical']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps Read and Index authorization independent', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM mcp_service_bundles')) return { rows: [
        { id: 11, name: 'argus-code-intelligence-read' },
        { id: 13, name: 'dev-repository' },
      ] };
      if (sql.includes('FROM mcp_backend_bundles bb') && !sql.includes('UNION ALL')) return { rows: [
        { bundle_id: 13, signal: 'github repository git' },
      ] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    await expect(resolveNativeCodeBundleAccess(pool, [11, 13])).resolves.toEqual({
      canRead: true,
      canIndex: false,
      repositoryBundleIds: [13],
    });
  });

  it('reuses an exact ready snapshot with Read and repository bundles only', async () => {
    const commit = 'c'.repeat(40);
    const fetchMock = jest.fn(async (input: URL | RequestInfo): Promise<Response> => {
      expect(String(input)).toContain('/code-index/metadata');
      return new Response(JSON.stringify({
        commit_sha: commit, branch_name: 'main', repository_key: 'argus/sample',
      }), { status: 200 });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const snapshotRow = {
      id: 17, repository_key: 'argus/sample', branch_name: 'main', commit_sha: commit,
      provider: 'graphify', source_graph_digest: 'd'.repeat(64), parser_version: '0.9.32',
      graph_schema_version: 'argus-graphify-v3', embedding_model: null, embedding_dimension: null,
      status: 'ready', file_count: 3, symbol_count: 9, edge_count: 8, document_count: 12,
      error_message: null, metadata: {}, created_at: '2026-08-14T10:00:00.000Z',
      finished_at: '2026-08-14T10:00:01.000Z',
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM mcp_service_bundles')) return { rows: [
        { id: 11, name: 'argus-code-intelligence-read' },
        { id: 13, name: 'dev-repository' },
      ] };
      if (sql.includes('FROM mcp_backend_bundles bb') && !sql.includes('UNION ALL')) return { rows: [
        { bundle_id: 13, signal: 'github repository git' },
      ] };
      if (sql.includes('UNION ALL')) return { rows: [] };
      if (sql.includes('graph_schema_version=$5')) return { rows: [snapshotRow] };
      if (sql.includes('SELECT EXISTS') && sql.includes('mcp_code_index_snapshot_bundles')) {
        return { rows: [{ authorized: true }] };
      }
      if (sql.includes('SELECT s.*')) return { rows: [snapshotRow] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    const context = await buildNativeWorkspaceCodeContext(pool, {
      workspaceRoot: '/workspace/ARGUS-42', executionBundleIds: [11, 13], query: 'createApp',
    });

    expect(context.snapshot).toMatchObject({ id: 17, repositoryKey: 'argus/sample', commitSha: commit });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO mcp_code_index_snapshot_bundles')))
      .toBe(false);
  });

  it('reports a normal unavailable state when Read-only has no exact snapshot', async () => {
    const fetchMock = jest.fn(async (): Promise<Response> => new Response(JSON.stringify({
      commit_sha: 'e'.repeat(40), branch_name: 'main', repository_key: 'argus/sample',
    }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM mcp_service_bundles')) return { rows: [
        { id: 11, name: 'argus-code-intelligence-read' },
        { id: 13, name: 'dev-repository' },
      ] };
      if (sql.includes('FROM mcp_backend_bundles bb') && !sql.includes('UNION ALL')) return { rows: [
        { bundle_id: 13, signal: 'github repository git' },
      ] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    await expect(buildNativeWorkspaceCodeContext(pool, {
      workspaceRoot: '/workspace/ARGUS-42', executionBundleIds: [11, 13], query: 'createApp',
    })).rejects.toThrow('an Index-authorized run must create it first');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not leak an exact snapshot into an unrelated repository Bundle', async () => {
    const commit = 'f'.repeat(40);
    global.fetch = jest.fn(async (): Promise<Response> => new Response(JSON.stringify({
      commit_sha: commit, branch_name: 'main', repository_key: 'argus/sample',
    }), { status: 200 })) as unknown as typeof fetch;
    const snapshotRow = {
      id: 23, repository_key: 'argus/sample', branch_name: 'main', commit_sha: commit,
      provider: 'graphify', source_graph_digest: 'a'.repeat(64), parser_version: null,
      graph_schema_version: 'argus-graphify-v3', embedding_model: null, status: 'ready',
      file_count: 1, symbol_count: 1, edge_count: 0, document_count: 1,
      error_message: null, metadata: {}, created_at: '2026-08-14T10:00:00.000Z',
      finished_at: '2026-08-14T10:00:01.000Z',
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM mcp_service_bundles')) return { rows: [
        { id: 11, name: 'argus-code-intelligence-read' },
        { id: 13, name: 'different-repository' },
      ] };
      if (sql.includes('FROM mcp_backend_bundles bb') && !sql.includes('UNION ALL')) return { rows: [
        { bundle_id: 13, signal: 'github repository git' },
      ] };
      if (sql.includes('graph_schema_version=$5')) return { rows: [snapshotRow] };
      if (sql.includes('SELECT EXISTS') && sql.includes('mcp_code_index_snapshot_bundles')) {
        return { rows: [{ authorized: false }] };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    await expect(buildNativeWorkspaceCodeContext(pool, {
      workspaceRoot: '/workspace/ARGUS-42', executionBundleIds: [11, 13], query: 'createApp',
    })).rejects.toThrow('authorized for the selected repository Bundle');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('mcp_code_search_documents'))).toBe(false);
  });

  it('rejects direct runtime context when the read bundle is absent', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM mcp_service_bundles')) return { rows: [
        { id: 12, name: 'argus-code-intelligence-index' },
        { id: 13, name: 'dev-repository' },
      ] };
      if (sql.includes('FROM mcp_backend_bundles bb') && !sql.includes('UNION ALL')) return { rows: [
        { bundle_id: 13, signal: 'gitea repository git' },
      ] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(buildNativeWorkspaceCodeContext(pool, {
      workspaceRoot: '/workspace/ARGUS-42', executionBundleIds: [12, 13], query: 'createApp',
    })).rejects.toThrow('argus-code-intelligence-read');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid source budget before touching bundles or the workspace', async () => {
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(buildNativeWorkspaceCodeContext(pool, {
      workspaceRoot: '/workspace/ARGUS-42',
      executionBundleIds: [11, 12, 13],
      query: 'createApp',
      maxBytes: 24_001,
    })).rejects.toThrow('maxBytes must be an integer from 1024 to 24000');
    expect(pool.query).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
