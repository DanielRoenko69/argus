import { describe, it, expect, jest } from '@jest/globals';
jest.mock('../../ragClient.js', () => ({ embedText: jest.fn(async () => [0.1, 0.2, 0.3]) }));
import { searchPgvectorRag } from '../searchPgvector.js';
import type pg from 'pg';
import type { RagIndex } from '../../types.js';

describe('searchPgvectorRag', () => {
  it('embeds the query + maps rows to RagResult (source = doc name, score = similarity)', async () => {
    const pool = {
      query: jest.fn(async () => ({ rows: [{ id: 5, content: 'OOMKilled chunk', source: 'runbook.md', score: 0.83 }] })),
    } as unknown as pg.Pool;
    const idx = { id: 7, top_k: 4, provider: 'pgvector' } as unknown as RagIndex;
    const out = await searchPgvectorRag(idx, 'why OOM?', pool);
    expect(out).toEqual([{ id: '5', score: 0.83, content: 'OOMKilled chunk', source: 'runbook.md' }]);
    const sql = (pool.query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toMatch(/embedding <=> \$1::halfvec/);
    expect((pool.query as jest.Mock).mock.calls[0][1]).toEqual(['[0.1,0.2,0.3]', 7, 4]);
  });
});
