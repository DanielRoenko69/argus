import { describe, it, expect, jest } from '@jest/globals';
import { buildRagContext } from '../agentRunner.js';

function mockPool(captured: { sql: string; params: unknown[] }[]) {
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      return { rows: [] }; // no indexes → search loop skipped, returns ''
    }),
  } as unknown as import('pg').Pool;
}

describe('buildRagContext — ragIndexIds filtering (Item 3)', () => {
  it('adds an id filter to the junction query when ragIndexIds is provided', async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool = mockPool(captured);
    const out = await buildRagContext(pool, 42, 'why did pods crash?', [7, 9]);
    expect(out).toBe('');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain('ar.rag_index_id = ANY(');
    expect(captured[0]!.params).toEqual([42, [7, 9]]);
  });

  it('keeps the no-ids query byte-equivalent (only agent_id param)', async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool = mockPool(captured);
    const out = await buildRagContext(pool, 42, 'why did pods crash?');
    expect(out).toBe('');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).not.toContain('ar.rag_index_id = ANY(');
    expect(captured[0]!.params).toEqual([42]);
  });

  it('treats an empty id array as "no filter" (all bound indexes)', async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool = mockPool(captured);
    await buildRagContext(pool, 42, 'q', []);
    expect(captured[0]!.sql).not.toContain('ar.rag_index_id = ANY(');
    expect(captured[0]!.params).toEqual([42]);
  });
});
