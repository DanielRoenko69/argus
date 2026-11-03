import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { extractCodeLexicalTerms, extractCodeLookupTerms, extractCodePathTerms, fuseCodeRetrievalCandidates, searchCodeIndex, type CodeRetrievalCandidate } from '../retrieval.js';
import { CodeIndexValidationError } from '../store.js';

const commit = 'a'.repeat(40);

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7, repository_key: 'argus/sample', branch_name: 'main', commit_sha: commit,
    provider: 'graphify', source_graph_digest: 'b'.repeat(64), parser_version: '0.9.32',
    graph_schema_version: 'graphify-node-link-v1', embedding_model: null,
    embedding_dimension: null, status: 'ready', file_count: 2, symbol_count: 3,
    edge_count: 2, document_count: 4, error_message: null, metadata: {},
    created_at: '2026-08-14T10:00:00.000Z', finished_at: '2026-08-14T10:00:01.000Z',
    ...overrides,
  };
}

function row(id: number, path: string, symbolId: number, score: number, relation?: string) {
  return {
    document_id: id, snapshot_id: 7, repository_key: 'argus/sample', branch_name: 'main',
    commit_sha: commit, file_path: path, symbol_id: symbolId, symbol_name: `symbol${symbolId}`,
    qualified_name: `${path}#symbol${symbolId}`, symbol_kind: 'function', start_line: 1,
    end_line: 3, chunk_kind: 'symbol', content: `content ${id}`, channel_score: score,
    graph_relation: relation,
  };
}

function candidate(documentId: number, channel: CodeRetrievalCandidate['channel'], path: string): CodeRetrievalCandidate {
  return {
    documentId, snapshotId: 7, repositoryKey: 'argus/sample', branchName: 'main', commitSha: commit,
    filePath: path, symbolId: documentId, symbolName: `symbol${documentId}`,
    qualifiedName: `${path}#symbol${documentId}`, symbolKind: 'function', startLine: 1, endLine: 2,
    chunkKind: 'symbol', content: `content ${documentId}`, channel, channelScore: 1,
  };
}

