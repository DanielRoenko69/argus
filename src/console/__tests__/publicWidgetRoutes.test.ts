import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../public/widgetStore.js', () => ({
  createWidget: jest.fn(),
  deleteWidget: jest.fn(),
  getWidget: jest.fn(),
  listPublicWidgetAgents: jest.fn(),
  listWidgets: jest.fn(),
  updateWidget: jest.fn(),
}));
jest.mock('../../public/publicWidgetDemo.js', () => ({
  disablePublicWidgetDemo: jest.fn(),
  provisionPublicWidgetDemo: jest.fn(),
  PUBLIC_WIDGET_DEMO_AGENT_NAME: 'public_demo_assistant',
  PUBLIC_WIDGET_DEMO_SLUG: 'argus-public-demo',
  PublicWidgetDemoError: class PublicWidgetDemoError extends Error {
    status = 400;
  },
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class {
    async isAllowed() { return true; }
    cleanup() { /* no-op */ }
  },
}));

import { writeAdminAudit } from '../../lib/adminAudit.js';
import {
  createWidget,
  deleteWidget,
  getWidget,
  listPublicWidgetAgents,
  listWidgets,
  updateWidget,
  type PublicWidget,
} from '../../public/widgetStore.js';
import { disablePublicWidgetDemo, provisionPublicWidgetDemo } from '../../public/publicWidgetDemo.js';
import { registerConsoleApi } from '../consoleApi.js';

const mockCreate = createWidget as jest.MockedFunction<typeof createWidget>;
const mockDelete = deleteWidget as jest.MockedFunction<typeof deleteWidget>;
const mockGet = getWidget as jest.MockedFunction<typeof getWidget>;
const mockListAgents = listPublicWidgetAgents as jest.MockedFunction<typeof listPublicWidgetAgents>;
const mockList = listWidgets as jest.MockedFunction<typeof listWidgets>;
const mockUpdate = updateWidget as jest.MockedFunction<typeof updateWidget>;
const mockAudit = writeAdminAudit as jest.MockedFunction<typeof writeAdminAudit>;
const mockProvisionDemo = provisionPublicWidgetDemo as jest.MockedFunction<typeof provisionPublicWidgetDemo>;
const mockDisableDemo = disablePublicWidgetDemo as jest.MockedFunction<typeof disablePublicWidgetDemo>;

const admin: SessionUser = {
  id: 7, username: 'admin', display_name: 'Admin', role: 'platform_admin', allowed_bundles: null, entra_groups: [],
};
const widget: PublicWidget = {
  id: 9, agent_id: 41, slug: 'support', allowed_origins: ['https://example.com'], enabled: true,
  greeting: 'Hello', accent: '#7c3aed', title: 'Ask Argus', input_placeholder: 'Ask a question...',
  launcher_icon_url: 'https://example.com/argus.svg', launcher_icon_alt: 'Open Argus', launcher_position: 'right',
  rate_limit_per_ip: 20, daily_token_cap: 50_000,
  created_by: 7, created_at: new Date('2026-08-01T10:00:00.000Z'),
};
const agents = [
  { id: 41, name: 'support', label: 'Support Agent', enabled: true, visibility: 'public' as const },
  { id: 42, name: 'sales', label: 'Sales Agent', enabled: true, visibility: 'public' as const },
  { id: 43, name: 'internal', label: 'Internal Agent', enabled: true, visibility: 'internal' as const },
];

let authenticated = true;
let sameOriginAllowed = true;
let currentUser: SessionUser = admin;
let sameOriginCalls = 0;
let server: Server;
let baseUrl: string;
const pool = {} as pg.Pool;

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, res, next) => {
    if (!authenticated) { res.status(401).json({ error: 'auth' }); return; }
    (req as unknown as { user: SessionUser }).user = currentUser;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, res, next) => {
    sameOriginCalls += 1;
    if (!sameOriginAllowed) { res.status(403).json({ error: 'origin' }); return; }
    next();
  };
  registerConsoleApi(app, {
    pool,
    requireAuth,
    requireSameOrigin,
    loadStatus: jest.fn(async () => ({})),
    listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined),
    publicWidgetEnabled: true,
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  authenticated = true;
  sameOriginAllowed = true;
  currentUser = admin;
  sameOriginCalls = 0;
  mockList.mockResolvedValue([widget]);
  mockListAgents.mockResolvedValue(agents);
  mockGet.mockResolvedValue(widget);
  mockCreate.mockResolvedValue(widget);
  mockUpdate.mockImplementation(async (_pool, id, patch) => ({
    ...widget,
    id,
    agent_id: patch.agent_id ?? widget.agent_id,
    allowed_origins: patch.allowed_origins ?? widget.allowed_origins,
    enabled: patch.enabled ?? widget.enabled,
  }));
  mockDelete.mockResolvedValue(undefined);
  mockProvisionDemo.mockResolvedValue({
    agent: { id: 51, name: 'public_demo_assistant', label: 'Public Demo Assistant', enabled: true, visibility: 'public' },
    widget: { ...widget, id: 19, agent_id: 51, slug: 'argus-public-demo', allowed_origins: ['http://localhost'] },
  });
  mockDisableDemo.mockResolvedValue({
    agent: { id: 51, name: 'public_demo_assistant', label: 'Public Demo Assistant', enabled: false, visibility: 'internal' },
    widget: { ...widget, id: 19, agent_id: 51, slug: 'argus-public-demo', allowed_origins: ['http://localhost'], enabled: false },
  });
});

