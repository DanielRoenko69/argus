import { describe, it, expect, jest } from '@jest/globals';
// The pgvector KB accepts provider-neutral dimensions (migration 152). Each
// corpus is expected to keep one configured embedding dimension consistently.
jest.mock('../../ragClient.js', () => ({ embedText: jest.fn(async () => new Array(3072).fill(0.1)) }));
import { ingestDocument } from '../ingest.js';
import { embedText } from '../../ragClient.js';
import type pg from 'pg';

function mockPool(captured: { sql: string; params: unknown[] }[]) {
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      if (/INSERT INTO mcp_kb_documents/.test(sql)) return { rows: [{ id: 99 }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return { connect: jest.fn(async () => client) } as unknown as pg.Pool;
}

describe('ingestDocument', () => {
  it('inserts a document row + one chunk row per chunk (BEGIN/COMMIT)', async () => {
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool = mockPool(captured);
    const res = await ingestDocument(pool, 7, 'note.md', Buffer.from('a short note'));
    expect(res).toEqual({ id: 99, chunkCount: 1 });
    const sqls = captured.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/BEGIN/);
    expect(sqls).toMatch(/INSERT INTO mcp_kb_documents/);
    expect(sqls).toMatch(/INSERT INTO mcp_kb_chunks/);
    expect(sqls).toMatch(/COMMIT/);
    const docInsert = captured.find((c) => /mcp_kb_documents/.test(c.sql))!;
    expect(docInsert.params[0]).toBe(7);      // rag_index_id
    expect(docInsert.params[1]).toBe('note.md');
  });

  it('persists provider-neutral embedding dimensions', async () => {
    (embedText as jest.Mock).mockResolvedValueOnce([0.1, 0.2] as never);
    const captured: { sql: string; params: unknown[] }[] = [];
    const pool = mockPool(captured);
    const res = await ingestDocument(pool, 7, 'note.md', Buffer.from('text'));
    expect(res).toEqual({ id: 99, chunkCount: 1 });
    const chunkInsert = captured.find((c) => /INSERT INTO mcp_kb_chunks/.test(c.sql));
    expect(chunkInsert?.params[4]).toBe('[0.1,0.2]');
  });
});
