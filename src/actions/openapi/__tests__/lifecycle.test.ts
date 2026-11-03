import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { MappedOp, MappedSecurity } from '../map.js';
import type { PreparedOpenApiStudioPreview } from '../studio.js';

jest.mock('../studio.js', () => ({ prepareOpenApiStudioPreview: jest.fn() }));

import { prepareOpenApiStudioPreview } from '../studio.js';
import { buildOpenApiCapabilityManifest, openApiOperationSignature } from '../manifest.js';
import {
  checkCapabilitySource,
  listCapabilitySources,
} from '../lifecycle.js';

const mockPrepare = prepareOpenApiStudioPreview as jest.MockedFunction<typeof prepareOpenApiStudioPreview>;

const getPet: MappedOp = {
  name: 'pets__getpet',
  description: 'Get pet',
  queryTemplate: 'GET /pets/{{id}}',
  parameters: [{ name: 'id', type: 'string', description: '', required: true }],
  isWrite: false,
  method: 'GET',
  path: '/pets/{id}',
  tags: ['pets'],
  warnings: [],
  supported: true,
};
const removePet: MappedOp = {
  name: 'pets__deletepet',
  description: 'Delete pet',
  queryTemplate: 'DELETE /pets/{{id}}',
  parameters: [{ name: 'id', type: 'string', description: '', required: true }],
  isWrite: true,
  method: 'DELETE',
  path: '/pets/{id}',
  tags: ['pets'],
  warnings: [],
  supported: true,
};

function manifest(
  operations: MappedOp[] = [getPet, removePet],
  options: { baseUrl?: string; security?: MappedSecurity; specDigest?: string } = {},
) {
  return buildOpenApiCapabilityManifest({
    prefix: 'pets',
    sourceKind: 'text',
    title: 'Pets',
    openapiVersion: '3.0.3',
    baseUrl: options.baseUrl ?? 'https://api.example.test/v1',
    baseUrlOverridden: false,
    security: options.security ?? { auth_type: 'none' },
    specDigest: options.specDigest ?? 'a'.repeat(64),
    operations,
  });
}

const baseline = manifest();

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 4,
    backend_id: 9,
    backend_name: 'pets',
    backend_enabled: true,
    name_prefix: 'pets',
    source_kind: 'text',
    source_url: null,
    title: 'Pets',
    openapi_version: '3.0.3',
    base_url: baseline.baseUrl,
    base_url_override: null,
    auth_scheme: baseline.auth,
    auth_signature: baseline.authSignature,
    spec_digest: baseline.specDigest,
    manifest_digest: baseline.manifestDigest,
    operation_count: baseline.operations.length,
    revision: '2',
    lifecycle_status: 'current',
    last_checked_at: null,
    last_observed_spec_digest: null,
    last_observed_manifest_digest: null,
    last_check_summary: null,
    last_check_error_code: null,
    imported_at: '2026-07-30T10:00:00.000Z',
    ...overrides,
  };
}

function storedOperations() {
  return [
    {
      operation_key: 'GET /pets/{id}', tool_name: getPet.name, method: 'GET', path: getPet.path,
      is_write: false, supported: true, signature: openApiOperationSignature(getPet), workflow_count: 2,
    },
    {
      operation_key: 'DELETE /pets/{id}', tool_name: removePet.name, method: 'DELETE', path: removePet.path,
      is_write: true, supported: true, signature: openApiOperationSignature(removePet), workflow_count: 3,
    },
  ];
}

function prepared(
  operations: MappedOp[],
  options: { baseUrl?: string; security?: MappedSecurity; specDigest?: string } = {},
): PreparedOpenApiStudioPreview {
  const security = options.security ?? { auth_type: 'none' };
  return {
    operations,
    preview: {
      previewDigest: 'preview',
      specDigest: options.specDigest ?? 'b'.repeat(64),
      title: 'Pets',
      openapiVersion: '3.0.3',
      sourceKind: 'text',
      prefix: 'pets',
      baseUrl: options.baseUrl ?? baseline.baseUrl,
      security,
      existing: {
        backendId: 9, backendOwned: true, authType: security.auth_type,
        hasCredential: false, credentialReusable: false, importedToolCount: 2,
        assignedBundleIds: [1], sourceRevision: '2', sourceManifestDigest: baseline.manifestDigest,
        defaultBundleId: 1, defaultBundleOwned: true,
      },
      operations: [],
      removals: [],
      counts: { total: operations.length, supported: operations.length, read: 1, write: 1, create: 0, update: operations.length, collisions: 0, unsupported: 0, removals: 0 },
      warnings: [],
    },
  };
}

