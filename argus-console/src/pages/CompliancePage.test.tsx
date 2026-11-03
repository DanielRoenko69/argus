import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComplianceRunDetailResponse, ComplianceWorkspaceResponse, OverviewResponse } from '../types';
import { CompliancePage } from './CompliancePage';

const api = vi.hoisted(() => ({
  classifyAiSystem: vi.fn(),
  createAiSystem: vi.fn(),
  deleteComplianceRun: vi.fn(),
  downloadAiComplianceDossierArtifact: vi.fn(),
  generateAiComplianceDossier: vi.fn(),
  getAiActControlCatalog: vi.fn(),
  getAiComplianceDossiers: vi.fn(),
  getAiSystemControlLedger: vi.fn(),
  getAiSystemRegistry: vi.fn(),
  getAiSystemRegistryDetail: vi.fn(),
  getAuditReportCatalog: vi.fn(),
  getComplianceRun: vi.fn(),
  getComplianceWorkspace: vi.fn(),
  getOverview: vi.fn(),
  releaseAiSystem: vi.fn(),
  recordAiSystemControlAssessment: vi.fn(),
  startComplianceRun: vi.fn(),
}));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: '2026-08-01T10:00:00.000Z',
  user: { id: 1, username: 'admin', displayName: 'Argus Admin', role: 'platform_admin' },
  attention: [],
  stats: { activeRuns: 0, successRate24h: null, completed24h: 0, failed24h: 0, workflowsInReview: 0, connectedTools: 0, agents: 0 },
  health: { state: 'healthy', healthy: 0, total: 0, degraded: 0 },
  runs: [],
};
const workspace: ComplianceWorkspaceResponse = {
  generatedAt: '2026-08-01T12:00:00.000Z',
  assessmentNotice: 'Automated evidence assessment. Results do not constitute certification.',
  auditor: { ready: true, agentId: 7 },
  stats: { frameworks: 2, readyFrameworks: 1, activeRuns: 0, completedRuns: 1, averageScore: 84, recentGaps: 1 },
  frameworks: [
    { id: 2, slug: 'nis2', label: 'NIS2', version: '2022/2555', jurisdiction: 'EU', description: 'Security directive', enabled: true, checklistReady: true, knowledgeAttached: false, ready: true },
    { id: 3, slug: 'soc2', label: 'SOC 2', version: '2017', jurisdiction: 'US', description: 'Trust services', enabled: true, checklistReady: false, knowledgeAttached: false, ready: false },
  ],
  runs: [{
    id: 41, frameworkId: 2, frameworkSlug: 'nis2', frameworkLabel: 'NIS2', target: 'argus-prod', agentId: 7,
    status: 'completed', score: 84, counts: { passed: 3, warning: 1, failed: 0, notApplicable: 0 },
    triggeredBy: 'admin', startedAt: '2026-08-01T10:00:00.000Z', completedAt: '2026-08-01T10:01:00.000Z', durationMs: 60_000, error: null,
  }],
};
const detail: ComplianceRunDetailResponse = {
  generatedAt: workspace.generatedAt,
  assessmentNotice: workspace.assessmentNotice,
  framework: workspace.frameworks[0]!,
  run: workspace.runs[0]!,
  findings: [{
    id: 9, article: 'Art. 21', title: 'Incident handling', verdict: 'warning', severity: 'high',
    evidence: 'The incident process is documented but not exercised.', remediation: 'Run a tabletop exercise.',
    codePointers: [{ file: 'docs/runbook.md', line: 7, snippet: 'Exercise pending' }], createdAt: '2026-08-01T10:00:30.000Z',
  }],
  exports: { pdf: '/api/ui/compliance/runs/41/export.pdf', csv: '/api/ui/compliance/runs/41/export.csv' },
};

