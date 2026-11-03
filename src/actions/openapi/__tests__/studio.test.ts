import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { MAX_OPENAPI_SPEC_BYTES } from '../parse.js';
import {
  MAX_OPENAPI_OPERATIONS,
  normalizeOpenApiPrefix,
  prepareOpenApiStudioPreview,
  resolveOpenApiSpecText,
} from '../studio.js';

jest.mock('../../../backends/customBackends.js', () => ({
  assertSsrfSafeResolved: jest.fn(async () => undefined),
  assertEgressAllowed: jest.fn(() => undefined),
}));

interface PreviewPoolState {
  tools?: Array<{
    id: number;
    name: string;
    category: string | null;
    backend: string;
    workflow_count: number;
  }>;
  backends?: Array<{
    id: number;
    description: string;
    backend_type: string;
    managed_by: string | null;
    auth_type?: string;
    auth_value?: string | null;
    has_credential?: boolean;
    source_revision?: string | null;
    source_manifest_digest?: string | null;
    source_auth_scheme?: unknown;
    bundle_ids: number[];
  }>;
  bundles?: Array<{ id: number; description: string }>;
}

function mockPreviewPool(state: PreviewPoolState = {}) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM mcp_tools tool')) return { rows: state.tools ?? [] };
    if (sql.includes('FROM mcp_backends backend')) return { rows: state.backends ?? [] };
    if (sql.includes('FROM mcp_service_bundles')) return { rows: state.bundles ?? [] };
    throw new Error(`Unexpected preview query: ${sql}`);
  });
  return { pool: { query } as unknown as pg.Pool, query };
}

function specText(paths: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Pets API', version: '2026.1' },
    servers: [{ url: 'https://api.example.test/v1/' }],
    paths,
    ...overrides,
  });
}

const simplePaths = {
  '/pets': {
    get: { operationId: 'listPets', summary: 'List pets' },
  },
};

function fetchReturning(response: Response): typeof fetch {
  return jest.fn(async () => response) as unknown as typeof fetch;
}

describe('normalizeOpenApiPrefix', () => {
  it('normalizes punctuation, numeric starts, fallback titles and maximum length', () => {
    expect(normalizeOpenApiPrefix(' 123 My.API--- ')).toBe('api_123_my_api');
    expect(normalizeOpenApiPrefix(undefined, 'Payments API')).toBe('payments_api');
    expect(normalizeOpenApiPrefix('___')).toBe('api');

    const longPrefix = normalizeOpenApiPrefix('This Prefix Is Far Too Long To Fit In Thirty Two Characters');
    expect(longPrefix).toHaveLength(32);
    expect(longPrefix).toMatch(/^[a-z][a-z0-9_-]*[a-z0-9]$/);
  });
});

describe('resolveOpenApiSpecText', () => {
  it('requires exactly one non-empty source', async () => {
    await expect(resolveOpenApiSpecText({})).rejects.toThrow(/exactly one OpenAPI source/i);
    await expect(resolveOpenApiSpecText({
      specText: specText(simplePaths),
      specUrl: 'https://specs.example.test/openapi.json',
    })).rejects.toThrow(/exactly one OpenAPI source/i);
  });

  it.each([
    'file:///tmp/openapi.json',
    'ftp://specs.example.test/openapi.json',
    'https://user:secret@specs.example.test/openapi.json',
  ])('rejects a non-http(s) URL or embedded userinfo: %s', async invalidUrl => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    await expect(resolveOpenApiSpecText({ specUrl: invalidUrl }, fetchImpl))
      .rejects.toThrow(/must use http\(s\).*embedded credentials/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects redirects instead of following them', async () => {
    const fetchImpl = fetchReturning(new Response(null, {
      status: 302,
      headers: { location: 'https://cdn.example.test/openapi.json' },
    }));

    await expect(resolveOpenApiSpecText({
      specUrl: 'https://specs.example.test/openapi.json',
    }, fetchImpl)).rejects.toThrow(/returned a redirect/i);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://specs.example.test/openapi.json',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects an oversized declared Content-Length before reading the body', async () => {
    const fetchImpl = fetchReturning(new Response('small body', {
      status: 200,
      headers: { 'content-length': String(MAX_OPENAPI_SPEC_BYTES + 1) },
    }));

    await expect(resolveOpenApiSpecText({
      specUrl: 'https://specs.example.test/openapi.json',
    }, fetchImpl)).rejects.toThrow(/exceeds the 2 MB limit/i);
  });

  it('enforces the size limit while streaming when Content-Length is absent', async () => {
    const cancelSpy = jest.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_OPENAPI_SPEC_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelSpy();
      },
    });
    const fetchImpl = fetchReturning(new Response(stream, { status: 200 }));

    await expect(resolveOpenApiSpecText({
      specUrl: 'https://specs.example.test/openapi.json',
    }, fetchImpl)).rejects.toThrow(/exceeds the 2 MB limit/i);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});

