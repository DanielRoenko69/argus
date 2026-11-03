import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { openMcpClient } from './helpers/mcpClient.js';

type ApiResult<T> = { status: number; body: T; text: string };
type ApiOptions = { method?: string; body?: unknown; headers?: Record<string, string> };

async function api<T = unknown>(page: Page, path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
  const result = await page.evaluate(async ({ requestPath, method, requestBody, requestHeaders }) => {
    const response = await fetch(requestPath, {
      method,
      headers: {
        ...(requestBody === undefined ? {} : { 'content-type': 'application/json' }),
        ...(requestHeaders ?? {}),
      },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body, text };
  }, { requestPath: path, method: options.method ?? 'GET', requestBody: options.body, requestHeaders: options.headers ?? {} });
  return result as ApiResult<T>;
}

async function expectApi<T = unknown>(page: Page, path: string, expectedStatus: number, options: ApiOptions = {}): Promise<T> {
  const result = await api<T>(page, path, options);
  expect(result.status, `${options.method ?? 'GET'} ${path}: ${result.text}`).toBe(expectedStatus);
  return result.body;
}

async function pollApi<T>(
  page: Page,
  path: string,
  predicate: (body: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: ApiResult<T> | null = null;
  while (Date.now() < deadline) {
    latest = await api<T>(page, path);
    if (latest.status === 200 && predicate(latest.body)) return latest.body;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out polling ${path}. Last response: ${latest?.status ?? 'none'} ${latest?.text ?? ''}`);
}

async function chat(page: Page, agentId: number, sessionId: string, message: string): Promise<string> {
  const result = await page.evaluate(async ({ id, sid, prompt }) => {
    const response = await fetch(`/api/agents/${id}/sessions/${sid}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: prompt }),
    });
    return { status: response.status, text: await response.text() };
  }, { id: agentId, sid: sessionId, prompt: message });
  expect(result.status, result.text).toBe(200);
  expect(result.text).toContain('data: [DONE]');
  return result.text;
}

async function registerFirstAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Ersten Administrator anlegen' })).toBeVisible();
  await page.locator('#username').fill('e2e-admin');
  await page.locator('#display_name').fill('Argus E2E Admin');
  await page.locator('#password').fill('ArgusE2e42!');
  await page.locator('#password_confirm').fill('ArgusE2e42!');
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole('button', { name: 'Registrieren' }).click(),
  ]);
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole('button', { name: 'Anmelden' }).click(),
  ]);
}

async function loginWithKeycloak(
  page: Page,
  username: string,
  expectedLanding: '/home' | '/chat',
): Promise<string> {
  let callbackUrl = '';
  const captureCallback = (event: { url(): string }) => {
    if (event.url().startsWith('http://argus:3000/auth/oidc/callback?')) callbackUrl = event.url();
  };
  page.on('request', captureCallback);
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Mit Keycloak anmelden' })).toBeVisible();
  await page.getByRole('link', { name: 'Mit Keycloak anmelden' }).click();
  await expect(page.locator('#username')).toBeVisible();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill('ArgusE2e42!');
  await Promise.all([
    page.waitForURL(`http://argus:3000${expectedLanding}`),
    page.locator('#kc-login').click(),
  ]);
  page.off('request', captureCallback);
  expect(callbackUrl).toContain('/auth/oidc/callback?');
  return callbackUrl;
}

