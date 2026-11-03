import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const baseUrl = String(process.env.ARGUS_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const origin = new URL(baseUrl).origin;
const connectionString = process.env.POSTGRES_CONNECTION_URL;
const workflowId = Number(process.env.ARGUS_ACCEPTANCE_WORKFLOW_ID ?? process.argv[2]);
const slackChannelId = String(process.env.ARGUS_ACCEPTANCE_SLACK_CHANNEL_ID ?? process.argv[3] ?? '').trim();

if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL is required');
if (!Number.isSafeInteger(workflowId) || workflowId <= 0) {
  throw new Error('Pass a workflow id as the first argument or ARGUS_ACCEPTANCE_WORKFLOW_ID');
}
if (!/^C[A-Z0-9]+$/.test(slackChannelId)) {
  throw new Error('Pass a concrete Slack channel id as the second argument or ARGUS_ACCEPTANCE_SLACK_CHANNEL_ID');
}

const pool = new pg.Pool({ connectionString });
const sessionId = randomUUID();

async function api(path, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: `argus_session=${sessionId}`,
      Origin: origin,
      Referer: `${origin}/build/workflows/studio/${workflowId}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  let payload;
  try { payload = responseText ? JSON.parse(responseText) : null; } catch { payload = responseText; }
  if (!response.ok) {
    const detail = (typeof payload === 'string' ? payload : JSON.stringify(payload)).slice(0, 1_000);
    throw new Error(`${method} ${path} returned ${response.status}: ${detail}`);
  }
  return payload;
}

function patchSlackChannel(flow) {
  let patchedSteps = 0;
  let patchedBlocks = 0;
  const steps = flow.steps.map(step => {
    if (step.type !== 'argus.tool' || (step.integration_id ?? step.tool_binding?.integration_id) !== 'slack') return step;
    patchedSteps += 1;
    return { ...step, args: { ...(step.args ?? {}), channel_id: slackChannelId } };
  });
  const blockDefinitions = flow.block_definitions.map(node => {
    if (node.type !== 'argus.tool' || (node.data?.integration_id ?? node.data?.tool_binding?.integration_id) !== 'slack') return node;
    patchedBlocks += 1;
    return {
      ...node,
      data: {
        ...(node.data ?? {}),
        args: { ...(node.data?.args ?? {}), channel_id: slackChannelId },
      },
    };
  });
  if (patchedSteps === 0 || patchedBlocks === 0) {
    throw new Error('The workflow has no Slack tool step that can be configured for live acceptance');
  }
  return { steps, blockDefinitions, patchedSteps };
}

async function waitForTerminalStatus(executionId, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      `SELECT id, status, started_at, completed_at, duration_ms, step_results, error_message
       FROM mcp_workflow_executions WHERE id = $1`,
      [executionId],
    );
    const execution = rows[0];
    if (!execution) throw new Error(`Execution ${executionId} disappeared from persistence`);
    if (['completed', 'failed', 'cancelled', 'waiting_for_approval'].includes(execution.status)) return execution;
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Execution did not reach a terminal state within ${timeoutMs / 1_000} seconds`);
}

try {
  const { rows: users } = await pool.query(
    `SELECT id, username FROM mcp_users
     WHERE enabled = true AND role IN ('platform_admin', 'admin', 'operations_admin')
     ORDER BY CASE role WHEN 'platform_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id
     LIMIT 1`,
  );
  const user = users[0];
  if (!user) throw new Error('No enabled Argus admin user is available for the live acceptance session');
  await pool.query(
    `INSERT INTO mcp_sessions (id, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, now() + interval '30 minutes', $3, $4)`,
    [sessionId, user.id, '127.0.0.1', 'argus-live-workflow-execution-acceptance'],
  );

  const flow = await api(`/api/workflows/${workflowId}/flow`);
  const patched = patchSlackChannel(flow);
  const validation = await api(`/api/workflows/${workflowId}/validate`, {
    method: 'POST',
    body: { steps: patched.steps },
  });
  if (!validation.valid) {
    throw new Error(`Workflow validation failed: ${JSON.stringify(validation.errors).slice(0, 2_000)}`);
  }
  await api(`/api/workflows/${workflowId}/flow`, {
    method: 'PUT',
    body: {
      steps: patched.steps,
      canvas_state: flow.canvas_state,
      block_definitions: patched.blockDefinitions,
      trigger_config: flow.trigger_config,
    },
  });

  const started = await api(`/api/workflows/${workflowId}/execute`, {
    method: 'POST',
    body: { input: {}, mock: false },
    timeoutMs: 60_000,
  });
  const executionId = Number(started.executionId);
  if (!Number.isSafeInteger(executionId) || executionId <= 0) throw new Error('Execution returned no valid id');

  const execution = await waitForTerminalStatus(executionId);
  const { rows: traces } = await pool.query(
    `SELECT root_trace_id FROM mcp_observability_traces
     WHERE workflow_execution_id = $1 ORDER BY started_at LIMIT 1`,
    [executionId],
  );
  const rootTraceId = traces[0]?.root_trace_id ?? null;
  const result = {
    verdict: execution.status === 'completed' ? 'prototype-ready' : 'needs-attention',
    workflowId,
    workflowName: flow.name,
    studioUrl: `${baseUrl}/build/workflows/studio/${workflowId}`,
    executionId,
    status: execution.status,
    durationMs: execution.duration_ms,
    completedSteps: Object.keys(execution.step_results ?? {}),
    slackChannelId,
    rootTraceId,
    logsUrl: rootTraceId ? `${baseUrl}/observe/logs?root_trace=${rootTraceId}` : null,
    error: execution.error_message,
  };
  console.log(JSON.stringify(result, null, 2));
  if (execution.status !== 'completed') process.exitCode = 2;
} finally {
  await pool.query('DELETE FROM mcp_sessions WHERE id = $1', [sessionId]).catch(() => {});
  await pool.end();
}
