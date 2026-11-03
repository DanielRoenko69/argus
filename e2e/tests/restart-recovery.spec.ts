import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openMcpClient } from './helpers/mcpClient.js';

const phase = process.env.ARGUS_E2E_RECOVERY_PHASE ?? '';
const resultsDir = path.resolve(process.cwd(), 'test-results');
const authStatePath = path.join(resultsDir, 'restart-auth.json');
const recoveryStatePath = path.join(resultsDir, 'restart-state.json');

type RecoveryState = {
  workflowId: number;
  executionId: number;
  codingThreadId: string;
  ciRecoveryThreadId: string;
  codingA2aTaskId: string;
  complianceRunId: number;
  canaryRunId: number;
  connectorBundleId: number;
  connectorBackendId: number;
  connectorCapabilityId: number;
  governedAgentId: number;
  policyApiKeyId: number;
  policyApiKeyPrefix: string;
  policyApiKey: string;
};

type CodingState = {
  status?: string;
  values?: {
    ticket_id?: string;
    tests_passed?: boolean;
    review_passed?: boolean;
    human_approved?: boolean;
    branch_pushed?: boolean;
    branch_name?: string;
    commit_sha?: string;
    pr_approved?: boolean;
    pr_url?: string;
    delivery_status?: string;
    fix_applied?: boolean;
    retry_count?: number;
    ci_recovery_completed?: boolean;
    ci_run?: {
      provider?: string;
      external_id?: string;
      status?: string;
      conclusion?: string;
      branch?: string;
      commit_sha?: string;
      run_url?: string;
    } | null;
    bitbucket_creds?: { project_key?: string; repo_slug?: string } | null;
    log?: Array<{ step: string; summary: string }>;
  };
  next?: string[];
  tasks?: Array<{ interrupts?: unknown[] }>;
};

type CodingA2aTask = {
  id: string;
  status: { state: string };
  metadata: {
    workflowThreadId?: string;
    argusRootTraceId?: string;
    runtimeStatus?: string;
    executionGrantId?: string;
    executionPrincipal?: string;
    executionBundleIds?: number[];
    executionGrantExpiresAt?: string;
  };
  artifacts?: Array<{ parts: Array<{ data: {
    ticketId?: string;
    humanApproved?: boolean;
    testsPassed?: boolean;
    reviewPassed?: boolean;
  } }> }>;
};

