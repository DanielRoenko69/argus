import { jest } from '@jest/globals';
import type pg from 'pg';
import type { Config } from '../../config/env.js';
import type { IncidentRemediationStore } from '../incidentRemediations.js';
import type { IncidentRemediationAuditWriter } from '../incidentRemediationAudit.js';
import { PostgresIncidentRemediationExecutor } from '../incidentRemediationExecutor.js';
import type {
  IncidentRemediationChangePlanRow,
  IncidentRemediationPostChangeMonitorRow,
} from '../incidentRemediationPlans.js';

const now = '2026-09-09T12:00:00.000Z';
const executionTraceId = '11111111-1111-4111-8111-111111111111';
const observationTraceId = '22222222-2222-4222-8222-222222222222';
const rollbackTraceId = '33333333-3333-4333-8333-333333333333';

const planRow = (overrides: Partial<IncidentRemediationChangePlanRow> = {}): IncidentRemediationChangePlanRow => ({
  id: 71,
  remediation_id: 91,
  adapter_key: 'kubernetes.scale.v1', // gitleaks:allow -- public adapter identifier, not a credential
  bundle_id: 29,
  write_backend_id: 52,
  write_tool_name: 'aiops_kubernetes_write_resources_scale',
  status: 'executing',
  version: 3,
  plan_hash: 'c'.repeat(64),
  target_scope: { kind: 'kubernetes', namespace: 'argus-demo', workloadName: 'checkout-api' },
  preview: { format: 'replica_diff', summary: 'Scale.', lines: [], rollbackSummary: 'Restore.' },
  write_arguments: { namespace: 'argus-demo', name: 'checkout-api', scale: 3 },
  verify_arguments: { namespace: 'argus-demo', name: 'checkout-api' },
  rollback_arguments: { namespace: 'argus-demo', name: 'checkout-api', scale: 1 },
  adapter_state: { schemaVersion: 1, before: { replicas: 1 }, desired: { replicas: 3 } },
  previous_replicas: 1,
  desired_replicas: 3,
  created_by: 1,
  created_by_username: 'Alex',
  approved_by: 2,
  approved_by_username: 'Reviewer',
  approval_comment: null,
  approved_at: now,
  execution_trace_id: executionTraceId,
  execution_result: null,
  execution_error: null,
  executed_at: null,
  verification_trace_id: null,
  verification_result: null,
  verification_error: null,
  verified_at: null,
  rollback_trace_id: null,
  rollback_result: null,
  rollback_error: null,
  rolled_back_at: null,
  created_at: now,
  updated_at: now,
  ...overrides,
});

const monitorRow = (
  status: IncidentRemediationPostChangeMonitorRow['status'],
  overrides: Partial<IncidentRemediationPostChangeMonitorRow> = {},
): IncidentRemediationPostChangeMonitorRow => ({
  id: 81,
  remediation_id: 91,
  plan_id: 71,
  status,
  version: 2,
  rollback_hash: 'e'.repeat(64),
  scheduled_for: now,
  observation_trace_id: status === 'checking' ? observationTraceId : null,
  observed_replicas: null,
  observed_state: null,
  observation_result: null,
  observation_error: null,
  observed_at: null,
  decided_by: status === 'rolling_back' ? 2 : null,
  decided_by_username: status === 'rolling_back' ? 'Reviewer' : null,
  decision_comment: null,
  decided_at: status === 'rolling_back' ? now : null,
  rollback_trace_id: status === 'rolling_back' ? rollbackTraceId : null,
  rollback_result: null,
  rollback_error: null,
  rolled_back_at: null,
  created_at: now,
  updated_at: now,
  ...overrides,
});

