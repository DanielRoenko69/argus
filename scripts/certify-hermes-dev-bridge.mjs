import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const EXPECTED_TOOLS = [
  'argus_dev_cancel_run',
  'argus_dev_capabilities',
  'argus_dev_get_result',
  'argus_dev_get_run',
  'argus_dev_get_workspace_evidence',
  'argus_dev_preflight',
  'argus_dev_start_workflow',
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function toolJson(result) {
  const text = result.content
    ?.filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n') ?? '';
  if (result.isError) throw new Error(`Hermes Dev bridge tool failed: ${text.slice(0, 1_000)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Hermes Dev bridge returned non-JSON output: ${text.slice(0, 500)}`);
  }
}

async function main() {
  const key = required('ARGUS_HERMES_DEV_MCP_KEY');
  const url = new URL(process.env.ARGUS_HERMES_DEV_MCP_URL?.trim()
    || 'http://127.0.0.1:3000/mcp/hermes-dev');
  const client = new Client(
    { name: 'argus-hermes-dev-bridge-certifier', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });

  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const names = catalog.tools.map(tool => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      throw new Error(`Unexpected personal-Hermes tool catalog: ${names.join(', ') || '(empty)'}`);
    }

    const capabilities = toolJson(await client.callTool({
      name: 'argus_dev_capabilities',
      arguments: {},
    }));
    if (capabilities.packId !== 'argus.dev'
      || capabilities.agentId !== 'coding-orchestrator'
      || capabilities.workflow?.id !== 'ticket-to-pull-request') {
      throw new Error('Bridge capabilities are not bound to the certified Argus Dev workflow');
    }
    if (capabilities.workerRecursion !== 'blocked-by-separate-mcp-catalog') {
      throw new Error('Bridge did not advertise the worker-recursion boundary');
    }

    const preflight = toolJson(await client.callTool({
      name: 'argus_dev_preflight',
      arguments: {},
    }));
    if (preflight.workflowId !== 'ticket-to-pull-request'
      || preflight.state !== 'TASK_STATE_COMPLETED'
      || !preflight.rootTraceId) {
      throw new Error(`Argus Dev preflight did not complete: ${JSON.stringify(preflight).slice(0, 1_000)}`);
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      endpoint: url.toString(),
      tools: names,
      projectedBundleIds: capabilities.projectedBundleIds,
      workflowId: preflight.workflowId,
      state: preflight.state,
      rootTraceId: preflight.rootTraceId,
      writingWorkflowStarted: false,
    }, null, 2)}\n`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
