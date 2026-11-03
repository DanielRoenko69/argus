import { jest } from '@jest/globals';
import type pg from 'pg';
import type { Config } from '../../config/env.js';
import type { IncidentRemediationRecord, IncidentRemediationStore } from '../incidentRemediations.js';
import { noOpIncidentRemediationAudit } from '../incidentRemediationAudit.js';
import { PostgresIncidentRemediationExecutor } from '../incidentRemediationExecutor.js';
import {
  incidentRemediationChangePlanFromRow,
  incidentRemediationPostChangeMonitorFromRow,
  type IncidentRemediationChangePlanRow,
  type IncidentRemediationPostChangeMonitorRow,
} from '../incidentRemediationPlans.js';

const createdAt = '2026-08-13T10:00:00.000Z';
const rootTraceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const freshCertification = {
  id: 1, backend_id: 42, target_id: 'demo-kind', platform: 'kubernetes', profile: 'in-cluster-read-only',
  status: 'passed', contract_sha256: 'a'.repeat(64), report_sha256: 'b'.repeat(64), checks: [],
  check_count: 4, passed_count: 4, failed_count: 0, generated_at: new Date().toISOString(),
  imported_at: new Date().toISOString(), imported_by: 'test',
};

const context = {
  status: 'approved',
  version: 2,
  root_trace_id: rootTraceId,
  target_scope: { namespace: 'argus-demo', targetId: 'demo-kind' },
  aiops_bundle_ids: [28],
  aiops_service: 'checkout-api',
  aiops_environment: 'demo',
  triggered_at: createdAt,
};

const getTraceTool = {
  name: 'argus_observe_get_trace',
  description: 'Inspect a native trace.',
  backend: 'argus-observability',
  category: 'Observability',
  tool_type: 'builtin',
  query_template: null,
  parameters: [{ name: 'trace_id', type: 'string', description: 'Trace ID', required: true }],
  is_write: false,
};

const alertsTool = {
  name: 'aiops_prometheus_alerts',
  description: 'Read active Prometheus alerts.',
  backend: 'custom:aiops-prometheus',
  category: 'Metrics',
  tool_type: 'dynamic',
  query_template: 'GET /api/v1/alerts',
  parameters: [],
  is_write: false,
};

function remediation(dryRuns: IncidentRemediationRecord['dryRuns'] = []): IncidentRemediationRecord {
  return {
    id: 91, incidentId: 81, taskLinkId: 15, taskId: 'task-81', rootTraceId,
    sourceActionIndex: 0, priority: 'now', action: 'Inspect saturation.', rationale: 'Correlated evidence.',
    requiresApproval: true, riskLevel: 'high', executionMode: dryRuns.length ? 'dry_run' : 'proposal_only',
    executorBundleId: dryRuns.length ? 28 : null, executorToolName: dryRuns.length ? 'aiops_prometheus_alerts' : null,
    targetScope: { namespace: 'argus-demo' }, executionIntent: null, status: 'approved', version: dryRuns.length ? 3 : 2,
    createdBy: 1, decidedBy: 1, decidedByUsername: 'Alex', decisionComment: null,
    decidedAt: createdAt, createdAt, updatedAt: createdAt, events: [], dryRuns, changePlans: [],
  };
}

function poolForCandidates(tools = [getTraceTool, alertsTool]) {
  const query = jest.fn(async (text: string) => {
    if (text.includes('FROM mcp_observability_incident_remediations remediation')) return { rows: [context] };
    if (text.includes('WITH dynamic_candidates')) return { rows: tools.map(tool => ({ name: tool.name })) };
    if (text.startsWith('SELECT name, label FROM mcp_service_bundles')) {
      return { rows: [{ name: 'argus-aiops-observe', label: 'Argus.AIOps Observe' }] };
    }
    if (text.includes('FROM mcp_tools')) return { rows: tools };
    throw new Error(`unexpected query: ${text}`);
  });
  return { query } as unknown as pg.Pool;
}

