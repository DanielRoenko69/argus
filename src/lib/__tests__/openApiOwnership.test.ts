import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  isOpenApiCategory,
  lockBackendOpenApiOwnership,
  lockCapabilityOpenApiOwnership,
} from '../openApiOwnership.js';

function clientWith(handler: (sql: string, params: unknown[]) => unknown): pg.PoolClient {
  return {
    query: jest.fn(async (sql: string, params: unknown[] = []) => handler(sql, params)),
  } as unknown as pg.PoolClient;
}

describe('OpenAPI ownership guards', () => {
  it('reserves the OpenAPI category namespace case-insensitively', () => {
    expect(isOpenApiCategory('openapi:pets')).toBe(true);
    expect(isOpenApiCategory('  OpenAPI:Pets ')).toBe(true);
    expect(isOpenApiCategory('manual')).toBe(false);
  });

  it('locks a capability row and treats category or source-operation ownership as protected', async () => {
    const client = clientWith(sql => {
      expect(sql).toMatch(/FOR UPDATE OF tool/);
      return {
        rows: [{ id: 7, name: 'pets__get', category: 'manual', source_controlled: true }],
      };
    });

    await expect(lockCapabilityOpenApiOwnership(client, 7)).resolves.toMatchObject({
      id: 7,
      sourceControlled: true,
    });
  });

  it('uses importer lock order and recognizes a managed legacy backend without a source row', async () => {
    const calls: string[] = [];
    const client = clientWith(sql => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (sql === 'SELECT name FROM mcp_backends WHERE id = $1') return { rows: [{ name: 'pets' }] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes('FROM mcp_backends backend')) {
        return { rows: [{ id: 9, name: 'pets', config: { managed_by: 'openapi' } }] };
      }
      if (sql.includes('FROM mcp_capability_sources source')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(lockBackendOpenApiOwnership(client, 9)).resolves.toMatchObject({
      sourceControlled: true,
      backend: { id: 9, name: 'pets' },
    });
    expect(calls.findIndex(sql => sql.includes('pg_advisory_xact_lock')))
      .toBeLessThan(calls.findIndex(sql => sql.includes('FROM mcp_backends backend')));
    expect(calls.findIndex(sql => sql.includes('FROM mcp_backends backend')))
      .toBeLessThan(calls.findIndex(sql => sql.includes('FROM mcp_capability_sources source')));
  });
});
