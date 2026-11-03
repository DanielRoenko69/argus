import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import pg from 'pg';
import { importOpenApi } from '../importOpenApi.js';
import type { MappedOp } from '../map.js';
import { buildOpenApiCapabilityManifest } from '../manifest.js';

const prefix = `openapi_it_${process.pid}_${Math.random().toString(36).slice(2, 7)}`
  .padEnd(32, 'x').slice(0, 32);
const category = `openapi:${prefix}`;
const backendRef = `custom:${prefix}`;
const targetBundleName = `${prefix}_target`;
const baseUrl = 'https://8.8.8.8/v1';
const connectionString = process.env.POSTGRES_CONNECTION_URL
  ?? 'postgresql://aiops:aiops123@localhost:5432/aiops';
const runIntegration = process.env['RUN_OPENAPI_INTEGRATION'] === '1';
const integrationDescribe = runIntegration ? describe : describe.skip;
let pool: pg.Pool;
const savedEnvironment = {
  MCP_API_KEYS: process.env['MCP_API_KEYS'],
  SESSION_SECRET: process.env['SESSION_SECRET'],
  DB_ENCRYPTION_KEY: process.env['DB_ENCRYPTION_KEY'],
  ARGUS_EGRESS_ALLOWLIST: process.env['ARGUS_EGRESS_ALLOWLIST'],
};

const readOperation: MappedOp = {
  name: `${prefix}__get_item`,
  description: 'Get item',
  queryTemplate: 'GET /items/{{id}}',
  parameters: [{ name: 'id', type: 'string', description: '', required: true }],
  isWrite: false,
  method: 'GET',
  path: '/items/{id}',
  tags: [],
  warnings: [],
  supported: true,
};
const writeOperation: MappedOp = {
  name: `${prefix}__create_item`,
  description: 'Create item',
  queryTemplate: 'POST /items\n\n{{body}}',
  parameters: [{ name: 'body', type: 'string', description: '', required: true }],
  isWrite: true,
  method: 'POST',
  path: '/items',
  tags: [],
  warnings: [],
  supported: true,
};

function manifestFor(manifestOperations: MappedOp[]) {
  return buildOpenApiCapabilityManifest({
    prefix,
    sourceKind: 'text',
    title: 'Integration API',
    openapiVersion: '3.0.3',
    baseUrl,
    baseUrlOverridden: false,
    security: { auth_type: 'none' },
    specDigest: 'a'.repeat(64),
    operations: manifestOperations,
  });
}

async function cleanup() {
  await pool.query('DELETE FROM mcp_tools WHERE category = $1 AND backend = $2', [category, backendRef]);
  await pool.query("DELETE FROM mcp_backends WHERE name = $1 AND description = 'Imported from OpenAPI'", [prefix]);
  await pool.query('DELETE FROM mcp_service_bundles WHERE name = $1 AND description = $2', [prefix, `OpenAPI: ${prefix}`]);
  await pool.query('DELETE FROM mcp_service_bundles WHERE name = $1 AND description = $2', [targetBundleName, 'OpenAPI integration target']);
}

