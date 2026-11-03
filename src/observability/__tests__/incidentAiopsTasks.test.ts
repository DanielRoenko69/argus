import { jest } from '@jest/globals';
import type pg from 'pg';
import type { A2aTask } from '../../a2a/client.js';
import {
  incidentAiopsResultFromTask,
  incidentAiopsSnapshotFromTask,
  PostgresIncidentAiopsTaskStore,
} from '../incidentAiopsTasks.js';

function completedTask(diagnosis: Record<string, unknown>): A2aTask {
  return {
    id: 'task-81',
    contextId: 'context-81',
    status: { state: 'TASK_STATE_COMPLETED' },
    metadata: { quality: 'reviewed', rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    artifacts: [{
      artifactId: 'reviewed-evidence',
      parts: [{ data: {
        kind: 'aiops-investigation-evidence',
        schemaVersion: 2,
        generatedAt: '2026-08-12T20:30:00.000Z',
        quality: 'reviewed',
        synthesis: 'Legacy synthesis should not replace the structured assessment.',
        diagnosis,
      } }],
    }],
  };
}

describe('incident AIOps result projection', () => {
  it('extracts a bounded machine-readable diagnosis from the latest Pack artifact', () => {
    const task = completedTask({
      conclusion: 'confirmed',
      executiveAssessment: 'PostgreSQL failures explain the checkout latency regression.',
      rootCause: {
        candidateRef: 'argus.core.impact.candidate.1',
        targetKind: 'database',
        targetName: 'postgresql',
        statement: 'The checkout service is failing on its PostgreSQL query path.',
        confidence: 94.4,
        rationale: 'Metrics, traces and dependency evidence agree inside the incident window.',
      },
      hypotheses: [{
        id: 'dependency-degradation', statement: 'The database dependency degraded.', verdict: 'supported', confidence: 94,
        evidenceFor: ['4 of 4 observed calls failed'], evidenceAgainst: [],
      }],
      evidence: [{ lane: 'traces', claim: 'Failures start at the PostgreSQL span.', sourceRefs: ['trace:abc'] }],
      recommendedActions: [{ priority: 'now', action: 'Inspect PostgreSQL availability.', rationale: 'It is on the failing request path.', requiresApproval: false }],
    });

    expect(incidentAiopsResultFromTask(task)).toEqual(expect.objectContaining({
      schemaVersion: 1,
      sourceSchemaVersion: 2,
      quality: 'reviewed',
      conclusion: 'confirmed',
      rootCause: expect.objectContaining({
        candidateRef: 'argus.core.impact.candidate.1',
        targetName: 'postgresql',
        confidence: 94,
      }),
    }));
    expect(incidentAiopsSnapshotFromTask(task)).toMatchObject({
      summary: 'PostgreSQL failures explain the checkout latency regression.',
      result: { conclusion: 'confirmed' },
    });
  });

  it('rejects unknown artifacts and strips untrusted fields and references', () => {
    const task = completedTask({
      conclusion: 'made-up-state',
      executiveAssessment: `Assessment\n${'x'.repeat(3_000)}`,
      rootCause: {
        candidateRef: 'attacker.controlled.candidate', statement: 'A bounded statement.', confidence: 500,
        rationale: 'A rationale.', secret: 'must-not-cross-the-boundary',
      },
      hypotheses: Array.from({ length: 20 }, (_, index) => ({
        id: `hypothesis-${index}`, statement: 'test', verdict: 'unknown', confidence: -4,
      })),
      evidence: [
        { lane: 'raw-logs', claim: 'raw corpus', sourceRefs: [] },
        { lane: 'metrics', claim: 'bounded aggregate', sourceRefs: Array(20).fill('source') },
      ],
      recommendedActions: [{ priority: 'now', action: 'Restart everything.', rationale: 'No.', requiresApproval: true, command: 'rm -rf /' }],
    });

    const result = incidentAiopsResultFromTask(task)!;
    expect(result.conclusion).toBe('inconclusive');
    expect(result.executiveAssessment.length).toBeLessThanOrEqual(2_000);
    expect(result.rootCause).toMatchObject({ candidateRef: null, confidence: 100 });
    expect(result.hypotheses).toHaveLength(6);
    expect(result.evidence).toEqual([expect.objectContaining({ lane: 'metrics', sourceRefs: expect.any(Array) })]);
    expect(result.evidence[0]?.sourceRefs).toHaveLength(4);
    expect(result.recommendedActions[0]).not.toHaveProperty('command');
  });

  it('keeps only a strictly bounded provider-write intent', () => {
    const valid = incidentAiopsResultFromTask(completedTask({
      conclusion: 'suspected', executiveAssessment: 'Capacity is a suspected contributor.',
      recommendedActions: [{
        priority: 'next', action: 'Scale checkout-api.', rationale: 'Saturation is correlated.', requiresApproval: true,
        executionIntent: { adapterKey: 'kubernetes.scale.v1', workloadKind: 'Deployment', workloadName: 'checkout-api', desiredReplicas: 3 },
      }],
    }))!;
    expect(valid.recommendedActions[0]?.executionIntent).toEqual({
      adapterKey: 'kubernetes.scale.v1', workloadKind: 'Deployment', workloadName: 'checkout-api', desiredReplicas: 3,
    });

    const invalid = incidentAiopsResultFromTask(completedTask({
      conclusion: 'suspected', executiveAssessment: 'Capacity is a suspected contributor.',
      recommendedActions: [{
        priority: 'next', action: 'Scale arbitrary workload.', rationale: 'Untrusted.', requiresApproval: true,
        executionIntent: { adapterKey: 'shell.exec', workloadKind: 'Deployment', workloadName: '../system', desiredReplicas: 5_000 },
      }],
    }))!;
    expect(invalid.recommendedActions[0]?.executionIntent).toBeNull();
  });

  it('keeps legacy v1 evidence readable without manufacturing a conclusion', () => {
    const task = completedTask({});
    task.artifacts![0]!.parts[0] = { data: {
      kind: 'aiops-investigation-evidence', schemaVersion: 1, quality: 'reviewed', synthesis: 'Legacy result.',
    } };
    expect(incidentAiopsResultFromTask(task)).toBeNull();
    expect(incidentAiopsSnapshotFromTask(task)).toMatchObject({ summary: 'Legacy result.', result: null });
  });
});

describe('incident AIOps execution context persistence', () => {
  it('captures the execution boundary once and excludes it from conflict updates', async () => {
    const capturedAt = '2026-08-14T10:00:00.000Z';
    const query = jest.fn(async (text: string, params: unknown[]) => ({ rows: [{
      id: 15, incident_id: 81, pack_id: 'argus.aiops', agent_id: 'incident-orchestrator', task_id: 'task-81',
      root_trace_id: null, state: 'TASK_STATE_WORKING', quality: null, summary: null, result_json: null,
      execution_bundle_ids: [28],
      execution_resource_scope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
      execution_service: 'checkout-api', execution_environment: 'demo', execution_context_captured_at: capturedAt,
      service_profile_id: 44, service_profile_revision: 3, service_profile_sha256: 'c'.repeat(64),
      trigger_kind: 'native-alert', trigger_ref: '81',
      created_by: 1, created_at: capturedAt, updated_at: capturedAt,
    }], text, params }));
    const store = new PostgresIncidentAiopsTaskStore({ query } as unknown as pg.Pool);

    const result = await store.create({
      incidentId: 81, packId: 'argus.aiops', agentId: 'incident-orchestrator', taskId: 'task-81', createdBy: 1,
      snapshot: { state: 'TASK_STATE_WORKING' },
      executionContext: {
        bundleIds: [28, 28],
        resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
        service: 'checkout-api', environment: 'demo',
        serviceProfile: { id: 44, revision: 3, sha256: 'c'.repeat(64) },
        trigger: { kind: 'native-alert', ref: '81' },
      },
    });

    const insert = String(query.mock.calls[0]?.[0]);
    const conflictUpdate = insert.split('ON CONFLICT')[1] ?? '';
    expect(conflictUpdate).not.toContain('execution_bundle_ids=');
    expect(conflictUpdate).not.toContain('execution_resource_scope=');
    expect(conflictUpdate).not.toContain('service_profile_id=');
    expect(conflictUpdate).not.toContain('trigger_kind=');
    expect(query.mock.calls[0]?.[1]?.[10]).toEqual([28]);
    expect(result.executionContext).toEqual({
      bundleIds: [28],
      resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
      service: 'checkout-api', environment: 'demo', capturedAt,
      serviceProfile: { id: 44, revision: 3, sha256: 'c'.repeat(64) },
      trigger: { kind: 'native-alert', ref: '81' },
    });
  });
});
