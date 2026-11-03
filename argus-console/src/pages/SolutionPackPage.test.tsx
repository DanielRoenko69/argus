import { writeFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexRuntimeStatus, SolutionPackWorkflowDefinition, SolutionPacksResponse } from '../types';
import { governedRetryInput, initialWorkflowBundleIds, SolutionPackPage } from './SolutionPackPage';

const api = vi.hoisted(() => ({
  getSolutionPacks: vi.fn(),
  getOverview: vi.fn(),
  getArgusDevRuns: vi.fn(),
  getCodingThread: vi.fn(),
  getCodingApprovalRecovery: vi.fn(),
  recoverCodingApproval: vi.fn(),
  getCodingCheckpoints: vi.fn(),
  getFabricManagement: vi.fn(),
  getRunDetail: vi.fn(),
  getSolutionPackAgentCard: vi.fn(),
  getSolutionPackDiff: vi.fn(),
  getSolutionPackRollbackRequests: vi.fn(),
  getSolutionPackTask: vi.fn(),
  refreshSolutionPacks: vi.fn(),
  runSolutionPackPreflight: vi.fn(),
  startSolutionPackWorkflow: vi.fn(),
  cancelSolutionPackTask: vi.fn(),
  getCodexRuntimeStatus: vi.fn(),
  getClaudeRuntimeStatus: vi.fn(),
  cancelCodexRuntimeRun: vi.fn(),
  cancelClaudeRuntimeRun: vi.fn(),
  retryCodingWorkflow: vi.fn(),
  resumeCodingWorkflow: vi.fn(),
  submitCodingRequirements: vi.fn(),
  recheckCodingQaResponse: vi.fn(),
  continueCodingQaResponse: vi.fn(),
  previewCodingQaRetry: vi.fn(),
  retryCodingQa: vi.fn(),
  loadCodingIssue: vi.fn(),
  getAdminUsers: vi.fn(),
  getHermesDevConnections: vi.fn(),
  getHermesManagedMemoryProposals: vi.fn(),
  getHermesManagedRuntime: vi.fn(),
  getHermesManagedRuns: vi.fn(),
  getHermesManagedRun: vi.fn(),
  getHermesManagedRunEvents: vi.fn(),
  preflightHermesManagedRuntime: vi.fn(),
  startHermesManagedRun: vi.fn(),
  cancelHermesManagedRun: vi.fn(),
  decideHermesManagedMemoryProposal: vi.fn(),
  createHermesDevConnection: vi.fn(),
  testHermesDevConnection: vi.fn(),
  rotateHermesDevConnection: vi.fn(),
  revokeHermesDevConnection: vi.fn(),
}));
vi.mock('../api', () => api);

const workflows: SolutionPackWorkflowDefinition[] = [
  {
    id: 'ticket-to-pull-request', graphId: 'coding_workflow', label: 'Ticket to pull request',
    description: 'Turn a scoped ticket into tested, reviewed and human-approved delivery evidence.',
    tags: ['ticket', 'implementation'],
    inputSchema: [
      { name: 'ticket_id', label: 'Ticket ID', type: 'text', required: true, placeholder: 'ARGUS-123' },
      { name: 'description', label: 'Implementation brief', type: 'textarea', required: true },
    ],
    stages: [
      { id: 'setup_workspace', label: 'Workspace', hint: 'Clone & reset', kind: 'workspace' },
      { id: 'planner', label: 'Plan', hint: 'Planner agent', kind: 'plan' },
      { id: 'coder', label: 'Implement', hint: 'Coder workspace write', kind: 'code' },
      { id: 'tests', label: 'Tests', hint: 'Fixture & suite', kind: 'test' },
      { id: 'human_approval_pr', label: 'Approval', hint: 'Functional gate', kind: 'approval' },
      { id: 'finalize_pr', label: 'Pull request', hint: 'Final artifact', kind: 'delivery' },
    ],
    approvalGates: ['code_approval', 'functional_approval'], requiredAgents: ['planner', 'coder'],
    titleField: 'ticket_id', descriptionField: 'description',
    requiredBundleCategories: ['repository', 'repository-checkout', 'ci'], recommendedBundleCategories: ['rag'],
  },
  {
    id: 'pull-request-review', graphId: 'pull_request_review', label: 'Pull request review',
    description: 'Inspect an existing pull request and create an approved release handoff.',
    tags: ['pull-request', 'review'],
    inputSchema: [
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'pull_request_number', label: 'Pull request number', type: 'number', required: true, min: 1 },
      { name: 'review_goal', label: 'Review goal', type: 'textarea', required: true },
      { name: 'next_action', label: 'Approved continuation', type: 'select', required: true, defaultValue: 'release_handoff', options: [{ value: 'release_handoff', label: 'Create release handoff' }, { value: 'approval_evidence', label: 'Record approval evidence only' }] },
    ],
    stages: [
      { id: 'inspect_pull_request', label: 'Inspect PR', hint: 'Diff & metadata', kind: 'workspace' },
      { id: 'fix_pull_request', label: 'Fix', hint: 'Coder workspace write', kind: 'code' },
      { id: 'run_tests', label: 'Tests', hint: 'Scoped validation', kind: 'test' },
      { id: 'review_pull_request', label: 'Review', hint: 'Risk & quality', kind: 'review' },
      { id: 'human_approval', label: 'Approval', hint: 'Continuation gate', kind: 'approval' },
      { id: 'release_handoff', label: 'Handoff', hint: 'Release evidence', kind: 'delivery' },
    ],
    approvalGates: ['pr_review_approval'], requiredAgents: ['researcher', 'coder', 'reviewer'],
    titleField: 'pull_request_number', titlePrefix: 'PR #', descriptionField: 'review_goal',
    requiredBundleCategories: ['repository'],
  },
  {
    id: 'backlog-grooming', graphId: 'backlog_grooming', label: 'Backlog Planning',
    description: 'Read-only issue planning', tags: ['planning'],
    inputSchema: [{ name: 'backlog_id', label: 'Backlog ID', type: 'text', required: true }],
    stages: [
      { id: 'decompose_backlog', label: 'Plan', hint: 'Vertical tasks', kind: 'plan' },
      { id: 'review_backlog', label: 'Review', hint: 'Quality gate', kind: 'review' },
      { id: 'backlog_approval', label: 'Approval', hint: 'Handoff gate', kind: 'approval' },
    ],
    approvalGates: ['backlog_approval'], requiredAgents: ['planner', 'reviewer'],
    titleField: 'backlog_id', descriptionField: 'issue_body', reviewPolicy: { maxAttempts: 2 },
  },
];

const catalog: SolutionPacksResponse = {
  total: 1,
  packs: [{
    configuredId: 'argus.dev',
    endpoint: 'http://argus-dev:8080',
    state: 'ready',
    checkedAt: '2026-08-02T12:00:00.000Z',
    health: { ok: true, status: 200, latencyMs: 4 },
    readiness: { ok: true, status: 200, latencyMs: 8 },
    manifest: {
      apiVersion: 'argus.eu/v1alpha1',
      kind: 'SolutionPack',
      metadata: { id: 'argus.dev', version: '0.4.0', displayName: 'Argus Dev', description: 'Governed coding workflows.' },
      spec: {
        delivery: { type: 'container', protocol: 'argus-pack-v1alpha1', healthPath: '/healthz', readinessPath: '/readyz' },
        requires: { core: '>=1.0.0', capabilities: ['agent.invoke'], credentials: [] },
        components: {
          agents: [{ id: 'coding-orchestrator', runtime: 'a2a', skills: ['implementation'], bundles: ['dev-workspace'], credentials: [], coreAgents: ['planner', 'coder'] }],
          skills: ['implementation'], bundles: ['dev-workspace'], workflows: ['ticket-to-pull-request', 'pull-request-review'], knowledgeSources: ['engineering-standards'], dashboards: ['development-overview'], policies: ['governed-repository-write'],
        },
        readiness: { smokeTests: ['coding-orchestrator-a2a'] },
      },
    },
  }],
};

const connectedHermesPack: SolutionPacksResponse['packs'][number] = {
  configuredId: 'argus.hermes',
  endpoint: 'http://argus-hermes:2040',
  state: 'ready',
  checkedAt: '2026-08-05T12:00:00.000Z',
  health: { ok: true, status: 200, latencyMs: 3 },
  readiness: { ok: true, status: 200, latencyMs: 6 },
  manifest: {
    apiVersion: 'argus.eu/v1alpha1',
    kind: 'SolutionPack',
    metadata: { id: 'argus.hermes', version: '0.1.0', displayName: 'Argus Hermes', description: 'Governed Hermes runtime bridge.' },
    spec: {
      delivery: { type: 'container', protocol: 'argus-pack-v1alpha1', healthPath: '/healthz', readinessPath: '/readyz' },
      requires: { core: '>=1.0.0', capabilities: ['runtime.execute'], credentials: [] },
      components: {
        agents: [],
        runtimeAdapters: [{
          id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime/v1',
          modes: ['attached', 'managed'], capabilities: ['health', 'runs'],
        }],
        skills: [], bundles: [], workflows: [], knowledgeSources: [], dashboards: [], policies: [],
      },
      readiness: { smokeTests: ['runtime-capability-handshake'] },
    },
  },
};

