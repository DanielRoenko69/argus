import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  executionTargetsFromBackend,
  mergeExecutionTargetConfig,
  normalizeKubernetesExecutionTargetMutation,
  resolveExecutionResourceScope,
} from '../executionTargets.js';

const backend = {
  id: 17,
  name: 'aiops-kubernetes',
  description: 'Kubernetes evidence',
  enabled: true,
  bundle_ids: [8],
  config: {
    scope_kind: 'kubernetes',
    platform: 'kubernetes',
    target_id: 'argus-aiops-kind',
    target_label: 'Local Kind cluster',
    cluster: 'argus-aiops',
    environment: 'local-demo',
    execution_namespaces: ['argus-demo', 'invalid/NAMESPACE'],
    bearer_token: 'must-not-leak',
  },
};

describe('Solution Pack execution targets', () => {
  it('publishes only the safe target catalog derived from private backend config', () => {
    const targets = executionTargetsFromBackend(backend);
    expect(targets).toEqual([expect.objectContaining({
      kind: 'kubernetes',
      platform: 'kubernetes',
      backendId: 17,
      targetId: 'argus-aiops-kind',
      targetLabel: 'Local Kind cluster',
      cluster: 'argus-aiops',
      namespace: 'argus-demo',
      bundleIds: [8],
    })]);
    expect(JSON.stringify(targets)).not.toContain('must-not-leak');
  });

  it('normalizes the public editor contract and rejects provider config injection', () => {
    expect(normalizeKubernetesExecutionTargetMutation({
      kind: 'kubernetes',
      platform: 'gke',
      targetId: 'production-kubernetes',
      label: 'Production Kubernetes',
      cluster: 'eu-central-platform-01',
      environment: 'production',
      namespaces: ['payments', 'observability', 'payments'],
    })).toEqual({
      scope_kind: 'kubernetes',
      platform: 'gke',
      target_id: 'production-kubernetes',
      target_label: 'Production Kubernetes',
      cluster: 'eu-central-platform-01',
      environment: 'production',
      execution_namespaces: ['payments', 'observability'],
    });
    expect(() => normalizeKubernetesExecutionTargetMutation({
      kind: 'kubernetes',
      targetId: 'production-kubernetes',
      label: 'Production Kubernetes',
      cluster: 'eu-central-platform-01',
      environment: 'production',
      namespaces: ['payments'],
      bearerToken: 'must-not-be-accepted',
    })).toThrow(/unknown field/);
  });

  it('changes only safe target fields while preserving private provider configuration', () => {
    const next = mergeExecutionTargetConfig(backend.config, {
      scope_kind: 'kubernetes',
      platform: 'openshift',
      target_id: 'staging-kubernetes',
      target_label: 'Staging Kubernetes',
      cluster: 'eu-central-staging-01',
      environment: 'staging',
      execution_namespaces: ['preview'],
    });
    expect(next).toMatchObject({
      target_id: 'staging-kubernetes',
      platform: 'openshift',
      bearer_token: 'must-not-leak',
    });
    expect(mergeExecutionTargetConfig(next, null)).toEqual({ bearer_token: 'must-not-leak' });
  });

  it('resolves an exact target only through a selected member bundle', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [backend] })) } as unknown as pg.Pool;
    await expect(resolveExecutionResourceScope(pool, [8], {
      kind: 'kubernetes', backendId: 17, targetId: 'argus-aiops-kind', namespace: 'argus-demo',
    })).resolves.toEqual({
      kind: 'kubernetes', backendId: 17, targetId: 'argus-aiops-kind', cluster: 'argus-aiops',
      namespace: 'argus-demo', environment: 'local-demo',
    });
    await expect(resolveExecutionResourceScope(pool, [9], {
      kind: 'kubernetes', backendId: 17, targetId: 'argus-aiops-kind', namespace: 'argus-demo',
    })).rejects.toThrow(/not enabled in the selected MCP bundle scope/);
  });
});
