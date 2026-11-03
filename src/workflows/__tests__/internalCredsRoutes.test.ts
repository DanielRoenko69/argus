import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { describeLiveDb } from '../../__tests__/helpers/liveDb.js';
import express from 'express';
import type { Server } from 'node:http';
import pg from 'pg';
import { encrypt } from '../../lib/encryption.js';
import { createInternalCredsRouter } from '../internalCredsRoutes.js';

describeLiveDb('GET /api/internal/workflow-creds — integration', () => {
  let pool: pg.Pool;
  let app: express.Express;
  let server: Server;
  let baseUrl: string;
  let backendId: number;
  let bundleId: number;
  let workflowId: number;
  const SECRET = 'test-workspace-secret-r2';

  beforeAll(async () => {
    process.env['WORKSPACE_SECRET'] = SECRET;
    pool = new pg.Pool({
      connectionString: process.env['POSTGRES_CONNECTION_URL']
        ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    });

    // Seed
    const r1 = await pool.query(`
      INSERT INTO mcp_backends (name, description, base_url, auth_type, auth_value, config, enabled)
      VALUES ('bitbucket-test-r2', 'r2', 'https://r2.test', 'bearer', $1,
              jsonb_build_object('kind', 'bitbucket'), true)
      ON CONFLICT (name) DO UPDATE SET auth_value = EXCLUDED.auth_value RETURNING id
    `, [encrypt('secret-token-r2')]);
    backendId = r1.rows[0].id;
    const r2 = await pool.query(`
      INSERT INTO mcp_service_bundles (name, label, description)
      VALUES ('r2-test-bundle', 'R2', 'r2')
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id
    `);
    bundleId = r2.rows[0].id;
    await pool.query(`INSERT INTO mcp_backend_bundles (backend_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [backendId, bundleId]);
    const r3 = await pool.query(`
      INSERT INTO mcp_workflows (name, description, steps, input_params)
      VALUES ('r2_test_workflow', 'r2', '[]'::jsonb, '[]'::jsonb)
      ON CONFLICT (tenant_key, workspace_key, name) DO UPDATE SET description = EXCLUDED.description RETURNING id
    `);
    workflowId = r3.rows[0].id;
    await pool.query(`INSERT INTO mcp_workflow_bundles (workflow_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [workflowId, bundleId]);

    app = express();
    app.use(createInternalCredsRouter(pool));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
    else throw new Error('test server failed to bind');
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pool) {
      try {
        await pool.query('DELETE FROM mcp_workflow_bundles WHERE workflow_id = $1', [workflowId]);
        await pool.query('DELETE FROM mcp_backend_bundles WHERE backend_id = $1', [backendId]);
        await pool.query('DELETE FROM mcp_workflows WHERE id = $1', [workflowId]);
        await pool.query('DELETE FROM mcp_service_bundles WHERE id = $1', [bundleId]);
        await pool.query('DELETE FROM mcp_backends WHERE id = $1', [backendId]);
      } finally {
        await pool.end();
      }
    }
  });

  it('200 with decrypted token on valid secret + valid workflow', async () => {
    const r = await fetch(`${baseUrl}/api/internal/workflow-creds/${workflowId}/bitbucket`, {
      headers: { 'X-Workspace-Secret': SECRET },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { token: string; base_url: string; backend_name: string; config: { kind: string } };
    expect(body.token).toBe('secret-token-r2');
    expect(body.base_url).toBe('https://r2.test');
    expect(body.backend_name).toBe('bitbucket-test-r2');
    expect(body.config.kind).toBe('bitbucket');
  });

  it('401 on missing secret', async () => {
    const r = await fetch(`${baseUrl}/api/internal/workflow-creds/${workflowId}/bitbucket`);
    expect(r.status).toBe(401);
  });

  it('401 on wrong secret', async () => {
    const r = await fetch(`${baseUrl}/api/internal/workflow-creds/${workflowId}/bitbucket`, {
      headers: { 'X-Workspace-Secret': 'wrong' },
    });
    expect(r.status).toBe(401);
  });

  it('400 on non-integer workflowId', async () => {
    const r = await fetch(`${baseUrl}/api/internal/workflow-creds/abc/bitbucket`, {
      headers: { 'X-Workspace-Secret': SECRET },
    });
    expect(r.status).toBe(400);
  });

  it('400 on invalid backendKind chars', async () => {
    const r = await fetch(`${baseUrl}/api/internal/workflow-creds/${workflowId}/bad%20kind`, {
      headers: { 'X-Workspace-Secret': SECRET },
    });
    expect(r.status).toBe(400);
  });

  it('404 when no matching backend kind', async () => {
    const r = await fetch(`${baseUrl}/api/internal/workflow-creds/${workflowId}/gitea`, {
      headers: { 'X-Workspace-Secret': SECRET },
    });
    expect(r.status).toBe(404);
  });
});