describe('incident remediation read-only executor', () => {
  it('lists only Core-verifiable read tools and locks trusted incident arguments', async () => {
    const unsafePost = { ...alertsTool, name: 'unsafe_post', query_template: 'POST /api/restart' };
    const writeGet = { ...alertsTool, name: 'write_get', is_write: true };
    const pool = poolForCandidates([getTraceTool, alertsTool, unsafePost, writeGet]);
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const executor = new PostgresIncidentRemediationExecutor(pool, {} as Config, store);

    const candidates = await executor.listCandidates(81, 91);

    expect(candidates.map(candidate => candidate.toolName)).toEqual([
      'argus_observe_get_trace',
      'aiops_prometheus_alerts',
    ]);
    expect(candidates[0]).toMatchObject({
      executorKind: 'native_read',
      suggestedArguments: { trace_id: rootTraceId },
      missingRequiredArguments: [],
      parameters: [{ name: 'trace_id', valueSource: 'incident', locked: true }],
    });
    const calls = (pool.query as unknown as { mock: { calls: Array<[string]> } }).mock.calls;
    const contextSql = calls.map(call => String(call[0])).find(text => text.includes('incident_remediations remediation')) ?? '';
    expect(contextSql).toContain('task.execution_bundle_ids AS aiops_bundle_ids');
    expect(contextSql).toContain('task.execution_service AS aiops_service');
    expect(contextSql).not.toContain('mcp_observability_alert_rules');
  });

  it('persists a selected bundle/tool and returns redacted read-only evidence', async () => {
    const executionTraceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const attempt = {
      id: 6, remediation_id: 91, bundle_id: 28, tool_name: 'aiops_prometheus_alerts', arguments: {},
      status: 'passed', execution_trace_id: executionTraceId, result_preview: 'alerts loaded', error_message: null,
      redaction_summary: {}, started_by: 1, started_by_username: 'Alex', started_at: createdAt, completed_at: createdAt,
    };
    const candidatePool = poolForCandidates([alertsTool]);
    const clientQuery = jest.fn(async (text: string) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('SELECT status, version')) return { rows: [{ status: 'approved', version: 2 }] };
      if (text.includes('FOR SHARE OF tool')) return { rows: [{ ...alertsTool, bundle_allowed: true }] };
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_dry_runs')) {
        return { rows: [{ ...attempt, status: 'running', result_preview: null, completed_at: null }] };
      }
      if (text.includes('UPDATE mcp_observability_incident_remediation_dry_runs')) return { rows: [attempt] };
      if (text.includes('UPDATE mcp_observability_incident_remediations')) return { rows: [] };
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] };
      throw new Error(`unexpected client query: ${text}`);
    });
    const originalPoolQuery = candidatePool.query.bind(candidatePool);
    const poolQuery = jest.fn(async (text: string, params?: unknown[]) => {
      if (text.includes('UPDATE mcp_observability_incident_remediation_dry_runs')) return { rows: [attempt] } as never;
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] } as never;
      return originalPoolQuery(text, params) as never;
    });
    const pool = {
      query: poolQuery,
      connect: jest.fn(async () => ({ query: clientQuery, release: jest.fn() })),
    } as unknown as pg.Pool;
    const dryRun = {
      id: 6, remediationId: 91, bundleId: 28, toolName: 'aiops_prometheus_alerts', arguments: {},
      status: 'passed' as const, executionTraceId, resultPreview: 'alerts loaded', errorMessage: null,
      redactionSummary: {}, startedBy: 1, startedByUsername: 'Alex', startedAt: createdAt, completedAt: createdAt,
    };
    const store = { listForIncident: jest.fn(async () => [remediation([dryRun])]) } as unknown as IncidentRemediationStore;
    const runTool = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'alerts loaded' }] }));
    const executor = new PostgresIncidentRemediationExecutor(
      pool, {} as Config, store, runTool, noOpIncidentRemediationAudit,
    );

    const result = await executor.runDryRun({
      incidentId: 81, remediationId: 91, expectedVersion: 2, bundleId: 28,
      toolName: 'aiops_prometheus_alerts', arguments: {}, operator: { id: 1, username: 'Alex' },
    });

    expect(runTool).toHaveBeenCalledWith('aiops_prometheus_alerts', {}, expect.objectContaining({ allowedBundles: [28] }));
    expect(clientQuery.mock.calls.some(call => String(call[0]).includes("execution_mode='dry_run'"))).toBe(true);
    expect(result).toMatchObject({ remediation: { version: 3, executionMode: 'dry_run' }, dryRun: { status: 'passed' } });
  });

  it('rejects attempts to override a trusted incident binding before execution', async () => {
    const pool = poolForCandidates([getTraceTool]);
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const runTool = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'not called' }] }));
    const executor = new PostgresIncidentRemediationExecutor(pool, {} as Config, store, runTool);

    await expect(executor.runDryRun({
      incidentId: 81, remediationId: 91, expectedVersion: 2, bundleId: 28,
      toolName: 'argus_observe_get_trace', arguments: { trace_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      operator: { id: 1, username: 'Alex' },
    })).rejects.toMatchObject({ status: 400, code: 'incident_argument_locked' });
    expect(runTool).not.toHaveBeenCalled();
  });
});

