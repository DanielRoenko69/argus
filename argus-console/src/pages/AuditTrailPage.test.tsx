import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditTrailPage } from './AuditTrailPage';

const api = vi.hoisted(() => ({
  ApiRequestError: class ApiRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } },
  auditReportArtifactUrl: vi.fn((id: string, format: string) => `/reports/${id}.${format}`),
  auditRetentionVerifierUrl: '/api/ui/audit/retention-verifier/v1',
  anchorAuditEvidencePack: vi.fn(), createAuditReportDefinition: vi.fn(), disableAuditReportDefinition: vi.fn(), downloadAuditReportArtifact: vi.fn(), getAuditEntries: vi.fn(), getAuditStats: vi.fn(),
  archiveAuditRetentionPlan: vi.fn(), createAuditRetentionPlan: vi.fn(), decideAuditRetentionPlan: vi.fn(), getAuditRetentionPlans: vi.fn(), runAuditRetentionRestoreDrill: vi.fn(), sealAuditRetentionChainSegment: vi.fn(),
  getAuditReportCatalog: vi.fn(), getCanonicalAuditEvidence: vi.fn(), getOverview: vi.fn(), reviewAuditReport: vi.fn(), runAuditReport: vi.fn(),
}));
vi.mock('../api', () => api);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const entry = `${window.location.pathname}${window.location.search}`;
  render(<MemoryRouter initialEntries={[entry]}><QueryClientProvider client={client}><AuditTrailPage /></QueryClientProvider></MemoryRouter>);
}