function setup(input: {
  plans?: Array<IncidentRemediationChangePlanRow & { incident_id: number; root_trace_id: string }>;
  monitors?: Array<IncidentRemediationPostChangeMonitorRow & {
    incident_id: number;
    root_trace_id: string;
    plan: IncidentRemediationChangePlanRow;
  }>;
  observedReplicas?: number;
  providerError?: boolean;
}) {
  const plans = input.plans ?? [];
  const monitors = input.monitors ?? [];
  const query = jest.fn(async (sql: string) => {
    if (sql.includes("plan.status='executing'")) return { rows: plans };
    if (sql.includes("monitor.status IN ('checking','rolling_back')")) return { rows: monitors };
    throw new Error(`unexpected pool query: ${sql}`);
  });
  const clientQuery = jest.fn(async (sql: string, params?: unknown[]) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('UPDATE mcp_observability_incident_remediation_change_plans')) {
      const source = plans[0]?.id === Number(params?.[0]) ? plans[0]!.status === 'executing'
        ? plans[0]! : monitors[0]!.plan : monitors[0]!.plan;
      return { rows: [{ ...source, status: params?.[1], version: Number(source.version) + 1 }] };
    }
    if (sql.includes('UPDATE mcp_observability_incident_remediation_post_change_monitors')) {
      const source = monitors[0]!;
      return { rows: [{ ...source, status: params?.[1], version: Number(source.version) + 1 }] };
    }
    if (sql.includes('UPDATE mcp_observability_incident_remediations')) return { rows: [] };
    if (sql.includes('INSERT INTO mcp_observability_incident_remediation_events')) return { rows: [] };
    if (sql.includes('INSERT INTO mcp_observability_incident_remediation_post_change_monitors')) return { rows: [] };
    throw new Error(`unexpected client query: ${sql}`);
  });
  const release = jest.fn();
  const connect = jest.fn(async () => ({ query: clientQuery, release }));
  const pool = { query, connect } as unknown as pg.Pool;
  const execute = jest.fn(async () => input.providerError
    ? { content: [{ type: 'text' as const, text: 'connector unavailable' }], isError: true }
    : { content: [{ type: 'text' as const, text: JSON.stringify({ replicas: input.observedReplicas ?? 3 }) }] });
  const audit = jest.fn(async () => undefined) as unknown as jest.MockedFunction<IncidentRemediationAuditWriter>;
  const executor = new PostgresIncidentRemediationExecutor(
    pool,
    { aiopsRemediationReconcileStaleSec: 45, aiopsPostChangeMonitorDelaySec: 300 } as Config,
    { listForIncident: jest.fn() } as unknown as IncidentRemediationStore,
    execute,
    audit,
  );
  return { executor, execute, audit, connect, clientQuery };
}

describe('incident remediation reconciliation worker', () => {
  it('finalizes an interrupted execution from the observed approved desired state without replaying the write', async () => {
    const executing = { ...planRow(), incident_id: 81, root_trace_id: 'root-trace-81' };
    const { executor, execute, audit } = setup({ plans: [executing], observedReplicas: 3 });

    await expect(executor.reconcileInterruptedOperations()).resolves.toEqual({
      examined: 1, recovered: 1, failedClosed: 0, deferred: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(executing.write_tool_name, executing.verify_arguments, expect.objectContaining({
      allowedBundles: [29],
    }));
    expect(execute).not.toHaveBeenCalledWith(executing.write_tool_name, executing.write_arguments, expect.anything());
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'aiops.remediation.execution.reconciled',
      outcome: 'success',
      context: expect.objectContaining({ resolution: 'desired_state_observed' }),
    }));
  });

  it('fails an interrupted execution closed when the provider is back at the pre-change state', async () => {
    const executing = { ...planRow(), incident_id: 81, root_trace_id: 'root-trace-81' };
    const { executor, execute, audit } = setup({ plans: [executing], observedReplicas: 1 });

    await expect(executor.reconcileInterruptedOperations()).resolves.toEqual({
      examined: 1, recovered: 0, failedClosed: 1, deferred: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'failure',
      context: expect.objectContaining({ resolution: 'pre_change_state_observed' }),
    }));
  });

  it('repeats a stale read-only monitor check and finalizes it atomically', async () => {
    const plan = planRow({ status: 'verified', version: 4, verified_at: now });
    const checking = { ...monitorRow('checking'), incident_id: 81, root_trace_id: 'root-trace-81', plan };
    const { executor, execute, audit } = setup({ monitors: [checking], observedReplicas: 3 });

    await expect(executor.reconcileInterruptedOperations()).resolves.toEqual({
      examined: 1, recovered: 1, failedClosed: 0, deferred: 0,
    });
    expect(execute).toHaveBeenCalledWith(plan.write_tool_name, plan.verify_arguments, expect.anything());
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'aiops.remediation.monitor.reconciled', outcome: 'success',
    }));
  });

  it('recognizes a completed stale rollback from the observed pre-change state', async () => {
    const plan = planRow({ status: 'verified', version: 4, verified_at: now });
    const rollingBack = { ...monitorRow('rolling_back'), incident_id: 81, root_trace_id: 'root-trace-81', plan };
    const { executor, execute, audit } = setup({ monitors: [rollingBack], observedReplicas: 1 });

    await expect(executor.reconcileInterruptedOperations()).resolves.toEqual({
      examined: 1, recovered: 1, failedClosed: 0, deferred: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'aiops.remediation.post-change-rollback.reconciled', outcome: 'success',
    }));
  });

  it('defers without mutating state while the exact provider read is unavailable', async () => {
    const executing = { ...planRow(), incident_id: 81, root_trace_id: 'root-trace-81' };
    const { executor, connect } = setup({ plans: [executing], providerError: true });

    await expect(executor.reconcileInterruptedOperations()).resolves.toEqual({
      examined: 1, recovered: 0, failedClosed: 0, deferred: 1,
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
