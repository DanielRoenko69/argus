import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import { aiActSystemRevisionSchema } from '../aiActContracts.js';
import { AI_ACT_CONTROL_CATALOG } from '../aiActControlCatalog.js';
import {
  createAiSystemAudited,
  type AiSystemRegistryMutationContext,
  type CreateAiSystemInput,
} from '../aiSystemRegistry.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

const ids = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000004',
  '30000000-0000-4000-8000-000000000005',
];

const input: CreateAiSystemInput = {
  displayName: 'Governed coding assistant',
  intendedPurpose: 'Assist authenticated developers with governed repository work.',
  prohibitedUses: ['Employment ranking'],
  targetUsers: ['Developers'],
  affectedGroups: ['Repository contributors'],
  regions: ['EU/EEA'],
  marketRoles: [{
    role: 'provider',
    organisationId: 'argus-project',
    organisationName: 'Argus Project',
    rationale: 'Publishes the configured system release.',
  }],
  prohibitedPracticeCheck: {
    decision: 'clear',
    articleRefs: ['Article 5'],
    rationale: 'The bounded intended purpose does not include a prohibited practice.',
  },
  classification: {
    classification: 'minimal_or_no_risk',
    articleRefs: ['Article 6'],
    annexRefs: [],
    rationale: 'The bounded coding purpose is not an Annex III decision use case.',
    legalReviewRequired: true,
    nextReviewAt: '2026-12-09T08:00:00.000Z',
  },
  componentBindings: [{
    resourceType: 'agent',
    resourceId: 'developer-agent',
    revision: '12',
    sha256: '1'.repeat(64),
  }],
  dataCategories: ['Source code'],
  controlCatalog: {
    catalogId: AI_ACT_CONTROL_CATALOG.catalogId,
    catalogVersion: AI_ACT_CONTROL_CATALOG.catalogVersion,
    catalogSha256: AI_ACT_CONTROL_CATALOG.catalogSha256,
  },
};

function mutationContext(): AiSystemRegistryMutationContext {
  const queue = [...ids];
  return {
    scope: { workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'governance' },
    actor: { type: 'human', id: '17', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    producerEventId: 'request-ai-system-create-1',
    requestId: 'request-1',
    now: () => new Date('2026-09-09T08:00:00.000Z'),
    uuid: () => queue.shift()!,
  };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('AI-system registry canonical persistence', () => {
  it('creates the stable identity, immutable evidence rows and canonical event atomically', async () => {
    const client = { query: jest.fn<TestQuery>().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    let emitted: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, producer, scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      emitted = eventFor(result) as unknown as Record<string, unknown>;
      return {
        event: {
          resource: emitted['resource'],
        } as never,
        replayed: false,
        result,
      };
    });

    const result = await createAiSystemAudited(pool, mutationContext(), input);

    expect(aiActSystemRevisionSchema.parse(result.value)).toMatchObject({
      revision: 1,
      lifecycleState: 'controls_incomplete',
      classification: { classification: 'minimal_or_no_risk' },
    });
    expect(executeMock).toHaveBeenCalledWith(
      pool,
      { name: 'compliance.ai-system.create', eventId: 'request-ai-system-create-1' },
      { workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'governance' },
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ now: expect.any(Function) }),
    );
    expect(client.query.mock.calls.filter(call => /INSERT INTO mcp_ai_system_assessments/i.test(String(call[0])))).toHaveLength(2);
    expect(client.query.mock.calls.filter(call => /INSERT INTO mcp_ai_system_role_assignments/i.test(String(call[0])))).toHaveLength(1);
    expect(emitted).toMatchObject({
      action: 'compliance.ai_system.created',
      risk: 'high',
      resource: { type: 'ai_system', id: ids[0], revision: '1' },
      policy: { id: 'argus.ai-act.system-registry', version: '1', decision: 'controls_incomplete' },
      payload: { after: { classification: 'minimal_or_no_risk', componentCount: 1 } },
    });
    expect(JSON.stringify(emitted)).not.toContain(input.intendedPurpose);
  });

  it('persists a prohibited system only in the blocked lifecycle state', async () => {
    const client = { query: jest.fn<TestQuery>().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const pool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      const event = eventFor(result);
      return { event: { resource: event.resource } as never, replayed: false, result };
    });

    const result = await createAiSystemAudited(pool, mutationContext(), {
      ...input,
      prohibitedPracticeCheck: { ...input.prohibitedPracticeCheck, decision: 'blocked' },
      classification: { ...input.classification, classification: 'prohibited' },
    });

    expect(result.value.lifecycleState).toBe('blocked');
  });

  it('re-reads the immutable revision on an idempotent canonical replay', async () => {
    const context = mutationContext();
    const firstClient = { query: jest.fn<TestQuery>().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const firstPool = { query: jest.fn<TestQuery>() } as unknown as pg.Pool;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(firstClient as unknown as pg.PoolClient);
      const event = eventFor(result);
      return { event: { resource: event.resource } as never, replayed: false, result };
    });
    const created = await createAiSystemAudited(firstPool, context, input);

    const replayContext = mutationContext();
    const replayPool = {
      query: jest.fn<TestQuery>().mockResolvedValue({ rows: [{ revision_json: created.value }], rowCount: 1 }),
    } as unknown as pg.Pool;
    executeMock.mockResolvedValueOnce({
      event: { resource: { type: 'ai_system', id: created.value.aiSystemId, revision: '1' } } as never,
      replayed: true,
      result: null,
    });

    const replay = await createAiSystemAudited(replayPool, replayContext, input);

    expect(replay.replayed).toBe(true);
    expect(replay.value.revisionSha256).toBe(created.value.revisionSha256);
    expect(replayPool.query).toHaveBeenCalledWith(expect.stringContaining('mcp_ai_system_revisions'), [
      created.value.aiSystemId, 'default', 'tenant-a', 1,
    ]);
  });
});