describe('prepareOpenApiStudioPreview', () => {
  it('reports operation metadata, all change types, removals and existing ownership', async () => {
    const paths = {
      '/pets/{pet-id}': {
        parameters: [{
          name: 'pet-id', in: 'path', required: true,
          description: 'Pet identifier', schema: { type: 'string' },
        }],
        get: {
          operationId: 'getPet',
          summary: 'Get one pet',
          tags: ['pets'],
          parameters: [{
            name: 'include', in: 'query', required: false,
            description: 'Related data', schema: { type: 'string' },
          }],
        },
      },
      '/pets': {
        post: { operationId: 'createPet', summary: 'Create a pet', tags: ['pets', 'write'] },
      },
      '/health': {
        get: { operationId: 'health', summary: 'Check service health', tags: ['ops'] },
      },
      '/unsafe path': {
        get: { operationId: 'unsafePath', summary: 'Unsafe path' },
      },
    };
    const { pool } = mockPreviewPool({
      tools: [
        { id: 1, name: 'pets__getpet', category: 'openapi:pets', backend: 'custom:pets', workflow_count: 0 },
        { id: 2, name: 'pets__createpet', category: 'manual', backend: 'custom:other', workflow_count: 0 },
        { id: 3, name: 'pets__removed', category: 'openapi:pets', backend: 'custom:pets', workflow_count: 2 },
      ],
      backends: [{
        id: 10,
        description: 'Imported from OpenAPI',
        backend_type: 'http',
        managed_by: 'openapi',
        bundle_ids: [20, 21],
      }],
      bundles: [{ id: 20, description: 'OpenAPI: pets' }],
    });

    const { preview, operations } = await prepareOpenApiStudioPreview(pool, {
      specText: specText(paths, {
        components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
        security: [{ bearerAuth: [] }],
      }),
      namePrefix: 'Pets',
    });

    expect(operations).toHaveLength(4);
    expect(preview).toMatchObject({
      title: 'Pets API',
      openapiVersion: '3.0.3',
      sourceKind: 'text',
      prefix: 'pets',
      baseUrl: 'https://api.example.test/v1',
      security: { auth_type: 'bearer' },
      existing: {
        backendId: 10,
        backendOwned: true,
        importedToolCount: 2,
        assignedBundleIds: [20, 21],
        defaultBundleId: 20,
        defaultBundleOwned: true,
      },
      counts: {
        total: 4,
        supported: 3,
        read: 3,
        write: 1,
        create: 1,
        update: 1,
        collisions: 1,
        unsupported: 1,
        removals: 1,
      },
    });
    expect(preview.removals).toEqual([{ name: 'pets__removed', workflowCount: 2 }]);
    expect(preview.warnings).toContain('Re-import removes 1 operation');

    expect(preview.operations.find(operation => operation.name === 'pets__getpet')).toMatchObject({
      key: 'GET /pets/{pet-id}',
      method: 'GET',
      path: '/pets/{pet-id}',
      description: 'Get one pet [GET /pets/{pet-id}]',
      parameterCount: 2,
      tags: ['pets'],
      isWrite: false,
      riskLevel: 'low',
      supported: true,
      change: 'update',
      collisionReason: null,
    });
    expect(preview.operations.find(operation => operation.name === 'pets__createpet')).toMatchObject({
      change: 'collision',
      isWrite: true,
      riskLevel: 'high',
      collisionReason: 'Name is already owned by custom:other',
    });
    expect(preview.operations.find(operation => operation.name === 'pets__health')).toMatchObject({
      change: 'create',
      supported: true,
    });
    expect(preview.operations.find(operation => operation.name === 'pets__unsafepath')).toMatchObject({
      change: 'unsupported',
      supported: false,
      warnings: ['Operation path is not a safe relative HTTP path'],
    });
  });

  it('does not offer header credential reuse when the live backend header was edited', async () => {
    const shared = {
      id: 10,
      description: 'Imported from OpenAPI',
      backend_type: 'http',
      managed_by: 'openapi',
      auth_type: 'header',
      has_credential: true,
      source_revision: '1',
      source_manifest_digest: 'a'.repeat(64),
      source_auth_scheme: { type: 'header', headerName: 'X-API-Key' },
      bundle_ids: [],
    };
    const spec = specText(simplePaths, {
      components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
      security: [{ apiKey: [] }],
    });

    const mismatched = (await prepareOpenApiStudioPreview(mockPreviewPool({
      backends: [{ ...shared, auth_value: 'X-Other-Key:secret' }],
    }).pool, { specText: spec, namePrefix: 'pets' })).preview;
    const matching = (await prepareOpenApiStudioPreview(mockPreviewPool({
      backends: [{ ...shared, auth_value: 'x-api-key:secret' }],
    }).pool, { specText: spec, namePrefix: 'pets' })).preview;
    const unreadable = (await prepareOpenApiStudioPreview(mockPreviewPool({
      backends: [{ ...shared, auth_value: 'enc:v1:opaque-ciphertext' }],
    }).pool, { specText: spec, namePrefix: 'pets' })).preview;

    expect(mismatched.existing).toMatchObject({ hasCredential: true, credentialReusable: false });
    expect(matching.existing).toMatchObject({ hasCredential: true, credentialReusable: true });
    expect(unreadable.existing).toMatchObject({ hasCredential: true, credentialReusable: false });
    expect(JSON.stringify(mismatched)).not.toContain('X-Other-Key');
    expect(JSON.stringify(matching)).not.toContain(':secret');
  });

  it('does not treat a spoofed importer description as source ownership', async () => {
    const preview = (await prepareOpenApiStudioPreview(mockPreviewPool({
      backends: [{
        id: 10,
        description: 'Imported from OpenAPI',
        backend_type: 'http',
        managed_by: null,
        source_revision: null,
        bundle_ids: [],
      }],
    }).pool, { specText: specText(simplePaths), namePrefix: 'pets' })).preview;

    expect(preview.existing.backendOwned).toBe(false);
    expect(preview.warnings).toContain("Connection name 'pets' is already owned by another source");
  });

  it('does not treat a spoofed default-bundle description as ownership on first import', async () => {
    const preview = (await prepareOpenApiStudioPreview(mockPreviewPool({
      bundles: [{ id: 20, description: 'OpenAPI: pets' }],
    }).pool, { specText: specText(simplePaths), namePrefix: 'pets' })).preview;

    expect(preview.existing.defaultBundleOwned).toBe(false);
    expect(preview.warnings).toContain("Bundle name 'pets' is already owned by another source");
  });

  it('changes digests for changed source text and changed database state', async () => {
    const originalSpec = specText(simplePaths);
    const changedSpec = specText({
      '/pets': { get: { operationId: 'listPets', summary: 'List every pet' } },
    });
    const emptyState = mockPreviewPool();
    const existingState = mockPreviewPool({
      tools: [{
        id: 1,
        name: 'pets__listpets',
        category: 'openapi:pets',
        backend: 'custom:pets',
        workflow_count: 0,
      }],
    });

    const original = (await prepareOpenApiStudioPreview(emptyState.pool, {
      specText: originalSpec,
      namePrefix: 'pets',
    })).preview;
    const sourceChanged = (await prepareOpenApiStudioPreview(emptyState.pool, {
      specText: changedSpec,
      namePrefix: 'pets',
    })).preview;
    const stateChanged = (await prepareOpenApiStudioPreview(existingState.pool, {
      specText: originalSpec,
      namePrefix: 'pets',
    })).preview;

    expect(sourceChanged.specDigest).not.toBe(original.specDigest);
    expect(sourceChanged.previewDigest).not.toBe(original.previewDigest);
    expect(stateChanged.specDigest).toBe(original.specDigest);
    expect(stateChanged.previewDigest).not.toBe(original.previewDigest);
    expect(original.operations[0]?.change).toBe('create');
    expect(stateChanged.operations[0]?.change).toBe('update');
  });

  it('rejects a spec with zero operations before querying preview state', async () => {
    const { pool, query } = mockPreviewPool();

    await expect(prepareOpenApiStudioPreview(pool, {
      specText: specText({}),
    })).rejects.toThrow(/contains no supported HTTP operations/i);
    expect(query).not.toHaveBeenCalled();
  });

  it(`rejects more than ${MAX_OPENAPI_OPERATIONS} operations before querying preview state`, async () => {
    const paths = Object.fromEntries(Array.from(
      { length: MAX_OPENAPI_OPERATIONS + 1 },
      (_, index) => [`/items/${index}`, { get: { operationId: `getItem${index}` } }],
    ));
    const { pool, query } = mockPreviewPool();

    await expect(prepareOpenApiStudioPreview(pool, {
      specText: specText(paths),
    })).rejects.toThrow(`limit of ${MAX_OPENAPI_OPERATIONS} operations`);
    expect(query).not.toHaveBeenCalled();
  });
});
