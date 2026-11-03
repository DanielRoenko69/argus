import { createHmac } from 'node:crypto';
import type { ToolFilterRow } from '../toolFilters.js';

jest.mock('../../backends/customBackends.js', () => ({
  assertSsrfSafe: jest.fn(),
  assertSsrfSafeResolved: jest.fn(async () => undefined),
  assertEgressAllowed: jest.fn(),
}));

import { assertEgressAllowed, assertSsrfSafeResolved } from '../../backends/customBackends.js';
import { runFilters, setToolFilters, testToolFilter, updateToolFilter } from '../toolFilters.js';

const row = (overrides: Partial<ToolFilterRow> = {}): ToolFilterRow => ({
  id: 1,
  name: 'policy',
  description: 'test',
  webhook_url: 'https://policy.example.test/decide',
  hmac_secret: 'shared-secret',
  timeout_ms: 3000,
  tool_patterns: ['workspace_*'],
  enabled: true,
  on_timeout: 'deny',
  created_at: '2026-08-01T10:00:00.000Z',
  updated_at: '2026-08-01T10:00:00.000Z',
  ...overrides,
});

describe('runtime tool filters', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    setToolFilters([]);
    jest.clearAllMocks();
  });

  it('revalidates egress, signs the exact payload and applies transformed args', async () => {
    setToolFilters([row()]);
    global.fetch = jest.fn(async (_url, init) => {
      const body = String(init?.body);
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Argus-Signature']).toBe(`sha256=${createHmac('sha256', 'shared-secret').update(body).digest('hex')}`);
      return new Response(JSON.stringify({ allow: true, args: { path: 'SAFE.md' } }), { status: 200 });
    }) as typeof fetch;

    const args = { path: 'README.md' };
    await expect(runFilters('workspace_read_file', args, { apiKeyPrefix: 'argus_', sessionId: 's1' }))
      .resolves.toEqual({ allowed: true, args: { path: 'SAFE.md' } });
    expect(assertSsrfSafeResolved).toHaveBeenCalledWith(row().webhook_url, undefined, { failClosedOnDnsError: true });
    expect(assertEgressAllowed).toHaveBeenCalledWith(row().webhook_url);
  });

  it('preserves argument identity when no policy transforms the request', async () => {
    setToolFilters([row()]);
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ allow: true }), { status: 200 })) as typeof fetch;
    const args = { path: 'README.md' };
    const result = await runFilters('workspace_read_file', args, { apiKeyPrefix: null, sessionId: null });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.args).toBe(args);
  });

  it('fails closed on malformed or oversized policy responses', async () => {
    setToolFilters([row()]);
    global.fetch = jest.fn(async () => new Response('{"unexpected":true}', { status: 200 })) as typeof fetch;
    await expect(runFilters('workspace_exec', { cmd: 'pwd' }, { apiKeyPrefix: null, sessionId: null }))
      .resolves.toEqual(expect.objectContaining({ allowed: false }));
  });

  it('uses the production HMAC path and test header for dry runs', async () => {
    global.fetch = jest.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>)['X-Argus-Test']).toBe('true');
      expect((init?.headers as Record<string, string>)['X-Argus-Signature']).toMatch(/^sha256=/);
      return new Response(JSON.stringify({ allow: false, reason: 'change freeze' }), { status: 200 });
    }) as typeof fetch;
    await expect(testToolFilter(row(), 'workspace_exec', { cmd: 'deploy' })).resolves.toMatchObject({
      reachable: true, ok: true, decision: 'deny', reason: 'change freeze', signed: true, status: 200,
    });
  });

  it('whitelists update columns instead of interpolating arbitrary keys into SQL', async () => {
    const query = jest.fn(async (sql: string) => ({ rows: [{ ...row(), description: 'safe' }] }));
    await updateToolFilter({ query } as never, 1, {
      description: 'safe',
      name: 'sql_injection_attempt',
    } as never);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET description = $1'),
      ['safe', 1],
    );
    expect(String(query.mock.calls[0]?.[0])).not.toContain('name =');
  });
});