describe('native hybrid code retrieval', () => {
  it('fuses repeated evidence across channels above single-channel candidates', () => {
    const result = fuseCodeRetrievalCandidates({
      exact: [candidate(1, 'exact', 'src/a.ts'), candidate(2, 'exact', 'src/b.ts')],
      lexical: [candidate(1, 'lexical', 'src/a.ts'), candidate(3, 'lexical', 'src/c.ts')],
      graph: [{ ...candidate(1, 'graph', 'src/a.ts'), graphRelation: 'inbound:CALLS' }],
    }, 10);

    expect(result[0]).toMatchObject({ documentId: 1, channels: ['exact', 'lexical', 'graph'] });
    expect(result[0]!.scores.fused).toBeGreaterThan(result[1]!.scores.fused);
    expect(result[0]!.graphRelations).toEqual(['inbound:CALLS']);
  });

  it('extracts individual exact paths and symbols from a websearch query', () => {
    expect(extractCodeLookupTerms('"/api/build-info" OR "package.json" OR "src/app.js" OR "createApp"'))
      .toEqual(['/api/build-info', 'package.json', 'src/app.js', 'createapp']);
  });

  it('does not promote ordinary ticket prose into the exact identifier channel', () => {
    expect(extractCodeLookupTerms('custom formatters emit text level labels through multiple streams'))
      .toEqual([]);
    expect(extractCodeLookupTerms('inspect lastLevel in lib/multistream.js and createApp()'))
      .toEqual(['lastlevel', 'lib/multistream.js', 'createapp()']);
  });

  it('extracts bounded filename stems from prose for path-only matching', () => {
    expect(extractCodePathTerms('Fix custom level routing in lib/multistream.js and its regression test'))
      .toEqual(expect.arrayContaining(['custom', 'level', 'routing', 'multistream', 'regression', 'test']));
    expect(extractCodePathTerms('through the stream')).toEqual(['stream']);
    expect(extractCodePathTerms('records routed through multiple streams'))
      .toEqual(expect.arrayContaining(['records', 'record', 'streams', 'stream']));
  });

  it('builds a safe bounded OR vocabulary from ticket prose', () => {
    expect(extractCodeLexicalTerms('When lastLevel is "error", route records through multiple streams.'))
      .toEqual(['lastlevel', 'error', 'route', 'records', 'multiple', 'streams']);
    expect(extractCodeLexicalTerms('the AND with')).toEqual([]);
  });

  it('reserves most top-k positions for distinct relevant files', () => {
    const result = fuseCodeRetrievalCandidates({
      lexical: [
        candidate(1, 'lexical', 'package.json'),
        candidate(2, 'lexical', 'package.json'),
        candidate(3, 'lexical', 'package.json'),
        candidate(4, 'lexical', 'package.json'),
        candidate(5, 'lexical', 'src/app.js'),
        candidate(6, 'lexical', 'test/app.test.js'),
      ],
    }, 4);

    expect(result.map(item => item.documentId)).toEqual([1, 5, 6, 2]);
    expect(new Set(result.slice(0, 3).map(item => item.filePath)).size).toBe(3);
  });

  it('keeps a direct-evidence majority before graph expansion', () => {
    const result = fuseCodeRetrievalCandidates({
      vector: [
        candidate(1, 'vector', 'src/app.ts'),
        candidate(2, 'vector', 'test/app.test.ts'),
        candidate(3, 'vector', 'README.md'),
      ],
      graph: [
        candidate(4, 'graph', 'src/server.ts'),
        candidate(5, 'graph', 'src/config.ts'),
        candidate(1, 'graph', 'src/app.ts'),
      ],
    }, 4);

    expect(result.slice(0, 3).map(item => item.documentId)).toEqual([1, 2, 3]);
    expect(result[3]!.documentId).toBe(4);
  });

  it('reserves the non-direct budget for graph-connected files', () => {
    const result = fuseCodeRetrievalCandidates({
      exact: [
        candidate(1, 'exact', 'src/a.ts'),
        candidate(2, 'exact', 'src/b.ts'),
        candidate(3, 'exact', 'src/c.ts'),
        candidate(4, 'exact', 'src/d.ts'),
        candidate(5, 'exact', 'src/e.ts'),
      ],
      graph: [
        candidate(6, 'graph', 'test/a.test.ts'),
        candidate(7, 'graph', 'src/dependency.ts'),
      ],
    }, 5);

    expect(result.slice(0, 3).map(item => item.documentId)).toEqual([1, 2, 3]);
    expect(result.slice(3).map(item => item.documentId)).toEqual([6, 7]);
  });

  it('scopes exact, lexical and one-hop graph retrieval to one ready snapshot', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT s.*')) return { rows: [snapshotRow()] };
      if (sql.includes('1.0::real')) return { rows: [row(11, 'src/app.ts', 21, 1)] };
      if (sql.includes('ts_rank_cd')) return { rows: [row(11, 'src/app.ts', 21, 0.7)] };
      if (sql.includes('adjacent AS')) return { rows: [row(12, 'src/dependency.ts', 22, 0.9, 'outbound:CALLS')] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    const result = await searchCodeIndex(pool, {
      snapshotId: 7, query: 'createApp', limit: 5, allowedBundleIds: [12],
    });

    expect(result.snapshot.commitSha).toBe(commit);
    expect(result.channelsUsed).toEqual(['exact', 'lexical', 'graph']);
    expect(result.evidence.map(item => item.documentId)).toEqual([11, 12]);
    expect(calls[0]!.params).toEqual([7, [12]]);
    expect(calls[1]!.params[1]).toEqual(['createapp']);
    expect(calls[2]!.params[1]).toEqual(['createapp']);
    expect(calls[2]!.sql).toContain("array_to_string($2::text[], ' | ')");
    expect(calls[1]!.sql).toContain("LIKE '%' || path_term.term || '%'");
    expect(calls.slice(1).every(call => call.params[0] === 7)).toBe(true);
    const graphCall = calls.find(call => call.sql.includes('adjacent AS'))!;
    expect(graphCall.params[1]).toEqual([21]);
    expect(graphCall.sql).toContain('WITH ORDINALITY');
    expect(graphCall.sql).toContain("WHEN 'TESTS' THEN 4.0");
  });

  it('uses vector retrieval only when a dimension-compatible embedding is supplied', async () => {
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT s.*')) return { rows: [snapshotRow({ embedding_model: 'embed', embedding_dimension: 3 })] };
      if (sql.includes('<=>')) return { rows: [row(13, 'src/vector.ts', 23, 0.95)] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    const result = await searchCodeIndex(pool, {
      snapshotId: 7, query: 'semantic intent', embedding: [0.1, 0.2, 0.3], includeGraph: false,
    });
    expect(result.channelsUsed).toEqual(['exact', 'lexical', 'vector']);
    expect(calls.some(sql => sql.includes('<=>'))).toBe(true);
  });

  it('bridges direct file evidence to one root symbol before graph expansion', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT s.*')) return { rows: [snapshotRow()] };
      if (sql.includes('1.0::real')) return { rows: [{ ...row(21, 'test/app.test.ts', 0, 1), symbol_id: null }] };
      if (sql.includes('DISTINCT ON (f.path)')) return { rows: [{ file_path: 'test/app.test.ts', symbol_id: 31 }] };
      if (sql.includes('adjacent AS')) return { rows: [row(22, 'src/app.ts', 32, 0.95, 'outbound:TESTS')] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    const result = await searchCodeIndex(pool, { snapshotId: 7, query: 'app.test.ts', limit: 5 });

    expect(result.evidence.map(item => item.filePath)).toEqual(['test/app.test.ts', 'src/app.ts']);
    const graphCall = calls.find(call => call.sql.includes('adjacent AS'))!;
    expect(graphCall.params[1]).toEqual([31]);
  });

  it('runs a reproducible lexical-only benchmark strategy', async () => {
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT s.*')) return { rows: [snapshotRow()] };
      if (sql.includes('ts_rank_cd')) return { rows: [row(14, 'src/lexical.ts', 24, 0.8)] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    const result = await searchCodeIndex(pool, {
      snapshotId: 7, query: 'health route', strategy: 'lexical', limit: 3,
    });

    expect(result.channelsUsed).toEqual(['lexical']);
    expect(result.evidence.map(item => item.documentId)).toEqual([14]);
    expect(calls.some(sql => sql.includes('1.0::real'))).toBe(false);
    expect(calls.some(sql => sql.includes('adjacent AS'))).toBe(false);
  });

  it('runs a reproducible dense-vector-only benchmark strategy', async () => {
    const calls: string[] = [];
    const query = jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT s.*')) return { rows: [snapshotRow({ embedding_model: 'embed', embedding_dimension: 3 })] };
      if (sql.includes('<=>')) return { rows: [row(15, 'src/vector.ts', 25, 0.9)] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;

    const result = await searchCodeIndex(pool, {
      snapshotId: 7, query: 'semantic behavior', strategy: 'vector',
      embedding: [0.1, 0.2, 0.3], limit: 3,
    });

    expect(result.channelsUsed).toEqual(['vector']);
    expect(result.evidence.map(item => item.documentId)).toEqual([15]);
    expect(calls.some(sql => sql.includes('ts_rank_cd'))).toBe(false);
    expect(calls.some(sql => sql.includes('1.0::real'))).toBe(false);
    expect(calls.some(sql => sql.includes('adjacent AS'))).toBe(false);
  });

  it('rejects a stale/missing snapshot and incompatible embeddings', async () => {
    const missingPool = { query: jest.fn(async () => ({ rows: [] })) } as unknown as pg.Pool;
    await expect(searchCodeIndex(missingPool, { snapshotId: 9, query: 'test' }))
      .rejects.toThrow('ready code index snapshot not found');

    const mismatchPool = {
      query: jest.fn(async () => ({ rows: [snapshotRow({ embedding_model: 'embed', embedding_dimension: 3 })] })),
    } as unknown as pg.Pool;
    await expect(searchCodeIndex(mismatchPool, { snapshotId: 7, query: 'test', embedding: [0.1, 0.2] }))
      .rejects.toBeInstanceOf(CodeIndexValidationError);
  });

  it('validates query bounds before touching PostgreSQL', async () => {
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    await expect(searchCodeIndex(pool, { snapshotId: 7, query: '   ' })).rejects.toThrow('safe characters');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
