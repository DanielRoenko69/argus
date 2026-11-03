import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SolutionPackWorkflowDefinition } from '../types';
import { SolutionPackPage } from './SolutionPackPage';

const api = vi.hoisted(() => ({
  getSolutionPacks: vi.fn(),
  getSolutionPackAgentCard: vi.fn(),
  getSolutionPackTask: vi.fn(),
  getSolutionPackTasks: vi.fn(),
  getFabricManagement: vi.fn(),
  getAiOpsReadiness: vi.fn(),
  getAiOpsServiceProfiles: vi.fn(),
  getAiOpsServiceProfileReadiness: vi.fn(),
  getNativeAlerts: vi.fn(),
  createAiOpsServiceProfile: vi.fn(),
  preflightAiOpsEvidenceQuery: vi.fn(),
  validateAiOpsServiceProfile: vi.fn(),
  activateAiOpsServiceProfile: vi.fn(),
  pauseAiOpsServiceProfile: vi.fn(),
  getKubernetesCertificationHistory: vi.fn(),
  importKubernetesCertification: vi.fn(),
  refreshSolutionPacks: vi.fn(),
  runSolutionPackPreflight: vi.fn(),
  startSolutionPackWorkflow: vi.fn(),
  startAiOpsServiceProfileInvestigation: vi.fn(),
}));
vi.mock('../api', () => api);

const workflow: SolutionPackWorkflowDefinition = {
  id: 'incident-investigation',
  graphId: 'incident_investigation',
  label: 'Incident investigation',
  description: 'Build an evidence-first investigation plan.',
  tags: ['aiops'],
  inputSchema: [
    { name: 'title', label: 'Incident title', type: 'text', required: true },
    { name: 'summary', label: 'Observed symptoms', type: 'textarea', required: true },
    { name: 'severity', label: 'Severity', type: 'select', required: true, defaultValue: 'warning', options: [{ value: 'warning', label: 'Warning' }, { value: 'critical', label: 'Critical' }] },
    { name: 'service', label: 'Affected service', type: 'text', required: true },
    { name: 'environment', label: 'Environment', type: 'text', required: true, defaultValue: 'production' },
    { name: 'correlation_window_minutes', label: 'Correlation window', type: 'number', required: true, defaultValue: 30 },
  ],
  stages: [
    { id: 'intake', label: 'Intake', hint: 'Normalize signal', kind: 'workspace' },
    { id: 'metrics', label: 'Metrics', hint: 'Golden signals', kind: 'knowledge' },
    { id: 'findings', label: 'Findings', hint: 'Read-only handoff', kind: 'delivery' },
  ],
  approvalGates: [],
  requiredAgents: ['researcher', 'knowledge', 'reviewer'],
  titleField: 'title',
  descriptionField: 'summary',
  requiredBundleCategories: ['metrics', 'runtime'],
  recommendedBundleCategories: ['logs', 'traces'],
  requiredExecutionTargetKinds: ['kubernetes'],
};

const activeProfile = {
  schemaVersion: 1,
  kind: 'aiops-service-profile',
  id: 41,
  status: 'active',
  activeRevision: { revision: 3, sha256: 'a'.repeat(64) },
  latestRevision: {
    revision: 3,
    sha256: 'a'.repeat(64),
    config: {
      schemaVersion: 1,
      service: { displayName: 'Checkout API', serviceName: 'checkout-api', environment: 'production' },
      ownership: { team: 'payments', criticality: 'high' },
      evidencePolicy: {
        lanes: [{ lane: 'logs', requirement: 'required', bundleId: 8, toolAllowlist: ['elastic_search'], queryTemplates: [] }],
        minimumCollectedLanes: 1, correlationWindowMinutes: 30, maxProviderResultBytes: 65536,
      },
      selectors: { otelServiceNames: ['checkout-api'], metricLabels: {}, logLabels: {}, traceOperations: [] },
      detection: { nativeAlertRuleIds: [], nativeSloIds: [], providerMonitorRefs: [], autoInvestigate: false, cooldownMinutes: 15 },
      context: { knowledgeSourceIds: [], runbookRefs: [], dependencyOverrides: [] },
      remediationPolicy: { mode: 'diagnose-only', allowedAdapterKeys: [], maxRiskWithoutApproval: 'none', requireApprovalInProduction: true, requireVerification: true, requireRollbackPlan: true },
    },
    createdAt: '2026-09-08T12:00:00.000Z',
    createdBy: { id: 1, username: 'alex' },
  },
  tags: [],
  allowedActions: ['read', 'investigate'],
  createdAt: '2026-09-08T12:00:00.000Z',
  updatedAt: '2026-09-08T12:00:00.000Z',
};

