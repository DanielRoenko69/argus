import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  CodeIndexConflictError,
  CodeIndexValidationError,
  findLatestReadyCodeIndex,
  listCodeIndexSnapshots,
  normalizeRepositoryPath,
  persistCodeIndexSnapshot,
} from '../store.js';
import type { PersistCodeIndexInput } from '../types.js';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const fileHash = 'c'.repeat(64);

function input(): PersistCodeIndexInput {
  return {
    repositoryKey: 'argus/argus-dev-sample',
    branchName: 'main',
    commitSha: sha,
    bundleIds: [12],
    provider: 'graphify',
    sourceGraphDigest: digest,
    parserVersion: '8.0.0',
    graphSchemaVersion: 'argus-graphify-v2',
    files: [
      { path: 'src/app.ts', language: 'typescript', contentHash: fileHash, byteSize: 42, lineCount: 3 },
    ],
    symbols: [
      { key: 'src/app.ts#createApp', filePath: 'src/app.ts', name: 'createApp', qualifiedName: 'src.app.createApp', kind: 'function', startLine: 1, endLine: 3 },
    ],
    edges: [],
    documents: [
      { filePath: 'src/app.ts', symbolKey: 'src/app.ts#createApp', chunkKind: 'symbol', content: 'export function createApp() {}' },
    ],
  };
}

function readyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    repository_key: 'argus/argus-dev-sample',
    branch_name: 'main',
    commit_sha: sha,
    provider: 'graphify',
    source_graph_digest: digest,
    parser_version: '8.0.0',
    graph_schema_version: '1',
    embedding_model: null,
    status: 'ready',
    file_count: 1,
    symbol_count: 1,
    edge_count: 0,
    document_count: 1,
    error_message: null,
    metadata: {},
    created_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:00:01.000Z',
    ...overrides,
  };
}

describe('native code intelligence store', () => {
  it('normalizes Windows separators but rejects absolute and traversal paths', () => {
    expect(normalizeRepositoryPath('src\\app.ts')).toBe('src/app.ts');
    expect(() => normalizeRepositoryPath('../secret')).toThrow(CodeIndexValidationError);
    expect(() => normalizeRepositoryPath('C:\\repo\\app.ts')).toThrow(CodeIndexValidationError);
  });

  it('persists a complete snapshot in one transaction and materializes lexical documents', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO mcp_code_index_snapshots')) return { rows: [readyRow({ status: 'building', finished_at: null, file_count: 0, symbol_count: 0, document_count: 0 })] };
      if (sql.includes('INSERT INTO mcp_code_index_files')) return { rows: [{ id: 11 }] };
      if (sql.includes('INSERT INTO mcp_code_index_symbols')) return { rows: [{ id: 21 }] };
      if (sql.includes("SET status='ready'")) return { rows: [readyRow()] };
      return { rows: [] };
    });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;

    const result = await persistCodeIndexSnapshot(pool, input());

    expect(result.status).toBe('ready');
    expect(result.commitSha).toBe(sha);
    expect(calls[0]!.sql).toBe('BEGIN');
    const commitIndex = calls.findIndex(call => call.sql === 'COMMIT');
    expect(commitIndex).toBeGreaterThan(0);
    expect(calls.some(call => call.sql.includes('INSERT INTO mcp_code_search_documents'))).toBe(true);
    expect(calls.filter(call => call.sql.startsWith('ANALYZE ')).map(call => call.sql)).toEqual([
      'ANALYZE mcp_code_index_files',
      'ANALYZE mcp_code_index_symbols',
      'ANALYZE mcp_code_index_edges',
      'ANALYZE mcp_code_search_documents',
    ]);
    expect(calls.slice(commitIndex + 1).every(call => call.sql.startsWith('ANALYZE '))).toBe(true);
    expect(calls.some(call => call.sql.includes('mcp_code_index_snapshot_bundles'))).toBe(true);
    const documentCall = calls.find(call => call.sql.includes('INSERT INTO mcp_code_search_documents'))!;
    expect(documentCall.params[1]).toBe(11);
    expect(documentCall.params[2]).toBe(21);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('returns an identical ready snapshot idempotently without inserting children', async () => {
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('INSERT INTO mcp_code_index_snapshots')) return { rows: [] };
      if (sql.includes('FOR SHARE')) return { rows: [readyRow()] };
      return { rows: [] };
    });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;

    const result = await persistCodeIndexSnapshot(pool, input());

    expect(result.id).toBe(7);
    expect(calls.some(sql => sql.includes('mcp_code_index_files'))).toBe(false);
    expect(calls.some(sql => sql.includes('mcp_code_index_snapshot_bundles'))).toBe(true);
    expect(calls.at(-1)).toBe('COMMIT');
  });

  it('rejects a different graph digest for the same immutable identity', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO mcp_code_index_snapshots')) return { rows: [] };
      if (sql.includes('FOR SHARE')) return { rows: [readyRow({ source_graph_digest: 'd'.repeat(64) })] };
      return { rows: [] };
    });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;

    await expect(persistCodeIndexSnapshot(pool, input())).rejects.toBeInstanceOf(CodeIndexConflictError);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('validates graph references before opening a database transaction', async () => {
    const invalid = input();
    invalid.edges.push({ sourceKey: 'missing', targetKey: 'src/app.ts#createApp', relation: 'CALLS' });
    const pool = { connect: jest.fn() } as unknown as pg.Pool;

    await expect(persistCodeIndexSnapshot(pool, invalid)).rejects.toThrow('references an unknown symbol');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('requires one embedding model and dimension per snapshot', async () => {
    const invalid = input();
    invalid.documents[0]!.embedding = [0.1, 0.2];
    invalid.documents.push({
      filePath: 'src/app.ts', symbolKey: 'src/app.ts#createApp', chunkKind: 'context',
      chunkOrdinal: 1, content: 'context', embedding: [0.1, 0.2, 0.3],
    });
    const pool = { connect: jest.fn() } as unknown as pg.Pool;

    await expect(persistCodeIndexSnapshot(pool, invalid)).rejects.toThrow('one dimension');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('finds the newest ready snapshot for an exact repository and branch', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [readyRow()] }));
    const pool = { query } as unknown as pg.Pool;

    const result = await findLatestReadyCodeIndex(pool, 'argus/argus-dev-sample', 'main');

    expect(result?.id).toBe(7);
    expect(query.mock.calls[0]![0]).toMatch(/status='ready'/);
    expect(query.mock.calls[0]![1]).toEqual(['argus/argus-dev-sample', 'main']);
  });

  it('lists bounded admin metadata without returning source documents', async () => {
    const query = jest.fn(async (_sql: string, _params: unknown[] = []) => ({ rows: [{
      ...readyRow(),
      bundle_names: ['argus-dev-demo'],
      languages: { typescript: 1 },
    }] }));
    const pool = { query } as unknown as pg.Pool;

    const result = await listCodeIndexSnapshots(pool, 10);

    expect(result[0]).toMatchObject({
      id: 7,
      repositoryKey: 'argus/argus-dev-sample',
      bundleNames: ['argus-dev-demo'],
      languages: { typescript: 1 },
    });
    expect(query.mock.calls[0]![1]).toEqual([10]);
    expect(JSON.stringify(result)).not.toContain('export function');
  });
});
