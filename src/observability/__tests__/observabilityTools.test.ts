import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { executeArgusObservabilityTool } from '../observabilityTools.js';

const trace = {
  id: '11111111-1111-4111-8111-111111111111',
  external_trace_id: null,
  root_trace_id: '11111111-1111-4111-8111-111111111111',
  parent_trace_id: null,
  parent_span_id: null,
  name: 'workflow.release',
  kind: 'workflow',
  status: 'failed',
  session_id: null,
  user_id: 12,
  agent_id: null,
  workflow_execution_id: 42,
  model: null,
  provider: null,
  started_at: '2026-08-01T10:00:00.000Z',
  ended_at: '2026-08-01T10:00:02.000Z',
  duration_ms: 2000,
  input_preview: { password: 'password=hunter2' },
  output_preview: { status: 'failed' },
  error_message: 'request failed',
  input_tokens: 0,
  output_tokens: 0,
  total_cost_usd: 0,
  metadata: {},
  agent_name: null,
};

function poolWithQuery(query: (...args: [string, unknown[]?]) => Promise<unknown>): pg.Pool {
  return { query: jest.fn(query) } as unknown as pg.Pool;
}

describe('Argus read-only Observability MCP tools', () => {
  it('requires trace correlation before searching logs', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    const result = await executeArgusObservabilityTool(
      { query } as unknown as pg.Pool,
      'argus_observe_search_logs',
      { query: 'failure' },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('trace_id');
    expect(query).not.toHaveBeenCalled();
  });

  it('applies bundle scope and normalizes the error status alias when searching traces', async () => {
    const pool = poolWithQuery(async () => ({ rows: [trace] }));
    const result = await executeArgusObservabilityTool(
      pool,
      'argus_observe_search_traces',
      { hours: 12, limit: 10, status: 'error' },
      [4, 9],
    );
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('workflow.release');
    const calls = (pool.query as unknown as { mock: { calls: Array<[string, unknown[]]> } }).mock.calls;
    expect(calls[0]?.[0]).toContain('mcp_workflow_bundles');
    expect(calls[0]?.[1]).toContainEqual([4, 9]);
    expect(calls[0]?.[1]).toContain('failed');
    expect(calls[0]?.[1]).not.toContain('error');
  });

  it('redacts previews and structured log data before returning evidence', async () => {
    const pool = poolWithQuery(async (sql: string) => {
      if (sql.includes('SELECT trace.*')) return { rows: [trace] };
      if (sql.includes('SELECT * FROM mcp_observability_spans')) return { rows: [] };
      if (sql.includes('FROM argus_logs')) {
        return { rows: [{
          id: 7,
          ts: '2026-08-01T10:00:01.000Z',
          level: 'error',
          msg: 'upstream password=hunter2 rejected',
          tool: 'deploy',
          backend: 'cluster',
          req_id: 'req-7',
          root_trace_id: trace.root_trace_id,
          trace_id: trace.id,
          span_id: null,
          data: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456' },
        }] };
      }
      return { rows: [] };
    });
    const detail = await executeArgusObservabilityTool(
      pool,
      'argus_observe_get_trace',
      { trace_id: trace.id, include_family: false, include_previews: true },
    );
    const logs = await executeArgusObservabilityTool(
      pool,
      'argus_observe_search_logs',
      { trace_id: trace.id, query: 'upstream' },
    );
    const output = `${detail.content[0]?.text}\n${logs.content[0]?.text}`;
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(output).toContain('[REDACTED]');
  });
});
