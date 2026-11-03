import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const phase = process.env.ARGUS_GOLDEN_PATH_CERT_PHASE ?? 'prepare';
const statePath = join(process.cwd(), 'test-results', 'golden-path-restart-state.json');

type ApiOptions = { method?: string; body?: unknown; headers?: Record<string, string> };

async function api<T>(page: Page, path: string, options: ApiOptions = {}): Promise<{ status: number; body: T; text: string }> {
  return page.evaluate(async ({ path, options }) => {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body: body as T, text };
  }, { path, options });
}

async function expectApi<T>(page: Page, path: string, expected: number, options: ApiOptions = {}): Promise<T> {
  const result = await api<T>(page, path, options);
  expect(result.status, `${options.method ?? 'GET'} ${path}: ${result.text}`).toBe(expected);
  return result.body;
}

async function poll<T>(page: Page, path: string, predicate: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = '';
  while (Date.now() < deadline) {
    const result = await api<T>(page, path);
    latest = `${result.status} ${result.text}`;
    if (result.status === 200 && predicate(result.body)) return result.body;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out polling ${path}. Last response: ${latest}`);
}

async function registerFirstAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#username').fill('e2e-admin');
  await page.locator('#display_name').fill('Argus Golden Path Admin');
  await page.locator('#password').fill('ArgusE2e42!');
  await page.locator('#password_confirm').fill('ArgusE2e42!');
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Registrieren' }).click()]);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#username').fill('e2e-admin');
  await page.locator('#password').fill('ArgusE2e42!');
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Anmelden' }).click()]);
}

type GoldenStart = {
  runId: string;
  workflowExecutionId: number;
  traceId: string;
  replayed: boolean;
  href: string;
};

type GoldenRun = {
  status: string;
  correlation: { runId: string; traceId: string };
  approval: { id: string | null; state: string };
  outcomes: Array<{ target: string; operation: string; state: string; attemptCount: number; retryable: boolean; providerReceiptSha256: string | null }>;
  stages: Array<{ id: string; state: string }>;
  evidence: { state: string; offlineVerifiable: boolean; resourceRefIds: string[] };
  resourceRefs: Array<{ refId: string; type: string; id: string; sha256?: string }>;
  allowedActions: string[];
};

const sealedEvidence = (run: GoldenRun): boolean =>
  ['completed', 'completed_with_gaps', 'rejected', 'failed'].includes(run.status)
  && run.evidence.offlineVerifiable
  && run.evidence.resourceRefIds.includes('audit-report')
  && run.evidence.resourceRefIds.includes('evidence-pack');

const workflowInputs = [
  { name: 'repository_owner', type: 'string', description: 'Bounded repository owner', required: true },
  { name: 'repository_name', type: 'string', description: 'Bounded repository name', required: true },
  { name: 'issue_number', type: 'number', description: 'Bounded issue number', required: true },
  { name: 'notification_channel', type: 'string', description: 'Bounded notification destination', required: true },
  { name: 'write_mode', type: 'string', description: 'read_only or guarded', required: true },
];

function workflowSteps(agentId: number, notificationTool = 'argus_e2e_slack_post_message') {
  return [
    { id: 'manual', label: 'Golden Path start', type: 'trigger.manual', args: {} },
    { id: 'read_issue', label: 'Read bounded issue', type: 'argus.tool', tool: 'argus_e2e_gitea_get_issue', args: {}, depends_on: ['manual'] },
    {
      id: 'triage', label: 'Analyze issue', type: 'argus.agent', agent_id: agentId,
      args: { prompt: 'Analyze this deterministic issue without calling tools or modifying external systems.\n\n{{ steps.read_issue.result }}' },
      depends_on: ['read_issue'],
    },
    {
      id: 'approval', label: 'Approve bounded outcomes', type: 'argus.approval',
      condition: "input.write_mode === 'guarded'", args: { message: 'Approve the exact bounded Golden Path outcomes?' }, depends_on: ['triage'],
    },
    { id: 'comment_issue', label: 'Comment', type: 'argus.tool', tool: 'argus_e2e_gitea_comment_issue', condition: "input.write_mode === 'guarded'", args: {}, depends_on: ['approval'] },
    { id: 'add_label', label: 'Label', type: 'argus.tool', tool: 'argus_e2e_gitea_add_label', condition: "input.write_mode === 'guarded'", args: {}, depends_on: ['approval'] },
    { id: 'notify', label: 'Notify', type: 'argus.tool', tool: notificationTool, condition: "input.write_mode === 'guarded'", args: {}, depends_on: ['comment_issue', 'add_label'] },
    { id: 'response', label: 'Result', type: 'logic.response', args: { value: '{{ steps.triage.result }}' }, depends_on: ['notify'] },
  ];
}

test('prepare and exercise the fresh Golden Path before restart', async ({ page }) => {
  test.skip(phase !== 'prepare', 'Only runs during Golden Path prepare phase.');
  test.setTimeout(180_000);
  await registerFirstAdmin(page);
  const me = await expectApi<{ user: { id: number } }>(page, '/api/me', 200);
  const packs = await expectApi<{ packs: Array<{ configuredId: string; state: string }> }>(page, '/api/admin/solution-packs/refresh', 200, { method: 'POST' });
  expect(packs.packs).toEqual(expect.arrayContaining([expect.objectContaining({ configuredId: 'argus.dev', state: 'ready' })]));

  const provider = await expectApi<{ id: number }>(page, '/api/ui/llm/providers', 201, {
    method: 'POST',
    body: { name: 'golden-e2e-provider', label: 'Golden E2E Provider', providerType: 'openai-compatible', baseUrl: 'http://fake-openai:4000/v1', authType: 'none', secretName: null, credentialProfileId: null, enabled: true },
  });
  await expectApi(page, '/api/ui/llm/models', 201, {
    method: 'POST',
    body: { modelName: 'e2e-chat', displayName: 'Golden E2E Chat', providerId: provider.id, upstreamModelName: 'e2e-chat', enabled: true, supportsVision: false, supportsTools: true, supportsReasoning: false, maxInputTokens: 8192, maxOutputTokens: 2048, inputCostPer1k: 0, outputCostPer1k: 0 },
  });
  const agent = await expectApi<{ id: number }>(page, '/api/admin/agents', 201, {
    method: 'POST',
    body: { name: 'e2e-operator', label: 'Golden E2E Operator', description: 'Deterministic Golden Path agent', model: 'e2e-chat', system_prompt: 'Analyze only the supplied deterministic issue. Do not call tools.', enabled: true, agent_mode: 'chat', max_iterations: 3, visibility: 'internal', min_role: 'viewer', risk_level: 'low', human_oversight_required: false, untrusted_tool_output_enforcement: true },
  });
  const fabric = await expectApi<{ bundles: Array<{ id: number; name: string }> }>(page, '/api/ui/mcp-fabric/manage', 200);
  const git = fabric.bundles.find(bundle => bundle.name === 'argus_e2e_gitea');
  const slack = fabric.bundles.find(bundle => bundle.name === 'argus_e2e_slack_fixture');
  expect(git).toBeTruthy();
  expect(slack).toBeTruthy();

  const steps = workflowSteps(agent.id);
  const workflow = await expectApi<{ id: number }>(page, '/api/admin/workflows', 201, {
    method: 'POST',
    body: { name: 'e2e_golden_path_workflow', description: 'Focused Golden Path release certification.', steps, input_params: workflowInputs, bundle_ids: [git!.id, slack!.id], human_oversight_required: false },
  });
  await expectApi(page, `/api/workflows/${workflow.id}/flow`, 200, {
    method: 'PUT',
    body: { steps, input_params: workflowInputs, trigger_config: { type: 'manual' }, canvas_state: {}, block_definitions: [] },
  });
  for (const bundle of [git!, slack!]) {
    await expectApi(page, `/api/ui/mcp-fabric/bundles/${bundle.id}/access`, 200, {
      method: 'PATCH', body: { kind: 'workflow', id: workflow.id, granted: true },
    });
  }
  await expectApi(page, '/api/ui/access-policies/users', 200, {
    method: 'PUT',
    body: { userId: me.user.id, compositeIds: [], agentIds: [agent.id], rules: [
      { toolPattern: 'argus_e2e_gitea_*', effect: 'allow', reason: 'Golden Path Git fixture', expiresAt: null },
      { toolPattern: 'argus_e2e_slack_*', effect: 'allow', reason: 'Golden Path Slack fixture', expiresAt: null },
    ] },
  });

  const preflight = await expectApi<{ state: string; allowedActions: string[] }>(page, '/api/ui/golden-path/v1/preflight?mode=certification&writeMode=guarded', 200);
  expect(preflight).toMatchObject({ state: 'ready', allowedActions: ['start', 'refresh'] });

  const readOnly = await expectApi<GoldenStart>(page, '/api/ui/golden-path/v1/runs', 202, {
    method: 'POST', headers: { 'idempotency-key': 'cert-read-only-1' }, body: { mode: 'certification', writeMode: 'read_only' },
  });
  const replay = await expectApi<GoldenStart>(page, '/api/ui/golden-path/v1/runs', 200, {
    method: 'POST', headers: { 'idempotency-key': 'cert-read-only-1' }, body: { mode: 'certification', writeMode: 'read_only' },
  });
  expect(replay).toMatchObject({ runId: readOnly.runId, workflowExecutionId: readOnly.workflowExecutionId, replayed: true });
  const readDone = await poll<GoldenRun>(page, readOnly.href, sealedEvidence, 60_000);
  expect(readDone.approval.state).toBe('not_required');
  expect(readDone.outcomes).toEqual([]);
  expect(readDone.allowedActions).toEqual(expect.arrayContaining(['open_trace', 'open_report', 'download_evidence']));

  const approved = await expectApi<GoldenStart>(page, '/api/ui/golden-path/v1/runs', 202, {
    method: 'POST', headers: { 'idempotency-key': 'cert-approved-1' }, body: { mode: 'certification', writeMode: 'guarded' },
  });
  const approvalWait = await poll<GoldenRun>(page, approved.href, run => run.status === 'waiting_for_approval');
  await expectApi(page, `/api/ui/governance/runtime-approvals/${approvalWait.approval.id}/approve`, 200, { method: 'POST', body: { comment: 'Approve bounded certification outcomes.' } });
  const approvedDone = await poll<GoldenRun>(page, approved.href, sealedEvidence, 60_000);
  expect(approvedDone.approval.state).toBe('approved');
  expect(approvedDone.stages.find(stage => stage.id === 'external_action')?.state).toBe('succeeded');
  expect(approvedDone.outcomes.every(outcome => outcome.state === 'succeeded'
    && outcome.attemptCount === 1
    && Boolean(outcome.providerReceiptSha256))).toBe(true);

  const rejected = await expectApi<GoldenStart>(page, '/api/ui/golden-path/v1/runs', 202, {
    method: 'POST', headers: { 'idempotency-key': 'cert-rejected-1' }, body: { mode: 'certification', writeMode: 'guarded' },
  });
  const rejectWait = await poll<GoldenRun>(page, rejected.href, run => run.status === 'waiting_for_approval');
  await expectApi(page, `/api/ui/governance/runtime-approvals/${rejectWait.approval.id}/reject`, 200, { method: 'POST', body: { comment: 'Reject bounded certification outcomes.' } });
  const rejectedDone = await poll<GoldenRun>(page, rejected.href, run => run.status === 'rejected');
  expect(rejectedDone.outcomes.every(outcome => outcome.state === 'skipped' && outcome.attemptCount === 0 && !outcome.retryable)).toBe(true);

  const retrySteps = workflowSteps(agent.id, 'argus_e2e_slack_post_message_flaky');
  await expectApi(page, `/api/workflows/${workflow.id}/flow`, 200, {
    method: 'PUT',
    body: { steps: retrySteps, input_params: workflowInputs, trigger_config: { type: 'manual' }, canvas_state: {}, block_definitions: [] },
  });
  const retryRun = await expectApi<GoldenStart>(page, '/api/ui/golden-path/v1/runs', 202, {
    method: 'POST', headers: { 'idempotency-key': 'cert-checkpoint-retry-1' }, body: { mode: 'certification', writeMode: 'guarded' },
  });
  const retryApproval = await poll<GoldenRun>(page, retryRun.href, run => run.status === 'waiting_for_approval');
  await expectApi(page, `/api/ui/governance/runtime-approvals/${retryApproval.approval.id}/approve`, 200, {
    method: 'POST', body: { comment: 'Approve bounded retry certification outcomes.' },
  });
  const failedAttempt = await poll<GoldenRun>(page, retryRun.href, run => run.status === 'failed');
  expect(failedAttempt.outcomes.find(item => item.operation === 'comment')).toMatchObject({ state: 'succeeded', attemptCount: 1, retryable: false });
  expect(failedAttempt.outcomes.find(item => item.operation === 'add_label')).toMatchObject({ state: 'succeeded', attemptCount: 1, retryable: false });
  expect(failedAttempt.outcomes.find(item => item.operation === 'post_message')).toMatchObject({ state: 'failed', attemptCount: 1, retryable: true });
  const retryReceipt = await expectApi<{ executionId: number; reusedStepIds: string[]; retryStepIds: string[] }>(
    page,
    `/api/ui/golden-path/v1/runs/${retryRun.runId}/retry`,
    202,
    { method: 'POST', body: {} },
  );
  expect(retryReceipt.reusedStepIds).toEqual(expect.arrayContaining(['comment_issue', 'add_label']));
  expect(retryReceipt.retryStepIds).toEqual(expect.arrayContaining(['notify']));
  const retriedDone = await poll<GoldenRun>(page, retryRun.href, sealedEvidence, 60_000);
  expect(retriedDone.correlation.runId).toBe(String(retryReceipt.executionId));
  expect(retriedDone.outcomes.find(item => item.operation === 'comment')?.attemptCount).toBe(1);
  expect(retriedDone.outcomes.find(item => item.operation === 'add_label')?.attemptCount).toBe(1);
  expect(retriedDone.outcomes.find(item => item.operation === 'post_message')).toMatchObject({ state: 'succeeded', attemptCount: 2, retryable: false });

  const restart = await expectApi<GoldenStart>(page, '/api/ui/golden-path/v1/runs', 202, {
    method: 'POST', headers: { 'idempotency-key': 'cert-restart-1' }, body: { mode: 'certification', writeMode: 'guarded' },
  });
  const restartWait = await poll<GoldenRun>(page, restart.href, run => run.status === 'waiting_for_approval');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ restart, approvalId: restartWait.approval.id }, null, 2));
});

test('resume the exact persisted Golden Path after Argus restart', async ({ page }) => {
  test.skip(phase !== 'resume', 'Only runs during Golden Path resume phase.');
  test.setTimeout(60_000);
  await login(page);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { restart: GoldenStart; approvalId: string };
  const waiting = await expectApi<GoldenRun>(page, state.restart.href, 200);
  expect(waiting).toMatchObject({ status: 'waiting_for_approval', approval: { id: state.approvalId, state: 'pending' } });
  const replay = await expectApi<GoldenStart>(page, '/api/ui/golden-path/v1/runs', 200, {
    method: 'POST', headers: { 'idempotency-key': 'cert-restart-1' }, body: { mode: 'certification', writeMode: 'guarded' },
  });
  expect(replay).toMatchObject({ runId: state.restart.runId, workflowExecutionId: state.restart.workflowExecutionId, replayed: true });
  await expectApi(page, `/api/ui/governance/runtime-approvals/${state.approvalId}/approve`, 200, {
    method: 'POST', body: { comment: 'Approve the checkpoint after Argus restart.' },
  });
  const completed = await poll<GoldenRun>(page, state.restart.href, sealedEvidence, 60_000);
  expect(completed.approval).toMatchObject({ id: state.approvalId, state: 'approved' });
  expect(completed.stages.find(stage => stage.id === 'external_action')?.state).toBe('succeeded');
  expect(['complete', 'complete_with_gaps']).toContain(completed.evidence.state);
  expect(completed.resourceRefs).toEqual(expect.arrayContaining([
    expect.objectContaining({ refId: 'audit-report', type: 'audit_report' }),
    expect.objectContaining({ refId: 'evidence-pack', type: 'evidence_pack' }),
  ]));
});
