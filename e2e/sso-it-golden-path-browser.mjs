import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { generateTotp, LOCAL_MFA_ALEX } from '../scripts/lib/localMfaDemo.mjs';

const baseUrl = (process.env.ARGUS_SSO_IT_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const outputDirectory = resolve(import.meta.dirname, '..', 'test-results');
const channels = ['msedge', 'chrome', undefined];
let browser = null;
let browserChannel = 'chromium';
for (const channel of channels) {
  try {
    browser = await chromium.launch({
      ...(channel ? { channel } : {}),
      headless: true,
      args: ['--force-device-scale-factor=1'],
    });
    browserChannel = channel ?? 'chromium';
    break;
  } catch (error) {
    if (channel === undefined) throw error;
  }
}
if (!browser) throw new Error('No supported Chromium browser is available');

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
let previousTotp = null;

async function freshTotp() {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const code = generateTotp({ secret: LOCAL_MFA_ALEX.totpSecret });
    if (code !== previousTotp) {
      previousTotp = code;
      return code;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error('No fresh Alex TOTP became available');
}

async function submitProviderFactors() {
  await page.waitForLoadState('domcontentloaded');
  const username = page.locator('#username');
  const password = page.locator('#password');
  const otp = page.locator('#otp');
  if (await password.isVisible().catch(() => false)) {
    if (await username.isVisible().catch(() => false)) await username.fill(LOCAL_MFA_ALEX.username);
    await password.fill(LOCAL_MFA_ALEX.password);
    await page.locator('#kc-login').click();
  }
  if (page.url().startsWith(baseUrl)) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await otp.waitFor({ state: 'visible', timeout: 15_000 });
    await otp.fill(await freshTotp());
    await page.locator('#kc-login').click();
    const returned = await page.waitForURL(
      new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
      { timeout: 5_000 },
    ).then(() => true).catch(() => false);
    if (returned) return;
  }
  throw new Error(`Keycloak rejected Alex's factors: ${page.url()}`);
}

async function apiSnapshot() {
  return page.evaluate(async () => {
    const read = async (path, init) => {
      const response = await fetch(path, {
        headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
        ...init,
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: response.status, body };
    };
    const [me, identity, packs, workflows, fabric, management, capabilities] = await Promise.all([
      read('/api/me'),
      read('/api/me/identity-security'),
      read('/api/ui/solution-packs'),
      read('/api/admin/workflows'),
      read('/api/ui/mcp-fabric'),
      read('/api/ui/mcp-fabric/manage'),
      read('/api/ui/mcp-fabric/capabilities'),
    ]);
    return { me, identity, packs, workflows, fabric, management, capabilities };
  });
}

async function browserApi(path, init = {}) {
  return page.evaluate(async ({ requestPath, requestInit }) => {
    const response = await fetch(requestPath, {
      method: requestInit.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(requestInit.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(requestInit.body === undefined ? {} : { body: JSON.stringify(requestInit.body) }),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body };
  }, { requestPath: path, requestInit: init });
}

function responseText(result) {
  const value = result?.body?.response?.body;
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

async function capabilityProof(capabilities, name, parameters, expected) {
  const capability = capabilities.find(item => item.name === name && Number.isSafeInteger(item.managedId));
  if (!capability) return { name, passed: false, error: 'Capability is not in the SSO-scoped catalog' };
  const result = await browserApi(`/api/ui/mcp-fabric/capabilities/${capability.managedId}/playground`, {
    method: 'POST', body: { parameters, execute: true },
  });
  const text = responseText(result);
  const upstreamStatus = Number(result.body?.response?.status ?? 0);
  const auditId = Number(result.body?.auditId ?? 0);
  return {
    name,
    capabilityId: capability.managedId,
    status: result.status,
    upstreamStatus,
    auditId: Number.isSafeInteger(auditId) && auditId > 0 ? auditId : null,
    responseBytes: Buffer.byteLength(text, 'utf8'),
    responseSha256: digest(text),
    matchedExpectedEvidence: expected.test(text),
    passed: result.status === 200
      && result.body?.executed === true
      && upstreamStatus >= 200 && upstreamStatus < 300
      && Number.isSafeInteger(auditId) && auditId > 0
      && expected.test(text),
    ...(result.status === 200 ? {} : { error: result.body?.error ?? `HTTP ${result.status}` }),
  };
}

async function devAgentPreflight(bundles) {
  const bundle = bundles.find(item => item.name === 'argus-dev-demo');
  if (!bundle) return { passed: false, error: 'Argus.Dev Demo bundle is missing' };
  const response = await browserApi('/api/admin/solution-packs/argus.dev/agents/coding-orchestrator/a2a/message', {
    method: 'POST',
    body: {
      text: 'Verify the SSO-attributed Dev workflow and its governed repository plus CI boundary.',
      data: { operation: 'coding.preflight' },
      execution: { bundleIds: [bundle.id] },
    },
  });
  const task = response.body?.task;
  const evidence = task?.artifacts?.flatMap(artifact => artifact.parts ?? [])
    .map(part => part.data).find(data => data?.ready !== undefined) ?? null;
  const workflows = Array.isArray(evidence?.workflows) ? evidence.workflows : [];
  const ticketFlow = workflows.find(workflow => workflow.id === 'ticket-to-pull-request');
  const requiredCategories = Array.isArray(ticketFlow?.requiredBundleCategories)
    ? ticketFlow.requiredBundleCategories : [];
  const executionPrincipal = task?.metadata?.executionPrincipal ?? null;
  return {
    status: response.status,
    taskId: task?.id ?? null,
    rootTraceId: response.body?.rootTraceId ?? null,
    executionPrincipal,
    bundleId: bundle.id,
    workflowId: evidence?.workflowId ?? null,
    requiredAgents: Array.isArray(evidence?.requiredAgents)
      ? evidence.requiredAgents.map(agent => agent.name).sort() : [],
    requiredBundleCategories: requiredCategories,
    passed: response.status === 200
      && task?.status?.state === 'TASK_STATE_COMPLETED'
      && evidence?.ready === true
      && evidence?.toolTransport === 'MCP'
      && requiredCategories.includes('repository')
      && requiredCategories.includes('ci')
      && (executionPrincipal === null || /^user:\d+$/.test(executionPrincipal)),
  };
}

async function runVisualSsoProof(workflows) {
  const workflowList = Array.isArray(workflows) ? workflows : workflows?.workflows ?? [];
  const workflow = workflowList.find(item => item.name === 'sso_it_readonly_backend_proof');
  if (!workflow) return { passed: false, error: 'SSO read-only proof workflow is missing' };
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60_000);
  const created = await browserApi(`/api/workflows/${workflow.id}/execute`, {
    method: 'POST',
    body: { input: { window_start: start.toISOString(), window_end: end.toISOString() }, mock: false },
  });
  const executionId = Number(created.body?.executionId ?? 0);
  if (created.status !== 200 || !Number.isSafeInteger(executionId) || executionId <= 0) {
    return { passed: false, status: created.status, error: created.body?.error ?? 'Workflow was not accepted' };
  }
  let detail = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const current = await browserApi(`/api/workflows/${workflow.id}/runs/${executionId}`);
    if (current.status === 200) {
      detail = current.body;
      if (['completed', 'failed', 'waiting_for_approval'].includes(detail?.status)) break;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  const stepResults = detail?.step_results && typeof detail.step_results === 'object'
    ? detail.step_results : {};
  const completedSteps = Object.entries(stepResults)
    .filter(([, value]) => value?.status === 'completed')
    .map(([key]) => key)
    .sort();
  const requiredSteps = [
    'gitea_repository', 'gitea_ci', 'jenkins_jobs', 'jenkins_build',
    'prometheus', 'loki', 'jaeger', 'opensearch_health', 'opensearch_logs', 'result',
  ];
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    executionId,
    status: detail?.status ?? 'timeout',
    triggeredBy: detail?.triggered_by ?? null,
    traceId: detail?.trace_id ?? null,
    rootTraceId: detail?.root_trace_id ?? null,
    completedSteps,
    stepResultSha256: digest(stepResults),
    error: detail?.error_message ?? detail?.error ?? null,
    passed: detail?.status === 'completed'
      && String(detail?.triggered_by ?? '').startsWith('builder:oidc:')
      && typeof detail?.trace_id === 'string' && detail.trace_id.length > 0
      && requiredSteps.every(step => completedSteps.includes(step)),
  };
}

async function testConnections(backends) {
  const testable = backends.filter(backend => backend.enabled && backend.managed && backend.type !== 'builtin');
  const results = [];
  for (let offset = 0; offset < testable.length; offset += 4) {
    const batch = testable.slice(offset, offset + 4);
    results.push(...await page.evaluate(async connections => Promise.all(connections.map(async connection => {
      const response = await fetch(`/api/ui/mcp-fabric/connections/${connection.id}/test`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: '{}',
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { id: connection.id, name: connection.name, status: response.status, body };
    })), batch));
  }
  return results;
}

async function inspectPage(path, expectedText, screenshotName) {
  await page.goto(`${baseUrl}${path}`);
  await page.waitForLoadState('domcontentloaded');
  await page.locator('main, .app-stage').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
  const body = await page.locator('body').innerText();
  const passed = expectedText.test(body) && !/Zugriff verweigert|Access denied/i.test(body);
  await page.screenshot({ path: resolve(outputDirectory, screenshotName), fullPage: false });
  return { path, passed, url: page.url(), expected: expectedText.source };
}

function moduleAssignments(backend, bundleLabels) {
  const haystack = `${backend.name} ${backend.description ?? ''} ${bundleLabels.join(' ')}`.toLowerCase();
  const modules = [];
  if (/aiops|observ|prometheus|loki|jaeger|grafana|elastic|opensearch|kubernetes/.test(haystack)) modules.push('argus.aiops');
  if (/dev|code|git|github|gitea|gitlab|bitbucket|jenkins|jira|repository/.test(haystack)) modules.push('argus.dev');
  if (backend.workflowCount > 0 || /workflow|slack|notification/.test(haystack)) modules.push('workflow-builder');
  if (modules.length === 0) modules.push('argus.core');
  return modules;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

try {
  mkdirSync(outputDirectory, { recursive: true });
  await page.goto(`${baseUrl}/login`);
  await page.getByRole('link', { name: /Argus MFA Demo/i }).click();
  await submitProviderFactors();
  await page.waitForURL(new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));

  await page.goto(`${baseUrl}/auth/oidc/step-up?returnTo=${encodeURIComponent('/home')}`);
  await submitProviderFactors();
  await page.waitForURL(`${baseUrl}/home`);

  const api = await apiSnapshot();
  const management = api.management.body ?? {};
  let fabric = api.fabric.body ?? {};
  const backends = Array.isArray(management.backends) ? management.backends : [];
  const bundles = Array.isArray(management.bundles) ? management.bundles : [];
  const bundleById = new Map(bundles.map(bundle => [bundle.id, bundle]));
  const capabilities = Array.isArray(api.capabilities.body?.capabilities)
    ? api.capabilities.body.capabilities : [];
  const connectionTests = await testConnections(backends);
  const testById = new Map(connectionTests.map(result => [result.id, result]));
  const refreshedFabric = await page.evaluate(async () => {
    const response = await fetch('/api/ui/mcp-fabric', { headers: { accept: 'application/json' } });
    return { status: response.status, body: await response.json() };
  });
  if (refreshedFabric.status === 200) fabric = refreshedFabric.body ?? fabric;
  const effectiveByName = new Map((fabric.servers ?? []).map(server => [String(server.name).toLowerCase(), server]));

  const backendEvidence = backends.filter(backend => backend.enabled).map(backend => {
    const assignedBundles = (backend.bundleIds ?? []).map(id => bundleById.get(id)).filter(Boolean);
    const test = testById.get(backend.id) ?? null;
    const effective = effectiveByName.get(String(backend.name).toLowerCase()) ?? null;
    return {
      id: backend.id,
      name: backend.name,
      type: backend.type,
      modules: moduleAssignments(backend, assignedBundles.map(bundle => `${bundle.name} ${bundle.label}`)),
      bundles: assignedBundles.map(bundle => ({ id: bundle.id, name: bundle.name, label: bundle.label })),
      policyBound: assignedBundles.length > 0 || backend.type === 'builtin' || backend.name === 'postgresql',
      toolCount: backend.toolCount,
      workflowCount: backend.workflowCount,
      effectiveState: effective?.state ?? backend.state ?? 'unknown',
      test: test ? {
        status: test.status,
        reachable: test.status === 200 && test.body?.reachable === true,
        latencyMs: test.body?.latencyMs ?? null,
        auditId: Number.isSafeInteger(test.body?.auditId) ? test.body.auditId : null,
        error: test.body?.error ?? null,
      } : null,
    };
  });

  const evidenceEnd = new Date();
  const evidenceStart = new Date(evidenceEnd.getTime() - 60 * 60_000);
  const moduleActions = {
    dev: {
      agentPreflight: await devAgentPreflight(bundles),
      repository: await capabilityProof(
        capabilities, 'gitea_local_get_repo',
        { owner: 'argus', repo: 'argus-dev-sample' },
        /argus(?:\\\/|\/)argus-dev-sample|argus-dev-sample/i,
      ),
      ci: await capabilityProof(
        capabilities, 'gitea_local_list_action_runs',
        { owner: 'argus', repo: 'argus-dev-sample', limit: 20 },
        /workflow_runs|total_count|entries/i,
      ),
      jenkins: await capabilityProof(
        capabilities, 'jenkins_prod_get_job',
        { job_name: 'checkout-api-production' },
        /checkout-api-production|lastBuild|SUCCESS/i,
      ),
    },
    aiops: {
      metrics: await capabilityProof(capabilities, 'aiops_prometheus_query', { query: 'up' }, /argus-core|"1"/i),
      logs: await capabilityProof(
        capabilities, 'aiops_loki_query_range',
        {
          query: '{service="argus-core", environment="local-demo"}',
          start: evidenceStart.toISOString(), end: evidenceEnd.toISOString(), limit: 20, direction: 'backward',
        },
        /simulated timeout|trace_id/i,
      ),
      traces: await capabilityProof(capabilities, 'aiops_jaeger_services', {}, /argus-core/i),
      opensearchHealth: await capabilityProof(
        capabilities, 'opensearch_prod_get_cluster_health', {},
        /argus-production-like|green|yellow/i,
      ),
      opensearchLogs: await capabilityProof(
        capabilities, 'opensearch_prod_search',
        {
          index: 'argus-production-logs',
          query_json: JSON.stringify({
            size: 10,
            query: {
              bool: {
                filter: [
                  { term: { 'service.keyword': 'checkout-api' } },
                  { term: { 'environment.keyword': 'production' } },
                ],
                must: [{ match: { message: 'payment-provider-timeout' } }],
              },
            },
          }),
        },
        /payment-provider-timeout|trace-checkout-002/i,
      ),
    },
    workflow: await runVisualSsoProof(api.workflows.body),
  };

  const pages = {
    dev: await inspectPage('/solutions/argus.dev', /Argus\.?\s*Dev/i, 'sso-it-golden-path-dev.png'),
    aiops: await inspectPage('/solutions/argus.aiops', /Argus\.?\s*AIOps/i, 'sso-it-golden-path-aiops.png'),
    workflows: await inspectPage('/build/workflows', /Workflows/i, 'sso-it-golden-path-workflows.png'),
    fabric: await inspectPage('/mcp-fabric', /MCP Fabric/i, 'sso-it-golden-path-fabric.png'),
  };

  const apiStatuses = Object.fromEntries(Object.entries(api).map(([key, value]) => [key, value.status]));
  const testable = backendEvidence.filter(backend => backend.test !== null);
  const checks = {
    alexSsoLinked: api.me.status === 200
      && api.identity.body?.session?.ssoLinked === true
      && /^Alex(?:\s|$)/iu.test(String(api.me.body?.user?.display_name ?? '')),
    alexPlatformAdmin: api.me.body?.user?.role === 'platform_admin',
    freshMfa: api.identity.body?.session?.mfaFresh === true,
    coreApisAuthorized: Object.values(apiStatuses).every(status => status === 200),
    devInstalled: (api.packs.body?.packs ?? []).some(pack => pack.configuredId === 'argus.dev' && pack.state === 'ready'),
    aiopsInstalled: (api.packs.body?.packs ?? []).some(pack => pack.configuredId === 'argus.aiops' && pack.state === 'ready'),
    workflowsAvailable: Array.isArray(api.workflows.body) ? api.workflows.body.length > 0 : (api.workflows.body?.workflows ?? []).length > 0,
    modulePagesAuthorized: Object.values(pages).every(result => result.passed),
    everyManagedConnectionReachable: testable.length > 0 && testable.every(backend => backend.test?.reachable),
    everyConnectionTestAudited: testable.length > 0
      && testable.every(backend => Number.isSafeInteger(backend.test?.auditId)),
    everyEnabledBackendPolicyBound: backendEvidence.every(backend => backend.policyBound),
    everyEffectiveServerHealthy: backendEvidence
      .filter(backend => backend.effectiveState !== 'unknown')
      .every(backend => backend.effectiveState === 'healthy'),
    devAgentPreflightReady: moduleActions.dev.agentPreflight.passed === true,
    devRepositoryRead: moduleActions.dev.repository.passed === true,
    devCiRead: moduleActions.dev.ci.passed === true,
    devJenkinsRead: moduleActions.dev.jenkins.passed === true,
    aiopsMetricsRead: moduleActions.aiops.metrics.passed === true,
    aiopsLogsRead: moduleActions.aiops.logs.passed === true,
    aiopsTracesRead: moduleActions.aiops.traces.passed === true,
    aiopsOpenSearchHealthRead: moduleActions.aiops.opensearchHealth.passed === true,
    aiopsOpenSearchProductionLogRead: moduleActions.aiops.opensearchLogs.passed === true,
    visualWorkflowCompleted: moduleActions.workflow.passed === true,
  };

  const payload = {
    schema: 'argus.sso-it-golden-path-certification.v3',
    generatedAt: new Date().toISOString(),
    browser: browserChannel,
    baseUrl,
    identity: {
      userId: api.me.body?.user?.id ?? null,
      displayName: api.me.body?.user?.display_name ?? null,
      username: api.me.body?.user?.username ?? null,
      role: api.me.body?.user?.role ?? null,
      authMethod: api.identity.body?.session?.authMethod ?? null,
      mfaMethod: api.identity.body?.session?.mfaMethod ?? null,
      mfaVerifiedAt: api.identity.body?.session?.mfaVerifiedAt ?? null,
    },
    apiStatuses,
    modules: pages,
    summary: {
      enabledBackends: backendEvidence.length,
      testableConnections: testable.length,
      reachableConnections: testable.filter(backend => backend.test?.reachable).length,
      auditedConnectionTests: testable.filter(backend => Number.isSafeInteger(backend.test?.auditId)).length,
      policyBoundBackends: backendEvidence.filter(backend => backend.policyBound).length,
      bundles: bundles.length,
      effectiveTools: (fabric.tools ?? []).length,
    },
    backends: backendEvidence,
    moduleActions,
    checks,
  };
  const report = { ...payload, payloadSha256: digest(payload), passed: Object.values(checks).every(Boolean) };
  writeFileSync(resolve(outputDirectory, 'sso-it-golden-path-certification.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) throw new Error('SSO IT Golden Path certification failed');
} finally {
  await context.close();
  await browser.close();
}
