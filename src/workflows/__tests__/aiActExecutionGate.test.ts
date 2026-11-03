import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../compliance/aiSystemRunBinding.js', () => ({
  bindAiSystemProductionRunAudited: jest.fn(),
}));

import { bindAiSystemProductionRunAudited } from '../../compliance/aiSystemRunBinding.js';
import { enforceHumanAiActProductionGate } from '../aiActExecutionGate.js';

const bindingMock = bindAiSystemProductionRunAudited as jest.MockedFunction<typeof bindAiSystemProductionRunAudited>;

describe('interactive workflow AI-system production gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps an OIDC session to a verified human and permits a released revision', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as pg.Pool;
    bindingMock.mockResolvedValueOnce({
      binding: {
        executionAuthorized: true,
        releaseGate: { status: 'passed', blockingReasons: [] },
      },
      bindingId: '40000000-0000-4000-8000-000000000001',
      bindingSha256: 'a'.repeat(64),
      replayed: false,
      auditEvent: { eventId: 'gate-41' },
    } as never);

    const result = await enforceHumanAiActProductionGate(pool, {
      executionId: 41,
      target: { aiSystemId: '10000000-0000-4000-8000-000000000001', aiSystemRevision: 3 },
      user: { id: 17, username: 'oidc:issuer:subject', role: 'developer', allowed_bundles: [] },
      source: 'builder',
      environment: 'production',
    });

    expect(result.authorized).toBe(true);
    expect(bindingMock).toHaveBeenCalledWith(pool, expect.objectContaining({
      workflowExecutionId: 41,
      identity: expect.objectContaining({
        actorType: 'human',
        authenticationMethod: 'sso',
        identityVerified: true,
      }),
      actor: expect.objectContaining({ authMethod: 'oidc', ssoSubject: 'oidc:issuer:subject' }),
    }));
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('aiActProductionGate');
  });

  it('fails closed for a local session and retains the immutable denied binding reference', async () => {
    const updates: string[] = [];
    const pool = {
      query: jest.fn(async (sql: string) => {
        updates.push(sql);
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as pg.Pool;
    bindingMock.mockResolvedValueOnce({
      binding: {
        executionAuthorized: false,
        releaseGate: { status: 'blocked', blockingReasons: ['Human production execution requires SSO.'] },
      },
      bindingId: '40000000-0000-4000-8000-000000000002',
      bindingSha256: 'b'.repeat(64),
      replayed: false,
      auditEvent: { eventId: 'gate-42' },
    } as never);

    const result = await enforceHumanAiActProductionGate(pool, {
      executionId: 42,
      target: { aiSystemId: '10000000-0000-4000-8000-000000000001', aiSystemRevision: 3 },
      user: { id: 18, username: 'local-alex', role: 'admin', allowed_bundles: null },
      source: 'builder-retry',
      environment: 'production',
    });

    expect(result).toEqual(expect.objectContaining({
      authorized: false,
      bindingId: '40000000-0000-4000-8000-000000000002',
      bindingSha256: 'b'.repeat(64),
    }));
    expect(bindingMock).toHaveBeenCalledWith(pool, expect.objectContaining({
      identity: expect.objectContaining({ authenticationMethod: 'local', identityVerified: false }),
      producerEventId: 'workflow-builder-retry-production-gate:42',
    }));
    expect(updates).toHaveLength(2);
    expect(updates[1]).toContain("status='failed'");
  });

  it('fails closed before side effects when the workflow binding is incomplete', async () => {
    const pool = {
      query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
    } as unknown as pg.Pool;

    const result = await enforceHumanAiActProductionGate(pool, {
      executionId: 43,
      target: { aiSystemId: null, aiSystemRevision: null },
      user: { id: 17, username: 'oidc:subject', role: 'developer', allowed_bundles: [] },
      source: 'builder',
    });

    expect(result.authorized).toBe(false);
    expect(bindingMock).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
