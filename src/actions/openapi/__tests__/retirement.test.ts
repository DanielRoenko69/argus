import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  OpenApiSourceRetirementError,
  previewOpenApiSourceRetirement,
  retireOpenApiSource,
  type OpenApiSourceRetirementConfirmation,
} from '../retirement.js';

const source = {
  id: 4,
  backend_id: 9,
  name_prefix: 'pets',
  title: 'Pets API',
  revision: '2',
  manifest_digest: 'a'.repeat(64),
  operation_count: 2,
};

const backend = {
  id: 9,
  name: 'pets',
  enabled: true,
};

const tools = [
  {
    id: 11,
    name: 'pets__getpet',
    category: 'openapi:pets',
    backend: 'custom:pets',
    is_write: false,
    enabled: true,
    mapped_name: 'pets__getpet',
  },
  {
    id: 12,
    name: 'pets__deletepet',
    category: 'openapi:pets',
    backend: 'custom:pets',
    is_write: true,
    enabled: false,
    mapped_name: 'pets__deletepet',
  },
];

const backendBundles = [{ id: 21, name: 'pets', label: 'Pets' }];
const toolBundles = [
  { tool_id: 11, id: 21, name: 'pets', label: 'Pets' },
  { tool_id: 12, id: 22, name: 'operators', label: 'Operators' },
];
const workflows = [
  { id: 31, name: 'inspect_pet', capability_names: ['pets__deletepet', 'pets__getpet'] },
  { id: 32, name: 'remove_pet', capability_names: ['pets__deletepet'] },
];

interface PoolOptions {
  source?: typeof source | null;
  retireSource?: typeof source | null;
  backend?: typeof backend | null;
  tools?: typeof tools;
  backendBundles?: typeof backendBundles;
  toolBundles?: typeof toolBundles;
  workflows?: typeof workflows;
  deletedTools?: Array<{ id: number; name: string }>;
  backendDeleted?: boolean;
  failDelete?: Error;
}

