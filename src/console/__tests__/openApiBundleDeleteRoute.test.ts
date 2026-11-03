import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';

jest.mock('../../bundles/serviceBundles.js', () => ({
  deleteBundle: jest.fn(),
  getBundle: jest.fn(),
  getBundleBackends: jest.fn(),
  getBundleTools: jest.fn(),
  listBundles: jest.fn(),
}));
jest.mock('../../lib/adminAudit.js', () => ({ writeAdminAudit: jest.fn() }));
jest.mock('../../lib/rateLimiter.js', () => ({
  RateLimiter: class {
    async isAllowed() { return true; }
    cleanup() { /* no-op */ }
  },
}));

import { deleteBundle, getBundle } from '../../bundles/serviceBundles.js';
import {
  OPENAPI_CAPABILITY_STUDIO_HREF,
  OpenApiOwnershipError,
} from '../../lib/openApiOwnership.js';
import { registerConsoleApi } from '../consoleApi.js';

const mockDeleteBundle = deleteBundle as jest.MockedFunction<typeof deleteBundle>;
const mockGetBundle = getBundle as jest.MockedFunction<typeof getBundle>;
const admin: SessionUser = {
  id: 7,
  username: 'admin',
  display_name: 'Admin',
  role: 'platform_admin',
  allowed_bundles: null,
  entra_groups: [],
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, _res, next) => {
    (req as unknown as { user: SessionUser }).user = admin;
    next();
  };
  const requireSameOrigin: RequestHandler = (_req, _res, next) => next();
  registerConsoleApi(app, {
    pool: {} as pg.Pool,
    requireAuth,
    requireSameOrigin,
    loadStatus: jest.fn(async () => ({})),
    listActiveSessions: () => [],
    refreshBackends: jest.fn(async () => undefined),
    refreshDynamicTools: jest.fn(async () => undefined),
  } as unknown as Parameters<typeof registerConsoleApi>[1]);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBundle.mockResolvedValue({
    id: 4,
    name: 'pets',
    label: 'Pets',
    description: '',
    icon: '',
    system_prompt: null,
    agent_role: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    backend_count: 1,
    tool_count: 1,
  });
});

describe('managed bundle delete ownership contract', () => {
  it('returns 409 and the Studio target when a source boundary is protected', async () => {
    mockDeleteBundle.mockRejectedValue(new OpenApiOwnershipError('Source boundary protected'));

    const response = await fetch(`${baseUrl}/api/ui/mcp-fabric/bundles/4`, { method: 'DELETE' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Source boundary protected',
      href: OPENAPI_CAPABILITY_STUDIO_HREF,
    });
    expect(mockDeleteBundle).toHaveBeenCalledWith(expect.anything(), 4, false);
  });
});
