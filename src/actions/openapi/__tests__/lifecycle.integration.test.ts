import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import pg from 'pg';
import { importOpenApi } from '../importOpenApi.js';
import { checkCapabilitySource, listCapabilitySources } from '../lifecycle.js';
import { buildOpenApiCapabilityManifest } from '../manifest.js';
import { prepareOpenApiStudioPreview } from '../studio.js';

const runIntegration = process.env['RUN_OPENAPI_INTEGRATION'] === '1';
const integrationDescribe = runIntegration ? describe : describe.skip;
const connectionString = process.env.POSTGRES_CONNECTION_URL
  ?? 'postgresql://aiops:aiops123@localhost:5432/aiops';
const prefix = `drift_it_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
const category = `openapi:${prefix}`;
const backendRef = `custom:${prefix}`;
let pool: pg.Pool;

function spec(options: { changed?: boolean } = {}): string {
  const changed = options.changed === true;
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Lifecycle integration API', version: changed ? '2.0.0' : '1.0.0' },
    servers: [{ url: changed ? 'https://8.8.8.8/v2' : 'https://8.8.8.8/v1' }],
    ...(changed ? {
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    } : {}),
    paths: changed ? {
      '/pets': {
        get: { operationId: 'getPets', summary: 'List pets with changed semantics' },
        post: { operationId: 'createPet', summary: 'Create pet' },
      },
    } : {
      '/pets': { get: { operationId: 'getPets', summary: 'List pets' } },
      '/pets/{id}': {
        delete: {
          operationId: 'deletePet', summary: 'Delete pet',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
    },
  });
}

async function cleanup(): Promise<void> {
  await pool.query('DELETE FROM mcp_tools WHERE category = $1 AND backend = $2', [category, backendRef]);
  await pool.query("DELETE FROM mcp_backends WHERE name = $1 AND description = 'Imported from OpenAPI'", [prefix]);
  await pool.query('DELETE FROM mcp_service_bundles WHERE name = $1 AND description = $2', [prefix, `OpenAPI: ${prefix}`]);
}

integrationDescribe('OpenAPI lifecycle — live PostgreSQL integration', () => {
  beforeAll(async () => {
    process.env['ARGUS_EGRESS_ALLOWLIST'] = '';
    pool = new pg.Pool({ connectionString });
    await cleanup();
    const tables = await pool.query<{ source: string | null; operations: string | null }>(
      `SELECT to_regclass('mcp_capability_sources')::text AS source,
              to_regclass('mcp_capability_source_operations')::text AS operations`,
    );
    if (!tables.rows[0]?.source || !tables.rows[0]?.operations) {
      throw new Error('OpenAPI lifecycle integration requires migrations 132 and 133');
    }
  });

  afterAll(async () => {
    if (!pool) return;
    try { await cleanup(); }
    finally { await pool.end(); }
  });

  it('detects canonical drift without applying it to materialized capabilities', async () => {
    const initialText = spec();
    const prepared = await prepareOpenApiStudioPreview(pool, { specText: initialText, namePrefix: prefix });
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
    await importOpenApi(pool, {
      backendName: prefix,
      namePrefix: prefix,
      baseUrl: prepared.preview.baseUrl,
      authType: 'none',
      authValue: null,
      credentialMode: 'clear',
      operations: prepared.operations.filter(operation => operation.supported),
      sourceOperationNames: prepared.operations.filter(operation => operation.supported).map(operation => operation.name),
      sourceManifest: manifest,
      expectedSourceRevision: null,
      expectedSourceManifestDigest: null,
      expectedExistingBundleIds: [],
    });

    const listed = await listCapabilitySources(pool);
    const source = listed.sources.find(candidate => candidate.prefix === prefix)!;
    expect(source).toEqual(expect.objectContaining({ status: 'current' }));

    const reformatted = JSON.stringify(JSON.parse(initialText), null, 2);
    const current = await checkCapabilitySource(pool, String(source.id), { specText: reformatted });
    expect(current.status).toBe('current');
    expect(current.observed.specDigest).not.toBe(current.baseline.specDigest);

    const beforeTools = (await pool.query(
      'SELECT id, name, description, query_template, is_write FROM mcp_tools WHERE category = $1 ORDER BY name',
      [category],
    )).rows;
    const drifted = await checkCapabilitySource(pool, String(source.id), { specText: spec({ changed: true }) });
    expect(drifted.status).toBe('drifted');
    expect(drifted.diff.summary).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      authChanged: true,
      baseUrlChanged: true,
    });
    expect(drifted.diff.removed[0]?.workflowCount).toBe(0);

    const afterTools = (await pool.query(
      'SELECT id, name, description, query_template, is_write FROM mcp_tools WHERE category = $1 ORDER BY name',
      [category],
    )).rows;
    expect(afterTools).toEqual(beforeTools);
    expect((await pool.query(
      'SELECT lifecycle_status, revision::text, manifest_digest FROM mcp_capability_sources WHERE id = $1',
      [source.id],
    )).rows).toEqual([{
      lifecycle_status: 'drifted',
      revision: '1',
      manifest_digest: manifest.manifestDigest,
    }]);
  });
});
