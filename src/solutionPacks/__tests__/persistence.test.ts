import { describe, expect, it } from '@jest/globals';
import { SolutionPackPostgresStore } from '../persistence.js';

describe('persistent Solution Pack installation state', () => {
  it('restores discovery evidence without replacing operator endpoint config', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        return {
          rows: [{
            pack_id: 'argus.dev', endpoint: 'http://old-pack:2025', state: 'ready',
            checked_at: '2026-08-09T12:00:00.000Z', observed_version: '0.4.0',
            observed_manifest: { metadata: { id: 'argus.dev', version: '0.4.0' } },
            health: { ok: true, latencyMs: 3 }, readiness: { ok: true, latencyMs: 4 }, error: null,
          }],
        };
      },
    } as never;
    const store = new SolutionPackPostgresStore(pool);
    const result = await store.load(['argus.dev']);
    expect(result[0]).toMatchObject({ configuredId: 'argus.dev', endpoint: 'http://old-pack:2025', state: 'ready' });
    expect(result[0]?.manifest?.metadata.version).toBe('0.4.0');
    expect(queries[0]?.values).toEqual([['argus.dev']]);
  });

  it('records the latest contract and keeps the previous version as rollback evidence', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        return { rows: [] };
      },
    } as never;
    const store = new SolutionPackPostgresStore(pool);
    await store.save([{
      configuredId: 'argus.dev', endpoint: 'http://argus-dev:2025', state: 'ready',
      checkedAt: '2026-08-09T12:00:00.000Z',
      manifest: { metadata: { id: 'argus.dev', version: '0.5.0' } } as never,
      health: { ok: true, latencyMs: 3 }, readiness: { ok: true, latencyMs: 4 },
    }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain('previous_version');
    expect(queries[0]?.values?.[4]).toBe('0.5.0');
  });

  it('creates a durable rollback request for the external reconciler', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      async query(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        return {
          rows: [{
            id: '8ecf0e84-4a12-4f61-9a1a-5c3cfbf1e820', pack_id: 'argus.dev',
            requested_by: 'Alex', reason: 'reconcile the known-good release', source_revision: 8,
            current_version: '0.5.0', target_version: '0.4.0',
            target_manifest: { metadata: { id: 'argus.dev', version: '0.4.0' } },
            status: 'pending', error: null,
            requested_at: '2026-08-09T12:00:00.000Z', updated_at: '2026-08-09T12:00:00.000Z', applied_at: null,
          }],
        };
      },
    } as never;
    const store = new SolutionPackPostgresStore(pool);
    const result = await store.createRollbackRequest({
      packId: 'argus.dev', requestedBy: 'Alex', reason: 'reconcile the known-good release',
      sourceRevision: 8, currentVersion: '0.5.0', targetVersion: '0.4.0',
      targetManifest: { metadata: { id: 'argus.dev', version: '0.4.0' } } as never,
    });
    expect(result).toMatchObject({ packId: 'argus.dev', status: 'pending', targetVersion: '0.4.0' });
    expect(queries[0]?.sql).toContain('argus_solution_pack_rollback_requests');
    expect(queries[0]?.values?.slice(1, 4)).toEqual(['argus.dev', 'Alex', 'reconcile the known-good release']);
  });

  it('reclaims expired leases and binds completion to the claiming worker', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const row = {
      id: '8ecf0e84-4a12-4f61-9a1a-5c3cfbf1e820', pack_id: 'argus.dev',
      requested_by: 'Alex', reason: 'reconcile the known-good release', source_revision: 8,
      current_version: '0.5.0', target_version: '0.4.0',
      target_manifest: { metadata: { id: 'argus.dev', version: '0.4.0' } },
      status: 'accepted', error: null,
      requested_at: '2026-08-09T12:00:00.000Z', updated_at: '2026-08-09T12:00:00.000Z',
      applied_at: null, claimed_by: 'controller-2', claimed_at: '2026-08-10T12:00:00.000Z',
      claim_expires_at: '2026-08-10T12:10:00.000Z',
    };
    const pool = {
      async query(sql: string, values?: unknown[]) {
        queries.push({ sql, values });
        return { rows: [row] };
      },
    } as never;
    const store = new SolutionPackPostgresStore(pool);
    const claimed = await store.claimRollbackRequest(row.id, 'controller-2', 600);
    expect(claimed).toMatchObject({ claimedBy: 'controller-2', claimExpiresAt: row.claim_expires_at });
    expect(queries[0]?.sql).toContain('claim_expires_at < NOW()');
    expect(queries[0]?.values).toEqual([row.id, 'controller-2', 600]);

    const completed = await store.completeRollbackRequest(row.id, 'controller-2', 'applied', null);
    expect(completed?.status).toBe('accepted');
    expect(queries[1]?.sql).toContain("claimed_by = $4");
    expect(queries[1]?.values).toEqual([row.id, 'applied', null, 'controller-2']);
  });
});
