import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { runCanonicalAuditIntegrityCycle } from '../integrityMonitor.js';

describe('canonical audit integrity monitor', () => {
  it('reports unsigned scopes and overdue durable-outbox delivery', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM mcp_canonical_audit_chain_heads')) return { rows: [{
        workspace_key: 'default', tenant_key: 'default', environment: 'production', last_sequence: '7',
      }] };
      if (sql.includes('JOIN mcp_canonical_audit_signing_keys')) return { rows: [] };
      if (sql.includes('FROM mcp_canonical_audit_outbox')) return { rows: [{ pending: '3', oldest_age_seconds: '901.25' }] };
      return { rows: [] };
    });
    const result = await runCanonicalAuditIntegrityCycle(
      { query } as unknown as pg.Pool,
      { now: () => new Date('2026-09-08T12:00:00.000Z'), outboxLagAlertSec: 300 },
    );
    expect(result).toEqual({
      checkedAt: '2026-09-08T12:00:00.000Z',
      scopes: [{
        scope: { workspaceKey: 'default', tenantKey: 'default', environment: 'production' },
        state: 'unsigned', headSequence: 7, checkpointSequence: null,
        checkpointId: null, reason: 'checkpoint_missing',
      }],
      outbox: { pending: 3, oldestAgeSeconds: 901.25, lagging: true },
    });
  });

  it('returns a healthy empty report before the first canonical event exists', async () => {
    const query = jest.fn(async (sql: string) => sql.includes('mcp_canonical_audit_outbox')
      ? { rows: [{ pending: '0', oldest_age_seconds: '0' }] }
      : { rows: [] });
    await expect(runCanonicalAuditIntegrityCycle(
      { query } as unknown as pg.Pool,
      { now: () => new Date('2026-09-08T12:00:00.000Z') },
    )).resolves.toMatchObject({ scopes: [], outbox: { pending: 0, oldestAgeSeconds: 0, lagging: false } });
  });
});
