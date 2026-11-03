import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { CustomBackendRow } from '../../backends/customBackends.js';

jest.mock('../../backends/customBackends.js', () => ({
  assertCustomBackendTargetSafe: jest.fn(async (backend: CustomBackendRow, path: string) =>
    new URL(`${new URL(backend.base_url).origin}${new URL(backend.base_url).pathname.replace(/\/$/, '')}${path}`).toString()),
  executeCustomBackendStructured: jest.fn(),
  getCustomBackendResponseLimit: () => 65_536,
  resolveCustomBackendTarget: (backend: CustomBackendRow, path: string) =>
    new URL(`${new URL(backend.base_url).origin}${new URL(backend.base_url).pathname.replace(/\/$/, '')}${path}`).toString(),
}));

import { assertCustomBackendTargetSafe, executeCustomBackendStructured } from '../../backends/customBackends.js';
import {
  CapabilityPlaygroundError,
  runCapabilityPlayground,
} from '../capabilityPlayground.js';

const mockExecute = executeCustomBackendStructured as jest.MockedFunction<typeof executeCustomBackendStructured>;
const mockAssertTarget = assertCustomBackendTargetSafe as jest.MockedFunction<typeof assertCustomBackendTargetSafe>;

const backend: CustomBackendRow = {
  id: 12,
  name: 'pets',
  description: 'Pets',
  base_url: 'https://api.example.test/v1',
  auth_type: 'bearer',
  auth_value: 'encrypted-service-secret',
  health_path: null,
  default_headers: {},
  timeout_ms: 10_000,
  tls_skip_verify: false,
  enabled: true,
  backend_type: 'http',
  mcp_endpoint: null,
  transport_type: 'streamable-http',
  builtin_key: null,
  auth_mode: 'service-account',
  oauth_authorize_url: null,
  oauth_token_url: null,
  oauth_client_id: null,
  oauth_client_secret: null,
  oauth_scopes: null,
  oauth_revoke_url: null,
  config: {},
  bundle_id: null,
  bundle_ids: [3],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function capability(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    name: 'pets__get_pet',
    backend: 'custom:pets',
    query_template: 'GET /pets/{{petId}}?api_key={{api_key}}\nX-Api-Key: {{api_key}}',
    parameters: [
      { name: 'petId', type: 'string', description: '', required: true },
      { name: 'api_key', type: 'string', description: '', required: true },
    ],
    enabled: false,
    tool_type: 'dynamic',
    is_write: false,
    risk_level: 'low',
    required_auth_mode: null,
    ...overrides,
  };
}

function poolFor(tool = capability(), connection = backend): pg.Pool {
  const query = jest.fn(async (sql: string) => ({
    rows: sql.includes('FROM mcp_tools') ? (tool ? [tool] : []) : (connection ? [connection] : []),
  }));
  return { query } as unknown as pg.Pool;
}

