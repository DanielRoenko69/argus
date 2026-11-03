import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import {
  transitionWorkflowApprovalAudited,
  WorkflowApprovalTransitionError,
} from '../workflowApprovalLifecycle.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

const context = {
  producerEventId: 'workflow-42-approval-1',
  environment: 'test',
  actor: {
    type: 'human' as const,
    id: '7',
    ssoSubject: 'oidc:issuer:reviewer',
    authMethod: 'oidc',
    effectiveRoles: ['agent_operator'],
  },
  requestId: 'request-42',
  tenantKey: 'tenant-a',
  workspaceKey: 'engineering',
};

beforeEach(() => { jest.clearAllMocks(); });

describe('canonical workflow lifecycle approvals', () => {
  it('atomically approves and emits bounded four-eyes evidence', async () => {
    const queries: string[] = [];
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        queries.push(sql);
        if (/FROM mcp_workflows[\s\S]*FOR UPDATE/i.test(sql)) {
          return Promise.resolve({ rows: [{
            id: 42, name: 'Release flow', lifecycle_status: 'review', human_oversight_required: true,
          }], rowCount: 1 });
        }
        if (/FROM mcp_workflow_approvals[\s\S]*action='submitted'/i.test(sql)) {
          return Promise.resolve({ rows: [{ actor_username: 'author' }], rowCount: 1 });
        }
        if (/MAX\(version\)/i.test(sql)) {
          return Promise.resolve({ rows: [{ version: 9 }], rowCount: 1 });
        }
        if (/UPDATE mcp_workflows/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 1 });
        if (/INSERT INTO mcp_workflow_approvals/i.test(sql)) {
          return Promise.resolve({ rows: [{ id: 301 }], rowCount: 1 });
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
        event: {
          ...emitted,
          eventId: 'event-301',
          producer,
          policy: emitted['policy'],
          resource: emitted['resource'],
          approvalId: '301',
          payloadSummary: emitted['payload'],
        } as never,
        replayed: false,
        result,
      };
    });

    const result = await transitionWorkflowApprovalAudited(
      pool,
      42,
      'approved',
      { username: 'reviewer', role: 'agent_operator' },
      'Looks good; promote it.',
      false,
      context,
    );

    expect(result).toMatchObject({ replayed: false, action: 'approved', status: 'production' });
    expect(queries.some(sql => /FOR UPDATE/i.test(sql))).toBe(true);
    expect(queries.some(sql => /INSERT INTO mcp_workflow_approvals/i.test(sql))).toBe(true);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO mcp_workflow_approvals/),
      [42, 9, 'approved', 'reviewer', 'agent_operator', 'Looks good; promote it.', 'tenant-a', 'engineering'],
    );
    expect(emitted).toMatchObject({
      action: 'approval.workflow.approved',
      outcome: 'success',
      risk: 'high',
      resource: { type: 'workflow', id: '42', revision: '9' },
      policy: { id: 'argus.workflow-lifecycle', version: 'v1', decision: 'production' },
      approvalId: '301',
      tenantKey: 'tenant-a',
      workspaceKey: 'engineering',
      payload: {
        before: { lifecycleStatus: 'review' },
        after: { lifecycleStatus: 'production' },
        context: {
          submitterIdDigest: createHash('sha256').update('author').digest('hex'),
          commentPresent: true,
          commentDigest: createHash('sha256').update('Looks good; promote it.').digest('hex'),
          fourEyesOverrideApplied: false,
          freeFormText: 'excluded',
        },
      },
    });
    expect(JSON.stringify(emitted)).not.toContain('Looks good; promote it.');
    expect(JSON.stringify(emitted)).not.toContain('author');
  });

  it('checks four-eyes under the workflow row lock', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockImplementation((sql: string) => {
        if (/FROM mcp_workflows[\s\S]*FOR UPDATE/i.test(sql)) {
          return Promise.resolve({ rows: [{
            id: 42, name: 'Release flow', lifecycle_status: 'review', human_oversight_required: false,
          }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [{ actor_username: 'reviewer' }], rowCount: 1 });
      }),
    };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate) => {
      await mutate(client as unknown as pg.PoolClient);
      throw new Error('unreachable');
    });

    await expect(transitionWorkflowApprovalAudited(
      pool, 42, 'approved', { username: 'reviewer', role: 'agent_operator' }, null, false, context,
    )).rejects.toEqual(new WorkflowApprovalTransitionError(
      '4-eyes: cannot approve your own submission (admin override possible)',
      403,
      'WORKFLOW_APPROVAL_FORBIDDEN',
    ));
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('replays without applying the lifecycle mutation twice', async () => {
    const query = jest.fn<TestQuery>().mockResolvedValue({
      rows: [{
        name: 'Release flow', human_oversight_required: true,
        workflow_version: 9, actor_username: 'reviewer',
      }],
      rowCount: 1,
    });
    const pool = { query } as unknown as pg.Pool;
    executeMock.mockResolvedValueOnce({
      event: {
        eventId: 'event-301',
        action: 'approval.workflow.submitted',
        resource: { type: 'workflow', id: '42', revision: '9' },
        approvalId: '301',
        policy: { id: 'argus.workflow-lifecycle', version: 'v1', decision: 'review' },
        payloadSummary: { before: { lifecycleStatus: 'draft' } },
      } as never,
      replayed: true,
      result: null,
    });

    const result = await transitionWorkflowApprovalAudited(
      pool, 42, 'submitted', { username: 'reviewer', role: 'developer' }, null, false, context,
    );

    expect(result).toMatchObject({ replayed: true, action: 'submitted', status: 'review' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toMatch(/SELECT w\.name/);
  });

  it('rejects replay when an idempotency key belongs to another action', async () => {
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockResolvedValueOnce({
      event: {
        eventId: 'event-301',
        action: 'approval.workflow.withdrawn',
        resource: { type: 'workflow', id: '42', revision: '9' },
        approvalId: '301',
        policy: { id: 'argus.workflow-lifecycle', version: 'v1', decision: 'draft' },
        payloadSummary: { before: { lifecycleStatus: 'review' } },
      } as never,
      replayed: true,
      result: null,
    });

    await expect(transitionWorkflowApprovalAudited(
      pool, 42, 'rejected', { username: 'reviewer', role: 'agent_operator' }, null, false, context,
    )).rejects.toThrow('Canonical workflow approval event does not match the requested action');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
