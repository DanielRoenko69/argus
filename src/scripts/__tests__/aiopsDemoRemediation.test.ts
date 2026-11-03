import { aiopsDemoRemediationFromEnvironment, withBoundDemoRemediation } from '../aiopsDemoRemediation.js';
import type { IncidentAiopsTaskRecord } from '../../observability/incidentAiopsTasks.js';

const record = (): IncidentAiopsTaskRecord => ({
  id: 1, incidentId: 2, packId: 'argus.aiops', agentId: 'incident-orchestrator', taskId: 'task-1',
  rootTraceId: null, state: 'TASK_STATE_COMPLETED', quality: 'reviewed',
  summary: 'A rollout regression was confirmed.',
  executionContext: {
    bundleIds: [28],
    resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
    service: 'checkout-api', environment: 'demo', capturedAt: '2026-08-13T18:00:00.000Z',
    serviceProfile: null, trigger: null,
  },
  result: {
    schemaVersion: 1, sourceSchemaVersion: 1, generatedAt: null, quality: 'reviewed',
    conclusion: 'confirmed', executiveAssessment: 'A rollout regression was confirmed.',
    rootCause: null, hypotheses: [], evidence: [], recommendedActions: [],
  },
  createdBy: 1, createdAt: '2026-08-13T18:00:00.000Z', updatedAt: '2026-08-13T18:00:00.000Z',
});

describe('AIOps demo remediation binding', () => {
  it('requires a bounded retained revision for the deployment regression demo', () => {
    expect(() => aiopsDemoRemediationFromEnvironment({
      ARGUS_AIOPS_DEMO_REMEDIATION: 'deployment-revision', ARGUS_AIOPS_TARGET_REVISION: '0',
    })).toThrow(/retained positive Deployment revision/);
    expect(aiopsDemoRemediationFromEnvironment({
      ARGUS_AIOPS_DEMO_REMEDIATION: 'deployment-revision', ARGUS_AIOPS_TARGET_REVISION: '17',
    })).toEqual({ adapter: 'deployment-revision', targetRevision: 17 });
  });

  it('adds exactly one fingerprint-bound revision proposal without changing reviewer evidence', () => {
    const investigation = record();
    const bound = withBoundDemoRemediation(investigation, { adapter: 'deployment-revision', targetRevision: 17 });
    expect(bound.result?.recommendedActions).toEqual([expect.objectContaining({
      priority: 'now', requiresApproval: true,
      executionIntent: {
        adapterKey: 'kubernetes.deployment-revision-rollback.v1', workloadKind: 'Deployment',
        workloadName: 'checkout-api', targetRevision: 17,
      },
    })]);
    expect(bound.result?.executiveAssessment).toBe(investigation.result?.executiveAssessment);
    expect(withBoundDemoRemediation(bound, { adapter: 'deployment-revision', targetRevision: 17 })).toEqual(bound);
  });
});
