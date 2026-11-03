import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { hashApiKey } from '../apiKeyRbac.js';
import { rotateManagedApiKey } from '../apiKeyManagement.js';

describe('rotateManagedApiKey', () => {
  it('atomically replaces prefix, hash and suffix without retaining the old credential', async () => {
    const fullKey = 'ak_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const query = jest.fn(async (_sql: string, params: unknown[]) => ({
      rows: [{
        id: 7,
        label: 'deployment bot',
        key_prefix: params[1],
        key_suffix: params[3],
        previous_key_prefix: 'ak_old12',
      }],
      rowCount: 1,
    }));
    const pool = { query } as unknown as pg.Pool;

    const result = await rotateManagedApiKey(pool, 7, () => fullKey);

    expect(result).toEqual({
      id: 7,
      label: 'deployment bot',
      key_prefix: fullKey.slice(0, 8),
      key_suffix: fullKey.slice(-4),
      previous_key_prefix: 'ak_old12',
      api_key: fullKey,
    });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('previous_key_hash = NULL');
    expect(sql).toContain('tenant_key = $5');
    expect(sql).toContain('workspace_key = $6');
    expect(params).toEqual([
      7, fullKey.slice(0, 8), hashApiKey(fullKey), fullKey.slice(-4), 'default', 'default',
    ]);
  });

  it('returns null when the key no longer exists', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as pg.Pool;
    await expect(rotateManagedApiKey(pool, 99, () => 'ak_missing')).resolves.toBeNull();
  });
});
