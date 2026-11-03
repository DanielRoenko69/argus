import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { ExecutionGrantClaims } from '../executionGrant.js';
import {
  RuntimeMcpLeaseError,
  RuntimeMcpLeaseStore,
} from '../runtimeMcpLeases.js';

const claims: ExecutionGrantClaims = {
  v: 1,
  jti: '9d9e7f3b-4745-405a-83ec-91f3988f9ae4',
  iss: 'argus.core',
  aud: 'argus.hermes',
  agent: 'hermes-http',
  sub: 'user:7',
  principalKind: 'user',
  principalId: '7',
  bundleIds: [3, 7],
  coreAgentIds: [42],
  coreAgents: [{ id: 42, name: 'coder' }],
  messageId: 'message-42',
  rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
  policy: 'mcp-bundle-v1',
  iat: 1_788_100_000,
  exp: 1_788_100_900,
};

const requestId = 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd';
const runId = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const leaseId = '81d84476-b44e-4bb3-9d10-9f44ec04d4f1';

function row(overrides: Record<string, unknown> = {}) {
  return {
    lease_id: leaseId,
    execution_grant_id: claims.jti,
    pack_id: 'argus.hermes',
    adapter_id: 'hermes-http',
    core_agent_id: 42,
    run_id: runId,
    request_id: requestId,
    root_trace_id: claims.rootTraceId,
    mode: 'managed',
    status: 'pending',
    issued_at: new Date('2026-08-30T14:00:00.000Z'),
    activated_at: null,
    expires_at: new Date('2026-08-30T14:15:00.000Z'),
    revoked_at: null,
    terminal_at: null,
    ...overrides,
  };
}

function poolWith(responses: Array<{ rows: unknown[] }>) {
  const query = jest.fn(async () => responses.shift() ?? { rows: [] });
  return { query } as unknown as Pick<pg.Pool, 'query'> & { query: jest.Mock };
}