describe('AuditTrailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/observe/audit');
    api.getOverview.mockResolvedValue({ user: { role: 'platform_admin' } });
    api.getCanonicalAuditEvidence.mockResolvedValue({
      schemaVersion: 1, generatedAt: '2026-09-09T12:00:00.000Z', nextCursor: null,
      verification: { state: 'event_hashes_and_checkpoint_valid', checkpointId: 'checkpoint-1', checkedAt: '2026-09-09T12:00:00.000Z' },
      coverage: { canonicalProducerFamilies: ['tags'], legacyGaps: [{ code: 'legacy_sources_not_canonical', description: 'Legacy sources remain outside the completeness claim.' }] },
      export: { allowed: true, state: 'available', formats: ['json'], requiresStepUp: false },
      items: [{ id: 'event-1', occurredAt: '2026-09-09T11:00:00.000Z', receivedAt: '2026-09-09T11:00:00.000Z', environment: 'production', solution: 'argus.core',
        actor: { type: 'human', id: 'alex', ssoSubject: 'alex@example.test', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
        action: 'access.policy.updated', outcome: 'success', risk: 'high', policy: { id: 'policy-1', version: '2', decision: 'allow' },
        approval: { id: null, href: null }, resource: { type: 'access_policy', id: '42', label: 'Production policy', href: null, version: '2', tags: [] },
        correlation: { rootRunId: null, traceId: 'trace-1', spanId: null, requestId: null, rootRunHref: null, logsHref: '/observe/logs?trace=trace-1' },
        digests: { payload: 'a'.repeat(64), before: null, after: 'b'.repeat(64), redactionProfile: 'canonical-v1' },
        integrity: { sequence: 42, previousHash: 'c'.repeat(64), hash: 'd'.repeat(64), hashState: 'event_hash_valid', signingKeyId: null, checkpointId: 'checkpoint-1' },
        retention: { class: 'business-audit-governance', until: null, legalHold: false }, summary: 'Policy update was allowed and committed.' }],
    });
    api.getAuditReportCatalog.mockResolvedValue({ readiness: { enabled: true, signingConfigured: true, canonicalEventCount: 42, checkpointCount: 2, environments: ['production'], ready: true }, exportSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' }, externalAnchoring: { enabled: false, provider: null, supportedKinds: [], requiresFreshMfa: true }, definitions: [], runs: [] });
    api.getAuditRetentionPlans.mockResolvedValue({
      schemaVersion: 1,
      readiness: { mode: 'archive_first', purgeEnabled: false, signerConfigured: true, requiresFreshMfa: true, requiresIndependentApproval: true, requiresExternalArchiveAnchor: true, externalArchiveConfigured: false, externalArchiveProvider: null, restoreDrillConfigured: false },
      operationSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' },
      plans: [],
    });
  });

  it('shows verified canonical evidence and opens the integrity drill-down', async () => {
    renderPage();
    expect(await screen.findByText('access.policy.updated')).toBeVisible();
    expect(screen.getByText('Verified')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /access.policy.updated/i }));
    expect(screen.getByRole('dialog', { name: 'Audit event evidence' })).toBeVisible();
    expect(screen.getByText('Integrity proof')).toBeVisible();
  });

  it('shows signed report readiness on the reports tab', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Reports' }));
    expect(await screen.findByRole('heading', { name: 'Signed report pipeline ready' })).toBeVisible();
    const generate = screen.getByRole('button', { name: /Generate report now/ });
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    expect(screen.getByRole('dialog', { name: 'Generate general audit report' })).toBeVisible();
    expect(screen.getByText(/entire workspace and tenant/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Generate signed report' })).toBeEnabled();
    expect(screen.getByText('42')).toBeVisible();
  });

  it('restores the reports tab after an MFA step-up redirect', async () => {
    window.history.replaceState({}, '', '/observe/audit?tab=reports');
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Signed report pipeline ready' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reports' })).toHaveClass('is-active');
  });

  it('offers provider-supported anchoring and shows verified receipts', async () => {
    api.getAuditReportCatalog.mockResolvedValueOnce({
      readiness: { enabled: true, signingConfigured: true, canonicalEventCount: 42, checkpointCount: 2, environments: ['production'], ready: true },
      exportSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' },
      externalAnchoring: { enabled: true, provider: 'Customer WORM', supportedKinds: ['worm_object', 'qualified_timestamp'], requiresFreshMfa: true },
      definitions: [],
      runs: [{
        id: 'report-1', name: 'Production evidence', reportType: 'compliance', status: 'completed', createdAt: '2026-09-09T12:00:00.000Z',
        eventCount: 42, chainEntryCount: 42, gapCodes: [], packDigest: 'a'.repeat(64), reviews: [],
        externalAnchors: [{ anchorId: 'anchor-1', anchorKind: 'worm_object', provider: 'Customer WORM', reference: 'immutable://pack/1', verification: 'verified' }],
      }],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Reports' }));
    expect(await screen.findByText('WORM verified')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add timestamp' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Anchor WORM' })).not.toBeInTheDocument();
  });

  it('shows archive-first retention with deletion visibly disabled', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Retention' }));
    expect(await screen.findByRole('heading', { name: 'Physical purge is fail-closed' })).toBeVisible();
    expect(screen.getByText('Deletion disabled')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create signed dry-run' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Offline verifier' })).toHaveAttribute('href', '/api/ui/audit/retention-verifier/v1');
    expect(screen.getByText(/without deleting or modifying evidence/i)).toBeVisible();
  });

  it('offers WORM archival only after approval and keeps purge disabled', async () => {
    api.getAuditRetentionPlans.mockResolvedValueOnce({
      schemaVersion: 1,
      readiness: { mode: 'archive_first', purgeEnabled: false, signerConfigured: true, requiresFreshMfa: true, requiresIndependentApproval: true, requiresExternalArchiveAnchor: true, externalArchiveConfigured: true, externalArchiveProvider: 'Customer WORM', restoreDrillConfigured: true },
      operationSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' },
      plans: [{ planId: '10000000-0000-4000-8000-000000000001', environment: 'production', retentionClass: 'all-classes', checkpointId: '20000000-0000-4000-8000-000000000002', checkpointDigest: 'c'.repeat(64), throughSequence: 42, evaluatedAt: '2026-09-10T10:00:00.000Z', eligiblePrefixCount: 12, firstSequence: 1, lastSequence: 12, blocker: { code: 'not_due', sequence: 13 }, manifestSha256: 'd'.repeat(64), manifest: { schemaVersion: 1, mode: 'dry_run', evaluatedAt: '2026-09-10T10:00:00.000Z', purgeAllowed: false, eligibleEvents: [], nextRequiredAction: 'independent_approval_then_archive' }, requestedById: '41', requesterSsoSubject: 'oidc:41', mfaVerifiedAt: '2026-09-10T09:59:00.000Z', mfaMethod: 'webauthn', producerEventId: 'plan-1', createdAt: '2026-09-10T10:00:00.000Z', status: 'approved', archive: null }],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Retention' }));
    expect(await screen.findByRole('button', { name: 'Archive to WORM & verify' })).toBeEnabled();
    expect(screen.getByText('Deletion disabled')).toBeVisible();
    expect(screen.queryByRole('button', { name: /purge/i })).not.toBeInTheDocument();
  });

  it('offers an independent restore verification and displays its latest immutable proof', async () => {
    api.getAuditRetentionPlans.mockResolvedValueOnce({
      schemaVersion: 1,
      readiness: { mode: 'archive_first', purgeEnabled: false, signerConfigured: true, requiresFreshMfa: true, requiresIndependentApproval: true, requiresExternalArchiveAnchor: true, externalArchiveConfigured: true, externalArchiveProvider: 'Customer WORM', restoreDrillConfigured: true },
      operationSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' },
      plans: [{ planId: '10000000-0000-4000-8000-000000000001', environment: 'production', retentionClass: 'all-classes', checkpointId: '20000000-0000-4000-8000-000000000002', checkpointDigest: 'c'.repeat(64), throughSequence: 42, evaluatedAt: '2026-09-10T10:00:00.000Z', eligiblePrefixCount: 12, firstSequence: 1, lastSequence: 12, blocker: { code: 'not_due', sequence: 13 }, manifestSha256: 'd'.repeat(64), manifest: { schemaVersion: 1, mode: 'dry_run', evaluatedAt: '2026-09-10T10:00:00.000Z', purgeAllowed: false, eligibleEvents: [], nextRequiredAction: 'independent_approval_then_archive' }, requestedById: '41', requesterSsoSubject: 'oidc:41', mfaVerifiedAt: '2026-09-10T09:59:00.000Z', mfaMethod: 'webauthn', producerEventId: 'plan-1', createdAt: '2026-09-10T10:00:00.000Z', status: 'archive_verified', archive: {
        archiveId: '30000000-0000-4000-8000-000000000003', planId: '10000000-0000-4000-8000-000000000001', checkpointId: '20000000-0000-4000-8000-000000000002', checkpointDigest: 'c'.repeat(64), manifestSha256: 'd'.repeat(64), packageSha256: 'e'.repeat(64), packageBytes: 4096, eventCount: 12, firstSequence: 1, lastSequence: 12, lastEventHash: 'f'.repeat(64), provider: 'Customer WORM', reference: 'immutable://archive/1', archivedAt: '2026-09-10T10:30:00.000Z', retentionUntil: '2036-09-10T10:30:00.000Z', statementSha256: 'a'.repeat(64), receiptSha256: 'b'.repeat(64), verificationKeyId: 'key-1', verificationKeyFingerprint: 'c'.repeat(64), verification: 'verified', requestedById: '42', createdAt: '2026-09-10T10:30:00.000Z',
        restoreDrills: [{ drillId: '40000000-0000-4000-8000-000000000004', archiveId: '30000000-0000-4000-8000-000000000003', provider: 'Customer WORM', reference: 'immutable://archive/1', packageSha256: 'e'.repeat(64), receiptSha256: 'b'.repeat(64), checkpointDigest: 'c'.repeat(64), eventCount: 12, firstSequence: 1, lastSequence: 12, lastEventHash: 'f'.repeat(64), retrievedBytes: 4096, retrievedAt: '2026-09-10T11:00:00.000Z', verifiedAt: '2026-09-10T11:00:00.000Z', durationMs: 318, verificationStatus: 'verified', requestedById: '44', createdAt: '2026-09-10T11:00:00.000Z', verification: { receipt: 'signature_valid', package: 'sha256_valid', checkpoint: 'signature_valid', eventChain: 'complete_and_valid', wormRetention: 'active', purgeAuthorized: false } }],
      }}],
    });
    renderPage(); fireEvent.click(await screen.findByRole('button', { name: 'Retention' }));
    expect(await screen.findByText('Full restore verified')).toBeVisible();
    expect(screen.getByText(/12 events · 318 ms/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run restore verification' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Seal chain segment' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /purge/i })).not.toBeInTheDocument();
  });

  it('shows the immutable segment continuation proof after sealing', async () => {
    api.getAuditRetentionPlans.mockResolvedValueOnce({
      schemaVersion: 1,
      readiness: { mode: 'archive_first', purgeEnabled: false, signerConfigured: true, requiresFreshMfa: true, requiresIndependentApproval: true, requiresExternalArchiveAnchor: true, externalArchiveConfigured: true, externalArchiveProvider: 'Customer WORM', restoreDrillConfigured: true, offlineVerifierAvailable: true, segmentSealingEnabled: true },
      operationSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' },
      plans: [{ planId: '10000000-0000-4000-8000-000000000001', environment: 'production', retentionClass: 'all-classes', checkpointId: '20000000-0000-4000-8000-000000000002', checkpointDigest: 'c'.repeat(64), throughSequence: 42, evaluatedAt: '2026-09-10T10:00:00.000Z', eligiblePrefixCount: 12, firstSequence: 1, lastSequence: 12, blocker: { code: 'not_due', sequence: 13 }, manifestSha256: 'd'.repeat(64), manifest: { schemaVersion: 1, mode: 'dry_run', evaluatedAt: '2026-09-10T10:00:00.000Z', purgeAllowed: false, eligibleEvents: [], nextRequiredAction: 'independent_approval_then_archive' }, requestedById: '41', requesterSsoSubject: 'oidc:41', mfaVerifiedAt: '2026-09-10T09:59:00.000Z', mfaMethod: 'webauthn', producerEventId: 'plan-1', createdAt: '2026-09-10T10:00:00.000Z', status: 'archive_verified', archive: {
        archiveId: '30000000-0000-4000-8000-000000000003', planId: '10000000-0000-4000-8000-000000000001', checkpointId: '20000000-0000-4000-8000-000000000002', checkpointDigest: 'c'.repeat(64), manifestSha256: 'd'.repeat(64), packageSha256: 'e'.repeat(64), packageBytes: 4096, eventCount: 12, firstSequence: 1, lastSequence: 12, lastEventHash: 'f'.repeat(64), provider: 'Customer WORM', reference: 'immutable://archive/1', archivedAt: '2026-09-10T10:30:00.000Z', retentionUntil: '2036-09-10T10:30:00.000Z', statementSha256: 'a'.repeat(64), receiptSha256: 'b'.repeat(64), verificationKeyId: 'key-1', verificationKeyFingerprint: 'c'.repeat(64), verification: 'verified', requestedById: '42', createdAt: '2026-09-10T10:30:00.000Z', restoreDrills: [],
        segment: { segmentId: '40000000-0000-4000-8000-000000000004', segmentOrdinal: 1, previousSegmentId: null, previousSegmentDigest: '', archiveId: '30000000-0000-4000-8000-000000000003', restoreDrillId: '50000000-0000-4000-8000-000000000005', firstSequence: 1, lastSequence: 12, eventCount: 12, firstPreviousHash: '', lastEventHash: 'f'.repeat(64), continuationSequence: 13, continuationPreviousHash: 'f'.repeat(64), checkpointId: '20000000-0000-4000-8000-000000000002', checkpointDigest: 'c'.repeat(64), archivePackageSha256: 'e'.repeat(64), archiveReceiptSha256: 'b'.repeat(64), segmentDigest: '9'.repeat(64), sealedAt: '2026-09-10T11:30:00.000Z', requestedById: '44', createdAt: '2026-09-10T11:30:00.000Z', verification: { archive: 'worm_receipt_verified', restoreDrill: 'full_download_verified', sourceBoundary: 'canonical_chain_verified', continuation: 'hash_anchored', purgeAuthorized: false } },
      }}],
    });
    renderPage(); fireEvent.click(await screen.findByRole('button', { name: 'Retention' }));
    expect(await screen.findByText('Canonical chain segment #1 sealed')).toBeVisible();
    expect(screen.getByText(/next #13 anchors/)).toBeVisible();
    expect(screen.getByText('No purge grant')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Seal chain segment' })).not.toBeInTheDocument();
  });
});