describe('native public widget console routes', () => {
  it('returns a master-switch-aware catalog without internal agents', async () => {
    const response = await request('/api/ui/public-widgets');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ masterEnabled: true });
    expect(response.body['demo']).toMatchObject({ configured: false, reachable: false });
    expect(response.body['widgets']).toEqual([expect.objectContaining({
      id: 9, slug: 'support', runtimeState: 'active', agent: expect.objectContaining({ label: 'Support Agent' }),
    })]);
    expect(response.body['agents']).toEqual([
      { id: 41, name: 'support', label: 'Support Agent' },
      { id: 42, name: 'sales', label: 'Sales Agent' },
    ]);
  });

  it('requires platform-admin access for the catalog', async () => {
    currentUser = { ...admin, role: 'viewer' };
    expect((await request('/api/ui/public-widgets')).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('enforces same-origin before creating a widget', async () => {
    sameOriginAllowed = false;
    const response = await request('/api/ui/public-widgets', 'POST', {
      slug: 'new-widget', agentId: 41, allowedOrigins: ['https://example.com'], enabled: true,
    });
    expect(response.status).toBe(403);
    expect(sameOriginCalls).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('normalizes origins and records a structured create audit', async () => {
    const response = await request('/api/ui/public-widgets', 'POST', {
      slug: 'support', agentId: 41,
      allowedOrigins: ['https://Example.com/', 'https://example.com'],
      enabled: true, accent: '#7C3AED', rateLimitPerIp: 25, dailyTokenCap: 60_000,
    });
    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(pool, expect.objectContaining({
      agent_id: 41, allowed_origins: ['https://example.com'], accent: '#7c3aed',
      rate_limit_per_ip: 25, daily_token_cap: 60_000, created_by: 7,
    }));
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'created', 'mcp_public_widgets', '9', 'support', null,
      expect.objectContaining({ slug: 'support' }),
    );
  });

  it('rejects wildcard origins and enabled widgets without an origin', async () => {
    expect((await request('/api/ui/public-widgets', 'POST', {
      slug: 'unsafe', agentId: 41, allowedOrigins: ['https://*.example.com'], enabled: true,
    })).status).toBe(400);
    expect((await request('/api/ui/public-widgets', 'POST', {
      slug: 'unreachable', agentId: 41, allowedOrigins: [], enabled: true,
    })).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('persists agent reassignment that the legacy route silently ignored', async () => {
    const response = await request('/api/ui/public-widgets/9', 'PUT', { agentId: 42 });
    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(pool, 9, { agent_id: 42 });
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'updated', 'mcp_public_widgets', '9', 'support',
      expect.objectContaining({ agentId: 41 }), expect.objectContaining({ agentId: 42 }),
    );
  });

  it('provisions one isolated local demo Agent and Widget behind same-origin admin access', async () => {
    const response = await request('/api/ui/public-widgets/demo', 'POST', {
      origin: 'http://localhost',
      websiteOrigins: ['http://localhost:4173', 'http://127.0.0.1:4173'],
    });
    expect(response.status).toBe(201);
    expect(mockProvisionDemo).toHaveBeenCalledWith(pool, {
      origin: 'http://localhost',
      websiteOrigins: ['http://localhost:4173', 'http://127.0.0.1:4173'],
      createdBy: 7,
    });
    expect(response.body['demo']).toMatchObject({
      configured: true, reachable: true, agentReady: true, widgetEnabled: true,
    });
    expect(response.body['widget']).toMatchObject({ slug: 'argus-public-demo', runtimeState: 'active' });
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'created', 'public_widget_demo', '19', 'argus-public-demo',
      expect.anything(), expect.objectContaining({ reachable: true }),
    );
  });

  it('disables both local demo resources through one governed action', async () => {
    const response = await request('/api/ui/public-widgets/demo/disable', 'POST');
    expect(response.status).toBe(200);
    expect(mockDisableDemo).toHaveBeenCalledWith(pool);
    expect(response.body['demo']).toMatchObject({
      configured: true, reachable: false, agentReady: false, widgetEnabled: false,
    });
  });

  it('deletes through same-origin protection and preserves before-state audit evidence', async () => {
    const response = await request('/api/ui/public-widgets/9', 'DELETE');
    expect(response.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith(pool, 9);
    expect(mockAudit).toHaveBeenCalledWith(
      pool, expect.anything(), 'deleted', 'mcp_public_widgets', '9', 'support', widget, null,
    );
  });
});
