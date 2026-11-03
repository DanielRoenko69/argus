import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type {
  FabricProfileDrift,
  FabricProfileDriftPersistenceResult,
  FabricProfileRecord,
} from '../fabricProfiles.js';
import { runFabricProfileDriftCycle } from '../fabricProfileDriftWorker.js';

function profile(): FabricProfileRecord {
  const manifestDigest = 'a'.repeat(64);
  return {
    id: 12,
    name: 'platform-team',
    label: 'Platform team',
    description: '',
    manifestVersion: '1.0.0',
    revision: 2,
    manifest: {
      apiVersion: 'fabric.argus.dev/v1alpha1',
      kind: 'FabricProfile',
      metadata: { name: 'platform-team', label: 'Platform team', description: '', version: '1.0.0' },
      spec: { connectors: [], bundles: [], access: null },
    },
    manifestDigest,
    source: 'imported',
    installedBundleIds: [3],
    appliedMappings: {},
    createdBy: 'admin',
    updatedBy: 'admin',
    lastAppliedAt: '2026-09-13T10:00:00.000Z',
    drift: null,
    createdAt: '2026-09-13T09:00:00.000Z',
    updatedAt: '2026-09-13T10:00:00.000Z',
  };
}

function drift(): FabricProfileDrift {
  return {
    status: 'drifted',
    checkedAt: '2026-09-13T11:00:00.000Z',
    profileId: 12,
    profileRevision: 2,
    manifestDigest: 'a'.repeat(64),
    counts: { total: 1, critical: 1, warning: 0 },
    findings: [{
      code: 'tool_policy_changed',
      severity: 'critical',
      resourceType: 'connector',
      resource: 'platform-team:github',
      message: 'Tool policy for github changed',
      expected: { mode: 'selected' },
      actual: { mode: 'all' },
    }],
  };
}

function persistence(): FabricProfileDriftPersistenceResult {
  const observation = drift();
  return {
    transitioned: true,
    previousStatus: 'in_sync',
    previousFindingDigest: 'b'.repeat(64),
    snapshot: {
      ...observation,
      findings: observation.findings.map(({ expected: _expected, actual: _actual, ...finding }) => finding),
      findingDigest: 'c'.repeat(64),
      source: 'scheduled',
      transitionSequence: 2,
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastErrorAt: null,
      changedAt: observation.checkedAt,
      notifiedAt: null,
    },
  };
}

describe('MCP Fabric profile drift worker', () => {
  it('checks applied profiles and notifies only for a persisted drift transition', async () => {
    const lockQuery = jest.fn(async (sql: string) => ({
      rows: sql.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [{ unlocked: true }],
    }));
    const poolQuery = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 1 }));
    const pool = {
      connect: jest.fn(async () => ({ query: lockQuery, release: jest.fn() })),
      query: poolQuery,
    } as unknown as pg.Pool;
    const notify = jest.fn(async (
      _title: string,
      _message: string,
      _severity: 'info' | 'warning' | 'critical',
    ) => undefined);
    const persistTransition = jest.fn(async () => persistence());

    const result = await runFabricProfileDriftCycle(pool, { environment: 'test' }, {
      listProfiles: async () => [profile()],
      detect: async () => drift(),
      persistTransition,
      notify,
      now: () => new Date('2026-09-13T11:00:00.000Z'),
    });

    expect(result).toEqual(expect.objectContaining({
      considered: 1, checked: 1, drifted: 1, transitions: 1, notifications: 1, failures: 0, skipped: false,
    }));
    expect(persistTransition).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('drift detected'),
      expect.stringContaining('tool_policy_changed'),
      'critical',
    );
    expect(poolQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET notified_at=now()'),
      [12, 2],
    );
  });

  it('persists an initial failed-check state and retries its threshold notification', async () => {
    const lockQuery = jest.fn(async (sql: string) => ({
      rows: sql.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [{ unlocked: true }],
    }));
    const poolQuery = jest.fn(async (sql: string, _params?: unknown[]) => ({
      rows: sql.includes('INSERT INTO mcp_fabric_profile_drift_state')
        ? [{ consecutive_failures: 3, last_error_notified_at: null }]
        : [],
      rowCount: 1,
    }));
    const pool = {
      connect: jest.fn(async () => ({ query: lockQuery, release: jest.fn() })),
      query: poolQuery,
    } as unknown as pg.Pool;
    const notify = jest.fn(async (
      _title: string,
      _message: string,
      _severity: 'info' | 'warning' | 'critical',
    ) => undefined);

    const result = await runFabricProfileDriftCycle(pool, { environment: 'test' }, {
      listProfiles: async () => [profile()],
      detect: async () => { throw new Error('temporary database failure'); },
      notify,
    });

    expect(result).toEqual(expect.objectContaining({
      considered: 1, checked: 0, failures: 1, notifications: 1,
    }));
    expect(poolQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mcp_fabric_profile_drift_state'),
      [12, 2, 'a'.repeat(64), expect.stringMatching(/^[a-f0-9]{64}$/)],
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('monitoring delayed'),
      expect.stringContaining('3 consecutive checks'),
      'warning',
    );
    expect(poolQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET last_error_notified_at=now()'),
      [12, 3],
    );
  });

  it('skips cleanly when another replica owns the advisory lock', async () => {
    const release = jest.fn();
    const pool = {
      connect: jest.fn(async () => ({
        query: jest.fn(async (sql: string) => ({
          rows: sql.includes('pg_try_advisory_lock') ? [{ acquired: false }] : [{ unlocked: false }],
        })),
        release,
      })),
    } as unknown as pg.Pool;
    const listProfiles = jest.fn(async () => [profile()]);

    const result = await runFabricProfileDriftCycle(pool, {}, { listProfiles });

    expect(result.skipped).toBe(true);
    expect(listProfiles).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
