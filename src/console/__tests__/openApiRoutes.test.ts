import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import type { MappedOp } from '../../actions/openapi/map.js';
import type { PreparedOpenApiStudioPreview } from '../../actions/openapi/studio.js';

jest.mock('../../actions/openapi/studio.js', () => ({
  prepareOpenApiStudioPreview: jest.fn(),
}));
jest.mock('../../actions/openapi/importOpenApi.js', () => ({
  importOpenApi: jest.fn(),
}));
jest.mock('../../lib/adminAudit.js', () => ({
  writeAdminAudit: jest.fn(),
}));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class {
    async isAllowed() { return true; }
    cleanup() { /* no-op */ }
  },
}));
jest.mock('../../lib/logger.js', () => ({
  logger: {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  },
}));

import { prepareOpenApiStudioPreview } from '../../actions/openapi/studio.js';
import { importOpenApi } from '../../actions/openapi/importOpenApi.js';
import { logger } from '../../lib/logger.js';
import { registerConsoleApi } from '../consoleApi.js';

const mockPrepare = prepareOpenApiStudioPreview as jest.MockedFunction<typeof prepareOpenApiStudioPreview>;
const mockImport = importOpenApi as jest.MockedFunction<typeof importOpenApi>;

const adminUser: SessionUser = {
  id: 7,
  username: 'platform-admin',
  display_name: 'Platform Admin',
  role: 'platform_admin',
  allowed_bundles: null,
  entra_groups: [],
};

function mappedOperation(method: MappedOp['method'] = 'GET', path = '/pets'): MappedOp {
  return {
    name: `pets__${method.toLowerCase()}pets`,
    description: `${method} pets`,
    queryTemplate: `${method} ${path}`,
    parameters: [],
    isWrite: method !== 'GET',
    method,
    path,
    tags: ['pets'],
    warnings: [],
    supported: true,
  };
}

function preparedPreview(operations: MappedOp[] = [mappedOperation()]): PreparedOpenApiStudioPreview {
  const previewOperations = operations.map(operation => ({
    key: `${operation.method} ${operation.path}`,
    name: operation.name,
    method: operation.method,
    path: operation.path,
    description: operation.description,
    parameterCount: operation.parameters.length,
    parameters: operation.parameters,
    tags: operation.tags,
    isWrite: operation.isWrite,
    riskLevel: operation.isWrite ? 'high' as const : 'low' as const,
    supported: operation.supported,
    warnings: operation.warnings,
    change: 'create' as const,
    collisionReason: null,
  }));
  return {
    operations,
    preview: {
      previewDigest: 'preview-digest',
      specDigest: 'spec-digest',
      title: 'Pets API',
      openapiVersion: '3.0.3',
      sourceKind: 'text',
      prefix: 'pets',
      baseUrl: 'https://api.example.test/v1',
      security: { auth_type: 'none' },
      existing: {
        backendId: null,
        backendOwned: true,
        authType: null,
        hasCredential: false,
        credentialReusable: false,
        importedToolCount: 0,
        assignedBundleIds: [],
        sourceRevision: null,
        sourceManifestDigest: null,
        defaultBundleId: null,
        defaultBundleOwned: true,
      },
      operations: previewOperations,
      removals: [],
      counts: {
        total: previewOperations.length,
        supported: previewOperations.filter(operation => operation.supported).length,
        read: previewOperations.filter(operation => !operation.isWrite).length,
        write: previewOperations.filter(operation => operation.isWrite).length,
        create: previewOperations.length,
        update: 0,
        collisions: 0,
        unsupported: 0,
        removals: 0,
      },
      warnings: [],
    },
  };
}

function validMutation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specText: '{"openapi":"3.0.3","paths":{}}',
    previewDigest: 'preview-digest',
    selectedOperationKeys: ['GET /pets'],
    bundleIds: [],
    createDefaultBundle: true,
    enabled: false,
    confirmWrites: false,
    confirmReimport: false,
    confirmRemovals: false,
    acknowledgeUnsupportedAuth: false,
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;