function servicePool(options: PoolOptions = {}) {
  const sourceRow = options.source === undefined ? source : options.source;
  const backendRow = options.backend === undefined ? backend : options.backend;
  const toolRows = options.tools ?? tools;
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: jest.fn(async (rawSql: string, params: unknown[] = []) => {
      const sql = rawSql.replace(/\s+/g, ' ').trim();
      captured.push({ sql, params });
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK'
        || sql.startsWith('LOCK TABLE') || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('JOIN mcp_backends backend') && sql.includes('WHERE source.id = $1')) {
        return {
          rows: sourceRow && backendRow ? [{
            ...sourceRow,
            backend_name: backendRow.name,
            backend_enabled: backendRow.enabled,
          }] : [],
        };
      }
      if (sql.startsWith('SELECT source.backend_id, source.name_prefix')) {
        return { rows: sourceRow ? [{ backend_id: sourceRow.backend_id, name_prefix: sourceRow.name_prefix }] : [] };
      }
      if (sql.includes('FROM mcp_backends backend') && sql.includes('FOR UPDATE OF backend')) {
        return { rows: backendRow ? [backendRow] : [] };
      }
      if (sql.includes('FROM mcp_capability_sources source') && sql.includes('FOR UPDATE OF source')) {
        const row = options.retireSource === undefined ? sourceRow : options.retireSource;
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('FROM mcp_tools tool')) return { rows: toolRows };
      if (sql.includes('FROM mcp_backend_bundles assignment')) {
        return { rows: options.backendBundles ?? backendBundles };
      }
      if (sql.includes('FROM mcp_tool_bundles assignment')) {
        return { rows: options.toolBundles ?? toolBundles };
      }
      if (sql.includes('FROM mcp_workflows workflow')) {
        return { rows: options.workflows ?? workflows };
      }
      if (sql.startsWith('DELETE FROM mcp_tools')) {
        if (options.failDelete) throw options.failDelete;
        return {
          rows: options.deletedTools ?? toolRows.map(tool => ({ id: tool.id, name: tool.name })),
          rowCount: options.deletedTools?.length ?? toolRows.length,
        };
      }
      if (sql.startsWith('DELETE FROM mcp_backends')) {
        return { rows: options.backendDeleted === false || !backendRow ? [] : [{ id: backendRow.id }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in retirement test: ${sql}`);
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => client),
  } as unknown as pg.Pool;
  return { pool, client, captured };
}

async function confirmationFrom(pool: pg.Pool): Promise<OpenApiSourceRetirementConfirmation> {
  return (await previewOpenApiSourceRetirement(pool, source.id)).confirmation;
}

describe('OpenAPI source retirement service', () => {
  it('previews exact capability, preserved bundle and dangling workflow impact', async () => {
    const { pool, captured, client } = servicePool();
    const preview = await previewOpenApiSourceRetirement(pool, '4');

    expect(preview.source).toEqual({
      id: 4,
      name: 'Pets API',
      prefix: 'pets',
      revision: '2',
      manifestDigest: 'a'.repeat(64),
      operationCount: 2,
    });
    expect(preview.backend).toEqual({ id: 9, name: 'pets', enabled: true });
    expect(preview.impact.capabilities).toEqual([
      expect.objectContaining({
        id: 12, name: 'pets__deletepet', bundleIds: [22], workflowCount: 2,
      }),
      expect.objectContaining({
        id: 11, name: 'pets__getpet', bundleIds: [21], workflowCount: 1,
      }),
    ]);
    expect(preview.impact.bundles).toEqual([
      {
        id: 21, name: 'pets', label: 'Pets', connectionAssigned: true,
        capabilityIds: [11], capabilityNames: ['pets__getpet'],
      },
      {
        id: 22, name: 'operators', label: 'Operators', connectionAssigned: false,
        capabilityIds: [12], capabilityNames: ['pets__deletepet'],
      },
    ]);
    expect(preview.impact.workflows).toEqual(workflows.map(row => ({
      id: row.id,
      name: row.name,
      capabilityNames: [...row.capability_names].sort(),
    })));
    expect(preview.confirmation).toEqual({
      expectedPrefix: 'pets',
      expectedRevision: '2',
      expectedManifestDigest: 'a'.repeat(64),
      expectedImpactDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(captured[0]?.sql).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(captured.at(-1)?.sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('retires under importer-compatible locks and deletes only exact locked source tools plus backend', async () => {
    const fixture = servicePool();
    const confirmation = await confirmationFrom(fixture.pool);
    fixture.captured.length = 0;

    const result = await retireOpenApiSource(fixture.pool, 4, confirmation);
    const sql = fixture.captured.map(entry => entry.sql);
    const advisoryIndex = sql.findIndex(statement => statement.includes('pg_advisory_xact_lock'));
    const backendIndex = sql.findIndex(statement => statement.includes('FOR UPDATE OF backend'));
    const sourceIndex = sql.findIndex(statement => statement.includes('FOR UPDATE OF source'));
    const toolsIndex = sql.findIndex(statement => statement.includes('FOR UPDATE OF tool'));
    const impactLockIndex = sql.findIndex(statement => statement.startsWith('LOCK TABLE'));
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(backendIndex).toBeGreaterThan(advisoryIndex);
    expect(sourceIndex).toBeGreaterThan(backendIndex);
    expect(toolsIndex).toBeGreaterThan(sourceIndex);
    expect(impactLockIndex).toBeGreaterThan(toolsIndex);

    const deleteTools = fixture.captured.find(entry => entry.sql.startsWith('DELETE FROM mcp_tools'))!;
    expect(deleteTools.sql).toContain('id = ANY($1::int[])');
    expect(deleteTools.sql).toContain('category = $2');
    expect(deleteTools.sql).toContain('backend = $3');
    expect(deleteTools.params).toEqual([[11, 12], 'openapi:pets', 'custom:pets']);
    expect(sql.some(statement => statement.startsWith('DELETE FROM mcp_service_bundles'))).toBe(false);
    expect(sql.some(statement => statement.startsWith('DELETE FROM mcp_workflows'))).toBe(false);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(result).toEqual(expect.objectContaining({
      sourceId: 4,
      backendId: 9,
      prefix: 'pets',
      deletedCapabilities: [
        { id: 11, name: 'pets__getpet' },
        { id: 12, name: 'pets__deletepet' },
      ],
      deletedCapabilityCount: 2,
      preservedBundleIds: [21, 22],
      preservedWorkflowIds: [31, 32],
      retiredAt: expect.any(String),
    }));
  });

  it('rejects a changed revision or manifest before loading or deleting tools', async () => {
    const previewPool = servicePool();
    const confirmation = await confirmationFrom(previewPool.pool);
    const fixture = servicePool({ retireSource: { ...source, revision: '3' } });

    await expect(retireOpenApiSource(fixture.pool, 4, confirmation))
      .rejects.toMatchObject({ status: 409, code: 'baseline_changed' });
    expect(fixture.captured.some(entry => entry.sql.includes('FOR UPDATE OF tool'))).toBe(false);
    expect(fixture.captured.some(entry => entry.sql.startsWith('DELETE FROM'))).toBe(false);
    expect(fixture.captured.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('recomputes workflow and bundle impact under locks and rejects a stale confirmation', async () => {
    const previewPool = servicePool();
    const confirmation = await confirmationFrom(previewPool.pool);
    const fixture = servicePool({
      workflows: [...workflows, { id: 33, name: 'new_pet_flow', capability_names: ['pets__getpet'] }],
    });

    await expect(retireOpenApiSource(fixture.pool, 4, confirmation))
      .rejects.toMatchObject({ status: 409, code: 'impact_changed' });
    expect(fixture.captured.some(entry => entry.sql.startsWith('LOCK TABLE'))).toBe(true);
    expect(fixture.captured.some(entry => entry.sql.startsWith('DELETE FROM'))).toBe(false);
    expect(fixture.captured.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('fails closed when an operation mapping points outside the exact importer category/backend scope', async () => {
    const foreignMappedTool = [{
      ...tools[0],
      category: 'manual',
      backend: 'custom:other',
      mapped_name: tools[0]!.name,
    }];
    const fixture = servicePool({ tools: foreignMappedTool });
    const syntacticallyValidConfirmation: OpenApiSourceRetirementConfirmation = {
      expectedPrefix: 'pets',
      expectedRevision: '2',
      expectedManifestDigest: 'a'.repeat(64),
      expectedImpactDigest: 'b'.repeat(64),
    };

    await expect(retireOpenApiSource(fixture.pool, 4, syntacticallyValidConfirmation))
      .rejects.toMatchObject({ status: 409, code: 'ownership_mismatch' });
    expect(fixture.captured.some(entry => entry.sql.startsWith('DELETE FROM'))).toBe(false);
  });

  it('rolls back if the exact locked capability set cannot be deleted', async () => {
    const fixture = servicePool({ deletedTools: [{ id: 11, name: 'pets__getpet' }] });
    const confirmation = await confirmationFrom(fixture.pool);
    fixture.captured.length = 0;

    await expect(retireOpenApiSource(fixture.pool, 4, confirmation))
      .rejects.toMatchObject({ status: 409, code: 'impact_changed' });
    expect(fixture.captured.some(entry => entry.sql.startsWith('DELETE FROM mcp_backends'))).toBe(false);
    expect(fixture.captured.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('validates IDs and exact confirmation fields before opening a transaction', async () => {
    const fixture = servicePool();
    await expect(previewOpenApiSourceRetirement(fixture.pool, '04'))
      .rejects.toBeInstanceOf(OpenApiSourceRetirementError);
    await expect(retireOpenApiSource(fixture.pool, 4, {
      expectedPrefix: 'pets',
      expectedRevision: '2',
      expectedManifestDigest: 'a'.repeat(64),
      expectedImpactDigest: 'b'.repeat(64),
      unexpected: true,
    })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(fixture.pool.connect).not.toHaveBeenCalled();
  });
});
