import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { MappedOp } from '../map.js';
import { importOpenApi } from '../importOpenApi.js';
import { buildOpenApiCapabilityManifest } from '../manifest.js';

jest.mock('../../../lib/encryption.js', () => ({
  encrypt: (value: string | null | undefined) => value == null ? null : `enc(${value})`,
  decrypt: (value: string | null | undefined) => value ?? null,
}));
jest.mock('../../../backends/customBackends.js', () => ({
  assertSsrfSafeResolved: jest.fn(async () => undefined),
  assertEgressAllowed: jest.fn(() => undefined),
}));

const operations: MappedOp[] = [
  {
    name: 'pets__getpet', description: 'Get pet', queryTemplate: 'GET /pets/{{id}}',
    parameters: [{ name: 'id', type: 'string', description: '', required: true }],
    isWrite: false, method: 'GET', path: '/pets/{id}', tags: [], warnings: [], supported: true,
  },
  {
    name: 'pets__createpet', description: 'Create pet', queryTemplate: 'POST /pets\n\n{{body}}',
    parameters: [{ name: 'body', type: 'string', description: '', required: true }],
    isWrite: true, method: 'POST', path: '/pets', tags: [], warnings: [], supported: true,
  },
];

interface MockOptions {
  existingBackend?: Record<string, unknown>;
  existingBundle?: { id: number; description: string };
  previous?: Array<{ id: number; name: string }>;
  collisions?: Array<{ name: string; category: string | null; backend: string }>;
  existingSource?: Record<string, unknown>;
  existingBackendBundleIds?: number[];
  baselineSignatures?: Record<string, string | null>;
  removalWorkflowCounts?: Record<string, number>;
}

