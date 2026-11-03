import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { loadApiKeyRbac } from '../apiKeyRbac.js';

describe('API-key RBAC lifecycle filtering', () => {
  it('excludes expired and soft-deleted keys from the authentication cache', async () => {
    let cacheQuery = '';
    const query = jest.fn(async (rawSql: unknown) => {
      const sql = String(rawSql).replace(/\s+/g, ' ').trim();
      if (sql.includes('information_schema.tables')) return { rows: [{ exists: true }], rowCount: 1 };
      if (sql.includes('column_name IN')) {
        return {
          rows: [
            { column_name: 'key_hash' },
            { column_name: 'scope' },
            { column_name: 'expires_at' },
            { column_name: 'deleted_at' },
          ],
          rowCount: 4,
        };
      }
      if (sql.includes("column_name = 'acting_as_user_id'")) return { rows: [{ exists: false }], rowCount: 1 };
      cacheQuery = sql;
      return { rows: [], rowCount: 0 };
    });
    const pool = { query } as unknown as pg.Pool;

    await loadApiKeyRbac(pool);

    expect(cacheQuery).toContain('k.enabled = true');
    expect(cacheQuery).toContain('(k.expires_at IS NULL OR k.expires_at > now())');
    expect(cacheQuery).toContain('k.deleted_at IS NULL');
  });
});
