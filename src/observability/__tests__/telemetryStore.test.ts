import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { setSharedPool } from '../../lib/sharedPool.js';
import {
  finishTelemetrySpan,
  finishTelemetryTrace,
  findPreviousComparableTelemetryTrace,
  flushTelemetryWrites,
  getNativeTelemetryContext,
  getTelemetryAnalytics,
  getTelemetrySpan,
  getTelemetryTrace,
  getTelemetryTraceHistoricalBaseline,
  listTelemetryTraceFamily,
  listTelemetryTraces,
  sanitizeTelemetryValue,
  startTelemetrySpan,
  startTelemetryTrace,
  withNativeTelemetryContext,
} from '../telemetryStore.js';

function fakePool() {
  const query = jest.fn<pg.Pool['query']>().mockResolvedValue({ rows: [], rowCount: 0 } as never);
  return { query } as unknown as pg.Pool;
}

afterEach(async () => {
  await flushTelemetryWrites();
  setSharedPool(null);
});

describe('native telemetry store', () => {
  it('redacts credential keys and PII before values reach the write queue', () => {
    expect(sanitizeTelemetryValue({
      namespace: 'platform',
      a2a_task_id: 'cac69299-c831-492e-9d83-51600376f1c0',
      apiToken: 'do-not-store',
      nested: { password: 'also-secret', owner: 'alex@example.com' },
    })).toEqual({
      namespace: 'platform',
      a2a_task_id: 'cac69299-c831-492e-9d83-51600376f1c0',
      apiToken: '[REDACTED]',
      nested: { password: '[REDACTED]', owner: '[EMAIL]' },
    });
  });

  it('persists root and child lifecycle updates in order', async () => {
    const pool = fakePool();
    setSharedPool(pool);

    const trace = startTelemetryTrace({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'agent.chat',
      kind: 'agent',
      sessionId: 'session-7',
      userId: 7,
      input: { prompt: 'hello', authorization: 'Bearer never-store-this-token' },
    });
    const span = startTelemetrySpan({
      traceId: trace.id,
      name: 'llm.iteration.1',
      kind: 'llm',
      model: 'gpt-test',
      input: { messageCount: 3 },
    });
    finishTelemetrySpan(span, {
      status: 'completed',
      output: 'done',
      inputTokens: 12,
      outputTokens: 5,
      totalCostUsd: 0.001,
    });
    finishTelemetryTrace(trace, {
      status: 'completed',
      output: 'done',
      inputTokens: 12,
      outputTokens: 5,
      totalCostUsd: 0.001,
    });
    await flushTelemetryWrites();

    expect(trace.traceId).toBe(trace.id);
    expect(span.traceId).toBe(trace.id);
    expect(span.rootTraceId).toBe(trace.id);
    const calls = (pool.query as jest.MockedFunction<pg.Pool['query']>).mock.calls;
    expect(calls).toHaveLength(4);
    expect(String(calls[0]?.[0])).toContain('INSERT INTO mcp_observability_traces');
    expect(String(calls[1]?.[0])).toContain('INSERT INTO mcp_observability_spans');
    expect(String(calls[2]?.[0])).toContain('UPDATE mcp_observability_spans');
    expect(String(calls[3]?.[0])).toContain('UPDATE mcp_observability_traces');
    expect(JSON.stringify(calls[0]?.[1])).toContain('[REDACTED]');
    expect(JSON.stringify(calls[0]?.[1])).not.toContain('never-store-this-token');
  });

  it('correlates a nested trace with the active root trace and parent span', async () => {
    const pool = fakePool();
    setSharedPool(pool);
    let capturedContext = getNativeTelemetryContext();

    const child = withNativeTelemetryContext({
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      traceId: '22222222-2222-4222-8222-222222222222',
      spanId: '33333333-3333-4333-8333-333333333333',
      userId: 12,
      workflowId: 42,
      workflowExecutionId: 99,
      tenantKey: 'tenant-a',
      workspaceKey: 'engineering',
    }, () => {
      capturedContext = getNativeTelemetryContext();
      return startTelemetryTrace({ name: 'agent.child', kind: 'agent', agentId: 7 });
    });
    await flushTelemetryWrites();

    expect(child.rootTraceId).toBe('11111111-1111-4111-8111-111111111111');
    expect(capturedContext?.workflowId).toBe(42);
    expect(capturedContext?.workflowExecutionId).toBe(99);
    expect(child.tenantKey).toBe('tenant-a');
    expect(child.workspaceKey).toBe('engineering');
    expect(getNativeTelemetryContext()).toBeNull();
    const params = (pool.query as jest.MockedFunction<pg.Pool['query']>).mock.calls[0]?.[1] as unknown[] | undefined;
    expect(params?.slice(2, 5)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);
    expect(params?.[8]).toBe(12);
    expect(params?.[10]).toBe(99);
    expect(JSON.parse(String(params?.[15]))).toMatchObject({
      tenantKey: 'tenant-a',
      workspaceKey: 'engineering',
    });
  });

  it('scopes trace lists by owner and assigned backend bundles', async () => {
    const pool = fakePool();
    await listTelemetryTraces(pool, {
      userId: 12,
      observeAll: false,
      allowedBundleIds: [4, 9],
      kind: 'agent',
      hours: 24,
      limit: 50,
    });

    const [sql, params] = (pool.query as jest.MockedFunction<pg.Pool['query']>).mock.calls[0] ?? [];
    expect(String(sql)).toContain('trace.user_id = $1');
    expect(String(sql)).toContain('agent.bundle_ids && $3::int[]');
    expect(params).toEqual([12, false, [4, 9], 24, 'agent', 50]);
  });

  it('applies tenant and workspace selectors inside the trace query', async () => {
    const pool = fakePool();
    await listTelemetryTraces(pool, {
      userId: 12,
      observeAll: false,
      tenantKey: 'acme',
      workspaceKey: 'engineering',
      limit: 25,
    });

    const [sql, params] = (pool.query as jest.MockedFunction<pg.Pool['query']>).mock.calls[0] ?? [];
    expect(String(sql)).toContain("trace.metadata->>'tenantKey'");
    expect(String(sql)).toContain("trace.metadata->>'tenant_key'");
    expect(String(sql)).toContain("trace.metadata->>'workspaceKey'");
    expect(String(sql)).toContain("trace.metadata->>'workspace_key'");
    expect(params).toEqual([12, false, 'acme', 'engineering', 25]);
  });

  it('scopes trace and span detail lookups with metadata or Golden Path ownership', async () => {
    const tracePool = fakePool();
    await getTelemetryTrace(tracePool, '11111111-1111-4111-8111-111111111111', {
      userId: 12,
      observeAll: false,
      allowedBundleIds: [4, 9],
      tenantKey: 'acme',
      workspaceKey: 'engineering',
    });
    const [traceSql, traceParams] = (tracePool.query as jest.MockedFunction<pg.Pool['query']>).mock.calls[0] ?? [];
    expect(String(traceSql)).toContain("trace.metadata->>'tenantKey'");
    expect(String(traceSql)).toContain('golden.workflow_execution_id=trace.workflow_execution_id');
    expect(traceParams).toEqual([
      '11111111-1111-4111-8111-111111111111', 12, false, [4, 9], 'acme', 'engineering',
    ]);

    const spanPool = fakePool();
    await getTelemetrySpan(spanPool, '22222222-2222-4222-8222-222222222222', {
      userId: 12,
      observeAll: false,
      tenantKey: 'acme',
      workspaceKey: 'engineering',
    });
    const [spanSql, spanParams] = (spanPool.query as jest.MockedFunction<pg.Pool['query']>).mock.calls[0] ?? [];
    expect(String(spanSql)).toContain("trace.metadata->>'workspaceKey'");
    expect(String(spanSql)).toContain('golden.workflow_execution_id=trace.workflow_execution_id');
    expect(spanParams).toEqual([
      '22222222-2222-4222-8222-222222222222', 12, false, 'acme', 'engineering',
    ]);
  });

  it('loads a bounded trace family with root ownership and bundle scope', async () => {
    const pool = fakePool();
    const query = pool.query as jest.MockedFunction<pg.Pool['query']>;
    query.mockResolvedValueOnce({ rows: [{ id: '22222222-2222-4222-8222-222222222222' }], rowCount: 1 } as never);
    const result = await listTelemetryTraceFamily(pool, '11111111-1111-4111-8111-111111111111', {
      userId: 12,
      observeAll: false,
      allowedBundleIds: [4, 9],
      tenantKey: 'acme',
      workspaceKey: 'engineering',
    });

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('trace.root_trace_id = $1');
    expect(String(sql)).toContain('family_root.id = $1 AND family_root.user_id = $2');
    expect(String(sql)).toContain('agent.bundle_ids && $4::int[]');
    expect(String(sql)).toContain("trace.metadata->>'tenantKey'");
    expect(String(sql)).toContain('golden.workflow_execution_id=trace.workflow_execution_id');
    expect(String(sql)).toContain('LIMIT 251');
    expect(params).toEqual([
      '11111111-1111-4111-8111-111111111111', 12, false, [4, 9], 'acme', 'engineering',
    ]);
    expect(String(query.mock.calls[1]?.[0])).toContain('span.trace_id = ANY($1::uuid[])');
    expect(query.mock.calls[1]?.[1]).toEqual([['22222222-2222-4222-8222-222222222222']]);
    expect(result.spans).toEqual([]);
  });

  it('selects a previous successful baseline with the same definition and access scope', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValue({
      rows: [{ id: '11111111-1111-4111-8111-111111111111', kind: 'workflow' }], rowCount: 1,
    } as never);
    const pool = { query } as unknown as pg.Pool;
    const baseline = await findPreviousComparableTelemetryTrace(
      pool,
      '22222222-2222-4222-8222-222222222222',
      { userId: 12, observeAll: false, allowedBundleIds: [4, 9] },
    );

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(baseline?.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(String(sql)).toContain("trace.status = 'completed'");
    expect(String(sql)).toContain('workflow_execution.workflow_id = current_root.definition_workflow_id');
    expect(String(sql)).toContain('trace.agent_id = current_root.agent_id');
    expect(String(sql)).toContain('agent.bundle_ids && $4::int[]');
    expect(String(sql)).toContain('($3::boolean OR trace.user_id = $2)');
    expect(params).toEqual(['22222222-2222-4222-8222-222222222222', 12, false, [4, 9]]);
  });

  it('aggregates bundle-scoped historical trace families into seven and thirty day baselines', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValue({ rows: [{
      sample_count_7d: '12', terminal_count_7d: '13', median_duration_ms_7d: '1000', p95_duration_ms_7d: '1800',
      median_cost_usd_7d: '0.02', p95_cost_usd_7d: '0.04', success_rate_7d: '92.3',
      sample_count_30d: '40', terminal_count_30d: '43', median_duration_ms_30d: '1100', p95_duration_ms_30d: '2000',
      median_cost_usd_30d: '0.021', p95_cost_usd_30d: '0.05', success_rate_30d: '93.0',
    }] } as never);
    const pool = { query } as unknown as pg.Pool;
    const windows = await getTelemetryTraceHistoricalBaseline(
      pool,
      '22222222-2222-4222-8222-222222222222',
      { userId: 12, observeAll: false, allowedBundleIds: [4, 9] },
    );

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(windows[0]).toMatchObject({ days: 7, sampleCount: 12, medianDurationMs: 1000, medianCostUsd: 0.02 });
    expect(windows[1]).toMatchObject({ days: 30, sampleCount: 40, p95DurationMs: 2000, successRate: 93 });
    expect(String(sql)).toContain("trace.started_at >= current_root.started_at - interval '30 days'");
    expect(String(sql)).toContain('family_trace.root_trace_id = trace.id');
    expect(String(sql)).toContain('agent.bundle_ids && $4::int[]');
    expect(params).toEqual(['22222222-2222-4222-8222-222222222222', 12, false, [4, 9]]);
  });

  it('loads one span through root ownership and bundle visibility', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValue({ rows: [{ id: 'span-1' }], rowCount: 1 } as never);
    const pool = { query } as unknown as pg.Pool;
    const result = await getTelemetrySpan(pool, '33333333-3333-4333-8333-333333333333', {
      userId: 12,
      observeAll: false,
      allowedBundleIds: [4, 9],
    });

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(result?.id).toBe('span-1');
    expect(String(sql)).toContain('span.id=$1::uuid');
    expect(String(sql)).toContain('family_root.id=trace.root_trace_id');
    expect(String(sql)).toContain('agent.bundle_ids && $4::int[]');
    expect(params).toEqual(['33333333-3333-4333-8333-333333333333', 12, false, [4, 9]]);
  });

  it('builds analytics from the same owner and bundle-scoped trace set', async () => {
    const analytics = {
      summary: { totalTraces: 0 }, timeline: [], models: [], tools: [], agents: [], workflows: [],
    };
    const query = jest.fn<pg.Pool['query']>().mockResolvedValue({ rows: [{ analytics }] } as never);
    const pool = { query } as unknown as pg.Pool;

    const result = await getTelemetryAnalytics(pool, {
      userId: 12,
      observeAll: false,
      allowedBundleIds: [4, 9],
      hours: 24,
    });

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(result).toBe(analytics);
    expect(String(sql)).toContain('($3::boolean OR trace.user_id = $1)');
    expect(String(sql)).toContain('agent.bundle_ids && $4::int[]');
    expect(String(sql)).toContain("percentile_cont(0.95)");
    expect(params).toEqual([12, 24, false, [4, 9]]);
  });
});