function renderPage(path = '/governance/compliance', role = 'platform_admin') {
  api.getOverview.mockResolvedValue({ ...overview, user: { ...overview.user, role } });
  api.getComplianceWorkspace.mockResolvedValue(workspace);
  api.getComplianceRun.mockResolvedValue(detail);
  api.startComplianceRun.mockResolvedValue({ run: { ...workspace.runs[0], status: 'running', score: null } });
  api.deleteComplianceRun.mockResolvedValue({ deleted: true });
  api.getAiSystemRegistry.mockResolvedValue({ schemaVersion: 1, kind: 'ai-system-registry-list', claimBoundary: 'Evidence is not legal certification.', aiSystems: [{ aiSystemId: '10000000-0000-4000-8000-000000000001', revisionId: '10000000-0000-4000-8000-000000000002', revision: 3, revisionSha256: 'a'.repeat(64), displayName: 'Claims copilot', lifecycleState: 'released', classification: 'high_risk', owner: { actorType: 'user', actorId: '1' }, marketRoles: ['provider'], componentCount: 4, createdAt: '2026-08-01T08:00:00.000Z', releasedAt: '2026-08-01T09:00:00.000Z', tags: [], allowedActions: ['read'] }] });
  api.getAiSystemRegistryDetail.mockResolvedValue({ schemaVersion: 1, kind: 'ai-system-registry-detail', aiSystem: { tags: [], allowedActions: ['read'], revision: { schemaVersion: 1, kind: 'ai-system-revision', aiSystemId: '10000000-0000-4000-8000-000000000001', revisionId: '10000000-0000-4000-8000-000000000002', revision: 3, revisionSha256: 'a'.repeat(64), displayName: 'Claims copilot', lifecycleState: 'released', owner: { actorType: 'user', actorId: '1', displayName: 'Argus Admin' }, intendedPurpose: 'Assist claims reviewers without making the final decision.', prohibitedUses: ['Autonomous claim denial'], targetUsers: ['Claims reviewers'], affectedGroups: ['Policyholders'], regions: ['EU/EEA'], marketRoles: [{ role: 'provider', organisationId: 'argus', organisationName: 'Argus', rationale: 'Provides the configured system.', confirmedBy: { actorType: 'user', actorId: '1' }, confirmedAt: '2026-08-01T08:00:00.000Z' }], prohibitedPracticeCheck: { decision: 'clear', articleRefs: ['Article 5'], rationale: 'Reviewed.', decidedBy: { actorType: 'external_reviewer', actorId: 'reviewer' }, decidedAt: '2026-08-01T08:00:00.000Z' }, classification: { assessmentId: '11000000-0000-4000-8000-000000000001', classification: 'high_risk', articleRefs: ['Article 6'], annexRefs: ['Annex III'], highRiskBasis: 'Claims access may materially affect a natural person.', rationale: 'Independent assessment.', legalReviewRequired: false, assessedBy: { actorType: 'external_reviewer', actorId: 'reviewer' }, assessedAt: '2026-08-01T08:00:00.000Z', nextReviewAt: '2027-08-01T08:00:00.000Z' }, componentBindings: [{ resourceType: 'agent', resourceId: 'claims-agent', revision: '7', sha256: 'c'.repeat(64) }], dataCategories: ['Claims data'], controlCatalog: { catalogId: 'eu-ai-act-2024-1689-core', catalogVersion: 1, catalogSha256: 'd'.repeat(64) }, createdAt: '2026-08-01T08:00:00.000Z', releasedAt: '2026-08-01T09:00:00.000Z' }, readiness: { schemaVersion: 1, kind: 'ai-system-registration-readiness', aiSystemId: '10000000-0000-4000-8000-000000000001', revisionId: '10000000-0000-4000-8000-000000000002', state: 'released', generatedAt: '2026-08-01T10:00:00.000Z', evidenceCoverage: { applicable: 8, satisfied: 8, blocked: 0, notAssessed: 0, expiring: 0 }, steps: ['identity', 'intended_purpose', 'market_roles', 'prohibited_practices', 'classification', 'components', 'controls', 'independent_review'].map(stepId => ({ stepId, title: stepId.replaceAll('_', ' '), status: 'complete', blocking: false, issues: [], action: null })), customerResponsibilities: [{ responsibilityId: 'customer-legal', title: 'Confirm legal classification', ownerRole: 'provider', status: 'verified', dueAt: null }], allowedActions: ['read'], claimBoundary: 'Readiness is evidence support, not legal certification.' } } });
  const controlDefinition = { controlId: 'AIA-ART5-PROHIBITED-PRACTICES', articleRefs: ['Article 5'], title: 'Prohibited-practice screening', description: 'Reviewed intended-purpose screening.', applicability: 'always', enforcement: 'hybrid', blocksProduction: true, evidenceKinds: ['review_decision'], responsibilities: [{ party: 'provider', responsibility: 'Confirm intended purpose.', required: true }], customerInputs: ['Intended purpose'] };
  const controlCatalog = { schemaVersion: 1, kind: 'ai-act-control-catalog', catalogId: 'eu-ai-act-2024-1689-core', catalogVersion: 1, catalogSha256: 'd'.repeat(64), effectiveFrom: '2024-08-01T00:00:00.000Z', legalSource: { regulation: 'Regulation (EU) 2024/1689', title: 'European Union Artificial Intelligence Act', url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj' }, claimBoundary: 'Evidence support, not legal certification.', controls: [controlDefinition] };
  api.getAiActControlCatalog.mockResolvedValue({ schemaVersion: 1, kind: 'ai-act-control-catalog-response', catalog: controlCatalog });
  api.getAiSystemControlLedger.mockResolvedValue({ schemaVersion: 1, kind: 'ai-system-control-ledger', aiSystemId: '10000000-0000-4000-8000-000000000001', revisionId: '10000000-0000-4000-8000-000000000002', revision: 3, revisionSha256: 'a'.repeat(64), assessmentSourceRevision: { revisionId: '10000000-0000-4000-8000-000000000003', revision: 2, revisionSha256: '9'.repeat(64), relation: 'release_source' }, generatedAt: '2026-08-01T10:00:00.000Z', catalog: controlCatalog, coverage: { applicable: 1, satisfied: 1, open: 0, exceptions: 0, expired: 0 }, releaseReady: true, blockingReasons: [], controls: [{ definition: controlDefinition, applicable: true, assessment: null, effectiveStatus: 'satisfied', expired: false, releaseBlocking: false, issues: [] }], claimBoundary: controlCatalog.claimBoundary });
  api.getAuditReportCatalog.mockResolvedValue({ readiness: { enabled: true, signingConfigured: true, canonicalEventCount: 9, checkpointCount: 1, environments: ['production'], ready: true }, exportSecurity: { requiresFreshMfa: true, satisfied: true, maxAgeSeconds: 600, stepUpUrl: '/auth/oidc/step-up' }, definitions: [], runs: [{ id: '20000000-0000-4000-8000-000000000001', definitionId: null, environment: 'production', reportType: 'compliance', name: 'Release evidence', triggerType: 'manual', requestedBy: '1', status: 'completed', periodFrom: '2026-08-01T08:00:00.000Z', periodTo: '2026-08-01T10:00:00.000Z', filters: {}, checkpointId: '30000000-0000-4000-8000-000000000001', packId: '30000000-0000-4000-8000-000000000002', packDigest: 'b'.repeat(64), verificationState: 'valid', eventCount: 9, chainEntryCount: 9, gapCodes: [], summary: null, errorCode: null, errorMessage: null, startedAt: '2026-08-01T10:00:00.000Z', completedAt: '2026-08-01T10:01:00.000Z', createdAt: '2026-08-01T10:00:00.000Z', reviews: [] }] });
  api.getAiComplianceDossiers.mockResolvedValue({ schemaVersion: 1, kind: 'ai-compliance-dossier-list', dossiers: [{ sourceReportRunId: '20000000-0000-4000-8000-000000000001', verification: { state: 'valid', reasons: [], sourceEvidencePackState: 'valid' }, manifest: { schemaVersion: 1, kind: 'ai-compliance-dossier-manifest', dossierId: '40000000-0000-4000-8000-000000000001', dossierSha256: 'c'.repeat(64), generatedAt: '2026-08-01T10:02:00.000Z', generatedBy: { actorType: 'user', actorId: '1' }, assessmentStatus: 'controls_incomplete', aiSystem: { aiSystemId: '10000000-0000-4000-8000-000000000001', revisionId: '10000000-0000-4000-8000-000000000002', revision: 3, revisionSha256: 'a'.repeat(64), displayName: 'Claims copilot', classification: 'high_risk' }, scope: { workspaceId: 'default', tenantId: 'default', environments: ['production'], from: '2026-08-01T08:00:00.000Z', to: '2026-08-01T10:00:00.000Z' }, sourceEvidencePack: { evidencePackId: '30000000-0000-4000-8000-000000000002', sha256: 'b'.repeat(64), checkpointId: '30000000-0000-4000-8000-000000000001', verification: 'verified' }, controlCoverage: { applicable: 8, satisfied: 7, open: 1, exceptions: 0, expired: 0 }, sections: [], artifacts: [{ format: 'json', filename: 'evidence.json', mediaType: 'application/json', bytes: 512, sha256: 'd'.repeat(64) }, { format: 'pdf', filename: 'dossier.pdf', mediaType: 'application/pdf', bytes: 1024, sha256: 'e'.repeat(64) }, { format: 'signature', filename: 'checkpoint.sig', mediaType: 'application/octet-stream', bytes: 64, sha256: 'f'.repeat(64) }], externalAnchors: [], declaredGaps: [{ gapId: 'external-anchor-not-configured', severity: 'high', description: 'No customer-owned WORM object is attached.', ownerRole: 'provider', dueAt: null }], claimBoundary: 'This dossier is not an automatic legal certification.' } }] });
  api.generateAiComplianceDossier.mockResolvedValue({ dossier: {}, auditEventId: 'event-1' });
  api.createAiSystem.mockResolvedValue({ aiSystem: { revision: { aiSystemId: '12000000-0000-4000-8000-000000000001' } } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/governance/compliance" element={<CompliancePage />} />
          <Route path="/governance/compliance/runs/:runId" element={<CompliancePage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('CompliancePage', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows honest readiness, metrics and assessment history', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Compliance workspace' })).toBeInTheDocument();
    expect(screen.getByText('Evidence support, not a certification')).toBeInTheDocument();
    expect(screen.getByText('Checklist ready')).toBeInTheDocument();
    expect(screen.getByText('Checklist required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /NIS2/ })).toHaveAttribute('href', '/governance/compliance/runs/41');
  });

  it('starts a ready framework with a bounded audit scope', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Compliance workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'New assessment' }));
    fireEvent.change(screen.getByLabelText('Audit scope'), { target: { value: 'argus-production' } });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Start compliance assessment' })).getByRole('button', { name: /Start assessment/ }));
    await waitFor(() => expect(api.startComplianceRun).toHaveBeenCalledWith(2, 'argus-production'));
  });

  it('renders finding evidence, exports and exact-confirmation deletion', async () => {
    renderPage('/governance/compliance/runs/41');
    expect(await screen.findByRole('heading', { name: 'NIS2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Incident handling' })).toBeInTheDocument();
    expect(screen.getByText('Run a tabletop exercise.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PDF' })).toHaveAttribute('href', detail.exports?.pdf);
    fireEvent.click(screen.getByRole('button', { name: 'Delete run' }));
    const deleteButton = screen.getByRole('button', { name: 'Delete evidence' });
    expect(deleteButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Confirm compliance run deletion'), { target: { value: 'run-41' } });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(api.deleteComplianceRun).toHaveBeenCalledWith(41));
  });

  it('fails closed for non-admin users', async () => {
    renderPage('/governance/compliance', 'viewer');
    expect(await screen.findByText('Platform administrator access required.')).toBeInTheDocument();
  });

  it('shows verified release dossiers with explicit gaps and protected artifacts', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Compliance workspace' });
    fireEvent.click(screen.getByRole('button', { name: /AI dossiers/ }));
    expect(await screen.findByRole('heading', { name: 'Immutable compliance dossiers' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Download dossier manifest' })).toBeInTheDocument();
    expect(screen.getAllByText('Claims copilot').length).toBeGreaterThan(0);
    expect(screen.getByText('Integrity')).toBeInTheDocument();
    expect(screen.getByText('high / critical', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download dossier signature' })).toBeInTheDocument();
  });

  it('shows the governed AI-system registry and revision-bound control matrix', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Compliance workspace' });
    fireEvent.click(screen.getByRole('button', { name: /AI systems/ }));
    expect(await screen.findByRole('heading', { name: 'Govern the complete AI-system lifecycle' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Claims copilot' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '8/8 gates satisfied' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1/1 applicable controls satisfied' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Prohibited-practice screening' })).toBeInTheDocument();
    expect(screen.getByText('claims-agent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register AI system' })).toBeInTheDocument();
  });

  it('guides a user through immutable AI-system registration', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Compliance workspace' });
    fireEvent.click(screen.getByRole('button', { name: /AI systems/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Register AI system' }));
    const dialog = screen.getByRole('dialog', { name: 'Register AI system' });
    fireEvent.change(within(dialog).getByLabelText('AI-system name'), { target: { value: 'Service copilot' } });
    fireEvent.change(within(dialog).getByLabelText('Intended purpose'), { target: { value: 'Assist authenticated operators while preserving human decisions.' } });
    fireEvent.change(within(dialog).getByLabelText('Target users'), { target: { value: 'Operators' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Continue/ }));
    fireEvent.change(within(dialog).getByLabelText('Organisation ID'), { target: { value: 'argus' } });
    fireEvent.change(within(dialog).getByLabelText('Organisation name'), { target: { value: 'Argus GmbH' } });
    fireEvent.change(within(dialog).getByLabelText('Market role rationale'), { target: { value: 'Provides the configured AI system.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Continue/ }));
    fireEvent.change(within(dialog).getByLabelText('Prohibited-practice rationale'), { target: { value: 'Independent Article 5 review is required.' } });
    fireEvent.change(within(dialog).getByLabelText('Classification rationale'), { target: { value: 'Classification remains pending independent review.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Continue/ }));
    fireEvent.change(within(dialog).getByLabelText('Component 1 ID'), { target: { value: 'operator-agent' } });
    fireEvent.change(within(dialog).getByLabelText('Component 1 revision'), { target: { value: '7' } });
    fireEvent.change(within(dialog).getByLabelText('Component 1 SHA-256'), { target: { value: 'e'.repeat(64) } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register immutable draft' }));
    await waitFor(() => expect(api.createAiSystem).toHaveBeenCalledWith(expect.objectContaining({
      displayName: 'Service copilot',
      componentBindings: [expect.objectContaining({ resourceId: 'operator-agent', revision: '7', sha256: 'e'.repeat(64) })],
      controlCatalog: expect.objectContaining({ catalogSha256: 'd'.repeat(64) }),
    })));
  });
});
