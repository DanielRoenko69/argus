import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  parseHttpRequestSpec,
  renderTemplate,
  type ToolParameter,
} from '../tools/dynamic/index.js';
import {
  executeCustomBackend,
  type CustomBackendRow,
} from '../backends/customBackends.js';

const stringParameter = (name: string): ToolParameter => ({
  name,
  type: 'string',
  description: name,
  required: true,
});

function backend(overrides: Partial<CustomBackendRow> = {}): CustomBackendRow {
  return {
    id: 1,
    name: 'test-api',
    description: '',
    base_url: 'https://8.8.8.8/api/',
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
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('dynamic HTTP mini-format', () => {
  it('parses request line, headers, and a multiline body', () => {
    const request = parseHttpRequestSpec([
      'POST https://api.example.test/v1/items?dryRun=true',
      'X-Trace-Id: trace-123',
      'Content-Type: application/json',
      '',
      '{',
      '  "name": "Ada"',
      '}',
    ].join('\n'));

    expect(request).toEqual({
      method: 'POST',
      target: 'https://api.example.test/v1/items?dryRun=true',
      headers: {
        'X-Trace-Id': 'trace-123',
        'Content-Type': 'application/json',
      },
      body: '{\n  "name": "Ada"\n}',
    });
  });

  it('recognizes a JSON body immediately after the request line', () => {
    expect(parseHttpRequestSpec('PATCH /items/1\n{"enabled":true}')).toEqual({
      method: 'PATCH',
      target: '/items/1',
      headers: {},
      body: '{"enabled":true}',
    });
  });

  it.each([
    'Authorization',
    'authorization',
    'Cookie',
    'Host',
    'Content-Length',
    'Connection',
    'Proxy-Authorization',
    'TE',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
  ])('rejects the reserved header %s case-insensitively', (name) => {
    expect(() => parseHttpRequestSpec(`GET /items\n${name}: attacker-controlled`))
      .toThrow(/reserved or invalid/i);
  });

  it.each([
    'Bad Header: value',
    'Missing-Separator',
    ': value',
    'X-Test:value',
  ])('rejects the invalid header line %s', (line) => {
    expect(() => parseHttpRequestSpec(`GET /items\n${line}`))
      .toThrow(/invalid/i);
  });

  it('renders a raw JSON parameter byte-for-byte and rejects invalid JSON', () => {
    const template = 'POST /items\nContent-Type: application/json\n\n{{body}}';
    const rawBody = '{"name":"Ada","nested":{"active":true},"roles":["admin"]}';

    expect(renderTemplate(template, { body: rawBody }, [stringParameter('body')]))
      .toBe(`POST /items\nContent-Type: application/json\n\n${rawBody}`);
    expect(() => renderTemplate(template, { body: '{not-json}' }, [stringParameter('body')]))
      .toThrow(/invalid JSON body/i);
  });

  it('URL-encodes request targets and only escapes controls in header values', () => {
    const injected = 'safe\r\nHost: 169.254.169.254';
    const rendered = renderTemplate(
      'GET /search?q={{query}}\nX-Trace-Id: {{trace}}',
      { query: injected, trace: injected },
      [stringParameter('query'), stringParameter('trace')],
    );
    const request = parseHttpRequestSpec(rendered);

    expect(rendered).not.toContain('\r');
    expect(rendered.split('\n')).toHaveLength(2);
    expect(request.target).toContain('safe%0D%0AHost%3A%20169.254.169.254');
    expect(request.headers).toEqual({
      'X-Trace-Id': 'safe%0D%0AHost: 169.254.169.254',
    });
    expect(request.headers).not.toHaveProperty('Host');
  });

  it('preserves valid header-value syntax such as spaces, slashes and quoted ETags', () => {
    const rendered = renderTemplate(
      'GET /items\nIf-Match: {{etag}}\nX-Scope: {{scope}}',
      { etag: '"version/2"', scope: 'read write' },
      [stringParameter('etag'), stringParameter('scope')],
    );
    expect(parseHttpRequestSpec(rendered).headers).toEqual({
      'If-Match': '"version/2"',
      'X-Scope': 'read write',
    });
  });
});

describe('custom HTTP runtime path boundary', () => {
  const savedEnvironment = {
    MCP_API_KEYS: process.env['MCP_API_KEYS'],
    SESSION_SECRET: process.env['SESSION_SECRET'],
    DB_ENCRYPTION_KEY: process.env['DB_ENCRYPTION_KEY'],
    ARGUS_EGRESS_ALLOWLIST: process.env['ARGUS_EGRESS_ALLOWLIST'],
  };

  beforeEach(() => {
    process.env['MCP_API_KEYS'] = 'test-api-key';
    process.env['SESSION_SECRET'] = 's'.repeat(32);
    process.env['DB_ENCRYPTION_KEY'] = 'e'.repeat(64);
    process.env['ARGUS_EGRESS_ALLOWLIST'] = '';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each([
    '//evil.example/steal',
    'https://evil.example/steal',
    '@evil.example/steal',
    '',
  ])('rejects a path that does not start with exactly one slash: %s', async (path) => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(executeCustomBackend(backend(), 'GET', path))
      .rejects.toThrow(/single \/|path must start/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a configured base URL containing credentials before fetch', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(executeCustomBackend(
      backend({ base_url: 'https://user:password@8.8.8.8/api' }),
      'GET',
      '/items',
    )).rejects.toThrow(/base URL is invalid/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('joins a valid single-slash path under the configured base path and keeps request data intact', async () => {
    const response = {
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'text/plain' },
      text: async () => 'accepted',
    } as unknown as Response;
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const rawBody = '{"name":"Ada"}';
    const rendered = renderTemplate(
      'POST /v1/items\nX-Trace-Id: {{trace}}\nContent-Type: application/json\n\n{{body}}',
      { trace: 'trace-123', body: rawBody },
      [stringParameter('trace'), stringParameter('body')],
    );
    const request = parseHttpRequestSpec(rendered);

    await expect(executeCustomBackend(
      backend(),
      request.method,
      request.target,
      request.body,
      null,
      undefined,
      request.headers,
    )).resolves.toBe('HTTP 200 OK\n\naccepted');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://8.8.8.8/api/v1/items');
    expect(options).toEqual(expect.objectContaining({
      method: 'POST',
      body: rawBody,
      redirect: 'manual',
      headers: expect.objectContaining({
        'X-Trace-Id': 'trace-123',
        'Content-Type': 'application/json',
      }),
    }));
  });
});