function mockPool(options: MockOptions = {}) {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  let nextToolId = 70;
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (/SELECT id, description, base_url/.test(sql)) return { rows: options.existingBackend ? [options.existingBackend] : [] };
      if (/FROM mcp_capability_sources\s+WHERE name_prefix/.test(sql)) return { rows: options.existingSource ? [options.existingSource] : [] };
      if (/INSERT INTO mcp_capability_sources/.test(sql)) return { rows: [{ id: 80 }] };
      if (/SELECT bundle_id\s+FROM mcp_backend_bundles/.test(sql)) {
        return { rows: (options.existingBackendBundleIds ?? []).map(bundle_id => ({ bundle_id })) };
      }
      if (/SELECT tool\.name, baseline\.signature AS baseline_signature/.test(sql)) {
        return {
          rows: (options.previous ?? []).map(tool => ({
            name: tool.name,
            baseline_signature: options.baselineSignatures?.[tool.name] ?? null,
          })),
        };
      }
      if (/FROM unnest\(\$1::text\[\]\) AS candidate\(name\)/.test(sql)) {
        return {
          rows: ((params[0] as string[]) ?? []).sort().map(name => ({
            name,
            workflow_count: options.removalWorkflowCounts?.[name] ?? 0,
          })),
        };
      }
      if (/INSERT INTO mcp_backends/.test(sql)) return { rows: [{ id: 50 }] };
      if (/SELECT id, description FROM mcp_service_bundles/.test(sql)) return { rows: options.existingBundle ? [options.existingBundle] : [] };
      if (/INSERT INTO mcp_service_bundles/.test(sql)) return { rows: [{ id: 60 }] };
      if (/SELECT id FROM mcp_service_bundles WHERE id = ANY/.test(sql)) {
        return { rows: ((params[0] as number[]) ?? []).map(id => ({ id })) };
      }
      if (/SELECT name, category, backend FROM mcp_tools/.test(sql)) return { rows: options.collisions ?? [] };
      if (/SELECT id, name FROM mcp_tools/.test(sql)) return { rows: options.previous ?? [] };
      if (/INSERT INTO mcp_tools/.test(sql)) return { rows: [{ id: nextToolId++ }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;
  return { pool, client, captured };
}

const baseInput = {
  backendName: 'pets',
  baseUrl: 'https://api.pets.example/v1',
  authType: 'header' as const,
  authValue: 'X-API-Key:secret',
  credentialMode: 'replace' as const,
  namePrefix: 'pets',
  operations,
  sourceManifest: buildOpenApiCapabilityManifest({
    prefix: 'pets', sourceKind: 'text', title: 'Pets', openapiVersion: '3.0.3',
    baseUrl: 'https://api.pets.example/v1', baseUrlOverridden: false,
    security: { auth_type: 'header', headerName: 'X-API-Key' }, specDigest: 'a'.repeat(64), operations,
  }),
  expectedSourceRevision: null,
  expectedSourceManifestDigest: null,
  expectedExistingBundleIds: [],
};

const existingSource = {
  id: 80,
  backend_id: 50,
  revision: '1',
  manifest_digest: baseInput.sourceManifest.manifestDigest,
  auth_scheme: { type: 'header', headerName: 'X-API-Key' },
};

describe('importOpenApi', () => {
  it('creates an owned backend, default bundle and exact backend/tool bundle scope atomically', async () => {
    const { pool, captured } = mockPool();
    const result = await importOpenApi(pool, baseInput);

    expect(result).toEqual({
      backendId: 50,
      bundleId: 60,
      bundleIds: [60],
      created: { read: 1, write: 1 },
      inserted: { read: 1, write: 1 },
      updated: { read: 0, write: 0 },
      removed: [],
      skipped: [],
      sourceId: 80,
    });
    const sql = captured.map(entry => entry.sql).join('\n');
    expect(sql).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/INSERT INTO mcp_backend_bundles/);
    expect(sql).toMatch(/INSERT INTO mcp_tool_bundles/);
    expect(sql).toMatch(/ON CONFLICT \(name\) DO UPDATE/);
    expect(sql).toMatch(/COMMIT/);
    const backendInsert = captured.find(entry => /INSERT INTO mcp_backends/.test(entry.sql))!;
    expect(backendInsert.params).toContain('enc(X-API-Key:secret)');
    const toolInserts = captured.filter(entry => /INSERT INTO mcp_tools/.test(entry.sql));
    expect(toolInserts.some(entry => entry.params.includes(true) && entry.params.includes('high'))).toBe(true);
  });

  it('reimports with stable name upserts and preserves existing governance fields', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'X-API-Key:existing-secret', backend_type: 'http', managed_by: 'openapi',
      },
      existingBundle: { id: 60, description: 'OpenAPI: pets' },
      existingBackendBundleIds: [60],
      previous: operations.map((operation, index) => ({ id: 70 + index, name: operation.name })),
      existingSource,
      baselineSignatures: Object.fromEntries(baseInput.sourceManifest.operations
        .map(operation => [operation.name, operation.signature])),
    });
    const result = await importOpenApi(pool, {
      ...baseInput,
      authValue: null,
      credentialMode: 'preserve',
      allowReimport: true,
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
      expectedExistingBundleIds: [60],
    });

    expect(result.inserted).toEqual({ read: 0, write: 0 });
    expect(result.updated).toEqual({ read: 1, write: 1 });
    expect(result.removed).toEqual([]);
    const sql = captured.map(entry => entry.sql).join('\n');
    expect(sql).not.toMatch(/DELETE FROM mcp_tools/);
    expect(sql).toMatch(/ELSE mcp_tools\.risk_level/);
    expect(sql).not.toMatch(/enabled = EXCLUDED\.enabled/);
    expect(sql).toMatch(/WHEN EXCLUDED\.enabled = false THEN false/);
    const backendUpdate = captured.find(entry => /UPDATE mcp_backends/.test(entry.sql))!;
    expect(backendUpdate.sql).not.toMatch(/auth_mode/);
  });

  it('stages every retained imported capability, including unselected source operations', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'encrypted', enabled: true,
        backend_type: 'http', managed_by: 'openapi',
      },
      existingBundle: { id: 60, description: 'OpenAPI: pets' },
      existingBackendBundleIds: [60],
      previous: operations.map((operation, index) => ({ id: 70 + index, name: operation.name })),
      existingSource,
      baselineSignatures: Object.fromEntries(baseInput.sourceManifest.operations
        .map(operation => [operation.name, operation.signature])),
    });

    const result = await importOpenApi(pool, {
      ...baseInput,
      operations: [operations[0]!],
      sourceOperationNames: operations.map(operation => operation.name),
      enabled: false,
      allowReimport: true,
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
      expectedExistingBundleIds: [60],
    });

    expect(result.removed).toEqual([]);
    expect(captured.some(entry => /UPDATE mcp_tools\s+SET enabled = false[\s\S]+category = \$1/.test(entry.sql)
      && entry.params[1] === 'custom:pets')).toBe(true);
  });

  it('removes only source operations absent from the new spec after preflight', async () => {
    const { pool, captured } = mockPool({
      previous: [
        { id: 70, name: operations[0]!.name },
        { id: 71, name: 'pets__removed' },
      ],
    });
    const result = await importOpenApi(pool, {
      ...baseInput,
      operations: [operations[0]!],
      sourceOperationNames: [operations[0]!.name],
      allowReimport: true,
      allowRemoval: true,
      expectedRemovalNames: ['pets__removed'],
      expectedRemovalImpacts: [{ name: 'pets__removed', workflowCount: 0 }],
    });
    expect(result.removed).toEqual(['pets__removed']);
    expect(captured.some(entry => /DELETE FROM mcp_tools/.test(entry.sql) && entry.params[2] instanceof Array)).toBe(true);
    expect(captured.some(entry => /UPDATE mcp_bundle_backend_tool_policies/.test(entry.sql)
      && entry.params[1] instanceof Array)).toBe(true);
  });

  it('rejects a removal when the locked diff no longer matches the preview confirmation', async () => {
    const { pool, captured } = mockPool({
      previous: [
        { id: 70, name: operations[0]!.name },
        { id: 71, name: 'pets__removed' },
      ],
    });
    await expect(importOpenApi(pool, {
      ...baseInput,
      operations: [operations[0]!],
      sourceOperationNames: [operations[0]!.name],
      allowReimport: true,
      allowRemoval: true,
      expectedRemovalNames: ['pets__different_removal'],
    })).rejects.toThrow(/changed after preview/i);
    expect(captured.some(entry => /INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('rolls back when workflow impact changes after the removal preview', async () => {
    const { pool, captured } = mockPool({
      previous: [
        { id: 70, name: operations[0]!.name },
        { id: 71, name: 'pets__removed' },
      ],
      removalWorkflowCounts: { pets__removed: 1 },
    });
    await expect(importOpenApi(pool, {
      ...baseInput,
      operations: [operations[0]!],
      sourceOperationNames: [operations[0]!.name],
      allowReimport: true,
      allowRemoval: true,
      expectedRemovalNames: ['pets__removed'],
      expectedRemovalImpacts: [{ name: 'pets__removed', workflowCount: 0 }],
    })).rejects.toThrow(/removal impact changed after preview/i);
    expect(captured.some(entry => entry.sql === 'LOCK TABLE mcp_workflows IN SHARE MODE')).toBe(true);
    expect(captured.some(entry => /DELETE FROM mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('rejects an empty import before opening a transaction', async () => {
    const { pool } = mockPool();
    await expect(importOpenApi(pool, { ...baseInput, operations: [] })).rejects.toThrow(/at least one supported operation/i);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects runtime-coerced bundle IDs and inconsistent request metadata before a transaction', async () => {
    const { pool } = mockPool();
    await expect(importOpenApi(pool, {
      ...baseInput,
      bundleIds: ['7'] as unknown as number[],
    })).rejects.toThrow(/bundle selection is invalid/i);
    await expect(importOpenApi(pool, {
      ...baseInput,
      operations: [{ ...operations[0]!, method: 'DELETE', isWrite: false }],
    })).rejects.toThrow(/unsupported operations/i);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back when the prefix belongs to a non-imported backend', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Manually managed', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'encrypted', backend_type: 'http', managed_by: null,
      },
    });
    await expect(importOpenApi(pool, baseInput)).rejects.toThrow(/not owned by the OpenAPI importer/i);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
    expect(captured.some(entry => /INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
  });

  it('does not claim a same-named bundle through a spoofed importer description', async () => {
    const { pool, captured } = mockPool({
      existingBundle: { id: 60, description: 'OpenAPI: pets' },
    });
    await expect(importOpenApi(pool, baseInput)).rejects.toThrow(/Bundle 'pets'.*not owned/i);
    expect(captured.some(entry => /INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('does not treat a spoofed legacy description as importer ownership', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'X-API-Key:secret', backend_type: 'http', managed_by: null,
      },
    });
    await expect(importOpenApi(pool, baseInput)).rejects.toThrow(/not owned by the OpenAPI importer/i);
    expect(captured.some(entry => /UPDATE mcp_backends|INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('refuses to preserve an existing secret across an origin change', async () => {
    const { pool } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: 'https://old.example/v1',
        auth_type: 'header', auth_value: 'X-API-Key:existing-secret', backend_type: 'http', managed_by: 'openapi',
      },
      existingSource,
    });
    await expect(importOpenApi(pool, {
      ...baseInput,
      authValue: null,
      credentialMode: 'preserve',
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
    }))
      .rejects.toThrow(/origin changes/i);
  });

  it('fails closed when a credential selected for preservation no longer exists under lock', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: null, enabled: true,
        backend_type: 'http', managed_by: 'openapi',
      },
      existingSource,
    });

    await expect(importOpenApi(pool, {
      ...baseInput,
      authValue: null,
      credentialMode: 'preserve',
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
    })).rejects.toThrow(/credential no longer exists/i);
    expect(captured.some(entry => /UPDATE mcp_backends/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('requires replacement instead of reusing ciphertext that cannot be decrypted', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'enc:v1:opaque-ciphertext', backend_type: 'http', managed_by: 'openapi',
      },
      existingSource,
    });
    await expect(importOpenApi(pool, {
      ...baseInput,
      authValue: null,
      credentialMode: 'preserve',
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
    })).rejects.toThrow(/cannot be decrypted/i);
    expect(captured.some(entry => /UPDATE mcp_backends|INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('requires explicit reimport confirmation when capabilities appear after preview', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'encrypted', enabled: true,
        backend_type: 'http', managed_by: 'openapi',
      },
      existingBundle: { id: 60, description: 'OpenAPI: pets' },
      existingBackendBundleIds: [60],
      previous: operations.map((operation, index) => ({ id: 70 + index, name: operation.name })),
    });

    await expect(importOpenApi(pool, {
      ...baseInput,
      expectedExistingBundleIds: [60],
    })).rejects.toThrow(/state changed after preview.*reimport/i);
    expect(captured.some(entry => /INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it.each([
    ['revision', { revision: '2' }],
    ['digest', { manifest_digest: 'c'.repeat(64) }],
  ])('rolls back before mutation when the source %s is stale', async (_label, staleState) => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'X-API-Key:existing-secret', backend_type: 'http', managed_by: 'openapi',
      },
      existingSource: { ...existingSource, ...staleState },
    });
    await expect(importOpenApi(pool, {
      ...baseInput,
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
    })).rejects.toThrow(/baseline changed after preview/i);
    expect(captured.some(entry => /UPDATE mcp_backends|INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('requires a replacement credential when a header-auth name changed', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'encrypted', backend_type: 'http', managed_by: 'openapi',
      },
      existingSource: {
        ...existingSource,
        auth_scheme: { type: 'header', headerName: 'X-Old-Key' },
      },
    });
    await expect(importOpenApi(pool, {
      ...baseInput,
      authValue: null,
      credentialMode: 'preserve',
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
    })).rejects.toThrow(/API key header changes/i);
    expect(captured.some(entry => /UPDATE mcp_backends|INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('requires a replacement when the live backend header differs from its source baseline', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'X-Other-Key:existing-secret', backend_type: 'http', managed_by: 'openapi',
      },
      existingSource,
    });
    await expect(importOpenApi(pool, {
      ...baseInput,
      authValue: null,
      credentialMode: 'preserve',
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
    })).rejects.toThrow(/API key header changes/i);
    expect(captured.some(entry => /UPDATE mcp_backends|INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('rejects a changed retained capability that was omitted from a partial re-import', async () => {
    const changedCreate = { ...operations[1]!, description: 'Changed create operation' };
    const changedManifest = buildOpenApiCapabilityManifest({
      prefix: 'pets', sourceKind: 'text', title: 'Pets', openapiVersion: '3.0.3',
      baseUrl: baseInput.baseUrl, baseUrlOverridden: false,
      security: { auth_type: 'header', headerName: 'X-API-Key' }, specDigest: 'b'.repeat(64),
      operations: [operations[0]!, changedCreate],
    });
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'X-API-Key:existing-secret', backend_type: 'http', managed_by: 'openapi',
      },
      existingSource,
      previous: operations.map((operation, index) => ({ id: 70 + index, name: operation.name })),
      baselineSignatures: Object.fromEntries(baseInput.sourceManifest.operations
        .map(operation => [operation.name, operation.signature])),
    });

    await expect(importOpenApi(pool, {
      ...baseInput,
      operations: [operations[0]!],
      sourceOperationNames: operations.map(operation => operation.name),
      sourceManifest: changedManifest,
      authValue: null,
      credentialMode: 'preserve',
      allowReimport: true,
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: baseInput.sourceManifest.manifestDigest,
    })).rejects.toThrow(/must be selected for re-import/i);
    expect(captured.some(entry => /UPDATE mcp_backends|INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('requires all retained legacy tools to be selected when establishing the first baseline', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'X-API-Key:existing-secret', backend_type: 'http', managed_by: 'openapi',
      },
      existingSource: { ...existingSource, manifest_digest: null, auth_scheme: null },
      previous: operations.map((operation, index) => ({ id: 70 + index, name: operation.name })),
    });

    await expect(importOpenApi(pool, {
      ...baseInput,
      operations: [operations[0]!],
      sourceOperationNames: operations.map(operation => operation.name),
      allowReimport: true,
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: null,
    })).rejects.toThrow(/must be selected for re-import/i);
    expect(captured.some(entry => /UPDATE mcp_backends|INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });

  it('rolls back before mutation when bundle assignments changed after preview', async () => {
    const { pool, captured } = mockPool({
      existingBackend: {
        id: 50, description: 'Imported from OpenAPI', base_url: baseInput.baseUrl,
        auth_type: 'header', auth_value: 'encrypted', backend_type: 'http', managed_by: 'openapi',
      },
      existingBackendBundleIds: [99],
    });
    await expect(importOpenApi(pool, baseInput)).rejects.toThrow(/bundle assignments changed after preview/i);
    expect(captured.some(entry => /UPDATE mcp_backends|INSERT INTO mcp_tools/.test(entry.sql))).toBe(false);
    expect(captured.some(entry => entry.sql === 'ROLLBACK')).toBe(true);
  });
});
