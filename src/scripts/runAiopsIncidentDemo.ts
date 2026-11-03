import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { a2aTaskSchema, type A2aTask } from '../a2a/client.js';
import {
  incidentAiopsSnapshotFromTask,
  PostgresIncidentAiopsTaskStore,
} from '../observability/incidentAiopsTasks.js';
import { getIncidentImpact, incidentImpactLabels } from '../observability/incidentImpact.js';
import { PostgresIncidentRemediationStore } from '../observability/incidentRemediations.js';
import { upsertServiceDependencyEvidence } from '../observability/serviceDependencies.js';
import { ExecutionGrantIssuer } from '../solutionPacks/executionGrant.js';
import { aiopsDemoRemediationFromEnvironment, withBoundDemoRemediation } from './aiopsDemoRemediation.js';

type JsonObject = Record<string, unknown>;

const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

function record(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status} returned invalid JSON: ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} from AIOps Pack: ${text.slice(0, 500)}`);
  return body;
}

async function main(): Promise<void> {
  const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
  const secret = process.env['ARGUS_EXECUTION_GRANT_SECRET'] ?? '';
  const packUrl = (process.env['ARGUS_AIOPS_URL'] ?? 'http://argus-aiops:2030').replace(/\/+$/, '');
  const publicBaseUrl = (process.env['ARGUS_PUBLIC_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
  const remediation = aiopsDemoRemediationFromEnvironment();
  const deploymentRegression = remediation.adapter === 'deployment-revision';
  const demoRunId = process.env['ARGUS_AIOPS_DEMO_RUN_ID']?.trim() ?? '';
  if (deploymentRegression && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(demoRunId)) {
    throw new Error('ARGUS_AIOPS_DEMO_RUN_ID must be a version-4 UUID for a deployment regression demo');
  }
  const service = deploymentRegression ? 'checkout-api' : 'argus-core';
  const fallbackEnvironment = 'local-demo';
  const fallbackNamespace = 'argus-demo';
  const title = deploymentRegression
    ? 'ARGUS-AIOPS-DEMO · checkout-api rollout regression'
    : 'ARGUS-AIOPS-DEMO · PostgreSQL latency incident';
  if (!connectionString || !secret) throw new Error('Postgres and execution grant configuration are required');

  const pool = new pg.Pool({ connectionString, max: 2 });
  const store = new PostgresIncidentAiopsTaskStore(pool);
  const remediations = new PostgresIncidentRemediationStore(pool);
  let rootTraceId: string | null = null;
  let task: A2aTask | null = null;
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
    const environment = typeof targetBackend?.config?.['environment'] === 'string'
      ? targetBackend.config['environment']
      : fallbackEnvironment;
    const namespaces = Array.isArray(targetBackend?.config?.['execution_namespaces'])
      ? targetBackend.config['execution_namespaces'].filter((value): value is string => typeof value === 'string')
      : [];
    const namespace = namespaces.includes(fallbackNamespace) ? fallbackNamespace : namespaces[0] ?? '';
    if (!targetBackend || !targetId || !environment || !namespace) {
      throw new Error('The AIOps Fabric connection has no complete environment and execution namespace scope');
    }

    const userResult = await pool.query<{ id: number }>(
      "SELECT id FROM mcp_users WHERE role='platform_admin' ORDER BY id LIMIT 1",
    );
    const userId = userResult.rows[0]?.id ?? null;
    const ruleResult = await pool.query<{ id: number }>(
      `SELECT id FROM mcp_observability_alert_rules WHERE archived_at IS NULL AND name=$1 ORDER BY id DESC LIMIT 1`,
      [title],
    );
    let ruleId = ruleResult.rows[0]?.id;
    if (!ruleId) {
      const insertedRule = await pool.query<{ id: number }>(
        `INSERT INTO mcp_observability_alert_rules
          (name, description, metric, operator, threshold, window_minutes, min_samples,
           severity, scope_kind, cooldown_minutes, notify, enabled, created_by,
           aiops_auto_investigate, aiops_bundle_ids, aiops_resource_scope, aiops_service, aiops_environment,
           last_state, last_value, last_sample_count, last_evaluated_at, last_triggered_at)
         VALUES ($1,$2,'p95_latency_ms','gt',750,30,10,'critical','all',60,false,false,$3,
                 false,$4,$5::jsonb,$6,$7,'firing',1850,60,now(),now())
         RETURNING id`,
        [
          title,
          deploymentRegression
            ? 'Controlled local demo: correlate an unready checkout-api rollout with Kubernetes resources, Events, telemetry, topology and runbook evidence.'
            : 'Controlled local demo: correlate a latency alert with telemetry, topology, Kubernetes and runbook evidence.',
          userId,
          [bundleId],
          JSON.stringify({ kind: 'kubernetes', backendId: targetBackend.id, targetId, namespace }),
          service,
          environment,
        ],
      );
      ruleId = insertedRule.rows[0]!.id;
    } else {
      await pool.query(
        `UPDATE mcp_observability_alert_rules
            SET aiops_bundle_ids=$2, aiops_resource_scope=$3::jsonb,
                aiops_service=$4, aiops_environment=$5,
                last_state='firing', last_value=1850, last_sample_count=60,
                last_evaluated_at=now(), last_triggered_at=now(), updated_at=now()
          WHERE id=$1`,
        [ruleId, [bundleId], JSON.stringify({ kind: 'kubernetes', backendId: targetBackend.id, targetId, namespace }), service, environment],
      );
    }

    let incidentResult = await pool.query<{ id: number; triggered_at: Date | string }>(
      `SELECT incident.id, incident.triggered_at
         FROM mcp_observability_alert_incidents incident
        WHERE incident.rule_id=$1
          AND incident.context->>'demo'='true'
          AND incident.triggered_at >= now() - interval '1 hour'
          AND NOT EXISTS (
            SELECT 1 FROM mcp_observability_incident_aiops_tasks task WHERE task.incident_id=incident.id
          )
        ORDER BY incident.triggered_at DESC
        LIMIT 1`,
      [ruleId],
    );
    if (!incidentResult.rows[0]) {
      incidentResult = await pool.query<{ id: number; triggered_at: Date | string }>(
        `INSERT INTO mcp_observability_alert_incidents
          (rule_id, state, severity, metric_value, threshold, sample_count, message, context)
         VALUES ($1,'firing','critical',1850,750,60,$2,$3::jsonb)
         RETURNING id, triggered_at`,
        [
          ruleId,
          deploymentRegression
            ? 'checkout-api has an unready rollout after a controlled pod-template change. Correlate the change and runtime symptoms before recommending remediation.'
            : 'P95 latency is 1850 ms, above the 750 ms demo threshold. Correlate before recommending remediation.',
          JSON.stringify({
            demo: true,
            source: 'argus-controlled-aiops-demo',
            signal: deploymentRegression ? 'deployment_availability' : 'p95_latency_ms',
            currentValue: 1850,
            baselineValue: 220,
            correlationWindowMinutes: 30,
            workload: deploymentRegression ? 'Deployment/checkout-api' : undefined,
            expectedHealthyRevision: deploymentRegression ? remediation.targetRevision : undefined,
            demoRunId: deploymentRegression ? demoRunId : undefined,
          }),
        ],
      );
    }
    const incidentId = incidentResult.rows[0]!.id;
    const observedAt = new Date(incidentResult.rows[0]!.triggered_at).toISOString();
    await upsertServiceDependencyEvidence(pool, deploymentRegression ? [
      { identitySeed: `${incidentId}:catalog:1`, environment, sourceService: service, targetKind: 'service', targetName: 'catalog-api', relation: 'calls', bundleId, sourceRef: 'argus-demo-kubernetes', durationMs: 18, failed: false, observedAt },
    ] : [
      { identitySeed: `${incidentId}:postgres:1`, environment, sourceService: service, targetKind: 'database', targetName: 'postgresql', relation: 'queries', bundleId, sourceRef: 'argus-demo-jaeger', durationMs: 1680, failed: true, observedAt },
      { identitySeed: `${incidentId}:postgres:2`, environment, sourceService: service, targetKind: 'database', targetName: 'postgresql', relation: 'queries', bundleId, sourceRef: 'argus-demo-jaeger', durationMs: 1850, failed: true, observedAt },
      { identitySeed: `${incidentId}:postgres:3`, environment, sourceService: service, targetKind: 'database', targetName: 'postgresql', relation: 'queries', bundleId, sourceRef: 'argus-demo-jaeger', durationMs: 2010, failed: true, observedAt },
      { identitySeed: `${incidentId}:postgres:4`, environment, sourceService: service, targetKind: 'database', targetName: 'postgresql', relation: 'queries', bundleId, sourceRef: 'argus-demo-jaeger', durationMs: 1900, failed: true, observedAt },
      { identitySeed: `${incidentId}:redis:1`, environment, sourceService: service, targetKind: 'database', targetName: 'redis', relation: 'queries', bundleId, sourceRef: 'argus-demo-jaeger', durationMs: 12, failed: false, observedAt },
    ]);

    const impact = await getIncidentImpact(pool, incidentId);
    const impactLabels = incidentImpactLabels(impact);
    const issuer = new ExecutionGrantIssuer(pool, secret);
    const capabilityCheck = await issuer.checkBundleCapabilities([bundleId], ['metrics', 'runtime', 'logs', 'traces']);
    if (!capabilityCheck.ok) {
      throw new Error(`AIOps bundle lacks required capabilities: ${capabilityCheck.missing.join(', ')}`);
    }

    rootTraceId = randomUUID();
    const messageId = randomUUID();
    const grant = await issuer.issue({
      packId: 'argus.aiops',
      agentId: 'incident-orchestrator',
      principalKind: 'service',
      principalId: 'native-alert-demo',
      principalAllowedBundleIds: null,
      requestedBundleIds: [bundleId],
      coreAgentNames: ['aiops-researcher', 'aiops-knowledge', 'aiops-reviewer'],
      messageId,
      rootTraceId,
      requestedResourceScope: {
        kind: 'kubernetes',
        backendId: targetBackend.id,
        targetId,
        namespace,
      },
    });
    const traceHex = rootTraceId.replaceAll('-', '');
    const startedBody = record(await json(`${packUrl}/message:send`, {
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
                summary: deploymentRegression
                  ? `Investigate the unready checkout-api Deployment rollout in ${namespace} using only governed read-only evidence. Correlate the pod-template change, ReplicaSets, Pods and Events with telemetry and runbooks. The known pre-incident revision is ${remediation.targetRevision}; verify the regression independently before proposing any action.`
                  : 'Investigate the PostgreSQL-correlated P95 latency regression using only governed read-only evidence. Distinguish correlation from causal proof.',
                severity: 'critical',
                service,
                environment,
                correlation_window_minutes: 30,
                alert_source: `Argus native alert incident ${incidentId}`,
                labels: impactLabels,
              },
            },
          }],
        },
      }),
    }));
    const started = a2aTaskSchema.parse(startedBody?.['task']);
    task = started;
    let link = await store.create({
      incidentId,
      packId: 'argus.aiops',
      agentId: 'incident-orchestrator',
      taskId: task.id,
      createdBy: userId,
      snapshot: incidentAiopsSnapshotFromTask(task, rootTraceId),
      executionContext: {
        bundleIds: [bundleId],
        resourceScope: { kind: 'kubernetes', backendId: targetBackend.id, targetId, namespace },
        service,
        environment,
      },
    });
    process.stderr.write(`[aiops-demo] incident=${incidentId} task=${task.id} state=${task.status.state}\n`);

    const deadline = Date.now() + 20 * 60_000;
    let previousState = task.status.state;
    while (!TERMINAL_STATES.has(task.status.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      task = a2aTaskSchema.parse(await json(`${packUrl}/tasks/${encodeURIComponent(task.id)}`));
      link = await store.update(link.id, incidentAiopsSnapshotFromTask(task, rootTraceId));
      if (task.status.state !== previousState) {
        previousState = task.status.state;
        process.stderr.write(`[aiops-demo] state=${task.status.state}\n`);
      }
    }
    if (!TERMINAL_STATES.has(task.status.state)) throw new Error('AIOps demo exceeded the 20 minute deadline');

    const finalStatus = task.status.state === 'TASK_STATE_COMPLETED'
      ? 'completed'
      : task.status.state === 'TASK_STATE_CANCELED' ? 'cancelled' : 'failed';
    await issuer.finalizeRootTrace(rootTraceId, finalStatus, { incidentId, taskId: task.id, state: task.status.state });
    const finalRecord = await store.update(link.id, incidentAiopsSnapshotFromTask(task, rootTraceId));
    if (deploymentRegression) {
      const kubernetesEvidence = await pool.query<{ tool_name: string }>(
        `SELECT DISTINCT span.tool_name
           FROM mcp_observability_spans span
           JOIN mcp_observability_traces trace ON trace.id=span.trace_id
          WHERE trace.root_trace_id=$1::uuid
            AND span.kind='tool'
            AND span.status='completed'
            AND span.tool_name LIKE 'aiops_kubernetes_%'
          ORDER BY span.tool_name`,
        [rootTraceId],
      );
      if (kubernetesEvidence.rows.length === 0) {
        throw new Error('Deployment regression investigation completed without persisted Kubernetes tool evidence');
      }
    }
    const remediationRecord = withBoundDemoRemediation(finalRecord, remediation);
    const remediationProposalsCreated = await remediations.syncFromInvestigation(remediationRecord);
    const result = finalRecord.result;
    process.stdout.write(`${JSON.stringify({
      ok: task.status.state === 'TASK_STATE_COMPLETED' && Boolean(result),
      incidentId,
      taskId: task.id,
      rootTraceId,
      state: task.status.state,
      quality: finalRecord.quality,
      conclusion: result?.conclusion ?? null,
      executiveAssessment: result?.executiveAssessment ?? finalRecord.summary,
      rootCause: result?.rootCause ?? null,
      evidenceLanes: result?.evidence.map(item => item.lane) ?? [],
      recommendedActions: remediationRecord.result?.recommendedActions ?? [],
      remediationProposalsCreated,
      links: {
        incident: `${publicBaseUrl}/observe/alerts?incident=${incidentId}`,
        trace: `${publicBaseUrl}/runs/workflow/${rootTraceId}`,
        logs: `${publicBaseUrl}/observe/logs?root_trace=${rootTraceId}`,
      },
    }, null, 2)}\n`);
    if (task.status.state !== 'TASK_STATE_COMPLETED') throw new Error(`AIOps workflow ended in ${task.status.state}`);
    if (!result) throw new Error('AIOps workflow completed without structured reviewer diagnosis');
  } catch (cause) {
    if (rootTraceId) {
      const issuer = new ExecutionGrantIssuer(pool, secret);
      await issuer.finalizeRootTrace(rootTraceId, 'failed', {
        taskId: task?.id ?? null,
        state: task?.status.state ?? 'UNKNOWN',
        error: cause instanceof Error ? cause.message : String(cause),
      }).catch(() => undefined);
    }
    throw cause;
  } finally {
    await pool.end();
  }
}

main().catch(cause => {
  process.stderr.write(`[aiops-demo] failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
