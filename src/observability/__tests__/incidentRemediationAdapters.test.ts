import {
  incidentRemediationAdapter,
  KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_REMEDIATION_ADAPTER,
  KUBERNETES_SCALE_REMEDIATION_ADAPTER,
  listIncidentRemediationAdapters,
  normalizeIncidentRemediationExecutionIntent,
} from '../incidentRemediationAdapters.js';

describe('incident remediation adapter registry', () => {
  it('normalizes only the exact bounded Kubernetes scale intent', () => {
    expect(normalizeIncidentRemediationExecutionIntent({
      adapterKey: 'kubernetes.scale.v1', workloadKind: 'Deployment',
      workloadName: 'checkout-api', desiredReplicas: 3,
    })).toEqual({
      adapterKey: 'kubernetes.scale.v1', workloadKind: 'Deployment',
      workloadName: 'checkout-api', desiredReplicas: 3,
    });
    expect(normalizeIncidentRemediationExecutionIntent({
      adapterKey: 'kubernetes.scale.v1', workloadKind: 'Pod',
      workloadName: 'checkout-api', desiredReplicas: 3,
    })).toBeNull();
    expect(normalizeIncidentRemediationExecutionIntent({
      adapterKey: 'kubernetes.restart.v1', workloadKind: 'Deployment',
      workloadName: 'checkout-api', desiredReplicas: 3,
    })).toBeNull();
    expect(normalizeIncidentRemediationExecutionIntent({
      adapterKey: 'kubernetes.scale.v1', workloadKind: 'Deployment',
      workloadName: '../checkout-api', desiredReplicas: 3,
    })).toBeNull();
    expect(normalizeIncidentRemediationExecutionIntent({
      adapterKey: 'kubernetes.scale.v1', workloadKind: 'Deployment',
      workloadName: 'checkout-api', desiredReplicas: 0,
    })).toBeNull();
  });

  it('accepts only the exact provider scale schema', () => {
    const valid = {
      type: 'object',
      required: ['apiVersion', 'kind', 'name'],
      properties: {
        apiVersion: { type: 'string' }, kind: { type: 'string' },
        name: { type: 'string' }, namespace: { type: 'string' }, scale: { type: 'integer' },
      },
    };
    expect(KUBERNETES_SCALE_REMEDIATION_ADAPTER.supportsToolSchema(valid)).toBe(true);
    expect(KUBERNETES_SCALE_REMEDIATION_ADAPTER.supportsToolSchema({
      ...valid,
      properties: { ...valid.properties, scale: { type: 'string' } },
    })).toBe(false);
    expect(KUBERNETES_SCALE_REMEDIATION_ADAPTER.supportsToolSchema({
      ...valid, required: ['apiVersion', 'name'],
    })).toBe(false);
  });

  it('builds an immutable provider plan from trusted intent and observed state', () => {
    const plan = KUBERNETES_SCALE_REMEDIATION_ADAPTER.preparePlan({
      intent: {
        adapterKey: 'kubernetes.scale.v1', workloadKind: 'StatefulSet',
        workloadName: 'orders', desiredReplicas: 4,
      },
      target: {
        backendId: 42, targetId: 'demo-kind', cluster: 'argus-aiops',
        namespace: 'argus-demo', environment: 'demo',
      },
      currentResult: { content: [{ type: 'text', text: '{"scale":2}' }] },
    });
    expect(plan).not.toBeNull();
    expect(plan).toMatchObject({
      targetScope: { workloadKind: 'StatefulSet', workloadName: 'orders', namespace: 'argus-demo' },
      writeArguments: { kind: 'StatefulSet', name: 'orders', namespace: 'argus-demo', scale: 4 },
      verifyArguments: { kind: 'StatefulSet', name: 'orders', namespace: 'argus-demo' },
      rollbackArguments: { kind: 'StatefulSet', name: 'orders', namespace: 'argus-demo', scale: 2 },
      adapterState: { schemaVersion: 1, before: { replicas: 2 }, desired: { replicas: 4 } },
      previousReplicas: 2, desiredReplicas: 4,
    });
    expect(plan!.preview.lines).toEqual(['- replicas: 2', '+ replicas: 4']);
  });

  it('parses bounded replica evidence and fails closed for unknown adapters', () => {
    expect(KUBERNETES_SCALE_REMEDIATION_ADAPTER.observedState({
      content: [{ type: 'text', text: '{"spec":{"replicas":3}}' }],
    })).toEqual({ schemaVersion: 1, observed: { replicas: 3 } });
    expect(KUBERNETES_SCALE_REMEDIATION_ADAPTER.observedState({
      content: [{ type: 'text', text: 'mutation accepted' }],
    })).toBeNull();
    expect(KUBERNETES_SCALE_REMEDIATION_ADAPTER.observedState({
      content: [{ type: 'text', text: '{"scale":3}' }],
    })).toEqual({ schemaVersion: 1, observed: { replicas: 3 } });
    expect(KUBERNETES_SCALE_REMEDIATION_ADAPTER.normalizeState({
      schemaVersion: 1, before: { replicas: 2 }, desired: { replicas: 4 }, ignored: true,
    })).toEqual({ schemaVersion: 1, before: { replicas: 2 }, desired: { replicas: 4 } });
    expect(KUBERNETES_SCALE_REMEDIATION_ADAPTER.normalizeState({
      schemaVersion: 1, desired: { replicas: 4 },
    })).toBeNull();
    expect(incidentRemediationAdapter('shell.exec')).toBeNull();
    expect(listIncidentRemediationAdapters()).toEqual([
      expect.objectContaining({
        key: 'kubernetes.scale.v1',
        controls: {
          riskLevel: 'high', planApproval: 'hash_bound', verification: 'read_after_write',
          rollback: 'verified_restore', postChangeMonitoring: true, productionSeparationOfDuties: true,
        },
      }),
      expect.objectContaining({
        key: 'kubernetes.deployment-revision-rollback.v1',
        remoteToolName: 'deployment_revision_rollback',
      }),
    ]);
  });

  it('builds and verifies a template-fingerprint-bound Deployment revision rollback', () => {
    const beforeHash = 'a'.repeat(64);
    const targetHash = 'b'.repeat(64);
    const intent = normalizeIncidentRemediationExecutionIntent({
      adapterKey: 'kubernetes.deployment-revision-rollback.v1',
      workloadKind: 'Deployment', workloadName: 'checkout-api', targetRevision: 4,
    });
    expect(intent).toEqual({
      adapterKey: 'kubernetes.deployment-revision-rollback.v1',
      workloadKind: 'Deployment', workloadName: 'checkout-api', targetRevision: 4,
    });
    const currentResult = {
      content: [{ type: 'text' as const, text: JSON.stringify({
        currentRevision: 7,
        templateHash: beforeHash,
        availableRevisions: [
          { revision: 7, templateHash: beforeHash },
          { revision: 4, templateHash: targetHash },
        ],
      }) }],
    };
    const plan = KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_REMEDIATION_ADAPTER.preparePlan({
      intent: intent!,
      target: {
        backendId: 42, targetId: 'demo-kind', cluster: 'argus-aiops',
        namespace: 'argus-demo', environment: 'demo',
      },
      currentResult,
    });
    expect(plan).toMatchObject({
      preview: { format: 'deployment_revision_diff' },
      writeArguments: {
        name: 'checkout-api', namespace: 'argus-demo', targetRevision: 4,
        expectedCurrentTemplateHash: beforeHash, targetTemplateHash: targetHash,
      },
      rollbackArguments: {
        name: 'checkout-api', namespace: 'argus-demo', targetRevision: 7,
        expectedCurrentTemplateHash: targetHash, targetTemplateHash: beforeHash,
      },
      adapterState: {
        schemaVersion: 1,
        before: { revision: 7, templateHash: beforeHash },
        desired: { targetRevision: 4, templateHash: targetHash },
      },
      previousReplicas: null, desiredReplicas: null, noop: false,
    });
    const observed = KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_REMEDIATION_ADAPTER.observedState(currentResult);
    expect(observed).toEqual({ schemaVersion: 1, observed: { revision: 7, templateHash: beforeHash } });
    expect(KUBERNETES_DEPLOYMENT_REVISION_ROLLBACK_REMEDIATION_ADAPTER.matchesBeforeState(
      plan!.adapterState,
      observed!,
    )).toBe(true);
  });
});