integrationDescribe('importOpenApi — live PostgreSQL governance integration', () => {
  beforeAll(async () => {
    process.env['MCP_API_KEYS'] = 'openapi-integration-test-key';
    process.env['SESSION_SECRET'] = 's'.repeat(32);
    process.env['DB_ENCRYPTION_KEY'] = 'e'.repeat(64);
    process.env['ARGUS_EGRESS_ALLOWLIST'] = '';
    pool = new pg.Pool({ connectionString });
    await cleanup();
  });
  afterAll(async () => {
    try {
      await cleanup();
    } finally {
      await pool.end();
      for (const [name, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('creates effective bundle scope and preserves stable governance across reimports', async () => {
    const targetBundleId = (await pool.query<{ id: number }>(
      `INSERT INTO mcp_service_bundles (name, label, description)
       VALUES ($1,$1,'OpenAPI integration target') RETURNING id`,
      [targetBundleName],
    )).rows[0]!.id;
    const firstManifest = manifestFor([readOperation, writeOperation]);
    const first = await importOpenApi(pool, {
      backendName: prefix,
      namePrefix: prefix,
      baseUrl,
      authType: 'none',
      authValue: null,
      credentialMode: 'clear',
      operations: [readOperation, writeOperation],
      bundleIds: [targetBundleId],
      enabled: true,
      sourceManifest: firstManifest,
      expectedSourceRevision: null,
      expectedSourceManifestDigest: null,
      expectedExistingBundleIds: [],
    });
    expect(first.bundleIds).toEqual([...first.bundleIds].sort((left, right) => left - right));
    expect(first.bundleIds).toEqual(expect.arrayContaining([first.bundleId, targetBundleId]));
    expect(first.bundleIds).toHaveLength(2);

    const initialTools = await pool.query<{
      id: number;
      name: string;
      enabled: boolean;
      risk_level: string;
      required_auth_mode: string | null;
    }>(
      'SELECT id, name, enabled, risk_level, required_auth_mode FROM mcp_tools WHERE category = $1 ORDER BY name',
      [category],
    );
    expect(initialTools.rows).toHaveLength(2);
    expect(initialTools.rows.every(row => row.enabled === true)).toBe(true);
    expect(initialTools.rows.find(row => row.name === writeOperation.name)?.risk_level).toBe('high');
    const initialIds = new Map(initialTools.rows.map(row => [row.name, row.id]));

    const backendScope = await pool.query<{ bundle_id: number }>(
      `SELECT assignment.bundle_id
        FROM mcp_backend_bundles assignment
         JOIN mcp_backends backend ON backend.id = assignment.backend_id
        WHERE backend.name = $1
        ORDER BY assignment.bundle_id`,
      [prefix],
    );
    expect(backendScope.rows.map(row => row.bundle_id)).toEqual(first.bundleIds);
    const toolScope = await pool.query<{ name: string; bundle_id: number }>(
      `SELECT tool.name, assignment.bundle_id
         FROM mcp_tool_bundles assignment
         JOIN mcp_tools tool ON tool.id = assignment.tool_id
        WHERE tool.category = $1
        ORDER BY tool.name, assignment.bundle_id`,
      [category],
    );
    expect(toolScope.rows).toHaveLength(4);
    for (const operation of [readOperation, writeOperation]) {
      expect(toolScope.rows.filter(row => row.name === operation.name).map(row => row.bundle_id))
        .toEqual(first.bundleIds);
    }

    await pool.query(
      `INSERT INTO mcp_bundle_backend_tool_policies (backend_id, bundle_id, mode, allowed_tool_names)
       VALUES ($1,$2,'selected',$3::text[])`,
      [first.backendId, first.bundleId, [readOperation.name]],
    );

    await pool.query(
      `UPDATE mcp_tools
          SET enabled = false, risk_level = 'medium', required_auth_mode = 'strict'
        WHERE name = $1`,
      [writeOperation.name],
    );
    await pool.query("UPDATE mcp_backends SET enabled = false, auth_mode = 'strict' WHERE id = $1", [first.backendId]);
    const secondOperations = [{ ...readOperation, description: 'Updated read' }, { ...writeOperation, description: 'Updated write' }];
    const secondManifest = manifestFor(secondOperations);
    const second = await importOpenApi(pool, {
      backendName: prefix,
      namePrefix: prefix,
      baseUrl,
      authType: 'none',
      authValue: null,
      credentialMode: 'clear',
      operations: secondOperations,
      bundleIds: [targetBundleId],
      enabled: false,
      allowReimport: true,
      sourceManifest: secondManifest,
      expectedSourceRevision: '1',
      expectedSourceManifestDigest: firstManifest.manifestDigest,
      expectedExistingBundleIds: first.bundleIds,
    });
    expect(second.updated).toEqual({ read: 1, write: 1 });

    const reimported = await pool.query<{
      id: number;
      name: string;
      enabled: boolean;
      risk_level: string;
      required_auth_mode: string | null;
    }>('SELECT id, name, enabled, risk_level, required_auth_mode FROM mcp_tools WHERE category = $1', [category]);
    expect(reimported.rows.every(row => row.id === initialIds.get(row.name))).toBe(true);
    const governedWrite = reimported.rows.find(row => row.name === writeOperation.name)!;
    expect(reimported.rows.every(row => row.enabled === false)).toBe(true);
    expect(governedWrite).toMatchObject({ enabled: false, risk_level: 'medium', required_auth_mode: 'strict' });
    expect((await pool.query<{ enabled: boolean; auth_mode: string }>(
      'SELECT enabled, auth_mode FROM mcp_backends WHERE id = $1',
      [first.backendId],
    )).rows).toEqual([{ enabled: false, auth_mode: 'strict' }]);
    const retainedPolicy = await pool.query<{ mode: string; allowed_tool_names: string[] }>(
      `SELECT mode, allowed_tool_names
         FROM mcp_bundle_backend_tool_policies
        WHERE backend_id = $1 AND bundle_id = $2`,
      [first.backendId, first.bundleId],
    );
    expect(retainedPolicy.rows).toEqual([{
      mode: 'selected',
      allowed_tool_names: [readOperation.name],
    }]);

    // Re-enabling an import updates definitions but must not overwrite the
    // staged/manual disabled state established above.
    const thirdManifest = manifestFor([readOperation, writeOperation]);
    await importOpenApi(pool, {
      backendName: prefix,
      namePrefix: prefix,
      baseUrl,
      authType: 'none',
      authValue: null,
      credentialMode: 'clear',
      operations: [readOperation, writeOperation],
      bundleIds: [targetBundleId],
      enabled: true,
      allowReimport: true,
      sourceManifest: thirdManifest,
      expectedSourceRevision: '2',
      expectedSourceManifestDigest: secondManifest.manifestDigest,
      expectedExistingBundleIds: second.bundleIds,
    });
    expect((await pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM mcp_tools WHERE category = $1 ORDER BY name',
      [category],
    )).rows).toEqual([{ enabled: false }, { enabled: false }]);

    await expect(importOpenApi(pool, {
      backendName: prefix,
      namePrefix: prefix,
      baseUrl,
      authType: 'none',
      authValue: null,
      credentialMode: 'clear',
      operations: [readOperation],
      sourceOperationNames: [readOperation.name],
      bundleIds: [targetBundleId],
      allowReimport: true,
      allowRemoval: false,
      sourceManifest: manifestFor([readOperation]),
      expectedSourceRevision: '3',
      expectedSourceManifestDigest: thirdManifest.manifestDigest,
      expectedExistingBundleIds: second.bundleIds,
    })).rejects.toThrow(/explicit confirmation/i);
    expect((await pool.query('SELECT id FROM mcp_tools WHERE category = $1', [category])).rows).toHaveLength(2);

    const confirmedRemoval = await importOpenApi(pool, {
      backendName: prefix,
      namePrefix: prefix,
      baseUrl,
      authType: 'none',
      authValue: null,
      credentialMode: 'clear',
      operations: [writeOperation],
      sourceOperationNames: [writeOperation.name],
      bundleIds: [targetBundleId],
      enabled: false,
      allowReimport: true,
      allowRemoval: true,
      expectedRemovalNames: [readOperation.name],
      expectedRemovalImpacts: [{ name: readOperation.name, workflowCount: 0 }],
      sourceManifest: manifestFor([writeOperation]),
      expectedSourceRevision: '3',
      expectedSourceManifestDigest: thirdManifest.manifestDigest,
      expectedExistingBundleIds: second.bundleIds,
    });
    expect(confirmedRemoval.removed).toEqual([readOperation.name]);
    expect((await pool.query<{ allowed_tool_names: string[] }>(
      `SELECT allowed_tool_names
         FROM mcp_bundle_backend_tool_policies
        WHERE backend_id = $1 AND bundle_id = $2`,
      [first.backendId, first.bundleId],
    )).rows).toEqual([{ allowed_tool_names: [] }]);
  });
});
