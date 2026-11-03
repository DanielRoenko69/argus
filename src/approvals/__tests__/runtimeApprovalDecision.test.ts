import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import {
  decideRuntimeApprovalAudited,
  RuntimeApprovalDecisionError,
  type RuntimeApprovalRecord,
} from '../runtimeApprovalStore.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

const record: RuntimeApprovalRecord = {
  id: 71,
  tenant_key: 'tenant-a',
  workspace_key: 'engineering',
  request_key: 'request-key',
  grant_key: 'grant-key',
  subject_type: 'workflow',
  agent_id: null,
  workflow_id: 19,
  session_id: 'builder:88',
  tool_name: 'github_create_issue',
  tool_args: { title: 'private title' },
  tool_args_hash: 'a'.repeat(64),
  risk_level: 'high',
  risk_score: 70,
  risk_factors: [{ id: 'write-action', label: 'Write action', category: 'action', weight: 15, evidence: 'write' }],
  risk_model: 'argus-risk-v1',
  reason: 'free form reason',
  status: 'pending',
  requested_by_user_id: 12,
  requested_at: '2026-09-08T10:00:00.000Z',
  last_seen_at: '2026-09-08T10:00:00.000Z',
  occurrence_count: 1,
  decided_by_user_id: null,
  decided_by_username: null,
  decision_comment: null,
  decided_at: null,
  approval_expires_at: null,
  consumed_at: null,
  consumed_session_id: null,
  workflow_execution_id: 88,
  workflow_step_id: 'notify',
};
const approved: RuntimeApprovalRecord = {
  ...record,
  status: 'approved',
  decided_by_user_id: 17,
  decided_by_username: 'alex',
  decision_comment: 'approved comment',
  decided_at: '2026-09-08T10:01:00.000Z',
  approval_expires_at: '2026-09-08T10:31:00.000Z',
};
const context = {
  producerEventId: 'runtime-approval-71-decision-1',
  environment: 'test',
  actor: {
    type: 'human' as const,
    id: '17',
    ssoSubject: 'oidc:issuer:subject-17',
    authMethod: 'oidc',
    effectiveRoles: ['agent_operator'],
  },
  requestId: 'request-71',
  tenantKey: 'tenant-a',
  workspaceKey: 'engineering',
};

beforeEach(() => { jest.clearAllMocks(); });

describe('canonical runtime approval decisions', () => {
  it('commits the decision with bounded evidence and excludes arguments/comments', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/SELECT \* FROM mcp_runtime_approvals[\s\S]*FOR UPDATE/i.test(sql)) {
          return Promise.resolve({ rows: [record], rowCount: 1 });
        }
        if (/UPDATE mcp_runtime_approvals/i.test(sql)) {
          return Promise.resolve({ rows: [approved], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, producer, scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return {
        event: { ...emitted, eventId: 'event-71', policy: emitted['policy'] } as never,
        replayed: false,
        result,
      };
    });

    const result = await decideRuntimeApprovalAudited(
      pool, 71, 'approve', { id: 17, username: 'alex' }, 'approved comment', false, context,
    );

    expect(result).toMatchObject({ value: approved, replayed: false, decision: 'approved' });
    expect(emitted).toMatchObject({
      action: 'approval.runtime.approved',
      risk: 'high',
      approvalId: '71',
      tenantKey: 'tenant-a',
      workspaceKey: 'engineering',
      resource: { type: 'runtime_approval', id: '71' },
      policy: { id: 'argus.runtime-approval', version: 'argus-risk-v1', decision: 'approved' },
      correlation: { requestId: 'request-71', rootRunId: '88' },
      payload: {
        before: { status: 'pending' },
        after: { status: 'approved', approvalExpiresAt: approved.approval_expires_at },
        context: {
          subjectType: 'workflow', subjectId: 19, toolName: 'github_create_issue',
          toolArgsDigest: 'a'.repeat(64), riskScore: 70,
          riskFactorIds: ['write-action'], requestedByUserId: 12,
          fourEyesOverrideApplied: false, freeFormText: 'excluded',
        },
      },
    });
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain('private title');
    expect(serialized).not.toContain('approved comment');
    expect(serialized).not.toContain('free form reason');
  });

  it('enforces four-eyes inside the transaction', async () => {
    const selfRequested = { ...record, requested_by_user_id: 17 };
    const client = {
      query: jest.fn<TestQuery>().mockResolvedValue({ rows: [selfRequested], rowCount: 1 }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate) => {
      await mutate(client as unknown as pg.PoolClient);
      throw new Error('unreachable');
    });

    await expect(decideRuntimeApprovalAudited(
      pool, 71, 'approve', { id: 17, username: 'alex' }, null, false, context,
    )).rejects.toEqual(new RuntimeApprovalDecisionError(
      'Four-eyes policy forbids approving your own request.', 403, 'RUNTIME_APPROVAL_FORBIDDEN',
    ));
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the decision on canonical replay', async () => {
    const consumed = { ...approved, status: 'consumed' as const };
    const query = jest.fn<TestQuery>().mockResolvedValue({ rows: [consumed], rowCount: 1 });
    const pool = { query } as unknown as pg.Pool;
    executeMock.mockResolvedValueOnce({
      event: {
        eventId: 'event-71', action: 'approval.runtime.approved',
        resource: { type: 'runtime_approval', id: '71', revision: null },
        policy: { id: 'argus.runtime-approval', version: 'argus-risk-v1', decision: 'approved' },
      } as never,
      replayed: true,
      result: null,
    });

    const result = await decideRuntimeApprovalAudited(
      pool, 71, 'approve', { id: 17, username: 'alex' }, null, false, context,
    );

    expect(result).toMatchObject({ value: consumed, replayed: true, decision: 'approved' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects replay when an idempotency key belongs to the opposite decision', async () => {
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockResolvedValueOnce({
      event: {
        eventId: 'event-71', action: 'approval.runtime.rejected',
        resource: { type: 'runtime_approval', id: '71', revision: null },
        policy: { id: 'argus.runtime-approval', version: 'argus-risk-v1', decision: 'rejected' },
      } as never,
      replayed: true,
      result: null,
    });

    await expect(decideRuntimeApprovalAudited(
      pool, 71, 'approve', { id: 17, username: 'alex' }, null, false, context,
    )).rejects.toThrow('Canonical runtime approval event does not match the requested action');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
