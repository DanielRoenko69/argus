import { describe, it, expect, jest } from '@jest/globals';

// ts-jest (CJS mode) — jest.mock() is hoisted automatically
jest.mock('../ragSearch.js', () => ({
  searchRagIndex: jest.fn(async () => [
    { id: 'd1', score: 0.88, content: 'pods OOMKilled due to memory limit', source: 'runbook.md' },
  ]),
}));

import { buildRagContext } from '../agentRunner.js';
import type pg from 'pg';

function poolOneIndex(): pg.Pool {
  return {
    query: jest.fn(async () => ({
      rows: [{ id: 7, label: 'Ops-KB', provider: 'qdrant', endpoint: 'http://x', index_name: 'kb', api_key: null, semantic_config: null, top_k: 5 }],
    })),
  } as unknown as pg.Pool;
}

describe('buildRagContext citationsOut', () => {
  it('fills the out-array from search results with the index label', async () => {
    const citations: { source: string; snippet: string; score: number; index: string }[] = [];
    const out = await buildRagContext(poolOneIndex(), 42, 'why OOM?', undefined, citations);
    expect(out).toContain('rag_context');
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ source: 'runbook.md', index: 'Ops-KB' });
    expect(citations[0]!.snippet).toContain('OOMKilled');
  });

  it('leaves the result + behavior unchanged when the out-array is omitted', async () => {
    const out = await buildRagContext(poolOneIndex(), 42, 'q');
    expect(out).toContain('rag_context');
  });
});
