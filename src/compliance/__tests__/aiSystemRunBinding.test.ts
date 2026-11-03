import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../audit/canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
}));

import { executeCanonicalAuditedMutation } from '../../audit/canonicalAuditStore.js';
import { aiActSystemRevisionSchema } from '../aiActContracts.js';
import {
  bindAiSystemProductionRunAudited,
  evaluateAiSystemProductionGate,
} from '../aiSystemRunBinding.js';

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
type TestQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

const revisionFixture = aiActSystemRevisionSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/ai-act-compliance/ai-system-revision.v1.fixture.json',
), 'utf8')));

const releasedRevision = aiActSystemRevisionSchema.parse({
  ...revisionFixture,
  lifecycleState: 'released',
  releasedAt: '2026-09-09T08:30:00.000Z',
});

const scope = { workspaceKey: 'default', tenantKey: 'default', environment: 'production' };
const verifiedServiceIdentity = {
  actorType: 'service' as const,
  subjectId: 'workload:argus-core:workflow-trigger',
  role: 'workflow_trigger',
  authenticationMethod: 'workload_identity' as const,
  identityVerified: true,
  mfaStepUpAt: null,
};

function poolForRevision(revision = releasedRevision): pg.Pool {
  return {
    query: jest.fn<TestQuery>().mockResolvedValue({ rows: [{ revision_json: revision }], rowCount: 1 }),
  } as unknown as pg.Pool;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('AI-system production root-run binding', () => {
  it('authorizes an exact released revision for a verified workload identity', async () => {
    const binding = await evaluateAiSystemProductionGate(poolForRevision(), {
      scope,
      environment: 'production',
      workflowExecutionId: 42,
      aiSystemId: releasedRevision.aiSystemId,
      aiSystemRevision: releasedRevision.revision,
      identity: verifiedServiceIdentity,
      now: () => new Date('2026-09-10T09:00:00.000Z'),
    });

    expect(binding).toMatchObject({
      rootRunId: 'workflow:42',
      production: true,
      executionAuthorized: true,
      effectiveIdentity: { authenticationMethod: 'workload_identity', identityVerified: true },
      releaseGate: { status: 'passed', blockingReasons: [] },
    });
    expect(binding.componentBindings).toEqual(releasedRevision.componentBindings);
  });

  it('fails closed for an unreleased revision and unverified service identity', async () => {
    const binding = await evaluateAiSystemProductionGate(poolForRevision(revisionFixture), {
      scope,
      environment: 'production',
      workflowExecutionId: 43,
      aiSystemId: revisionFixture.aiSystemId,
      aiSystemRevision: revisionFixture.revision,
      identity: { ...verifiedServiceIdentity, authenticationMethod: 'api_key', identityVerified: false },
      now: () => new Date('2026-09-10T09:00:00.000Z'),
    });

    expect(binding.executionAuthorized).toBe(false);
    expect(binding.releaseGate.status).toBe('blocked');
    expect(binding.releaseGate.blockingReasons).toEqual(expect.arrayContaining([
      "AI system revision is 'ready_for_independent_review', not released.",
      'AI system revision has no effective release timestamp.',
      'The effective production identity is not verified.',
      'Automated production execution requires workload identity.',
    ]));
  });

  it('persists the immutable binding and canonical authorization event atomically', async () => {
    const pool = poolForRevision();
    const client = { query: jest.fn<TestQuery>().mockResolvedValue({ rows: [], rowCount: 1 }) };
    let event: Record<string, unknown> | undefined;
    executeMock.mockImplementationOnce(async (_pool, _producer, _scope, mutate, eventFor) => {
      const result = await mutate(client as unknown as pg.PoolClient);
      event = eventFor(result) as unknown as Record<string, unknown>;
      return { event: { eventId: 'gate-event-42' } as never, replayed: false, result };
    });

    const outcome = await bindAiSystemProductionRunAudited(pool, {
      scope,
      environment: 'production',
      workflowExecutionId: 42,
      aiSystemId: releasedRevision.aiSystemId,
      aiSystemRevision: releasedRevision.revision,
      identity: verifiedServiceIdentity,
      actor: {
        type: 'service',
        id: verifiedServiceIdentity.subjectId,
        authMethod: 'workload_identity',
        effectiveRoles: [verifiedServiceIdentity.role],
      },
      producerEventId: 'workflow-production-gate-42',
      now: () => new Date('2026-09-10T09:00:00.000Z'),
      uuid: () => '40000000-0000-4000-8000-000000000001',
    });

    expect(outcome.binding.executionAuthorized).toBe(true);
    expect(outcome.bindingSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mcp_ai_system_run_bindings'),
      expect.arrayContaining([42, releasedRevision.aiSystemId, releasedRevision.revision]),
    );
    expect(event).toMatchObject({
      action: 'compliance.ai_system.production_run_authorized',
      outcome: 'success',
      risk: 'critical',
      resource: { type: 'workflow_execution', id: '42' },
      policy: { id: 'argus.ai-act.production-release-gate', version: '1', decision: 'passed' },
    });
  });
});
