import { describe, it, expect, jest } from '@jest/globals';
import { listKbDocuments, deleteKbDocument } from '../store.js';
import type pg from 'pg';

describe('kb store', () => {
  it('listKbDocuments scopes by rag_index_id', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: 1, name: 'a.md', chunk_count: 3, created_at: 't' }] }));
    const pool = { query } as unknown as pg.Pool;
    const out = await listKbDocuments(pool, 7);
    expect(out).toHaveLength(1);
    expect(query.mock.calls[0]![0]).toMatch(/WHERE rag_index_id=\$1/);
    expect(query.mock.calls[0]![1]).toEqual([7]);
  });

  it('deleteKbDocument scopes by BOTH index and doc id and returns true when a row was deleted', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1 }));
    const pool = { query } as unknown as pg.Pool;
    const ok = await deleteKbDocument(pool, 7, 42);
    expect(ok).toBe(true);
    expect(query.mock.calls[0]![0]).toMatch(/WHERE id=\$1 AND rag_index_id=\$2/);
    expect(query.mock.calls[0]![1]).toEqual([42, 7]);
  });

  it('deleteKbDocument returns false when the doc is not in that index (no row deleted)', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 0 }));
    const pool = { query } as unknown as pg.Pool;
    expect(await deleteKbDocument(pool, 7, 999)).toBe(false);
  });
});
