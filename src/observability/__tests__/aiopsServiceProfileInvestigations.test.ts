import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { A2aGateway } from '../../a2a/client.js';
import {
  aiOpsServiceProfileReadinessSchema,
  aiOpsServiceProfileResourceSchema,
  hashAiOpsResolvedServiceContext,
} from '../aiopsServiceProfileContracts.js';
import {
  AiOpsServiceProfileInvestigationError,
  startAiOpsServiceProfileInvestigation,
} from '../aiopsServiceProfileInvestigations.js';
import type { AiOpsServiceProfileRecord } from '../aiopsServiceProfiles.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(
  process.cwd(), 'docs/specs/aiops-service-profiles', name,
), 'utf8'));

function profile(): AiOpsServiceProfileRecord {
  const value = aiOpsServiceProfileResourceSchema.parse(fixture('service-profile-active.v1.fixture.json'));
  return {
    id: value.id,
    status: value.status,
    activeRevision: value.activeRevision,
    latestRevision: value.latestRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

describe('profile-backed AIOps investigation start', () => {
  const pool = {} as pg.Pool;

  it('freezes the active revision and sends only Core-resolved bundles, tools and queries', async () => {
    const active = profile();
    const readiness = aiOpsServiceProfileReadinessSchema.parse(fixture('profile-readiness-partial.v1.fixture.json'));
    const sendMessage = jest.fn<A2aGateway['sendMessage']>().mockResolvedValue({
      rootTraceId: '3d6b6613-61cb-4fb4-9d13-f29d00692ea4',
      agentCard: {} as never,
      task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_WORKING' } },
    });
    const a2a = {
      getAgentCard: jest.fn<A2aGateway['getAgentCard']>().mockResolvedValue({
        capabilities: { aiopsServiceContextVersion: 1 },
      } as never),
      sendMessage,
    } as unknown as A2aGateway;

    const result = await startAiOpsServiceProfileInvestigation(pool, active.id, {
      title: 'Checkout latency',
      summary: 'Latency increased after a deployment.',
      severity: 'critical',
      keyword: 'deadline exceeded',
    }, { kind: 'user', id: '17', allowedBundleIds: [11, 18] }, {
      getProfile: async () => active,
      getRevision: async () => active.latestRevision,
      evaluateReadiness: async (_pool, resolved) => {
        expect(resolved.latestRevision.revision).toBe(active.activeRevision?.revision);
        return readiness;
      },
      a2a,
      now: () => new Date('2026-09-08T14:00:00.000Z'),
    });

    const [packId, agentId, message, execution] = sendMessage.mock.calls[0]!;
    expect([packId, agentId]).toEqual(['argus.aiops', 'incident-orchestrator']);
    expect(message.data?.['input']).toMatchObject({
      service: 'checkout-api',
      environment: 'production',
      signal_keyword: 'deadline exceeded',
    });
    const context = message.data?.['resolvedServiceContext'] as Record<string, unknown>;
    expect(execution).toMatchObject({
      requestedBundleIds: [11, 18],
      requestedToolNames: expect.arrayContaining(['aiops_prometheus_query_range', 'aiops_jaeger_find_traces', 'github_list_commits']),
      aiopsServiceContext: {
        profileId: active.id,
        revision: active.activeRevision?.revision,
        profileSha256: active.activeRevision?.sha256,
        resolvedContextSha256: hashAiOpsResolvedServiceContext(context),
      },
    });
    expect(execution?.requestedToolNames).not.toContain('aiops_loki_query_range');
    expect((context['evidence'] as { lanes: Array<{ lane: string }> }).lanes).not.toContainEqual(
      expect.objectContaining({ lane: 'logs' }),
    );
    expect(result).toMatchObject({
      kind: 'aiops-service-profile-investigation-started',
      task: { id: 'task-1' },
      execution: { bundleIds: [11, 18], service: 'checkout-api', environment: 'production' },
    });
  });

  it('rejects a queued investigation when the active revision changed before dispatch', async () => {
    const active = profile();
    const a2a = { getAgentCard: jest.fn(), sendMessage: jest.fn() } as unknown as A2aGateway;
    await expect(startAiOpsServiceProfileInvestigation(pool, active.id, {
      title: 'Checkout latency', summary: 'Latency increased.',
    }, { kind: 'service', id: 'native-alert-rule:73', allowedBundleIds: [11, 18] }, {
      getProfile: async () => active,
      getRevision: async () => active.latestRevision,
      evaluateReadiness: async () => { throw new Error('must not run'); },
      a2a,
      now: () => new Date(),
    }, { revision: active.activeRevision!.revision - 1, sha256: 'b'.repeat(64) }))
      .rejects.toMatchObject({ status: 409, code: 'profile_context_invalid' });
    expect(a2a.sendMessage).not.toHaveBeenCalled();
  });

  it('blocks inactive or currently unready profiles before contacting the Pack', async () => {
    const inactive = { ...profile(), status: 'paused' as const };
    const a2a = { getAgentCard: jest.fn(), sendMessage: jest.fn() } as unknown as A2aGateway;
    await expect(startAiOpsServiceProfileInvestigation(pool, inactive.id, {
      title: 'Checkout latency', summary: 'Latency increased.',
    }, { kind: 'user', id: '17', allowedBundleIds: null }, {
      getProfile: async () => inactive,
      getRevision: async () => inactive.latestRevision,
      evaluateReadiness: async () => { throw new Error('must not run'); },
      a2a,
      now: () => new Date(),
    })).rejects.toBeInstanceOf(AiOpsServiceProfileInvestigationError);
    expect(a2a.sendMessage).not.toHaveBeenCalled();
  });

  it('returns blocking readiness codes and spends no Pack or model work after connector drift', async () => {
    const active = profile();
    const blocked = aiOpsServiceProfileReadinessSchema.parse({
      ...(fixture('profile-readiness-blocked.v1.fixture.json') as Record<string, unknown>),
      profileId: active.id,
      revision: active.latestRevision.revision,
      profileSha256: active.latestRevision.sha256,
      issues: [{
        code: 'aiops_bundle_operationally_blocked', severity: 'blocking',
        message: 'The configured evidence connection is unavailable', lane: 'metrics', bundleId: 11,
      }],
    });
    const a2a = { getAgentCard: jest.fn(), sendMessage: jest.fn() } as unknown as A2aGateway;

    await expect(startAiOpsServiceProfileInvestigation(pool, active.id, {
      title: 'Checkout latency', summary: 'Latency increased.',
    }, { kind: 'user', id: '17', allowedBundleIds: [11, 18] }, {
      getProfile: async () => active,
      getRevision: async () => active.latestRevision,
      evaluateReadiness: async () => blocked,
      a2a,
      now: () => new Date(),
    })).rejects.toMatchObject({
      status: 409,
      code: 'profile_blocked',
      issueCodes: ['aiops_bundle_operationally_blocked'],
    });
    expect(a2a.getAgentCard).not.toHaveBeenCalled();
    expect(a2a.sendMessage).not.toHaveBeenCalled();
  });
});