function renderPage(
  taskHistory: { tasks: unknown[]; nextCursor: string | null } = { tasks: [], nextCursor: null },
  certificationOverrides: Record<string, unknown> = {},
  initialEntry = '/solutions/argus.aiops',
  readinessOverrides: Record<string, unknown> = {},
  profileReadinessOverrides: Record<string, unknown> = {},
) {
  api.getSolutionPacks.mockResolvedValue({ total: 1, packs: [{
    configuredId: 'argus.aiops', endpoint: 'http://argus-aiops:2030', state: 'ready', checkedAt: new Date().toISOString(),
    health: { ok: true, status: 200, latencyMs: 3 }, readiness: { ok: true, status: 200, latencyMs: 4 },
    manifest: {
      apiVersion: 'argus.eu/v1alpha1', kind: 'SolutionPack',
      metadata: { id: 'argus.aiops', version: '0.1.0', displayName: 'Argus AIOps', description: 'Governed incident investigation.' },
      spec: {
        delivery: { type: 'container', protocol: 'argus-pack-v1alpha1', healthPath: '/healthz', readinessPath: '/readyz' },
        requires: { core: '>=1.0.0', capabilities: ['agent.invoke'], credentials: [] },
        components: { agents: [{ id: 'incident-orchestrator', runtime: 'a2a', skills: ['incident-investigation'], bundles: [], credentials: [], coreAgents: ['researcher'] }], skills: [], bundles: [], workflows: ['incident-investigation'], knowledgeSources: [], dashboards: [], policies: [] },
        readiness: { smokeTests: ['incident-orchestrator-a2a'] },
      },
    },
  }] });
  api.getSolutionPackAgentCard.mockResolvedValue({ agentCard: { name: 'Argus AIOps', version: '0.1.0', skills: [{ id: workflow.id, name: workflow.label, 'x-argus-workflow': workflow }] } });
  api.getAiOpsReadiness.mockResolvedValue({
    schemaVersion: 1,
    kind: 'aiops-readiness',
    state: 'setup_required',
    presentation: 'connector_setup',
    generatedAt: '2026-09-08T12:00:00.000Z',
    pack: { state: 'ready', version: '0.3.0' },
    eligibleBundleCount: 0,
    availableLanes: [],
    primaryConnection: null,
    profiles: { active: 0, ready: 0, degraded: 0, blocked: 0 },
    issues: [{ code: 'aiops_evidence_connection_required', severity: 'blocking', message: 'Connect evidence' }],
    recoveryActions: [],
    ...readinessOverrides,
  });
  api.getSolutionPackTasks.mockResolvedValue(taskHistory);
  api.getAiOpsServiceProfiles.mockResolvedValue({ schemaVersion: 1, kind: 'aiops-service-profile-list', profiles: [activeProfile] });
  api.getAiOpsServiceProfileReadiness.mockResolvedValue({
    schemaVersion: 1,
    kind: 'aiops-service-profile-readiness',
    profileId: 41,
    revision: 3,
    profileSha256: 'a'.repeat(64),
    state: 'ready',
    generatedAt: '2026-09-08T12:00:00.000Z',
    lanes: [{
      lane: 'logs', requirement: 'required', state: 'ready', bundleId: 8,
      bundleName: 'operations-readonly', providedCategories: ['logs'],
      toolNames: ['elastic_search'], issueCodes: [],
    }],
    runtime: { required: false, state: 'not_required', scope: null, certification: null },
    summary: { requiredLanes: 1, readyRequiredLanes: 1, optionalGaps: 0, blockingIssues: 0 },
    issues: [],
    recoveryActions: [],
    ...profileReadinessOverrides,
  });
  api.getNativeAlerts.mockResolvedValue({
    generatedAt: '2026-09-08T12:00:00.000Z',
    rules: [{
      id: 73, name: 'Checkout error rate', description: '', metric: 'error_rate', operator: 'gt', threshold: 0.05,
      windowMinutes: 5, minSamples: 10, severity: 'critical', scopeKind: 'all', scopeValue: null,
      cooldownMinutes: 30, notify: true, enabled: true, aiopsAutoInvestigate: false, aiopsBundleIds: [],
      aiopsResourceScope: null, aiopsService: null, aiopsEnvironment: null, lastState: 'ok', lastValue: null,
      lastSampleCount: 0, lastEvaluatedAt: null, lastTriggeredAt: null, createdAt: '2026-09-08T10:00:00.000Z',
      updatedAt: '2026-09-08T10:00:00.000Z', openIncidentId: null,
    }],
    incidents: [], templates: [], summary: { enabledRules: 1, firingRules: 0, incidents24h: 0, recovered24h: 0 },
  });
  const certification = { id: 9, backendId: 1, targetId: 'argus-aiops-kind', platform: 'kubernetes', profile: 'in-cluster-read-only', status: 'passed', contractSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), checkCount: 25, passedCount: 25, failedCount: 0, failedChecks: [], generatedAt: '2026-08-11T22:23:50.493Z', importedAt: '2026-08-11T22:24:00.000Z', importedBy: 'alex', freshness: 'fresh', ageHours: 3, expiresAt: '2026-08-18T22:23:50.493Z', ...certificationOverrides };
  const certificationPolicy = { warningAgeHours: 120, maxAgeHours: 168, enforceAIOps: true };
  api.getFabricManagement.mockResolvedValue({ generatedAt: new Date().toISOString(), bundles: [{ id: 8, name: 'operations-readonly', label: 'Operations read-only', description: '', icon: '', agentRole: null, systemPrompt: null, backendIds: [1], skillIds: [], workflowIds: [], workflowCount: 0, toolPolicies: [], backendCount: 1, toolCount: 8, capabilityCategories: ['metrics', 'runtime', 'logs'], capabilitySignals: [], compositeCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], backends: [{ id: 1, executionTargets: [{ kind: 'kubernetes', platform: 'kubernetes', backendId: 1, backendName: 'aiops-kubernetes', targetId: 'argus-aiops-kind', label: 'Local Kind cluster / argus-demo', targetLabel: 'Local Kind cluster', cluster: 'argus-aiops', namespace: 'argus-demo', environment: 'local-demo', bundleIds: [8] }] }], skills: [], tools: [
    { backendId: 1, name: 'elastic_search', description: 'Search Elasticsearch application logs', source: 'dynamic', enabled: true, isWrite: false, bundleIds: [8] },
    { backendId: 1, name: 'aiops_jaeger_find_traces', description: 'Find traces for a service', source: 'dynamic', enabled: true, isWrite: false, bundleIds: [8] },
    { backendId: 1, name: 'aiops_prometheus_query_range', description: 'Query metrics for a time range', source: 'dynamic', enabled: true, isWrite: false, bundleIds: [8] },
  ], kubernetesCertifications: [certification], kubernetesCertificationPolicy: certificationPolicy });
  api.getKubernetesCertificationHistory.mockResolvedValue({ history: [certification], policy: certificationPolicy });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter initialEntries={[initialEntry]}><QueryClientProvider client={client}><Routes><Route path="/solutions/:packId" element={<SolutionPackPage />} /></Routes></QueryClientProvider></MemoryRouter>);
}

