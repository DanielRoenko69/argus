import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  executeCustomBackend,
  executeCustomBackendStructured,
  type CustomBackendRow,
} from '../backends/customBackends.js';

const savedEnvironment = {
  MCP_API_KEYS: process.env['MCP_API_KEYS'],
  SESSION_SECRET: process.env['SESSION_SECRET'],
  DB_ENCRYPTION_KEY: process.env['DB_ENCRYPTION_KEY'],
  ARGUS_EGRESS_ALLOWLIST: process.env['ARGUS_EGRESS_ALLOWLIST'],
  MAX_RESULT_SIZE_BYTES: process.env['MAX_RESULT_SIZE_BYTES'],
};

function backend(overrides: Partial<CustomBackendRow> = {}): CustomBackendRow {
  return {
    id: 1,
    name: 'public-api',
    description: '',
    base_url: 'https://8.8.8.8/api',
    auth_type: 'none',
    auth_value: null,
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
    bundle_ids: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('structured custom backend execution', () => {
  beforeEach(() => {
    process.env['MCP_API_KEYS'] = 'test-api-key';
    process.env['SESSION_SECRET'] = 's'.repeat(32);
    process.env['DB_ENCRYPTION_KEY'] = 'e'.repeat(64);
    process.env['ARGUS_EGRESS_ALLOWLIST'] = '';
    process.env['MAX_RESULT_SIZE_BYTES'] = '1024';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('caps a streamed response at MAX_RESULT_SIZE_BYTES for normal runtime calls', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(2_048), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));

    const result = await executeCustomBackend(backend(), 'GET', '/items');
    const body = result.split('\n\n')[1] ?? '';
    expect(Buffer.byteLength(body)).toBe(1_024);
  });

  it('returns structured metadata, redacts auth values and reports truncation', async () => {
    const secret = 'top-secret-token';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `${secret}:${'x'.repeat(2_048)}`,
      { status: 206, statusText: 'Partial Content', headers: { 'content-type': 'text/plain' } },
    ));

    const result = await executeCustomBackendStructured(
      backend({ default_headers: { 'X-Api-Key': secret } }),
      'GET',
      '/items',
    );
    expect(result).toEqual(expect.objectContaining({
      status: 206,
      statusText: 'Partial Content',
      contentType: 'text/plain',
      truncated: true,
    }));
    expect(result.body).not.toContain(secret);
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(1_024);
  });

  it('redacts stored credentials even when a custom auth header has a non-obvious name', async () => {
    const secret = 'odd-service-secret';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`echo:${secret}`, { status: 200 }));
    const result = await executeCustomBackendStructured(
      backend({ auth_type: 'header', auth_value: `X-License:${secret}` }),
      'GET',
      '/items',
    );
    expect(result.body).toBe('echo:[REDACTED]');
  });

  it('sends DELETE bodies through the same manual-redirect request path', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('deleted', { status: 200 }));
    await executeCustomBackendStructured(
      backend(),
      'DELETE',
      '/items/7',
      '{"reason":"duplicate"}',
      null,
      undefined,
      { 'Content-Type': 'application/json' },
    );

    expect(fetchSpy).toHaveBeenCalledWith('https://8.8.8.8/api/items/7', expect.objectContaining({
      method: 'DELETE',
      body: '{"reason":"duplicate"}',
      redirect: 'manual',
    }));
  });

  it('treats non-success HTTP responses as dynamic tool failures', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', {
      status: 429,
      statusText: 'Too Many Requests',
    }));

    await expect(executeCustomBackend(backend(), 'POST', '/items'))
      .rejects.toThrow('Upstream service returned HTTP 429 Too Many Requests');
  });

  it('treats Slack Web API ok=false envelopes as dynamic tool failures', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: 'not_in_channel' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(executeCustomBackend(
      backend({ config: { response_contract: 'slack-web-api' } }),
      'POST',
      '/api/chat.postMessage',
    )).rejects.toThrow('Slack API rejected request: not_in_channel');
  });
});
