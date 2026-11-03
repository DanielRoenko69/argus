import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { A2aClientError, type A2aGateway, type A2aTask } from '../../a2a/client.js';
import type { IncidentAiopsTaskRecord, IncidentAiopsTaskStore } from '../incidentAiopsTasks.js';
import { NativeAlertAiopsDispatcher } from '../nativeAlertAiopsAutomation.js';

const now = '2026-08-12T18:00:00.000Z';

function task(state = 'TASK_STATE_WORKING'): A2aTask {
  return { id: 'task-81', contextId: 'context-81', status: { state: state as A2aTask['status']['state'] } };
}

function record(state = 'TASK_STATE_WORKING'): IncidentAiopsTaskRecord {
  return {
    id: 4, incidentId: 81, packId: 'argus.aiops', agentId: 'incident-orchestrator', taskId: 'task-81',
    rootTraceId: '11111111-1111-4111-8111-111111111111', state, quality: null, summary: null, result: null,
    executionContext: {
      bundleIds: [28],
      resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'argus-aiops-kind', namespace: 'argus-demo' },
      service: 'checkout-api', environment: 'argus-demo', capturedAt: now,
      serviceProfile: null, trigger: null,
    },
    createdBy: null, createdAt: now, updatedAt: now,
  };
}

function taskStore(input: { existing?: IncidentAiopsTaskRecord[]; active?: IncidentAiopsTaskRecord[] } = {}): IncidentAiopsTaskStore {
  return {
    async incidentExists() { return true; },
    async create() { return record(); },
    async list() { return input.existing ?? []; },
    async listActive() { return input.active ?? []; },
    async update(_id, snapshot) { return { ...record(), ...snapshot }; },
  };
}

function gateway(send: A2aGateway['sendMessage']): A2aGateway {
  return {
    async getAgentCard() { throw new Error('not used'); },
    sendMessage: send,
    async getTask() { return task('TASK_STATE_COMPLETED'); },
    async listTasks() { return { tasks: [], nextCursor: null }; },
    async cancelTask() { return task('TASK_STATE_CANCELED'); },
  };
}

function claimedRow() {
  return {
    id: 9, incident_id: 81, rule_id: 7, status: 'dispatching', bundle_ids: [28],
    resource_scope: { kind: 'kubernetes', backendId: 42, targetId: 'argus-aiops-kind', namespace: 'argus-demo' },
    service: 'checkout-api', environment: 'argus-demo', attempt_count: 1, available_at: now,
    last_attempt_at: now, last_error: null, task_link_id: null, created_at: now, updated_at: now,
    incident_state: 'firing', severity: 'critical', message: 'Latency exceeded the threshold.',
    triggered_at: now, rule_name: 'Checkout latency', rule_auto_enabled: true, window_minutes: 30,
    rule_enabled: true, rule_archived: false,
    service_profile_id: null, service_profile_revision: null, service_profile_sha256: null,
    correlation_group_id: 31, correlation_key: 'c'.repeat(64), correlation_signal_count: 2,
    correlation_window_minutes: 30,
  };
}