function checkPool(options: {
  source?: ReturnType<typeof source>;
  refreshedSource?: ReturnType<typeof source>;
  operations?: ReturnType<typeof storedOperations>;
  lock?: boolean;
  updateRowCount?: number;
} = {}) {
  const sourceRow = options.source ?? source();
  const operationRows = options.operations ?? storedOperations();
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  let sourceLoads = 0;
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (sql.includes('FROM mcp_capability_sources source')) {
        const row = sourceLoads++ > 0 && options.refreshedSource ? options.refreshedSource : sourceRow;
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: options.lock !== false }] };
      if (sql.includes('FROM mcp_capability_source_operations')) return { rows: operationRows };
      if (sql.includes('UPDATE mcp_capability_sources')) return { rows: [], rowCount: options.updateRowCount ?? 1 };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn(),
  } as unknown as pg.Pool;
  return { pool, client, captured };
}

describe('OpenAPI capability source lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepare.mockResolvedValue(prepared([getPet, removePet]));
  });

  it('treats a whitespace-only spec digest change as current when the canonical manifest is unchanged', async () => {
    const { pool, captured } = checkPool();
    const result = await checkCapabilitySource(pool, '4', { specText: '{  "openapi": "3.0.3" }' });
    expect(result.status).toBe('current');
    expect(result.baseline.specDigest).not.toBe(result.observed.specDigest);
    expect(result.diff.summary).toEqual({ added: 0, changed: 0, removed: 0, authChanged: false, baseUrlChanged: false });
    expect(captured.some(entry => entry.sql.includes('revision = $8::bigint'))).toBe(true);
  });

  it('returns structured add/change/remove, auth/base-url drift and workflow impact', async () => {
    const changedGet = { ...getPet, description: 'Changed description' };
    const added: MappedOp = {
      ...getPet,
      name: 'pets__listpets',
      description: 'List pets',
      queryTemplate: 'GET /pets',
      path: '/pets',
      parameters: [],
    };
    mockPrepare.mockResolvedValue(prepared([changedGet, added], {
      baseUrl: 'https://api.example.test/v2',
      security: { auth_type: 'bearer' },
    }));
    const { pool } = checkPool();
    const result = await checkCapabilitySource(pool, '4', { specText: 'changed spec' });
    expect(result.status).toBe('drifted');
    expect(result.diff.summary).toEqual({ added: 1, changed: 1, removed: 1, authChanged: true, baseUrlChanged: true });
    expect(result.diff.changed[0]?.changes).toContain('implementation');
    expect(result.diff.removed[0]).toEqual(expect.objectContaining({ name: removePet.name, workflowCount: 3 }));
    expect(result.diff.auth).toEqual({
      changed: true,
      before: { type: 'none', headerName: null },
      after: { type: 'bearer', headerName: null },
    });
  });

  it('lists legacy backfills as unchecked and not checkable without invented digests', async () => {
    const legacy = source({
      auth_scheme: null, auth_signature: null, spec_digest: null, manifest_digest: null,
      operation_count: 0, lifecycle_status: 'unchecked', revision: '1',
    });
    const pool = { query: jest.fn(async () => ({ rows: [legacy] })) } as unknown as pg.Pool;
    const result = await listCapabilitySources(pool);
    expect(result.sources[0]).toEqual(expect.objectContaining({
      status: 'unchecked',
      source: { kind: 'text', url: null, canCheck: false, baseUrlOverride: null },
      baseline: { specDigest: null, manifestDigest: null, operationCount: 0 },
    }));
  });

  it('returns 409 for a legacy baseline before parsing or locking', async () => {
    const { pool, captured } = checkPool({
      source: source({ auth_scheme: null, auth_signature: null, spec_digest: null, manifest_digest: null, revision: '1' }),
    });
    await expect(checkCapabilitySource(pool, '4', { specText: 'spec' }))
      .rejects.toMatchObject({ status: 409, code: 'baseline_required' });
    expect(captured.some(entry => entry.sql.includes('pg_try_advisory_lock'))).toBe(false);
  });

  it('refetches URL sources server-side, rejects pasted payloads and preserves a pinned base URL', async () => {
    const urlSource = source({
      source_kind: 'url', source_url: 'https://spec.example.test/openapi.json',
      base_url_override: baseline.baseUrl,
    });
    const invalidPool = checkPool({ source: urlSource });
    await expect(checkCapabilitySource(invalidPool.pool, '4', { specText: 'not allowed' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(invalidPool.captured.some(entry => entry.sql.includes('UPDATE mcp_capability_sources'))).toBe(false);

    const validPool = checkPool({ source: urlSource });
    await checkCapabilitySource(validPool.pool, '4', {});
    expect(mockPrepare).toHaveBeenLastCalledWith(validPool.client as unknown as pg.PoolClient, {
      specUrl: 'https://spec.example.test/openapi.json',
      namePrefix: 'pets',
      baseUrl: baseline.baseUrl,
    });
  });

  it('revalidates the request body when source semantics change under the importer lock', async () => {
    const initialUrl = source({
      source_kind: 'url', source_url: 'https://spec.example.test/openapi.json',
    });
    const refreshedText = source({
      source_kind: 'text', source_url: null, revision: '3',
    });
    const { pool, captured } = checkPool({ source: initialUrl, refreshedSource: refreshedText });

    await expect(checkCapabilitySource(pool, '4', {}))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(captured.some(entry => entry.sql.includes('FROM mcp_capability_source_operations'))).toBe(false);
  });

  it('fails CAS when baseline revision changes and does not overwrite lifecycle status', async () => {
    const { pool, captured } = checkPool({ updateRowCount: 0 });
    await expect(checkCapabilitySource(pool, '4', { specText: 'spec' }))
      .rejects.toMatchObject({ status: 409, code: 'baseline_changed' });
    expect(captured.filter(entry => entry.sql.includes('UPDATE mcp_capability_sources'))).toHaveLength(1);
  });

  it('does not persist pasted-spec errors or internal DB failures, but persists safe URL-source error codes', async () => {
    mockPrepare.mockRejectedValueOnce(new Error('Failed to parse OpenAPI specification'));
    const invalid = checkPool();
    await expect(checkCapabilitySource(invalid.pool, '4', { specText: 'bad' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_spec' });
    expect(invalid.captured.some(entry => entry.sql.includes("lifecycle_status = 'error'"))).toBe(false);

    mockPrepare.mockRejectedValueOnce(new Error('Failed to parse OpenAPI specification'));
    const remoteInvalid = checkPool({ source: source({
      source_kind: 'url', source_url: 'https://spec.example.test/openapi.json',
    }) });
    await expect(checkCapabilitySource(remoteInvalid.pool, '4', {}))
      .rejects.toMatchObject({ status: 400, code: 'invalid_spec' });
    expect(remoteInvalid.captured.some(entry => entry.sql.includes("lifecycle_status = 'error'")
      && entry.params.includes('invalid_spec'))).toBe(true);

    mockPrepare.mockRejectedValueOnce(Object.assign(
      new Error('The operation was aborted due to timeout'),
      { name: 'TimeoutError', code: 23 },
    ));
    const timeout = checkPool({ source: source({
      source_kind: 'url', source_url: 'https://spec.example.test/openapi.json',
    }) });
    await expect(checkCapabilitySource(timeout.pool, '4', {}))
      .rejects.toMatchObject({ status: 502, code: 'source_fetch_failed' });
    expect(timeout.captured.some(entry => entry.sql.includes("lifecycle_status = 'error'")
      && entry.params.includes('source_fetch_failed'))).toBe(true);

    const dbError = Object.assign(new Error('connection terminated'), { code: '57P01' });
    mockPrepare.mockRejectedValueOnce(dbError);
    const internal = checkPool();
    await expect(checkCapabilitySource(internal.pool, '4', { specText: 'valid' })).rejects.toBe(dbError);
    expect(internal.captured.some(entry => entry.sql.includes("lifecycle_status = 'error'"))).toBe(false);
  });
});
