import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { flushLogBuffer, initLogStore, writeLog } from '../logStore.js';

describe('structured log correlation', () => {
  it('persists native trace, span, agent and workflow execution fields', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
    initLogStore({ query } as unknown as pg.Pool);

    writeLog({
      time: Date.now(),
      level: 30,
      msg: 'Tool execution completed',
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      traceId: '22222222-2222-4222-8222-222222222222',
      spanId: '33333333-3333-4333-8333-333333333333',
      agentId: 7,
      workflowExecutionId: 42,
      tenantKey: 'tenant-a',
      workspaceKey: 'engineering',
    });
    await flushLogBuffer();

    const insert = query.mock.calls.find(call => String(call[0]).includes('INSERT INTO argus_logs'));
    expect(insert).toBeDefined();
    expect(String(insert?.[0])).toContain('tenant_key, workspace_key');
    expect(insert?.[1]).toEqual(expect.arrayContaining([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      7,
      42,
      'tenant-a',
      'engineering',
    ]));
  });
});