function renderPage(threads: unknown[] = [], runtimeStatus: CodexRuntimeStatus = { enabled: true, authenticated: true, authMethod: 'chatgpt', activeRuns: 0, recentRuns: 0, maxConcurrentRuns: 1, runs: [] }, bundleCategories: string[] = ['repository', 'repository-checkout', 'ci'], packCatalog: SolutionPacksResponse = catalog, role = 'platform_admin') {
  api.getOverview.mockResolvedValue({ user: { id: 7, username: 'alex', displayName: 'Alex', role } });
  api.getSolutionPacks.mockResolvedValue(packCatalog);
  api.getArgusDevRuns.mockResolvedValue({ threads });
  api.getCodingCheckpoints.mockResolvedValue({ threadId: 'thread-history-1', parentThreadId: null,
    checkpoints: [{ checkpointId: 'checkpoint-123456789', parentCheckpointId: 'parent-checkpoint-987654321', createdAt: '2026-08-02T12:00:00.000Z',
      step: 1, nodes: ['planner'], next: ['knowledge'], interrupted: false }] });
  api.getCodingApprovalRecovery.mockResolvedValue({ available: false });
  api.recoverCodingApproval.mockResolvedValue({ ok: true, recovered: true });
  api.getCodexRuntimeStatus.mockResolvedValue(runtimeStatus);
  api.getClaudeRuntimeStatus.mockResolvedValue(runtimeStatus);
  api.cancelCodexRuntimeRun.mockResolvedValue({ ok: true });
  api.cancelClaudeRuntimeRun.mockResolvedValue({ ok: true });
  api.getSolutionPackAgentCard.mockResolvedValue({
    agentCard: {
      name: 'Argus Dev', version: '0.4.0',
      skills: workflows.map(workflow => ({ id: workflow.id, name: workflow.label, 'x-argus-workflow': workflow })),
    },
  });
  api.getFabricManagement.mockResolvedValue({
    generatedAt: '2026-08-02T12:00:00.000Z',
    bundles: [
      { id: 7, name: 'dev-workspace', label: 'Development workspace', description: '', icon: '', agentRole: null, systemPrompt: null, backendIds: [1], skillIds: [], workflowIds: [], workflowCount: 0, toolPolicies: [], backendCount: 1, toolCount: 12, capabilityCategories: bundleCategories, capabilitySignals: { repository: ['gitea'], ci: ['gitea actions'] }, compositeCount: 0, createdAt: '2026-08-02T12:00:00.000Z', updatedAt: '2026-08-02T12:00:00.000Z' },
      { id: 9, name: 'code-intelligence-read', label: 'Code intelligence read-only', description: '', icon: '', agentRole: null, systemPrompt: null, backendIds: [2], skillIds: [], workflowIds: [], workflowCount: 0, toolPolicies: [], backendCount: 1, toolCount: 2, capabilityCategories: [], capabilitySignals: {}, compositeCount: 0, createdAt: '2026-08-02T12:00:00.000Z', updatedAt: '2026-08-02T12:00:00.000Z' },
    ],
    backends: [], skills: [], tools: [],
  });
  api.getSolutionPackDiff.mockResolvedValue({ revision: 1, previousVersion: null, currentVersion: '0.4.0', rollbackAvailable: false, changes: [], state: 'ready' });
  api.getSolutionPackRollbackRequests.mockResolvedValue({ packId: 'argus.dev', total: 0, requests: [] });
  api.getAdminUsers.mockResolvedValue([]);
  api.getHermesDevConnections.mockResolvedValue({
    identity: { id: 7, username: 'entra:subject-7', displayName: 'Alex', role: 'platform_admin', authentication: 'sso' },
    connections: [],
    bundles: [{ id: 3, name: 'repository', label: 'Repository', toolCount: 5 }],
  });
  api.getHermesManagedRuntime.mockResolvedValue({
    identity: { id: 7, displayName: 'Alex', role, authentication: 'sso' },
    pack: { connected: true, version: '0.1.0' },
    adapter: { id: 'hermes-http', state: 'ready', modes: [{ mode: 'managed', state: 'ready', detail: 'Managed runner ready' }], capabilities: ['runs', 'mcp-fabric'] },
    managed: { ready: true, detail: 'Managed runner ready', approvedBundleIds: [9], agents: [{ id: 5, name: 'coder', label: 'Coder' }] },
    limits: { deadlineSeconds: { default: 600, min: 30, max: 900 }, maxToolCalls: { default: 64, min: 1, max: 1_000 } },
  });
  api.getHermesManagedRuns.mockResolvedValue({ runs: [] });
  api.getHermesManagedMemoryProposals.mockResolvedValue({ proposals: [] });
  api.decideHermesManagedMemoryProposal.mockResolvedValue({ id: 'unused', status: 'accepted' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter initialEntries={['/solutions/argus.dev']}><QueryClientProvider client={client}><Routes><Route path="/solutions/:packId" element={<SolutionPackPage />} /></Routes></QueryClientProvider></MemoryRouter>);
  return client;
}

describe('SolutionPackPage', () => {
  let dateNow: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dateNow = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-08-05T12:00:00.000Z').getTime());
    api.runSolutionPackPreflight.mockResolvedValue({
      rootTraceId: '12345678-1234-1234-1234-123456789abc',
      task: {
        id: 'preflight-task',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ parts: [{ data: { ready: true, engine: 'langgraph', toolTransport: 'MCP' } }] }],
      },
    });
  });
  afterEach(() => {
    dateNow.mockRestore();
    vi.clearAllMocks();
  });

  it('shows only active Codex runtime sessions while persisted runs stay in the normal run views', async () => {
    renderPage([], {
      enabled: true,
      authenticated: true,
      authMethod: 'chatgpt',
      activeRuns: 1,
      recentRuns: 1,
      maxConcurrentRuns: 1,
      runs: [{
        id: 'smoke-visible-123', telemetryTraceId: '12345678-1234-4234-8234-123456789abc', state: 'running', startedAt: '2026-08-04T12:00:00.000Z', updatedAt: '2026-08-04T12:00:05.000Z', cwd: '/workspace/ARGUS-REAL-002', model: null, reasoningEffort: 'low', timeoutSec: 45, threadId: null, rootTraceId: '12345678-1234-4234-8234-123456789abc', agentId: 1, taskType: 'smoke_test',
      }],
    });
    expect(await screen.findByRole('heading', { name: 'Active Codex runtime sessions' })).toBeVisible();
    expect(screen.getAllByText('smoke_test').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Logs' }).some(link => link.getAttribute('href') === '/observe/logs?trace=12345678-1234-4234-8234-123456789abc')).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Run' }).some(link => link.getAttribute('href') === '/runs/agent/12345678-1234-4234-8234-123456789abc')).toBe(true);
  });

  it('does not duplicate persisted Codex sessions in the live runtime panel', async () => {
    renderPage([], {
      enabled: true,
      authenticated: true,
      authMethod: 'chatgpt',
      activeRuns: 0,
      recentRuns: 1,
      maxConcurrentRuns: 1,
      runs: [{
        id: 'smoke-persisted-123', telemetryTraceId: '12345678-1234-4234-8234-123456789abc', state: 'canceled', startedAt: '2026-08-04T12:00:00.000Z', updatedAt: '2026-08-04T12:00:05.000Z', finishedAt: '2026-08-04T12:00:05.000Z', cwd: '/workspace/ARGUS-REAL-002', model: null, reasoningEffort: 'low', timeoutSec: 45, threadId: null, rootTraceId: '12345678-1234-4234-8234-123456789abc', agentId: 1, taskType: 'smoke_test', cancelReason: 'operator', errorCode: 'runtime_canceled', error: 'Codex run canceled by operator',
      }],
    });
    expect(await screen.findByRole('heading', { name: 'Development runs' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Active Codex runtime sessions' })).not.toBeInTheDocument();
    expect(screen.getByText('API EXECUTION')).toBeVisible();
    expect(screen.getByText('smoke_test')).toBeVisible();
    expect(screen.getByRole('link', { name: /smoke_test/ })).toHaveAttribute('href', '/runs/agent/12345678-1234-4234-8234-123456789abc');
  });

  it('hides only active plan rows in both runtime panels without canceling or changing their counts', async () => {
    const base = {
      startedAt: '2026-08-04T12:00:00.000Z', updatedAt: '2026-08-04T12:00:05.000Z',
      cwd: '/workspace/DEMO', model: null, reasoningEffort: null, timeoutSec: 900,
      threadId: null, rootTraceId: null, agentId: 1,
    };
    renderPage([], {
      enabled: true, authenticated: true, authMethod: 'chatgpt', activeRuns: 4, maxConcurrentRuns: 8,
      runs: [
        { ...base, id: 'plan-starting', taskType: 'plan', state: 'starting' },
        { ...base, id: 'plan-running', taskType: 'plan', state: 'running' },
        { ...base, id: 'implement-visible', taskType: 'implement_ticket', state: 'running' },
        { ...base, id: 'unknown-visible', taskType: null, state: 'running' },
        { ...base, id: 'plan-completed', taskType: 'plan', state: 'completed', telemetryTraceId: 'completed-plan-trace' },
      ],
    });
    for (const name of ['Codex runtime sessions', 'Claude Code runtime sessions']) {
      const panel = within(await screen.findByRole('region', { name }));
      expect(panel.queryByText('plan')).not.toBeInTheDocument();
      expect(panel.getByText('implement_ticket')).toBeVisible();
      expect(panel.getByText('4/8 active')).toBeVisible();
      expect(panel.getAllByRole('button', { name: 'Stop' })).toHaveLength(2);
      expect(panel.getByText(/Plan sessions are hidden here/)).toBeVisible();
    }
    // Historical evidence stays available; rendering must never issue cancellation.
    expect(screen.getByRole('link', { name: /plan/ })).toHaveAttribute('href', '/runs/agent/completed-plan-trace');
    expect(api.cancelCodexRuntimeRun).not.toHaveBeenCalled();
    expect(api.cancelClaudeRuntimeRun).not.toHaveBeenCalled();
    expect(api.cancelSolutionPackTask).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('region', { name: 'Codex runtime sessions' })).getAllByRole('button', { name: 'Stop' })[0]);
    await waitFor(() => expect(api.cancelCodexRuntimeRun.mock.calls.map(([id]) => id)).toEqual(['implement-visible']));
    expect(api.cancelClaudeRuntimeRun).not.toHaveBeenCalled();
  });

  it('does not render empty runtime panels when all active sessions are plans', async () => {
    renderPage([], {
      enabled: true, authenticated: true, authMethod: 'chatgpt', activeRuns: 1, maxConcurrentRuns: 2,
      runs: [{ id: 'plan-only', taskType: 'plan', state: 'running', startedAt: '2026-08-04T12:00:00.000Z',
        updatedAt: '2026-08-04T12:00:00.000Z', cwd: '/workspace/DEMO', model: null, reasoningEffort: null,
        timeoutSec: 900, threadId: null, rootTraceId: null, agentId: 1 }],
    });
    expect(await screen.findByRole('heading', { name: 'Development runs' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Codex runtime sessions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Claude Code runtime sessions' })).not.toBeInTheDocument();
    expect(api.cancelCodexRuntimeRun).not.toHaveBeenCalled();
    expect(api.cancelClaudeRuntimeRun).not.toHaveBeenCalled();
  });

  it('renders Argus Dev inside Core with its real workflow stages and components', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Argus Dev', level: 1 })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Ticket to pull request' })).toBeVisible();
    expect(screen.getByText('Planner agent')).toBeVisible();
    expect(screen.getByText('Functional gate')).toBeVisible();
    expect(screen.getByText('coding-orchestrator')).toBeVisible();
  });

  it('hides the Hermes Connector until a ready Argus Hermes runtime Pack is discovered', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Argus Dev', level: 1 })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Hermes runtime workbench' })).not.toBeInTheDocument();
    expect(api.getHermesDevConnections).not.toHaveBeenCalled();
  });

  it('shows the Hermes Connector when the discovered Argus Hermes Pack declares a Hermes adapter', async () => {
    renderPage([], undefined, undefined, {
      total: 2,
      packs: [...catalog.packs, connectedHermesPack],
    });

    expect(await screen.findByRole('region', { name: 'Hermes runtime workbench' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Choose how Hermes works with Argus Dev' })).toBeVisible();
    await waitFor(() => expect(api.getHermesManagedRuntime).toHaveBeenCalledTimes(1));
  });

  it('does not invoke or expose Pack administration controls for a developer SSO session', async () => {
    renderPage([], undefined, undefined, catalog, 'developer');

    expect(await screen.findByRole('heading', { name: 'Argus Dev', level: 1 })).toBeVisible();
    await waitFor(() => expect(api.getOverview).toHaveBeenCalled());
    expect(api.getSolutionPackDiff).not.toHaveBeenCalled();
    expect(api.getSolutionPackRollbackRequests).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('does not poll the legacy coding API while the Argus Dev pack is offline', async () => {
    renderPage([], undefined, undefined, {
      total: 1,
      packs: [{
        configuredId: 'argus.dev',
        endpoint: 'http://argus-dev:2025',
        state: 'unreachable',
        checkedAt: '2026-08-05T12:00:00.000Z',
        error: 'fetch failed',
      }],
    });

    expect(await screen.findByText('Argus Dev runtime is offline')).toBeVisible();
    expect(screen.getAllByText('fetch failed')).not.toHaveLength(0);
    expect(api.getArgusDevRuns).not.toHaveBeenCalled();
  });

  it('does not route an unknown Solution Pack to Argus Dev', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<MemoryRouter initialEntries={['/solutions/argus.unknown']}><QueryClientProvider client={client}><Routes><Route path="/solutions/:packId" element={<SolutionPackPage />} /></Routes></QueryClientProvider></MemoryRouter>);

    expect(screen.getByText('Unknown Solution Pack')).toBeVisible();
    expect(api.getSolutionPacks).not.toHaveBeenCalled();
  });

  it('runs the authenticated A2A preflight from the module UI', async () => {
    api.runSolutionPackPreflight.mockResolvedValue({ rootTraceId: '12345678-1234-1234-1234-123456789abc', task: { id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ data: { engine: 'langgraph', toolTransport: 'MCP' } }] }, { name: 'Argus Core bundle capability preflight', parts: [{ data: { kind: 'bundle-capability-preflight', ok: true, missing: [] } }] }] } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Run A2A preflight' }));
    expect(await screen.findByText('completed')).toBeVisible();
    expect(await screen.findByText('Bundles: capabilities ready')).toBeVisible();
    expect(api.runSolutionPackPreflight).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', {
      workflowId: 'ticket-to-pull-request',
      bundleIds: [7],
    });
  });

  it('starts a bundle-scoped coding task and renders live A2A evidence', async () => {
    const response = {
      rootTraceId: '12345678-1234-1234-1234-123456789abc',
      task: {
        id: 'task-1',
        status: { state: 'TASK_STATE_WORKING' },
        metadata: { workflowThreadId: 'thread-1' },
        artifacts: [{ parts: [{ data: { currentStage: 'tests', plan: 'Implement the requested change.', testsPassed: false, testOutput: 'Running tests…' } }] }],
      },
    };
    api.startSolutionPackWorkflow.mockResolvedValue(response);
    api.getSolutionPackTask.mockResolvedValue({ task: response.task });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    expect(screen.getByRole('dialog', { name: 'Start Argus Dev run' })).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'ARGUS-42' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Add a governed development workflow.' } });
    await waitFor(() => expect(screen.getByLabelText(/Development workspace/)).toBeChecked());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start Ticket to pull request' }));

    expect(await screen.findByRole('heading', { name: 'Agents, tests & approvals' })).toBeVisible();
    expect(screen.getAllByText('Plan').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Tests').length).toBeGreaterThan(0);
    expect(screen.getByText('Implement the requested change.')).toBeInTheDocument();
    expect(screen.getByText('Running tests…')).toBeInTheDocument();
    expect(screen.queryByText('The planner has not published its plan yet.')).not.toBeInTheDocument();
    expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', {
      workflowId: 'ticket-to-pull-request',
      input: {
        ticket_id: 'ARGUS-42',
        description: 'Add a governed development workflow.',
      },
      bundleIds: [7],
      runtimeMode: 'auto',
    });
    expect(api.runSolutionPackPreflight).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', {
      workflowId: 'ticket-to-pull-request',
      bundleIds: [7],
      runtimeMode: 'auto',
    });
  });

  it('binds Managed Hermes to one development run without changing the Agent default', async () => {
    const response = {
      rootTraceId: '12345678-1234-1234-1234-123456789abc',
      task: {
        id: 'task-hermes',
        status: { state: 'TASK_STATE_WORKING' },
        metadata: {
          workflowThreadId: 'thread-hermes',
          executionRuntimeOverrides: [{ runtimeProfileName: 'hermes-managed-dev' }],
        },
      },
    };
    api.startSolutionPackWorkflow.mockResolvedValue(response);
    api.getSolutionPackTask.mockResolvedValue({ task: response.task });
    renderPage([], undefined, undefined, { total: 2, packs: [...catalog.packs, connectedHermesPack] });

    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'ARGUS-HERMES-1' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Use one isolated Hermes coder turn.' } });
    await waitFor(() => expect(screen.getByLabelText(/Development workspace/)).toBeChecked());
    const managed = await screen.findByRole('radio', { name: /^Managed Hermes/ });
    await waitFor(() => expect(managed).toBeEnabled());
    fireEvent.click(managed);
    await waitFor(() => expect(screen.getByLabelText(/Code intelligence read-only/)).toBeChecked());
    expect(screen.getByText('Hermes read-only scope added automatically: Code intelligence read-only.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start Ticket to pull request' }));

    await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith(
      'argus.dev',
      'coding-orchestrator',
      expect.objectContaining({ runtimeMode: 'managed-hermes', bundleIds: [7, 9] }),
    ));
    expect(await screen.findByText('hermes-managed-dev')).toBeVisible();
  });

  it('defaults to Auto and adds the governed Hermes scope for a Coder workflow', async () => {
    api.runSolutionPackPreflight.mockResolvedValue({
      rootTraceId: '87654321-4321-4321-4321-cba987654321',
      task: {
        id: 'managed-auto-preflight', status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ parts: [{ data: {
          ready: true,
          coreRuntimeSelection: {
            source: 'argus.core', kind: 'runtime-selection', requestedMode: 'auto', effectiveMode: 'managed-hermes',
            reason: 'workflow_requires_coder_workspace_write', workflowId: 'ticket-to-pull-request',
          },
        } }] }],
      },
    });
    const response = {
      rootTraceId: '12345678-1234-1234-1234-123456789abc',
      task: {
        id: 'task-auto', status: { state: 'TASK_STATE_WORKING' }, metadata: { workflowThreadId: 'thread-auto' },
        history: [{ parts: [{ data: { coreRuntimeSelection: {
          source: 'argus.core', kind: 'runtime-selection', requestedMode: 'auto', effectiveMode: 'managed-hermes',
          reason: 'workflow_requires_coder_workspace_write', workflowId: 'ticket-to-pull-request',
        } } }] }],
      },
    };
    api.startSolutionPackWorkflow.mockResolvedValue(response);
    api.getSolutionPackTask.mockResolvedValue({ task: response.task });
    renderPage([], undefined, undefined, { total: 2, packs: [...catalog.packs, connectedHermesPack] });

    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    const automatic = screen.getByRole('radio', { name: /Auto/ });
    expect(automatic).toBeChecked();
    const launchRouting = await screen.findByLabelText('Core launch runtime routing');
    await waitFor(() => expect(launchRouting).toHaveTextContent('Auto'));
    expect(launchRouting).toHaveTextContent('Managed Hermes');
    expect(launchRouting).toHaveTextContent('Core routed the Coder workspace-write stage to Managed Hermes.');
    await waitFor(() => expect(screen.getByLabelText(/Code intelligence read-only/)).toBeChecked());
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'ARGUS-AUTO-1' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Route the Coder automatically.' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start Ticket to pull request' }));

    await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith(
      'argus.dev', 'coding-orchestrator',
      expect.objectContaining({ runtimeMode: 'auto', bundleIds: [7, 9] }),
    ));
    const routingDecision = await screen.findByLabelText('Core runtime routing decision');
    expect(routingDecision).toHaveTextContent('Auto');
    expect(routingDecision).toHaveTextContent('Managed Hermes');
    expect(screen.getByText('Core routed the Coder workspace-write stage to Managed Hermes.')).toBeVisible();
    expect(screen.getByText('hermes-managed-dev')).toBeVisible();
  });

  it('keeps Auto runnable on the Agent default when live Core preflight reports Hermes unavailable', async () => {
    api.getHermesManagedRuntime.mockResolvedValue({
      identity: { id: 7, displayName: 'Alex', role: 'platform_admin', authentication: 'sso' },
      pack: { connected: false, version: null },
      adapter: { id: 'hermes-http', state: 'unavailable', modes: [] },
      managed: { ready: false, detail: 'Managed Hermes readiness could not be verified.', approvedBundleIds: [9], agents: [{ id: 5, name: 'coder', label: 'Coder' }] },
      limits: { deadlineSeconds: { default: 600, min: 30, max: 900 }, maxToolCalls: { default: 64, min: 1, max: 1_000 } },
    });
    const fallbackSelection = {
      source: 'argus.core' as const, kind: 'runtime-selection' as const, requestedMode: 'auto' as const, effectiveMode: 'default' as const,
      reason: 'managed_hermes_unavailable_use_agent_default' as const, workflowId: 'ticket-to-pull-request',
    };
    api.runSolutionPackPreflight.mockResolvedValue({
      rootTraceId: 'aaaaaaaa-1234-4234-8234-bbbbbbbbbbbb',
      task: {
        id: 'fallback-preflight', status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ parts: [{ data: { ready: true, coreRuntimeSelection: fallbackSelection } }] }],
      },
    });
    const response = {
      rootTraceId: 'cccccccc-1234-4234-8234-dddddddddddd',
      task: {
        id: 'fallback-task', status: { state: 'TASK_STATE_WORKING' },
        metadata: { workflowThreadId: 'fallback-thread', coreRuntimeSelection: fallbackSelection },
      },
    };
    api.startSolutionPackWorkflow.mockResolvedValue(response);
    api.getSolutionPackTask.mockResolvedValue({ task: response.task });
    renderPage([], undefined, undefined, { total: 2, packs: [...catalog.packs, connectedHermesPack] });

    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    const launchRouting = await screen.findByLabelText('Core launch runtime routing');
    await waitFor(() => expect(launchRouting).toHaveTextContent('Auto'));
    expect(launchRouting).toHaveTextContent('Agent default');
    expect(launchRouting).toHaveTextContent('Managed Hermes was unavailable');
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'ARGUS-FALLBACK-1' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Keep the developer workflow running.' } });
    const startButton = screen.getByRole('button', { name: 'Start Ticket to pull request' });
    await waitFor(() => expect(startButton).toBeEnabled());
    fireEvent.click(startButton);

    await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith(
      'argus.dev', 'coding-orchestrator', expect.objectContaining({ runtimeMode: 'auto' }),
    ));
  });

  it('links a changed MCP catalog directly to its governed Fabric review and blocks start', async () => {
    api.runSolutionPackPreflight.mockRejectedValue(Object.assign(
      new Error("Selected MCP bundles are not operational: coding-ops: connection 'github_argus_core' catalog is changed"),
      {
        code: 'bundle_connections_not_ready',
        details: {
          operationalIssues: [{
            bundleId: 7,
            bundleName: 'coding-ops',
            backendId: 208,
            backendName: 'github_argus_core',
            kind: 'catalog_changed',
            recovery: 'review_catalog',
            message: "coding-ops: connection 'github_argus_core' catalog is changed",
          }],
        },
      },
    ));
    renderPage([], undefined, undefined, { total: 2, packs: [...catalog.packs, connectedHermesPack] });

    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'ARGUS-CATALOG-1' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Review the changed provider contract.' } });

    const reviewLink = await screen.findByRole('link', { name: /Review github_argus_core catalog/ });
    expect(reviewLink).toHaveAttribute(
      'href',
      '/mcp-fabric?server=github_argus_core&returnTo=%2Fsolutions%2Fargus.dev#connections',
    );
    expect(screen.getByText('Execution scope needs attention')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeDisabled();
  });

  it('blocks workflow creation when the runtime preflight is not ready', async () => {
    api.runSolutionPackPreflight.mockResolvedValue({
      rootTraceId: '12345678-1234-1234-1234-123456789abc',
      task: {
        id: 'blocked-preflight',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ parts: [{ data: {
          ready: false,
          runtimePreflight: { ready: false, blockers: ['Codex runtime is disabled in agent-workspace'] },
        } }] }],
      },
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'ARGUS-BLOCKED' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Verify runtime readiness.' } });
    await waitFor(() => expect(screen.getByLabelText(/Development workspace/)).toBeChecked());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start Ticket to pull request' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Codex runtime is disabled in agent-workspace');
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
  });

  it('explains missing required inputs next to Start and clears the checklist when ready', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    const requirements = await screen.findByRole('status', { name: 'Start requirements' });
    expect(requirements).toHaveTextContent('Complete required fields: Ticket ID, Implementation brief.');
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'GEM-6' } });
    expect(requirements).toHaveTextContent('Complete required fields: Implementation brief.');
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Implement the reviewed issue scope.' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
    expect(screen.queryByRole('status', { name: 'Start requirements' })).not.toBeInTheDocument();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
  });

  it('shows Jenkins job immediately after CI provider only for Jenkins and omits it after switching away', async () => {
    const original = workflows[0]!.inputSchema;
    workflows[0]!.inputSchema = [...original,
      { name: 'ci_job', label: 'Jenkins job', type: 'text', required: false },
      { name: 'ci_provider', label: 'CI provider', type: 'select', required: true, defaultValue: 'gitea',
        options: [{ value: 'gitea', label: 'Gitea Actions' }, { value: 'jenkins', label: 'Jenkins' }] }];
    try {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
      const provider = screen.getByRole('combobox', { name: /CI provider/ });
      expect(provider).toHaveValue('gitea');
      expect(screen.queryByLabelText('Jenkins job')).not.toBeInTheDocument();
      fireEvent.change(provider, { target: { value: 'jenkins' } });
      const job = screen.getByLabelText('Jenkins job');
      expect(provider.closest('label')!.nextElementSibling).toBe(job.closest('label'));
      fireEvent.change(job, { target: { value: 'demo-gem-repository-dev' } });
      fireEvent.change(provider, { target: { value: 'gitea' } });
      expect(screen.queryByLabelText('Jenkins job')).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'GEM-6' } });
      fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Implement the reviewed issue scope.' } });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Start Ticket to pull request' }));
      await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalled());
      const input = api.startSolutionPackWorkflow.mock.calls.at(-1)![2].input;
      expect(input.ci_provider).toBe('gitea');
      expect(input).not.toHaveProperty('ci_job');
    } finally { workflows[0]!.inputSchema = original; }
  });

  it('keeps the configured Jenkins job in a Jenkins launch', async () => {
    const original = workflows[0]!.inputSchema;
    workflows[0]!.inputSchema = [...original,
      { name: 'ci_job', label: 'Jenkins job', type: 'text', required: false },
      { name: 'ci_provider', label: 'CI provider', type: 'select', required: true, defaultValue: 'jenkins',
        options: [{ value: 'jenkins', label: 'Jenkins' }] }];
    try {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
      fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'GEM-6' } });
      fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Implement the reviewed issue scope.' } });
      fireEvent.change(screen.getByLabelText('Jenkins job'), { target: { value: 'demo-gem-repository-dev' } });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Start Ticket to pull request' }));
      await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator',
        expect.objectContaining({ input: expect.objectContaining({ ci_provider: 'jenkins', ci_job: 'demo-gem-repository-dev' }) })));
    } finally { workflows[0]!.inputSchema = original; }
  });

  it('does not render a stale task when the task detail request races a new run', async () => {
    const response = {
      rootTraceId: '12345678-1234-1234-1234-123456789abc',
      task: {
        id: 'task-new',
        status: { state: 'TASK_STATE_WORKING' },
        metadata: { workflowThreadId: 'thread-new' },
        artifacts: [{ parts: [{ data: { currentStage: 'setup_workspace', ticketId: 'ARGUS-NEW' } }] }],
      },
    };
    api.startSolutionPackWorkflow.mockResolvedValue(response);
    api.getSolutionPackTask.mockRejectedValue(new Error('A2A task is not available yet'));
    api.getCodingThread.mockResolvedValue({
      thread_id: 'thread-new', graph_id: 'coding_workflow', status: 'running', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-new' },
      values: { ticket_id: 'ARGUS-NEW', description: 'Keep the selected task stable.' },
      next: ['setup_workspace'], created_at: '2026-08-05T12:00:00.000Z', updated_at: '2026-08-05T12:00:01.000Z',
    });
    renderPage([{
      thread_id: 'thread-new', graph_id: 'coding_workflow', status: 'running', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-new' },
      values: { ticket_id: 'ARGUS-NEW', description: 'Keep the selected task stable.' },
      next: ['setup_workspace'], created_at: '2026-08-05T12:00:00.000Z', updated_at: '2026-08-05T12:00:01.000Z',
    }]);

    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'ARGUS-NEW' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Keep the selected task stable.' } });
    await waitFor(() => expect(screen.getByLabelText(/Development workspace/)).toBeChecked());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start Ticket to pull request' }));

    await waitFor(() => expect(document.querySelector('.solution-task-meta code')).toHaveTextContent('task-new'));
    expect(document.querySelector('.solution-task-meta code')).not.toHaveTextContent('thread-new');
  });

  it('discovers and starts the pull-request review workflow without UI code changes', async () => {
    const response = {
      rootTraceId: '12345678-1234-1234-1234-123456789abc',
      task: {
        id: 'task-pr-1', status: { state: 'TASK_STATE_WORKING' },
        metadata: { workflowThreadId: 'thread-pr-1', workflowId: 'pull-request-review' },
        artifacts: [{ parts: [{ data: { workflowId: 'pull-request-review', runTitle: 'PR #42', currentStage: 'inspect_pull_request' } }] }],
      },
    };
    api.startSolutionPackWorkflow.mockResolvedValue(response);
    api.getSolutionPackTask.mockResolvedValue({ task: response.task });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    fireEvent.click(screen.getByLabelText(/Pull request review/));
    fireEvent.change(screen.getByLabelText(/^Repository/), { target: { value: 'argus/core' } });
    fireEvent.change(screen.getByLabelText(/Pull request number/), { target: { value: '42' } });
    fireEvent.change(screen.getByLabelText(/Review goal/), { target: { value: 'Validate security and release readiness.' } });
    await waitFor(() => expect(screen.getByLabelText(/Development workspace/)).toBeChecked());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Pull request review' })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Pull request review' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start Pull request review' }));

    expect(await screen.findByRole('dialog', { name: 'Argus Dev run PR #42' }, { timeout: 5_000 })).toBeVisible();
    expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', {
      workflowId: 'pull-request-review',
      input: {
        repository: 'argus/core', pull_request_number: '42',
        review_goal: 'Validate security and release readiness.', next_action: 'release_handoff',
      },
      bundleIds: [7],
      runtimeMode: 'auto',
    });
  });

  it('collapses run instructions by default and resets the disclosure when another run opens', async () => {
    const description = 'First line of the complete implementation brief.\nSecond line with acceptance criteria.\n\nA separate paragraph with constraints.';
    const threads = ['ONE', 'TWO'].map(name => ({
      thread_id: `thread-${name}`, graph_id: 'coding_workflow', status: 'failed', error: 'Runtime disconnected',
      metadata: { source: 'a2a', a2a_task_id: `task-${name}`, ticket_id: `ARGUS-${name}`, description },
      values: { ticket_id: `ARGUS-${name}`, description },
      created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    }));
    api.getCodingThread.mockImplementation(async id => threads.find(thread => thread.thread_id === id));
    api.getSolutionPackTask.mockImplementation(async (_pack, _agent, id) => ({ task: {
      id, status: { state: 'TASK_STATE_FAILED' }, metadata: { workflowThreadId: id.replace('task-', 'thread-') },
      artifacts: [{ parts: [{ data: { currentStage: 'coder' } }] }],
    } }));
    renderPage(threads);
    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-ONE/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Argus Dev run ARGUS-ONE' });
    const flow = await within(dialog).findByRole('region', { name: 'Ticket to pull request workflow' });
    expect(within(flow).getByRole('status')).toHaveTextContent('FailedImplementation · Implement');
    const steps = within(flow).getByText('Technical steps', { selector: 'summary' });
    expect(steps.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(steps);
    expect(steps.closest('details')).toHaveAttribute('open');
    const toggle = within(dialog).getByText('Run instructions', { selector: 'summary' });
    const disclosure = toggle.closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    const content = within(dialog).getByLabelText('Full run instructions');
    expect(content.textContent).toBe(description);
    expect(content.querySelectorAll('p')).toHaveLength(2);
    expect(content.querySelector('p')?.textContent).toBe('First line of the complete implementation brief.\nSecond line with acceptance criteria.');
    expect(content).not.toBeVisible();
    fireEvent.click(toggle);
    expect(disclosure).toHaveAttribute('open');
    expect(content).toBeVisible();
    fireEvent.click(toggle);
    expect(content).not.toBeVisible();
    fireEvent.click(toggle);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close run details' }));
    fireEvent.click(screen.getByRole('button', { name: /ARGUS-TWO/ }));
    const nextDialog = await screen.findByRole('dialog', { name: 'Argus Dev run ARGUS-TWO' });
    expect(within(nextDialog).getByText('Run instructions', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
    expect((await within(nextDialog).findByText('Technical steps', { selector: 'summary' })).closest('details')).not.toHaveAttribute('open');
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
    expect(api.cancelSolutionPackTask).not.toHaveBeenCalled();
  });

  it('lists persisted runs and opens complete evidence from a clickable run card', async () => {
    const task = {
      id: 'task-history-1',
      status: { state: 'TASK_STATE_INPUT_REQUIRED' },
      metadata: { workflowThreadId: 'thread-history-1', executionBundleIds: [7] },
      artifacts: [{ parts: [{ data: {
        ticketId: 'ARGUS-77', currentStage: 'human_approval', plan: 'Persist this plan.', testsPassed: true,
        testOutput: 'PASS', reviewPassed: true, review: 'APPROVED', humanChangeRequest: 'Please add README documentation.',
        retryCount: 1, fileDiffs: [{ path: 'src/history.ts' }],
        revisionHistory: [{
          attempt: 1, retryCount: 0, trigger: 'initial', triggerFeedback: '', startedAt: '2026-08-02T12:01:00.000Z',
          coder: { output: 'Implemented the first draft.', traceId: 'coder-trace-1', recordedAt: '2026-08-02T12:01:10.000Z' },
          tests: { passed: true, output: '12 tests passed', profiles: [{ id: 'node-root', runner: 'node', root: '.', passed: true }], recordedAt: '2026-08-02T12:01:20.000Z' },
          reviewer: {
            verdict: 'REQUEST_CHANGES', summary: 'The behavior needs one correction.',
            findings: [{ severity: 'high', message: 'The new path is not covered.', file: 'src/history.ts', line: 24 }],
            requiredChanges: ['Add a regression test for the new path.'], output: 'REQUEST_CHANGES', traceId: 'reviewer-trace-1', recordedAt: '2026-08-02T12:01:30.000Z',
          },
          humanDecisions: [], fileDiffs: [{ path: 'src/history.ts' }],
        }, {
          attempt: 2, retryCount: 1, trigger: 'reviewer', triggerFeedback: 'Add a regression test for the new path.', startedAt: '2026-08-02T12:02:00.000Z',
          coder: { output: 'Added the missing regression test.', traceId: 'coder-trace-2', recordedAt: '2026-08-02T12:02:10.000Z' },
          tests: { passed: true, output: '13 tests passed', profiles: [{ id: 'node-root', runner: 'node', root: '.', passed: true }], recordedAt: '2026-08-02T12:02:20.000Z' },
          reviewer: { verdict: 'APPROVE', summary: 'The requested coverage is present.', findings: [], requiredChanges: [], output: 'APPROVE', traceId: 'reviewer-trace-2', recordedAt: '2026-08-02T12:02:30.000Z' },
          humanDecisions: [], fileDiffs: [{ path: 'src/history.ts' }],
        }],
      } }] }],
    };
    api.getSolutionPackTask.mockResolvedValue({ task });
    api.getCodingThread.mockResolvedValue({
      thread_id: 'thread-history-1', graph_id: 'coding_workflow', status: 'interrupted', error: null,
      metadata: {},
      values: { ticket_id: 'ARGUS-77', description: 'Persisted development run', human_change_request: 'Please add README documentation.', review: 'APPROVED' },
      next: ['human_approval'], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    });
    renderPage([{
      thread_id: 'thread-history-1', graph_id: 'coding_workflow', status: 'interrupted', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-history-1', ticket_id: 'ARGUS-77', description: 'Persisted development run', execution_bundle_ids: [7] },
      values: { ticket_id: 'ARGUS-77', description: 'Persisted development run', tests_passed: true, review_passed: true, human_change_request: 'Please add README documentation.' },
      next: ['human_approval'], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    }]);

    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-77/ }));
    expect(await screen.findByRole('dialog', { name: 'Argus Dev run ARGUS-77' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Agents, tests & approvals' })).toBeVisible();
    expect(screen.getByText('Persist this plan.')).toBeInTheDocument();
    expect(screen.getByText('PASS')).toBeInTheDocument();
    expect(screen.getAllByText('src/history.ts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('region', { name: 'Revision history' })).toBeVisible();
    expect(screen.getByText('Attempt 1')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
    expect(screen.getByText('Changes requested')).toBeInTheDocument();
    expect(screen.getByText('Review passed')).toBeInTheDocument();
    expect(screen.getAllByText('Add a regression test for the new path.').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('link', { name: 'Run', hidden: true }).some(link => link.getAttribute('href') === '/runs/agent/reviewer-trace-2')).toBe(true);
    expect(screen.getByLabelText('Human change request')).toHaveTextContent('Please add README documentation.');
    expect(screen.getByLabelText('Human change request')).toHaveTextContent('Awaiting approval');
    expect(screen.getByText('Code approval required')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show checkpoints' }));
    await waitFor(() => expect(api.getCodingCheckpoints).toHaveBeenCalledWith('thread-history-1'));
    expect(await screen.findByText(/checkpoint-1/)).toBeVisible();
    expect(screen.getByText(/parent-check/)).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Decision rationale/), { target: { value: 'The evidence is sufficient.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve & continue' }));
    await waitFor(() => expect(api.resumeCodingWorkflow).toHaveBeenCalledWith('thread-history-1', {
      approved: true, feedback: 'The evidence is sufficient.', rationale: 'The evidence is sufficient.',
    }));
  });

  it('clarifies blockers separately without offering or submitting an approval', async () => {
    const thread = { thread_id: 'thread-blocked', graph_id: 'coding_workflow', status: 'interrupted', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-blocked', ticket_id: 'ARGUS-BLOCKED' },
      values: { ticket_id: 'ARGUS-BLOCKED', workflow_blockers: ['Supply complete acceptance criteria'], qa_test_plan: 'Independent boundary tests' },
      next: ['requirements_input'], interrupts: [{ value: { stage: 'requirements_input' } }],
      created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z' };
    api.getCodingThread.mockResolvedValue(thread);
    api.getSolutionPackTask.mockResolvedValue({ task: { id: 'task-blocked', status: { state: 'TASK_STATE_INPUT_REQUIRED' },
      metadata: { workflowThreadId: 'thread-blocked' }, artifacts: [{ parts: [{ data: { ticketId: 'ARGUS-BLOCKED', currentStage: 'requirements_input',
        workflowBlockers: ['Supply complete acceptance criteria'], qaTestPlan: 'Independent boundary tests' } }] }] } });
    api.submitCodingRequirements.mockResolvedValue({ ok: true });
    renderPage([thread]);
    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-BLOCKED/ }));
    expect(await screen.findByRole('region', { name: 'Requirements clarification' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve & continue' })).not.toBeInTheDocument();
    expect(screen.getByText('Supply complete acceptance criteria')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Clarification'), { target: { value: 'Use the specified boundary behavior.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit clarification & re-plan' }));
    await waitFor(() => expect(api.submitCodingRequirements).toHaveBeenCalledWith('thread-blocked', 'Use the specified boundary behavior.'));
    expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
  });

  it('submits a version-bound product choice without using approval or launch APIs', async () => {
    const decision = { version: 2, id: 'a'.repeat(64), kind: 'requirement', canClarify: true,
      title: 'Product decision needed', planRevision: 2, round: 1, questions: [{ id: 'q1', question: 'Keep compatibility?',
        detail: 'The original requirement leaves the public behavior open.', evidence: ['issue#6'], recommendedOptionId: 'keep', options: [
          { id: 'keep', label: 'Keep existing behavior', consequence: 'Existing clients need no migration.' },
          { id: 'change', label: 'Change behavior', consequence: 'Existing clients need migration.' },
        ] }] };
    const thread = { thread_id: 'thread-decision', status: 'interrupted', metadata: { source: 'a2a', a2a_task_id: 'task-decision', ticket_id: 'ARGUS-DECISION' },
      values: { ticket_id: 'ARGUS-DECISION', development_contract_version: 2 }, next: ['requirements_input'],
      interrupts: [{ value: { stage: 'requirements_input', decision } }], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z' };
    api.getCodingThread.mockResolvedValue(thread);
    api.getSolutionPackTask.mockResolvedValue({ task: { id: 'task-decision', status: { state: 'TASK_STATE_INPUT_REQUIRED' },
      metadata: { workflowThreadId: 'thread-decision' }, artifacts: [{ parts: [{ data: { ticketId: 'ARGUS-DECISION', currentStage: 'requirements_input' } }] }] } });
    api.submitCodingRequirements.mockResolvedValue({ ok: true });
    renderPage([thread]);
    expect(await screen.findByText('awaiting clarification')).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-DECISION/ }));
    expect(await screen.findByRole('region', { name: 'Product decision needed' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Submit answer & re-evaluate' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Keep existing behavior/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer & re-evaluate' }));
    await waitFor(() => expect(api.submitCodingRequirements).toHaveBeenCalledWith('thread-decision', '', { decisionId: decision.id, answers: { q1: 'keep' } }));
    expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
  });

  it('fails closed instead of displaying legacy controls for a missing v2 question', async () => {
    const thread = { thread_id: 'thread-missing-question', status: 'interrupted',
      metadata: { source: 'a2a', a2a_task_id: 'task-missing-question', ticket_id: 'ARGUS-MISSING' },
      values: { ticket_id: 'ARGUS-MISSING', development_contract_version: 2 }, next: ['requirements_input'],
      interrupts: [{ value: { stage: 'requirements_input' } }], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z' };
    api.getCodingThread.mockResolvedValue(thread);
    api.getSolutionPackTask.mockResolvedValue({ task: { id: 'task-missing-question', status: { state: 'TASK_STATE_INPUT_REQUIRED' },
      metadata: { workflowThreadId: 'thread-missing-question' }, artifacts: [{ parts: [{ data: { ticketId: 'ARGUS-MISSING', currentStage: 'requirements_input' } }] }] } });
    renderPage([thread]);
    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-MISSING/ }));
    expect(await screen.findByText(/The current decision is unavailable/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Submit clarification & re-plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve & continue' })).toBeNull();
  });

  it('counts technical blocks separately and offers no owner answer or approval action', async () => {
    const decision = { version: 2, id: 'b'.repeat(64), kind: 'technical_review', canClarify: false,
      title: 'Technical work blocked', technicalPolicyVersion: 1, investigationCount: 1, planRevision: 4, round: 2,
      questions: [{ id: 'q1', question: 'Numeric tolerance evidence is missing.', detail: 'The reference calculation is unavailable.',
        evidence: ['fixture/solver.py:4'], options: [], recommendedOptionId: null }] };
    const thread = { thread_id: 'thread-technical', status: 'interrupted', metadata: { source: 'a2a', a2a_task_id: 'task-technical', ticket_id: 'ARGUS-TECHNICAL' },
      values: { ticket_id: 'ARGUS-TECHNICAL', development_contract_version: 2, technical_design_policy_version: 1 }, next: ['requirements_input'],
      interrupts: [{ value: { stage: 'requirements_input', decision } }], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z' };
    api.getCodingThread.mockResolvedValue(thread);
    api.getSolutionPackTask.mockResolvedValue({ task: { id: 'task-technical', status: { state: 'TASK_STATE_INPUT_REQUIRED' },
      metadata: { workflowThreadId: 'thread-technical' }, artifacts: [{ parts: [{ data: { ticketId: 'ARGUS-TECHNICAL', currentStage: 'requirements_input' } }] }] } });
    renderPage([thread]);
    expect(await screen.findByText('technically blocked')).toBeVisible();
    expect(screen.queryByText('awaiting clarification')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-TECHNICAL/ }));
    expect(await screen.findByRole('region', { name: 'Technical work blocked' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Submit answer & re-evaluate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve & continue' })).toBeNull();
    expect(screen.queryByText('Resolution and supporting evidence')).toBeNull();
    expect(api.submitCodingRequirements).not.toHaveBeenCalled();
    expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'qa', category: 'format', recoverable: true },
    { phase: 'qa', category: 'integrity', recoverable: false },
    { phase: 'planner', category: 'format', recoverable: false },
  ])('offers only the matching read-only recovery preview, never automatic QA calls: $phase/$category', async ({ phase, category, recoverable }) => {
    const decision = { version: 2, id: 'b'.repeat(64), kind: 'technical_review', canClarify: false,
      title: 'Agent response could not be validated', responseFailure: { phase, category, diagnostics: ['Invalid response contract.'] },
      technicalPolicyVersion: 1, investigationCount: 0, planRevision: 1, round: 0,
      questions: [{ id: 'q1', question: 'Response validation failed.', detail: 'No product decision is required.', evidence: [], options: [], recommendedOptionId: null }] };
    const thread = { thread_id: 'thread-response', status: 'interrupted',
      metadata: { source: 'a2a', a2a_task_id: 'task-response', ticket_id: 'ARGUS-RESPONSE' },
      values: { ticket_id: 'ARGUS-RESPONSE', development_contract_version: 2, technical_design_policy_version: 1, qa_acceptance_policy_version: 1 },
      next: ['requirements_input'], interrupts: [{ value: { stage: 'requirements_input', decision } }],
      created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z' };
    api.getCodingThread.mockResolvedValue(thread);
    api.getSolutionPackTask.mockRejectedValue(new Error('task not found'));
    api.recheckCodingQaResponse.mockResolvedValue({ available: false, reason: 'Workspace changed.' });
    api.previewCodingQaRetry.mockResolvedValue({ available: false, reason: 'Not solely missing reviews.' });
    renderPage([thread]);
    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-RESPONSE/ }));
    expect(await screen.findByText('Agent response error')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Prepare QA retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit answer & re-evaluate' })).toBeNull();
    expect(api.recheckCodingQaResponse).not.toHaveBeenCalled();
    if (recoverable) {
      fireEvent.click(screen.getByRole('button', { name: 'Recheck QA response' }));
      expect(await screen.findByText('Cannot continue: Workspace changed.')).toBeVisible();
      expect(api.recheckCodingQaResponse).toHaveBeenCalledWith('thread-response');
    } else if (phase === 'qa' && category === 'integrity') {
      expect(api.previewCodingQaRetry).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Recheck QA response' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Check targeted QA correction' }));
      expect(await screen.findByText('Cannot continue: Not solely missing reviews.')).toBeVisible();
      expect(api.previewCodingQaRetry).toHaveBeenCalledWith('thread-response');
    } else {
      expect(screen.queryByRole('region', { name: 'Saved QA response recovery' })).toBeNull();
    }
    expect(api.continueCodingQaResponse).not.toHaveBeenCalled();
    expect(api.retryCodingQa).not.toHaveBeenCalled();
    expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
  });

  it('falls back to the persisted LangGraph thread after A2A task retention expires', async () => {
    api.getSolutionPackTask.mockRejectedValue(new Error('A2A peer rejected request: task not found'));
    api.getCodingThread.mockResolvedValue({
      thread_id: 'thread-expired-a2a', graph_id: 'coding_workflow', status: 'interrupted', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-expired-a2a', workflow_id: 'ticket-to-pull-request', argus_bundle_id: 7 },
      values: {
        ticket_id: 'ARGUS-EXPIRED-1', description: 'Persisted workflow evidence', plan: 'Retained plan.',
        tests_passed: true, test_output: '61 passed', review_passed: true, review: 'APPROVED',
        human_approved: true, branch_pushed: true, delivery_status: 'ci_passed',
        ci_run: { provider: 'gitea', external_id: '58', workflow: 'External CI/CD', status: 'success', conclusion: 'success', branch: 'feature/ARGUS-EXPIRED-1', commit_sha: 'abc', run_url: 'http://127.0.0.1:3005/argus/actions/runs/58', updated_at: '2026-08-02T12:05:00.000Z' },
      },
      next: ['human_approval_pr'], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    });
    api.resumeCodingWorkflow.mockResolvedValue({ ok: true });
    renderPage([{
      thread_id: 'thread-expired-a2a', graph_id: 'coding_workflow', status: 'interrupted', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-expired-a2a', workflow_id: 'ticket-to-pull-request', ticket_id: 'ARGUS-EXPIRED-1' },
      values: { ticket_id: 'ARGUS-EXPIRED-1', description: 'Persisted workflow evidence', human_approved: true, branch_pushed: true, delivery_status: 'ci_passed' },
      next: ['human_approval_pr'], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    }]);

    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-EXPIRED-1/ }));

    expect(await screen.findByText('Functional approval required')).toBeVisible();
    expect(screen.getByText('LANGGRAPH THREAD')).toBeVisible();
    expect(screen.getByText('61 passed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open CI/CD run' })).toHaveAttribute('href', 'http://localhost:3005/argus/actions/runs/58');
    expect(screen.queryByText('Unable to load this view')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Decision rationale/), { target: { value: 'External CI passed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve & continue' }));
    await waitFor(() => expect(api.resumeCodingWorkflow).toHaveBeenCalledWith('thread-expired-a2a', {
      approved: true, feedback: 'External CI passed.', rationale: 'External CI passed.',
    }));
  });

  it('blocks a workflow launch when the selected bundle lacks a required capability', async () => {
    renderPage([], undefined, ['repository']);
    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'ARGUS-CI-1' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Require a CI-capable bundle.' } });
    await waitFor(() => expect(screen.getByLabelText(/Development workspace/)).toBeChecked());
    expect(screen.getByText('Missing required capability')).toBeVisible();
    expect(screen.getAllByText(/CI \/ CD provider/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeDisabled();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
  });

  it('separates CI/CD waiting from human approvals and exposes provider state on the run card', async () => {
    renderPage([
      {
        thread_id: 'thread-ci-waiting', graph_id: 'coding_workflow', status: 'interrupted', error: null,
        metadata: { source: 'a2a', a2a_task_id: 'task-ci-waiting', ticket_id: 'ARGUS-CI-1', description: 'Wait for provider checks.' },
        values: {
          ticket_id: 'ARGUS-CI-1', description: 'Wait for provider checks.',
          branch_pushed: true, delivery_status: 'awaiting_ci',
          ci_run: { provider: 'gitea', external_id: '42', workflow: 'Argus CI', status: 'queued', conclusion: '', branch: 'feature/ARGUS-CI-1', commit_sha: 'abc', run_url: 'http://127.0.0.1:3005/argus/actions/runs/42', updated_at: '2026-08-02T12:05:00.000Z' },
        },
        next: ['external_ci'], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
      },
      {
        thread_id: 'thread-human-waiting', graph_id: 'coding_workflow', status: 'interrupted', error: null,
        metadata: { source: 'a2a', a2a_task_id: 'task-human-waiting', ticket_id: 'ARGUS-APPROVAL-1', description: 'Wait for human approval.' },
        values: { ticket_id: 'ARGUS-APPROVAL-1', description: 'Wait for human approval.' },
        next: ['human_approval'], created_at: '2026-08-02T11:00:00.000Z', updated_at: '2026-08-02T11:05:00.000Z',
      },
    ]);

    expect(await screen.findByText('CI/CD waiting')).toBeVisible();
    expect(screen.getByText('CI queued')).toBeVisible();
    expect(screen.getByRole('button', { name: /ARGUS-CI-1/ })).toHaveTextContent('CI in progress');
    expect(screen.getByRole('link', { name: 'Open Gitea CI' })).toHaveAttribute('href', 'http://localhost:3005/argus/actions/runs/42');
    expect(screen.getByText('awaiting approval')).toBeVisible();
  });

  it('exposes the final pull request link alongside external CI evidence', async () => {
    const task = {
      id: 'task-delivery-1',
      status: { state: 'TASK_STATE_COMPLETED' },
      metadata: { workflowThreadId: 'thread-delivery-1' },
      artifacts: [{ parts: [{ data: {
        ticketId: 'ARGUS-DELIVERY-1', currentStage: 'finalize_pr', testsPassed: true, reviewPassed: true,
        humanApproved: true, branchPushed: true, deliveryStatus: 'pr_created',
        verificationMode: 'review-only-image', prApproved: true,
        ciRun: { provider: 'gitea', external_id: '22', status: 'success', conclusion: 'success', branch: 'feature/ARGUS-DELIVERY-1', commit_sha: 'abcdef1234567890', run_url: 'http://127.0.0.1:3005/argus/actions/runs/22' },
        prUrl: 'http://127.0.0.1:3005/argus/repo/pulls/10',
      } }] }],
    };
    api.getSolutionPackTask.mockResolvedValue({ task });
    renderPage([{
      thread_id: 'thread-delivery-1', graph_id: 'coding_workflow', status: 'completed', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-delivery-1', ticket_id: 'ARGUS-DELIVERY-1' },
      values: { ticket_id: 'ARGUS-DELIVERY-1', tests_passed: true, review_passed: true, human_approved: true, branch_pushed: true, delivery_status: 'pr_created' },
      next: [], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    }]);

    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-DELIVERY-1/ }));
    expect(await screen.findByRole('region', { name: 'Golden path completion evidence' })).toBeVisible();
    expect(screen.getByText('Review-ready delivery assembled')).toBeVisible();
    expect(screen.getByText('2/2 human approvals recorded')).toBeVisible();
    expect(screen.getByText('Image build only · automated tests intentionally skipped')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open completed CI build' })).toHaveAttribute('href', 'http://localhost:3005/argus/actions/runs/22');
    expect(screen.getByRole('link', { name: 'Open completed pull request' })).toHaveAttribute('href', 'http://localhost:3005/argus/repo/pulls/10');
    expect(await screen.findByRole('link', { name: 'Open CI/CD run' })).toHaveAttribute('href', 'http://localhost:3005/argus/actions/runs/22');
    expect(screen.getByRole('link', { name: 'Open pull request' })).toHaveAttribute('href', 'http://localhost:3005/argus/repo/pulls/10');
  });

  it('shows direct LangGraph coding-thread approvals in Argus Dev', async () => {
    api.getCodingThread.mockResolvedValue({
      thread_id: 'thread-direct-1', graph_id: 'coding_workflow', status: 'interrupted', error: null,
      metadata: { ticket_id: 'ARGUS-DIRECT-1', argus_bundle_id: 7 },
      values: { ticket_id: 'ARGUS-DIRECT-1', description: 'Direct coding run', tests_passed: true, review_passed: true, plan: 'Plan', review: 'APPROVED', file_diffs: [{ path: 'src/app.js' }] },
      next: ['human_approval'], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    });
    api.resumeCodingWorkflow.mockResolvedValue({ ok: true });
    renderPage([{
      thread_id: 'thread-direct-1', graph_id: 'coding_workflow', status: 'interrupted', error: null,
      metadata: { ticket_id: 'ARGUS-DIRECT-1', argus_bundle_id: 7 },
      values: { ticket_id: 'ARGUS-DIRECT-1', description: 'Direct coding run', tests_passed: true, review_passed: true },
      next: ['human_approval'], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    }]);

    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-DIRECT-1/ }));
    expect(await screen.findByRole('dialog', { name: 'Argus Dev run ARGUS-DIRECT-1' })).toBeVisible();
    expect(await screen.findByText('Code approval required')).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Decision rationale/), { target: { value: 'Direct evidence is sufficient.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve & continue' }));
    await waitFor(() => expect(api.resumeCodingWorkflow).toHaveBeenCalledWith('thread-direct-1', {
      approved: true, feedback: 'Direct evidence is sufficient.', rationale: 'Direct evidence is sufficient.',
    }));
  });

  it('shows six recent runs per page and excludes runs older than seven days', async () => {
    const recentThreads = Array.from({ length: 8 }, (_, index) => ({
      thread_id: `thread-page-${index + 1}`,
      graph_id: 'coding_workflow', status: 'completed', error: null,
      metadata: { source: 'a2a', a2a_task_id: `task-page-${index + 1}`, ticket_id: `ARGUS-PAGE-${index + 1}` },
      values: { ticket_id: `ARGUS-PAGE-${index + 1}` }, next: [],
      created_at: new Date(Date.now() - index * 60_000).toISOString(),
      updated_at: new Date(Date.now() - index * 60_000).toISOString(),
    }));
    const oldThread = {
      thread_id: 'thread-old', graph_id: 'coding_workflow', status: 'completed', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-old', ticket_id: 'ARGUS-OLD' },
      values: { ticket_id: 'ARGUS-OLD' }, next: [],
      created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    };
    renderPage([...recentThreads, oldThread]);

    expect(await screen.findByText('Showing 1–6 of 8 runs · last 7 days')).toBeVisible();
    expect(screen.getByRole('button', { name: /ARGUS-PAGE-1/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /ARGUS-PAGE-7/ })).not.toBeInTheDocument();
    expect(screen.queryByText('ARGUS-OLD')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await screen.findByText('Showing 7–8 of 8 runs · last 7 days')).toBeVisible();
    expect(screen.getByRole('button', { name: /ARGUS-PAGE-7/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /ARGUS-PAGE-8/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /ARGUS-PAGE-1/ })).not.toBeInTheDocument();
  });

  it('windows page links in groups of ten and keeps later pages, backwards navigation and refresh reachable', async () => {
    const threads = Array.from({ length: 135 }, (_, index) => ({
      thread_id: `thread-window-${index + 1}`, graph_id: 'coding_workflow', status: 'completed', error: null,
      metadata: { source: 'a2a', a2a_task_id: `task-window-${index + 1}`, ticket_id: `WINDOW-${index + 1}` },
      values: { ticket_id: `WINDOW-${index + 1}` }, next: [],
      created_at: new Date(Date.now() - index * 60_000).toISOString(),
      updated_at: new Date(Date.now() - index * 60_000).toISOString(),
    }));
    const client = renderPage(threads);
    const nav = within(await screen.findByRole('navigation', { name: 'Development run pages' }));
    const pages = () => nav.getAllByRole('button', { name: /^Page \d+$/ }).map(button => button.textContent);
    const range = (start: number, count: number) => Array.from({ length: count }, (_, index) => String(start + index));
    expect(pages()).toEqual(range(1, 10));
    expect(nav.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(nav.getByRole('button', { name: 'Page 10' }));
    expect(pages()).toEqual(range(1, 10));
    fireEvent.click(nav.getByRole('button', { name: 'Next' }));
    expect(pages()).toEqual(range(11, 10));
    expect(nav.getByRole('button', { name: 'Page 11' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Showing 61–66 of 135 runs · last 7 days')).toBeVisible();
    for (const page of [12, 13, 20]) {
      fireEvent.click(nav.getByRole('button', { name: `Page ${page}` }));
      expect(nav.getByRole('button', { name: `Page ${page}` })).toHaveAttribute('aria-current', 'page');
    }
    fireEvent.click(nav.getByRole('button', { name: 'Next' }));
    expect(pages()).toEqual(range(21, 3));
    fireEvent.click(nav.getByRole('button', { name: 'Page 23' }));
    expect(screen.getByText('Showing 133–135 of 135 runs · last 7 days')).toBeVisible();
    expect(nav.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.click(nav.getByRole('button', { name: 'Previous' }));
    expect(nav.getByRole('button', { name: 'Page 22' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(nav.getByRole('button', { name: 'Page 21' }));
    fireEvent.click(nav.getByRole('button', { name: 'Previous' }));
    expect(pages()).toEqual(range(11, 10));
    fireEvent.click(nav.getByRole('button', { name: 'Page 11' }));
    fireEvent.click(nav.getByRole('button', { name: 'Previous' }));
    expect(pages()).toEqual(range(1, 10));
    expect(nav.getByRole('button', { name: 'Page 10' })).toHaveAttribute('aria-current', 'page');

    // A refreshed seven-day history can shrink while a later page is selected.
    act(() => client.setQueryData(['argus-dev-runs'], { threads: threads.slice(0, 7) }));
    await waitFor(() => expect(nav.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page'));
    expect(pages()).toEqual(['1', '2']);
    expect(screen.getByText('Showing 7–7 of 7 runs · last 7 days')).toBeVisible();
    act(() => client.setQueryData(['argus-dev-runs'], { threads: threads.slice(0, 1) }));
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Development run pages' })).not.toBeInTheDocument());
    expect(screen.getByText('Showing 1–1 of 1 runs · last 7 days')).toBeVisible();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
    expect(api.cancelSolutionPackTask).not.toHaveBeenCalled();
  });

  it('keeps an accepted cancellation pending until the runtime confirms it', async () => {
    const task = { id: 'task-cancel', status: { state: 'TASK_STATE_WORKING' }, metadata: { workflowThreadId: 'thread-cancel' }, artifacts: [] };
    api.getSolutionPackTask.mockResolvedValue({ task });
    api.cancelSolutionPackTask.mockResolvedValue({ task: { ...task, metadata: { ...task.metadata, runtimeStatus: 'canceling' } } });
    renderPage([{
      thread_id: 'thread-cancel', graph_id: 'coding_workflow', status: 'running', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-cancel', ticket_id: 'CANCEL-42' },
      values: { ticket_id: 'CANCEL-42', description: 'Cancellation fixture' }, next: ['planner'],
      created_at: '2026-08-05T12:00:00.000Z', updated_at: '2026-08-05T12:00:00.000Z',
    }]);
    fireEvent.click(await screen.findByRole('button', { name: /CANCEL-42/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel task' }));
    expect(await screen.findByText(/Cancellation requested\. Stopping the active runtime/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Canceling…' })).toBeDisabled();
    expect(api.cancelSolutionPackTask).toHaveBeenCalledTimes(1);
    expect(api.cancelSolutionPackTask).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', 'task-cancel');
    expect(screen.queryByRole('button', { name: 'Configure retry' })).not.toBeInTheDocument();
    expect(api.cancelCodexRuntimeRun).not.toHaveBeenCalled();
  });

  it.each([
    ['TASK_STATE_WORKING', 'running', false, 'Changes requested — revising plan · round 2/2'],
    ['TASK_STATE_CANCELED', 'canceled', false, 'Run canceled'],
    ['TASK_STATE_INPUT_REQUIRED', 'interrupted', true, 'Plan review passed — human approval required'],
  ])('separates backlog review outcome from execution for %s', async (taskState, runtimeStatus, passed, title) => {
    const trace = '12345678-1234-4234-8234-123456789123';
    const review = `Define terminated and truncated separately.\nVERDICT: ${passed ? 'APPROVED' : 'REJECTED'}`;
    const stage = passed ? 'backlog_approval' : 'decompose_backlog';
    const thread = {
      thread_id: trace, graph_id: 'backlog_grooming', status: runtimeStatus, error: null,
      metadata: { source: 'a2a', a2a_task_id: 'backlog-task', workflow_id: 'backlog-grooming', run_title: 'GEM-PLAN-UI' },
      values: { ticket_id: 'GEM-PLAN-UI', review, review_passed: passed, log: [{ step: 'review_backlog', summary: passed ? '✓ backlog plan approved' : '✗ backlog plan rejected' }] },
      next: [stage], created_at: '2026-08-05T12:00:00Z', updated_at: '2026-08-05T12:00:00Z',
    };
    api.getCodingThread.mockResolvedValue(thread);
    api.getSolutionPackTask.mockResolvedValue({ task: {
      id: 'backlog-task', status: { state: taskState }, metadata: { workflowId: 'backlog-grooming', workflowThreadId: trace, runtimeStatus },
      artifacts: [{ parts: [{ data: { currentStage: stage, review, reviewPassed: passed, retryCount: passed ? 0 : 1, backlogTasks: 'Retained plan' } }] }],
    } });
    api.getRunDetail.mockResolvedValue({ traceFamily: { runs: [{
      id: 'review-trace', kind: 'agent', title: 'reviewer', subtitle: 'Reviewer', status: 'completed',
      startedAt: '2026-08-05T12:00:00Z', durationMs: 2000, outputPreview: review,
    }], spans: [] } });
    renderPage([thread]);
    fireEvent.click(await screen.findByRole('button', { name: /GEM-PLAN-UI/ }));
    const panel = await screen.findByRole('region', { name: 'Backlog review decision' });
    expect(within(panel).getByRole('heading', { name: String(title) })).toBeVisible();
    expect(within(panel).getByText('Reviewer findings')).toBeVisible();
    expect(await screen.findByText(passed ? 'Review passed' : 'Changes requested', { selector: 'em' })).toBeVisible();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
    expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
    if (runtimeStatus === 'canceled') {
      expect(within(panel).getByText(/No plan revision is running/)).toBeVisible();
      expect(screen.getByLabelText('Backlog Planning workflow').querySelector('.is-active')).toBeNull();
    }
    if (passed) expect(screen.getByRole('button', { name: 'Approve & continue' })).toBeDisabled();
  });

  it('does not substitute passing repository output for a failed independent QA execution', async () => {
    const root = '12345678-1234-4234-9234-123456789abc';
    const receipt = { passed: false, status: 'failed', exitCode: 1, collected: 1, stdout: 'QA seed mismatch', stderr: '' };
    api.getSolutionPackTask.mockResolvedValue({ task: {
      id: 'qa-task', status: { state: 'TASK_STATE_WORKING' }, metadata: { workflowThreadId: root },
      artifacts: [{ parts: [{ data: { ticketId: 'QA-INDEPENDENT', currentStage: 'coder', testsPassed: true,
        testOutput: 'Repository tests passed', qaAcceptance: { policyVersion: 1, receipt } } }] }],
    } });
    api.getRunDetail.mockResolvedValue({ generatedAt: '2026-08-02T12:05:00Z', run: {}, steps: [], timeline: [], metrics: {}, traceFamily: { runs: [], spans: [] } });
    const thread = { thread_id: root, status: 'running', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'qa-task', ticket_id: 'QA-INDEPENDENT' },
      values: { log: [{ step: 'tests', summary: '✓ PASSED (workspace)' },
        { step: 'qa_execute', summary: '✗ FAILED Independent QA: changes required' }] },
      created_at: '2026-08-02T12:00:00Z', updated_at: '2026-08-02T12:05:00Z' };
    api.getCodingThread.mockResolvedValue(thread);
    renderPage([thread]);
    fireEvent.click(await screen.findByRole('button', { name: /QA-INDEPENDENT/ }));
    const qa = await screen.findByText('QA · Test execution');
    fireEvent.click(qa);
    const card = qa.closest('details')!;
    expect(card).not.toBeNull();
    expect(within(card).getByText(/QA seed mismatch/)).toBeVisible();
    expect(within(card).queryByText('Repository tests passed')).toBeNull();
  });

  it('separates six Reviewer helper calls from QA and real code review', async () => {
    const root = '12345678-1234-4234-9234-123456789abc';
    const steps = ['test_design', 'generation_plan', ...Array(5).fill('stack_environment'), 'qa_author', 'qa_execute', 'reviewer'];
    const runs = steps.map((step, i) => ({ id: `helper-${i}`, kind: 'agent', title: 'reviewer', agentRole: 'reviewer',
      taskType: 'review', subtitle: 'codex · fixture-model', status: 'completed', startedAt: `2026-08-02T12:00:${String(i).padStart(2, '0')}Z`,
      endedAt: null, durationMs: 1200, parentTraceId: root, parentSpanId: null,
      outputPreview: step === 'reviewer' ? JSON.stringify({ verdict: 'APPROVE', required_changes: [] }) : 'Fixture evidence', href: `/runs/agent/helper-${i}` }));
    const thread = { thread_id: root, status: 'interrupted', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'helper-task', ticket_id: 'HELPER-PURPOSES' },
      values: { log: steps.map((step, i) => ({ step, traceId: `helper-${i}`, summary: 'Fixture evidence' })) },
      created_at: '2026-08-02T12:00:00Z', updated_at: '2026-08-02T12:05:00Z' };
    api.getSolutionPackTask.mockResolvedValue({ task: { id: 'helper-task', status: { state: 'TASK_STATE_INPUT_REQUIRED' },
      metadata: { workflowThreadId: root }, artifacts: [{ parts: [{ data: { ticketId: 'HELPER-PURPOSES', currentStage: 'human_approval' } }] }] } });
    api.getCodingThread.mockResolvedValue(thread);
    api.getRunDetail.mockResolvedValue({ generatedAt: '2026-08-02T12:05:00Z', run: {}, steps: [], timeline: [], metrics: {}, traceFamily: { runs, spans: [] } });
    renderPage([thread]);
    fireEvent.click(await screen.findByRole('button', { name: /HELPER-PURPOSES/ }));
    const generator = await screen.findByText('Generator planning');
    const panel = generator.closest<HTMLElement>('.solution-agent-results')!;
    expect(within(panel).getByText('QA · Test planning')).toBeVisible();
    expect(within(panel).getByText('QA · Test authoring')).toBeVisible();
    expect(within(panel).getByText('QA · Test execution')).toBeVisible();
    expect(within(panel).getByText('Test environment · Planning & repair · attempt 5')).toBeVisible();
    expect(within(panel).getByText('Code review')).toBeVisible();
    expect(within(panel).getAllByText(/Agent: reviewer/)).toHaveLength(9);
    expect(within(panel).queryByText(/Review · attempt/)).toBeNull();
    expect(within(panel).queryByText(/verdict unavailable/)).toBeNull();
    expect(panel.querySelectorAll('details')).toHaveLength(10);
    fireEvent.click(generator);
    expect(within(generator.closest('details')!).getByText(/separate workflow task/)).toBeVisible();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
    expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
    // Optional real-component markup for credential-free native-details browser QA.
    if (process.env['ARGUS_ACTIVITY_VISUAL_OUTPUT']) writeFileSync(process.env['ARGUS_ACTIVITY_VISUAL_OUTPUT'], panel.outerHTML);
  });

  it('shows every invoked agent result including repeated retries', async () => {
    const traceId = '12345678-1234-4234-9234-123456789abc';
    const task = {
      id: 'task-agents-1', status: { state: 'TASK_STATE_WORKING' },
      metadata: { workflowThreadId: traceId },
      artifacts: [{ parts: [{ data: {
        ticketId: 'ARGUS-88', currentStage: 'reviewer', plan: 'Plan result', testsPassed: false,
        testOutput: '1 test failed: expected 200, received 500',
        testProfiles: [
          { id: 'node:.', runner: 'node', root: '.', passed: true },
          { id: 'python:backend', runner: 'python', root: 'backend', passed: false },
        ],
      } }] }],
    };
    api.getSolutionPackTask.mockResolvedValue({ task });
    api.getRunDetail.mockResolvedValue({
      generatedAt: '2026-08-02T12:05:00.000Z', run: {}, currentApproval: null, metrics: {}, steps: [], timeline: [],
      traceFamily: {
        runs: [
          { id: traceId, kind: 'workflow', title: 'coding workflow', subtitle: 'Workflow execution', status: 'running', startedAt: '2026-08-02T12:00:00.000Z', endedAt: null, durationMs: null, parentTraceId: null, parentSpanId: null, agentId: null, inputPreview: null, outputPreview: null, error: null },
          { id: 'agent-planner', kind: 'agent', title: 'planner', subtitle: 'argus-local', status: 'completed', startedAt: '2026-08-02T12:00:01.000Z', endedAt: '2026-08-02T12:00:02.000Z', durationMs: 1000, parentTraceId: traceId, parentSpanId: null, agentId: 6, inputPreview: null, outputPreview: 'Planner result', error: null, href: '/runs/agent/agent-planner' },
          { id: 'agent-coder-1', kind: 'agent', title: 'coder', subtitle: 'argus-local-coder', status: 'completed', startedAt: '2026-08-02T12:00:03.000Z', endedAt: '2026-08-02T12:00:05.000Z', durationMs: 2000, parentTraceId: traceId, parentSpanId: null, agentId: 5, inputPreview: null, outputPreview: 'First coder result', error: null },
          { id: 'agent-coder-2', kind: 'agent', title: 'coder', subtitle: 'argus-local-coder', status: 'running', startedAt: '2026-08-02T12:00:06.000Z', endedAt: null, durationMs: null, parentTraceId: traceId, parentSpanId: null, agentId: 5, inputPreview: null, outputPreview: null, error: null },
        ],
        spans: [
          { id: 'tool-1', traceId: 'agent-coder-1', parentSpanId: null, name: 'workspace_write', kind: 'tool', status: 'completed', startedAt: '2026-08-02T12:00:04.000Z', endedAt: '2026-08-02T12:00:04.100Z', durationMs: 100, toolName: 'workspace_write', model: null, provider: null, error: null },
          { id: 'stage-setup', traceId, parentSpanId: null, name: 'workflow.stage.tests.setup', kind: 'workflow', status: 'completed', startedAt: '2026-08-02T12:00:05.100Z', endedAt: '2026-08-02T12:00:05.600Z', durationMs: 500, toolName: null, model: null, provider: null, inputPreview: JSON.stringify({ label: 'npm dependency setup', profileId: 'node:.', command: 'npm ci' }), outputPreview: 'Dependencies ready', error: null },
          { id: 'stage-build', traceId, parentSpanId: null, name: 'workflow.stage.tests.build', kind: 'workflow', status: 'completed', startedAt: '2026-08-02T12:00:05.700Z', endedAt: '2026-08-02T12:00:05.900Z', durationMs: 200, toolName: null, model: null, provider: null, inputPreview: JSON.stringify({ label: 'npm project build', profileId: 'node:.', command: 'npm run build' }), outputPreview: 'Build passed', error: null },
          { id: 'stage-test', traceId, parentSpanId: null, name: 'workflow.stage.tests.test', kind: 'workflow', status: 'running', startedAt: '2026-08-02T12:00:06.100Z', endedAt: null, durationMs: null, toolName: null, model: null, provider: null, inputPreview: JSON.stringify({ label: 'pytest ticket-scoped tests', profileId: 'python:backend', command: 'pytest backend/tests/test_issue_8675.py' }), outputPreview: null, error: null },
        ],
      },
    });
    renderPage([{
      thread_id: traceId, status: 'running', error: null,
      metadata: { source: 'a2a', a2a_task_id: 'task-agents-1', ticket_id: 'ARGUS-88' },
      values: { log: [
        { step: 'planner', summary: 'Plan completed' },
        { step: 'coder', summary: 'First implementation completed' },
        { step: 'tests', summary: '✗ FAILED (workspace)' },
        { step: 'coder', summary: 'Retry implementation running' },
      ] },
      created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    }]);

    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-88/ }));
    expect(await screen.findByRole('heading', { name: 'Agents, tests & approvals' })).toBeVisible();
    expect(screen.getAllByText('Plan').length).toBeGreaterThan(0);
    expect(screen.getByText('Coder · attempt 1')).toBeVisible();
    expect(screen.getByText('Coder · attempt 2')).toBeVisible();
    expect(screen.getAllByText('Tests').length).toBeGreaterThan(0);
    expect(await screen.findByText('1 test failed: expected 200, received 500')).toBeInTheDocument();
    expect(await screen.findByText('Dependency setup')).toBeVisible();
    expect(screen.getByText('Project build')).toBeVisible();
    expect(screen.getByText('Ticket-scoped tests')).toBeVisible();
    expect(screen.getByText('pytest ticket-scoped tests · python:backend')).toBeVisible();
    expect(screen.getByText((_content, element) => element?.tagName === 'PRE' && Boolean(element.textContent?.includes('pytest backend/tests/test_issue_8675.py')))).toBeVisible();
    expect(screen.getByText('node · .')).toBeInTheDocument();
    expect(screen.getByText('python · backend')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Coder · attempt 1'));
    expect(screen.getByText('First coder result')).toBeVisible();
    expect(screen.getByText('workspace_write')).toBeVisible();
  });

  it('blocks a repository conflict and allows correcting bundles before dispatch', async () => {
    api.runSolutionPackPreflight.mockImplementation(async (_pack, _agent, input) => {
      if (input.bundleIds.includes(9)) throw Object.assign(new Error('Select exactly one repository bundle.'), { code: 'repository_checkout_conflict' });
      return { rootTraceId: 'preflight', task: { status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ data: { ready: true } }] }] } };
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'GEM-182' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Plan GEM only.' } });
    fireEvent.click(await screen.findByLabelText(/Code intelligence read-only/));
    expect(await screen.findByText(/Select exactly one repository bundle/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeDisabled();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Code intelligence read-only/));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
  });

  it.each(['canceled', 'canceling'])('offers a fresh configured restart only after completed cancellation: %s', async status => {
    const thread = { thread_id: 'thread-cancel-restart', graph_id: 'coding_workflow', status, error: null,
      metadata: { a2a_task_id: 'task-cancel-restart', workflow_id: 'ticket-to-pull-request', execution_bundle_ids: [7, 9], workflow_input: { ticket_id: 'CANCEL-RESTART', description: 'Preserve the original brief' } },
      values: { ticket_id: 'CANCEL-RESTART', human_approved: true, pr_approved: true }, next: ['coder'],
      created_at: '2026-08-05T12:00:00Z', updated_at: '2026-08-05T12:00:00Z' };
    api.getCodingThread.mockResolvedValue(thread);
    api.getSolutionPackTask.mockResolvedValue({ task: { id: 'task-cancel-restart', status: { state: status === 'canceled' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING' }, metadata: { workflowThreadId: thread.thread_id, workflowId: 'ticket-to-pull-request', runtimeStatus: status }, artifacts: [] } });
    renderPage([thread]);
    fireEvent.click(await screen.findByRole('button', { name: /CANCEL-RESTART/ }));
    await screen.findByRole('heading', { name: 'Agents, tests & approvals' });
    expect(screen.queryByRole('button', { name: /Continue from/ })).not.toBeInTheDocument();
    if (status === 'canceling') {
      expect(screen.queryByRole('button', { name: 'Configure new run' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Configure retry' })).not.toBeInTheDocument();
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Configure new run' }));
      expect(screen.getByLabelText(/Ticket ID/)).toHaveValue('CANCEL-RESTART');
      expect(screen.getByLabelText(/Implementation brief/)).toHaveValue('Preserve the original brief');
      expect(screen.getByRole('checkbox', { name: /Development workspace/ })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /Code intelligence read-only/ })).toBeChecked();
      expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
      api.startSolutionPackWorkflow.mockResolvedValue({ task: { id: 'new-task', status: { state: 'TASK_STATE_WORKING' } } });
      const startButton = screen.getByRole('button', { name: 'Start new attempt' });
      await waitFor(() => expect(startButton).toBeEnabled());
      fireEvent.click(startButton);
      await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalledTimes(1));
      expect(api.startSolutionPackWorkflow.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
        input: { ticket_id: 'CANCEL-RESTART', description: 'Preserve the original brief' },
        bundleIds: [7, 9], retry: { sourceThreadId: thread.thread_id, sourceTaskId: 'task-cancel-restart', feedback: '' },
      }));
    }
    expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
    expect(api.retryCodingWorkflow).not.toHaveBeenCalled();
    expect(thread.status).toBe(status);
  });

  it('opens a prefilled retry dialog without starting or mutating the failed run', async () => {
    const failedThread = {
      thread_id: 'thread-failed-1', graph_id: 'coding_workflow', status: 'failed',
      error: 'External CI failure: tests failed',
      metadata: { ticket_id: 'ARGUS-FAIL-1', argus_bundle_id: 7 },
      values: { ticket_id: 'ARGUS-FAIL-1', description: 'Fix the service', argus_bundle_id: 7 },
      next: [], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    };
    api.getCodingThread.mockResolvedValue(failedThread);
    api.retryCodingWorkflow.mockResolvedValue({ thread_id: 'thread-retry-1', original_thread_id: failedThread.thread_id, status: 'started' });
    renderPage([failedThread]);

    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-FAIL-1/ }));
    expect(await screen.findByRole('heading', { name: 'Agents, tests & approvals' })).toBeVisible();
    expect(screen.getByText('Workflow stopped:')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Configure retry' }));
    expect(screen.getByRole('heading', { name: 'Configure retry' })).toBeVisible();
    expect(screen.getByLabelText(/Ticket ID/)).toHaveValue('ARGUS-FAIL-1');
    expect(screen.getByLabelText(/Implementation brief/)).toHaveValue('Fix the service');
    expect(screen.getByLabelText(/Additional feedback/)).toHaveValue('');
    expect(api.retryCodingWorkflow).not.toHaveBeenCalled();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Start Argus Dev run' })).not.toBeInTheDocument();
    expect(failedThread.values.description).toBe('Fix the service');
  });

  it('offers exact-checkpoint recovery when a restarted runtime exposes the recorded approval as input required', async () => {
    const checkpointId = '11111111-1111-4111-8111-111111111111';
    const thread = {
      thread_id: 'thread-approval-recovery', graph_id: 'coding_workflow', status: 'input_required',
      error: 'Approval dispatch interrupted', metadata: { ticket_id: 'ARGUS-RECOVER', workflow_id: 'ticket-to-pull-request' },
      values: { ticket_id: 'ARGUS-RECOVER', description: 'Continue the reviewed change', review_passed: true },
      next: ['human_approval'], checkpoint_id: checkpointId,
      created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    };
    api.getCodingThread.mockResolvedValue(thread);
    api.getSolutionPackTask.mockResolvedValue({ task: { id: thread.thread_id, status: { state: 'TASK_STATE_INPUT_REQUIRED' },
      metadata: { workflowThreadId: thread.thread_id, workflowId: 'ticket-to-pull-request' },
      artifacts: [{ parts: [{ data: { ticketId: 'ARGUS-RECOVER', currentStage: 'human_approval', reviewPassed: true } }] }],
    } });
    const client = renderPage([thread]);
    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-RECOVER/ }));
    await waitFor(() => expect(api.getCodingApprovalRecovery).toHaveBeenCalledWith(thread.thread_id));
    api.getCodingApprovalRecovery.mockResolvedValue({ available: true, checkpointId, stage: 'human_approval', approved: true });
    await client.invalidateQueries({ queryKey: ['git-approval-recovery', thread.thread_id] });
    expect(await screen.findByText('Approval recorded; continuation pending')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve & continue' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume recorded decision' }));
    await waitFor(() => expect(api.recoverCodingApproval).toHaveBeenCalledWith(thread.thread_id, checkpointId));
    expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
  });

  it('offers a read-only issue reload beside a blocked retry while retaining all selected Bundles', async () => {
    const original = workflows[0]!.inputSchema;
    workflows[0]!.inputSchema = [...original,
      { name: 'issue_reference', label: 'Gitea issue URL or number', type: 'text', required: false },
      { name: 'issue_sha256', label: 'Reviewed issue fingerprint', type: 'text', required: false }];
    const originalInput = { ticket_id: 'GEM-RETRY', description: 'Implement the issue.', issue_reference: '6', issue_sha256: 'a'.repeat(64) };
    const failedThread = { thread_id: 'thread-issue-retry', graph_id: 'coding_workflow', status: 'failed', error: 'Runtime disconnected',
      metadata: { a2a_task_id: 'task-issue-retry', workflow_id: 'ticket-to-pull-request', execution_bundle_ids: [7, 9], workflow_input: originalInput },
      values: { ...originalInput, argus_bundle_ids: [7, 9] }, next: [],
      created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z' };
    try {
      api.getCodingThread.mockResolvedValue(failedThread);
      api.getSolutionPackTask.mockResolvedValue({ task: { id: 'task-issue-retry', status: { state: 'TASK_STATE_FAILED' },
        metadata: { workflowThreadId: failedThread.thread_id, workflowId: 'ticket-to-pull-request', executionBundleIds: [7, 9] } } });
      api.loadCodingIssue.mockRejectedValueOnce(new Error('Read policy denied')).mockResolvedValue({ snapshot: {
        version: 1, provider: 'gitea', repository: 'team/repo', number: 6, title: 'Fresh issue', body: 'Current requirements.',
        state: 'open', sha256: 'b'.repeat(64), toolName: 'gitea_demo_get_issue', updatedAt: '2026-09-27',
      } });
      api.startSolutionPackWorkflow.mockRejectedValue(new Error('Captured request only'));
      renderPage([failedThread]);
      fireEvent.click(await screen.findByRole('button', { name: /GEM-RETRY/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Configure retry' }));
      expect(screen.getByLabelText(/Development workspace/)).toBeChecked();
      expect(screen.getByLabelText(/Code intelligence read-only/)).toBeChecked();
      expect(screen.getByText('Retry: Bundles and inputs are already selected.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Start new attempt' })).toBeDisabled();
      expect(api.loadCodingIssue).not.toHaveBeenCalled();
      const requirements = screen.getByRole('status', { name: 'Start requirements' });
      fireEvent.click(within(requirements).getByRole('button', { name: 'Load issue preview' }));
      expect(screen.getByRole('region', { name: 'Source issue preview' })).toHaveFocus();
      expect(await screen.findByText('Read policy denied')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Start new attempt' })).toBeDisabled();
      expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Load issue preview' }));
      expect(await screen.findByRole('heading', { name: '#6 · Fresh issue' })).toBeVisible();
      expect(api.loadCodingIssue).toHaveBeenLastCalledWith('6', [7, 9]);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start new attempt' })).toBeEnabled());
      expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Start new attempt' }));
      await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', expect.objectContaining({
        input: { ...originalInput, issue_sha256: 'b'.repeat(64) }, bundleIds: [7, 9],
        retry: { sourceThreadId: failedThread.thread_id, sourceTaskId: 'task-issue-retry', feedback: '' },
      })));
      expect(failedThread.metadata.workflow_input).toEqual(originalInput);
      expect(failedThread.values.issue_sha256).toBe('a'.repeat(64));
    } finally { workflows[0]!.inputSchema = original; }
  });

  it('restarts an A2A failure through the governed Pack boundary with its Hermes runtime and full Bundle scope', async () => {
    const failedThread = {
      thread_id: 'thread-hermes-failed-1', graph_id: 'coding_workflow', status: 'failed',
      error: 'Managed Hermes completed without bounded agent output',
      metadata: {
        a2a_task_id: 'task-hermes-failed-1', workflow_id: 'ticket-to-pull-request',
        execution_bundle_ids: [7],
        execution_runtime_overrides: [{ agentId: 5, runtimeType: 'hermes', runtimeProfileId: 37, runtimeProfileName: 'hermes-managed-dev' }],
      },
      values: { ticket_id: 'ARGUS-HERMES-FAIL-1', description: 'Fix the concurrency regression', argus_bundle_id: 7 },
      next: [], created_at: '2026-08-02T12:00:00.000Z', updated_at: '2026-08-02T12:05:00.000Z',
    };
    api.getCodingThread.mockResolvedValue(failedThread);
    api.getSolutionPackTask.mockResolvedValue({
      task: {
        id: 'task-hermes-failed-1', contextId: 'context-hermes-failed-1',
        status: { state: 'TASK_STATE_FAILED', timestamp: '2026-08-02T12:05:00.000Z' },
        metadata: {
          workflowThreadId: 'thread-hermes-failed-1', workflowId: 'ticket-to-pull-request', executionBundleIds: [7],
          execution_runtime_overrides: [{ agentId: 5, runtimeType: 'hermes', runtimeProfileId: 37, runtimeProfileName: 'hermes-managed-dev' }],
        },
        artifacts: [{ name: 'failure', parts: [{ data: { workflowId: 'ticket-to-pull-request', runTitle: 'ARGUS-HERMES-FAIL-1' } }] }],
      },
    });
    api.startSolutionPackWorkflow.mockResolvedValue({
      rootTraceId: '22345678-1234-1234-1234-123456789abc',
      task: {
        id: 'task-hermes-retry-2', contextId: 'context-hermes-retry-2',
        status: { state: 'TASK_STATE_WORKING', timestamp: '2026-08-05T12:00:00.000Z' },
        metadata: { workflowId: 'ticket-to-pull-request', executionBundleIds: [7] },
      },
    });
    renderPage([failedThread], undefined, undefined, {
      total: 2,
      packs: [...catalog.packs, connectedHermesPack],
    });

    fireEvent.click(await screen.findByRole('button', { name: /ARGUS-HERMES-FAIL-1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Configure retry' }));
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /^Managed Hermes/ })).toBeChecked();
    fireEvent.click(screen.getByLabelText(/Code intelligence read-only/));
    fireEvent.change(screen.getByLabelText(/Additional feedback/), { target: { value: 'Return a bounded final summary after the write.' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Fix the concurrency regression with deterministic tests' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start new attempt' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Start new attempt' }));

    await waitFor(() => expect(api.runSolutionPackPreflight).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', {
      workflowId: 'ticket-to-pull-request', bundleIds: [7, 9], runtimeMode: 'managed-hermes',
    }));
    await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', {
      workflowId: 'ticket-to-pull-request',
      input: {
        ticket_id: 'ARGUS-HERMES-FAIL-1',
        description: 'Fix the concurrency regression with deterministic tests',
      },
      bundleIds: [7, 9],
      runtimeMode: 'managed-hermes',
      retry: { sourceThreadId: 'thread-hermes-failed-1', sourceTaskId: 'task-hermes-failed-1', feedback: 'Return a bounded final summary after the write.' },
    }));
    expect(api.retryCodingWorkflow).not.toHaveBeenCalled();
  });
});