describe('RuntimeMcpLeaseStore', () => {
  it('creates a pending lease that contains only a grant JTI and is bounded by the grant expiry', async () => {
    const pool = poolWith([{ rows: [] }, { rows: [row()] }]);
    const store = new RuntimeMcpLeaseStore(pool, () => new Date('2026-08-30T14:00:00.000Z'));

    const lease = await store.createPending({
      claims,
      packId: 'argus.hermes',
      adapterId: 'hermes-http',
      coreAgentId: 42,
      runId,
      requestId,
    });

    expect(lease).toMatchObject({
      leaseId,
      executionGrantId: claims.jti,
      packId: 'argus.hermes',
      adapterId: 'hermes-http',
      coreAgentId: 42,
      runId,
      rootTraceId: claims.rootTraceId,
      mode: 'managed',
      status: 'pending',
      expiresAt: '2026-08-30T14:15:00.000Z',
    });
    const insertArgs = pool.query.mock.calls[1]?.[1] as unknown[];
    expect(insertArgs).toContain(claims.jti);
    expect(JSON.stringify(insertArgs)).not.toContain('eg_v1.');
  });

  it('is idempotent for the same request binding but rejects replay under a different run', async () => {
    const pool = poolWith([{ rows: [row()] }]);
    const store = new RuntimeMcpLeaseStore(pool);
    await expect(store.createPending({
      claims, packId: 'argus.hermes', adapterId: 'hermes-http', coreAgentId: 42, runId, requestId,
    })).resolves.toMatchObject({ leaseId, requestId });
    expect(pool.query).toHaveBeenCalledTimes(1);

    const conflictPool = poolWith([{ rows: [row()] }]);
    const conflictStore = new RuntimeMcpLeaseStore(conflictPool);
    await expect(conflictStore.createPending({
      claims, packId: 'argus.hermes', adapterId: 'hermes-http', coreAgentId: 42,
      runId: 'e8cd58bf-8731-4fec-8161-e879f8718762', requestId,
    })).rejects.toMatchObject({ code: 'runtime_lease_request_conflict' });
  });

  it('exposes only non-secret metadata for an existing idempotency binding', async () => {
    const pool = poolWith([{ rows: [row()] }]);
    const store = new RuntimeMcpLeaseStore(pool);

    await expect(store.getByRequest('argus.hermes', 'hermes-http', requestId)).resolves.toMatchObject({
      leaseId,
      executionGrantId: claims.jti,
      rootTraceId: claims.rootTraceId,
      status: 'pending',
    });
    expect(JSON.stringify(pool.query.mock.calls)).not.toContain('eg_v1.');
    await expect(store.getByRequest('argus.hermes', 'hermes-http', 'not-a-uuid')).rejects.toMatchObject({
      code: 'invalid_runtime_lease',
    });
  });

  it('resolves lifecycle state by the opaque managed run ID only', async () => {
    const pool = poolWith([{ rows: [row({ status: 'active', agent_name: undefined })] }]);
    const store = new RuntimeMcpLeaseStore(pool);
    await expect(store.getByRun(runId)).resolves.toMatchObject({
      leaseId,
      runId,
      rootTraceId: claims.rootTraceId,
      status: 'active',
    });
    await expect(store.getByRun('not-a-uuid')).rejects.toMatchObject({ code: 'invalid_runtime_lease' });
    expect(JSON.stringify(pool.query.mock.calls)).not.toContain('eg_v1.');
  });

  it('binds browser lifecycle reads and recent-run history to the authenticated principal', async () => {
    const pool = poolWith([
      { rows: [row({ status: 'active' })] },
      { rows: [row({ status: 'completed', terminal_at: new Date('2026-08-30T14:03:00.000Z') })] },
    ]);
    const store = new RuntimeMcpLeaseStore(pool);

    const principal = { kind: 'user' as const, id: '7', tenantKey: 'acme', workspaceKey: 'payments' };
    await expect(store.getByRun(runId, principal)).resolves.toMatchObject({ runId, status: 'active' });
    await expect(store.listByPrincipal(principal, 'argus.hermes', 'hermes-http', 10))
      .resolves.toEqual([expect.objectContaining({ runId, status: 'completed' })]);

    expect(pool.query.mock.calls[0]?.[1]).toEqual([runId, 'user', '7', 'acme', 'payments']);
    expect(pool.query.mock.calls[1]?.[1]).toEqual(['argus.hermes', 'hermes-http', 'user', '7', 'acme', 'payments', 10]);
    const sql = pool.query.mock.calls.map(call => String(call[0])).join('\n');
    expect(sql).toContain('execution_grant.principal_kind');
    expect(sql).toContain('execution_grant.principal_id');
    expect(sql).toContain('execution_grant.tenant_key');
    expect(sql).toContain('execution_grant.workspace_key');
    expect(sql).not.toMatch(/\bJOIN argus_execution_grants grant\b/);
  });

  it('makes activation, revocation and terminal state reconciliation idempotent', async () => {
    const active = row({ status: 'active', activated_at: new Date('2026-08-30T14:01:00.000Z') });
    const revoking = row({ status: 'revoking' });
    const revoked = row({ status: 'revoked', revoked_at: new Date('2026-08-30T14:02:00.000Z'), terminal_at: new Date('2026-08-30T14:02:00.000Z') });
    const completed = row({ status: 'completed', terminal_at: new Date('2026-08-30T14:03:00.000Z') });
    const failed = row({ status: 'failed', terminal_at: new Date('2026-08-30T14:04:00.000Z') });
    const pool = poolWith([
      { rows: [active] },
      { rows: [revoking] },
      { rows: [revoked] },
      { rows: [completed] },
      { rows: [failed] },
    ]);
    const store = new RuntimeMcpLeaseStore(pool);

    await expect(store.activate(leaseId)).resolves.toMatchObject({ status: 'active' });
    await expect(store.beginRevocation(leaseId)).resolves.toMatchObject({ status: 'revoking' });
    await expect(store.revoke(leaseId)).resolves.toMatchObject({ status: 'revoked' });
    await expect(store.complete(leaseId)).resolves.toMatchObject({ status: 'completed' });
    await expect(store.fail(leaseId)).resolves.toMatchObject({ status: 'failed' });

    const sql = pool.query.mock.calls.map(call => String(call[0])).join('\n');
    expect(sql).toContain("status IN ('pending', 'active')");
    expect(sql).toContain("status IN ('pending', 'active', 'revoking', 'revoked')");
    expect(sql).toContain("status IN ('pending', 'active', 'revoking', $2)");
  });

  it('fails closed when the execution grant does not cover the selected Pack or Core agent', async () => {
    const store = new RuntimeMcpLeaseStore(poolWith([]));
    await expect(store.createPending({
      claims, packId: 'argus.dev', adapterId: 'hermes-http', coreAgentId: 42, requestId,
    })).rejects.toBeInstanceOf(RuntimeMcpLeaseError);
    await expect(store.createPending({
      claims, packId: 'argus.hermes', adapterId: 'hermes-http', coreAgentId: 99, requestId,
    })).rejects.toMatchObject({ code: 'runtime_lease_scope_mismatch' });
  });

  it('returns an active binding only when the lease, grant, trace and Core agent all agree', async () => {
    const pool = poolWith([{ rows: [row({ status: 'active', agent_name: 'coder' })] }]);
    const store = new RuntimeMcpLeaseStore(pool);
    await expect(store.getActiveBinding(leaseId, claims)).resolves.toMatchObject({
      agentName: 'coder',
      lease: { leaseId, status: 'active', rootTraceId: claims.rootTraceId },
    });

    const denied = new RuntimeMcpLeaseStore(poolWith([{ rows: [] }]));
    await expect(denied.getActiveBinding(leaseId, claims)).rejects.toMatchObject({
      code: 'runtime_lease_scope_mismatch',
    });
  });
});