describe('incident remediation governed Kubernetes adapter', () => {
  const writeContext = {
    ...context,
    target_scope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo' },
    execution_intent: {
      adapterKey: 'kubernetes.scale.v1', workloadKind: 'Deployment',
      workloadName: 'checkout-api', desiredReplicas: 3,
    },
  };
  const scaleTool = {
    bundle_id: 29,
    bundle_label: 'Argus.AIOps Remediate',
    backend_id: 52,
    backend_name: 'aiops-kubernetes-write',
    backend_config: {
      governed_write: true,
      remediation_target_id: 'demo-kind',
      remediation_source_bundles: ['argus-aiops-observe'],
      execution_namespaces: ['argus-demo'],
    },
    prefixed_name: 'aiops_kubernetes_write_resources_scale',
    tool_name: 'resources_scale',
    description: 'Get or update workload scale.',
    input_schema: {
      type: 'object',
      required: ['apiVersion', 'kind', 'name'],
      properties: {
        apiVersion: { type: 'string' }, kind: { type: 'string' }, name: { type: 'string' },
        namespace: { type: 'string' }, scale: { type: 'integer' },
      },
    },
  };
  const beforeTemplateHash = '1'.repeat(64);
  const targetTemplateHash = '2'.repeat(64);
  const revisionContext = {
    ...writeContext,
    execution_intent: {
      adapterKey: 'kubernetes.deployment-revision-rollback.v1', workloadKind: 'Deployment',
      workloadName: 'checkout-api', targetRevision: 4,
    },
  };
  const revisionTool = {
    ...scaleTool,
    prefixed_name: 'aiops_kubernetes_write_deployment_revision_rollback',
    tool_name: 'deployment_revision_rollback',
    description: 'Inspect or restore one Deployment revision.',
    input_schema: {
      type: 'object',
      required: ['name', 'namespace'],
      properties: {
        name: { type: 'string' }, namespace: { type: 'string' }, targetRevision: { type: 'integer' },
        expectedCurrentTemplateHash: { type: 'string' }, targetTemplateHash: { type: 'string' },
      },
    },
  };

  function writePool(remoteRows: unknown[] = [scaleTool], remediationContext: Record<string, unknown> = writeContext) {
    const query = jest.fn(async (text: string) => {
      if (text.includes('FROM mcp_observability_incident_remediations remediation')) return { rows: [remediationContext] };
      if (text.includes('FROM mcp_observability_incident_remediation_dry_runs')) return { rows: [{ status: 'passed' }] };
      if (text.includes('FROM mcp_kubernetes_connector_certifications')) return { rows: [freshCertification] };
      if (text === 'SELECT config FROM mcp_backends WHERE id=$1 AND enabled=true') {
        return { rows: [{ config: { cluster: 'argus-aiops', environment: 'demo' } }] };
      }
      if (text.startsWith('SELECT name FROM mcp_service_bundles')) {
        return { rows: [{ name: 'argus-aiops-observe' }] };
      }
      if (text.includes('FROM mcp_remote_tools remote')) return { rows: remoteRows };
      throw new Error(`unexpected query: ${text}`);
    });
    return { query } as unknown as pg.Pool;
  }

  const planRow = (overrides: Partial<IncidentRemediationChangePlanRow> = {}): IncidentRemediationChangePlanRow => ({
    id: 71, remediation_id: 91, adapter_key: 'kubernetes.scale.v1', bundle_id: 29,
    write_backend_id: 52, write_tool_name: 'aiops_kubernetes_write_resources_scale',
    status: 'approved', version: 2, plan_hash: 'c'.repeat(64),
    target_scope: { kind: 'kubernetes', backendId: 42, targetId: 'demo-kind', cluster: 'argus-aiops', namespace: 'argus-demo', environment: 'demo', workloadKind: 'Deployment', workloadName: 'checkout-api' },
    preview: { format: 'replica_diff', summary: 'Scale from 1 to 3.', lines: ['- replicas: 1', '+ replicas: 3'], rollbackSummary: 'Restore 1.' },
    write_arguments: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'checkout-api', namespace: 'argus-demo', scale: 3 },
    verify_arguments: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'checkout-api', namespace: 'argus-demo' },
    rollback_arguments: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'checkout-api', namespace: 'argus-demo', scale: 1 },
    adapter_state: { schemaVersion: 1, before: { replicas: 1 }, desired: { replicas: 3 } },
    previous_replicas: 1, desired_replicas: 3, created_by: 1, created_by_username: 'Alex',
    approved_by: 2, approved_by_username: 'Reviewer', approval_comment: null, approved_at: createdAt,
    execution_trace_id: null, execution_result: null, execution_error: null, executed_at: null,
    verification_trace_id: null, verification_result: null, verification_error: null, verified_at: null,
    rollback_trace_id: null, rollback_result: null, rollback_error: null, rolled_back_at: null,
    created_at: createdAt, updated_at: createdAt,
    ...overrides,
  });

  const monitorRow = (overrides: Partial<IncidentRemediationPostChangeMonitorRow> = {}): IncidentRemediationPostChangeMonitorRow => ({
    id: 81, remediation_id: 91, plan_id: 71, status: 'scheduled', version: 1,
    rollback_hash: 'e'.repeat(64), scheduled_for: createdAt,
    observation_trace_id: null, observed_replicas: null, observed_state: null, observation_result: null,
    observation_error: null, observed_at: null, decided_by: null,
    decided_by_username: null, decision_comment: null, decided_at: null,
    rollback_trace_id: null, rollback_result: null, rollback_error: null,
    rolled_back_at: null, created_at: createdAt, updated_at: createdAt,
    ...overrides,
  });

  it('rejects an unregistered adapter before querying a connector or remediation record', async () => {
    const query = jest.fn();
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const runTool = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not run' }] }));
    const executor = new PostgresIncidentRemediationExecutor(
      { query } as unknown as pg.Pool,
      {} as Config,
      store,
      runTool,
    );

    await expect(executor.createChangePlan({
      adapterKey: 'shell.exec.v1',
      incidentId: 81,
      remediationId: 91,
      expectedRemediationVersion: 3,
      bundleId: 29,
      writeToolName: 'unsafe_exec',
      workloadKind: 'Deployment',
      workloadName: 'checkout-api',
      desiredReplicas: 3,
      operator: { id: 1, username: 'Alex' },
    } as unknown as Parameters<typeof executor.createChangePlan>[0])).rejects.toMatchObject({
      status: 400,
      code: 'remediation_adapter_unsupported',
    });
    expect(query).not.toHaveBeenCalled();
    expect(store.listForIncident).not.toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalled();
  });

  it('exposes the adapter only for an explicit governed-write connector with the exact scale schema', async () => {
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const executor = new PostgresIncidentRemediationExecutor(writePool(), {} as Config, store);

    const candidates = await executor.listWriteAdapters(81, 91);

    expect(candidates).toEqual([expect.objectContaining({
      adapterKey: 'kubernetes.scale.v1', status: 'ready', bundleId: 29, writeBackendId: 52,
      writeToolName: 'aiops_kubernetes_write_resources_scale',
      target: expect.objectContaining({ targetId: 'demo-kind', namespace: 'argus-demo' }),
    })]);
  });

  it('discovers the revision adapter only from its exact approved intent and MCP schema', async () => {
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const executor = new PostgresIncidentRemediationExecutor(
      writePool([revisionTool], revisionContext), {} as Config, store,
    );

    await expect(executor.listWriteAdapters(81, 91)).resolves.toEqual([
      expect.objectContaining({
        adapterKey: 'kubernetes.deployment-revision-rollback.v1', status: 'ready',
        writeToolName: 'aiops_kubernetes_write_deployment_revision_rollback',
        workloadKinds: ['Deployment'], replicas: null,
        intent: expect.objectContaining({ targetRevision: 4 }),
      }),
    ]);
  });

  it('verifies a revision plan by its approved template fingerprint rather than replica projections', async () => {
    const approved = planRow({
      adapter_key: 'kubernetes.deployment-revision-rollback.v1',
      write_tool_name: 'aiops_kubernetes_write_deployment_revision_rollback',
      preview: { format: 'deployment_revision_diff', summary: 'Restore revision 4.', lines: [], rollbackSummary: 'Restore revision 7.' },
      write_arguments: {
        name: 'checkout-api', namespace: 'argus-demo', targetRevision: 4,
        expectedCurrentTemplateHash: beforeTemplateHash, targetTemplateHash,
      },
      verify_arguments: { name: 'checkout-api', namespace: 'argus-demo' },
      rollback_arguments: {
        name: 'checkout-api', namespace: 'argus-demo', targetRevision: 7,
        expectedCurrentTemplateHash: targetTemplateHash, targetTemplateHash: beforeTemplateHash,
      },
      adapter_state: {
        schemaVersion: 1,
        before: { revision: 7, templateHash: beforeTemplateHash },
        desired: { targetRevision: 4, templateHash: targetTemplateHash },
      },
      previous_replicas: null,
      desired_replicas: null,
    });
    const executing = { ...approved, status: 'executing' as const, version: 3, execution_trace_id: 'd'.repeat(36) };
    const verified = { ...approved, status: 'verified' as const, version: 4, verified_at: createdAt };
    const base = writePool([revisionTool], revisionContext);
    const originalQuery = base.query.bind(base);
    const query = jest.fn(async (text: string, params?: unknown[]) => {
      if (text.includes('SELECT plan.*') && text.includes('WHERE plan.id=')) return { rows: [approved] } as never;
      if (text.includes("SET status='executing'")) return { rows: [executing] } as never;
      if (text.includes("SET status='verified'")) return { rows: [verified] } as never;
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_post_change_monitors')) {
        return { rows: [monitorRow()] } as never;
      }
      if (text.includes('UPDATE mcp_observability_incident_remediations')) return { rows: [] } as never;
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] } as never;
      return originalQuery(text, params) as never;
    });
    const store = {
      listForIncident: jest.fn(async () => [{
        ...remediation(), status: 'verified' as const, changePlans: [],
      }]),
    } as unknown as IncidentRemediationStore;
    const snapshot = JSON.stringify({
      currentRevision: 8,
      templateHash: targetTemplateHash,
      availableRevisions: [{ revision: 4, templateHash: targetTemplateHash }],
    });
    const runTool = jest.fn(async () => ({ content: [{ type: 'text' as const, text: snapshot }] }));
    const executor = new PostgresIncidentRemediationExecutor(
      { query } as unknown as pg.Pool, {} as Config, store, runTool, noOpIncidentRemediationAudit,
    );

    const result = await executor.executeChangePlan({
      incidentId: 81, remediationId: 91, planId: 71, expectedPlanVersion: 2,
      planHash: 'c'.repeat(64), operator: { id: 1, username: 'Alex' },
    });

    expect(runTool).toHaveBeenNthCalledWith(1, approved.write_tool_name, approved.write_arguments, expect.anything());
    expect(runTool).toHaveBeenNthCalledWith(2, approved.write_tool_name, approved.verify_arguments, expect.anything());
    expect(result.plan.status).toBe('verified');
  });

  it('fails closed when the write backend is not explicitly opted into governed writes', async () => {
    const unsafe = { ...scaleTool, backend_config: { ...scaleTool.backend_config, governed_write: false } };
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const executor = new PostgresIncidentRemediationExecutor(writePool([unsafe]), {} as Config, store);

    await expect(executor.listWriteAdapters(81, 91)).resolves.toEqual([
      expect.objectContaining({ status: 'unavailable', writeToolName: null }),
    ]);
  });

  it('fails closed when the write connector is not linked to the incident evidence bundle', async () => {
    const unrelated = {
      ...scaleTool,
      backend_config: { ...scaleTool.backend_config, remediation_source_bundles: ['another-bundle'] },
    };
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const executor = new PostgresIncidentRemediationExecutor(writePool([unrelated]), {} as Config, store);

    await expect(executor.listWriteAdapters(81, 91)).resolves.toEqual([
      expect.objectContaining({ status: 'unavailable', bundleId: null }),
    ]);
  });

  it('keeps diagnostic recommendations read-only when no explicit write intent exists', async () => {
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const executor = new PostgresIncidentRemediationExecutor(
      writePool([scaleTool], { ...writeContext, execution_intent: null }), {} as Config, store,
    );

    await expect(executor.listWriteAdapters(81, 91)).resolves.toEqual([
      expect.objectContaining({
        adapterKey: 'kubernetes.scale.v1', status: 'unavailable', intent: null,
        reason: expect.stringContaining('no explicit registered Kubernetes write intent'),
      }),
      expect.objectContaining({
        adapterKey: 'kubernetes.deployment-revision-rollback.v1', status: 'unavailable', intent: null,
        reason: expect.stringContaining('no explicit registered Kubernetes write intent'),
      }),
    ]);
  });

  it('rejects a plan that differs from the approved recommendation intent', async () => {
    const store = { listForIncident: jest.fn() } as unknown as IncidentRemediationStore;
    const executor = new PostgresIncidentRemediationExecutor(writePool(), {} as Config, store);

    await expect(executor.createKubernetesScalePlan({
      incidentId: 81, remediationId: 91, expectedRemediationVersion: 3,
      bundleId: 29, writeToolName: 'aiops_kubernetes_write_resources_scale',
      workloadKind: 'Deployment', workloadName: 'unrelated-api', desiredReplicas: 3,
      operator: { id: 1, username: 'Alex' },
    })).rejects.toMatchObject({ status: 409, code: 'remediation_intent_mismatch' });
  });

  it('executes only the approved hash and verifies the desired replica count', async () => {
    const approved = planRow();
    const executing = planRow({ status: 'executing', version: 3, execution_trace_id: 'd'.repeat(36) });
    const verified = planRow({ status: 'verified', version: 4, executed_at: createdAt, verified_at: createdAt });
    const base = writePool();
    const originalQuery = base.query.bind(base);
    const query = jest.fn(async (text: string, params?: unknown[]) => {
      if (text.includes('SELECT plan.*') && text.includes('WHERE plan.id=')) return { rows: [approved] } as never;
      if (text.includes("SET status='executing'")) return { rows: [executing] } as never;
      if (text.includes("SET status='verified'")) return { rows: [verified] } as never;
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_post_change_monitors')) {
        return { rows: [monitorRow()] } as never;
      }
      if (text.includes('UPDATE mcp_observability_incident_remediations')) return { rows: [] } as never;
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] } as never;
      return originalQuery(text, params) as never;
    });
    const pool = { query } as unknown as pg.Pool;
    const finalRemediation = { ...remediation(), status: 'verified' as const, changePlans: [] };
    const store = { listForIncident: jest.fn(async () => [finalRemediation]) } as unknown as IncidentRemediationStore;
    const runTool = jest.fn(async (
      _toolName: string,
      _args: Record<string, unknown>,
      _context: unknown,
    ) => ({ content: [{ type: 'text' as const, text: '{"scale":3}' }] }));
    const executor = new PostgresIncidentRemediationExecutor(
      pool, {} as Config, store, runTool, noOpIncidentRemediationAudit,
    );

    const result = await executor.executeChangePlan({
      incidentId: 81, remediationId: 91, planId: 71, expectedPlanVersion: 2,
      planHash: 'c'.repeat(64), operator: { id: 1, username: 'Alex' },
    });

    expect(runTool).toHaveBeenNthCalledWith(1, approved.write_tool_name, approved.write_arguments, expect.objectContaining({ allowedBundles: [29] }));
    expect(runTool).toHaveBeenNthCalledWith(2, approved.write_tool_name, approved.verify_arguments, expect.anything());
    expect(query.mock.calls.some(call => String(call[0]).includes('post_change_monitor_scheduled'))).toBe(true);
    expect(result.plan.status).toBe('verified');
    expect(result.remediation.status).toBe('verified');
  });

  it('rolls back the execution claim before provider mutation when canonical audit append fails', async () => {
    const approved = planRow();
    const executing = planRow({ status: 'executing', version: 3, execution_trace_id: 'd'.repeat(36) });
    const base = writePool();
    const originalQuery = base.query.bind(base);
    const query = jest.fn(async (text: string, params?: unknown[]) => {
      if (text.includes('SELECT plan.*') && text.includes('WHERE plan.id=')) return { rows: [approved] } as never;
      if (text.includes("SET status='executing'")) return { rows: [executing] } as never;
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] } as never;
      return originalQuery(text, params) as never;
    });
    const clientQuery = jest.fn(async (text: string, params?: unknown[]) => {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [] } as never;
      return query(text, params);
    });
    const pool = {
      query,
      connect: jest.fn(async () => ({ query: clientQuery, release: jest.fn() })),
    } as unknown as pg.Pool;
    const runTool = jest.fn(async () => ({ content: [{ type: 'text' as const, text: '{"scale":3}' }] }));
    const auditWriter = jest.fn(async () => {
      throw new Error('canonical audit outbox unavailable');
    });
    const executor = new PostgresIncidentRemediationExecutor(
      pool,
      {} as Config,
      { listForIncident: jest.fn() } as unknown as IncidentRemediationStore,
      runTool,
      auditWriter,
    );

    await expect(executor.executeChangePlan({
      incidentId: 81, remediationId: 91, planId: 71, expectedPlanVersion: 2,
      planHash: 'c'.repeat(64), operator: { id: 1, username: 'Alex' },
    })).rejects.toThrow('canonical audit outbox unavailable');

    expect(runTool).not.toHaveBeenCalled();
    expect(auditWriter).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'aiops.remediation.execution.started',
      planHash: 'c'.repeat(64),
    }));
    expect(clientQuery.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['BEGIN', 'ROLLBACK']));
    expect(clientQuery.mock.calls.map(call => call[0])).not.toContain('COMMIT');
  });

  it('rejects an unregistered persisted adapter before any provider mutation', async () => {
    const tampered = { ...planRow(), adapter_key: 'shell.exec.v1' } as unknown as IncidentRemediationChangePlanRow;
    const query = jest.fn(async (text: string) => {
      if (text.includes('SELECT plan.*') && text.includes('WHERE plan.id=')) return { rows: [tampered] } as never;
      throw new Error(`unexpected query: ${text}`);
    });
    const runTool = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not execute' }] }));
    const executor = new PostgresIncidentRemediationExecutor(
      { query } as unknown as pg.Pool,
      {} as Config,
      { listForIncident: jest.fn() } as unknown as IncidentRemediationStore,
      runTool,
    );

    await expect(executor.executeChangePlan({
      incidentId: 81, remediationId: 91, planId: 71, expectedPlanVersion: 2,
      planHash: 'c'.repeat(64), operator: { id: 1, username: 'Alex' },
    })).rejects.toMatchObject({ status: 409, code: 'remediation_adapter_unsupported' });
    expect(runTool).not.toHaveBeenCalled();
  });

  it('rejects invalid persisted adapter state before any provider mutation', async () => {
    const tampered = planRow({ adapter_state: { schemaVersion: 1, desired: { replicas: 3 } } });
    const query = jest.fn(async (text: string) => {
      if (text.includes('SELECT plan.*') && text.includes('WHERE plan.id=')) return { rows: [tampered] } as never;
      throw new Error(`unexpected query: ${text}`);
    });
    const runTool = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not execute' }] }));
    const executor = new PostgresIncidentRemediationExecutor(
      { query } as unknown as pg.Pool,
      {} as Config,
      { listForIncident: jest.fn() } as unknown as IncidentRemediationStore,
      runTool,
    );

    await expect(executor.executeChangePlan({
      incidentId: 81, remediationId: 91, planId: 71, expectedPlanVersion: 2,
      planHash: 'c'.repeat(64), operator: { id: 1, username: 'Alex' },
    })).rejects.toMatchObject({ status: 409, code: 'remediation_adapter_state_invalid' });
    expect(runTool).not.toHaveBeenCalled();
  });

  it('restores and verifies the approved previous replica count when verification fails', async () => {
    const approved = planRow();
    const executing = planRow({ status: 'executing', version: 3, execution_trace_id: 'd'.repeat(36) });
    const rolledBack = planRow({ status: 'rolled_back', version: 4, rolled_back_at: createdAt });
    const base = writePool();
    const originalQuery = base.query.bind(base);
    const query = jest.fn(async (text: string, params?: unknown[]) => {
      if (text.includes('SELECT plan.*') && text.includes('WHERE plan.id=')) return { rows: [approved] } as never;
      if (text.includes("SET status='executing'")) return { rows: [executing] } as never;
      if (text.includes('SET status=$2') && text.includes('rollback_trace_id')) return { rows: [rolledBack] } as never;
      if (text.includes('UPDATE mcp_observability_incident_remediations')) return { rows: [] } as never;
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] } as never;
      return originalQuery(text, params) as never;
    });
    const pool = { query } as unknown as pg.Pool;
    const failedRemediation = { ...remediation(), status: 'failed' as const, changePlans: [] };
    const store = { listForIncident: jest.fn(async () => [failedRemediation]) } as unknown as IncidentRemediationStore;
    const outputs = [3, 2, 1, 1];
    const runTool = jest.fn(async () => ({
      content: [{ type: 'text' as const, text: `{"scale":${outputs.shift()}}` }],
    }));
    const executor = new PostgresIncidentRemediationExecutor(
      pool, {} as Config, store, runTool, noOpIncidentRemediationAudit,
    );

    const result = await executor.executeChangePlan({
      incidentId: 81, remediationId: 91, planId: 71, expectedPlanVersion: 2,
      planHash: 'c'.repeat(64), operator: { id: 1, username: 'Alex' },
    });

    expect(runTool).toHaveBeenNthCalledWith(3, approved.write_tool_name, approved.rollback_arguments, expect.objectContaining({ allowedBundles: [29] }));
    expect(runTool).toHaveBeenNthCalledWith(4, approved.write_tool_name, approved.verify_arguments, expect.anything());
    expect(result.plan.status).toBe('rolled_back');
    expect(result.remediation.status).toBe('failed');
  });

  it('detects delayed drift and executes only the separately approved rollback hash', async () => {
    let currentPlan = planRow({
      status: 'verified', version: 4, executed_at: createdAt, verified_at: createdAt,
    });
    let currentMonitor = monitorRow();
    const exactRollbackHash = currentMonitor.rollback_hash;
    const base = writePool([scaleTool], { ...writeContext, status: 'verified', version: 4 });
    const originalQuery = base.query.bind(base);
    const query = jest.fn(async (text: string, params: any[] = []) => {
      if (text.includes('SELECT plan.*') && text.includes('WHERE plan.id=')) return { rows: [currentPlan] } as never;
      if (text.includes('SELECT monitor.*')) return { rows: [currentMonitor] } as never;
      if (text.includes("SET status='checking'")) {
        currentMonitor = monitorRow({
          ...currentMonitor, status: 'checking', version: Number(currentMonitor.version) + 1,
          observation_trace_id: String(params[1]),
        });
        return { rows: [currentMonitor] } as never;
      }
      if (text.includes('observed_replicas=$3')) {
        currentMonitor = monitorRow({
          ...currentMonitor, status: params[1], version: Number(currentMonitor.version) + 1,
          observed_replicas: params[2], observed_state: JSON.parse(String(params[3])),
          observation_result: params[4], observation_error: params[5],
          observed_at: createdAt,
        });
        return { rows: [currentMonitor] } as never;
      }
      if (text.includes('decided_by=$3')) {
        currentMonitor = monitorRow({
          ...currentMonitor, status: params[1], version: Number(currentMonitor.version) + 1,
          decided_by: params[2], decided_by_username: params[3], decision_comment: params[4], decided_at: createdAt,
        });
        return { rows: [currentMonitor] } as never;
      }
      if (text.includes("SET status='rolling_back'")) {
        currentMonitor = monitorRow({
          ...currentMonitor, status: 'rolling_back', version: Number(currentMonitor.version) + 1,
          rollback_trace_id: String(params[1]),
        });
        return { rows: [currentMonitor] } as never;
      }
      if (text.includes('rollback_result=$3') && text.includes('post_change_monitors')) {
        currentMonitor = monitorRow({
          ...currentMonitor, status: params[1], version: Number(currentMonitor.version) + 1,
          rollback_result: params[2], rollback_error: params[3], rolled_back_at: createdAt,
        });
        return { rows: [currentMonitor] } as never;
      }
      if (text.includes('UPDATE mcp_observability_incident_remediation_change_plans')) {
        currentPlan = planRow({
          ...currentPlan, status: params[1], version: Number(currentPlan.version) + 1,
          rollback_trace_id: params[2], rollback_result: params[3], rollback_error: params[4],
          rolled_back_at: createdAt,
        });
        return { rows: [] } as never;
      }
      if (text.includes('UPDATE mcp_observability_incident_remediations')) return { rows: [] } as never;
      if (text.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] } as never;
      return originalQuery(text, params) as never;
    });
    const pool = { query } as unknown as pg.Pool;
    const store = {
      listForIncident: jest.fn(async () => [{
        ...remediation(),
        status: currentPlan.status === 'verified' ? 'verified' as const : 'failed' as const,
        changePlans: [incidentRemediationChangePlanFromRow(
          currentPlan,
          incidentRemediationPostChangeMonitorFromRow(currentMonitor),
        )],
      }]),
    } as unknown as IncidentRemediationStore;
    const runTool = jest.fn(async () => ({
      content: [{ type: 'text' as const, text: '{"scale":1}' }],
    }));
    const executor = new PostgresIncidentRemediationExecutor(
      pool, {} as Config, store, runTool, noOpIncidentRemediationAudit,
    );

    const observed = await executor.monitorPostChange({
      incidentId: 81, remediationId: 91, planId: 71, monitorId: 81,
      expectedMonitorVersion: 1, rollbackHash: exactRollbackHash,
      operator: { id: null, username: 'argus.core' },
    });
    expect(observed.plan.postChangeMonitor).toMatchObject({
      status: 'regression_detected', observedReplicas: 1,
      observedState: { schemaVersion: 1, observed: { replicas: 1 } }, version: 3,
    });

    await expect(executor.executePostChangeRollback({
      incidentId: 81, remediationId: 91, planId: 71, monitorId: 81,
      expectedMonitorVersion: 3, rollbackHash: 'f'.repeat(64),
      operator: { id: 2, username: 'Reviewer' },
    })).rejects.toMatchObject({ status: 409, code: 'post_change_rollback_conflict' });
    expect(runTool).toHaveBeenCalledTimes(1);

    const approved = await executor.decidePostChangeRollback({
      incidentId: 81, remediationId: 91, planId: 71, monitorId: 81,
      expectedMonitorVersion: 3, rollbackHash: exactRollbackHash,
      decision: 'approve', comment: 'Rollback approved after drift review.',
      operator: { id: 2, username: 'Reviewer' },
    });
    expect(approved.plan.postChangeMonitor).toMatchObject({ status: 'rollback_approved', version: 4 });

    const result = await executor.executePostChangeRollback({
      incidentId: 81, remediationId: 91, planId: 71, monitorId: 81,
      expectedMonitorVersion: 4, rollbackHash: exactRollbackHash,
      operator: { id: 2, username: 'Reviewer' },
    });
    expect(runTool).toHaveBeenNthCalledWith(2, currentPlan.write_tool_name, currentPlan.rollback_arguments, expect.objectContaining({ allowedBundles: [29] }));
    expect(runTool).toHaveBeenNthCalledWith(3, currentPlan.write_tool_name, currentPlan.verify_arguments, expect.anything());
    expect(result.plan).toMatchObject({ status: 'rolled_back', postChangeMonitor: { status: 'rolled_back' } });
    expect(result.remediation.status).toBe('failed');
  });
});