describe('initialWorkflowBundleIds', () => {
  it('prefills only catalog inputs and removes legacy-generated failure suffixes', () => {
    const thread = { thread_id: 'old', graph_id: 'coding_workflow', status: 'failed' as const, created_at: '', updated_at: '', next: [],
      metadata: {}, values: { ticket_id: 'GEM-182', description: 'Plan GEM.\n\n---\nPrevious attempt failure:\n403\n\nPlease address the failure and rerun the relevant checks.', human_approved: true, argus_execution_grant: 'secret' } };
    expect(governedRetryInput(workflows[0]!, thread)).toEqual({ ticket_id: 'GEM-182', description: 'Plan GEM.' });
    expect(thread.values.description).toContain('403');
    expect(governedRetryInput(workflows[0]!, { ...thread, metadata: { workflow_input: { ticket_id: 'GEM-182', description: 'Frozen original' } } }).description).toBe('Frozen original');
  });

  it('loads issue content read-only, pins its hash and invalidates on changed reference', async () => {
    const original = workflows[0]!.inputSchema;
    workflows[0]!.inputSchema = [...original,
      { name: 'issue_reference', label: 'Gitea issue URL or number', type: 'text', required: false },
      { name: 'issue_sha256', label: 'Reviewed issue fingerprint', type: 'text', required: false }];
    try {
      api.loadCodingIssue.mockResolvedValue({ snapshot: { version: 1, provider: 'gitea', repository: 'team/repo',
        number: 5, title: 'A real issue', body: 'Keep approvals; add regression tests.', state: 'open',
        sha256: 'a'.repeat(64), toolName: 'gitea_demo_get_issue', updatedAt: '2026-09-27' } });
      api.startSolutionPackWorkflow.mockRejectedValue(new Error('Captured start; no workflow dispatched'));
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
      const issueSection = screen.getByRole('region', { name: 'Source issue preview' });
      expect(within(issueSection).getByRole('button', { name: 'Load issue' })).toBeDisabled();
      expect(within(issueSection).getByLabelText(/Gitea issue URL or number/)).toBeVisible();
      expect(screen.getByRole('group', { name: /Execution bundles/ }).compareDocumentPosition(issueSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(issueSection.compareDocumentPosition(screen.getByLabelText(/Implementation brief/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'GEM-5' } });
      fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Fix the issue within repository scope.' } });
      fireEvent.change(screen.getByLabelText(/Gitea issue URL or number/), { target: { value: '5' } });
      await waitFor(() => expect(screen.getByLabelText(/Development workspace/)).toBeChecked());
      expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
      expect(await screen.findByRole('heading', { name: '#5 · A real issue' })).toBeVisible();
      expect(api.loadCodingIssue).toHaveBeenCalledWith('5', [7]);
      expect(within(issueSection).getByText('Verified repository: team/repo')).toBeVisible();
      expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
      expect(api.resumeCodingWorkflow).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Start Ticket to pull request' }));
      await waitFor(() => expect(api.startSolutionPackWorkflow).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator',
        expect.objectContaining({ input: expect.objectContaining({ issue_reference: '5', issue_sha256: 'a'.repeat(64) }) })));
      fireEvent.change(screen.getByLabelText(/Gitea issue URL or number/), { target: { value: '6' } });
      expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeDisabled();
      expect(screen.queryByRole('heading', { name: '#5 · A real issue' })).not.toBeInTheDocument();
    } finally { workflows[0]!.inputSchema = original; }
  });

  it('prefers a concrete checkout bundle over a repository-only MCP bundle', () => {
    expect(initialWorkflowBundleIds(
      ['dev-workspace'],
      [
        { id: 1, name: 'coding-ops', capabilityCategories: ['repository', 'ci'] },
        { id: 3, name: 'argus-dev-demo', capabilityCategories: ['repository', 'repository-checkout', 'ci'] },
      ],
      ['repository', 'repository-checkout', 'ci'],
      ['rag'],
    )).toEqual([3]);
  });
});

describe('issue preview selection lifecycle', () => {
  let originalSchema: SolutionPackWorkflowDefinition['inputSchema'];
  const snapshot = (title = 'Current issue') => ({ version: 1, provider: 'gitea', repository: 'team/repo',
    number: 5, title, body: 'Add regression tests.', state: 'open', sha256: 'b'.repeat(64),
    toolName: 'gitea_demo_get_issue', updatedAt: '2026-09-27' });
  beforeEach(() => {
    vi.clearAllMocks();
    api.loadCodingIssue.mockReset();
    originalSchema = workflows[0]!.inputSchema;
    workflows[0]!.inputSchema = [...originalSchema,
      { name: 'issue_reference', label: 'Gitea issue URL or number', type: 'text', required: false },
      { name: 'issue_sha256', label: 'Reviewed issue fingerprint', type: 'text', required: false }];
  });
  afterEach(() => { workflows[0]!.inputSchema = originalSchema; });
  async function openIssueForm() {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New development run' }));
    await waitFor(() => expect(screen.getByLabelText(/Development workspace/)).toBeChecked());
    fireEvent.change(screen.getByLabelText(/Ticket ID/), { target: { value: 'GEM-PREVIEW' } });
    fireEvent.change(screen.getByLabelText(/Implementation brief/), { target: { value: 'Implement the selected issue.' } });
    fireEvent.change(screen.getByLabelText(/Gitea issue URL or number/), { target: { value: '5' } });
  }

  it('clears errors on reference, Bundle and workflow changes without automatic reads or starts', async () => {
    api.loadCodingIssue.mockRejectedValue(new Error('No authorized issue tool'));
    await openIssueForm();
    fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
    expect(await screen.findByText('No authorized issue tool')).toBeVisible();
    fireEvent.change(screen.getByLabelText(/Gitea issue URL or number/), { target: { value: '6' } });
    expect(screen.queryByText('No authorized issue tool')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
    expect(await screen.findByText('No authorized issue tool')).toBeVisible();
    fireEvent.click(screen.getByLabelText(/Code intelligence read-only/));
    expect(screen.queryByText('No authorized issue tool')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
    expect(await screen.findByText('No authorized issue tool')).toBeVisible();
    fireEvent.click(screen.getByRole('radio', { name: /^Backlog Planning/ }));
    expect(screen.queryByRole('region', { name: 'Source issue preview' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^Ticket to pull request/ }));
    expect(screen.queryByText('No authorized issue tool')).not.toBeInTheDocument();
    expect(api.loadCodingIssue).toHaveBeenCalledTimes(3);
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'])('ignores a late %s after switching away and back to the same selection', async outcome => {
    let resolveOld!: (value: { snapshot: ReturnType<typeof snapshot> }) => void;
    let rejectOld!: (reason: Error) => void;
    api.loadCodingIssue.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
      .mockResolvedValue({ snapshot: snapshot() });
    await openIssueForm();
    fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
    await waitFor(() => expect(api.loadCodingIssue).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Loading issue…' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Gitea issue URL or number/), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText(/Gitea issue URL or number/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
    expect(await screen.findByRole('heading', { name: '#5 · Current issue' })).toBeVisible();
    await act(async () => {
      if (outcome === 'success') resolveOld({ snapshot: snapshot('Outdated issue') });
      else rejectOld(new Error('Outdated request failed'));
    });
    expect(screen.getByRole('heading', { name: '#5 · Current issue' })).toBeVisible();
    expect(screen.queryByText(/Outdated/)).not.toBeInTheDocument();
    expect(api.startSolutionPackWorkflow).not.toHaveBeenCalled();
  });

  it('invalidates successful previews on Bundle changes and reload failures', async () => {
    api.loadCodingIssue.mockResolvedValue({ snapshot: snapshot() });
    await openIssueForm();
    fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
    expect(await screen.findByRole('heading', { name: '#5 · Current issue' })).toBeVisible();
    fireEvent.click(screen.getByLabelText(/Code intelligence read-only/));
    expect(screen.queryByRole('heading', { name: '#5 · Current issue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Start requirements' })).toHaveTextContent('Load and review the issue again for the currently selected Bundles.');
    fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
    expect(await screen.findByRole('heading', { name: '#5 · Current issue' })).toBeVisible();
    expect(api.loadCodingIssue).toHaveBeenLastCalledWith('5', [7, 9]);
    api.loadCodingIssue.mockRejectedValueOnce(new Error('Read policy denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Load issue' }));
    expect(await screen.findByText('Read policy denied')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '#5 · Current issue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Ticket to pull request' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Development workspace/));
    fireEvent.click(screen.getByLabelText(/Code intelligence read-only/));
    expect(screen.getByRole('button', { name: 'Load issue' })).toBeDisabled();
    expect(screen.queryByText('Read policy denied')).not.toBeInTheDocument();
  });
});
