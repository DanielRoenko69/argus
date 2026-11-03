import { describe, expect, it } from 'vitest';
import type { PlatformReadinessSources } from './platformReadiness';
import { buildPlatformReadinessSnapshot, readinessSnapshotMarkdown } from './platformReadiness';

const readySources: PlatformReadinessSources = {
  generatedAt: '2026-10-06T12:00:00.000Z',
  backends: {
    timestamp: '2026-10-06T12:00:00.000Z', total: 4, ok: 4, down: 0,
    results: [
      { name: 'postgres', kind: 'internal', url: null, status: 'ok', latency_ms: 2 },
      { name: 'argus-self', kind: 'internal', url: '/health', status: 'ok', latency_ms: 4 },
      { name: 'gitea', kind: 'mcp_backend', url: 'http://gitea:3000', status: 'ok', latency_ms: 9 },
      { name: 'jenkins-ci', kind: 'mcp_backend', url: 'http://jenkins:8080', status: 'ok', latency_ms: 13 },
    ],
  },
  identity: {
    provider: { enabled: true, name: 'Keycloak', type: 'oidc', ssoOnly: true, localLoginEnabled: false, emergencyLocalAdmin: true, mfaMaxAgeSeconds: 600, accountManagementUrl: null, adminConsoleUrl: null },
    session: { authMethod: 'oidc', ssoLinked: true, mfaVerifiedAt: '2026-10-06T11:58:00.000Z', mfaMethod: 'otp', mfaFresh: true },
    actions: { canLink: false, canStepUp: true, canManageMfa: true, canManageOrganizationPolicy: true },
    complianceReports: { roleAuthorized: true, freshMfaRequired: true, ready: true },
  },
  aiops: {
    schemaVersion: 1, kind: 'aiops-readiness', state: 'ready', presentation: 'connected_summary', generatedAt: '2026-10-06T12:00:00.000Z',
    pack: { state: 'ready', version: '0.4.0' }, eligibleBundleCount: 1, availableLanes: ['metrics', 'logs', 'traces'],
    primaryConnection: { bundleId: 1, bundleName: 'Argus.AIOps Observe', lanes: ['metrics', 'logs', 'traces'], certifiedTargetCount: 1, checkedAt: '2026-10-06T12:00:00.000Z' },
    profiles: { active: 1, ready: 1, degraded: 0, blocked: 0 }, issues: [], recoveryActions: [],
  },
  audit: {
    readiness: { enabled: true, signingConfigured: true, canonicalEventCount: 42, checkpointCount: 2, environments: ['production'], ready: true },
    exportSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' },
    externalAnchoring: { enabled: true, provider: 'minio-object-lock', supportedKinds: ['worm_object'], requiresFreshMfa: true },
    definitions: [], runs: [],
  },
  packs: {
    total: 1,
    packs: [{ configuredId: 'argus-dev', endpoint: 'http://argus-dev:2025', state: 'ready', checkedAt: '2026-10-06T12:00:00.000Z', manifest: { metadata: { id: 'argus.dev', version: '0.4.0', displayName: 'Argus Dev' } } }] as never,
  },
  executionProofs: {
    schemaVersion: 1, kind: 'platform-execution-certificate-catalog', profile: { id: 'pilot-demo', label: 'Pilot & live demo' }, freshnessDays: 7,
    limitation: 'Operational evidence only.',
    certificates: [{
      id: '11111111-1111-4111-8111-111111111111', workspaceKey: 'default', tenantKey: 'default', environment: 'local', profileId: 'pilot-demo',
      sourceSchema: 'argus.solution-showcase-golden-runs.v1', sourceMode: 'verify-only', generatedAt: '2026-10-06T11:59:00.000Z', recordedAt: '2026-10-06T12:00:00.000Z', recordedBy: 'alex', payloadSha256: 'a'.repeat(64),
      passed: true, devPassed: true, aiopsPassed: true, identity: { displayName: 'Alex', username: 'oidc:alex', authMethod: 'oidc', mfaMethod: 'otp' },
      dev: { taskId: '11111111-1111-4111-8111-111111111112', rootTraceId: '11111111-1111-4111-8111-111111111113', workflowId: 'ticket-to-pull-request', verificationMode: 'tests-and-review', testExecution: 'passed', ticketId: 'ARGUS-1', repository: 'alex/demo', branchName: 'feature/demo', commitSha: 'b'.repeat(40), pullRequestUrl: 'http://localhost/pr/1', changedFiles: ['src/app.js'], ci: { provider: 'jenkins', status: 'success', runUrl: 'http://localhost/ci/1', imageTag: 'demo:1', imageId: 'sha256:image' } },
      aiops: { taskId: '11111111-1111-4111-8111-111111111114', rootTraceId: '11111111-1111-4111-8111-111111111115', state: 'TASK_STATE_COMPLETED', quality: 'reviewed', profile: { displayName: 'Checkout', service: 'checkout-api', environment: 'demo', revision: 1, sha256: 'c'.repeat(64) }, evidenceLanes: [{ lane: 'metrics', status: 'collected' }], providerToolNames: ['prometheus'] },
    }],
  },
};

describe('platform readiness snapshot', () => {
  it('marks the pilot path ready only when every required control is available', () => {
    const snapshot = buildPlatformReadinessSnapshot(readySources);
    expect(snapshot.state).toBe('ready');
    expect(snapshot.score).toBe(100);
    expect(snapshot.summary).toEqual({ passed: 7, warnings: 0, failed: 0, unknown: 0, total: 7 });
    expect(snapshot.checks.map(item => item.id)).toEqual(['core', 'delivery-backends', 'argus-dev', 'aiops', 'identity', 'evidence', 'execution-proof']);
  });

  it('keeps expired MFA and degraded AIOps visible as operator actions', () => {
    const snapshot = buildPlatformReadinessSnapshot({
      ...readySources,
      identity: { ...readySources.identity!, session: { ...readySources.identity!.session, mfaFresh: false } },
      aiops: { ...readySources.aiops!, state: 'degraded', issues: [{ code: 'metrics_stale', severity: 'warning', message: 'Metrics evidence is stale.' }] },
    });
    expect(snapshot.state).toBe('attention');
    expect(snapshot.summary.warnings).toBe(2);
    expect(snapshot.checks.find(item => item.id === 'identity')?.detail).toContain('MFA step-up');
  });

  it('counts an expired MFA assertion once instead of downgrading evidence twice', () => {
    const snapshot = buildPlatformReadinessSnapshot({
      ...readySources,
      identity: { ...readySources.identity!, session: { ...readySources.identity!.session, mfaFresh: false } },
      audit: { ...readySources.audit!, exportSecurity: { ...readySources.audit!.exportSecurity, satisfied: false } },
    });
    expect(snapshot.state).toBe('attention');
    expect(snapshot.summary).toEqual({ passed: 6, warnings: 1, failed: 0, unknown: 0, total: 7 });
    expect(snapshot.checks.find(item => item.id === 'evidence')?.state).toBe('pass');
  });

  it('fails closed when a required source is unavailable and exports the limitation', () => {
    const snapshot = buildPlatformReadinessSnapshot({
      generatedAt: readySources.generatedAt,
      errors: { backends: 'health timeout', identity: 'forbidden', aiops: 'offline', audit: 'offline', packs: 'offline' },
    });
    expect(snapshot.state).toBe('blocked');
    expect(snapshot.summary.unknown).toBe(7);
    expect(snapshot.unavailableSources).toHaveLength(5);
    expect(readinessSnapshotMarkdown(snapshot)).toContain('not signed audit evidence');
  });
});