describe('Argus AIOps solution page', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders the pack-owned workflow and opens a profile-backed incident form', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Argus AIOps', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Incident investigation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New investigation' }));
    expect(screen.getByRole('dialog', { name: 'Start Argus AIOps investigation' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Incident title/)).toBeInTheDocument();
    expect(screen.getByLabelText('AIOps service profile')).toHaveValue('41');
    expect(screen.getByText(/Revision 3/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Kubernetes target')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('keeps an active profile visible while showing its live fail-closed cause and recovery action', async () => {
    renderPage({ tasks: [], nextCursor: null }, {}, '/solutions/argus.aiops', {}, {
      state: 'blocked',
      lanes: [{
        lane: 'logs', requirement: 'required', state: 'blocked', bundleId: 8,
        bundleName: 'operations-readonly', providedCategories: ['logs'],
        toolNames: [], issueCodes: ['aiops_bundle_operationally_blocked'],
      }],
      summary: { requiredLanes: 1, readyRequiredLanes: 0, optionalGaps: 0, blockingIssues: 1 },
      issues: [{
        code: 'aiops_bundle_operationally_blocked', severity: 'blocking',
        message: 'Evidence connection is not currently trusted and reachable', lane: 'logs', bundleId: 8,
      }],
      recoveryActions: [{
        id: 'manage-connection-8', label: 'Manage evidence connection',
        kind: 'manage_connection', href: '/mcp-fabric#connections',
      }],
    });

    expect(await screen.findByText('Evidence connection is not currently trusted and reachable')).toBeInTheDocument();
    expect(screen.getByText('0/1 required lanes ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage evidence connection/ })).toHaveAttribute('href', '/mcp-fabric#connections');
    expect(api.getAiOpsServiceProfileReadiness).toHaveBeenCalledWith(41);
  });

  it('opens the immutable service-profile contract instead of hiding its evidence bindings', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'View profile' }));
    const dialog = screen.getByRole('dialog', { name: 'AIOps service profile Checkout API' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Operations read-only')).toBeInTheDocument();
    expect(screen.getByText('checkout-api · production')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('1 allowed tools · 0 queries');
    expect(screen.getByText('aaaaaaaaaaaaaaaa…')).toHaveAttribute('title', 'a'.repeat(64));
    fireEvent.click(screen.getByRole('button', { name: 'Close service profile detail' }));
    expect(dialog).not.toBeInTheDocument();
  });

  it('opens a native-alert handoff with prefilled scope and the certified target selected', async () => {
    const startedTask = { id: 'native-alert-task-81', status: { state: 'TASK_STATE_WORKING' } };
    api.startAiOpsServiceProfileInvestigation.mockResolvedValue({
      task: startedTask,
      rootTraceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    api.getSolutionPackTask.mockResolvedValue({ task: startedTask });
    const params = new URLSearchParams({
      launch: 'incident',
      source_incident_id: '81',
      title: 'Payment error rate',
      summary: '5xx responses exceeded the native alert threshold.',
      severity: 'critical',
      service: 'payment-worker',
      correlation_window_minutes: '45',
    });
    renderPage({ tasks: [], nextCursor: null }, {}, `/solutions/argus.aiops?${params.toString()}`);

    expect(await screen.findByRole('dialog', { name: 'Start Argus AIOps investigation' })).toBeInTheDocument();
    expect(screen.getByText('Prefilled from native alert #81')).toBeInTheDocument();
    expect(screen.getByLabelText(/Incident title/)).toHaveValue('Payment error rate');
    expect(screen.getByLabelText(/Observed symptoms/)).toHaveValue('5xx responses exceeded the native alert threshold.');
    expect(screen.getByLabelText(/Severity/)).toHaveValue('critical');
    expect(screen.queryByLabelText(/Affected service/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Correlation window/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('AIOps service profile')).toHaveValue('41');
    expect(screen.getByRole('link', { name: /Open source incident/ })).toHaveAttribute('href', '/observe/alerts?incident=81');
    expect(screen.getByRole('button', { name: 'Start profile-backed investigation' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start profile-backed investigation' }));
    await waitFor(() => expect(api.startAiOpsServiceProfileInvestigation).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ sourceIncidentId: 81, title: 'Payment error rate' }),
    ));
  });

  it('creates a service-specific evidence profile and immediately validates its immutable draft', async () => {
    const createdProfile = {
      schemaVersion: 1,
      kind: 'aiops-service-profile',
      id: 61,
      status: 'draft',
      activeRevision: null,
      latestRevision: {
        revision: 1,
        sha256: 'a'.repeat(64),
        config: {},
        createdAt: '2026-09-08T12:00:00.000Z',
        createdBy: { id: 1, username: 'alex' },
      },
      tags: [],
      allowedActions: ['read', 'validate', 'activate'],
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T12:00:00.000Z',
    };
    api.createAiOpsServiceProfile.mockResolvedValue({ schemaVersion: 1, profile: createdProfile });
    api.validateAiOpsServiceProfile.mockResolvedValue({
      schemaVersion: 1,
      readiness: {
        schemaVersion: 1,
        kind: 'aiops-service-profile-readiness',
        profileId: 61,
        revision: 1,
        profileSha256: 'a'.repeat(64),
        state: 'ready',
        generatedAt: '2026-09-08T12:00:00.000Z',
        lanes: [],
        runtime: { required: false, state: 'not_required', scope: null, certification: null },
        summary: { requiredLanes: 1, readyRequiredLanes: 1, optionalGaps: 0, blockingIssues: 0 },
        issues: [],
        recoveryActions: [],
      },
    });
    renderPage();

    const createButton = await screen.findByRole('button', { name: 'New service profile' });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);
    const dialog = screen.getByRole('dialog', { name: 'Create AIOps service profile' });
    expect(dialog).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Checkout API' } });
    fireEvent.change(screen.getByLabelText(/OTel service name/), { target: { value: 'checkout-api' } });
    fireEvent.change(screen.getByLabelText(/Owning team/), { target: { value: 'payments' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Runtime \/ Kubernetes/ }));
    fireEvent.change(screen.getByLabelText('Runtime execution target'), { target: { value: '1:argus-aiops-kind:argus-demo' } });
    fireEvent.change(screen.getByLabelText('Runtime allowed workloads'), { target: { value: 'Deployment/checkout-api\nJob/checkout-migrations' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Auto-investigate alerts/ }));
    fireEvent.change(screen.getByLabelText('Provider monitor references'), {
      target: { value: 'CheckoutLatencyHigh\nprometheus-alertmanager:CheckoutErrorRate' },
    });
    const alertRule = await screen.findByRole('checkbox', { name: /Checkout error rate/ });
    fireEvent.click(alertRule);
    fireEvent.click(screen.getByRole('button', { name: 'Create and validate draft' }));

    await waitFor(() => expect(api.createAiOpsServiceProfile).toHaveBeenCalledWith(expect.objectContaining({
      service: expect.objectContaining({ displayName: 'Checkout API', serviceName: 'checkout-api', environment: 'production' }),
      ownership: expect.objectContaining({ team: 'payments', criticality: 'medium' }),
      evidencePolicy: expect.objectContaining({
        lanes: expect.arrayContaining([
          expect.objectContaining({ lane: 'metrics', requirement: 'required', bundleId: 8 }),
          expect.objectContaining({ lane: 'runtime', requirement: 'optional', bundleId: 8 }),
        ]),
      }),
      selectors: expect.objectContaining({
        runtime: {
          kind: 'kubernetes', backendId: 1, targetId: 'argus-aiops-kind', cluster: 'argus-aiops', namespace: 'argus-demo',
          workloads: [{ kind: 'Deployment', name: 'checkout-api' }, { kind: 'Job', name: 'checkout-migrations' }],
        },
      }),
      remediationPolicy: expect.objectContaining({ mode: 'diagnose-only' }),
      detection: expect.objectContaining({
        autoInvestigate: true,
        nativeAlertRuleIds: [73],
        providerMonitorRefs: ['CheckoutLatencyHigh', 'prometheus-alertmanager:CheckoutErrorRate'],
      }),
    })));
    await waitFor(() => expect(api.validateAiOpsServiceProfile).toHaveBeenCalledWith(61, 1));
  });

  it('maps and safely preflights a service-specific Elasticsearch query', async () => {
    api.preflightAiOpsEvidenceQuery.mockResolvedValue({
      schemaVersion: 1,
      kind: 'aiops-evidence-query-preflight',
      lane: 'logs',
      bundleId: 8,
      queryId: 'service-log-search',
      toolName: 'elastic_search',
      generatedAt: '2026-09-08T12:00:00.000Z',
      state: 'succeeded',
      executed: true,
      request: { arguments: { index: 'logs-checkout-*', query_json: '{"query":{}}' } },
      response: { preview: '{"hits":{"total":{"value":7}}}', matchedDocuments: 7, durationMs: 18, resultBytes: 31, truncated: false },
    });
    renderPage();
    const createButton = await screen.findByRole('button', { name: 'New service profile' });
    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Checkout API' } });
    fireEvent.change(screen.getByLabelText(/OTel service name/), { target: { value: 'checkout-api' } });
    expect(screen.queryByRole('option', { name: 'aiops_jaeger_find_traces' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'aiops_prometheus_query_range' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Log source or index'), { target: { value: 'logs-checkout-*' } });
    fireEvent.change(screen.getByLabelText('Default signal keyword'), { target: { value: 'payment_failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test query' }));

    await waitFor(() => expect(api.preflightAiOpsEvidenceQuery).toHaveBeenCalledWith(expect.objectContaining({
      bundleId: 8,
      lane: 'logs',
      execute: true,
      query: expect.objectContaining({
        toolName: 'elastic_search',
        source: expect.objectContaining({ kind: 'elasticsearch', resource: 'logs-checkout-*' }),
        defaults: { signalKeyword: 'payment_failed' },
      }),
    })));
    expect(await screen.findByText('Query succeeded')).toBeInTheDocument();
    expect(screen.getByText(/7 matching documents/)).toBeInTheDocument();
  });

  it('shows honest platform readiness and opens the platform setup flow', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'One evidence contract, five platforms' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Kubernetes setup' })).toHaveClass('is-certified'));
    expect(screen.getByRole('button', { name: 'Open AKS setup' })).not.toHaveClass('is-connected');

    fireEvent.click(screen.getByRole('button', { name: 'Open OpenShift setup' }));
    const dialog = screen.getByRole('dialog', { name: 'OpenShift platform setup' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Dedicated OpenShift ServiceAccount')).toBeInTheDocument();
    expect(screen.getByText(/configure-openshift-service-account\.ps1/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open MCP Fabric/ })).toHaveAttribute('href', '/mcp-fabric');
  });

  it('collapses platform choices after one governed evidence bundle is connected', async () => {
    renderPage({ tasks: [], nextCursor: null }, {}, '/solutions/argus.aiops', {
      state: 'ready',
      presentation: 'connected_summary',
      eligibleBundleCount: 1,
      availableLanes: ['metrics', 'logs', 'traces'],
      primaryConnection: {
        bundleId: 8,
        bundleName: 'operations-readonly',
        lanes: ['metrics', 'logs', 'traces'],
        certifiedTargetCount: 0,
        checkedAt: '2026-09-08T12:00:00.000Z',
      },
      profiles: { active: 2, ready: 2, degraded: 0, blocked: 0 },
      issues: [],
    });

    expect(await screen.findByRole('heading', { name: 'Evidence connected' })).toBeInTheDocument();
    expect(screen.getByText('operations-readonly')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open AKS setup' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage evidence' })).toHaveAttribute('href', '/mcp-fabric');

    fireEvent.click(screen.getByRole('button', { name: 'Add environment' }));
    expect(await screen.findByRole('heading', { name: 'One evidence contract, five platforms' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open AKS setup' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to evidence summary' }));
    expect(await screen.findByRole('heading', { name: 'Evidence connected' })).toBeInTheDocument();
  });

  it('renders persisted certification evidence for a governed target', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'One evidence contract, five platforms' });
    fireEvent.click(screen.getByRole('button', { name: 'Open Kubernetes setup' }));
    expect(screen.getByRole('region', { name: 'Kubernetes certification evidence' })).toBeInTheDocument();
    expect(screen.getByText('25/25')).toBeInTheDocument();
    expect(screen.getByText('All certification checks passed')).toBeInTheDocument();
    expect(screen.getByText('External renewal available')).toBeInTheDocument();
    expect(screen.getByText(/Renewal window opens/)).toBeInTheDocument();
    expect(await screen.findByText('Certification history')).toBeInTheDocument();
    expect(screen.getByText(/Latest 1 immutable reports/)).toBeInTheDocument();
    expect(screen.getByLabelText('Import certification report')).toHaveAttribute('type', 'file');
  });

  it('delegates runtime and evidence readiness to the active profile boundary', async () => {
    renderPage({ tasks: [], nextCursor: null }, {
      freshness: 'stale',
      ageHours: 192,
      expiresAt: '2026-08-11T00:00:00.000Z',
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Kubernetes setup' })).toHaveClass('has-certification-stale'));
    fireEvent.click(screen.getByRole('button', { name: 'New investigation' }));
    fireEvent.change(screen.getByLabelText(/Incident title/), { target: { value: 'Checkout latency' } });
    fireEvent.change(screen.getByLabelText(/Observed symptoms/), { target: { value: 'p95 increased' } });
    expect(screen.getByRole('button', { name: 'Start profile-backed investigation' })).toBeEnabled();
    expect(screen.queryByText(/Evidence expired/)).not.toBeInTheDocument();
  });

  it('polls a working task and renders reviewed agent evidence', async () => {
    const plan = {
      kind: 'aiops-investigation-plan', implementationStage: 'agent-evidence', generatedAt: '2026-08-11T00:00:00.000Z',
      incident: { title: 'Checkout latency', summary: 'p95 increased', severity: 'warning', service: 'checkout', environment: 'production' },
      scope: { windowStart: '2026-08-10T23:30:00.000Z', windowEnd: '2026-08-11T00:00:00.000Z', selectedBundleIds: [8] },
      evidenceLanes: [{ id: 'metrics', purpose: 'Golden signals', questions: [], requiredCapabilities: ['metrics'] }],
      hypotheses: [], safety: { readOnly: true, rawTelemetryPersisted: false, writeActionsAllowed: false, notes: [] },
    };
    const workingTask = {
      id: 'task-1', status: { state: 'TASK_STATE_WORKING', message: { parts: [{ text: 'Collecting evidence.' }] } },
      artifacts: [{ parts: [{ data: plan }] }],
    };
    api.startAiOpsServiceProfileInvestigation.mockResolvedValue({ task: workingTask, rootTraceId: '50b47a6e-e8a0-4d64-866c-b36982de8fd5' });
    api.getSolutionPackTask.mockResolvedValue({ task: {
      ...workingTask,
      status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: 'Investigation completed.' }] } },
      artifacts: [...workingTask.artifacts, { parts: [{ data: {
        kind: 'aiops-investigation-evidence', generatedAt: '2026-08-11T00:01:00.000Z', quality: 'reviewed',
        agentEvidence: [{ role: 'reviewer', status: 'completed', durationMs: 1200, agentId: 3, model: 'runtime-model', sessionId: 'session-1', outputSummary: 'Latency is correlated with request volume.', error: null, toolCalls: [{ name: 'aiops_prometheus_query', args: { query: 'up' } }] }],
        signalCoverage: [
          { lane: 'metrics', status: 'collected', queryCount: 1, sources: ['Prometheus'], toolNames: ['aiops_prometheus_query'] },
          { lane: 'logs', status: 'collected', queryCount: 1, sources: ['Loki'], toolNames: ['aiops_loki_query_range'] },
          { lane: 'traces', status: 'collected', queryCount: 1, sources: ['Jaeger'], toolNames: ['aiops_jaeger_find_traces'] },
        ],
        timeline: [{ id: 'researcher-0-aiops_loki_query_range', timestamp: '2026-08-11T00:00:30.000Z', lane: 'logs', source: 'Loki', title: 'Loki logs evidence', summary: 'query={service="checkout"}', correlationKey: 'checkout' }],
        kubernetesEvidence: {
          namespace: 'argus-demo',
          resources: [
            { kind: 'Service', name: 'checkout-api', status: 'Active', labels: { app: 'checkout-api' }, provenance: { toolName: 'aiops_kubernetes_k8s_get_resources', spanId: 'bd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4b' } },
            { kind: 'Deployment', name: 'checkout-api', status: 'Available', labels: { app: 'checkout-api' }, provenance: { toolName: 'aiops_kubernetes_k8s_get_resources', spanId: 'cd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4c' } },
            { kind: 'Pod', name: 'checkout-api-abc12', status: 'Running', owner: 'Deployment/checkout-api', labels: { app: 'checkout-api' }, provenance: { toolName: 'aiops_kubernetes_k8s_get_resources', spanId: 'dd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4d' } },
          ],
          edges: [
            { from: 'Service/checkout-api', to: 'Deployment/checkout-api', relation: 'selects' },
            { from: 'Deployment/checkout-api', to: 'Pod/checkout-api-abc12', relation: 'owns' },
          ],
          events: [{ timestamp: '2026-08-11T00:00:40.000Z', type: 'Normal', reason: 'Pulled', object: 'Pod/checkout-api-abc12', message: 'Container image already present.', provenance: { toolName: 'aiops_kubernetes_k8s_get_events', spanId: 'ed7c7498-cdb5-4ac0-9cf5-9ecbe6601a4e' } }],
        },
        synthesis: 'The service is reachable; inspect saturation next.',
        safety: { mode: 'read-only', writesAllowed: false, rawTelemetryPersisted: false, redactionApplied: true },
      } }] }],
    } });

    renderPage();
    await screen.findByRole('heading', { name: 'Argus AIOps', level: 1 });
    await screen.findByRole('heading', { name: 'Incident investigation' });
    fireEvent.click(screen.getByRole('button', { name: 'New investigation' }));
    fireEvent.change(screen.getByLabelText(/Incident title/), { target: { value: 'Checkout latency' } });
    fireEvent.change(screen.getByLabelText(/Observed symptoms/), { target: { value: 'p95 increased' } });
    const startButton = screen.getByRole('button', { name: 'Start profile-backed investigation' });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);

    await waitFor(() => expect(api.startAiOpsServiceProfileInvestigation).toHaveBeenCalledWith(41, expect.objectContaining({
      title: 'Checkout latency', summary: 'p95 increased',
    })));

    expect(await screen.findByText('Reviewer synthesis')).toBeInTheDocument();
    expect(screen.getByText('aiops_prometheus_query')).toBeInTheDocument();
    expect(screen.getByText('The service is reachable; inspect saturation next.')).toBeInTheDocument();
    expect(screen.getByText('Correlated evidence timeline')).toBeInTheDocument();
    expect(screen.getByText('Loki logs evidence')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Kubernetes topology evidence' })).toBeInTheDocument();
    expect(screen.getByText('argus-demo')).toBeInTheDocument();
    expect(screen.getByText('Recent cluster events')).toBeInTheDocument();
    expect(screen.getByText(/Container image already present\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inspect Pod checkout-api-abc12 source span' })).toHaveAttribute(
      'href',
      '/runs/workflow/50b47a6e-e8a0-4d64-866c-b36982de8fd5?span=dd7c7498-cdb5-4ac0-9cf5-9ecbe6601a4d',
    );
    expect(screen.getByRole('link', { name: 'Inspect Pod/checkout-api-abc12 event source span' })).toHaveAttribute(
      'href',
      '/runs/workflow/50b47a6e-e8a0-4d64-866c-b36982de8fd5?span=ed7c7498-cdb5-4ac0-9cf5-9ecbe6601a4e',
    );
    expect(screen.getByText(/Read-only investigation/)).toBeInTheDocument();
    expect(screen.queryByText(/Write access declared/)).not.toBeInTheDocument();
  });

  it('lists persisted investigations and opens their evidence through a shareable task selection', async () => {
    const plan = {
      kind: 'aiops-investigation-plan', implementationStage: 'agent-evidence', generatedAt: '2026-08-11T00:00:00.000Z',
      incident: { title: 'Payments error rate', summary: '5xx increased', severity: 'critical', service: 'payments', environment: 'production' },
      scope: { windowStart: '2026-08-10T23:30:00.000Z', windowEnd: '2026-08-11T00:00:00.000Z', selectedBundleIds: [8] },
      evidenceLanes: [], hypotheses: [], safety: { readOnly: true, rawTelemetryPersisted: false, writeActionsAllowed: false, notes: [] },
    };
    const task = {
      id: 'task-history-1',
      status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ text: 'Investigation completed.' }] } },
      metadata: { rootTraceId: '50b47a6e-e8a0-4d64-866c-b36982de8fd5' },
      artifacts: [{ parts: [{ data: plan }] }],
    };
    api.getSolutionPackTask.mockResolvedValue({ task });

    renderPage({ tasks: [{ task, createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:01:00.000Z' }], nextCursor: null });

    expect(await screen.findByRole('button', { name: 'Open investigation Payments error rate' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open investigation Payments error rate' }));
    expect(await screen.findByText('INCIDENT EVIDENCE')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Core trace/ })).toHaveAttribute('href', '/runs/workflow/50b47a6e-e8a0-4d64-866c-b36982de8fd5');
    expect(api.getSolutionPackTask).toHaveBeenCalledWith('argus.aiops', 'incident-orchestrator', 'task-history-1');
  });
});
