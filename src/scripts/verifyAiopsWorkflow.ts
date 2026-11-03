import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { ExecutionGrantIssuer } from '../solutionPacks/executionGrant.js';

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

async function json(url: string, init?: RequestInit): Promise<JsonObject> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  const body = record(JSON.parse(text));
  if (!response.ok || !body) throw new Error(`HTTP ${response.status} from AIOps Pack: ${text.slice(0, 500)}`);
  return body;
}

function evidenceFrom(task: JsonObject): JsonObject | null {
  const artifacts = Array.isArray(task['artifacts']) ? task['artifacts'] : [];
  for (const artifactValue of artifacts) {
    const artifact = record(artifactValue);
    const parts = Array.isArray(artifact?.['parts']) ? artifact['parts'] : [];
    for (const partValue of parts) {
      const data = record(record(partValue)?.['data']);
      if (data?.['kind'] === 'aiops-investigation-evidence') return data;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
  const secret = process.env['ARGUS_EXECUTION_GRANT_SECRET'] ?? '';
  const packUrl = (process.env['ARGUS_AIOPS_URL'] ?? 'http://argus-aiops:2030').replace(/\/+$/, '');
  const title = process.env['ARGUS_AIOPS_TEST_TITLE'] ?? 'ARGUS-AIOPS-E2E-002';
  const summary = process.env['ARGUS_AIOPS_TEST_SUMMARY']
    ?? 'Validate governed correlation across Prometheus metrics, Loki logs and Jaeger traces for the same local incident window.';
  const service = process.env['ARGUS_AIOPS_TEST_SERVICE'] ?? 'argus-core';
  const environment = process.env['ARGUS_AIOPS_TEST_ENVIRONMENT'] ?? 'argus-demo';
  const alertSource = process.env['ARGUS_AIOPS_TEST_ALERT_SOURCE'] ?? 'Argus multi-signal demo';
  const requiredToolPrefixes = (process.env['ARGUS_AIOPS_REQUIRE_TOOL_PREFIXES'] ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (!connectionString || !secret) throw new Error('Postgres and execution grant configuration are required');

  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    const bundleResult = await pool.query<{ id: number }>(
      "SELECT id FROM mcp_service_bundles WHERE name='argus-aiops-observe'",
    );
    const bundleId = bundleResult.rows[0]?.id;
    if (!bundleId) throw new Error('Argus.AIOps Observe bundle is not installed');
    const targetResult = await pool.query<{ id: number; config: Record<string, unknown> | null }>(
      "SELECT id, config FROM mcp_backends WHERE name='aiops-kubernetes' AND enabled=true",
    );
    const targetBackend = targetResult.rows[0];
    const targetId = typeof targetBackend?.config?.['target_id'] === 'string'
      ? targetBackend.config['target_id']
      : '';
    const namespaces = Array.isArray(targetBackend?.config?.['execution_namespaces'])
      ? targetBackend.config['execution_namespaces']
      : [];
    if (!targetBackend || !targetId || !namespaces.includes(environment)) {
      throw new Error(`Kubernetes target ${environment} is not configured on the AIOps Fabric connection`);
    }

    const issuer = new ExecutionGrantIssuer(pool, secret);
    const capabilityCheck = await issuer.checkBundleCapabilities([bundleId], ['metrics', 'runtime', 'logs', 'traces']);
    if (!capabilityCheck.ok) {
      throw new Error(`AIOps bundle lacks required capabilities: ${capabilityCheck.missing.join(', ')}`);
    }

    const rootTraceId = randomUUID();
    const messageId = randomUUID();
    const grant = await issuer.issue({
      packId: 'argus.aiops',
      agentId: 'incident-orchestrator',
      principalKind: 'service',
      principalId: 'local-aiops-e2e',
      principalAllowedBundleIds: null,
      requestedBundleIds: [bundleId],
      coreAgentNames: ['aiops-researcher', 'aiops-knowledge', 'aiops-reviewer'],
      messageId,
      rootTraceId,
      requestedResourceScope: {
        kind: 'kubernetes',
        backendId: targetBackend.id,
        targetId,
        namespace: environment,
      },
    });
    const traceHex = rootTraceId.replaceAll('-', '');
    const started = await json(`${packUrl}/message:send`, {
      method: 'POST',
      headers: {
        accept: 'application/a2a+json',
        'content-type': 'application/a2a+json',
        'a2a-version': '1.0',
        'x-argus-execution-grant': grant,
        'x-argus-root-trace-id': rootTraceId,
        traceparent: `00-${traceHex}-${randomBytes(8).toString('hex')}-01`,
      },
      body: JSON.stringify({
        message: {
          messageId,
          role: 'ROLE_USER',
          parts: [{
            data: {
              operation: 'workflow.start',
              workflowId: 'incident-investigation',
              input: {
                title,
                summary,
                severity: 'warning',
                service,
                environment,
                correlation_window_minutes: 30,
                alert_source: alertSource,
              },
            },
          }],
        },
      }),
    });
    let task = record(started['task']);
    const taskId = typeof task?.['id'] === 'string' ? task['id'] : '';
    if (!taskId) throw new Error('AIOps Pack did not return a task id');

    const terminal = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
    const deadline = Date.now() + 20 * 60_000;
    while (!terminal.has(String(record(task?.['status'])?.['state'] ?? '')) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      task = record(await json(`${packUrl}/tasks/${encodeURIComponent(taskId)}`));
    }
    const state = String(record(task?.['status'])?.['state'] ?? 'UNKNOWN');
    const evidence = task ? evidenceFrom(task) : null;
    const agents = Array.isArray(evidence?.['agentEvidence'])
      ? evidence.agentEvidence.map(record).filter((item): item is JsonObject => item !== null)
      : [];
    const calls = agents.flatMap(agent => Array.isArray(agent['toolCalls'])
      ? agent.toolCalls.map(record).filter((item): item is JsonObject => item !== null)
      : []);
    const toolNames = calls.flatMap(call => typeof call['name'] === 'string' ? [call['name']] : []);
    const researcher = agents.find(agent => agent['role'] === 'researcher');
    const researcherNames = Array.isArray(researcher?.['toolCalls'])
      ? researcher.toolCalls.map(record).flatMap(call => typeof call?.['name'] === 'string' ? [call.name] : [])
      : [];
    const hasProviderEvidence = researcherNames.some(name => !/^(?:workspace_|rag_|__)/.test(name));
    const hasWorkspaceCall = toolNames.some(name => name.startsWith('workspace_'));
    const missingToolPrefixes = requiredToolPrefixes.filter(prefix =>
      !researcherNames.some(name => name.startsWith(prefix)));
    const requiresKubernetesEvidence = requiredToolPrefixes.some(prefix =>
      'aiops_kubernetes_'.startsWith(prefix) || prefix.startsWith('aiops_kubernetes_'));
    const kubernetesEvidence = record(evidence?.['kubernetesEvidence']);
    const kubernetesResources = Array.isArray(kubernetesEvidence?.['resources'])
      ? kubernetesEvidence.resources : [];
    const kubernetesEdges = Array.isArray(kubernetesEvidence?.['edges'])
      ? kubernetesEvidence.edges : [];
    const kubernetesEvents = Array.isArray(kubernetesEvidence?.['events'])
      ? kubernetesEvidence.events : [];
    const kubernetesProvenance = [...kubernetesResources, ...kubernetesEvents].map(item =>
      record(record(item)?.['provenance']));
    const provenanceSpanIds = [...new Set(kubernetesProvenance.flatMap(source =>
      typeof source?.['spanId'] === 'string' ? [source.spanId] : []))];
    const persistedProvenanceSpanIds = provenanceSpanIds.length > 0
      ? (await pool.query<{ id: string }>(
          `SELECT span.id::text
             FROM mcp_observability_spans span
             JOIN mcp_observability_traces trace ON trace.id=span.trace_id
            WHERE trace.root_trace_id=$1::uuid
              AND span.id=ANY($2::uuid[])`,
          [rootTraceId, provenanceSpanIds],
        )).rows.map(row => row.id)
      : [];
    const hasKubernetesProvenance = !requiresKubernetesEvidence
      || (kubernetesProvenance.length === kubernetesResources.length + kubernetesEvents.length
        && kubernetesProvenance.every(source =>
          typeof source?.['toolName'] === 'string'
          && typeof source['spanId'] === 'string')
        && persistedProvenanceSpanIds.length === provenanceSpanIds.length);
    const hasNormalizedKubernetesEvidence = !requiresKubernetesEvidence
      || (typeof kubernetesEvidence?.['namespace'] === 'string'
        && kubernetesResources.length > 0
        && kubernetesEdges.length > 0
        && kubernetesEvents.length > 0);
    const coverage = Array.isArray(evidence?.['signalCoverage'])
      ? evidence.signalCoverage.map(record).filter((item): item is JsonObject => item !== null)
      : [];
    const missingMultiSignal = ['metrics', 'logs', 'traces', 'knowledge'].filter(lane =>
      !coverage.some(item => item['lane'] === lane && item['status'] === 'collected'));

    if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(state)) {
      await issuer.finalizeRootTrace(
        rootTraceId,
        state === 'TASK_STATE_COMPLETED' ? 'completed' : state === 'TASK_STATE_CANCELED' ? 'cancelled' : 'failed',
        { taskId, state },
      );
    }

    process.stdout.write(`${JSON.stringify({
      ok: state === 'TASK_STATE_COMPLETED'
        && hasProviderEvidence
        && !hasWorkspaceCall
        && missingMultiSignal.length === 0
        && missingToolPrefixes.length === 0
        && hasNormalizedKubernetesEvidence
        && hasKubernetesProvenance,
      incident: { title, service, environment, alertSource },
      taskId,
      rootTraceId,
      state,
      quality: evidence?.['quality'] ?? null,
      researcherTools: researcherNames,
      allAgentTools: toolNames,
      signalCoverage: coverage,
      requiredToolPrefixes,
      missingToolPrefixes,
      kubernetesEvidence: requiresKubernetesEvidence ? {
        normalized: hasNormalizedKubernetesEvidence,
        namespace: kubernetesEvidence?.['namespace'] ?? null,
        resources: kubernetesResources.length,
        edges: kubernetesEdges.length,
        events: kubernetesEvents.length,
        provenanceSpans: provenanceSpanIds.length,
        persistedProvenanceSpans: persistedProvenanceSpanIds.length,
      } : null,
      timelineEvents: Array.isArray(evidence?.['timeline']) ? evidence.timeline.length : 0,
      synthesis: typeof evidence?.['synthesis'] === 'string' ? evidence.synthesis.slice(0, 1_000) : null,
    }, null, 2)}\n`);

    if (state !== 'TASK_STATE_COMPLETED') throw new Error(`AIOps workflow ended in ${state}`);
    if (!hasProviderEvidence) throw new Error('researcher completed without scoped provider evidence');
    if (hasWorkspaceCall) throw new Error('observe-only AIOps workflow invoked a workspace tool');
    if (missingMultiSignal.length > 0) throw new Error(`multi-signal evidence missing: ${missingMultiSignal.join(', ')}`);
    if (missingToolPrefixes.length > 0) {
      throw new Error(`required provider tools were not invoked: ${missingToolPrefixes.join(', ')}`);
    }
    if (!hasNormalizedKubernetesEvidence) {
      throw new Error('Kubernetes tools ran without normalized resource, edge and Event evidence');
    }
    if (!hasKubernetesProvenance) {
      throw new Error('Kubernetes evidence is not linked to persisted Core tool spans');
    }
  } finally {
    await pool.end();
  }
}

main().catch(cause => {
  process.stderr.write(`[aiops-workflow] verification failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