async function api<T = unknown>(page: Page, requestPath: string, options: { method?: string; body?: unknown } = {}) {
  return page.evaluate(async ({ path: target, method, requestBody }) => {
    const response = await fetch(target, {
      method,
      headers: requestBody === undefined ? undefined : { 'content-type': 'application/json' },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body: body as T, text };
  }, { path: requestPath, method: options.method ?? 'GET', requestBody: options.body });
}

async function expectApi<T = unknown>(page: Page, requestPath: string, status: number, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await api<T>(page, requestPath, options);
  expect(response.status, `${options.method ?? 'GET'} ${requestPath}: ${response.text}`).toBe(status);
  return response.body;
}

async function chat(page: Page, agentId: number, sessionId: string, message: string): Promise<string> {
  const response = await api<string>(page, `/api/agents/${agentId}/sessions/${sessionId}/chat`, {
    method: 'POST',
    body: { message },
  });
  expect(response.status, response.text).toBe(200);
  expect(response.text).toContain('data: [DONE]');
  return response.text;
}

async function pollApi<T>(page: Page, requestPath: string, predicate: (body: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: Awaited<ReturnType<typeof api<T>>> | null = null;
  while (Date.now() < deadline) {
    latest = await api<T>(page, requestPath);
    if (latest.status === 200 && predicate(latest.body)) return latest.body;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out polling ${requestPath}. Last response: ${latest?.status ?? 'none'} ${latest?.text ?? ''}`);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#username').fill('e2e-admin');
  await page.locator('#password').fill('ArgusE2e42!');
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole('button', { name: 'Anmelden' }).click(),
  ]);
}

function isCodingInterrupt(state: CodingState): boolean {
  return state.values?.tests_passed === true
    && state.values?.review_passed === true
    && (state.next?.includes('human_approval') === true
      || state.tasks?.some(task => (task.interrupts?.length ?? 0) > 0) === true);
}

function isCiRecoveryApproval(state: CodingState): boolean {
  return state.values?.fix_applied === true
    && state.values?.tests_passed === true
    && (state.next?.includes('ci_recovery_approval') === true
      || state.tasks?.some(task => (task.interrupts?.length ?? 0) > 0) === true);
}

test('prepare persisted native and LangGraph checkpoints before Argus restart', async ({ browser }) => {
  test.skip(phase !== 'prepare', 'Only runs in the restart prepare phase.');
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page);

  const workflows = await expectApi<Array<{ id: number; name: string }>>(page, '/api/admin/workflows', 200);
  const workflow = workflows.find(item => item.name === 'e2e_governed_workflow');
  expect(workflow).toBeTruthy();

  const nativeExecution = await expectApi<{ executionId: number }>(page, `/api/workflows/${workflow!.id}/execute`, 200, {
    method: 'POST',
    body: { input: { recovery: 'argus-restart' } },
  });
  await pollApi<{ status: string }>(
    page,
    `/api/workflows/${workflow!.id}/runs/${nativeExecution.executionId}`,
    body => body.status === 'waiting_for_approval',
  );

  // The restart scenario is intentionally run through a browser session (so
  // the persisted checkpoint carries a real end-user identity). Ensure that
  // identity is allowed to use the three built-in workspace tools; otherwise
  // the user-policy hook correctly rejects the coder before it can reach its
  // human interrupt.
  const me = await expectApi<{ user: { id: number } }>(page, '/api/me', 200);
  const accessPolicies = await expectApi<{
    users: Array<{
      id: number;
      compositeIds: number[];
      agentIds: number[];
      rules: Array<{ toolPattern: string; effect: 'allow' | 'deny'; reason: string | null; expiresAt: string | null }>;
    }>;
  }>(page, '/api/ui/access-policies', 200);
  const currentPolicy = accessPolicies.users.find(user => user.id === me.user.id);
  await expectApi(page, '/api/ui/access-policies/users', 200, {
    method: 'PUT',
    body: {
      userId: me.user.id,
      compositeIds: currentPolicy?.compositeIds ?? [],
      agentIds: currentPolicy?.agentIds ?? [],
      rules: [
        ...(currentPolicy?.rules ?? []).filter(rule => rule.toolPattern !== 'workspace_*'),
        { toolPattern: 'workspace_*', effect: 'allow', reason: 'Restart recovery workspace grounding', expiresAt: null },
      ],
    },
  });

  await page.goto('/solutions/argus.dev');
  await page.getByRole('button', { name: 'New development run' }).click();
  await page.getByLabel(/Ticket ID/).fill('ARGUS-E2E-RESTART-1');
  await page.getByLabel(/Implementation brief/).fill('Persist this LangGraph human interrupt while the Argus control plane restarts.');
  // The bundle picker renders its checkboxes inside a horizontally scrollable
  // card. Use Playwright's idempotent check action so the journey works both
  // when a signed Pack manifest preselects the bundle and when an operator must
  // add it manually. Select the Git provider first because LangGraph uses the
  // first bundle as its credential source.
  const gitExecutionBundle = page.getByLabel(/Argus E2E Gitea/);
  await expect(gitExecutionBundle).toBeVisible();
  await gitExecutionBundle.evaluate((element: HTMLInputElement) => {
    if (!element.checked) element.click();
  });
  await expect(gitExecutionBundle).toBeChecked();
  const executionBundle = page.getByLabel(/E2E Observability/);
  await expect(executionBundle).toBeVisible();
  await executionBundle.evaluate((element: HTMLInputElement) => {
    if (!element.checked) element.click();
  });
  await expect(executionBundle).toBeChecked();
  const [codingStartResponse] = await Promise.all([
    page.waitForResponse(response => {
      if (!response.url().includes('/a2a/message') || response.request().method() !== 'POST') return false;
      try {
        const body = response.request().postDataJSON() as { data?: { operation?: string } } | null;
        return body?.data?.operation === 'workflow.start';
      } catch {
        return false;
      }
    }),
    page.getByRole('button', { name: 'Start Ticket to pull request' }).click(),
  ]);
  expect(codingStartResponse.status()).toBe(200);
  const codingRun = await codingStartResponse.json() as { rootTraceId: string; task: CodingA2aTask };
  await expect(page.locator('.solution-task-meta code').first()).toHaveText(codingRun.task.id);
  expect(codingRun.task.status.state).toBe('TASK_STATE_WORKING');
  expect(codingRun.task.metadata.workflowThreadId).toBe(codingRun.rootTraceId);
  expect(codingRun.task.metadata).toMatchObject({
    executionGrantId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    executionPrincipal: expect.stringMatching(/^user:\d+$/),
    executionBundleIds: expect.arrayContaining([expect.any(Number)]),
    executionGrantExpiresAt: expect.any(String),
  });
  expect(codingRun.task.metadata.executionBundleIds?.length).toBe(2);
  expect(codingRun.task.metadata.executionBundleIds?.[0]).toBeGreaterThan(0);
  const codingThreadId = codingRun.task.metadata.workflowThreadId!;
  await pollApi<CodingState>(page, `/api/coding/threads/${codingThreadId}`, isCodingInterrupt);
  const waitingA2aTask = await pollApi<{ task: CodingA2aTask }>(
    page,
    `/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/tasks/${codingRun.task.id}`,
    body => body.task?.status.state === 'TASK_STATE_INPUT_REQUIRED',
  );
  expect(waitingA2aTask.task.metadata).toMatchObject({
    workflowThreadId: codingThreadId,
    argusRootTraceId: codingThreadId,
    runtimeStatus: 'interrupted',
  });

  // Start a real provider-backed CI recovery graph. The failed provider run
  // id is encoded in the URL and must survive the fix and approval stages.
  const recoveryBundleId = codingRun.task.metadata.executionBundleIds?.[0] ?? 0;
  expect(recoveryBundleId).toBeGreaterThan(0);
  // Like every Argus Dev run, recovery starts through the governed Pack
  // boundary so Core binds the workspace and Git broker to its own grant.
  const recoveryStart = await expectApi<{ rootTraceId: string; task: CodingA2aTask }>(
    page,
    '/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/message',
    200,
    {
      method: 'POST',
      body: {
        text: 'Start ci-failure-recovery through the governed argus.dev runtime.',
        data: {
          operation: 'workflow.start',
          workflowId: 'ci-failure-recovery',
          input: {
            ticket_id: 'ARGUS-E2E-RECOVERY-1',
            repository: 'argus-e2e/argus-e2e-repo',
            branch_name: 'feature/ARGUS-E2E-RECOVERY-1',
            commit_sha: 'argus-e2e-recovery-sha',
            ci_provider: 'gitea',
            ci_workflow: 'Argus E2E Recovery CI',
            ci_run_url: 'http://fake-workspace:4200/argus-e2e/argus-e2e-repo/actions/runs/41',
            ci_failure_context: 'Argus E2E fixture: deterministic assertion failed in the provider test job.',
          },
        },
        execution: { bundleIds: [recoveryBundleId] },
      },
    },
  );
  expect(recoveryStart.task.status.state).toBe('TASK_STATE_WORKING');
  const recoveryRun = { thread_id: recoveryStart.task.metadata.workflowThreadId! };
  expect(recoveryRun.thread_id).toBe(recoveryStart.rootTraceId);
  const recoveryCheckpoint = await pollApi<CodingState>(
    page,
    `/api/coding/threads/${recoveryRun.thread_id}`,
    isCiRecoveryApproval,
    60_000,
  );
  expect(recoveryCheckpoint.values).toMatchObject({
    ticket_id: 'ARGUS-E2E-RECOVERY-1',
    fix_applied: true,
    tests_passed: true,
    ci_run: expect.objectContaining({ provider: 'gitea', external_id: '41', status: 'failure' }),
  });

  const compliance = await expectApi<{
    runs: Array<{ id: number; target: string; status: string }>;
  }>(page, '/api/ui/compliance', 200);
  const complianceRun = compliance.runs.find(run => run.target === 'argus-e2e-fabric');
  expect(complianceRun).toMatchObject({ status: 'completed' });
  const canaries = await expectApi<{
    history: Array<{ id: number; agentName: string; status: string; source: string }>;
  }>(page, '/api/ui/observability/canaries', 200);
  const canaryRun = canaries.history.find(run => run.agentName === 'E2E Operator');
  expect(canaryRun).toMatchObject({ status: 'ok', source: 'manual' });

  const fabric = await expectApi<{
    bundles: Array<{ id: number; name: string; backendIds: number[] }>;
    backends: Array<{ id: number; name: string; enabled: boolean; bundleIds: number[]; toolCount: number }>;
  }>(page, '/api/ui/mcp-fabric/manage', 200);
  const connectorBundle = fabric.bundles.find(item => item.name === 'e2e_observability');
  const connectorBackend = fabric.backends.find(item => item.name === 'e2e_prometheus');
  expect(connectorBundle).toBeTruthy();
  expect(connectorBackend).toMatchObject({
    enabled: true,
    bundleIds: [connectorBundle!.id],
    toolCount: 5,
  });
  expect(connectorBundle!.backendIds).toContain(connectorBackend!.id);
  const capabilities = await expectApi<{
    capabilities: Array<{ managedId: number | null; name: string; backendId: number | null; bundleIds: number[] }>;
  }>(page, '/api/ui/mcp-fabric/capabilities', 200);
  const connectorCapability = capabilities.capabilities.find(item => item.name === 'e2e_prometheus_query');
  expect(connectorCapability).toMatchObject({
    backendId: connectorBackend!.id,
    bundleIds: [connectorBundle!.id],
  });
  expect(connectorCapability?.managedId).toBeGreaterThan(0);
  const agents = await expectApi<Array<{ id: number; name: string; bundle_ids: number[] | null }>>(
    page,
    '/api/admin/agents',
    200,
  );
  const governedAgent = agents.find(item => item.name === 'e2e-operator');
  expect(governedAgent).toMatchObject({ bundle_ids: [connectorBundle!.id] });
  const restartPolicyKey = await expectApi<{
    id: number;
    key_prefix: string;
    api_key: string;
  }>(page, '/api/admin/api-keys', 201, {
    method: 'POST',
    body: {
      label: 'E2E Restart Policy Key',
      allowed_bundles: [connectorBundle!.id],
      allowed_tools: ['e2e_prometheus_*'],
      denied_tools: ['e2e_prometheus_query_range'],
      scope: 'both',
      enabled: true,
    },
  });

  await mkdir(resultsDir, { recursive: true });
  await context.storageState({ path: authStatePath });
  await writeFile(recoveryStatePath, JSON.stringify({
    workflowId: workflow!.id,
    executionId: nativeExecution.executionId,
    codingThreadId,
    ciRecoveryThreadId: recoveryRun.thread_id,
    codingA2aTaskId: codingRun.task.id,
    complianceRunId: complianceRun!.id,
    canaryRunId: canaryRun!.id,
    connectorBundleId: connectorBundle!.id,
    connectorBackendId: connectorBackend!.id,
    connectorCapabilityId: connectorCapability!.managedId!,
    governedAgentId: governedAgent!.id,
    policyApiKeyId: restartPolicyKey.id,
    policyApiKeyPrefix: restartPolicyKey.key_prefix,
    policyApiKey: restartPolicyKey.api_key,
  } satisfies RecoveryState, null, 2));
  await context.close();
});

test('resume native and retain LangGraph checkpoint after Argus restart', async ({ browser, request }) => {
  test.skip(phase !== 'resume', 'Only runs after the Argus restart.');
  const state = JSON.parse(await readFile(recoveryStatePath, 'utf8')) as RecoveryState;
  const context = await browser.newContext({ storageState: authStatePath });
  const page = await context.newPage();
  await page.goto('/home');
  // A runtime-only restart should preserve the session, but tolerate an
  // expired browser cookie when this phase is re-run independently during
  // local debugging.
  if (page.url().endsWith('/login')) await login(page);
  await expect(page).toHaveURL(/\/home$/);

  const me = await expectApi<{ user: { username: string; role: string } }>(page, '/api/me', 200);
  expect(me.user).toMatchObject({ username: 'e2e-admin', role: 'platform_admin' });

  const publicWidget = await api<string>(page, '/public/widget/e2e-support');
  expect(publicWidget.status).toBe(200);
  expect(publicWidget.text).toContain('E2E Public Assistant');

  const complianceEvidence = await expectApi<{
    run: { status: string; score: number };
    findings: Array<{ title: string }>;
  }>(page, `/api/ui/compliance/runs/${state.complianceRunId}`, 200);
  expect(complianceEvidence.run).toMatchObject({ status: 'completed', score: 67 });
  expect(complianceEvidence.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: 'Evidence-backed service controls' }),
  ]));
  const canaryEvidence = await expectApi<{
    history: Array<{ id: number; status: string; source: string }>;
  }>(page, '/api/ui/observability/canaries', 200);
  expect(canaryEvidence.history).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: state.canaryRunId, status: 'ok', source: 'manual' }),
  ]));

  const persistedFabric = await expectApi<{
    bundles: Array<{ id: number; backendIds: number[] }>;
    backends: Array<{ id: number; name: string; enabled: boolean; bundleIds: number[]; toolCount: number }>;
  }>(page, '/api/ui/mcp-fabric/manage', 200);
  expect(persistedFabric.bundles).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: state.connectorBundleId,
      backendIds: expect.arrayContaining([state.connectorBackendId]),
    }),
  ]));
  expect(persistedFabric.backends).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: state.connectorBackendId,
      name: 'e2e_prometheus',
      enabled: true,
      bundleIds: [state.connectorBundleId],
      toolCount: 5,
    }),
  ]));
  const persistedCapabilities = await expectApi<{
    capabilities: Array<{
      managedId: number | null;
      name: string;
      enabled: boolean;
      isWrite: boolean;
      riskLevel: string;
      bundleIds: number[];
    }>;
  }>(page, '/api/ui/mcp-fabric/capabilities', 200);
  expect(persistedCapabilities.capabilities).toEqual(expect.arrayContaining([
    expect.objectContaining({
      managedId: state.connectorCapabilityId,
      name: 'e2e_prometheus_query',
      enabled: true,
      isWrite: false,
      riskLevel: 'low',
      bundleIds: [state.connectorBundleId],
    }),
  ]));
  const connectorAfterRestart = await expectApi<{
    executed: boolean;
    response: { status: number; body: string; truncated: boolean };
  }>(page, `/api/ui/mcp-fabric/capabilities/${state.connectorCapabilityId}/playground`, 200, {
    method: 'POST',
    body: {
      parameters: { query: 'up', time: '2026-08-02T12:00:00Z' },
      execute: true,
    },
  });
  expect(connectorAfterRestart).toMatchObject({ executed: true, response: { status: 200, truncated: false } });
  expect(connectorAfterRestart.response.body).toContain('ARGUS_E2E_PROMETHEUS_OK');

  const agentsAfterRestart = await expectApi<Array<{ id: number; name: string; bundle_ids: number[] | null }>>(
    page,
    '/api/admin/agents',
    200,
  );
  expect(agentsAfterRestart).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: state.governedAgentId,
      name: 'e2e-operator',
      bundle_ids: [state.connectorBundleId],
    }),
  ]));
  const bundleSession = await expectApi<{ id: string }>(
    page,
    `/api/agents/${state.governedAgentId}/sessions`,
    201,
    { method: 'POST', body: {} },
  );
  const allowedBundleStream = await chat(
    page,
    state.governedAgentId,
    bundleSession.id,
    'Call the Prometheus bundle capability after restart.',
  );
  expect(allowedBundleStream).toContain('ARGUS_E2E_BUNDLE_ALLOWED');
  expect(allowedBundleStream).not.toContain('ARGUS_E2E_BUNDLE_ALLOWED_FAILED');
  const deniedBundleStream = await chat(
    page,
    state.governedAgentId,
    bundleSession.id,
    'Call the bundle-external status capability after restart.',
  );
  expect(deniedBundleStream).toContain('ARGUS_E2E_BUNDLE_DENIED');
  expect(deniedBundleStream).not.toContain('ARGUS_E2E_MCP_FIXTURE_OK');
  expect(deniedBundleStream).not.toContain('ARGUS_E2E_BUNDLE_BYPASS');
  const userDeniedStream = await chat(
    page,
    state.governedAgentId,
    bundleSession.id,
    'Call the Prometheus range capability as the direct user after restart.',
  );
  expect(userDeniedStream).toContain('ARGUS_E2E_PRINCIPAL_DENIED');
  expect(userDeniedStream).toContain('user-deny');
  expect(userDeniedStream).not.toContain('ARGUS_E2E_PROMETHEUS_RANGE_OK');

  const persistedGroupDeny = await expectApi<{
    decision: string;
    reason: string;
    steps: Array<{ key: string; outcome: string }>;
  }>(page, '/api/ui/access-policies/simulate', 200, {
    method: 'POST',
    body: {
      principalKind: 'group',
      principalId: 'argus-e2e-observability',
      toolName: 'e2e_prometheus_query_range',
    },
  });
  expect(persistedGroupDeny.decision).toBe('deny');
  expect(persistedGroupDeny.reason).toContain('group-deny');
  expect(persistedGroupDeny.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'group-rule-deny', outcome: 'matched' }),
  ]));

  const persistedKeys = await expectApi<Array<{
    id: number;
    key_prefix: string;
    allowed_bundles: number[];
    allowed_tools: string[];
    denied_tools: string[];
  }>>(page, '/api/admin/api-keys', 200);
  expect(persistedKeys).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: state.policyApiKeyId,
      key_prefix: state.policyApiKeyPrefix,
      allowed_bundles: [state.connectorBundleId],
      allowed_tools: ['e2e_prometheus_*'],
      denied_tools: ['e2e_prometheus_query_range'],
    }),
  ]));
  const restartMcpClient = await openMcpClient(request, state.policyApiKey);
  const restartCatalog = await restartMcpClient.send<{ tools: Array<{ name: string }> }>('tools/list');
  const restartToolNames = restartCatalog.result?.tools.map(tool => tool.name) ?? [];
  expect(restartToolNames).toContain('e2e_prometheus_query');
  expect(restartToolNames).not.toContain('e2e_fabric_fabric_status');
  const restartAllowedCall = await restartMcpClient.send<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>('tools/call', {
    name: 'e2e_prometheus_query',
    arguments: { query: 'argus_key_restart', time: '2026-08-02T12:30:00Z' },
  });
  expect(restartAllowedCall.result?.isError).not.toBe(true);
  expect(JSON.stringify(restartAllowedCall)).toContain('ARGUS_E2E_PROMETHEUS_OK');
  const restartDeniedCall = await restartMcpClient.send<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>('tools/call', {
    name: 'e2e_prometheus_query_range',
    arguments: {
      query: 'argus_key_restart',
      start: '2026-08-02T12:00:00Z',
      end: '2026-08-02T12:15:00Z',
      step: '1m',
    },
  });
  expect(restartDeniedCall.result?.isError).toBe(true);
  expect(JSON.stringify(restartDeniedCall)).toContain('für diesen API-Key nicht erlaubt');
  expect(JSON.stringify(restartDeniedCall)).not.toContain('ARGUS_E2E_PROMETHEUS_RANGE_OK');

  const keyAgentDenied = await request.post(`/api/agents/${state.governedAgentId}/chat`, {
    headers: { authorization: `Bearer ${state.policyApiKey}` },
    data: { message: 'Call the Prometheus range capability through the API key after restart.' },
  });
  const keyAgentDeniedText = await keyAgentDenied.text();
  expect(keyAgentDenied.status(), keyAgentDeniedText).toBe(200);
  expect(keyAgentDeniedText).toContain('ARGUS_E2E_PRINCIPAL_DENIED');
  expect(keyAgentDeniedText).not.toContain('ARGUS_E2E_PROMETHEUS_RANGE_OK');

  const nativeCheckpoint = await expectApi<{ status: string }>(
    page,
    `/api/workflows/${state.workflowId}/runs/${state.executionId}`,
    200,
  );
  expect(nativeCheckpoint.status).toBe('waiting_for_approval');
  const codingCheckpoint = await expectApi<CodingState>(page, `/api/coding/threads/${state.codingThreadId}`, 200);
  expect(isCodingInterrupt(codingCheckpoint)).toBe(true);
  const a2aCheckpoint = await pollApi<{ task: CodingA2aTask }>(
    page,
    `/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/tasks/${state.codingA2aTaskId}`,
    body => body.task?.status.state === 'TASK_STATE_INPUT_REQUIRED',
  );
  expect(a2aCheckpoint.task.metadata.workflowThreadId).toBe(state.codingThreadId);

  const commandCenterRun = page.locator(
    `a.run-row[href="/solutions/argus.dev?task=${state.codingA2aTaskId}"]`,
  );
  await expect(commandCenterRun).toContainText('Argus Dev · ARGUS-E2E-RESTART-1');
  await commandCenterRun.click();
  await expect(page).toHaveURL(new RegExp(`/solutions/argus\\.dev\\?task=${state.codingA2aTaskId}$`));
  const restartRunDialog = page.getByRole('dialog', { name: 'Argus Dev run ARGUS-E2E-RESTART-1' });
  await expect(restartRunDialog).toBeVisible();
  await expect(restartRunDialog.getByRole('heading', { name: /human approval required/i })).toBeVisible();

  const governance = await pollApi<{
    approvals: Array<{ runtimeApprovalId?: number; workflowExecutionId?: number }>;
  }>(page, '/api/ui/governance', body => body.approvals.some(item => item.workflowExecutionId === state.executionId));
  const nativeApproval = governance.approvals.find(item => item.workflowExecutionId === state.executionId);
  await expectApi(page, `/api/ui/governance/runtime-approvals/${nativeApproval!.runtimeApprovalId}/approve`, 200, {
    method: 'POST',
    body: { comment: 'Approved after Argus restart recovery certification.' },
  });
  const resumedNative = await pollApi<{
    status: string;
    step_results: Record<string, { status: string; result?: string }>;
  }>(page, `/api/workflows/${state.workflowId}/runs/${state.executionId}`, body => body.status === 'completed');
  expect(resumedNative.step_results.governed?.result).toContain('ARGUS_E2E_WRITE_EXECUTED');
  expect(resumedNative.step_results.response?.status).toBe('completed');

  // The CI recovery approval was persisted before the Argus restart. Resume
  // it now: the reviewed fix is pushed through the Core Git broker, and the
  // provider rerun, which the broker does not support yet, fails closed
  // without falling back to stored provider credentials.
  const recoveryCheckpoint = await expectApi<CodingState>(
    page,
    `/api/coding/threads/${state.ciRecoveryThreadId}`,
    200,
  );
  expect(isCiRecoveryApproval(recoveryCheckpoint)).toBe(true);
  await expectApi(page, `/api/coding/threads/${state.ciRecoveryThreadId}/resume`, 200, {
    method: 'POST',
    body: { approved: true, rationale: 'Recovery fix approved after Argus control-plane restart.' },
  });
  const recoveryPushed = await pollApi<CodingState>(
    page,
    `/api/coding/threads/${state.ciRecoveryThreadId}`,
    body => body.status === 'failed'
      && body.values?.ci_run?.conclusion === 'retry_trigger_failed'
      && body.values?.log?.some(entry => entry.step === 'external_ci_retry'
        && entry.summary.includes('not yet supported by the Core Git broker')) === true,
    60_000,
  );
  expect(recoveryPushed.values?.log?.map(entry => entry.step)).toEqual(expect.arrayContaining([
    'ci_recovery_tests', 'ci_recovery_review', 'ci_recovery_approval', 'finalize_build',
  ]));
  expect(recoveryPushed.values?.log?.find(entry => entry.step === 'finalize_build')?.summary).toContain('pushed feature/ARGUS-E2E-RECOVERY-1');
  expect(recoveryPushed.values?.delivery_status).toBe('ci_failed');

  await context.close();
});

test('resume LangGraph checkpoint after LangGraph runtime restart', async ({ browser, request }) => {
  test.skip(phase !== 'langgraph-resume', 'Only runs after the LangGraph runtime restart.');
  const state = JSON.parse(await readFile(recoveryStatePath, 'utf8')) as RecoveryState;
  const context = await browser.newContext({ storageState: authStatePath });
  const page = await context.newPage();
  await page.goto('/home');
  if (page.url().endsWith('/login')) await login(page);
  await expect(page).toHaveURL(/\/home$/);

  // The fail-closed recovery outcome is durable across the runtime restart.
  const persistedRecovery = await expectApi<CodingState>(
    page,
    `/api/coding/threads/${state.ciRecoveryThreadId}`,
    200,
  );
  expect(persistedRecovery.status).toBe('failed');
  expect(persistedRecovery.values).toMatchObject({
    delivery_status: 'ci_failed',
    ci_run: expect.objectContaining({ provider: 'gitea', conclusion: 'retry_trigger_failed' }),
  });

  const persistedCheckpoint = await expectApi<CodingState>(
    page,
    `/api/coding/threads/${state.codingThreadId}`,
    200,
  );
  expect(isCodingInterrupt(persistedCheckpoint)).toBe(true);
  expect(persistedCheckpoint.status).toBe('interrupted');
  const persistedA2aCheckpoint = await pollApi<{ task: CodingA2aTask }>(
    page,
    `/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/tasks/${state.codingA2aTaskId}`,
    body => body.task?.status.state === 'TASK_STATE_INPUT_REQUIRED',
  );
  expect(persistedA2aCheckpoint.task.metadata).toMatchObject({
    workflowThreadId: state.codingThreadId,
    runtimeStatus: 'interrupted',
  });

  await expectApi(page, `/api/coding/threads/${state.codingThreadId}/resume`, 200, {
    method: 'POST',
    body: {
      approved: true,
      rationale: 'Approval persisted across Argus and LangGraph runtime restarts.',
    },
  });
  const resumedAfterCodeApproval = await pollApi<CodingState>(
    page,
    `/api/coding/threads/${state.codingThreadId}`,
    body => body.values?.human_approved === true
      && body.values?.branch_pushed === true
      && (body.status === 'waiting_external_ci' || body.next?.includes('external_ci') === true)
      && body.values?.delivery_status === 'awaiting_ci',
  );
  expect(resumedAfterCodeApproval.values).toMatchObject({
    human_approved: true,
    branch_pushed: true,
    delivery_status: 'awaiting_ci',
  });

  const ciPayload = {
    workflow_run: {
      id: 142,
      name: 'Argus E2E CI',
      status: 'completed',
      conclusion: 'success',
      head_branch: resumedAfterCodeApproval.values?.branch_name,
      head_sha: resumedAfterCodeApproval.values?.commit_sha,
      html_url: 'http://fake-workspace:4200/argus-e2e/argus-e2e-repo/actions/runs/142',
    },
    repository: {
      full_name: `${resumedAfterCodeApproval.values?.bitbucket_creds?.project_key ?? 'argus-e2e'}/${resumedAfterCodeApproval.values?.bitbucket_creds?.repo_slug ?? 'argus-e2e-repo'}`,
    },
  };
  const ciRawBody = JSON.stringify(ciPayload);
  const ciSignature = createHmac('sha256', 'argus-e2e-ci-webhook-secret').update(ciRawBody).digest('hex');
  const ciCallback = await request.post('/api/coding/webhook/ci/gitea', {
    headers: {
      'content-type': 'application/json',
      'x-gitea-event': 'workflow_run',
      'x-gitea-signature': ciSignature,
    },
    data: ciPayload,
  });
  expect(ciCallback.status(), await ciCallback.text()).toBe(200);
  await expect.poll(async () => {
    const response = await api<CodingState>(page, `/api/coding/threads/${state.codingThreadId}`);
    return response.body;
  }, { timeout: 60_000 }).toMatchObject({
    status: 'interrupted',
    values: expect.objectContaining({ delivery_status: 'ci_passed' }),
    next: expect.arrayContaining(['human_approval_pr']),
  });

  // A Git-backed execution has a second, functional/PR approval gate. Resume
  // it as well and assert the synthetic provider returned a real PR URL.
  await expectApi(page, `/api/coding/threads/${state.codingThreadId}/resume`, 200, {
    method: 'POST',
    body: {
      approved: true,
      rationale: 'Functional verification persisted across the LangGraph runtime restart.',
    },
  });
  const resumedCoding = await pollApi<CodingState>(
    page,
    `/api/coding/threads/${state.codingThreadId}`,
    body => body.status === 'completed'
      && body.values?.human_approved === true
      && body.values?.branch_pushed === true
      && body.values?.pr_approved === true
      && Boolean(body.values?.pr_url)
      && body.values?.log?.some(entry => entry.step === 'finalize_build') === true
      && body.values?.log?.some(entry => entry.step === 'finalize_pr') === true
      && (body.next?.length ?? 0) === 0,
  );
  expect(resumedCoding.values?.ticket_id).toBe('ARGUS-E2E-RESTART-1');
  expect(resumedCoding.values).toMatchObject({
    human_approved: true,
    branch_pushed: true,
    pr_approved: true,
  });
  expect(resumedCoding.values?.pr_url).toContain('/pulls/42');

  const completedA2aTask = await pollApi<{ task: CodingA2aTask }>(
    page,
    `/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/tasks/${state.codingA2aTaskId}`,
    body => body.task?.status.state === 'TASK_STATE_COMPLETED',
  );
  expect(completedA2aTask.task.metadata).toMatchObject({
    workflowThreadId: state.codingThreadId,
    argusRootTraceId: state.codingThreadId,
    runtimeStatus: 'completed',
  });
  expect(completedA2aTask.task.artifacts?.[0]?.parts[0]?.data).toMatchObject({
    ticketId: 'ARGUS-E2E-RESTART-1',
    humanApproved: true,
    testsPassed: true,
    reviewPassed: true,
  });

  const approvalAudit = await expectApi<{
    entries: Array<{ thread_id: string; approved: boolean; rationale: string; row_hash: string }>;
  }>(page, '/api/admin/agent-approvals?limit=20', 200);
  expect(approvalAudit.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      thread_id: state.codingThreadId,
      approved: true,
      rationale: 'Approval persisted across Argus and LangGraph runtime restarts.',
      row_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  ]));
  await context.close();
});
