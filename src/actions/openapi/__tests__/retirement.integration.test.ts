import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import pg from 'pg';
import { importOpenApi } from '../importOpenApi.js';
import { buildOpenApiCapabilityManifest } from '../manifest.js';
import { previewOpenApiSourceRetirement, retireOpenApiSource } from '../retirement.js';
import { prepareOpenApiStudioPreview } from '../studio.js';

const runIntegration = process.env['RUN_OPENAPI_INTEGRATION'] === '1';
const integrationDescribe = runIntegration ? describe : describe.skip;
const connectionString = process.env['POSTGRES_CONNECTION_URL']
  ?? 'postgresql://aiops:aiops123@localhost:5432/aiops';
const prefix = `retire_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
const category = `openapi:${prefix}`;
const backendRef = `custom:${prefix}`;
const sharedBundleName = `${prefix}_shared`;
const workflowName = `wf_${prefix}`;
const manualToolName = `${prefix}_manual`;
let pool: pg.Pool;

function spec(): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Retirement integration API', version: '1.0.0' },
    servers: [{ url: 'https://8.8.8.8/v1' }],
    paths: {
      '/pets': { get: { operationId: 'getPets', summary: 'List pets' } },
      '/pets/{id}': {
        delete: {
          operationId: 'deletePet',
          summary: 'Delete pet',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
    },
  });
}

async function cleanup(): Promise<void> {
  await pool.query('DELETE FROM mcp_workflows WHERE name = $1', [workflowName]);
  await pool.query('DELETE FROM mcp_tools WHERE name = $1 OR (category = $2 AND backend = $3)', [
    manualToolName,
    category,
    backendRef,
  ]);
  await pool.query("DELETE FROM mcp_backends WHERE name = $1 AND description = 'Imported from OpenAPI'", [prefix]);
  await pool.query('DELETE FROM mcp_service_bundles WHERE name = ANY($1::text[])', [[prefix, sharedBundleName]]);
}

integrationDescribe('OpenAPI source retirement — live PostgreSQL integration', () => {
  beforeAll(async () => {
    process.env['ARGUS_EGRESS_ALLOWLIST'] = '';
    pool = new pg.Pool({ connectionString });
    await cleanup();
    const tables = await pool.query<{ source: string | null; operations: string | null }>(
      `SELECT to_regclass('mcp_capability_sources')::text AS source,
              to_regclass('mcp_capability_source_operations')::text AS operations`,
    );
    if (!tables.rows[0]?.source || !tables.rows[0]?.operations) {
      throw new Error('OpenAPI retirement integration requires migrations 132 and 133');
    }
  });

  afterAll(async () => {
    if (!pool) return;
    try { await cleanup(); }
    finally { await pool.end(); }
  });

  it('removes only source-owned capabilities/backend while preserving bundles, workflows and unrelated tools', async () => {
    const sharedBundleId = (await pool.query<{ id: number }>(
      `INSERT INTO mcp_service_bundles (name, label, description, icon, system_prompt, agent_role)
       VALUES ($1,$1,'Shared retirement boundary','','',NULL)
       RETURNING id`,
      [sharedBundleName],
    )).rows[0]!.id;
    const prepared = await prepareOpenApiStudioPreview(pool, { specText: spec(), namePrefix: prefix });
    const manifest = buildOpenApiCapabilityManifest({
      prefix,
      sourceKind: 'text',
      title: prepared.preview.title,
      openapiVersion: prepared.preview.openapiVersion,
      baseUrl: prepared.preview.baseUrl,
      baseUrlOverridden: false,
      security: prepared.preview.security,
      specDigest: prepared.preview.specDigest,
      operations: prepared.operations,
    });
    const imported = await importOpenApi(pool, {
      backendName: prefix,
      namePrefix: prefix,
      baseUrl: prepared.preview.baseUrl,
      authType: 'none',
      authValue: null,
      credentialMode: 'clear',
      operations: prepared.operations.filter(operation => operation.supported),
      sourceOperationNames: prepared.operations.filter(operation => operation.supported)
        .map(operation => operation.name),
      bundleIds: [sharedBundleId],
      sourceManifest: manifest,
      expectedSourceRevision: null,
      expectedSourceManifestDigest: null,
      expectedExistingBundleIds: [],
    });
    const sourceToolNames = prepared.operations.filter(operation => operation.supported)
      .map(operation => operation.name);
    const manualToolId = (await pool.query<{ id: number }>(
      `INSERT INTO mcp_tools (
         name, description, backend, query_template, parameters, category,
         enabled, tool_type, is_write, risk_level, required_auth_mode
       ) VALUES ($1,'Unrelated manual tool',$2,'GET /manual','[]'::jsonb,'manual',
                 true,'dynamic',false,'low','service-account')
       RETURNING id`,
      [manualToolName, backendRef],
    )).rows[0]!.id;
    await pool.query(
      'INSERT INTO mcp_tool_bundles (tool_id, bundle_id) VALUES ($1,$2)',
      [manualToolId, sharedBundleId],
    );
    const workflowSteps = [
      { id: 'source', label: 'Source capability', tool: sourceToolNames[0], args: {} },
      { id: 'manual', label: 'Manual capability', tool: manualToolName, args: {} },
    ];
    const workflowId = (await pool.query<{ id: number }>(
      `INSERT INTO mcp_workflows (name, description, steps, input_params)
       VALUES ($1,'Retirement impact fixture',$2::jsonb,'[]'::jsonb)
       RETURNING id`,
      [workflowName, JSON.stringify(workflowSteps)],
    )).rows[0]!.id;

    const preview = await previewOpenApiSourceRetirement(pool, imported.sourceId);
    expect(preview.impact.capabilities.map(capability => capability.name).sort())
      .toEqual([...sourceToolNames].sort());
    expect(preview.impact.bundles.map(bundle => bundle.id)).toEqual(expect.arrayContaining([
      imported.bundleId,
      sharedBundleId,
    ]));
    expect(preview.impact.workflows).toEqual([
      expect.objectContaining({ id: workflowId, capabilityNames: [sourceToolNames[0]] }),
    ]);

    const result = await retireOpenApiSource(pool, imported.sourceId, preview.confirmation);
    expect(result.deletedCapabilities.map(capability => capability.name).sort())
      .toEqual([...sourceToolNames].sort());
    expect(result.preservedBundleIds).toEqual(expect.arrayContaining([imported.bundleId, sharedBundleId]));
    expect(result.preservedWorkflowIds).toEqual([workflowId]);

    expect((await pool.query('SELECT id FROM mcp_backends WHERE id = $1', [imported.backendId])).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM mcp_capability_sources WHERE id = $1', [imported.sourceId])).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM mcp_tools WHERE name = ANY($1::text[])', [sourceToolNames])).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM mcp_tools WHERE id = $1', [manualToolId])).rows).toEqual([{ id: manualToolId }]);
    expect((await pool.query('SELECT id FROM mcp_service_bundles WHERE id = ANY($1::int[]) ORDER BY id', [
      [imported.bundleId, sharedBundleId],
    ])).rows).toHaveLength(2);
    expect((await pool.query<{ steps: unknown }>('SELECT steps FROM mcp_workflows WHERE id = $1', [workflowId])).rows)
      .toEqual([{ steps: workflowSteps }]);
  });
});