describe('Capability Playground service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertTarget.mockImplementation(async (value, path) =>
      new URL(`${new URL(value.base_url).origin}${new URL(value.base_url).pathname.replace(/\/$/, '')}${path}`).toString());
    mockExecute.mockResolvedValue({
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      body: '{"token":"upstream-secret","message":"ok"}',
      truncated: false,
      durationMs: 12,
      authentication: { backendId: 1, mode: 'service-account' },
    });
  });

  it('renders a disabled managed capability but never exposes sensitive parameters or connection credentials', async () => {
    const result = await runCapabilityPlayground(poolFor(), '7', {
      parameters: { petId: '42', api_key: 'user-secret-value' },
    });

    expect(result.executed).toBe(false);
    expect(result.capability).toEqual(expect.objectContaining({ id: 'managed:7', enabled: false, isWrite: false }));
    expect(decodeURIComponent(result.request.target)).toContain('api_key=[REDACTED]');
    expect(result.request.target).not.toContain('user-secret-value');
    expect(result.request.headers['X-Api-Key']).toBe('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('encrypted-service-secret');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('executes reads through the shared custom-backend runner and redacts secret response keys', async () => {
    const result = await runCapabilityPlayground(poolFor(), 'managed:7', {
      parameters: { petId: '42', api_key: 'user-secret-value' },
      execute: true,
    });

    expect(result.executed).toBe(true);
    expect(result.response).toEqual(expect.objectContaining({ status: 200, body: '{"token":"[REDACTED]","message":"ok"}' }));
    expect(mockExecute).toHaveBeenCalledWith(
      backend,
      'GET',
      '/pets/42?api_key=user-secret-value',
      undefined,
      null,
      undefined,
      { 'X-Api-Key': 'user-secret-value' },
      expect.objectContaining({ maxResponseBytes: 65_536, redactValues: ['user-secret-value'] }),
    );
  });

  it('treats every non-GET request as write even when the stored flag is false', async () => {
    const tool = capability({
      query_template: 'DELETE /pets/{{petId}}',
      parameters: [{ name: 'petId', type: 'string', description: '', required: true }],
    });
    const preview = await runCapabilityPlayground(poolFor(tool), '7', { parameters: { petId: '42' } });
    expect(preview.capability).toEqual(expect.objectContaining({ isWrite: true, riskLevel: 'high' }));

    await expect(runCapabilityPlayground(poolFor(tool), '7', {
      parameters: { petId: '42' },
      execute: true,
    })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Bestätigung/) });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('permits an explicitly allowlisted POST query only with a read-only service identity', async () => {
    const tool = capability({
      query_template: 'POST /argus-production-logs/_search\n\n{"query":{"match_all":{}}}',
    });
    const readOnlyBackend = {
      ...backend,
      config: {
        credential_mode: 'readonly-service-identity',
        read_only_post_paths: ['/argus-production-logs/_search'],
      },
    };

    const result = await runCapabilityPlayground(poolFor(tool, readOnlyBackend), '7', {
      parameters: { petId: 'ignored', api_key: 'ignored-secret' },
      execute: true,
    });

    expect(result.capability).toEqual(expect.objectContaining({ isWrite: false, riskLevel: 'low' }));
    expect(result.executed).toBe(true);
  });

  it('keeps POST queries fail-closed when the path is not explicitly allowlisted', async () => {
    const tool = capability({ query_template: 'POST /admin/reindex\n\n{}' });
    const readOnlyBackend = {
      ...backend,
      config: {
        credential_mode: 'readonly-service-identity',
        read_only_post_paths: ['/argus-production-logs/_search'],
      },
    };

    await expect(runCapabilityPlayground(poolFor(tool, readOnlyBackend), '7', {
      parameters: { petId: 'ignored', api_key: 'ignored-secret' },
      execute: true,
    })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Bestätigung/) });
  });

  it('executes a write only after explicit confirmation and masks bodies containing sensitive placeholders', async () => {
    const tool = capability({
      query_template: 'POST /pets\nContent-Type: application/json\n\n{"name":"{{petId}}","password":"{{api_key}}"}',
    });
    const result = await runCapabilityPlayground(poolFor(tool), '7', {
      parameters: { petId: 'Ada', api_key: 'body-secret' },
      execute: true,
      confirmWrite: true,
    });
    expect(result.request.body).toBe('[REDACTED]');
    expect(result.executed).toBe(true);
  });

  it('coerces typed defaults before rendering', async () => {
    const tool = capability({
      query_template: 'GET /pets?limit={{limit}}&active={{active}}',
      parameters: [
        { name: 'limit', type: 'number', description: '', required: false, default: '3' },
        { name: 'active', type: 'boolean', description: '', required: false, default: 'true' },
      ],
    });
    const result = await runCapabilityPlayground(poolFor(tool), '7', { parameters: {} });
    expect(result.request.target).toBe('https://api.example.test/v1/pets?limit=3&active=true');
  });

  it('fails closed for unsupported capability kinds and disabled connections', async () => {
    await expect(runCapabilityPlayground(poolFor(capability({ backend: 'postgresql' })), '7', { parameters: {} }))
      .rejects.toBeInstanceOf(CapabilityPlaygroundError);
    await expect(runCapabilityPlayground(poolFor(capability(), { ...backend, enabled: false }), '7', {
      parameters: { petId: '42', api_key: 'value' },
    })).rejects.toMatchObject({ status: 409 });
  });

  it('fails closed during preview when SSRF or egress validation rejects the real target', async () => {
    mockAssertTarget.mockRejectedValueOnce(new Error('URL nicht erlaubt'));
    await expect(runCapabilityPlayground(poolFor(), '7', {
      parameters: { petId: '42', api_key: 'value' },
    })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/nicht erlaubt/) });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects unknown parameters, invalid IDs and missing capabilities', async () => {
    await expect(runCapabilityPlayground(poolFor(), 'remote:7', { parameters: {} })).rejects.toMatchObject({ status: 400 });
    await expect(runCapabilityPlayground(poolFor(null as never), '7', { parameters: {} })).rejects.toMatchObject({ status: 404 });
    await expect(runCapabilityPlayground(poolFor(), '7', {
      parameters: { petId: '42', api_key: 'value', extra: true },
    })).rejects.toMatchObject({ status: 400 });
  });
});
