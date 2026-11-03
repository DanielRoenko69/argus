import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resultText(result) {
  return result.content
    ?.filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n') ?? '';
}

function toolJson(result, toolName) {
  const text = resultText(result);
  if (result.isError) throw new Error(`${toolName} failed: ${text.slice(0, 1_000)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${toolName} returned non-JSON output: ${text.slice(0, 500)}`);
  }
}

function positiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const key = required('ARGUS_HERMES_DEV_MCP_KEY');
  const url = new URL(process.env.ARGUS_HERMES_DEV_MCP_URL?.trim()
    || 'http://127.0.0.1:3000/mcp/hermes-dev');
  const ticketId = process.env.ARGUS_HERMES_DEV_FIXTURE_TICKET?.trim()
    || `HERMES-BRIDGE-CERT-${Date.now()}`;
  const description = process.env.ARGUS_HERMES_DEV_FIXTURE_DESCRIPTION?.trim()
    || [
      'Hermes Dev bridge lifecycle certification against the configured local demo repository.',
      'Create docs/hermes-bridge-certification.md containing a short statement that this is an isolated certification fixture.',
      'Do not modify runtime code or dependencies.',
      'Do not commit, push, open a pull request, merge, deploy, or change credentials.',
      'Stop at the first Argus human approval gate.',
    ].join(' ');
  // A personal MCP session is intentionally capped at 60 tool calls. Ten
  // seconds leaves enough headroom for a full planner/coder/test/review pass
  // plus the evidence and cleanup calls within the 15-minute lifecycle SLA.
  const pollMs = positiveInteger('ARGUS_HERMES_DEV_POLL_MS', 10_000);
  const timeoutMs = positiveInteger('ARGUS_HERMES_DEV_TIMEOUT_MS', 15 * 60_000);
  const originSessionRef = `cert-${randomUUID()}`;
  const client = new Client(
    { name: 'argus-hermes-dev-lifecycle-certifier', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  let taskId = null;
  let terminal = false;

  try {
    await client.connect(transport);
    const started = toolJson(await client.callTool({
      name: 'argus_dev_start_workflow',
      arguments: {
        ticket_id: ticketId,
        description,
        origin_session_ref: originSessionRef,
      },
    }), 'argus_dev_start_workflow');
    taskId = started.taskId;
    if (!taskId || !started.rootTraceId) {
      throw new Error(`Start did not return task ownership and trace evidence: ${JSON.stringify(started).slice(0, 1_000)}`);
    }

    process.stdout.write(`${JSON.stringify({
      event: 'started',
      ticketId,
      taskId,
      contextId: started.contextId,
      rootTraceId: started.rootTraceId,
      state: started.state,
      currentStage: started.currentStage,
    })}\n`);

    const deadline = Date.now() + timeoutMs;
    let previousProjection = '';
    let waiting = started;
    while (Date.now() < deadline) {
      const run = toolJson(await client.callTool({
        name: 'argus_dev_get_run',
        arguments: { task_id: taskId },
      }), 'argus_dev_get_run');
      if (run.taskId !== taskId || run.rootTraceId !== started.rootTraceId) {
        throw new Error('Owned run projection changed task or root trace identity');
      }
      waiting = run;
      const projection = `${run.state}:${run.currentStage ?? ''}`;
      if (projection !== previousProjection) {
        process.stdout.write(`${JSON.stringify({
          event: 'state',
          taskId,
          state: run.state,
          currentStage: run.currentStage,
          approvalRequired: run.approvalRequired,
        })}\n`);
        previousProjection = projection;
      }
      if (run.state === 'TASK_STATE_INPUT_REQUIRED') break;
      if (TERMINAL_STATES.has(run.state)) {
        terminal = true;
        throw new Error(`Workflow became terminal before the approval gate: ${run.state}`);
      }
      await sleep(pollMs);
    }

    if (waiting.state !== 'TASK_STATE_INPUT_REQUIRED' || waiting.currentStage !== 'human_approval') {
      throw new Error(`Workflow did not reach the first human approval gate within ${timeoutMs} ms`);
    }

    const workspace = toolJson(await client.callTool({
      name: 'argus_dev_get_workspace_evidence',
      arguments: { task_id: taskId },
    }), 'argus_dev_get_workspace_evidence');
    if (workspace.taskId !== taskId
      || workspace.rootTraceId !== started.rootTraceId
      || workspace.scope !== 'owned-run-bounded-evidence') {
      throw new Error('Workspace evidence escaped or lost the owned-run boundary');
    }
    if (!Array.isArray(workspace.fileDiffs) || workspace.fileDiffs.length === 0) {
      throw new Error('Workspace evidence did not contain the fixture diff');
    }
    if (workspace.testsPassed !== true || workspace.reviewPassed !== true) {
      throw new Error(`Workspace evidence did not prove tests and review: ${JSON.stringify({
        testsPassed: workspace.testsPassed,
        reviewPassed: workspace.reviewPassed,
      })}`);
    }

    const prematureResult = await client.callTool({
      name: 'argus_dev_get_result',
      arguments: { task_id: taskId },
    });
    if (!prematureResult.isError || !resultText(prematureResult).includes('bridge_result_not_ready')) {
      throw new Error('Result became readable before the run reached a terminal state');
    }

    const cancelled = toolJson(await client.callTool({
      name: 'argus_dev_cancel_run',
      arguments: { task_id: taskId },
    }), 'argus_dev_cancel_run');
    if (cancelled.state !== 'TASK_STATE_CANCELED' || !cancelled.terminal) {
      throw new Error(`Cancellation did not produce a terminal canceled task: ${JSON.stringify(cancelled).slice(0, 1_000)}`);
    }
    terminal = true;

    const result = toolJson(await client.callTool({
      name: 'argus_dev_get_result',
      arguments: { task_id: taskId },
    }), 'argus_dev_get_result');
    if (result.state !== 'TASK_STATE_CANCELED' || result.successful !== false || !Array.isArray(result.artifacts)) {
      throw new Error(`Canceled result projection is invalid: ${JSON.stringify(result).slice(0, 1_000)}`);
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      endpoint: url.toString(),
      ticketId,
      taskId,
      contextId: result.contextId,
      rootTraceId: result.rootTraceId,
      approvalGateReached: true,
      workspaceEvidenceBounded: true,
      fileDiffCount: workspace.fileDiffs.length,
      testsPassed: workspace.testsPassed,
      reviewPassed: workspace.reviewPassed,
      prematureResultBlocked: true,
      finalState: result.state,
      successful: result.successful,
      artifactCount: result.artifacts.length,
    }, null, 2)}\n`);
  } finally {
    if (taskId && !terminal) {
      await client.callTool({
        name: 'argus_dev_cancel_run',
        arguments: { task_id: taskId },
      }).catch(() => undefined);
    }
    await client.close().catch(() => undefined);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
