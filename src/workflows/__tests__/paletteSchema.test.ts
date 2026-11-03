import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { describeLiveDb } from '../../__tests__/helpers/liveDb.js';
import express from 'express';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import pg from 'pg';
import { registerFlowRoutes } from '../flowRoutes.js';
import { loadAccessiblePaletteForTest } from '../copilotRoutes.js';

// Pass-through auth: stamps an admin RbacUser then continues.
function fakeAuth(role: 'admin' | 'user', allowed: number[] | null) {
  return (req: Request, _res: Response, next: () => void): void => {
    (req as unknown as { user: { role: string; allowed_bundles: number[] | null } }).user = {
      role,
      allowed_bundles: allowed,
    };
    next();
  };
}

describeLiveDb('workflow palette — tool arg-schemas (P2-4)', () => {
  let pool: pg.Pool;
  let app: express.Express;
  let server: Server;
  let baseUrl: string;
  let typedToolId: number;
  let freeformToolId: number;
  let bundleId: number;
  let boundToolId: number;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env['POSTGRES_CONNECTION_URL']
        ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    });

    // Typed tool: non-empty parameters array.
    const t1 = await pool.query<{ id: number }>(`
      INSERT INTO mcp_tools (name, description, backend, query_template, parameters, enabled, tool_type)
      VALUES ('palette_typed_tool_p24', 'typed', 'postgresql', 'SELECT 1',
              '[{"name":"document_id","type":"string","required":true,"description":"The doc id"}]'::jsonb,
              true, 'dynamic')
      ON CONFLICT (name) DO UPDATE SET parameters = EXCLUDED.parameters, enabled = true RETURNING id
    `);
    typedToolId = t1.rows[0]!.id;

    // Freeform tool: empty parameters array.
    const t2 = await pool.query<{ id: number }>(`
      INSERT INTO mcp_tools (name, description, backend, query_template, parameters, enabled, tool_type)
      VALUES ('palette_freeform_tool_p24', 'freeform', 'postgresql', 'SELECT 1',
              '[]'::jsonb, true, 'dynamic')
      ON CONFLICT (name) DO UPDATE SET parameters = EXCLUDED.parameters, enabled = true RETURNING id
    `);
    freeformToolId = t2.rows[0]!.id;

    // RBAC fixture: a bundle-bound tool the non-admin user is NOT in.
    const b = await pool.query<{ id: number }>(`
      INSERT INTO mcp_service_bundles (name, label, description)
      VALUES ('p24-rbac-bundle', 'P24', 'p24')
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id
    `);
    bundleId = b.rows[0]!.id;
    const t3 = await pool.query<{ id: number }>(`
      INSERT INTO mcp_tools (name, description, backend, query_template, parameters, enabled, tool_type)
      VALUES ('palette_bound_tool_p24', 'bound', 'postgresql', 'SELECT 1', '[]'::jsonb, true, 'dynamic')
      ON CONFLICT (name) DO UPDATE SET enabled = true RETURNING id
    `);
    boundToolId = t3.rows[0]!.id;
    await pool.query(
      `INSERT INTO mcp_tool_bundles (tool_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [boundToolId, bundleId]
    );

    app = express();
    app.use(express.json());
    registerFlowRoutes(app, pool, fakeAuth('admin', null));
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    const addr = server.address();
    if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
    else throw new Error('test server failed to bind');
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pool) {
      try {
        await pool.query('DELETE FROM mcp_tool_bundles WHERE tool_id = $1', [boundToolId]);
        await pool.query("DELETE FROM mcp_tools WHERE name IN ('palette_typed_tool_p24','palette_freeform_tool_p24','palette_bound_tool_p24')");
        await pool.query('DELETE FROM mcp_service_bundles WHERE id = $1', [bundleId]);
      } finally {
        await pool.end();
      }
    }
  });

  it('palette includes typed parameters + schema:typed for a tool with params', async () => {
    const r = await fetch(`${baseUrl}/api/workflows/palette`);
    expect(r.status).toBe(200);
    const body = await r.json() as {
      tools: Array<{ id: number; name: string; parameters: Array<{ name: string; type: string; required: boolean; description?: string }>; schema: string }>;
    };
    const typed = body.tools.find((t) => t.id === typedToolId);
    expect(typed).toBeDefined();
    expect(typed!.schema).toBe('typed');
    expect(Array.isArray(typed!.parameters)).toBe(true);
    expect(typed!.parameters).toHaveLength(1);
    expect(typed!.parameters[0]!.name).toBe('document_id');
    expect(typed!.parameters[0]!.type).toBe('string');
    expect(typed!.parameters[0]!.required).toBe(true);
  });

  it('palette returns schema:freeform + empty parameters for a no-param tool', async () => {
    const r = await fetch(`${baseUrl}/api/workflows/palette`);
    const body = await r.json() as {
      tools: Array<{ id: number; parameters: unknown[]; schema: string }>;
    };
    const free = body.tools.find((t) => t.id === freeformToolId);
    expect(free).toBeDefined();
    expect(free!.schema).toBe('freeform');
    expect(free!.parameters).toEqual([]);
  });

  it('copilot palette includes parameters for typed tools', async () => {
    const palette = await loadAccessiblePaletteForTest(pool, null);
    const typed = palette.tools.find((t) => t.id === typedToolId);
    expect(typed).toBeDefined();
    expect(typed!.parameters).toHaveLength(1);
    expect(typed!.parameters[0]!.name).toBe('document_id');
    expect(typed!.parameters[0]!.required).toBe(true);
  });

  it('copilot palette stays RBAC-filtered: bundle-bound tool hidden from non-member', async () => {
    const adminPalette = await loadAccessiblePaletteForTest(pool, null);
    expect(adminPalette.tools.some((t) => t.id === boundToolId)).toBe(true);

    const userPalette = await loadAccessiblePaletteForTest(pool, []);
    expect(userPalette.tools.some((t) => t.id === boundToolId)).toBe(false);
    // Freeform (unbound) tool stays visible to the restricted user.
    expect(userPalette.tools.some((t) => t.id === freeformToolId)).toBe(true);
  });
});
