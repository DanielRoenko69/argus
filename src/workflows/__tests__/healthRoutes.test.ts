import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type pg from 'pg';
import { registerHealthRoutes } from '../healthRoutes.js';

const servers: Server[] = [];
const pass: RequestHandler = (_req, _res, next) => next();
const originalGrafanaEnabled = process.env['GRAFANA_ENABLED'];
const originalGrafanaUrl = process.env['GRAFANA_URL'];
const originalOpenSearchEnabled = process.env['OPENSEARCH_ENABLED'];
const originalOpenSearchUrl = process.env['OPENSEARCH_URL'];

async function serve(pool: pg.Pool): Promise<string> {
  const app = express();
  registerHealthRoutes(app, pool, pass);
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  jest.restoreAllMocks();
  process.env['GRAFANA_ENABLED'] = originalGrafanaEnabled;
  process.env['GRAFANA_URL'] = originalGrafanaUrl;
  process.env['OPENSEARCH_ENABLED'] = originalOpenSearchEnabled;
  process.env['OPENSEARCH_URL'] = originalOpenSearchUrl;
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('backend health routes', () => {
  it('does not probe disabled integrations and treats native Argus backends as in-process health', async () => {
    process.env['GRAFANA_ENABLED'] = 'false';
    process.env['GRAFANA_URL'] = 'http://grafana.invalid';
    process.env['OPENSEARCH_ENABLED'] = '0';
    process.env['OPENSEARCH_URL'] = 'http://opensearch.invalid';

    const query = jest.fn(async (sql: string) => sql === 'SELECT 1'
      ? { rows: [{ '?column?': 1 }] }
      : {
          rows: [{
            name: 'argus-observability',
            base_url: 'argus://observability',
            health_path: '/health',
            enabled: true,
            backend_type: 'builtin',
            mcp_endpoint: null,
          }],
        });
    const pool = { query } as unknown as pg.Pool;
    const baseUrl = await serve(pool);

    const response = await fetch(`${baseUrl}/api/admin/health/backends`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      results: Array<{ name: string; kind: string; status: string; url: string | null }>;
    };

    expect(body.results).toContainEqual({
      name: 'argus-observability',
      kind: 'internal',
      status: 'ok',
      url: 'argus://observability',
      latency_ms: 0,
    });
    expect(body.results.some(result => result.name === 'grafana')).toBe(false);
    expect(body.results.some(result => result.name === 'opensearch')).toBe(false);
  });

  it('uses the configured service credential for authenticated HTTP backend health checks', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const realFetch = globalThis.fetch;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url !== 'http://public.example.com/api/health') return realFetch(input, init);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const query = jest.fn(async (sql: string) => sql === 'SELECT 1'
      ? { rows: [{ '?column?': 1 }] }
      : {
          rows: [{
            id: 42,
            name: 'authenticated-backend',
            description: 'fixture',
            base_url: 'http://public.example.com',
            auth_type: 'basic',
            auth_value: 'argus-service:fixture-secret',
            health_path: '/api/health',
            default_headers: {},
            timeout_ms: 3000,
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
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }],
        });
    const pool = { query } as unknown as pg.Pool;
    const baseUrl = await serve(pool);

    const response = await fetch(`${baseUrl}/api/admin/health/backends`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      results: Array<{ name: string; status: string; error?: string }>;
    };

    expect(body.results.find(result => result.name === 'authenticated-backend')).toMatchObject({ status: 'ok' });
    const backendRequest = requests.find(request => request.url === 'http://public.example.com/api/health');
    expect(backendRequest?.authorization).toBe(`Basic ${Buffer.from('argus-service:fixture-secret').toString('base64')}`);
  });
});
