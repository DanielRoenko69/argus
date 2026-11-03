import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { searchCodeIndex } from '../../codeIntelligence/retrieval.js';
import { buildAgentRepositoryKnowledge } from '../codeIndexKnowledge.js';

jest.mock('../../codeIntelligence/retrieval.js', () => ({ searchCodeIndex: jest.fn() }));
jest.mock('../../lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockedSearch = searchCodeIndex as jest.MockedFunction<typeof searchCodeIndex>;

describe('Agent repository knowledge', () => {
  it('retrieves only assigned immutable snapshots through the effective Bundle scope', async () => {
    const query = jest.fn<(sql: unknown, parameters?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>>()
      .mockResolvedValue({ rows: [{
      snapshot_id: 42,
      repository_key: 'argus/platform',
      branch_name: 'main',
      commit_sha: 'a'.repeat(40),
      }] });
    const pool = { query } as unknown as pg.Pool;
    mockedSearch.mockResolvedValue({
      snapshot: {} as never,
      query: 'where is auth configured?',
      channelsUsed: ['lexical'],
      evidence: [{
        documentId: 9, snapshotId: 42, repositoryKey: 'argus/platform', branchName: 'main',
        commitSha: 'a'.repeat(40), filePath: 'src/auth/session.ts', symbolId: 3,
        symbolName: 'requireAuth', qualifiedName: 'session.requireAuth', symbolKind: 'function',
        startLine: 12, endLine: 20, chunkKind: 'symbol', content: 'export function requireAuth() {}',
        channels: ['lexical'], scores: { lexical: 1, fused: 0.9 }, graphRelations: [],
      }],
    });

    const result = await buildAgentRepositoryKnowledge(pool, 7, 'where is auth configured?', [11]);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('mcp_agent_code_index_snapshots'), [7, 3]);
    expect(mockedSearch).toHaveBeenCalledWith(pool, expect.objectContaining({
      snapshotId: 42,
      allowedBundleIds: [11],
      strategy: 'hybrid_graph',
    }));
    expect(result).toMatchObject({ snapshotCount: 1, evidenceCount: 1 });
    expect(result.context).toContain('Graphify · argus/platform · main');
    expect(result.context).toContain('src/auth/session.ts#L12');
  });

  it('fails open when no assignment catalog is available during a rolling migration', async () => {
    const query = jest.fn<(sql: unknown, parameters?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>>()
      .mockRejectedValue(new Error('relation does not exist'));
    const pool = { query } as unknown as pg.Pool;
    await expect(buildAgentRepositoryKnowledge(pool, 7, 'query', [11])).resolves.toEqual({
      context: '', snapshotCount: 0, evidenceCount: 0,
    });
  });
});