async function postImport(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/ui/mcp-fabric/capabilities/openapi/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function postPreview(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/ui/mcp-fabric/capabilities/openapi/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = adminUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, _res, next) => next();
  const dependencies = {
    pool: {} as pg.Pool,
    requireAuth,
    requireSameOrigin,
    loadStatus: jest.fn(async () => ({})),
    listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined),
  } as unknown as Parameters<typeof registerConsoleApi>[1];
  registerConsoleApi(app, dependencies);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrepare.mockResolvedValue(preparedPreview());
  mockImport.mockResolvedValue({
    backendId: 10,
    bundleId: 20,
    bundleIds: [20],
    created: { read: 1, write: 0 },
    inserted: { read: 1, write: 0 },
    updated: { read: 0, write: 0 },
    removed: [],
    skipped: [],
    sourceId: 30,
  });
});

describe('native OpenAPI import route validation', () => {
  it('never returns or logs raw parse diagnostics from an untrusted specification', async () => {
    const secret = 'super-secret-api-key';
    mockPrepare.mockRejectedValueOnce(Object.assign(
      new Error(`yaml mark leaked: ${secret}`),
      { code: 'openapi_parse_failed' },
    ));

    const response = await postPreview({ specText: `openapi: 3.0.3\nsecret: ${secret}\npaths: [` });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(secret);
    expect(logger.warn).toHaveBeenCalledWith(
      { status: 400, code: 'invalid_spec' },
      'OpenAPI Studio preview failed',
    );
  });

  it('rejects a stale preview digest before importing', async () => {
    const response = await postImport(validMutation({ previewDigest: 'stale' }));
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/veraltet/i);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', ['GET /unknown']],
    ['duplicate', ['GET /pets', 'GET /pets']],
    ['oversized', [`GET /${'x'.repeat(2_100)}`]],
  ])('rejects an %s operation selection', async (_label, selectedOperationKeys) => {
    const response = await postImport(validMutation({ selectedOperationKeys }));
    expect(response.status).toBe(400);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it.each(['collision', 'unsupported'] as const)('rejects a %s preview operation', async change => {
    const prepared = preparedPreview();
    prepared.preview.operations[0]!.change = change;
    if (change === 'unsupported') prepared.preview.operations[0]!.supported = false;
    mockPrepare.mockResolvedValue(prepared);

    const response = await postImport(validMutation());
    expect(response.status).toBe(400);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('requires explicit write, reimport and removal confirmations', async () => {
    const writePrepared = preparedPreview([mappedOperation('POST')]);
    mockPrepare.mockResolvedValueOnce(writePrepared);
    const writeResponse = await postImport(validMutation({ selectedOperationKeys: ['POST /pets'] }));
    expect(writeResponse.status).toBe(400);
    expect(writeResponse.body.error).toMatch(/Schreibende/i);

    const reimportPrepared = preparedPreview();
    reimportPrepared.preview.existing.importedToolCount = 1;
    mockPrepare.mockResolvedValueOnce(reimportPrepared);
    const reimportResponse = await postImport(validMutation());
    expect(reimportResponse.status).toBe(409);
    expect(reimportResponse.body.error).toMatch(/Reimport/i);

    const removalPrepared = preparedPreview();
    removalPrepared.preview.removals = [{ name: 'pets__removed', workflowCount: 2 }];
    removalPrepared.preview.counts.removals = 1;
    mockPrepare.mockResolvedValueOnce(removalPrepared);
    const removalResponse = await postImport(validMutation());
    expect(removalResponse.status).toBe(409);
    expect(removalResponse.body.error).toMatch(/Entfernte Source-Operations/i);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it.each([
    ['missing array', undefined],
    ['string element', ['7']],
    ['boolean element', [true]],
    ['object body', { id: 7 }],
    ['out-of-range integer', [2_147_483_648]],
    ['more than 500 entries', Array.from({ length: 501 }, () => 1)],
  ])('rejects a malformed bundle selection: %s', async (_label, bundleIds) => {
    const mutation = validMutation();
    if (bundleIds === undefined) delete mutation.bundleIds;
    else mutation.bundleIds = bundleIds;
    const response = await postImport(mutation);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Bundle-Auswahl/i);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('requires either an importer-owned default bundle or an explicit bundle boundary', async () => {
    const missingBoundary = await postImport(validMutation({
      createDefaultBundle: false,
      bundleIds: [],
    }));
    expect(missingBoundary.status).toBe(400);

    const prepared = preparedPreview();
    prepared.preview.existing.defaultBundleOwned = false;
    mockPrepare.mockResolvedValueOnce(prepared);
    const foreignDefault = await postImport(validMutation({ createDefaultBundle: true }));
    expect(foreignDefault.status).toBe(409);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('allows unsupported authentication only acknowledged and staged', async () => {
    const unsupported = preparedPreview();
    unsupported.preview.security = { auth_type: 'none', note: 'OAuth2 requires manual setup' };
    mockPrepare.mockResolvedValue(unsupported);

    const unacknowledged = await postImport(validMutation());
    expect(unacknowledged.status).toBe(400);
    expect(unacknowledged.body.error).toMatch(/bestätigt/i);

    const active = await postImport(validMutation({
      acknowledgeUnsupportedAuth: true,
      enabled: true,
    }));
    expect(active.status).toBe(400);
    expect(active.body.error).toMatch(/deaktiviert importiert/i);

    const staged = await postImport(validMutation({ acknowledgeUnsupportedAuth: true }));
    expect(staged.status).toBe(201);
    expect(mockImport).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      enabled: false,
      credentialMode: 'clear',
    }));
  });

  it.each([
    ['bearer whitespace', { auth_type: 'bearer' as const }, { credential: '   ' }],
    ['bearer newline', { auth_type: 'bearer' as const }, { credential: 'token\nX-Injected: yes' }],
    ['header control', { auth_type: 'header' as const, headerName: 'X-API-Key' }, { credential: 'key\u0000tail' }],
    ['basic colon', { auth_type: 'basic' as const }, { basicUser: 'ops:admin', basicPassword: 'secret' }],
    ['basic password control', { auth_type: 'basic' as const }, { basicUser: 'ops', basicPassword: 'secret\r' }],
    ['non-text credential', { auth_type: 'bearer' as const }, { credential: 42 }],
  ])('rejects malformed credentials: %s', async (_label, security, credentials) => {
    const prepared = preparedPreview();
    prepared.preview.security = security;
    mockPrepare.mockResolvedValue(prepared);

    const response = await postImport(validMutation(credentials));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Credential|Benutzernamen|Steuerzeichen/i);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('passes the exact preview removal set and a fail-closed removal flag to the transaction', async () => {
    const noRemoval = await postImport(validMutation());
    expect(noRemoval.status).toBe(201);
    expect(mockImport).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      allowReimport: false,
      allowRemoval: false,
      expectedRemovalNames: [],
    }));

    const prepared = preparedPreview();
    prepared.preview.existing.importedToolCount = 1;
    prepared.preview.removals = [
      { name: 'pets__old_search', workflowCount: 0 },
      { name: 'pets__old_write', workflowCount: 1 },
    ];
    prepared.preview.counts.removals = 2;
    mockPrepare.mockResolvedValueOnce(prepared);
    const confirmed = await postImport(validMutation({
      confirmReimport: true,
      confirmRemovals: true,
    }));

    expect(confirmed.status).toBe(201);
    expect(mockImport).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      allowReimport: true,
      allowRemoval: true,
      expectedRemovalNames: ['pets__old_search', 'pets__old_write'],
      expectedRemovalImpacts: prepared.preview.removals,
    }));
  });

  it.each([
    'OpenAPI capability removals changed after preview; review and confirm the new diff',
    "Capability name 'pets__getpets' became owned by another source during import",
    'OpenAPI import state changed after preview; reimport requires explicit confirmation',
    'The OpenAPI credential no longer exists; provide a new credential and preview again',
  ])('reports transactional state drift as HTTP 409: %s', async message => {
    mockImport.mockRejectedValueOnce(new Error(message));
    const response = await postImport(validMutation());
    expect(response.status).toBe(409);
    expect(response.body.error).toBe(message);
  });

  it('does not expose database error details to the client', async () => {
    mockImport.mockRejectedValueOnce(Object.assign(
      new Error('relation internal_secret_table does not exist'),
      { code: '42P01' },
    ));
    const response = await postImport(validMutation());
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('OpenAPI-Import fehlgeschlagen');
  });

  it('preserves an existing same-scheme credential without accepting one from the client', async () => {
    const prepared = preparedPreview();
    prepared.preview.security = { auth_type: 'bearer' };
    prepared.preview.existing = {
      ...prepared.preview.existing,
      backendId: 10,
      authType: 'bearer',
      hasCredential: true,
      credentialReusable: true,
      importedToolCount: 1,
    };
    mockPrepare.mockResolvedValue(prepared);

    const response = await postImport(validMutation({
      enabled: true,
      confirmReimport: true,
    }));
    expect(response.status).toBe(201);
    expect(mockImport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      authValue: null,
      credentialMode: 'preserve',
      allowReimport: true,
    }));
  });
});
