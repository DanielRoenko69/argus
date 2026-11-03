import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { Config } from '../../config/env.js';
import { runAiOpsEvidenceQueryPreflight } from '../aiopsEvidenceQueryPreflight.js';

const input = {
  bundleId: 11,
  lane: 'logs' as const,
  query: {
    id: 'checkout-errors',
    toolName: 'elastic_search',
    source: {
      kind: 'elasticsearch' as const,
      resource: 'logs-checkout-*',
      fields: {
        timestamp: '@timestamp',
        service: 'service.name',
        message: 'message',
        severity: 'log.level',
        traceId: 'trace.id',
      },
    },
    defaults: { signalKeyword: 'payment_failed' },
    template: JSON.stringify({
      index: 'logs-checkout-*',
      query_json: JSON.stringify({
        query: {
          bool: {
            filter: [
              { term: { 'service.name': '${service.name}' } },
              { term: { environment: '${environment}' } },
              { range: { '@timestamp': { gte: '${window.start}', lte: '${window.end}' } } },
            ],
            must: [{ match_phrase: { message: '${signal.keyword}' } }],
          },
        },
      }),
    }),
  },
  context: {
    serviceName: 'checkout-api',
    environment: 'production',
    windowStart: '2026-09-08T11:30:00.000Z',
    windowEnd: '2026-09-08T12:00:00.000Z',
    signal: { keyword: 'timeout "after checkout"' },
  },
  execute: false,
};

const pool = {} as pg.Pool;
const config = {} as Config;

describe('AIOps evidence query preflight', () => {
  it('renders typed context into bounded JSON arguments without breaking escaping', async () => {
    const result = await runAiOpsEvidenceQueryPreflight(pool, config, input, {
      loadAllowedTools: async () => new Set(['elastic_search']),
      loadToolSafety: async () => ({ enabled: true, isWrite: false, source: 'managed' }),
      now: () => new Date('2026-09-08T12:01:00.000Z'),
    });

    expect(result).toMatchObject({
      state: 'preview',
      executed: false,
      bundleId: 11,
      request: { arguments: { index: 'logs-checkout-*' } },
    });
    const query = JSON.parse(String(result.request.arguments['query_json'])) as Record<string, unknown>;
    expect(JSON.stringify(query)).toContain('checkout-api');
    expect(JSON.stringify(query)).toContain('timeout \\"after checkout\\"');
  });

  it('renders incident windows as Unix microseconds for trace providers', async () => {
    const result = await runAiOpsEvidenceQueryPreflight(pool, config, {
      ...input,
      lane: 'traces',
      query: {
        id: 'checkout-traces',
        toolName: 'aiops_jaeger_find_traces',
        source: { kind: 'generic', resource: 'jaeger' },
        template: JSON.stringify({
          service: '${service.name}',
          start_micros: '${window.start_micros}',
          end_micros: '${window.end_micros}',
          limit: 20,
        }),
      },
    }, {
      loadAllowedTools: async () => new Set(['aiops_jaeger_find_traces']),
      loadToolSafety: async () => ({ enabled: true, isWrite: false, source: 'managed' }),
    });

    expect(result.request.arguments).toMatchObject({
      service: 'checkout-api',
      start_micros: '1788867000000000',
      end_micros: '1788868800000000',
      limit: 20,
    });
  });

  it('executes only an allowed read tool and returns a bounded redacted sample', async () => {
    const execute = jest.fn(async (
      _toolName: string,
      _args: Record<string, unknown>,
      _context: { pool: pg.Pool; config: Config; allowedBundles: number[] },
    ) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ hits: { total: { value: 42 }, hits: [{ _source: { email: 'maintainer@example.com' } }] } }) }],
    }));
    const result = await runAiOpsEvidenceQueryPreflight(pool, config, { ...input, execute: true }, {
      loadAllowedTools: async () => new Set(['elastic_search']),
      loadToolSafety: async () => ({ enabled: true, isWrite: false, source: 'managed' }),
      execute,
      now: () => new Date('2026-09-08T12:01:00.000Z'),
    });

    expect(result.state).toBe('succeeded');
    expect(result.response?.matchedDocuments).toBe(42);
    expect(result.response?.preview).not.toContain('maintainer@example.com');
    expect(execute).toHaveBeenCalledWith('elastic_search', expect.objectContaining({ index: 'logs-checkout-*' }), {
      pool,
      config,
      allowedBundles: [11],
    });
  });

  it('rejects tools outside the bundle and tools classified as writes', async () => {
    await expect(runAiOpsEvidenceQueryPreflight(pool, config, input, {
      loadAllowedTools: async () => new Set(),
    })).rejects.toMatchObject({ status: 403, code: 'forbidden' });

    await expect(runAiOpsEvidenceQueryPreflight(pool, config, input, {
      loadAllowedTools: async () => new Set(['elastic_search']),
      loadToolSafety: async () => ({ enabled: true, isWrite: true, source: 'managed' }),
    })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('rejects invalid windows and unresolved context placeholders before execution', async () => {
    await expect(runAiOpsEvidenceQueryPreflight(pool, config, {
      ...input,
      context: { ...input.context, windowEnd: input.context.windowStart },
    })).rejects.toBeDefined();

    await expect(runAiOpsEvidenceQueryPreflight(pool, config, {
      ...input,
      query: { ...input.query, defaults: undefined, template: '{"query":"${signal.fingerprint}"}' },
    }, {
      loadAllowedTools: async () => new Set(['elastic_search']),
      loadToolSafety: async () => ({ enabled: true, isWrite: false, source: 'managed' }),
    })).rejects.toMatchObject({ status: 400, code: 'invalid_profile' });
  });
});