describe('native alert AIOps automation', () => {
  it('starts one deduplicated governed task with service-principal scope', async () => {
    const queries: string[] = [];
    let claimed = false;
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      queries.push(text);
      if (text.includes('WHERE incident.id=$1')) {
        return { rows: [{
          id: 81, triggered_at: now, recovered_at: null,
          aiops_service: 'checkout-api', aiops_environment: 'argus-demo',
        }] };
      }
      if (text.includes('mcp_observability_service_dependency_evidence')) {
        return { rows: [{
          source_service: 'checkout-api', target_kind: 'database', target_name: 'postgresql', relation: 'queries',
          calls: 4, failures: 4, p95_duration_ms: 1200, last_seen_at: now,
        }] };
      }
      if (text.includes('WITH candidate AS')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [claimedRow()] };
      }
      return { rows: [], rowCount: text.includes('INSERT INTO mcp_observability_incident_aiops_dispatches') ? 1 : 1 };
    });
    const send = jest.fn<A2aGateway['sendMessage']>(async (_packId, _agentId, _input, execution) => ({
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      agentCard: {} as never,
      task: task(),
      execution,
    } as never));
    let createInput: Parameters<IncidentAiopsTaskStore['create']>[0] | null = null;
    const store = taskStore();
    store.create = async input => {
      createInput = input;
      return record();
    };
    const dispatcher = new NativeAlertAiopsDispatcher(
      { query } as unknown as pg.Pool,
      gateway(send),
      store,
      3,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({ queued: 1, started: 1, active: 0 });
    const enqueueSql = queries.find(sql => sql.includes('INSERT INTO mcp_observability_incident_aiops_dispatches')) ?? '';
    expect(enqueueSql).toContain('mcp_observability_aiops_service_profiles');
    expect(enqueueSql).toContain('profile_queue_rank=1');
    expect(enqueueSql).toContain("correlation_member.role='primary'");
    expect(enqueueSql).toContain('ORDER BY EXISTS');
    expect(enqueueSql).toContain("'{detection,cooldownMinutes}'");
    expect(send).toHaveBeenCalledWith(
      'argus.aiops',
      'incident-orchestrator',
      expect.objectContaining({ data: expect.objectContaining({ operation: 'workflow.start' }) }),
      expect.objectContaining({
        principalKind: 'service',
        principalId: 'native-alert-rule:7',
        principalAllowedBundleIds: [28],
        requestedBundleIds: [28],
        requestedResourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'argus-aiops-kind', namespace: 'argus-demo' },
      }),
    );
    const sentInput = send.mock.calls[0]?.[2].data?.['input'] as Record<string, unknown>;
    const sentLabels = sentInput['labels'] as Record<string, string>;
    expect(sentLabels['argus.core.impact.status']).toBe('observed');
    expect(sentLabels['argus.core.impact.candidate.1']).toContain('target=database:postgresql');
    expect(sentLabels['argus.core.correlation.group_id']).toBe('31');
    expect(sentLabels['argus.core.correlation.signal_count']).toBe('2');
    expect(createInput).toMatchObject({ executionContext: {
      bundleIds: [28], service: 'checkout-api', environment: 'argus-demo',
      resourceScope: { kind: 'kubernetes', backendId: 42, targetId: 'argus-aiops-kind', namespace: 'argus-demo' },
    } });
    expect(queries.some(sql => sql.includes("SET status=$2"))).toBe(true);
  });

  it('blocks permanent capability or certification errors without retrying', async () => {
    const updates: unknown[][] = [];
    let claimed = false;
    const query = jest.fn(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('WITH candidate AS')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [claimedRow()] };
      }
      if (text.includes('UPDATE mcp_observability_incident_aiops_dispatches')) updates.push(params ?? []);
      return { rows: [], rowCount: 0 };
    });
    const dispatcher = new NativeAlertAiopsDispatcher(
      { query } as unknown as pg.Pool,
      gateway(async () => { throw new A2aClientError(409, 'bundle_capabilities_missing', 'metrics capability missing'); }),
      taskStore(),
      3,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result.blocked).toBe(1);
    expect(updates.some(params => params[1] === 'blocked' && params[2] === 'metrics capability missing')).toBe(true);
  });

  it('starts a native alert through its immutable active service profile', async () => {
    let claimed = false;
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('WITH candidate AS')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{
          ...claimedRow(),
          rule_auto_enabled: false,
          resource_scope: null,
          service_profile_id: 41,
          service_profile_revision: 3,
          service_profile_sha256: 'a'.repeat(64),
        }] };
      }
      return { rows: [], rowCount: text.includes('INSERT INTO mcp_observability_incident_aiops_dispatches') ? 1 : 1 };
    });
    let createInput: Parameters<IncidentAiopsTaskStore['create']>[0] | null = null;
    const store = taskStore();
    store.create = async input => { createInput = input; return record(); };
    const startProfile = jest.fn(async (_profileId: number, _signal: unknown, _principal: unknown, _expected: unknown) => ({
      schemaVersion: 1 as const,
      kind: 'aiops-service-profile-investigation-started' as const,
      profile: { id: 41, revision: 3, sha256: 'a'.repeat(64) },
      resolvedContextSha256: 'b'.repeat(64),
      execution: { bundleIds: [28], toolNames: ['prometheus_query'], resourceScope: null, service: 'checkout-api', environment: 'production' },
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      task: task(),
    }));
    const dispatcher = new NativeAlertAiopsDispatcher(
      { query } as unknown as pg.Pool,
      gateway(async () => { throw new Error('legacy path must not run'); }),
      store,
      3,
      { getForIncident: async () => null },
      startProfile,
    );

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({ queued: 1, started: 1 });
    expect(startProfile).toHaveBeenCalledWith(
      41,
      expect.objectContaining({ sourceIncidentId: 81, title: 'Checkout latency' }),
      expect.objectContaining({ kind: 'service', allowedBundleIds: [28] }),
      { revision: 3, sha256: 'a'.repeat(64) },
    );
    expect(createInput).toMatchObject({ executionContext: {
      bundleIds: [28], resourceScope: null, service: 'checkout-api', environment: 'production',
      serviceProfile: { id: 41, revision: 3, sha256: 'a'.repeat(64) },
      trigger: { kind: 'native-alert', ref: '81' },
    } });
  });

  it('retries a temporarily unreachable solution pack instead of blocking the incident', async () => {
    const updates: unknown[][] = [];
    let claimed = false;
    const query = jest.fn(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('WITH candidate AS')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [claimedRow()] };
      }
      if (text.includes('UPDATE mcp_observability_incident_aiops_dispatches')) updates.push(params ?? []);
      return { rows: [], rowCount: 0 };
    });
    const dispatcher = new NativeAlertAiopsDispatcher(
      { query } as unknown as pg.Pool,
      gateway(async () => { throw new A2aClientError(409, 'pack_not_ready', "solution pack 'argus.aiops' is unreachable"); }),
      taskStore(),
      3,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result.failed).toBe(1);
    expect(updates.some(params => params[1] === 'pending'
      && params[2] === "solution pack 'argus.aiops' is unreachable"
      && params[4] === 2)).toBe(true);
  });

  it('continues safely when optional impact enrichment is unavailable', async () => {
    let claimed = false;
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('WITH candidate AS')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [claimedRow()] };
      }
      if (text.includes('WHERE incident.id=$1')) throw new Error('impact store unavailable');
      return { rows: [], rowCount: 1 };
    });
    const send = jest.fn<A2aGateway['sendMessage']>(async () => ({
      rootTraceId: '11111111-1111-4111-8111-111111111111', agentCard: {} as never, task: task(),
    } as never));
    const dispatcher = new NativeAlertAiopsDispatcher(
      { query } as unknown as pg.Pool,
      gateway(send),
      taskStore(),
      3,
    );

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({ started: 1 });
    const input = send.mock.calls[0]?.[2].data?.['input'] as Record<string, unknown>;
    expect(input['labels']).toMatchObject({
      'argus.core.impact.schema': '1',
      'argus.core.impact.status': 'unavailable',
    });
  });

  it('defers queued work while the configured concurrency ceiling is occupied', async () => {
    const active = record();
    const query = jest.fn(async (sql: unknown) => ({
      rows: String(sql).includes('WITH candidate AS') ? [claimedRow()] : [],
      rowCount: 0,
    }));
    const store = taskStore({ active: [active] });
    const dispatcher = new NativeAlertAiopsDispatcher(
      { query } as unknown as pg.Pool,
      gateway(async () => ({ rootTraceId: active.rootTraceId!, agentCard: {} as never, task: task() })),
      store,
      1,
    );

    const result = await dispatcher.dispatchOnce();

    expect(result).toMatchObject({ active: 1, started: 0 });
    expect(query.mock.calls.some(call => String(call[0]).includes('WITH candidate AS'))).toBe(false);
  });
});