test('fresh Argus install certifies auth, LLM, agent, public widget, RAG, connector templates, MCP, compliance, native workflow and LangGraph approval-resume', async ({ browser, request }) => {
  // This is deliberately a broad product certification rather than a small
  // component test. Slower developer laptops need a larger orchestration
  // budget; individual polling and network operations retain tighter limits.
  test.setTimeout(300_000);
  test.skip(
    ['resume', 'langgraph-resume'].includes(process.env.ARGUS_E2E_RECOVERY_PHASE ?? ''),
    'Golden Path already completed before the restart phase.',
  );
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await registerFirstAdmin(admin);

  const me = await expectApi<{ user: { id: number; role: string; username: string }; aiTransparency: { enabled: boolean } }>(admin, '/api/me', 200);
  expect(me.user).toMatchObject({ role: 'platform_admin', username: 'e2e-admin' });
  expect(me.aiTransparency.enabled).toBe(true);

  const solutionPacks = await expectApi<{
    total: number;
    packs: Array<{
      configuredId: string;
      state: string;
      manifest?: {
        metadata: { id: string; version: string };
        spec: { components: { workflows: string[] } };
      };
      health?: { ok: boolean };
      readiness?: { ok: boolean };
    }>;
  }>(admin, '/api/admin/solution-packs/refresh', 200, { method: 'POST' });
  expect(solutionPacks.total).toBe(1);
  expect(solutionPacks.packs[0]).toMatchObject({
    configuredId: 'argus.dev',
    state: 'ready',
    manifest: { metadata: { id: 'argus.dev', version: '0.4.0' } },
    health: { ok: true },
    readiness: { ok: true },
  });
  expect(solutionPacks.packs[0]?.manifest?.spec.components.workflows).toContain('ticket-to-pull-request');
  expect(solutionPacks.packs[0]?.manifest?.spec.components.workflows).toContain('pull-request-review');

  const packDiff = await expectApi<{
    packId: string;
    revision: number;
    currentVersion: string | null;
    previousVersion: string | null;
    rollbackAvailable: boolean;
    changes: unknown[];
  }>(admin, '/api/admin/solution-packs/argus.dev/diff', 200);
  expect(packDiff).toMatchObject({
    packId: 'argus.dev',
    currentVersion: '0.4.0',
    previousVersion: null,
    rollbackAvailable: false,
  });
  expect(packDiff.revision).toBeGreaterThan(0);
  expect(Array.isArray(packDiff.changes)).toBe(true);
  const rollbackConfirmation = await expectApi<{ code: string }>(admin, '/api/admin/solution-packs/argus.dev/rollback', 400, {
    method: 'POST',
    body: { reason: 'missing explicit confirmation' },
  });
  expect(rollbackConfirmation.code).toBe('rollback_confirmation_required');

  await admin.goto('/solutions/argus.dev');
  await expect(admin.getByRole('heading', { name: 'Argus Dev', level: 1 })).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Ticket to pull request' })).toBeVisible();
  await expect(admin.getByRole('button', { name: /Pull request review/ })).toBeVisible();
  await expect(admin.getByText('coding-orchestrator')).toBeVisible();
  await expect(admin.getByText('Functional gate')).toBeVisible();

  const githubBrandAsset = await request.get('/console-assets/brand/github.svg');
  expect(githubBrandAsset.status()).toBe(200);
  expect(githubBrandAsset.headers()['content-type']).toContain('image/svg+xml');
  expect(await githubBrandAsset.text()).toContain('<title>GitHub</title>');

  const initialAgents = await expectApi<unknown[]>(admin, '/api/admin/agents', 200);
  expect(initialAgents).toEqual([]);

  const provider = await expectApi<{ id: number }>(admin, '/api/ui/llm/providers', 201, {
    method: 'POST',
    body: {
      name: 'e2e-openai-compatible',
      label: 'E2E OpenAI Compatible',
      providerType: 'openai-compatible',
      baseUrl: 'http://fake-openai:4000/v1',
      authType: 'none',
      secretName: null,
      credentialProfileId: null,
      enabled: true,
    },
  });
  const providerTest = await expectApi<{ ok: boolean; models: string[] }>(admin, `/api/ui/llm/providers/${provider.id}/test`, 200, { method: 'POST' });
  expect(providerTest.ok).toBe(true);
  expect(providerTest.models).toContain('e2e-chat');

  await expectApi(admin, '/api/ui/llm/models', 201, {
    method: 'POST',
    body: {
      modelName: 'e2e-chat',
      displayName: 'Argus E2E Chat',
      providerId: provider.id,
      upstreamModelName: 'e2e-chat',
      enabled: true,
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: false,
      maxInputTokens: 8192,
      maxOutputTokens: 2048,
      inputCostPer1k: 0,
      outputCostPer1k: 0,
    },
  });

  await expectApi(admin, '/api/admin/users', 201, {
    method: 'POST',
    body: {
      username: 'e2e-viewer',
      password: 'ViewerPass42!',
      display_name: 'Argus E2E Viewer',
      role: 'viewer',
      enabled: true,
    },
  });

  const agent = await expectApi<{ id: number; risk_level: string; human_oversight_required: boolean }>(admin, '/api/admin/agents', 201, {
    method: 'POST',
    body: {
      name: 'e2e-operator',
      label: 'E2E Operator',
      description: 'Deterministic release certification agent',
      model: 'e2e-chat',
      system_prompt: 'Operate only inside the deterministic Argus E2E environment.',
      enabled: true,
      agent_mode: 'chat',
      max_iterations: 5,
      visibility: 'public',
      min_role: 'viewer',
      risk_level: 'high',
      human_oversight_required: true,
      untrusted_tool_output_enforcement: true,
    },
  });
  expect(agent).toMatchObject({ risk_level: 'high', human_oversight_required: true });

  // Certify the native Public Widget administration and the real anonymous
  // runtime in the disposable E2E world. Production remains fail-closed by
  // default; compose.e2e.yml opts in explicitly for this security boundary.
  await admin.goto('/build/public-widgets');
  await expect(admin.getByRole('heading', { name: 'Public channels', exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Create widget' }).click();
  const widgetEditor = admin.getByRole('dialog', { name: 'Create public widget' });
  await widgetEditor.getByLabel('Widget slug').fill('e2e-support');
  await widgetEditor.getByLabel('Widget title').fill('E2E Public Assistant');
  await widgetEditor.getByLabel('Allowed origins').fill('http://argus:3000\nhttp://fake-workspace:4200');
  await widgetEditor.getByLabel('Widget greeting').fill('E2E Public Assistant');
  await widgetEditor.getByRole('button', { name: 'Create widget' }).click();
  await expect(admin.getByRole('heading', { name: 'E2E Public Assistant' })).toBeVisible();
  await expect(admin.getByText('Publicly reachable')).toBeVisible();

  const publicWidgets = await expectApi<{
    masterEnabled: boolean;
    widgets: Array<{ id: number; slug: string; agentId: number; runtimeState: string; allowedOrigins: string[] }>;
  }>(admin, '/api/ui/public-widgets', 200);
  expect(publicWidgets.masterEnabled).toBe(true);
  expect(publicWidgets.widgets).toEqual(expect.arrayContaining([
    expect.objectContaining({
      slug: 'e2e-support',
      agentId: agent.id,
      runtimeState: 'active',
      allowedOrigins: ['http://argus:3000', 'http://fake-workspace:4200'],
    }),
  ]));

  await admin.getByRole('button', { name: 'Edit' }).click();
  const widgetEdit = admin.getByRole('dialog', { name: 'Edit e2e-support' });
  await widgetEdit.getByLabel('Daily token cap').fill('60000');
  await widgetEdit.getByRole('button', { name: 'Save changes' }).click();
  await expect(admin.getByText('Public widget updated.')).toBeVisible();
  const updatedWidgets = await expectApi<{ widgets: Array<{ slug: string; dailyTokenCap: number }> }>(admin, '/api/ui/public-widgets', 200);
  expect(updatedWidgets.widgets).toEqual(expect.arrayContaining([
    expect.objectContaining({ slug: 'e2e-support', dailyTokenCap: 60_000 }),
  ]));

  const publicPageResponse = await admin.goto('/public/widget/e2e-support');
  expect(publicPageResponse?.status()).toBe(200);
  await expect(admin).toHaveTitle('E2E Public Assistant');
  await expect(admin.locator('#chatAgentName')).toHaveText('E2E Public Assistant');
  await expect(admin.getByLabel('AI interaction notice')).toBeVisible();

  // A real iframe navigation does not reliably carry an Origin header. The
  // response must therefore derive frame-ancestors from the stored allowlist,
  // while the browser verifies the actual ancestor origin.
  await admin.goto('http://fake-workspace:4200/health');
  await admin.setContent('<iframe title="Argus public widget" src="http://argus:3000/public/widget/e2e-support"></iframe>');
  await expect(admin.frameLocator('iframe[title="Argus public widget"]').locator('#chatAgentName')).toHaveText('E2E Public Assistant');
  await admin.goto('http://argus:3000/home');

  // Certify native Runtime Controls: encrypted secret lifecycle, real signed
  // dry run, fail-closed posture and browser-safe response projection.
  await admin.goto('/governance/runtime-controls');
  await expect(admin.getByRole('heading', { name: 'Execution policies', exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Add external policy' }).click();
  const runtimeEditor = admin.getByRole('dialog', { name: 'Create runtime policy' });
  await runtimeEditor.getByLabel('Policy name').fill('e2e_change_freeze');
  await runtimeEditor.getByLabel('Policy description').fill('Deterministic signed policy gate');
  await runtimeEditor.getByLabel('Webhook URL').fill('http://fake-mcp:4100/policy/decide');
  await runtimeEditor.getByLabel('Tool patterns').fill('e2e_fabric_fabric_status');
  await runtimeEditor.getByLabel('HMAC secret').fill('argus-e2e-policy-secret');
  await runtimeEditor.getByRole('button', { name: 'Create policy' }).click();
  await expect(admin.getByRole('heading', { name: 'e2e_change_freeze' })).toBeVisible();
  await expect(admin.getByText('Deny · closed')).toBeVisible();
  await expect(admin.getByText('HMAC SHA-256')).toBeVisible();

  const runtimeCatalog = await expectApi<{
    hooks: Array<{ name: string; priority: number }>;
    policies: Array<{ id: number; name: string; hasHmacSecret: boolean; onFailure: string }>;
  }>(admin, '/api/ui/runtime-controls', 200);
  expect(runtimeCatalog.hooks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'external-policy-filter', priority: 800 }),
  ]));
  const runtimePolicy = runtimeCatalog.policies.find(item => item.name === 'e2e_change_freeze');
  expect(runtimePolicy).toMatchObject({ hasHmacSecret: true, onFailure: 'deny' });
  expect(JSON.stringify(runtimeCatalog)).not.toContain('argus-e2e-policy-secret');

  await admin.getByRole('button', { name: 'Test' }).click();
  const runtimeTest = admin.getByRole('dialog', { name: 'Test e2e_change_freeze' });
  await runtimeTest.getByLabel('Test tool name').fill('e2e_fabric_fabric_status');
  await runtimeTest.getByLabel('Test arguments').fill('{}');
  await runtimeTest.getByRole('button', { name: 'Run policy test' }).click();
  await expect(runtimeTest.getByText('Request denied')).toBeVisible();
  await expect(runtimeTest.getByText(/HMAC signed/)).toBeVisible();
  await runtimeTest.getByRole('button', { name: 'Close', exact: true }).click();

  // LangGraph resolves these roles by stable name, never by environment-
  // specific SERIAL ids. A clean install therefore remains portable.
  const codingAgents = new Map<string, number>();
  for (const name of ['planner', 'knowledge', 'coder', 'reviewer', 'researcher']) {
    const codingAgent = await expectApi<{ id: number }>(admin, '/api/admin/agents', 201, {
      method: 'POST',
      body: {
        name,
        label: `E2E ${name[0]!.toUpperCase()}${name.slice(1)}`,
        description: `Deterministic LangGraph ${name} role`,
        model: 'e2e-chat',
        system_prompt: `Act as the deterministic ${name} role for Argus release certification.`,
        enabled: true,
        agent_mode: name === 'reviewer' ? 'reviewer' : 'worker',
        max_iterations: 4,
        visibility: 'internal',
        min_role: 'viewer',
        risk_level: 'low',
        human_oversight_required: false,
        untrusted_tool_output_enforcement: true,
      },
    });
    codingAgents.set(name, codingAgent.id);
  }
  expect(new Set(codingAgents.values()).size).toBe(5);

  // Core -> external Solution Pack is a real authenticated A2A v1 boundary.
  // The preflight is intentionally read-only: the later coding test certifies
  // the full LangGraph execution, rejection/rework and approval/resume path.
  const a2aPreflight = await expectApi<{
    rootTraceId: string;
    agentCard: {
      name: string;
      version: string;
      supportedInterfaces: Array<{ protocolBinding: string; protocolVersion: string }>;
      skills: Array<{ id: string }>;
    };
    task: {
      id: string;
      contextId: string;
      status: { state: string };
      metadata: { argusRootTraceId: string; argusPackId: string; argusAgentId: string };
      artifacts: Array<{ parts: Array<{ data: {
        ready: boolean;
        workflowId: string;
        engine: string;
         toolTransport: string;
         approvalGates: string[];
         workflows: Array<{
           id: string;
           requiredBundleCategories: string[];
           recommendedBundleCategories?: string[];
         }>;
         requiredAgents: Array<{ name: string; id: number }>;
      } }> }>;
    };
  }>(admin, '/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/message', 200, {
    method: 'POST',
    body: {
      text: 'Verify the governed ticket-to-pull-request workflow boundary.',
      data: { operation: 'coding.preflight' },
    },
  });
  expect(a2aPreflight.agentCard).toMatchObject({
    name: 'Argus Dev Coding Orchestrator',
    version: '0.4.0',
    supportedInterfaces: [{ protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
  });
  expect(a2aPreflight.agentCard.skills).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'coding-preflight' }),
    expect.objectContaining({ id: 'ticket-to-pull-request' }),
    expect.objectContaining({ id: 'pull-request-review' }),
  ]));
  expect(a2aPreflight.task).toMatchObject({
    status: { state: 'TASK_STATE_COMPLETED' },
    metadata: {
      argusRootTraceId: a2aPreflight.rootTraceId,
      argusPackId: 'argus.dev',
      argusAgentId: 'coding-orchestrator',
    },
  });
  const a2aEvidence = a2aPreflight.task.artifacts[0]!.parts[0]!.data;
  expect(a2aEvidence).toMatchObject({
    ready: true,
    workflowId: 'ticket-to-pull-request',
    engine: 'langgraph',
    toolTransport: 'MCP',
    approvalGates: expect.arrayContaining([
      'code_approval',
      'functional_approval',
      'pr_review_approval',
      'ci_recovery_approval',
      'security_fix_approval',
      'security_pr_approval',
      'release_approval',
      'backlog_approval',
    ]),
  });
  expect(a2aEvidence.requiredAgents.map(item => item.name).sort()).toEqual(
    [...codingAgents.keys()].sort(),
  );
  expect(new Set(a2aEvidence.requiredAgents.map(item => item.id))).toEqual(new Set(codingAgents.values()));
  const workflowCapabilities = new Map(a2aEvidence.workflows.map(workflow => [workflow.id, workflow.requiredBundleCategories]));
  expect(workflowCapabilities).toEqual(new Map([
    ['ticket-to-pull-request', ['repository', 'repository-checkout', 'ci']],
    ['ticket-to-image-pull-request', ['repository', 'repository-checkout', 'ci']],
    ['ticket-follow-up-image-pull-request', ['repository', 'repository-checkout', 'ci']],
    ['pull-request-review', ['repository', 'repository-checkout']],
    ['ci-failure-recovery', ['repository', 'repository-checkout', 'ci']],
    ['security-remediation', ['repository', 'repository-checkout', 'security']],
    ['release-notes', ['repository', 'repository-checkout']],
    ['backlog-grooming', ['repository', 'repository-checkout']],
  ]));

  const persistedA2aTask = await expectApi<{ task: typeof a2aPreflight.task }>(
    admin,
    `/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/tasks/${a2aPreflight.task.id}`,
    200,
  );
  expect(persistedA2aTask.task).toMatchObject({
    id: a2aPreflight.task.id,
    contextId: a2aPreflight.task.contextId,
    status: a2aPreflight.task.status,
    metadata: {
      argusRootTraceId: a2aPreflight.rootTraceId,
      argusPackId: 'argus.dev',
      argusAgentId: 'coding-orchestrator',
    },
    artifacts: [a2aPreflight.task.artifacts[0]],
  });
  expect(a2aPreflight.task.metadata).toHaveProperty('coreRuntimeSelection');
  expect(a2aPreflight.task.artifacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Argus Core runtime selection' }),
  ]));
  const terminalCancellation = await api<{ code: string; error: string }>(
    admin,
    `/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/tasks/${a2aPreflight.task.id}/cancel`,
    { method: 'POST', body: {} },
  );
  expect(terminalCancellation.status).toBe(400);
  expect(terminalCancellation.body).toMatchObject({ code: 'peer_rejected' });
  expect(terminalCancellation.body.error).toContain('not cancelable');

  await expectApi(admin, '/api/ui/access-policies/users', 200, {
    method: 'PUT',
    body: {
      userId: me.user.id,
      compositeIds: [],
      agentIds: [agent.id],
      rules: [
        { toolPattern: 'e2e_fabric_*', effect: 'allow', reason: 'Deterministic remote MCP certification', expiresAt: null },
        { toolPattern: 'jira_create_issue', effect: 'allow', reason: 'Human-approval certification', expiresAt: null },
      ],
    },
  });

  const session = await expectApi<{ id: string }>(admin, `/api/agents/${agent.id}/sessions`, 201, { method: 'POST', body: {} });
  expect(await chat(admin, agent.id, session.id, 'Run the normal deterministic chat check.')).toContain('ARGUS_E2E_CHAT_OK');

  // Synthetic Canary Operations use the real non-streaming Agent Chat route
  // with a deployment-managed service credential. Keep the scheduler off in
  // this deterministic gate and certify an explicit, cost-visible manual run.
  await expectApi(admin, '/api/ui/observability/canaries/config', 200, {
    method: 'PUT',
    body: {
      enabled: false,
      intervalMinutes: 15,
      timeoutSeconds: 10,
      retentionDays: 30,
      agentIds: [agent.id],
    },
  });
  const canaryExecution = await expectApi<{
    results: Array<{ agentId: number; status: string; latencyMs: number }>;
    operations: { history: Array<{ id: number; agentId: number; status: string; source: string }> };
  }>(admin, '/api/ui/observability/canaries/run', 200, { method: 'POST', body: { agentIds: [agent.id] } });
  expect(canaryExecution.results).toEqual([
    expect.objectContaining({ agentId: agent.id, status: 'ok' }),
  ]);
  expect(canaryExecution.operations.history).toEqual(expect.arrayContaining([
    expect.objectContaining({ agentId: agent.id, status: 'ok', source: 'manual' }),
  ]));
  expect(JSON.stringify(canaryExecution)).not.toContain('ARGUS_E2E_CHAT_OK');
  expect(JSON.stringify(canaryExecution)).not.toContain('argus-e2e-service-key');

  await admin.goto('/observe/health');
  await expect(admin.getByRole('heading', { name: 'Agent canaries' })).toBeVisible();
  await expect(admin.getByText('Scheduler disabled')).toBeVisible();
  await expect(admin.getByText('E2E Operator').first()).toBeVisible();
  await expect(admin.getByText('Persistent run evidence')).toBeVisible();

  const knowledge = await expectApi<{ id: number }>(admin, '/api/admin/rag-indexes', 201, {
    method: 'POST',
    body: {
      name: 'e2e-knowledge',
      label: 'E2E Knowledge',
      description: 'Deterministic built-in knowledge source',
      provider: 'pgvector',
      endpoint: '',
      index_name: '',
      adapter_config: {},
      top_k: 3,
      enabled: true,
    },
  });
  const upload = await admin.evaluate(async id => {
    const form = new FormData();
    form.append('files', new File([
      '# Argus E2E Runbook\n\nThe release certification secret is ARGUS_KNOWLEDGE_SECRET_42.\n',
    ], 'argus-e2e-runbook.md', { type: 'text/markdown' }));
    const response = await fetch(`/api/admin/rag-indexes/${id}/upload`, { method: 'POST', body: form });
    return { status: response.status, text: await response.text() };
  }, knowledge.id);
  expect(upload.status, upload.text).toBe(200);
  expect(JSON.parse(upload.text).documents).toHaveLength(1);
  await expectApi(admin, `/api/admin/agents/${agent.id}/rag-indexes`, 200, { method: 'PUT', body: { rag_index_ids: [knowledge.id] } });

  const ragStream = await chat(admin, agent.id, session.id, 'What is the release certification secret in the runbook?');
  expect(ragStream).toContain('ARGUS_E2E_RAG_FOUND');
  expect(ragStream).toContain('argus-e2e-runbook.md');
  const persisted = await expectApi<{ messages: Array<{ role: string; content: string | null; citations?: Array<{ source: string }> }> }>(admin, `/api/agents/${agent.id}/sessions/${session.id}`, 200);
  expect(persisted.messages.some(message => message.role === 'assistant' && message.citations?.some(citation => citation.source === 'argus-e2e-runbook.md'))).toBe(true);

  // Certify the native connector-template path against a deterministic local
  // Prometheus-compatible fixture: governed bundle first, UI install staged,
  // server-side health test, explicit activation and a real read execution.
  const connectorBundle = await expectApi<{ bundle: { id: number; name: string; label: string } }>(admin, '/api/ui/mcp-fabric/bundles', 201, {
    method: 'POST',
    body: {
      name: 'e2e_observability',
      label: 'E2E Observability',
      description: 'Governed connector-template certification boundary',
      icon: '◉',
      agentRole: null,
      systemPrompt: null,
      backendIds: [],
      skillIds: [],
      toolPolicies: [],
    },
  });

  await admin.goto('/mcp-fabric');
  await expect(admin.getByRole('heading', { name: 'MCP Fabric', exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Connector templates' }).click();
  const connectorCatalog = admin.getByRole('dialog', { name: 'Install governed connectors' });
  await expect(connectorCatalog.getByText('51 connector blueprints')).toBeVisible();
  await connectorCatalog.getByPlaceholder('Search connectors and capabilities').fill('Prometheus');
  await connectorCatalog.getByRole('heading', { name: 'Prometheus', exact: true }).click();
  const prometheusBrand = connectorCatalog.getByRole('complementary').getByRole('img', { name: 'Prometheus logo' });
  await expect(prometheusBrand).toBeVisible();
  const prometheusImage = prometheusBrand.locator('img');
  await expect(prometheusImage).toHaveAttribute('src', '/console-assets/brand/prometheus.svg');
  await expect.poll(() => prometheusImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await connectorCatalog.getByLabel('Technical prefix').fill('e2e_prometheus');
  await connectorCatalog.getByLabel('Required access bundle').selectOption(String(connectorBundle.bundle.id));
  await connectorCatalog.getByLabel('Prometheus URL').fill('http://fake-mcp:4100');
  await connectorCatalog.getByLabel('Authentifizierung').selectOption('none');
  await connectorCatalog.getByRole('button', { name: 'Install staged connector' }).click();
  await expect(admin.getByText('Connector “e2e_prometheus” was staged with 5 capabilities.')).toBeVisible();

  type FabricManagement = {
    bundles: Array<{ id: number; backendIds: number[]; toolCount: number }>;
    backends: Array<{
      id: number;
      name: string;
      description: string;
      type: 'http' | 'mcp' | 'builtin';
      enabled: boolean;
      baseUrl: string;
      mcpEndpoint: string | null;
      authType: 'none' | 'bearer' | 'basic' | 'header';
      healthPath: string | null;
      defaultHeaders: Record<string, string>;
      timeoutMs: number;
      tlsSkipVerify: boolean;
      authMode: 'service-account' | 'permissive' | 'strict';
      oauthAuthorizeUrl: string | null;
      oauthTokenUrl: string | null;
      oauthClientId: string | null;
      oauthScopes: string[];
      oauthRevokeUrl: string | null;
      bundleIds: number[];
      toolCount: number;
    }>;
    tools: Array<{ backendId: number | null; name: string; enabled: boolean; isWrite: boolean; bundleIds: number[] }>;
  };
  const stagedFabric = await pollApi<FabricManagement>(
    admin,
    '/api/ui/mcp-fabric/manage',
    body => body.backends.some(item => item.name === 'e2e_prometheus'),
  );
  const stagedConnector = stagedFabric.backends.find(item => item.name === 'e2e_prometheus');
  expect(stagedConnector).toMatchObject({
    type: 'http',
    enabled: false,
    baseUrl: 'http://fake-mcp:4100',
    healthPath: '/api/v1/status/buildinfo',
    toolCount: 5,
    bundleIds: [connectorBundle.bundle.id],
  });
  const stagedCapabilities = stagedFabric.tools.filter(item => item.backendId === stagedConnector!.id);
  expect(stagedCapabilities).toHaveLength(5);
  expect(stagedCapabilities.every(item => item.enabled && !item.isWrite)).toBe(true);
  expect(stagedCapabilities.every(item => item.bundleIds.includes(connectorBundle.bundle.id))).toBe(true);

  const connectorTest = await expectApi<{ type: string; reachable: boolean; latencyMs: number | null }>(
    admin,
    `/api/ui/mcp-fabric/connections/${stagedConnector!.id}/test`,
    200,
    { method: 'POST' },
  );
  expect(connectorTest).toMatchObject({ type: 'http', reachable: true });
  const stillStaged = await expectApi<FabricManagement>(admin, '/api/ui/mcp-fabric/manage', 200);
  expect(stillStaged.backends.find(item => item.id === stagedConnector!.id)?.enabled).toBe(false);

  const activatedConnector = await expectApi<{ connection: { id: number; enabled: boolean }; warning: string | null }>(
    admin,
    `/api/ui/mcp-fabric/connections/${stagedConnector!.id}`,
    200,
    {
      method: 'PUT',
      body: {
        type: stagedConnector!.type,
        description: stagedConnector!.description,
        baseUrl: stagedConnector!.baseUrl,
        mcpEndpoint: stagedConnector!.mcpEndpoint,
        authType: stagedConnector!.authType,
        healthPath: stagedConnector!.healthPath,
        defaultHeaders: stagedConnector!.defaultHeaders,
        timeoutMs: stagedConnector!.timeoutMs,
        tlsSkipVerify: stagedConnector!.tlsSkipVerify,
        enabled: true,
        authMode: stagedConnector!.authMode,
        oauthAuthorizeUrl: stagedConnector!.oauthAuthorizeUrl,
        oauthTokenUrl: stagedConnector!.oauthTokenUrl,
        oauthClientId: stagedConnector!.oauthClientId,
        oauthScopes: stagedConnector!.oauthScopes,
        oauthRevokeUrl: stagedConnector!.oauthRevokeUrl,
        bundleIds: stagedConnector!.bundleIds,
      },
    },
  );
  expect(activatedConnector).toMatchObject({ connection: { id: stagedConnector!.id, enabled: true }, warning: null });

  const capabilityCatalog = await expectApi<{
    capabilities: Array<{
      managedId: number | null;
      name: string;
      backendId: number | null;
      enabled: boolean;
      isWrite: boolean;
      riskLevel: string;
      bundleIds: number[];
    }>;
  }>(admin, '/api/ui/mcp-fabric/capabilities', 200);
  const prometheusQuery = capabilityCatalog.capabilities.find(item => item.name === 'e2e_prometheus_query');
  expect(prometheusQuery).toMatchObject({
    backendId: stagedConnector!.id,
    enabled: true,
    isWrite: false,
    riskLevel: 'low',
    bundleIds: [connectorBundle.bundle.id],
  });
  expect(prometheusQuery?.managedId).toBeGreaterThan(0);
  const prometheusParameters = { query: 'up', time: '2026-08-02T12:00:00Z' };
  const capabilityPreview = await expectApi<{
    request: { method: string; target: string };
    executed: boolean;
  }>(admin, `/api/ui/mcp-fabric/capabilities/${prometheusQuery!.managedId}/playground`, 200, {
    method: 'POST',
    body: { parameters: prometheusParameters, execute: false },
  });
  expect(capabilityPreview).toMatchObject({ request: { method: 'GET' }, executed: false });
  expect(capabilityPreview.request.target).toContain('/api/v1/query?query=up');
  const capabilityExecution = await expectApi<{
    executed: boolean;
    response: { status: number; body: string; truncated: boolean };
  }>(admin, `/api/ui/mcp-fabric/capabilities/${prometheusQuery!.managedId}/playground`, 200, {
    method: 'POST',
    body: { parameters: prometheusParameters, execute: true },
  });
  expect(capabilityExecution).toMatchObject({ executed: true, response: { status: 200, truncated: false } });
  expect(capabilityExecution.response.body).toContain('ARGUS_E2E_PROMETHEUS_OK');

  // Every tool of the installed connector is fixture-certified, not merely
  // listed. This matrix expands automatically when the release fixture adds a
  // connector and keeps write-capable live providers outside ordinary CI.
  const prometheusToolMatrix = [
    {
      name: 'e2e_prometheus_query_range',
      parameters: { query: 'up', start: '2026-08-02T12:00:00Z', end: '2026-08-02T12:15:00Z', step: '1m' },
      marker: 'ARGUS_E2E_PROMETHEUS_RANGE_OK',
    },
    { name: 'e2e_prometheus_alerts', parameters: {}, marker: 'ARGUS_E2E_PROMETHEUS_ALERTS_OK' },
    { name: 'e2e_prometheus_targets', parameters: { state: 'active' }, marker: 'ARGUS_E2E_PROMETHEUS_TARGETS_OK' },
    { name: 'e2e_prometheus_label_values', parameters: { label_name: 'job' }, marker: 'ARGUS_E2E_PROMETHEUS_LABEL_VALUES_OK' },
  ];
  for (const toolCase of prometheusToolMatrix) {
    const capability = capabilityCatalog.capabilities.find(item => item.name === toolCase.name);
    expect(capability, `${toolCase.name} is missing from the capability catalog`).toMatchObject({
      backendId: stagedConnector!.id,
      enabled: true,
      isWrite: false,
      riskLevel: 'low',
      bundleIds: [connectorBundle.bundle.id],
    });
    expect(capability?.managedId).toBeGreaterThan(0);
    const result = await expectApi<{
      executed: boolean;
      response: { status: number; body: string; truncated: boolean };
    }>(admin, `/api/ui/mcp-fabric/capabilities/${capability!.managedId}/playground`, 200, {
      method: 'POST',
      body: { parameters: toolCase.parameters, execute: true },
    });
    expect(result).toMatchObject({ executed: true, response: { status: 200, truncated: false } });
    expect(result.response.body).toContain(toolCase.marker);
  }

  const certificationKey = await expectApi<{ api_key: string }>(admin, '/api/admin/api-keys', 201, {
    method: 'POST',
    body: {
      label: 'E2E Tool Certification',
      allowed_bundles: [connectorBundle.bundle.id],
      allowed_tools: ['e2e_prometheus_*'],
      denied_tools: [],
      scope: 'mcp',
      enabled: true,
    },
  });
  const certificationMcp = await openMcpClient(request, certificationKey.api_key);
  const certificationCatalog = await certificationMcp.send<{
    tools: Array<{ name: string; description: string; inputSchema: { type?: string; properties?: Record<string, unknown> } }>;
  }>('tools/list');
  const certifiedTransportTools = (certificationCatalog.result?.tools ?? [])
    .filter(tool => tool.name.startsWith('e2e_prometheus_'));
  expect(certifiedTransportTools).toHaveLength(5);
  for (const tool of certifiedTransportTools) {
    expect(tool.description.trim().length, `${tool.name} needs a tool description`).toBeGreaterThan(0);
    expect(tool.inputSchema).toMatchObject({ type: 'object' });
  }
  const transportMatrix = [
    { name: 'e2e_prometheus_query', arguments: prometheusParameters, marker: 'ARGUS_E2E_PROMETHEUS_OK' },
    ...prometheusToolMatrix.map(item => ({ name: item.name, arguments: item.parameters, marker: item.marker })),
  ];
  for (const toolCase of transportMatrix) {
    const result = await certificationMcp.send<{ content: Array<{ text: string }>; isError?: boolean }>('tools/call', {
      name: toolCase.name,
      arguments: toolCase.arguments,
    });
    expect(result.result?.isError, `${toolCase.name} failed MCP fixture certification`).not.toBe(true);
    expect(JSON.stringify(result)).toContain(toolCase.marker);
  }

  const connection = await expectApi<{ connection: { id: number }; warning: string | null }>(admin, '/api/ui/mcp-fabric/connections', 201, {
    method: 'POST',
    body: {
      name: 'e2e_fabric',
      type: 'mcp',
      description: 'Deterministic remote MCP fixture',
      baseUrl: 'http://fake-mcp:4100',
      mcpEndpoint: '/mcp',
      authType: 'none',
      defaultHeaders: {},
      timeoutMs: 5000,
      tlsSkipVerify: false,
      enabled: true,
      authMode: 'service-account',
      bundleIds: [],
    },
  });
  expect(connection.warning).toBeNull();
  const discovery = await expectApi<{ connected: boolean; tools: Array<{ name: string }> }>(admin, `/api/ui/mcp-fabric/connections/${connection.connection.id}/discover`, 200, { method: 'POST' });
  expect(discovery.connected).toBe(true);
  expect(discovery.tools.map(tool => tool.name)).toContain('e2e_fabric_fabric_status');
  await expectApi(admin, `/api/admin/backends/${connection.connection.id}/trust`, 200, {
    method: 'POST',
    body: { action: 'trust', comment: 'Trusted by deterministic release certification' },
  });

  const blockedMcpStream = await chat(admin, agent.id, session.id, 'Call the remote MCP status tool.');
  expect(blockedMcpStream).toContain('ARGUS_E2E_MCP_FAILED');
  expect(blockedMcpStream).toContain('ARGUS_E2E_CHANGE_FREEZE');
  await expectApi(admin, `/api/ui/runtime-controls/policies/${runtimePolicy!.id}`, 200, {
    method: 'PUT', body: { enabled: false },
  });

  const mcpStream = await chat(admin, agent.id, session.id, 'Call the remote MCP status tool.');
  expect(mcpStream).toContain('e2e_fabric_fabric_status');
  expect(mcpStream).toContain('ARGUS_E2E_MCP_OK');

  // Install a provider-neutral auditor only after the fresh-install check and
  // exercise the real assessment path: LLM -> governed evidence tool ->
  // persisted findings -> browser detail -> signed exports.
  await expectApi(admin, '/api/admin/agents', 201, {
    method: 'POST',
    body: {
      name: 'compliance_auditor',
      label: 'E2E Compliance Auditor',
      description: 'Deterministic evidence-grounded compliance auditor',
      model: 'e2e-chat',
      system_prompt: 'Collect evidence with available tools and return only the checklist JSON result.',
      enabled: true,
      agent_mode: 'reviewer',
      max_iterations: 4,
      visibility: 'internal',
      min_role: 'platform_admin',
      risk_level: 'medium',
      human_oversight_required: false,
      untrusted_tool_output_enforcement: true,
    },
  });
  const complianceWorkspace = await expectApi<{
    assessmentNotice: string;
    auditor: { ready: boolean };
    frameworks: Array<{ id: number; slug: string; ready: boolean }>;
  }>(admin, '/api/ui/compliance', 200);
  expect(complianceWorkspace.assessmentNotice).toContain('do not constitute certification');
  expect(complianceWorkspace.auditor.ready).toBe(true);
  const nis2 = complianceWorkspace.frameworks.find(framework => framework.slug === 'nis2');
  expect(nis2).toMatchObject({ ready: true });

  await admin.goto('/governance/compliance');
  await expect(admin.getByRole('heading', { name: 'Compliance workspace' })).toBeVisible();
  await expect(admin.getByText('Evidence support, not a certification')).toBeVisible();
  await admin.getByRole('button', { name: 'New assessment' }).click();
  const assessmentDialog = admin.getByRole('dialog', { name: 'Start compliance assessment' });
  await assessmentDialog.getByLabel('Assessment framework').selectOption(String(nis2!.id));
  await assessmentDialog.getByLabel('Audit scope').fill('argus-e2e-fabric');
  await assessmentDialog.getByRole('button', { name: 'Start assessment' }).click();
  await expect(admin).toHaveURL(/\/governance\/compliance\/runs\/\d+$/);
  const complianceRunId = Number(new URL(admin.url()).pathname.split('/').pop());
  const completedCompliance = await pollApi<{
    run: { status: string; score: number; counts: { passed: number; warning: number } };
    findings: Array<{ title: string; evidence: string }>;
    exports: { pdf: string; csv: string } | null;
  }>(admin, `/api/ui/compliance/runs/${complianceRunId}`, body => body.run?.status === 'completed', 30_000);
  expect(completedCompliance.run).toMatchObject({ status: 'completed', score: 67, counts: { passed: 1, warning: 1 } });
  expect(completedCompliance.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: 'Evidence-backed service controls' }),
    expect.objectContaining({ title: 'Human review boundary' }),
  ]));
  expect(completedCompliance.exports).not.toBeNull();

  await admin.goto(`/governance/compliance/runs/${complianceRunId}`);
  await expect(admin.getByRole('heading', { name: 'NIS2 Directive' })).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Evidence-backed service controls' })).toBeVisible();
  await expect(admin.getByText('Automated evidence is available', { exact: false })).toBeVisible();
  // Compliance report downloads require a fresh provider-verified MFA
  // assertion. A local password session never satisfies it, so both formats
  // must redirect to the OIDC step-up instead of returning report content.
  const reportExports = await admin.evaluate(async runId => Promise.all(['csv', 'pdf'].map(async format => {
    const response = await fetch(`/api/ui/compliance/runs/${runId}/export.${format}`, { redirect: 'manual' });
    return { format, type: response.type };
  })), complianceRunId);
  expect(reportExports).toEqual([
    { format: 'csv', type: 'opaqueredirect' },
    { format: 'pdf', type: 'opaqueredirect' },
  ]);

  await expectApi(admin, '/api/admin/tools', 201, {
    method: 'POST',
    body: {
      name: 'jira_create_issue',
      description: 'Governed deterministic write fixture',
      backend: 'postgresql',
      query_template: "SELECT 'ARGUS_E2E_WRITE_EXECUTED' AS status",
      parameters: [{ name: 'summary', type: 'string', required: true }],
      category: 'e2e',
      enabled: true,
      bundle_ids: [],
    },
  });

  const pendingStream = await chat(admin, agent.id, session.id, 'Perform the governed write.');
  expect(pendingStream).toContain('ARGUS_E2E_APPROVAL_PENDING');
  const governance = await pollApi<{
    approvals: Array<{ kind: string; runtimeApprovalId?: number; toolName?: string; risk: string }>;
  }>(
    admin,
    '/api/ui/governance',
    body => body.approvals.some(item => item.kind === 'runtime_tool' && item.toolName === 'jira_create_issue'),
  );
  const pendingApproval = governance.approvals.find(item => item.kind === 'runtime_tool' && item.toolName === 'jira_create_issue');
  expect(pendingApproval).toBeTruthy();
  // The subject is governed as high risk, while this specific non-destructive
  // create action is deliberately classified medium by argus-risk-v1.
  expect(pendingApproval?.risk).toBe('medium');
  await expectApi(admin, `/api/ui/governance/runtime-approvals/${pendingApproval!.runtimeApprovalId}/approve`, 200, {
    method: 'POST',
    body: { comment: 'Approved by Argus E2E certification' },
  });

  const approvedStream = await chat(admin, agent.id, session.id, 'Perform the governed write.');
  expect(approvedStream).toContain('ARGUS_E2E_APPROVAL_EXECUTED');
  const audit = await expectApi<{ entries: Array<{ tool: string; is_error: boolean }> }>(admin, '/api/audit/entries?tool=jira_create_issue&limit=10', 200);
  expect(audit.entries.some(entry => entry.tool === 'jira_create_issue' && entry.is_error === false)).toBe(true);

  // Turn the connector bundle into an Agent Technical Identity boundary only
  // after the preceding unrestricted MCP and approval paths have been proven.
  // User policy deliberately still allows the external Fabric tool: the Agent
  // bundle must win even if the model hallucinates that valid tool name.
  await expectApi(admin, '/api/ui/access-policies/users', 200, {
    method: 'PUT',
    body: {
      userId: me.user.id,
      compositeIds: [],
      agentIds: [agent.id],
      rules: [
        { toolPattern: 'e2e_fabric_*', effect: 'allow', reason: 'Deterministic remote MCP certification', expiresAt: null },
        { toolPattern: 'jira_create_issue', effect: 'allow', reason: 'Human-approval certification', expiresAt: null },
        { toolPattern: 'e2e_prometheus_*', effect: 'allow', reason: 'Governed connector-template bundle certification', expiresAt: null },
      ],
    },
  });
  const restrictedAgent = await expectApi<{ id: number; bundle_ids: number[] }>(admin, `/api/admin/agents/${agent.id}`, 200, {
    method: 'PUT',
    body: { bundle_ids: [connectorBundle.bundle.id] },
  });
  expect(restrictedAgent).toMatchObject({
    id: agent.id,
    bundle_ids: [connectorBundle.bundle.id],
  });

  const bundleSession = await expectApi<{ id: string }>(admin, `/api/agents/${agent.id}/sessions`, 201, {
    method: 'POST',
    body: {},
  });
  const allowedBundleStream = await chat(
    admin,
    agent.id,
    bundleSession.id,
    'Call the Prometheus bundle capability.',
  );
  expect(allowedBundleStream).toContain('e2e_prometheus_query');
  expect(allowedBundleStream).toContain('ARGUS_E2E_BUNDLE_ALLOWED');
  expect(allowedBundleStream).not.toContain('ARGUS_E2E_BUNDLE_ALLOWED_FAILED');

  const deniedBundleStream = await chat(
    admin,
    agent.id,
    bundleSession.id,
    'Call the bundle-external status capability.',
  );
  expect(deniedBundleStream).toContain('ARGUS_E2E_BUNDLE_DENIED');
  expect(deniedBundleStream).toContain("Tool 'e2e_fabric_fabric_status' is not available to this agent.");
  expect(deniedBundleStream).not.toContain('ARGUS_E2E_MCP_FIXTURE_OK');
  expect(deniedBundleStream).not.toContain('ARGUS_E2E_BUNDLE_BYPASS');
  const deniedBundleAudit = await pollApi<{
    entries: Array<{ tool: string; is_error: boolean; error_message: string | null }>;
  }>(
    admin,
    '/api/audit/entries?tool=e2e_fabric_fabric_status&is_error=true&limit=20',
    body => body.entries.some(entry => entry.error_message?.includes('not available to this agent') === true),
  );
  expect(deniedBundleAudit.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      tool: 'e2e_fabric_fabric_status',
      is_error: true,
      error_message: "Tool 'e2e_fabric_fabric_status' is not available to this agent.",
    }),
  ]));

  // Cross-principal deny precedence: the direct user keeps the broad
  // Prometheus allow rule, but a narrower deny must win at runtime.
  await expectApi(admin, '/api/ui/access-policies/users', 200, {
    method: 'PUT',
    body: {
      userId: me.user.id,
      compositeIds: [],
      agentIds: [agent.id],
      rules: [
        { toolPattern: 'e2e_fabric_*', effect: 'allow', reason: 'Deterministic remote MCP certification', expiresAt: null },
        { toolPattern: 'jira_create_issue', effect: 'allow', reason: 'Human-approval certification', expiresAt: null },
        { toolPattern: 'e2e_prometheus_*', effect: 'allow', reason: 'Governed connector-template bundle certification', expiresAt: null },
        { toolPattern: 'e2e_prometheus_query_range', effect: 'deny', reason: 'Direct-user deny precedence certification', expiresAt: null },
      ],
    },
  });
  const userDeniedStream = await chat(
    admin,
    agent.id,
    bundleSession.id,
    'Call the Prometheus range capability as the direct user.',
  );
  expect(userDeniedStream).toContain('ARGUS_E2E_PRINCIPAL_DENIED');
  expect(userDeniedStream).toContain('user-deny');
  expect(userDeniedStream).not.toContain('ARGUS_E2E_PROMETHEUS_RANGE_OK');
  expect(userDeniedStream).not.toContain('ARGUS_E2E_PRINCIPAL_BYPASS');

  // Persist the group policy first, verify its native resolution, then log in
  // through the real Keycloak Authorization Code + PKCE browser flow below.
  const e2eGroup = 'argus-e2e-observability';
  await expectApi(admin, '/api/ui/access-policies/groups', 200, {
    method: 'PUT',
    body: {
      groupName: e2eGroup,
      compositeIds: [],
      agentIds: [agent.id],
      rules: [
        { toolPattern: 'e2e_prometheus_*', effect: 'allow', reason: 'Group-level connector access' },
        { toolPattern: 'e2e_prometheus_query_range', effect: 'deny', reason: 'Group deny precedence certification' },
      ],
    },
  });
  const groupAllowed = await expectApi<{
    decision: string;
    rawDecision: string;
    reason: string;
  }>(admin, '/api/ui/access-policies/simulate', 200, {
    method: 'POST',
    body: { principalKind: 'group', principalId: e2eGroup, toolName: 'e2e_prometheus_query' },
  });
  expect(groupAllowed).toMatchObject({ decision: 'allow', rawDecision: 'allow' });
  const groupDenied = await expectApi<{
    decision: string;
    rawDecision: string;
    reason: string;
    steps: Array<{ key: string; outcome: string }>;
  }>(admin, '/api/ui/access-policies/simulate', 200, {
    method: 'POST',
    body: { principalKind: 'group', principalId: e2eGroup, toolName: 'e2e_prometheus_query_range' },
  });
  expect(groupDenied.decision).toBe('deny');
  expect(groupDenied.rawDecision).toBe('deny');
  expect(groupDenied.reason).toContain('group-deny');
  expect(groupDenied.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: 'group-rule-deny', outcome: 'matched' }),
  ]));

  // The IdP-issued group claim must survive token validation, auto-provisioning
  // and session loading, then deny the narrower range capability in the actual
  // Agent runtime. Capture the callback URL so the same signed state/code can
  // also prove atomic replay rejection.
  const oidcContext = await browser.newContext();
  const oidcPage = await oidcContext.newPage();
  const oidcCallbackUrl = await loginWithKeycloak(oidcPage, 'argus-developer', '/home');

  const oidcMe = await expectApi<{
    user: { id: number; username: string; role: string; entra_groups: string[] };
  }>(oidcPage, '/api/me', 200);
  expect(oidcMe.user.username).toMatch(/^oidc:[a-f0-9]{12}:/);
  expect(oidcMe.user.role).toBe('developer');
  expect(oidcMe.user.entra_groups).toEqual(expect.arrayContaining([
    'argus-developers',
    e2eGroup,
  ]));
  const identitySecurity = await expectApi<{
    provider: { enabled: boolean; name: string };
    session: { authMethod: string; ssoLinked: boolean; mfaFresh: boolean };
    actions: { canLink: boolean; canStepUp: boolean };
    complianceReports: { roleAuthorized: boolean; ready: boolean };
  }>(oidcPage, '/api/me/identity-security', 200);
  expect(identitySecurity).toMatchObject({
    provider: { enabled: true, name: 'Keycloak' },
    session: { authMethod: 'oidc', ssoLinked: true },
    actions: { canLink: false, canStepUp: true },
    complianceReports: { roleAuthorized: false, ready: false },
  });
  await oidcPage.goto('/settings/identity');
  await expect(oidcPage.getByRole('heading', { name: 'Sign-in & MFA' })).toBeVisible();
  await expect(oidcPage.getByRole('heading', { name: 'Keycloak' })).toBeVisible();

  const oidcAgentSession = await expectApi<{ id: string }>(
    oidcPage,
    `/api/agents/${agent.id}/sessions`,
    201,
    { method: 'POST' },
  );
  const oidcAllowedStream = await chat(
    oidcPage,
    agent.id,
    oidcAgentSession.id,
    'Call the Prometheus bundle capability as the OIDC group user.',
  );
  expect(oidcAllowedStream).toContain('ARGUS_E2E_BUNDLE_ALLOWED');
  const oidcDeniedStream = await chat(
    oidcPage,
    agent.id,
    oidcAgentSession.id,
    'Call the Prometheus range capability as the OIDC group user.',
  );
  expect(oidcDeniedStream).toContain('ARGUS_E2E_PRINCIPAL_DENIED');
  expect(oidcDeniedStream).toContain('group-deny');
  expect(oidcDeniedStream).not.toContain('ARGUS_E2E_PROMETHEUS_RANGE_OK');

  await oidcPage.goto(oidcCallbackUrl);
  await expect(oidcPage.getByText('Keycloak-Anmeldung fehlgeschlagen. Bitte erneut versuchen.')).toBeVisible();
  await oidcContext.close();

  // Every seeded product role must traverse the same real browser redirect,
  // token verification and auto-provisioning path. This catches broken group
  // mappings and the special chat_user landing without duplicating the deeper
  // Developer group-policy journey above.
  const oidcRoleCases: Array<{
    username: string;
    expectedRole: string;
    expectedLanding: '/home' | '/chat';
    expectedGroup?: string;
  }> = [
    { username: 'argus-platform-admin', expectedRole: 'platform_admin', expectedLanding: '/home', expectedGroup: 'argus-platform-admins' },
    { username: 'argus-operations-admin', expectedRole: 'operations_admin', expectedLanding: '/home', expectedGroup: 'argus-operations-admins' },
    { username: 'argus-agent-operator', expectedRole: 'agent_operator', expectedLanding: '/home', expectedGroup: 'argus-agent-operators' },
    { username: 'argus-viewer', expectedRole: 'viewer', expectedLanding: '/home' },
    { username: 'argus-chat-user', expectedRole: 'chat_user', expectedLanding: '/chat', expectedGroup: 'argus-chat-users' },
  ];
  for (const roleCase of oidcRoleCases) {
    const roleContext = await browser.newContext();
    const rolePage = await roleContext.newPage();
    await loginWithKeycloak(rolePage, roleCase.username, roleCase.expectedLanding);
    const roleMe = await expectApi<{
      user: { username: string; role: string; entra_groups: string[] };
    }>(rolePage, '/api/me', 200);
    expect(roleMe.user.username).toMatch(/^oidc:[a-f0-9]{12}:/);
    expect(roleMe.user.role).toBe(roleCase.expectedRole);
    if (roleCase.expectedGroup) expect(roleMe.user.entra_groups).toContain(roleCase.expectedGroup);
    else expect(roleMe.user.entra_groups).toEqual([]);
    await roleContext.close();
  }

  // A scoped API Key is a separate Technical Identity. Its bundle boundary is
  // strict, and its deny patterns must beat its broad allow pattern in both
  // the native MCP transport and the Agent webhook runtime.
  const technicalKey = await expectApi<{
    id: number;
    key_prefix: string;
    api_key: string;
    allowed_bundles: number[];
    allowed_tools: string[];
    denied_tools: string[];
  }>(admin, '/api/admin/api-keys', 201, {
    method: 'POST',
    body: {
      label: 'E2E Cross-Principal Key',
      allowed_bundles: [connectorBundle.bundle.id],
      allowed_tools: ['e2e_prometheus_*'],
      denied_tools: ['e2e_prometheus_query_range'],
      scope: 'both',
      enabled: true,
    },
  });
  expect(technicalKey).toMatchObject({
    allowed_bundles: [connectorBundle.bundle.id],
    allowed_tools: ['e2e_prometheus_*'],
    denied_tools: ['e2e_prometheus_query_range'],
  });

  const mcpClient = await openMcpClient(request, technicalKey.api_key);
  const keyCatalog = await mcpClient.send<{ tools: Array<{ name: string }> }>('tools/list');
  const keyToolNames = keyCatalog.result?.tools.map(tool => tool.name) ?? [];
  expect(keyToolNames).toContain('e2e_prometheus_query');
  expect(keyToolNames).not.toContain('e2e_fabric_fabric_status');
  const keyAllowedCall = await mcpClient.send<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>('tools/call', {
    name: 'e2e_prometheus_query',
    arguments: { query: 'argus_key_boundary', time: '2026-08-02T12:20:00Z' },
  });
  expect(keyAllowedCall.result?.isError).not.toBe(true);
  expect(JSON.stringify(keyAllowedCall)).toContain('ARGUS_E2E_PROMETHEUS_OK');
  const keyDeniedCall = await mcpClient.send<{
    content: Array<{ text: string }>;
    isError?: boolean;
  }>('tools/call', {
    name: 'e2e_prometheus_query_range',
    arguments: {
      query: 'argus_key_boundary',
      start: '2026-08-02T12:00:00Z',
      end: '2026-08-02T12:15:00Z',
      step: '1m',
    },
  });
  expect(keyDeniedCall.result?.isError).toBe(true);
  expect(JSON.stringify(keyDeniedCall)).toContain('für diesen API-Key nicht erlaubt');
  expect(JSON.stringify(keyDeniedCall)).not.toContain('ARGUS_E2E_PROMETHEUS_RANGE_OK');
  const keyExternalCall = await mcpClient.send('tools/call', {
    name: 'e2e_fabric_fabric_status',
    arguments: {},
  });
  expect(JSON.stringify(keyExternalCall)).not.toContain('ARGUS_E2E_MCP_FIXTURE_OK');

  const keyAgentAllowed = await request.post(`/api/agents/${agent.id}/chat`, {
    headers: { authorization: `Bearer ${technicalKey.api_key}` },
    data: { message: 'Call the Prometheus bundle capability through the API key.' },
  });
  const keyAgentAllowedText = await keyAgentAllowed.text();
  expect(keyAgentAllowed.status(), keyAgentAllowedText).toBe(200);
  expect(keyAgentAllowedText).toContain('ARGUS_E2E_BUNDLE_ALLOWED');
  const keyAgentDenied = await request.post(`/api/agents/${agent.id}/chat`, {
    headers: { authorization: `Bearer ${technicalKey.api_key}` },
    data: { message: 'Call the Prometheus range capability through the API key.' },
  });
  const keyAgentDeniedText = await keyAgentDenied.text();
  expect(keyAgentDenied.status(), keyAgentDeniedText).toBe(200);
  expect(keyAgentDeniedText).toContain('ARGUS_E2E_PRINCIPAL_DENIED');
  expect(keyAgentDeniedText).not.toContain('ARGUS_E2E_PROMETHEUS_RANGE_OK');
  expect(keyAgentDeniedText).not.toContain('ARGUS_E2E_PRINCIPAL_BYPASS');

  const scopedUnbundledAgentResponse = await request.post(`/api/agents/${codingAgents.get('planner')!}/chat`, {
    headers: { authorization: `Bearer ${technicalKey.api_key}` },
    data: { message: 'Call the bundle-external status capability through the API key.' },
  });
  const scopedUnbundledAgentText = await scopedUnbundledAgentResponse.text();
  expect(scopedUnbundledAgentResponse.status(), scopedUnbundledAgentText).toBe(200);
  expect(scopedUnbundledAgentText).toContain('ARGUS_E2E_BUNDLE_DENIED');
  expect(scopedUnbundledAgentText).not.toContain('ARGUS_E2E_BUNDLE_BYPASS');

  const technicalDenyAudit = await pollApi<{
    entries: Array<{
      api_key_prefix: string;
      tool: string;
      is_error: boolean;
      error_message: string | null;
    }>;
  }>(
    admin,
    '/api/audit/entries?tool=e2e_prometheus_query_range&is_error=true&limit=30',
    body => body.entries.some(entry => entry.api_key_prefix === technicalKey.key_prefix),
  );
  expect(technicalDenyAudit.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      api_key_prefix: technicalKey.key_prefix,
      tool: 'e2e_prometheus_query_range',
      is_error: true,
    }),
  ]));

  // Create the workflow through the actual visual-builder UI. The graph below
  // is then persisted through the same /flow contract used by the Save button,
  // which keeps the E2E deterministic without relying on drag pixel positions.
  await admin.goto('/workflows/builder');
  await expect(admin.getByRole('heading', { name: 'Kein Workflow ausgewählt' })).toBeVisible();
  await admin.getByRole('button', { name: 'Neuer Workflow' }).last().click();
  await admin.locator('#nw-name').fill('E2E Governed Workflow');
  await admin.locator('#nw-desc').fill('Visual Agent, Knowledge and approval-resume release path');
  await admin.getByRole('button', { name: 'Erstellen' }).click();
  await expect(admin).toHaveURL(/\/workflows\/builder\/\d+$/);
  const workflowId = Number(new URL(admin.url()).pathname.split('/').pop());
  expect(workflowId).toBeGreaterThan(0);

  await expectApi(admin, `/api/admin/workflows/${workflowId}`, 200, {
    method: 'PUT',
    body: { human_oversight_required: true },
  });

  const workflowSteps = [
    { id: 'manual', label: 'Manual Start', type: 'trigger.manual', args: {} },
    {
      id: 'agent', label: 'Ask Agent', type: 'argus.agent', agent_id: agent.id,
      args: { prompt: 'Run the normal deterministic workflow agent check.' }, depends_on: ['manual'],
    },
    {
      id: 'knowledge', label: 'Query Knowledge', type: 'argus.knowledge',
      args: { index_name: 'e2e-knowledge', query: 'release certification secret', top_k: 3 }, depends_on: ['agent'],
    },
    {
      id: 'governed', label: 'Governed Write', type: 'argus.tool', tool: 'jira_create_issue',
      args: { summary: 'ARGUS E2E workflow governed change' }, depends_on: ['knowledge'],
    },
    {
      id: 'response', label: 'Final Response', type: 'logic.response',
      args: { value: 'Agent={{steps.agent.result}}; Knowledge={{steps.knowledge.result}}; Write={{steps.governed.result}}' },
      depends_on: ['governed'],
    },
  ];
  const blockDefinitions = workflowSteps.map((step, index) => ({
    id: step.id,
    type: step.type,
    position: { x: 80 + index * 280, y: index % 2 === 0 ? 120 : 320 },
    data: {
      label: step.label,
      ...('agent_id' in step ? { agent_id: step.agent_id } : {}),
      ...('tool' in step ? { tool: step.tool } : {}),
      args: step.args,
    },
  }));
  const validation = await expectApi<{ valid: boolean; errors: unknown[] }>(admin, `/api/workflows/${workflowId}/validate`, 200, {
    method: 'POST',
    body: { steps: workflowSteps },
  });
  expect(validation).toMatchObject({ valid: true, errors: [] });
  await expectApi(admin, `/api/workflows/${workflowId}/flow`, 200, {
    method: 'PUT',
    body: {
      steps: workflowSteps,
      input_params: [],
      canvas_state: { viewport: { x: 0, y: 0, zoom: 0.8 }, theme: 'dark' },
      trigger_config: { type: 'manual' },
      block_definitions: blockDefinitions,
    },
  });

  await admin.reload();
  await expect(admin.locator('.builder-canvas-meta')).toContainText('5 Blöcke');
  await expect(admin.locator('.react-flow__node')).toHaveCount(5);
  await expect(admin.getByText('Governed Write', { exact: true })).toBeVisible();
  const savedFlow = await expectApi<{
    source: string;
    human_oversight_required: boolean;
    steps: Array<{ id: string }>;
  }>(admin, `/api/workflows/${workflowId}/flow`, 200);
  expect(savedFlow).toMatchObject({ source: 'visual', human_oversight_required: true });
  expect(savedFlow.steps.map(step => step.id)).toEqual(['manual', 'agent', 'knowledge', 'governed', 'response']);

  const rejectedExecution = await expectApi<{ executionId: number }>(admin, `/api/workflows/${workflowId}/execute`, 200, {
    method: 'POST',
    body: { input: {} },
  });
  const rejectedWaitingRun = await pollApi<{
    status: string;
    step_results: Record<string, { status: string; result?: string; started_at?: string; approval_request_id?: number }>;
  }>(admin, `/api/workflows/${workflowId}/runs/${rejectedExecution.executionId}`, body => body.status === 'waiting_for_approval');
  expect(rejectedWaitingRun.step_results.governed).toMatchObject({ status: 'waiting' });
  const rejectedGovernance = await pollApi<{
    approvals: Array<{ kind: string; runtimeApprovalId?: number; workflowExecutionId?: number; toolName?: string }>;
  }>(admin, '/api/ui/governance', body => body.approvals.some(item => item.workflowExecutionId === rejectedExecution.executionId));
  const rejectedApproval = rejectedGovernance.approvals.find(item => item.workflowExecutionId === rejectedExecution.executionId);
  await expectApi(admin, `/api/ui/governance/runtime-approvals/${rejectedApproval!.runtimeApprovalId}/reject`, 200, {
    method: 'POST',
    body: { comment: 'Rejected by E2E: revise the governed workflow change before retrying.' },
  });
  const cancelledRun = await pollApi<{ status: string; error_message?: string }>(
    admin,
    `/api/workflows/${workflowId}/runs/${rejectedExecution.executionId}`,
    body => body.status === 'cancelled',
  );
  expect(cancelledRun.error_message).toContain('revise the governed workflow change');

  // A rejected runtime action cancels that immutable run. A fresh run creates
  // a new approval request and can be approved after the operator's rework.
  const execution = await expectApi<{ executionId: number }>(admin, `/api/workflows/${workflowId}/execute`, 200, {
    method: 'POST',
    body: { input: { revision: 'approved-after-review' } },
  });
  const waitingRun = await pollApi<{
    status: string;
    step_results: Record<string, { status: string; result?: string; started_at?: string; approval_request_id?: number }>;
  }>(admin, `/api/workflows/${workflowId}/runs/${execution.executionId}`, body => body.status === 'waiting_for_approval');
  expect(waitingRun.step_results).toMatchObject({
    manual: { status: 'completed' },
    // The agent is intentionally bound to e2e-knowledge above, so the real
    // workflow runner injects RAG context just like native Agent Chat does.
    agent: { status: 'completed', result: 'ARGUS_E2E_RAG_FOUND' },
    knowledge: { status: 'completed' },
    governed: { status: 'waiting' },
  });
  expect(waitingRun.step_results.knowledge?.result).toContain('ARGUS_KNOWLEDGE_SECRET_42');
  const firstAgentStartedAt = waitingRun.step_results.agent?.started_at;
  expect(firstAgentStartedAt).toBeTruthy();

  const workflowGovernance = await pollApi<{
    approvals: Array<{ kind: string; runtimeApprovalId?: number; workflowExecutionId?: number; toolName?: string }>;
  }>(admin, '/api/ui/governance', body => body.approvals.some(item => item.workflowExecutionId === execution.executionId));
  const workflowApproval = workflowGovernance.approvals.find(item => item.workflowExecutionId === execution.executionId);
  expect(workflowApproval).toMatchObject({ kind: 'runtime_tool', toolName: 'jira_create_issue' });
  await expectApi(admin, `/api/ui/governance/runtime-approvals/${workflowApproval!.runtimeApprovalId}/approve`, 200, {
    method: 'POST',
    body: { comment: 'Resume the deterministic visual workflow' },
  });

  const completedRun = await pollApi<{
    status: string;
    step_results: Record<string, { status: string; result?: string; started_at?: string }>;
  }>(admin, `/api/workflows/${workflowId}/runs/${execution.executionId}`, body => body.status === 'completed');
  expect(completedRun.step_results.agent?.started_at).toBe(firstAgentStartedAt);
  expect(completedRun.step_results.governed).toMatchObject({ status: 'completed' });
  expect(completedRun.step_results.governed?.result).toContain('ARGUS_E2E_WRITE_EXECUTED');
  expect(completedRun.step_results.response?.result).toContain('ARGUS_E2E_WRITE_EXECUTED');
  const resumeAudit = await expectApi<{ entries: Array<{ tool: string; is_error: boolean }> }>(
    admin,
    '/api/audit/entries?tool=workflow_resumed_after_approval&limit=10',
    200,
  );
  expect(resumeAudit.entries.some(entry => entry.tool === 'workflow_resumed_after_approval' && entry.is_error === false)).toBe(true);

  const codingCatalog = await expectApi<{
    workflows: Array<{ graph_id: string; assistant_id: string; label: string }>;
  }>(admin, '/api/coding/workflows', 200);
  expect(codingCatalog.workflows).toEqual(expect.arrayContaining([
    expect.objectContaining({ graph_id: 'coding_workflow', label: 'Ticket to pull request' }),
    expect.objectContaining({ graph_id: 'pull_request_review', label: 'Pull request review' }),
    expect.objectContaining({ graph_id: 'ci_failure_recovery', label: 'CI failure recovery' }),
    expect.objectContaining({ graph_id: 'security_remediation', label: 'Security remediation' }),
    expect.objectContaining({ graph_id: 'release_notes', label: 'Release notes' }),
    expect.objectContaining({ graph_id: 'backlog_grooming', label: 'Backlog Planning' }),
  ]));

  const gitFabric = await expectApi<{
    bundles: Array<{ id: number; name: string; label: string }>;
  }>(admin, '/api/ui/mcp-fabric/manage', 200);
  const gitBundle = gitFabric.bundles.find(bundle => bundle.name === 'argus_e2e_gitea');
  expect(gitBundle).toMatchObject({ name: 'argus_e2e_gitea' });
  const notificationBundle = gitFabric.bundles.find(bundle => bundle.name === 'argus_e2e_slack_fixture');
  expect(notificationBundle).toMatchObject({ name: 'argus_e2e_slack_fixture' });

  const goldenPathSteps = [
    { id: 'manual', label: 'Golden Path start', type: 'trigger.manual', args: {} },
    {
      id: 'read_issue', label: 'Read bounded Gitea issue', type: 'argus.tool', tool: 'argus_e2e_gitea_get_issue',
      args: {}, depends_on: ['manual'],
    },
    {
      id: 'triage', label: 'Analyze issue', type: 'argus.agent', agent_id: agent.id,
      args: { prompt: 'Analyze the bounded Golden Path issue evidence. Do not call tools or modify external systems.\n\n{{ steps.read_issue.result }}' },
      depends_on: ['read_issue'],
    },
    {
      id: 'approval', label: 'Approve bounded outcomes', type: 'argus.approval',
      condition: "input.write_mode === 'guarded'",
      args: { message: 'Approve one comment, one label and one Slack fixture message for the exact Golden Path targets?' },
      depends_on: ['triage'],
    },
    {
      id: 'comment_issue', label: 'Comment on bounded issue', type: 'argus.tool', tool: 'argus_e2e_gitea_comment_issue',
      condition: "input.write_mode === 'guarded'", args: {}, depends_on: ['approval'],
    },
    {
      id: 'add_label', label: 'Label bounded issue', type: 'argus.tool', tool: 'argus_e2e_gitea_add_label',
      condition: "input.write_mode === 'guarded'", args: {}, depends_on: ['approval'],
    },
    {
      id: 'notify', label: 'Notify bounded Slack fixture', type: 'argus.tool', tool: 'argus_e2e_slack_post_message',
      condition: "input.write_mode === 'guarded'", args: {}, depends_on: ['comment_issue', 'add_label'],
    },
    {
      id: 'response', label: 'Golden Path result', type: 'logic.response',
      args: { value: '{{ steps.triage.result }}' }, depends_on: ['notify'],
    },
  ];
  const goldenWorkflow = await expectApi<{ id: number }>(admin, '/api/admin/workflows', 201, {
    method: 'POST',
    body: {
      name: 'e2e_golden_path_workflow',
      description: 'Deterministic read-only and single-approval Golden Path certification workflow.',
      steps: goldenPathSteps,
      input_params: [
        { name: 'repository_owner', type: 'string', description: 'Bounded repository owner', required: true },
        { name: 'repository_name', type: 'string', description: 'Bounded repository name', required: true },
        { name: 'issue_number', type: 'number', description: 'Bounded issue number', required: true },
        { name: 'notification_channel', type: 'string', description: 'Bounded notification destination', required: true },
        { name: 'write_mode', type: 'string', description: 'read_only or guarded', required: true },
      ],
      bundle_ids: [gitBundle!.id, notificationBundle!.id],
      human_oversight_required: false,
    },
  });
  await expectApi(admin, '/api/ui/access-policies/users', 200, {
    method: 'PUT',
    body: {
      userId: me.user.id,
      compositeIds: [],
      agentIds: [agent.id],
      rules: [
        { toolPattern: 'e2e_fabric_*', effect: 'allow', reason: 'Deterministic remote MCP certification', expiresAt: null },
        { toolPattern: 'jira_create_issue', effect: 'allow', reason: 'Human-approval certification', expiresAt: null },
        { toolPattern: 'e2e_prometheus_*', effect: 'allow', reason: 'Governed connector-template bundle certification', expiresAt: null },
        { toolPattern: 'e2e_prometheus_query_range', effect: 'deny', reason: 'Direct-user deny precedence certification', expiresAt: null },
        { toolPattern: 'argus_e2e_gitea_*', effect: 'allow', reason: 'Golden Path Git fixture', expiresAt: null },
        { toolPattern: 'argus_e2e_slack_*', effect: 'allow', reason: 'Golden Path Slack fixture', expiresAt: null },
      ],
    },
  });
  await expectApi(admin, `/api/workflows/${goldenWorkflow.id}/flow`, 200, {
    method: 'PUT',
    body: {
      steps: goldenPathSteps,
      input_params: [
        { name: 'repository_owner', type: 'string', description: 'Bounded repository owner', required: true },
        { name: 'repository_name', type: 'string', description: 'Bounded repository name', required: true },
        { name: 'issue_number', type: 'number', description: 'Bounded issue number', required: true },
        { name: 'notification_channel', type: 'string', description: 'Bounded notification destination', required: true },
        { name: 'write_mode', type: 'string', description: 'read_only or guarded', required: true },
      ],
      trigger_config: { type: 'manual' },
      canvas_state: {},
      block_definitions: [],
    },
  });

  // Bind the exact Git and notification scopes to the saved revision through
  // the same admin/RBAC endpoint used by MCP Fabric. The Golden Path preflight
  // must now derive a start decision from real persisted state, never from a
  // UI-only toggle or an unsaved canvas.
  for (const bundle of [gitBundle!, notificationBundle!]) {
    await expectApi(admin, `/api/ui/mcp-fabric/bundles/${bundle.id}/access`, 200, {
      method: 'PATCH',
      body: { kind: 'workflow', id: goldenWorkflow.id, granted: true },
    });
  }

  type GoldenPathPreflight = {
    schemaVersion: number;
    kind: string;
    mode: string;
    state: string;
    scope: { workspaceKey: string; tenantKey: string; environment: string };
    workflow: { id: string; revision: string; sha256: string; saved: boolean; agent: { id: string; sha256: string } };
    runtime: { preferred: string; selected: string; fallbackAllowed: boolean; grantSha256: string };
    policy: { writeMode: string; approvalRequired: boolean; separationOfDutiesRequired: boolean; writes: string[] };
    checks: Array<{ id: string; state: string }>;
    allowedActions: string[];
  };
  const guardedPreflight = await expectApi<GoldenPathPreflight>(
    admin,
    '/api/ui/golden-path/v1/preflight?mode=certification&writeMode=guarded',
    200,
  );
  expect(guardedPreflight).toMatchObject({
    schemaVersion: 1,
    kind: 'argus.golden-path-preflight',
    mode: 'certification',
    state: 'ready',
    scope: { workspaceKey: 'default', tenantKey: 'default', environment: 'certification' },
    workflow: { id: String(goldenWorkflow.id), saved: true, agent: { id: String(agent.id) } },
    runtime: { preferred: 'native', selected: 'native', fallbackAllowed: false },
    policy: {
      writeMode: 'guarded',
      approvalRequired: true,
      separationOfDutiesRequired: true,
      writes: ['git_comment', 'git_add_label', 'slack_post_message'],
    },
    allowedActions: ['start', 'refresh'],
  });
  expect(Number(guardedPreflight.workflow.revision)).toBeGreaterThan(0);
  expect(guardedPreflight.workflow.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(guardedPreflight.workflow.agent.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(guardedPreflight.runtime.grantSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(guardedPreflight.checks.every(check => check.state === 'ready')).toBe(true);

  const readOnlyPreflight = await expectApi<GoldenPathPreflight>(
    admin,
    '/api/ui/golden-path/v1/preflight?mode=certification&writeMode=read_only',
    200,
  );
  expect(readOnlyPreflight).toMatchObject({
    state: 'ready',
    policy: {
      writeMode: 'read_only',
      approvalRequired: false,
      separationOfDutiesRequired: false,
      writes: [],
    },
    allowedActions: ['start', 'refresh'],
  });

  type GoldenPathStart = {
    kind: string;
    runId: string;
    workflowExecutionId: number;
    traceId: string;
    replayed: boolean;
    href: string;
  };
  type GoldenPathRun = {
    status: string;
    approval: { id: string | null; state: string };
    outcomes: Array<{ target: string; operation: string; state: string }>;
    stages: Array<{ id: string; state: string }>;
    correlation: { runId: string; traceId: string };
    evidence: { state: string; gaps: string[] };
  };

  const readOnlyStart = await expectApi<GoldenPathStart>(admin, '/api/ui/golden-path/v1/runs', 202, {
    method: 'POST',
    headers: { 'idempotency-key': 'argus-e2e-golden-read-only-1' },
    body: { mode: 'certification', writeMode: 'read_only' },
  });
  expect(readOnlyStart).toMatchObject({
    kind: 'argus.golden-path-run-started', replayed: false,
  });
  expect(readOnlyStart.workflowExecutionId).toBeGreaterThan(0);
  expect(readOnlyStart.traceId).toMatch(/^[0-9a-f-]{36}$/);
  const replayedReadOnlyStart = await expectApi<GoldenPathStart>(admin, '/api/ui/golden-path/v1/runs', 200, {
    method: 'POST',
    headers: { 'idempotency-key': 'argus-e2e-golden-read-only-1' },
    body: { mode: 'certification', writeMode: 'read_only' },
  });
  expect(replayedReadOnlyStart).toMatchObject({
    runId: readOnlyStart.runId,
    workflowExecutionId: readOnlyStart.workflowExecutionId,
    replayed: true,
  });
  const readOnlyGoldenRun = await pollApi<GoldenPathRun>(
    admin,
    readOnlyStart.href,
    body => body.status === 'completed_with_gaps',
  );
  expect(readOnlyGoldenRun).toMatchObject({
    approval: { id: null, state: 'not_required' },
    outcomes: [],
    correlation: { runId: String(readOnlyStart.workflowExecutionId), traceId: readOnlyStart.traceId },
  });
  expect(readOnlyGoldenRun.stages.find(stage => stage.id === 'approval')?.state).toBe('skipped');
  expect(readOnlyGoldenRun.stages.find(stage => stage.id === 'external_action')?.state).toBe('skipped');

  const guardedStart = await expectApi<GoldenPathStart>(admin, '/api/ui/golden-path/v1/runs', 202, {
    method: 'POST',
    headers: { 'idempotency-key': 'argus-e2e-golden-guarded-1' },
    body: { mode: 'certification', writeMode: 'guarded' },
  });
  const guardedWaiting = await pollApi<GoldenPathRun>(
    admin,
    guardedStart.href,
    body => body.status === 'waiting_for_approval',
  );
  expect(guardedWaiting.approval).toMatchObject({ state: 'pending' });
  expect(guardedWaiting.approval.id).toBeTruthy();
  expect(guardedWaiting.outcomes).toHaveLength(3);
  expect(guardedWaiting.outcomes.every(outcome => outcome.state === 'pending')).toBe(true);
  expect(guardedWaiting.stages.find(stage => stage.id === 'external_action')?.state).toBe('pending');

  await expectApi(admin, `/api/ui/governance/runtime-approvals/${guardedWaiting.approval.id}/approve`, 200, {
    method: 'POST',
    body: { comment: 'Approve the exact E2E Golden Path targets and payload.' },
  });
  const guardedCompleted = await pollApi<GoldenPathRun>(
    admin,
    guardedStart.href,
    body => body.status === 'completed_with_gaps',
  );
  expect(guardedCompleted.approval.state).toBe('approved');
  expect(guardedCompleted.stages.find(stage => stage.id === 'external_action')?.state).toBe('succeeded');
  expect(guardedCompleted.evidence).toMatchObject({ state: 'complete_with_gaps' });
  expect(guardedCompleted.evidence.gaps).toEqual(expect.arrayContaining([
    expect.stringContaining('Signed Audit Report and Evidence Pack generation is pending'),
  ]));

  const rejectedStart = await expectApi<GoldenPathStart>(admin, '/api/ui/golden-path/v1/runs', 202, {
    method: 'POST',
    headers: { 'idempotency-key': 'argus-e2e-golden-rejected-1' },
    body: { mode: 'certification', writeMode: 'guarded' },
  });
  const rejectedWaiting = await pollApi<GoldenPathRun>(
    admin,
    rejectedStart.href,
    body => body.status === 'waiting_for_approval',
  );
  await expectApi(admin, `/api/ui/governance/runtime-approvals/${rejectedWaiting.approval.id}/reject`, 200, {
    method: 'POST',
    body: { comment: 'Reject the bounded Golden Path plan; no external write is authorized.' },
  });
  const rejectedGoldenRun = await pollApi<GoldenPathRun>(
    admin,
    rejectedStart.href,
    body => body.status === 'rejected',
  );
  expect(rejectedGoldenRun).toMatchObject({
    approval: { state: 'rejected' },
    allowedActions: ['open_trace'],
  });
  expect(rejectedGoldenRun.stages.find(stage => stage.id === 'external_action')?.state).toBe('skipped');
  expect(rejectedGoldenRun.outcomes.every(outcome => outcome.state === 'skipped')).toBe(true);

  const telemetrySecret = 'ARGUS_E2E_TRACE_SECRET_DO_NOT_STORE';
  const codingRun = await expectApi<{ thread_id: string; workflow_type: string }>(admin, '/api/coding/threads', 200, {
    method: 'POST',
    body: {
      workflow_type: 'coding_workflow',
      input: {
        ticket_id: 'ARGUS-E2E-LG-1',
        description: 'Exercise the real LangGraph coding workflow and pause for human code approval.',
        apiToken: telemetrySecret,
        argus_bundle_id: gitBundle!.id,
      },
    },
  });
  expect(codingRun.workflow_type).toBe('coding_workflow');
  expect(codingRun.thread_id).toBeTruthy();

  type CodingState = {
    status?: string;
    values?: {
      ticket_id?: string;
      argus_bundle_id?: number;
      tests_passed?: boolean;
      review_passed?: boolean;
      retry_count?: number;
      human_approved?: boolean;
      branch_pushed?: boolean;
      pr_approved?: boolean;
      pr_url?: string;
      test_output?: string;
      review?: string;
      file_diffs?: Array<{ path: string }>;
      review_annotations?: Array<{ path: string }>;
      repository?: string;
      branch_name?: string;
      commit_sha?: string;
      build_url?: string;
      delivery_status?: string;
      ci_run?: { provider?: string; external_id?: string; status?: string; conclusion?: string; branch?: string; commit_sha?: string; run_url?: string } | null;
      bitbucket_creds?: { project_key?: string; repo_slug?: string } | null;
      log?: Array<{ step: string; summary: string }>;
    };
    next?: string[];
    tasks?: Array<{ interrupts?: unknown[] }>;
  };
  const interruptedCodingState = await pollApi<CodingState>(
    admin,
    `/api/coding/threads/${codingRun.thread_id}`,
    body => body.values?.tests_passed === true
      && body.values?.review_passed === true
      && (body.next?.includes('human_approval') === true || body.tasks?.some(task => (task.interrupts?.length ?? 0) > 0) === true),
    60_000,
  );
  expect(interruptedCodingState.values).toMatchObject({
    ticket_id: 'ARGUS-E2E-LG-1',
    tests_passed: true,
    review_passed: true,
  });
  expect(interruptedCodingState.values?.test_output).toContain('TEST_VERDICT: PASS');
  expect(interruptedCodingState.values?.review).toContain('VERDICT: APPROVED');
  expect(interruptedCodingState.values?.file_diffs).toEqual([
    expect.objectContaining({ path: 'src/argus-e2e.ts' }),
  ]);
  expect(interruptedCodingState.values?.review_annotations).toEqual([
    expect.objectContaining({ path: 'src/argus-e2e.ts' }),
  ]);

  await expectApi(admin, `/api/coding/threads/${codingRun.thread_id}/resume`, 200, {
    method: 'POST',
    body: {
      approved: false,
      feedback: 'Please revise the implementation once before final approval.',
      rationale: 'E2E reviewer requested one deterministic rework iteration.',
    },
  });
  const reworkedCodingState = await pollApi<CodingState>(
    admin,
    `/api/coding/threads/${codingRun.thread_id}`,
    body => (body.values?.retry_count ?? 0) >= 1
      && body.values?.tests_passed === true
      && body.values?.review_passed === true
      && body.values?.human_approved === false
      && (body.next?.includes('human_approval') === true || body.tasks?.some(task => (task.interrupts?.length ?? 0) > 0) === true),
    60_000,
  );
  expect(reworkedCodingState.values?.log?.filter(entry => entry.step === 'coder')).toHaveLength(2);
  const rejectedCodingApprovalAudit = await expectApi<{
    entries: Array<{ thread_id: string; approved: boolean; rationale: string }>;
  }>(admin, '/api/admin/agent-approvals?limit=20', 200);
  expect(rejectedCodingApprovalAudit.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      thread_id: codingRun.thread_id,
      approved: false,
      rationale: 'E2E reviewer requested one deterministic rework iteration.',
    }),
  ]));

  await expectApi(admin, `/api/coding/threads/${codingRun.thread_id}/resume`, 200, {
    method: 'POST',
    body: {
      approved: true,
      rationale: 'Deterministic E2E code review passed; resume the LangGraph checkpoint.',
    },
  });
  const ciWaitingCodingState = await pollApi<CodingState>(
    admin,
    `/api/coding/threads/${codingRun.thread_id}`,
    body => (body.status === 'waiting_external_ci' || body.next?.includes('external_ci') === true)
      && body.values?.human_approved === true
      && body.values?.branch_pushed === true
      && Boolean(body.values?.branch_name)
      && Boolean(body.values?.commit_sha)
      && body.values?.delivery_status === 'awaiting_ci',
    60_000,
  );
  expect(ciWaitingCodingState.values).toMatchObject({
    human_approved: true,
    branch_pushed: true,
    delivery_status: 'awaiting_ci',
  });
  expect(ciWaitingCodingState.values?.ci_run).toMatchObject({ status: 'queued' });

  const ciPayload = {
    workflow_run: {
      id: 42,
      name: 'Argus E2E CI',
      status: 'completed',
      conclusion: 'success',
      head_branch: ciWaitingCodingState.values?.branch_name,
      head_sha: ciWaitingCodingState.values?.commit_sha,
      html_url: 'http://fake-workspace:4200/argus-e2e/argus-e2e-repo/actions/runs/42',
    },
    repository: {
      full_name: `${ciWaitingCodingState.values?.bitbucket_creds?.project_key ?? 'argus-e2e'}/${ciWaitingCodingState.values?.bitbucket_creds?.repo_slug ?? 'argus-e2e-repo'}`,
    },
  };
  const ciRawBody = JSON.stringify(ciPayload);
  const ciSignature = createHmac('sha256', 'argus-e2e-ci-webhook-secret').update(ciRawBody).digest('hex');
  const rejectedCiSignature = await api(admin, '/api/coding/webhook/ci/gitea', {
    method: 'POST',
    body: ciPayload,
    headers: { 'x-gitea-event': 'workflow_run', 'x-gitea-signature': '00'.repeat(32) },
  });
  expect(rejectedCiSignature.status).toBe(403);

  const unsupportedCiBody = { ...ciPayload, repository: { full_name: 'argus-e2e/argus-e2e-repo' } };
  const unsupportedCiSignature = createHmac('sha256', 'argus-e2e-ci-webhook-secret')
    .update(JSON.stringify(unsupportedCiBody)).digest('hex');
  const unsupportedCi = await api(admin, '/api/coding/webhook/ci/gitea', {
    method: 'POST',
    body: unsupportedCiBody,
    headers: { 'x-gitea-event': 'push', 'x-gitea-signature': unsupportedCiSignature },
  });
  expect(unsupportedCi.status).toBe(202);
  expect(unsupportedCi.body).toMatchObject({ accepted: false, reason: 'unsupported_event', event: 'push' });

  const unmatchedCiBody = {
    ...ciPayload,
    workflow_run: { ...ciPayload.workflow_run, head_branch: 'feature/unknown-branch' },
  };
  const unmatchedCiSignature = createHmac('sha256', 'argus-e2e-ci-webhook-secret')
    .update(JSON.stringify(unmatchedCiBody)).digest('hex');
  const unmatchedCi = await api(admin, '/api/coding/webhook/ci/gitea', {
    method: 'POST',
    body: unmatchedCiBody,
    headers: { 'x-gitea-event': 'workflow_run', 'x-gitea-signature': unmatchedCiSignature },
  });
  expect(unmatchedCi.status).toBe(202);
  expect(unmatchedCi.body).toMatchObject({ accepted: false, reason: 'no_matching_argus_thread' });

  // Provider-specific webhook fixtures exercise the shared adapter routes
  // without mutating the active Gitea run before its terminal callback.
  const githubPayload = {
    workflow_run: {
      id: 43, name: 'GitHub checks', status: 'completed', conclusion: 'success',
      head_branch: 'feature/provider-unknown', head_sha: 'github-sha',
      html_url: 'https://github.com/argus-e2e/argus-e2e-repo/actions/runs/43',
    },
    repository: { full_name: 'argus-e2e/argus-e2e-repo' },
  };
  const githubSignature = `sha256=${createHmac('sha256', 'argus-e2e-github-ci-webhook-secret').update(JSON.stringify(githubPayload)).digest('hex')}`;
  const githubCallback = await api(admin, '/api/coding/webhook/ci/github', {
    method: 'POST', body: githubPayload,
    headers: { 'x-github-event': 'workflow_run', 'x-hub-signature-256': githubSignature },
  });
  expect(githubCallback.status).toBe(202);
  expect(githubCallback.body).toMatchObject({ accepted: false, provider: 'github', reason: 'no_matching_argus_thread' });

  const gitlabPayload = {
    object_attributes: {
      id: 44, ref: 'feature/provider-unknown', sha: 'gitlab-sha', status: 'success',
      web_url: 'https://gitlab.example/argus-e2e/argus-e2e-repo/-/pipelines/44',
    },
    project: { path_with_namespace: 'argus-e2e/argus-e2e-repo' },
  };
  const gitlabCallback = await api(admin, '/api/coding/webhook/ci/gitlab', {
    method: 'POST', body: gitlabPayload,
    headers: { 'x-gitlab-event': 'Pipeline Hook', 'x-gitlab-token': 'argus-e2e-gitlab-ci-webhook-secret' },
  });
  expect(gitlabCallback.status).toBe(202);
  expect(gitlabCallback.body).toMatchObject({ accepted: false, provider: 'gitlab', reason: 'no_matching_argus_thread' });

  const jenkinsPayload = {
    build: { number: 45, job_name: 'argus-e2e', result: 'SUCCESS', full_url: 'http://jenkins/job/argus-e2e/45' },
    branch: 'feature/provider-unknown', scm: { commit: 'jenkins-sha' },
    repository: { url: 'https://git.example/argus-e2e/argus-e2e-repo.git' },
  };
  const jenkinsCallback = await api(admin, '/api/coding/webhook/ci/jenkins', {
    method: 'POST', body: jenkinsPayload,
    headers: { 'x-jenkins-token': 'argus-e2e-jenkins-ci-webhook-secret' },
  });
  expect(jenkinsCallback.status).toBe(202);
  expect(jenkinsCallback.body).toMatchObject({ accepted: false, provider: 'jenkins', reason: 'no_matching_argus_thread' });

  const ciCallback = await expectApi<{ accepted: boolean; ci_run: { provider: string; status: string; external_id: string } }>(
    admin,
    '/api/coding/webhook/ci/gitea',
    200,
    {
      method: 'POST',
      body: ciPayload,
      headers: { 'x-gitea-event': 'workflow_run', 'x-gitea-signature': ciSignature },
    },
  );
  expect(ciCallback).toMatchObject({ accepted: true, ci_run: { provider: 'gitea', status: 'success', external_id: '42' } });

  const completedCiApprovalState = await pollApi<CodingState>(
    admin,
    `/api/coding/threads/${codingRun.thread_id}`,
    body => body.status === 'interrupted'
      && body.next?.includes('human_approval_pr') === true
      && body.values?.delivery_status === 'ci_passed',
    60_000,
  );
  expect(completedCiApprovalState.values?.ci_run).toMatchObject({ status: 'success', conclusion: 'success' });

  await expectApi(admin, `/api/coding/threads/${codingRun.thread_id}/resume`, 200, {
    method: 'POST',
    body: {
      approved: true,
      rationale: 'Deterministic E2E functional verification passed; create the pull request.',
    },
  });
  const deliveredCodingState = await pollApi<CodingState>(
    admin,
    `/api/coding/threads/${codingRun.thread_id}`,
    body => body.status === 'completed'
      && body.values?.human_approved === true
      && body.values?.branch_pushed === true
      && body.values?.pr_approved === true
      && Boolean((body.values as Record<string, unknown> | undefined)?.pr_url)
      && body.values?.log?.some(entry => entry.step === 'finalize_build') === true
      && body.values?.log?.some(entry => entry.step === 'finalize_pr') === true
      && (body.next?.length ?? 0) === 0,
    60_000,
  );
  const codingLogSteps = deliveredCodingState.values?.log?.map(entry => entry.step) ?? [];
  expect(codingLogSteps).toEqual(expect.arrayContaining([
    'setup_workspace', 'planner', 'knowledge', 'coder', 'tests', 'reviewer', 'human', 'finalize_build', 'human_pr', 'finalize_pr',
  ]));

  // Exercise the durable failure/retry contract without running a second
  // multi-minute coding graph. A synthetic checkpoint is failed by the same
  // provider-neutral CI endpoint used by real webhooks, then retried through
  // the authenticated Core API. The failed evidence remains immutable and
  // the bundle scope must survive the new attempt.
  const syntheticThreadResponse = await request.post('http://langgraph:2025/threads', {
    headers: { 'X-Workspace-Secret': 'argus-e2e-workspace-secret' },
    data: {
      metadata: {
        workflow_type: 'coding_workflow',
        ticket_id: 'ARGUS-E2E-CI-FAIL-1',
        description: 'Synthetic CI failure for retry certification.',
        argus_bundle_id: gitBundle!.id,
        execution_bundle_ids: [gitBundle!.id],
      },
    },
  });
  expect(syntheticThreadResponse.status()).toBe(200);
  const syntheticThread = await syntheticThreadResponse.json() as { thread_id: string };
  const syntheticCiResponse = await request.post(`http://langgraph:2025/threads/${syntheticThread.thread_id}/ci`, {
    headers: { 'X-Workspace-Secret': 'argus-e2e-workspace-secret' },
    data: {
      provider: 'gitea',
      external_id: 'argus-e2e-failure-1',
      workflow: 'Argus E2E CI',
      status: 'failure',
      conclusion: 'tests_failed',
      branch: 'feature/ARGUS-E2E-CI-FAIL-1',
      commit_sha: 'argus-e2e-failure-sha',
      run_url: 'http://fake-workspace:4200/actions/runs/9001',
    },
  });
  expect(syntheticCiResponse.status()).toBe(200);
  const syntheticFailure = await expectApi<CodingState & { error?: string }>(
    admin,
    `/api/coding/threads/${syntheticThread.thread_id}`,
    200,
  );
  expect(syntheticFailure).toMatchObject({
    status: 'failed',
    error: 'External CI failure: tests_failed',
    values: { delivery_status: 'ci_failed' },
  });
  const retryResult = await expectApi<{ thread_id: string; original_thread_id: string; status: string }>(
    admin,
    `/api/coding/threads/${syntheticThread.thread_id}/retry`,
    200,
    { method: 'POST', body: { error_context: 'Synthetic CI feedback: inspect the failing test output before retrying.' } },
  );
  expect(retryResult).toMatchObject({ original_thread_id: syntheticThread.thread_id, status: 'started' });
  const retryState = await pollApi<CodingState & { metadata?: Record<string, unknown> }>(
    admin,
    `/api/coding/threads/${retryResult.thread_id}`,
    body => body.values?.ticket_id === 'ARGUS-E2E-CI-FAIL-1'
      && body.values?.argus_bundle_id === gitBundle!.id,
    15_000,
  );
  expect(retryState.metadata).toMatchObject({
    source: 'retry_after_error',
    retry_of: syntheticThread.thread_id,
    argus_bundle_id: gitBundle!.id,
  });

  const codingApprovalAudit = await expectApi<{
    entries: Array<{ thread_id: string; gate_type: string; approved: boolean; rationale: string; row_hash: string }>;
  }>(admin, '/api/admin/agent-approvals?limit=20', 200);
  expect(codingApprovalAudit.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({
      thread_id: codingRun.thread_id,
      gate_type: 'code_approval',
      approved: true,
      rationale: 'Deterministic E2E code review passed; resume the LangGraph checkpoint.',
      row_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
    expect.objectContaining({
      thread_id: codingRun.thread_id,
      gate_type: 'code_approval',
      approved: false,
      rationale: 'E2E reviewer requested one deterministic rework iteration.',
      row_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  ]));

  type NativeTraceDetail = {
    trace: {
      id: string;
      root_trace_id: string;
      parent_trace_id: string | null;
      kind: string;
      status: string;
      input_preview: Record<string, unknown> | null;
    };
    family: {
      rootTraceId: string;
      runs: Array<{
        id: string;
        parentTraceId: string | null;
        kind: 'workflow' | 'agent';
        status: string;
      }>;
      spans: Array<{
        id: string;
        traceId: string;
        kind: string;
        status: string;
      }>;
    };
  };
  const codingTrace = await pollApi<NativeTraceDetail>(
    admin,
    `/api/ui/observability/traces/${codingRun.thread_id}`,
    body => body.trace?.status === 'completed'
      && body.family?.runs.filter(run => run.kind === 'agent').length >= 6
      && body.family?.spans.some(span => span.kind === 'rag') === true
      && body.family?.spans.some(span => span.kind === 'llm') === true,
    60_000,
  );
  expect(codingTrace.trace).toMatchObject({
    id: codingRun.thread_id,
    root_trace_id: codingRun.thread_id,
    parent_trace_id: null,
    kind: 'workflow',
    status: 'completed',
  });
  expect(codingTrace.trace.input_preview).toMatchObject({ apiToken: '[REDACTED]' });
  expect(JSON.stringify(codingTrace)).not.toContain(telemetrySecret);
  expect(codingTrace.family.rootTraceId).toBe(codingRun.thread_id);
  const childAgentRuns = codingTrace.family.runs.filter(run => run.kind === 'agent');
  expect(childAgentRuns.length).toBeGreaterThanOrEqual(6);
  expect(childAgentRuns.every(run => run.parentTraceId === codingRun.thread_id && run.status === 'completed')).toBe(true);
  const childAgentIds = new Set(childAgentRuns.map(run => run.id));
  const childSpans = codingTrace.family.spans.filter(span => childAgentIds.has(span.traceId));
  expect(childSpans.filter(span => span.kind === 'rag').length).toBeGreaterThanOrEqual(childAgentRuns.length);
  expect(childSpans.filter(span => span.kind === 'llm').length).toBeGreaterThanOrEqual(childAgentRuns.length);
  expect(childSpans.every(span => span.status === 'completed')).toBe(true);

  const approvalFeedback = await expectApi<{
    feedback: Array<{ label: string; score: number | null; sentiment: string | null; supersedesId: number | null }>;
  }>(admin, `/api/ui/observability/traces/${codingRun.thread_id}/feedback`, 200);
  expect(approvalFeedback.feedback).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: 'code_approval', score: 1, sentiment: 'positive' }),
  ]));
  expect(approvalFeedback.feedback.find(item => item.label === 'code_approval')?.supersedesId).not.toBeNull();

  const firstQualityFeedback = await expectApi<{
    submitted: { id: number; label: string; score: number; comment: string; supersedesId: number | null };
  }>(admin, `/api/ui/observability/traces/${codingRun.thread_id}/feedback`, 201, {
    method: 'POST',
    body: {
      label: 'e2e_quality',
      score: 0.8,
      sentiment: 'positive',
      comment: 'Trace tree reviewed by alex@example.com.',
      tags: ['e2e', 'trace-tree'],
    },
  });
  expect(firstQualityFeedback.submitted).toMatchObject({
    label: 'e2e_quality',
    score: 0.8,
    comment: 'Trace tree reviewed by [EMAIL]',
    supersedesId: null,
  });
  const revisedQualityFeedback = await expectApi<{
    submitted: { id: number; label: string; score: number; supersedesId: number | null };
    feedback: Array<{ label: string; score: number }>;
  }>(admin, `/api/ui/observability/traces/${codingRun.thread_id}/feedback`, 201, {
    method: 'POST',
    body: {
      label: 'e2e_quality',
      score: 0.9,
      sentiment: 'positive',
      comment: 'Trace tree and redaction revision passed.',
      tags: ['e2e', 'trace-tree'],
    },
  });
  expect(revisedQualityFeedback.submitted).toMatchObject({
    label: 'e2e_quality',
    score: 0.9,
    supersedesId: firstQualityFeedback.submitted.id,
  });
  expect(revisedQualityFeedback.feedback.filter(item => item.label === 'e2e_quality')).toEqual([
    expect.objectContaining({ score: 0.9 }),
  ]);

  const runIndex = await expectApi<{
    runs: Array<{ id: string; kind: string; href: string; title: string }>;
  }>(admin, '/api/ui/runs', 200);
  expect(runIndex.runs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: codingRun.thread_id,
      kind: 'workflow',
      href: `/runs/workflow/${codingRun.thread_id}`,
    }),
  ]));
  const langGraphRunDetail = await expectApi<{
    run: { id: string; kind: string; traceId: string; rootTraceId: string };
    metrics: { agentCount: number; llmCallCount: number; ragCallCount: number; approvalCount: number };
    traceFamily: { rootTraceId: string; runs: unknown[]; spans: unknown[] };
  }>(admin, `/api/ui/runs/workflow/${codingRun.thread_id}`, 200);
  expect(langGraphRunDetail.run).toMatchObject({
    id: codingRun.thread_id,
    kind: 'workflow',
    traceId: codingRun.thread_id,
    rootTraceId: codingRun.thread_id,
  });
  expect(langGraphRunDetail.metrics).toMatchObject({
    agentCount: expect.any(Number),
    llmCallCount: expect.any(Number),
    ragCallCount: expect.any(Number),
    approvalCount: 2,
  });
  expect(langGraphRunDetail.metrics.agentCount).toBeGreaterThanOrEqual(6);
  expect(langGraphRunDetail.metrics.llmCallCount).toBeGreaterThanOrEqual(6);
  expect(langGraphRunDetail.metrics.ragCallCount).toBeGreaterThanOrEqual(6);
  expect(langGraphRunDetail.traceFamily.rootTraceId).toBe(codingRun.thread_id);

  await admin.goto('/observe');
  const langGraphRunLink = admin.locator(`a[href="/runs/workflow/${codingRun.thread_id}"]`).first();
  await expect(langGraphRunLink).toBeVisible();
  await langGraphRunLink.click();
  await expect(admin).toHaveURL(new RegExp(`/runs/workflow/${codingRun.thread_id}$`));
  await expect(admin.getByRole('heading', { name: 'Distributed trace' })).toBeVisible();
  await expect(admin.getByLabel('Runtime trace summary')).toContainText('Argus LangGraph');
  await expect(admin.getByLabel('Runtime trace summary')).toContainText('Approval gates');
  const approvalMarker = admin.getByRole('button', { name: /Code Approval/ });
  await expect(approvalMarker).toBeVisible();
  await approvalMarker.click();
  await expect(admin.getByLabel('Approval evidence')).toContainText('Deterministic E2E code review passed');
  await admin.getByRole('button', { name: /Waterfall/ }).click();
  await expect(admin.getByRole('heading', { name: 'Distributed waterfall' })).toBeVisible();
  await expect(admin.getByText('llm.worker', { exact: true }).first()).toBeVisible();

  const viewerContext = await browser.newContext();
  const viewer = await viewerContext.newPage();
  await login(viewer, 'e2e-viewer', 'ViewerPass42!');
  const viewerMe = await expectApi<{ user: { role: string } }>(viewer, '/api/me', 200);
  expect(viewerMe.user.role).toBe('viewer');
  const visibleAgents = await expectApi<Array<{ id: number }>>(viewer, '/api/agents', 200);
  expect(visibleAgents.map(item => item.id)).toContain(agent.id);
  await expectApi(viewer, '/api/admin/users', 403);
  await expectApi(viewer, '/api/ui/public-widgets', 403);
  await expectApi(viewer, '/api/ui/runtime-controls', 403);
  await expectApi(viewer, '/api/ui/compliance', 403);

  await viewerContext.close();
  await adminContext.close();
});
