import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPendingMigrations } from '../migrate.js';

/**
 * Mock pool: the migration runner holds one session client for its advisory
 * lock, bookkeeping and migration transactions. A file whose content contains
 * 'FAIL_ME' throws, simulating a broken migration.
 */
function mockPool() {
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes('mcp_user_upstream_tokens')) return { rows: [{ has_late_marker: false }] };
        if (sql.includes('SELECT name FROM mcp_schema_migrations')) return { rows: [] };
        if (sql.includes('FAIL_ME')) throw new Error('syntax error at FAIL_ME');
        return { rows: [] };
      },
      release: () => {},
    }),
  };
  return pool as unknown as import('pg').Pool;
}

function recordingMockPool(options: {
  hasLateMarker?: boolean;
  applied?: string[];
} = {}) {
  const poolQueries: Array<{ sql: string; params: unknown[] }> = [];
  const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
  let releaseCount = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      poolQueries.push({ sql, params });
      return { rows: [] };
    },
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        clientQueries.push({ sql, params });
        if (sql.includes('mcp_user_upstream_tokens')) {
          return { rows: [{ has_late_marker: options.hasLateMarker ?? false }] };
        }
        if (sql.includes('SELECT name FROM mcp_schema_migrations')) {
          return { rows: (options.applied ?? []).map(name => ({ name })) };
        }
        if (sql.includes('FAIL_ME')) throw new Error('syntax error at FAIL_ME');
        return { rows: [] };
      },
      release: () => { releaseCount++; },
    }),
  };
  return {
    pool: pool as unknown as import('pg').Pool,
    poolQueries,
    clientQueries,
    get releaseCount() { return releaseCount; },
  };
}

describe('runPendingMigrations — stop on first failure', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'mig-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('halts after a failed migration and skips the rest (no partial-schema cascade)', async () => {
    await writeFile(path.join(dir, '01_ok.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, '02_bad.sql'), 'FAIL_ME;');
    await writeFile(path.join(dir, '03_after.sql'), 'SELECT 1;');

    const report = await runPendingMigrations(mockPool(), dir);

    expect(report.applied).toEqual(['01_ok.sql']);
    expect(report.failed.map((f) => f.name)).toEqual(['02_bad.sql']);
    // 03 must NOT have been applied — it depends on a now-broken prefix.
    expect(report.applied).not.toContain('03_after.sql');
    expect(report.skipped).toContain('03_after.sql');
  });

  it('applies all migrations when none fail', async () => {
    await writeFile(path.join(dir, '01_a.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, '02_b.sql'), 'SELECT 1;');

    const report = await runPendingMigrations(mockPool(), dir);

    expect(report.applied).toEqual(['01_a.sql', '02_b.sql']);
    expect(report.failed).toEqual([]);
  });

  it('baselines a legacy database only through migration 131 and applies 132+', async () => {
    await writeFile(path.join(dir, '130_legacy.sql'), 'FAIL_ME;');
    await writeFile(path.join(dir, '131_legacy.sql'), 'FAIL_ME;');
    await writeFile(path.join(dir, '132_manifest.sql'), 'SELECT 132;');
    await writeFile(path.join(dir, '133_follow_up.sql'), 'SELECT 133;');
    const mock = recordingMockPool({ hasLateMarker: true });

    const report = await runPendingMigrations(mock.pool, dir);

    expect(report.baseline).toBe(true);
    expect(report.skipped).toEqual(['130_legacy.sql', '131_legacy.sql']);
    expect(report.applied).toEqual(['132_manifest.sql', '133_follow_up.sql']);
    expect(report.failed).toEqual([]);
    expect(mock.clientQueries
      .filter(entry => entry.sql.includes('baseline) VALUES'))
      .map(entry => entry.params[0]))
      .toEqual(['130_legacy.sql', '131_legacy.sql']);
    expect(mock.clientQueries.some(entry => entry.sql.includes('FAIL_ME'))).toBe(false);
  });

  it('keeps the normal incremental path when migration tracking already has entries', async () => {
    await writeFile(path.join(dir, '131_existing.sql'), 'FAIL_ME;');
    await writeFile(path.join(dir, '132_pending.sql'), 'SELECT 132;');
    const mock = recordingMockPool({
      hasLateMarker: true,
      applied: ['131_existing.sql'],
    });

    const report = await runPendingMigrations(mock.pool, dir);

    expect(report.baseline).toBe(false);
    expect(report.skipped).toEqual(['131_existing.sql']);
    expect(report.applied).toEqual(['132_pending.sql']);
    expect(report.failed).toEqual([]);
    expect(mock.clientQueries.some(entry => entry.sql.includes('mcp_user_upstream_tokens'))).toBe(false);
  });

  it('exposes fresh-install context transaction-locally to migrations', async () => {
    await writeFile(path.join(dir, '142_templates.sql'), 'SELECT 142;');
    const mock = recordingMockPool({ hasLateMarker: false });

    await runPendingMigrations(mock.pool, dir);

    const context = mock.clientQueries.find(entry => entry.sql.includes("set_config('argus.fresh_install'"));
    expect(context?.params).toEqual(['true']);
  });

  it('marks incremental migrations as upgrades rather than fresh installs', async () => {
    await writeFile(path.join(dir, '141_existing.sql'), 'SELECT 141;');
    await writeFile(path.join(dir, '142_templates.sql'), 'SELECT 142;');
    const mock = recordingMockPool({ applied: ['141_existing.sql'] });

    await runPendingMigrations(mock.pool, dir);

    const context = mock.clientQueries.find(entry => entry.sql.includes("set_config('argus.fresh_install'"));
    expect(context?.params).toEqual(['false']);
  });

  it('locks before reading applied state and releases the single held client', async () => {
    await writeFile(path.join(dir, '132_pending.sql'), 'SELECT 132;');
    const mock = recordingMockPool();

    await runPendingMigrations(mock.pool, dir);

    const lockIndex = mock.clientQueries.findIndex(entry => entry.sql.includes('pg_advisory_lock('));
    const appliedIndex = mock.clientQueries.findIndex(entry => entry.sql.includes('SELECT name FROM mcp_schema_migrations'));
    const unlockIndex = mock.clientQueries.findIndex(entry => entry.sql.includes('pg_advisory_unlock('));
    expect(lockIndex).toBe(0);
    expect(appliedIndex).toBeGreaterThan(lockIndex);
    expect(unlockIndex).toBeGreaterThan(appliedIndex);
    expect(mock.poolQueries).toEqual([]);
    expect(mock.releaseCount).toBe(1);
  });
});
