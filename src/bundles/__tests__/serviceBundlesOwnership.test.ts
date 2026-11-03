import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../../lib/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { OpenApiOwnershipError } from '../../lib/openApiOwnership.js';
import { deleteBundle } from '../serviceBundles.js';

interface BundleMockOptions {
  prefixes?: string[];
  backend?: { id: number; name: string; config: unknown; source_controlled: boolean };
  tool?: { id: number; name: string; category: string | null; source_controlled: boolean };
}

function bundlePool(options: BundleMockOptions = {}) {
  const sql: string[] = [];
  const query = jest.fn(async (statement: string) => {
    const normalized = statement.replace(/\s+/g, ' ').trim();
    sql.push(normalized);
    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: null };
    }
    if (normalized.includes('SELECT DISTINCT candidate.name_prefix')) {
      return { rows: (options.prefixes ?? []).map(name_prefix => ({ name_prefix })), rowCount: null };
    }
    if (normalized.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    if (normalized.startsWith('SELECT id FROM mcp_service_bundles')) return { rows: [{ id: 4 }], rowCount: 1 };
    if (normalized.includes('FROM mcp_backends backend')) {
      return { rows: options.backend ? [options.backend] : [], rowCount: options.backend ? 1 : 0 };
    }
    if (normalized.includes('FROM mcp_tools tool')) {
      return { rows: options.tool ? [options.tool] : [], rowCount: options.tool ? 1 : 0 };
    }
    if (normalized.startsWith('DELETE FROM mcp_tools')) return { rows: [], rowCount: 1 };
    if (normalized.startsWith('DELETE FROM mcp_backends')) return { rows: [], rowCount: 1 };
    if (normalized.startsWith('DELETE FROM mcp_service_bundles')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query: ${normalized}`);
  });
  const client = { query, release: jest.fn() } as unknown as pg.PoolClient;
  const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;
  return { pool, sql };
}

describe('deleteBundle OpenAPI ownership boundary', () => {
  it('rejects even a plain bundle delete when it would cascade a source boundary', async () => {
    const { pool, sql } = bundlePool({
      prefixes: ['pets'],
      backend: { id: 9, name: 'pets', config: {}, source_controlled: true },
    });

    await expect(deleteBundle(pool, 4, false)).rejects.toBeInstanceOf(OpenApiOwnershipError);
    expect(sql).toContain('ROLLBACK');
    expect(sql.some(statement => statement.startsWith('DELETE FROM mcp_service_bundles'))).toBe(false);
    expect(sql.findIndex(statement => statement.includes('pg_advisory_xact_lock')))
      .toBeLessThan(sql.findIndex(statement => statement.startsWith('SELECT id FROM mcp_service_bundles')));
  });

  it('rejects category-owned legacy tools even without a source-operation row', async () => {
    const { pool, sql } = bundlePool({
      prefixes: ['pets'],
      tool: { id: 12, name: 'pets__get', category: 'openapi:pets', source_controlled: false },
    });

    await expect(deleteBundle(pool, 4, true)).rejects.toBeInstanceOf(OpenApiOwnershipError);
    expect(sql.some(statement => statement.startsWith('DELETE FROM mcp_tools'))).toBe(false);
    expect(sql).toContain('ROLLBACK');
  });

  it('keeps deletion atomic for ordinary bundle contents', async () => {
    const { pool, sql } = bundlePool({
      backend: { id: 10, name: 'manual', config: {}, source_controlled: false },
      tool: { id: 13, name: 'manual_get', category: 'manual', source_controlled: false },
    });

    await expect(deleteBundle(pool, 4, true)).resolves.toBeUndefined();
    expect(sql.some(statement => statement.startsWith('DELETE FROM mcp_tools'))).toBe(true);
    expect(sql.some(statement => statement.startsWith('DELETE FROM mcp_backends'))).toBe(true);
    expect(sql.some(statement => statement.startsWith('DELETE FROM mcp_service_bundles'))).toBe(true);
    expect(sql).toContain('COMMIT');
  });
});
