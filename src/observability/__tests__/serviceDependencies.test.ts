import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  listServiceDependencies,
  serviceDependenciesFromJaegerResult,
  upsertServiceDependencyEvidence,
} from '../serviceDependencies.js';

function jaegerResult(traces: unknown[]) {
  return { content: [{ type: 'text' as const, text: `HTTP 200 OK\n\n${JSON.stringify({ data: traces })}` }] };
}

describe('service dependency evidence', () => {
  it('extracts explicit database dependencies and error state without using operation-name guesses', () => {
    const evidence = serviceDependenciesFromJaegerResult(jaegerResult([{
      traceID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      processes: { p1: { serviceName: 'argus-core', tags: [{ key: 'deployment.environment', value: 'demo' }] } },
      spans: [{
        spanID: '1111111111111111', processID: 'p1', operationName: 'opaque-operation',
        startTime: 1_786_565_000_000_000, duration: 45_000_000, references: [],
        tags: [{ key: 'db.system', value: 'postgresql' }, { key: 'otel.status_code', value: 'ERROR' }],
      }],
    }]), { bundleId: 28, environment: 'demo', sourceRef: 'aiops_jaeger_find_traces' });
    expect(evidence).toEqual([expect.objectContaining({
      environment: 'demo', sourceService: 'argus-core', targetKind: 'database', targetName: 'postgresql',
      relation: 'queries', durationMs: 45000, failed: true,
    })]);
  });

  it('extracts cross-process service calls only from a real parent-child trace relation', () => {
    const evidence = serviceDependenciesFromJaegerResult(jaegerResult([{
      traceID: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      processes: {
        p1: { serviceName: 'frontend', tags: [{ key: 'deployment.environment.name', value: 'demo' }] },
        p2: { serviceName: 'payments-api', tags: [{ key: 'deployment.environment.name', value: 'demo' }] },
      },
      spans: [{ spanID: 'parent', processID: 'p1', startTime: 1_786_565_000_000_000, duration: 10_000, references: [], tags: [] }, {
        spanID: 'child', processID: 'p2', startTime: 1_786_565_000_010_000, duration: 8_000,
        references: [{ refType: 'CHILD_OF', spanID: 'parent' }], tags: [],
      }],
    }]), { bundleId: 28, environment: 'demo', sourceRef: 'aiops_jaeger_find_traces' });
    expect(evidence).toEqual([expect.objectContaining({
      sourceService: 'frontend', targetKind: 'service', targetName: 'payments-api', relation: 'calls', failed: false,
    })]);
  });

  it('rejects connector self-telemetry without an explicit matching environment', () => {
    const evidence = serviceDependenciesFromJaegerResult(jaegerResult([{
      traceID: 'cccccccccccccccccccccccccccccccc',
      processes: { p1: { serviceName: 'jaeger' } },
      spans: [{
        spanID: '3333333333333333', processID: 'p1', startTime: 1_786_565_000_000_000,
        duration: 1_000, references: [], tags: [{ key: 'server.address', value: '127.0.0.1' }],
      }],
    }]), { bundleId: 28, environment: 'demo', sourceRef: 'aiops_jaeger_find_traces' });
    expect(evidence).toEqual([]);
  });

  it('persists deduplicated edge evidence and returns bounded aggregates', async () => {
    const writes: unknown[][] = [];
    const query = jest.fn(async (sql: unknown, params?: unknown[]) => {
      if (String(sql).startsWith('INSERT INTO')) { writes.push(params ?? []); return { rows: [], rowCount: 1 }; }
      return { rows: [{
        environment: 'demo', source_service: 'checkout-api', target_kind: 'database', target_name: 'postgresql',
        relation: 'queries', calls: 4, failures: 1, p95_duration_ms: 125.4,
        last_seen_at: '2026-08-12T18:00:00.000Z', current: true,
      }] };
    });
    const pool = { query } as unknown as pg.Pool;
    expect(await upsertServiceDependencyEvidence(pool, [{
      identitySeed: 'trace\0span\0checkout-api\0database\0postgresql\0queries', environment: 'demo',
      sourceService: 'checkout-api', targetKind: 'database', targetName: 'postgresql', relation: 'queries',
      bundleId: 28, sourceRef: 'jaeger', durationMs: 125, failed: true,
      observedAt: '2026-08-12T18:00:00.000Z',
    }])).toBe(1);
    expect(writes).toHaveLength(1);
    await expect(listServiceDependencies(pool)).resolves.toEqual([expect.objectContaining({
      calls: 4, failures: 1, p95DurationMs: 125, current: true,
    })]);
  });
});
