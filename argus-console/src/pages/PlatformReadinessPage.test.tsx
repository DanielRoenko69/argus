import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformReadinessPage } from './PlatformReadinessPage';

const api = vi.hoisted(() => ({
  getPlatformBackendHealth: vi.fn(),
  getIdentitySecurityStatus: vi.fn(),
  getAiOpsReadiness: vi.fn(),
  getAuditReportCatalog: vi.fn(),
  getSolutionPacks: vi.fn(),
  getPlatformExecutionCertificates: vi.fn(),
}));
vi.mock('../api', () => api);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><PlatformReadinessPage /></QueryClientProvider></MemoryRouter>);
}

function mockReady() {
  api.getPlatformBackendHealth.mockResolvedValue({
    timestamp: '2026-10-06T12:00:00.000Z', total: 4, ok: 4, down: 0,
    results: [
      { name: 'postgres', kind: 'internal', url: null, status: 'ok', latency_ms: 2 },
      { name: 'argus-self', kind: 'internal', url: '/health', status: 'ok', latency_ms: 4 },
      { name: 'gitea', kind: 'mcp_backend', url: 'http://gitea:3000', status: 'ok', latency_ms: 8 },
      { name: 'jenkins-ci', kind: 'mcp_backend', url: 'http://jenkins:8080', status: 'ok', latency_ms: 11 },
    ],
  });
  api.getIdentitySecurityStatus.mockResolvedValue({
    provider: { enabled: true, name: 'Keycloak', type: 'oidc', ssoOnly: true, localLoginEnabled: false, emergencyLocalAdmin: true, mfaMaxAgeSeconds: 600, accountManagementUrl: null, adminConsoleUrl: null },
    session: { authMethod: 'oidc', ssoLinked: true, mfaVerifiedAt: '2026-10-06T11:58:00.000Z', mfaMethod: 'otp', mfaFresh: true },
    actions: { canLink: false, canStepUp: true, canManageMfa: true, canManageOrganizationPolicy: true },
    complianceReports: { roleAuthorized: true, freshMfaRequired: true, ready: true },
  });
  api.getAiOpsReadiness.mockResolvedValue({
    schemaVersion: 1, kind: 'aiops-readiness', state: 'ready', presentation: 'connected_summary', generatedAt: '2026-10-06T12:00:00.000Z',
    pack: { state: 'ready', version: '0.4.0' }, eligibleBundleCount: 1, availableLanes: ['metrics', 'logs', 'traces'], primaryConnection: null,
    profiles: { active: 1, ready: 1, degraded: 0, blocked: 0 }, issues: [], recoveryActions: [],
  });
  api.getAuditReportCatalog.mockResolvedValue({
    readiness: { enabled: true, signingConfigured: true, canonicalEventCount: 42, checkpointCount: 2, environments: ['production'], ready: true },
    exportSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' },
    externalAnchoring: { enabled: true, provider: 'minio-object-lock', supportedKinds: ['worm_object'], requiresFreshMfa: true }, definitions: [], runs: [],
  });
  api.getSolutionPacks.mockResolvedValue({ total: 1, packs: [{ configuredId: 'argus-dev', endpoint: 'http://argus-dev:2025', state: 'ready', checkedAt: '2026-10-06T12:00:00.000Z', manifest: { metadata: { id: 'argus.dev', version: '0.4.0', displayName: 'Argus Dev' } } }] });
  api.getPlatformExecutionCertificates.mockResolvedValue({
    schemaVersion: 1, kind: 'platform-execution-certificate-catalog', profile: { id: 'pilot-demo', label: 'Pilot & live demo' }, freshnessDays: 7, limitation: 'Operational evidence only.',
    certificates: [{
      id: '11111111-1111-4111-8111-111111111111', workspaceKey: 'default', tenantKey: 'default', environment: 'local', profileId: 'pilot-demo', sourceSchema: 'argus.solution-showcase-golden-runs.v1', sourceMode: 'verify-only', generatedAt: new Date().toISOString(), recordedAt: new Date().toISOString(), recordedBy: 'alex', payloadSha256: 'a'.repeat(64), passed: true, devPassed: true, aiopsPassed: true,
      identity: { displayName: 'Alex', username: 'oidc:alex', authMethod: 'oidc', mfaMethod: 'otp' },
      dev: { taskId: '11111111-1111-4111-8111-111111111112', rootTraceId: '11111111-1111-4111-8111-111111111113', workflowId: 'ticket-to-image-pull-request', verificationMode: 'review-only-image', testExecution: 'intentionally_skipped', ticketId: 'ARGUS-1', repository: 'alex/demo', branchName: 'feature/demo', commitSha: 'b'.repeat(40), pullRequestUrl: 'http://localhost:3005/alex/demo/pulls/1', changedFiles: ['src/app.js'], ci: { provider: 'jenkins', status: 'success', runUrl: 'http://localhost:8081/job/demo/1', imageTag: 'demo:1', imageId: 'sha256:image' } },
      aiops: { taskId: '11111111-1111-4111-8111-111111111114', rootTraceId: '11111111-1111-4111-8111-111111111115', state: 'TASK_STATE_COMPLETED', quality: 'reviewed', profile: { displayName: 'Checkout', service: 'checkout-api', environment: 'demo', revision: 1, sha256: 'c'.repeat(64) }, evidenceLanes: [{ lane: 'metrics', status: 'collected' }], providerToolNames: ['prometheus'] },
    }],
  });
}

describe('PlatformReadinessPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows a fail-closed, exportable readiness snapshot without starting work', async () => {
    mockReady();
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Ready to demonstrate' })).toBeInTheDocument();
    expect(screen.getByLabelText('Readiness score 100 percent')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Repository & CI delivery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /JSON snapshot/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Markdown/ })).toBeEnabled();
    expect(screen.getByRole('table', { name: 'Platform backend readiness' })).toHaveTextContent('jenkins-ci');
    expect(screen.getByRole('heading', { name: 'Ticket to reviewed image' })).toBeInTheDocument();
    expect(screen.getByText('Reviewer-gated · tests intentionally skipped')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Signal to reviewed evidence' })).toBeInTheDocument();
    expect(api.getPlatformBackendHealth).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unavailable evidence source instead of claiming readiness', async () => {
    mockReady();
    api.getAuditReportCatalog.mockRejectedValue(new Error('evidence unavailable'));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Readiness blockers found' })).toBeInTheDocument();
    expect(await screen.findByText('evidence unavailable')).toBeInTheDocument();
  });
});
