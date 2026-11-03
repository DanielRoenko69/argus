import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodingThreadSummary, CodexRuntimeStatus, RunDetailResponse, TraceFeedbackResponse } from '../types';
import { RunDetailPage } from './RunDetailPage';

const api = vi.hoisted(() => ({
  getConsoleUser: vi.fn().mockResolvedValue({ role:'viewer' }),
  getRunDetail: vi.fn(),
  getCodingThread: vi.fn(),
  getSpanEvidence: vi.fn(),
  getTraceFeedback: vi.fn(),
  submitTraceFeedback: vi.fn(),
  getCodexRuntimeStatus: vi.fn(),
  cancelCodexRuntimeRun: vi.fn(),
}));
vi.mock('../api', () => api);

const detail: RunDetailResponse = {
  generatedAt: '2026-07-31T12:00:06.000Z',
  run: {
    id: '42', numericId: 42, kind: 'workflow', title: 'Release workflow', subtitle: 'Production release',
    status: 'completed', risk: 'medium', startedAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:06.000Z',
    durationMs: 6000, href: '/runs/workflow/42', totalSteps: 1, completedSteps: 1, resumeCount: 0,
  },
  currentApproval: null,
  metrics: { approvalCount: 0 },
  steps: [{ id: 'deploy', label: 'Deploy release', type: 'argus.tool', toolName: 'kubernetes_apply', status: 'completed', durationMs: 1800, resultPreview: '{"ready":true}' }],
  timeline: [
    { id: 'started', kind: 'run_started', title: 'Execution started', detail: 'Manual trigger', timestamp: '2026-07-31T12:00:00.000Z' },
    {
      id: 'deploy', kind: 'step_completed', title: 'Deploy release completed', detail: 'Tool · kubernetes_apply',
      timestamp: '2026-07-31T12:00:04.000Z', durationMs: 1800, stepId: 'deploy', toolName: 'kubernetes_apply',
      inputPreview: '{"namespace":"platform","api_token":"[REDACTED]"}', resultPreview: '{"ready":true}',
    },
    { id: 'done', kind: 'run_completed', title: 'Execution completed', detail: 'Finished', timestamp: '2026-07-31T12:00:06.000Z', durationMs: 6000 },
  ],
};

