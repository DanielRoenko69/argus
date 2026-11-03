import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { registerBuilderRoutes } from '../builderRoutes.js';
import { registerFlowRoutes } from '../flowRoutes.js';
import { registerVersionRoutes } from '../versionRoutes.js';

const servers: Server[] = [];
const user: SessionUser = {
  id: 7,
  username: 'alex',
  display_name: 'Alex',
  role: 'admin',
  allowed_bundles: null,
  entra_groups: [],
  workspace_scopes: [
    { tenantKey: 'default', workspaceKey: 'default', isDefault: true },
    { tenantKey: 'tenant-a', workspaceKey: 'engineering', isDefault: false },
  ],
};

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

async function serve(register: (app: express.Express) => void): Promise<string> {
  const app = express();
  app.use(express.json());
  register(app);
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function requireAuth(req: Request, _res: Response, next: () => void): void {
  Object.assign(req, { user });
  next();
}

const selectedHeaders = {
  'x-argus-tenant-key': 'tenant-a',
  'x-argus-workspace-key': 'engineering',
};

describe('workflow HTTP tenant boundary', () => {
  it('loads a visual flow only through the selected authorized scope', async () => {
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM mcp_workflows') && params[1] === 'tenant-a' && params[2] === 'engineering') {
        return { rows: [{
          id: 9, name: 'delivery', description: '', steps: [], input_params: [], canvas_state: {},
          trigger_config: {}, block_definitions: [], source: 'visual', enabled: true,
          updated_at: '2026-09-14T00:00:00.000Z', agent_requirements: [], lifecycle_status: 'draft',
          ai_act_governed: false, ai_system_id: null, ai_system_revision: null,
        }] };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;
    const baseUrl = await serve(app => registerFlowRoutes(app, pool, requireAuth));

    const response = await fetch(`${baseUrl}/api/workflows/9/flow`, { headers: selectedHeaders });
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/tenant_key = \$2/), [9, 'tenant-a', 'engineering']);
  });

  it('rejects an unassigned selector before any workflow SQL executes', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as pg.Pool;
    const baseUrl = await serve(app => registerFlowRoutes(app, pool, requireAuth));

    const response = await fetch(`${baseUrl}/api/workflows/9/flow`, {
      headers: { 'x-argus-tenant-key': 'tenant-b', 'x-argus-workspace-key': 'engineering' },
    });
    expect(response.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('passes the selected scope into Pack-owned workflow lookup', async () => {
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM mcp_workflows w') && params[1] === 'tenant-a' && params[2] === 'engineering') {
        return { rows: [{
          id: 9, name: 'delivery', description: '', updated_at: '2026-09-14T00:00:00.000Z',
          steps: [{ id: 'start', label: 'Start', type: 'trigger.manual', args: {} }],
          input_params: [], agent_requirements: [], bundle_ids: [],
        }] };
      }
      if (sql.includes('FROM mcp_tools') || sql.includes('FROM mcp_remote_tools')) return { rows: [] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;
    const baseUrl = await serve(app => registerBuilderRoutes(app, pool, requireAuth));

    const response = await fetch(`${baseUrl}/api/workflows/9/preflight`, { headers: selectedHeaders });
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/w\.tenant_key = \$2/), [9, 'tenant-a', 'engineering']);
  });

  it('joins version history back to its scoped workflow owner', async () => {
    const query = jest.fn(async (_sql: string, params: unknown[] = []) => ({
      rows: params[1] === 'tenant-a' && params[2] === 'engineering'
        ? [{ version: 3, step_count: 4 }]
        : [],
    }));
    const pool = { query } as unknown as pg.Pool;
    const baseUrl = await serve(app => registerVersionRoutes(app, pool, requireAuth));

    const response = await fetch(`${baseUrl}/api/workflows/9/versions`, { headers: selectedHeaders });
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/JOIN mcp_workflows workflow[\s\S]*workflow\.tenant_key = \$2/),
      [9, 'tenant-a', 'engineering'],
    );
  });
});
