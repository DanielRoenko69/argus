import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const REQUIRED_TOOLS = [
  'aiops_prometheus_query',
  'aiops_prometheus_query_range',
  'aiops_prometheus_alerts',
  'aiops_prometheus_targets',
  'aiops_prometheus_label_values',
  'aiops_loki_query_range',
  'aiops_loki_label_values',
  'aiops_jaeger_services',
  'aiops_jaeger_find_traces',
  'aiops_jaeger_get_trace',
  'aiops_kubernetes_k8s_get_events',
  'aiops_kubernetes_k8s_get_pod_logs',
  'aiops_kubernetes_k8s_get_resources',
] as const;

const FORBIDDEN_KUBERNETES_TOOLS = [
  'aiops_kubernetes_k8s_describe_resource',
  'aiops_kubernetes_k8s_get_available_api_resources',
  'aiops_kubernetes_k8s_get_cluster_configuration',
  'aiops_kubernetes_k8s_get_resource_yaml',
  'aiops_kubernetes_k8s_generate_resource',
] as const;

function firstApiKey(): string {
  const key = (process.env['MCP_API_KEYS'] ?? '').split(',')[0]?.trim() ?? '';
  if (!key) throw new Error('MCP_API_KEYS must contain a key for AIOps demo verification');
  return key;
}

function toolText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (Array.isArray(result.content) ? result.content : [])
    .flatMap((part: unknown) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
      const value = part as Record<string, unknown>;
      return value['type'] === 'text' && typeof value['text'] === 'string' ? [value['text']] : [];
    })
    .join('\n');
}

async function waitForHealthyCoreTarget(client: Client): Promise<void> {
  let lastOutput = '';
  for (let attempt = 1; attempt <= 15; attempt++) {
    const result = await client.callTool({ name: 'aiops_prometheus_query', arguments: { query: 'up' } });
    lastOutput = toolText(result);
    if (!result.isError && lastOutput.includes('argus-core') && lastOutput.includes('"1"')) return;
    if (attempt < 15) await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  throw new Error(`Prometheus did not return the healthy Argus Core target after the restart grace period: ${lastOutput.slice(0, 300)}`);
}

async function verifyLogs(client: Client): Promise<void> {
  const end = new Date();
  const start = new Date(end.getTime() - 15 * 60_000);
  const result = await client.callTool({
    name: 'aiops_loki_query_range',
    arguments: {
      query: '{service="argus-core", environment="local-demo"}',
      start: start.toISOString(),
      end: end.toISOString(),
      limit: 20,
      direction: 'backward',
    },
  });
  const output = toolText(result);
  if (result.isError || !output.includes('simulated timeout') || !output.includes('trace_id')) {
    throw new Error(`Loki did not return the correlated demonstration logs: ${output.slice(0, 500)}`);
  }
}

async function verifyTraces(client: Client): Promise<void> {
  const services = await client.callTool({ name: 'aiops_jaeger_services', arguments: {} });
  const serviceOutput = toolText(services);
  if (services.isError || !serviceOutput.includes('argus-core')) {
    throw new Error(`Jaeger did not index the demonstration service: ${serviceOutput.slice(0, 500)}`);
  }
  const endMicros = BigInt(Date.now()) * 1_000n;
  const startMicros = endMicros - 15n * 60n * 1_000_000n;
  const traces = await client.callTool({
    name: 'aiops_jaeger_find_traces',
    arguments: { service: 'argus-core', start_micros: String(startMicros), end_micros: String(endMicros), limit: 20 },
  });
  const traceOutput = toolText(traces);
  if (traces.isError || !traceOutput.includes('postgres.query') || !traceOutput.includes('simulated timeout')) {
    throw new Error(`Jaeger did not return the correlated demonstration trace: ${traceOutput.slice(0, 500)}`);
  }
}

async function verifyKubernetes(client: Client): Promise<void> {
  const resources = await client.callTool({
    name: 'aiops_kubernetes_k8s_get_resources',
    arguments: { resource_type: 'pods', namespace: 'argus-demo', output: 'wide' },
  });
  const output = toolText(resources);
  if (resources.isError || !output.includes('checkout-api') || !output.includes('catalog-api')) {
    throw new Error(`Kubernetes MCP did not return the governed demo topology: ${output.slice(0, 500)}`);
  }
}

async function main(): Promise<void> {
  const url = new URL(process.env['ARGUS_AIOPS_MCP_URL']
    ?? 'http://127.0.0.1:3000/mcp/group/argus-aiops-observe');
  const client = new Client(
    { name: 'argus-aiops-demo-verifier', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${firstApiKey()}` } },
  });

  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const names = catalog.tools.map(tool => tool.name).sort();
    const missing = REQUIRED_TOOLS.filter(name => !names.includes(name));
    if (missing.length > 0) throw new Error(`AIOps MCP tools missing: ${missing.join(', ')}`);
    const escaped = FORBIDDEN_KUBERNETES_TOOLS.filter(name => names.includes(name));
    if (escaped.length > 0) {
      throw new Error(`Broad Kubernetes tools escaped the selected read-only Bundle policy: ${escaped.join(', ')}`);
    }

    // Core is restarted after the SQL seed so its dynamic backend registry is
    // current. Prometheus can legitimately retain one failed scrape during
    // that short restart; verify eventual health within a bounded window.
    await waitForHealthyCoreTarget(client);
    await verifyLogs(client);
    await verifyTraces(client);
    await verifyKubernetes(client);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      bundle: 'argus-aiops-observe',
      requiredTools: REQUIRED_TOOLS,
      prometheusTarget: 'argus-core',
      up: 1,
      logs: 'loki',
      traces: 'jaeger',
      kubernetes: 'kagent-tools/read-only',
    }, null, 2)}\n`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

main().catch(cause => {
  process.stderr.write(`[aiops-demo] verification failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
