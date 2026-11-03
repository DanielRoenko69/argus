/**
 * apiKeyMiddlewarePublicPaths.test.ts — locks the PUBLIC_PREFIXES exemptions.
 *
 * Regression for the Shared-Links P4 e2e gap: the global API-key gate rejected anon
 * GET /share/:token with 401 before the route handler ran (the handler enforces its own
 * flag/token/rate-limit gates). /share/ must be exempt just like /public/.
 */
import { createApiKeyMiddleware } from '../apiKeyMiddleware.js';
import type { Config } from '../../config/env.js';
import type { Request, Response } from 'express';

const config = { apiKeys: ['secret-key-123456'], rateLimitPerMinute: 1000 } as unknown as Config;

function run(path: string, headers: Record<string, string> = {}): { nexted: boolean; status: number | null } {
  const mw = createApiKeyMiddleware(config);
  let nexted = false;
  let status: number | null = null;
  const req = { path, query: {}, headers, method: 'GET' } as unknown as Request;
  const res = {
    on: () => res,
    status: (c: number) => { status = c; return res; },
    json: () => res,
  } as unknown as Response;
  mw(req, res, () => { nexted = true; });
  return { nexted, status };
}

describe('apiKeyMiddleware PUBLIC_PREFIXES', () => {
  it('lets the session-protected dashboard preview reach requireAuth', () => {
    const { nexted, status } = run('/design-showcase');
    expect(nexted).toBe(true);
    expect(status).toBeNull();
  });

  it.each(['/home', '/build/agents', '/build/knowledge', '/build/skills', '/build/workflows', '/build/public-widgets', '/runs', '/mcp-fabric', '/governance', '/observe', '/settings', '/connections'])(
    'lets the session-protected console route %s reach requireAuth',
    (path) => {
      const { nexted, status } = run(path);
      expect(nexted).toBe(true);
      expect(status).toBeNull();
    },
  );

  it('serves console assets without an API key', () => {
    const { nexted, status } = run('/console-assets/assets/index-example.js');
    expect(nexted).toBe(true);
    expect(status).toBeNull();
  });

  it('lets nested MCP Fabric bundle routes reach session auth', () => {
    const { nexted, status } = run('/mcp-fabric/bundles/1');
    expect(nexted).toBe(true);
    expect(status).toBeNull();
  });

  it('lets the nested Agent Studio route reach admin session auth', () => {
    const { nexted, status } = run('/build/agents/manage');
    expect(nexted).toBe(true);
    expect(status).toBeNull();
  });

  it.each([
    '/runs/agent/run-42',
    '/governance/policies',
    '/governance/runtime-controls',
    '/governance/compliance/runs/41',
    '/observe/audit',
    '/connections/connect/7',
    '/build/workflows/studio/9',
    '/solutions/argus.dev',
    '/workflows/studio/9',
    '/chat/3',
  ])('lets nested browser route %s reach its own session guard', path => {
    const { nexted, status } = run(path);
    expect(nexted).toBe(true);
    expect(status).toBeNull();
  });

  it('lets an anonymous /share/:token request through (no 401) so the route can self-gate', () => {
    const { nexted, status } = run('/share/sometoken');
    expect(nexted).toBe(true);
    expect(status).toBeNull();
  });

  it('lets an anonymous /share/:token/unlock POST through', () => {
    const { nexted, status } = run('/share/sometoken/unlock');
    expect(nexted).toBe(true);
    expect(status).toBeNull();
  });

  it('keeps the /public/ widget surface exempt (existing behavior)', () => {
    const { nexted } = run('/public/widget/foo/session');
    expect(nexted).toBe(true);
  });

  it('lets signed workflow webhook deliveries reach their HMAC gate', () => {
    const { nexted, status } = run('/webhooks/wf/github-issue-triage');
    expect(nexted).toBe(true);
    expect(status).toBeNull();
  });

  it('still rejects an unrelated unauthenticated path with 401', () => {
    const { nexted, status } = run('/mcp');
    expect(nexted).toBe(false);
    expect(status).toBe(401);
  });
});
