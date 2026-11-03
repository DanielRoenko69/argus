import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import {
  configureWorkflowAiSystemBindingAudited,
} from '../aiSystemWorkflowBinding.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

const revisionJson = JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/ai-act-compliance/ai-system-revision.v1.fixture.json',
), 'utf8')) as { aiSystemId: string; revision: number };
const aiSystemId = revisionJson.aiSystemId;
const before = {
  id: 42,
  name: 'governed_coding',
  lifecycle_status: 'draft',
  ai_act_governed: false,
  ai_system_id: null,
  ai_system_revision: null,
};
const after = {
  ...before,
  ai_act_governed: true,
  ai_system_id: aiSystemId,
  ai_system_revision: 3,
};

beforeEach(() => { jest.clearAllMocks(); });

describe('workflow AI-system governance binding', () => {
  it('validates the scoped revision and writes an audited binding before production promotion', async () => {
    const client = {
      query: jest.fn<TestQuery>()
        .mockResolvedValueOnce({ rows: [before], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ revision_json: revisionJson }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [after], rowCount: 1 }),
    };
    let event: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      event = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { eventId: 'binding-event' } as never, replayed: false, result };
    });

    const result = await configureWorkflowAiSystemBindingAudited({} as pg.Pool, {
      scope: { workspaceKey: 'default', tenantKey: 'default', environment: 'governance' },
      actor: { type: 'human', id: '17', authMethod: 'oidc', effectiveRoles: ['operations_admin'] },
      producerEventId: 'workflow-binding-42',
      now: () => new Date('2026-09-09T09:00:00.000Z'),
    }, {
      workflowId: 42,
      governed: true,
      aiSystemId,
      aiSystemRevision: 3,
    });

    expect(result.value).toMatchObject({ workflowId: 42, governed: true, aiSystemId, aiSystemRevision: 3 });
    expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE mcp_workflows'), [
      42, true, aiSystemId, 3,
    ]);
    expect(event).toMatchObject({
      action: 'compliance.ai_system.workflow_bound',
      risk: 'high',
      resource: { type: 'workflow', id: '42' },
    });
  });

  it('refuses to mutate the compliance binding of a production workflow', async () => {
    const client = {
      query: jest.fn<TestQuery>().mockResolvedValue({
        rows: [{ ...before, lifecycle_status: 'production' }],
        rowCount: 1,
      }),
    };
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate) => {
      await mutate(client as unknown as pg.PoolClient);
      throw new Error('unreachable');
    });

    await expect(configureWorkflowAiSystemBindingAudited({} as pg.Pool, {
      scope: { workspaceKey: 'default', tenantKey: 'default', environment: 'governance' },
      actor: { type: 'human', id: '17', authMethod: 'oidc', effectiveRoles: ['operations_admin'] },
      producerEventId: 'workflow-unbinding-42',
    }, {
      workflowId: 42,
      governed: false,
      aiSystemId: null,
      aiSystemRevision: null,
    })).rejects.toMatchObject({ code: 'PRODUCTION_WORKFLOW_BINDING_LOCKED', status: 409 });
  });
});