function renderPage(
  payload: RunDetailResponse = detail,
  initialEntry = '/runs/workflow/42',
  feedbackResponse?: TraceFeedbackResponse,
  codingThread?: CodingThreadSummary,
  runtimeStatus?: CodexRuntimeStatus,
) {
  api.getRunDetail.mockResolvedValue(payload);
  api.getCodingThread.mockResolvedValue(codingThread);
  const traceId = payload.run.traceId ?? '11111111-1111-4111-8111-111111111111';
  const emptyFeedback = {
    generatedAt: '2026-07-31T12:00:06.000Z',
    traceId,
    feedback: [],
    summary: {
      activeCount: 0, humanCount: 0, modelCount: 0, averageScore: null,
      sentiments: { positive: 0, neutral: 0, negative: 0, mixed: 0 }, labels: [],
    },
  };
  api.getTraceFeedback.mockResolvedValue(feedbackResponse ?? emptyFeedback);
  api.submitTraceFeedback.mockResolvedValue(emptyFeedback);
  api.getCodexRuntimeStatus.mockResolvedValue(runtimeStatus ?? {
    enabled: true,
    authenticated: true,
    authMethod: 'chatgpt',
    activeRuns: 0,
    maxConcurrentRuns: 1,
    runs: [],
  });
  api.cancelCodexRuntimeRun.mockResolvedValue({ ok: true });
  api.getSpanEvidence.mockResolvedValue({
    generatedAt: '2026-07-31T12:00:04.000Z',
    trace: {
      id: '22222222-2222-4222-8222-222222222222',
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      parentTraceId: '11111111-1111-4111-8111-111111111111',
      name: 'agent.planner', kind: 'agent',
    },
    span: {
      id: '44444444-4444-4444-8444-444444444444', parentSpanId: null, name: 'llm.iteration.1',
      kind: 'llm', status: 'completed', startedAt: '2026-07-31T12:00:02.000Z',
      endedAt: '2026-07-31T12:00:03.500Z', durationMs: 1500, model: 'gpt-5.1', provider: 'openai',
      toolName: null, inputTokens: 120, outputTokens: 30, totalCostUsd: 0.0042,
      inputPreview: '{"prompt":"hello","apiKey":"[REDACTED]"}', outputPreview: '{"answer":"ready"}',
      metadataPreview: '{"iteration":1}', error: null,
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <Routes><Route path="/runs/:kind/:runId" element={<RunDetailPage />} /></Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('RunDetailPage trace inspection', () => {
  afterEach(() => vi.clearAllMocks());

  it('links a correlated visual run to the read-only workflow replay', async () => {
    const traceId = '927d3c7a-4b82-4693-bf67-9e96159990c1';
    renderPage({
      ...detail,
      run: {
        ...detail.run,
        id: traceId,
        traceId,
        rootTraceId: traceId,
        workflowId: 149,
        workflowHref: `/build/workflows/studio/149?replay=${traceId}`,
      },
    }, `/runs/workflow/${traceId}`, undefined, {
      thread_id: traceId,
      graph_id: 'visual_workflow_149',
      status: 'completed',
      metadata: {},
      values: { step_results: {} },
      created_at: detail.run.startedAt,
      updated_at: detail.run.updatedAt,
    });

    expect(await screen.findByRole('link', { name: /Replay workflow/ }))
      .toHaveAttribute('href', `/build/workflows/studio/149?replay=${traceId}`);
  });

  it('renders commit-bound native code evidence with trace-deep links', async () => {
    const rootTraceId = '11111111-1111-4111-8111-111111111111';
    const spanId = '66666666-6666-4666-8666-666666666666';
    renderPage({
      ...detail,
      run: { ...detail.run, traceId: rootTraceId, rootTraceId },
      traceFamily: {
        rootTraceId,
        currentTraceId: rootTraceId,
        truncated: false,
        spansTruncated: false,
        runs: [{
          id: rootTraceId, parentTraceId: null, parentSpanId: null, kind: 'workflow',
          title: 'Release workflow', subtitle: 'Argus Dev', status: 'completed',
          startedAt: detail.run.startedAt, endedAt: detail.run.updatedAt, durationMs: 6000,
        }, {
          id: '55555555-5555-4555-8555-555555555555', agentId: 6,
          parentTraceId: rootTraceId, parentSpanId: null, kind: 'agent',
          title: 'planner', subtitle: 'Codex runtime', status: 'completed',
          startedAt: detail.run.startedAt, endedAt: detail.run.updatedAt, durationMs: 1200,
        }],
        spans: [],
        codeIntelligence: {
          mode: 'local_retrieval',
          snapshots: [{
            snapshotId: 7, repositoryKey: 'argus/sample', branchName: 'main', commitSha: 'a'.repeat(40),
            provider: 'graphify', fileCount: 5, symbolCount: 24, edgeCount: 24, documentCount: 29,
            traceId: rootTraceId, spanId, status: 'completed', observedAt: detail.run.updatedAt,
          }],
          retrievals: [{
            traceId: rootTraceId, spanId, snapshotId: 7, status: 'completed', durationMs: 31,
            agentId: 6, agentName: 'planner', runtimeTraceId: '55555555-5555-4555-8555-555555555555', taskType: 'plan',
            evidenceCount: 1, channels: ['exact', 'graph'], observedAt: detail.run.updatedAt, error: null,
            citations: [{
              filePath: 'src/app.ts', symbolName: 'createApp', startLine: 17, endLine: 35,
              chunkKind: 'symbol', channels: ['exact', 'graph'], fusedScore: 1.25,
            }],
          }],
        },
        analysis: { criticalPath: [], bottleneck: null, totalDurationMs: 6000, maxConcurrency: 1, failedNodes: 0 },
        historicalBaseline: {
          selectedWindowDays: null, confidence: 'none', sampleCount: 0, currentDurationMs: 6000,
          currentCostUsd: 0, durationDeltaPercent: null, costDeltaPercent: null,
          durationState: 'no_data', costState: 'no_data', selected: null, windows: [],
        },
        comparison: null,
      },
    });

    const evidence = await screen.findByLabelText('Native code intelligence evidence');
    expect(evidence).toHaveTextContent('argus/sample');
    expect(evidence).toHaveTextContent('main · aaaaaaaaaaaa');
    expect(evidence).toHaveTextContent('src/app.ts#L17-35');
    expect(evidence).toHaveTextContent('Planner');
    expect(evidence).toHaveTextContent('exact');
    expect(evidence).toHaveTextContent('graph');
    expect(within(evidence).getByRole('link', { name: /Agent run/ })).toHaveAttribute(
      'href',
      '/runs/agent/55555555-5555-4555-8555-555555555555',
    );
    expect(within(evidence).getAllByRole('link', { name: /Trace|31 ms/ })[0]).toHaveAttribute(
      'href',
      `/runs/workflow/${rootTraceId}?span=${spanId}`,
    );
  });

  it('shows only Codex runtime sessions correlated with the current trace family', async () => {
    const rootTraceId = '11111111-1111-4111-8111-111111111111';
    const childTraceId = '55555555-5555-4555-8555-555555555555';
    const runtimeRun = (id: string, rootTraceIdValue: string, taskType: string) => ({
      id,
      state: 'completed' as const,
      startedAt: detail.run.startedAt,
      updatedAt: detail.run.updatedAt,
      finishedAt: detail.run.updatedAt,
      cwd: '/runtime',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      timeoutSec: 300,
      threadId: null,
      rootTraceId: rootTraceIdValue,
      agentId: 6,
      taskType,
    });
    renderPage({
      ...detail,
      run: { ...detail.run, traceId: rootTraceId, rootTraceId },
      traceFamily: {
        rootTraceId,
        currentTraceId: rootTraceId,
        truncated: false,
        spansTruncated: false,
        runs: [{
          id: rootTraceId, parentTraceId: null, parentSpanId: null, kind: 'workflow',
          title: 'Release workflow', subtitle: 'Manual', status: 'completed',
          startedAt: detail.run.startedAt, endedAt: detail.run.updatedAt, durationMs: 6000,
        }, {
          id: childTraceId, parentTraceId: rootTraceId, parentSpanId: null, kind: 'agent',
          title: 'planner', subtitle: 'Codex runtime', status: 'completed',
          startedAt: detail.run.startedAt, endedAt: detail.run.updatedAt, durationMs: 1200,
        }],
        spans: [],
        analysis: { criticalPath: [], bottleneck: null, totalDurationMs: 6000, maxConcurrency: 1, failedNodes: 0 },
        historicalBaseline: {
          selectedWindowDays: null, confidence: 'none', sampleCount: 0, currentDurationMs: 6000,
          currentCostUsd: 0, durationDeltaPercent: null, costDeltaPercent: null,
          durationState: 'no_data', costState: 'no_data', selected: null, windows: [],
        },
        comparison: null,
      },
    }, '/runs/workflow/42', undefined, undefined, {
      enabled: true,
      authenticated: true,
      authMethod: 'chatgpt',
      activeRuns: 0,
      maxConcurrentRuns: 2,
      runs: [
        runtimeRun('related-runtime', rootTraceId, 'planner_smoke'),
        runtimeRun('unrelated-runtime', '99999999-9999-4999-8999-999999999999', 'unrelated_history'),
      ],
    });

    const runtimePanel = await screen.findByLabelText('Codex runtime sessions');
    expect(runtimePanel).toHaveTextContent('planner_smoke');
    expect(runtimePanel).not.toHaveTextContent('unrelated_history');
  });

  it('shows the persisted human change request and its workflow status', async () => {
    const threadId = '11111111-1111-4111-8111-111111111111';
    renderPage({
      ...detail,
      run: { ...detail.run, id: threadId, traceId: threadId, rootTraceId: threadId },
    }, `/runs/workflow/${threadId}`, undefined, {
      thread_id: threadId,
      graph_id: 'coding_workflow',
      status: 'interrupted',
      metadata: {},
      values: {
        human_change_request: 'Bitte zusätzlich die README-Dokumentation ergänzen.',
        review: 'VERDICT: APPROVED',
      },
      next: ['human_approval'],
      created_at: '2026-07-31T12:00:00.000Z',
      updated_at: '2026-07-31T12:00:05.000Z',
    });

    const requestCard = await screen.findByLabelText('Human change request');
    expect(requestCard).toHaveTextContent('Bitte zusätzlich die README-Dokumentation ergänzen.');
    expect(requestCard).toHaveTextContent('Awaiting approval');
    expect(requestCard).toHaveTextContent('Last updated');
    expect(requestCard).toHaveTextContent('Persisted in workflow trace');
    expect(api.getCodingThread).toHaveBeenCalledWith(threadId);
  });

  it('highlights the selected visual Router branch and keeps skipped steps visible', async () => {
    const threadId = '33333333-3333-4333-8333-333333333333';
    renderPage({
      ...detail,
      run: { ...detail.run, id: threadId, traceId: threadId, rootTraceId: threadId, totalSteps: 1, completedSteps: 1 },
    }, `/runs/workflow/${threadId}`, undefined, {
      thread_id: threadId,
      graph_id: 'visual_workflow_149',
      status: 'completed',
      metadata: {},
      values: {
        step_results: {
          start: { status: 'completed', label: 'Start', type: 'trigger.manual', result: 'Started', durationMs: 1 },
          route: { status: 'completed', label: 'Intent route', type: 'logic.router', result: 'plan', selectedTarget: 'planner', durationMs: 2 },
          planner: { status: 'completed', label: 'Planner', type: 'argus.agent', result: 'Plan output', durationMs: 1200 },
          reviewer: { status: 'skipped', label: 'Reviewer', type: 'argus.agent', result: "Route 'plan' selected 'planner'", durationMs: 0 },
          response: { status: 'completed', label: 'Response', type: 'logic.response', result: 'Plan output', durationMs: 1 },
        },
        log: [{ step: 'route', summary: "Route 'plan' selected 'planner'" }],
      },
      created_at: '2026-07-31T12:00:00.000Z',
      updated_at: '2026-07-31T12:00:05.000Z',
    });

    const routing = await screen.findByLabelText('Workflow routing decisions');
    expect(routing).toHaveTextContent('Intent route · plan');
    expect(routing).toHaveTextContent('Selected Planner');
    expect(routing).toHaveTextContent('Reviewer');
    expect(await screen.findByText('5 of 5 steps settled')).toBeInTheDocument();
    const reviewerStep = screen.getAllByText('Reviewer').map(element => element.closest('.run-step')).find(Boolean);
    expect(reviewerStep).toHaveClass('step-skipped');
  });

  it('shows direct external CI evidence and a provider link on the run detail page', async () => {
    const threadId = '22222222-2222-4222-8222-222222222222';
    renderPage({
      ...detail,
      run: { ...detail.run, id: threadId, traceId: threadId, rootTraceId: threadId },
    }, `/runs/workflow/${threadId}`, undefined, {
      thread_id: threadId,
      graph_id: 'coding_workflow',
      status: 'waiting_external_ci',
      metadata: {},
      values: {
        ci_run: {
          provider: 'github', external_id: '99', workflow: 'checks', status: 'running', conclusion: '',
          branch: 'feature/ARGUS-99', commit_sha: 'abcdef1234567890',
          run_url: 'https://github.com/argus/core/actions/runs/99', updated_at: '2026-07-31T12:00:05.000Z',
        },
        build_url: 'https://github.com/argus/core/actions/runs/99',
      },
      next: ['external_ci'],
      created_at: '2026-07-31T12:00:00.000Z',
      updated_at: '2026-07-31T12:00:05.000Z',
    });

    const card = await screen.findByLabelText('External CI/CD evidence');
    expect(card).toHaveTextContent('GitHub pipeline');
    expect(card).toHaveTextContent('feature/ARGUS-99');
    expect(within(card).getByRole('link', { name: 'Open GitHub CI run' })).toHaveAttribute('href', 'https://github.com/argus/core/actions/runs/99');
  });

  it('shows the immutable Agent resolution captured for a workflow run', async () => {
    renderPage({
      ...detail,
      agentContract: {
        schemaVersion: 1,
        capturedAt: '2026-07-31T12:00:00.000Z',
        contractFingerprint: 'a'.repeat(64),
        inferredLegacyContract: false,
        assignments: [{
          role: 'coder', label: 'Delivery Coder', stepIds: ['implement'], status: 'ready',
          agentId: 42, agentName: 'delivery_coder', agentLabel: 'Delivery Coder', agentMode: 'worker',
          model: 'gpt-5.6-terra', presetName: 'argus-dev-coder', installedPresetVersion: 3,
          skillNames: ['typescript'], bundleIds: [4], toolNames: ['github_get_file', 'workspace_write'],
          runtime: {
            type: 'codex', profileId: 5, profileName: 'codex-terra', profileLabel: 'Codex Terra',
            model: 'gpt-5.6-terra', state: 'ready', detail: 'Authenticated',
          },
          catalogFingerprint: 'b'.repeat(64), blockers: [], warnings: [],
          runs: [{
            traceId: '11111111-1111-4111-8111-111111111111', title: 'Delivery Coder',
            taskType: 'implement_ticket', status: 'completed', startedAt: '2026-07-31T12:00:01.000Z', durationMs: 2_300,
            runHref: '/runs/agent/11111111-1111-4111-8111-111111111111',
            traceHref: '/observe/logs?trace=11111111-1111-4111-8111-111111111111',
          }],
        }],
      },
    });

    const card = await screen.findByLabelText('Workflow Agent contract evidence');
    expect(card).toHaveTextContent('Delivery Coder');
    expect(card).toHaveTextContent('gpt-5.6-terra');
    expect(card).toHaveTextContent('Codex Terra');
    expect(card).toHaveTextContent('2 tools');
    fireEvent.click(within(card).getByText('Captured capabilities'));
    expect(card).toHaveTextContent('typescript');
    expect(card).toHaveTextContent('workspace_write');
    expect(card).toHaveTextContent('Contract aaaaaaaaaaaa');
    expect(within(card).getByRole('link', { name: 'Open Delivery Coder agent run' }))
      .toHaveAttribute('href', '/runs/agent/11111111-1111-4111-8111-111111111111');
    expect(within(card).getByRole('link', { name: 'Open Delivery Coder trace logs' }))
      .toHaveAttribute('href', '/observe/logs?trace=11111111-1111-4111-8111-111111111111');
  });

  it('opens on a waterfall and inspects redacted span input and output', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Execution waterfall' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /kubernetes_apply/ })).toBeInTheDocument();
    expect(screen.getByText('[REDACTED]', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('"ready": true', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Find correlated logs/ })).toHaveAttribute('href', '/observe/logs?q=kubernetes_apply');
  });

  it('keeps the chronological event view as a first-class alternate trace view', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Execution waterfall' });
    fireEvent.click(screen.getByRole('button', { name: /Timeline/ }));
    expect(screen.getByRole('heading', { name: 'Execution timeline' })).toBeInTheDocument();
    expect(screen.getAllByText('Deploy release completed').length).toBeGreaterThanOrEqual(1);
  });

  it('shows captured worker tokens and the classified termination reason', async () => {
    renderPage({
      ...detail,
      run: {
        ...detail.run,
        id: 'worker-trace',
        kind: 'agent',
        title: 'Coder',
        subtitle: 'argus-local-coder',
        inputTokens: 3210,
        outputTokens: 418,
        termination: 'token_limit',
      },
      metrics: { toolCallCount: 3 },
    }, '/runs/agent/worker-trace');

    expect(await screen.findByText('3628')).toBeInTheDocument();
    expect(screen.getAllByText('token limit').length).toBeGreaterThanOrEqual(1);
  });

  it('captures reviewer feedback on a native trace', async () => {
    const traceId = '11111111-1111-4111-8111-111111111111';
    renderPage({ ...detail, run: { ...detail.run, traceId } });

    expect(await screen.findByRole('heading', { name: 'Trace feedback' })).toBeInTheDocument();
    expect(await screen.findByText('Was this run useful and correct?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Positive' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Correction note' }), { target: { value: 'Correct and useful.' } });
    fireEvent.click(screen.getByRole('button', { name: 'accurate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));

    await waitFor(() => expect(api.submitTraceFeedback).toHaveBeenCalledWith(traceId, {
      label: 'overall',
      sentiment: 'positive',
      score: 1,
      comment: 'Correct and useful.',
      tags: ['accurate'],
    }));
  });

  it('renders correlated workflow and agent runs as a collapsible trace tree', async () => {
    renderPage({
      ...detail,
      run: {
        ...detail.run,
        traceId: '11111111-1111-4111-8111-111111111111',
        rootTraceId: '11111111-1111-4111-8111-111111111111',
      },
      traceFamily: {
        rootTraceId: '11111111-1111-4111-8111-111111111111',
        currentTraceId: '11111111-1111-4111-8111-111111111111',
        truncated: false,
        spansTruncated: false,
        runs: [
          {
            id: '11111111-1111-4111-8111-111111111111', parentTraceId: null, parentSpanId: null,
            kind: 'workflow', title: 'Release workflow', subtitle: 'coding_workflow · argus-langgraph', status: 'completed',
            startedAt: '2026-07-31T12:00:00.000Z', endedAt: '2026-07-31T12:00:06.000Z', durationMs: 6000,
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            parentTraceId: '11111111-1111-4111-8111-111111111111',
            parentSpanId: '33333333-3333-4333-8333-333333333333', kind: 'agent', title: 'Planner',
            subtitle: 'openai · gpt-5.1', status: 'completed', startedAt: '2026-07-31T12:00:01.000Z',
            endedAt: '2026-07-31T12:00:04.000Z', durationMs: 3000,
            href: '/runs/agent/22222222-2222-4222-8222-222222222222',
          },
        ],
        spans: [
          {
            id: '33333333-3333-4333-8333-333333333333', traceId: '11111111-1111-4111-8111-111111111111',
            parentSpanId: null, name: 'workflow.step.plan', kind: 'workflow', status: 'completed',
            startedAt: '2026-07-31T12:00:00.500Z', endedAt: '2026-07-31T12:00:04.500Z', durationMs: 4000,
            toolName: null, model: null, provider: null, error: null,
          },
          {
            id: '44444444-4444-4444-8444-444444444444', traceId: '22222222-2222-4222-8222-222222222222',
            parentSpanId: null, name: 'llm.iteration.1', kind: 'llm', status: 'completed',
            startedAt: '2026-07-31T12:00:02.000Z', endedAt: '2026-07-31T12:00:03.500Z', durationMs: 1500,
            toolName: null, model: 'gpt-5.1', provider: 'openai', error: null,
          },
          {
            id: '55555555-5555-4555-8555-555555555555', traceId: '22222222-2222-4222-8222-222222222222',
            parentSpanId: null, name: 'tool.fast_lookup', kind: 'tool', status: 'completed',
            startedAt: '2026-07-31T12:00:03.500Z', endedAt: '2026-07-31T12:00:03.700Z', durationMs: 200,
            toolName: 'fast_lookup', model: null, provider: null, error: null,
          },
        ],
        analysis: {
          criticalPath: [
            'run:11111111-1111-4111-8111-111111111111',
            'span:33333333-3333-4333-8333-333333333333',
            'run:22222222-2222-4222-8222-222222222222',
            'span:44444444-4444-4444-8444-444444444444',
          ],
          bottleneck: {
            key: 'span:44444444-4444-4444-8444-444444444444', id: '44444444-4444-4444-8444-444444444444',
            nodeType: 'span', kind: 'llm', label: 'llm.iteration.1', durationMs: 1500, selfTimeMs: 1500, sharePercent: 25,
          },
          totalDurationMs: 6000, maxConcurrency: 2, failedNodes: 0,
        },
        historicalBaseline: {
          selectedWindowDays: 7, confidence: 'high', sampleCount: 35,
          currentDurationMs: 6000, currentCostUsd: 0.0042,
          durationDeltaPercent: 50, costDeltaPercent: 40,
          durationState: 'warning', costState: 'normal',
          selected: {
            days: 7, sampleCount: 35, terminalCount: 36, medianDurationMs: 4000,
            p95DurationMs: 5500, medianCostUsd: 0.003, p95CostUsd: 0.005, successRate: 97.2,
          },
          windows: [
            { days: 7, sampleCount: 35, terminalCount: 36, medianDurationMs: 4000, p95DurationMs: 5500, medianCostUsd: 0.003, p95CostUsd: 0.005, successRate: 97.2 },
            { days: 30, sampleCount: 120, terminalCount: 124, medianDurationMs: 4200, p95DurationMs: 5700, medianCostUsd: 0.0031, p95CostUsd: 0.0052, successRate: 96.8 },
          ],
        },
        comparison: {
          baseline: {
            rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            startedAt: '2026-07-30T12:00:00.000Z', status: 'completed', durationMs: 5000,
            costUsd: 0.003, failedNodes: 0, href: '/runs/workflow/41',
          },
          current: {
            rootTraceId: '11111111-1111-4111-8111-111111111111', durationMs: 6000,
            costUsd: 0.0042, failedNodes: 1,
          },
          summary: {
            durationDeltaMs: 1000, durationDeltaPercent: 20, costDeltaUsd: 0.0012,
            costDeltaPercent: 40, failedNodeDelta: 1, regressionCount: 1, improvementCount: 0,
          },
          changes: [{
            signature: '/run:workflow:workflow.release#1/span:llm:llm.iteration.1#1',
            label: 'llm.iteration.1', kind: 'llm', nodeType: 'span', change: 'regression',
            currentStatus: 'completed', baselineStatus: 'completed', currentDurationMs: 1500,
            baselineDurationMs: 1000, durationDeltaMs: 500, durationDeltaPercent: 50,
            currentCostUsd: 0.0042, baselineCostUsd: 0.003, costDeltaUsd: 0.0012,
          }],
        },
      },
    }, '/runs/workflow/42?span=44444444-4444-4444-8444-444444444444', {
      generatedAt: '2026-07-31T12:00:06.000Z',
      traceId: '11111111-1111-4111-8111-111111111111',
      feedback: [{
        id: 17, traceId: '11111111-1111-4111-8111-111111111111', spanId: null,
        source: 'human', label: 'code_approval', score: 1, sentiment: 'positive',
        comment: 'Reviewed by the platform owner.', tags: ['human-approval'], metadata: null,
        createdByUserId: 7, createdByName: 'Ada', supersedesId: null,
        createdAt: '2026-07-31T12:00:04.750Z', updatedAt: '2026-07-31T12:00:04.750Z',
      }],
      summary: {
        activeCount: 1, humanCount: 1, modelCount: 0, averageScore: 1,
        sentiments: { positive: 1, neutral: 0, negative: 0, mixed: 0 },
        labels: [{ label: 'code_approval', count: 1, humanCount: 1, modelCount: 0, averageScore: 1 }],
      },
    });
    expect(await screen.findByRole('heading', { name: 'Distributed trace' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Span evidence')).toHaveTextContent('llm.iteration.1');
    expect(api.getSpanEvidence).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444');
    expect(screen.getByText('workflow.step.plan')).toBeInTheDocument();
    expect(screen.getByText('AUTOMATIC BOTTLENECK')).toBeInTheDocument();
    expect(screen.getByText('HISTORICAL BASELINE')).toBeInTheDocument();
    expect(screen.getByLabelText('Runtime trace summary')).toHaveTextContent('Argus LangGraph');
    expect(screen.getByLabelText('Runtime trace summary')).toHaveTextContent('Approval gates1');
    expect(screen.getByText('7-day performance envelope')).toBeInTheDocument();
    expect(screen.getByText('35 successful runs · high confidence')).toBeInTheDocument();
    expect(screen.getByText('RUN COMPARISON')).toBeInTheDocument();
    expect(screen.getByText('+20.0%')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ago/ })).toHaveAttribute('href', '/runs/workflow/41');
    expect(screen.getAllByText('50.0%', { exact: false }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: /fast_lookup/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Planner/ })).toHaveAttribute('href', '/runs/agent/22222222-2222-4222-8222-222222222222');
    expect(await screen.findByRole('button', { name: /Code Approval/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /llm\.iteration\.1/ }));
    expect(await screen.findByText('gpt-5.1')).toBeInTheDocument();
    expect(screen.getByLabelText('Span evidence')).toHaveTextContent('[REDACTED]');
    expect(screen.getByLabelText('Span evidence')).toHaveTextContent('150');
    expect(screen.getByRole('link', { name: /Correlated logs/ })).toHaveAttribute(
      'href',
      '/observe/logs?trace=22222222-2222-4222-8222-222222222222&span=44444444-4444-4444-8444-444444444444',
    );
    fireEvent.click(screen.getByRole('button', { name: /Focus critical path/ }));
    expect(screen.queryByRole('button', { name: /fast_lookup/ })).not.toBeInTheDocument();
    api.getSpanEvidence.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Release workflow/ }));
    expect(screen.getByLabelText('Run evidence')).toHaveTextContent('Trace root');
    expect(api.getSpanEvidence).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Code Approval/ }));
    expect(screen.getByLabelText('Approval evidence')).toHaveTextContent('Reviewed by the platform owner.');
    expect(screen.getByLabelText('Approval evidence')).toHaveTextContent('Ada');
    expect(screen.getByRole('link', { name: /Correlated logs/ })).toHaveAttribute(
      'href',
      '/observe/logs?root_trace=11111111-1111-4111-8111-111111111111',
    );
    fireEvent.click(screen.getByRole('button', { name: /Waterfall/ }));
    expect(screen.getByRole('heading', { name: 'Distributed waterfall' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workflow\.step\.plan/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Trace tree/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Release workflow' }));
    expect(screen.queryByRole('link', { name: /Planner/ })).not.toBeInTheDocument();
  });
});
