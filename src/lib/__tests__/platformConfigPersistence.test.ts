import { afterEach, describe, expect, it } from '@jest/globals';
import type pg from 'pg';
import {
  getUpstreamTokenExchangeConfig, loadAllPlatformConfigs,
  persistPlatformConfig, setUpstreamTokenExchangeConfig,
} from '../platformConfig.js';

afterEach(() => setUpstreamTokenExchangeConfig({ enabled: false }));

describe('persisted platform configuration loading', () => {
  it.each(['jsonb', 'text'])('restores delegation after an in-memory reset (%s)', async storage => {
    const rows = new Map<string, unknown>();
    const pool = { query: async (sql: string, args: unknown[]) => {
      const key = `${args[0]}:${args[1]}`;
      if (sql.includes('INSERT INTO')) {
        rows.set(key, storage === 'jsonb' ? JSON.parse(args[2] as string) : args[2]);
        return { rows: [] };
      }
      return { rows: rows.has(key) ? [{ value: rows.get(key) }] : [] };
    } } as unknown as pg.Pool;
    for (const enabled of [true, false]) {
      await persistPlatformConfig(pool, 'upstream_token_exchange', { enabled });
      setUpstreamTokenExchangeConfig({ enabled: !enabled });
      await loadAllPlatformConfigs(pool);
      expect(getUpstreamTokenExchangeConfig().enabled).toBe(enabled);
    }
  });

  it.each([undefined, null, '{invalid'])('keeps delegation disabled without valid saved JSON: %p', async value => {
    setUpstreamTokenExchangeConfig({ enabled: false });
    const pool = { query: async () => ({ rows: value === undefined ? [] : [{ value }] }) } as unknown as pg.Pool;
    await loadAllPlatformConfigs(pool);
    expect(getUpstreamTokenExchangeConfig().enabled).toBe(false);
  });
});
