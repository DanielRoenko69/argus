import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { describeLiveDb } from '../../__tests__/helpers/liveDb.js';
import pg from 'pg';
import { encrypt } from '../../lib/encryption.js';
import { getWorkflowBackendCreds } from '../backendCredsStore.js';

describeLiveDb('getWorkflowBackendCreds — integration against live Postgres', () => {
  let pool: pg.Pool;
  let backendId: number;
  let bundleId: number;
  let workflowId: number;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env['POSTGRES_CONNECTION_URL']
        ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    });

    // Create a test backend + bundle + workflow setup we can clean up after
    const r1 = await pool.query(`
      INSERT INTO mcp_backends (name, description, base_url, auth_type, auth_value, config, enabled)
      VALUES ('bitbucket-test-r1', 'r1 test', 'https://example.test', 'bearer', $1,
              jsonb_build_object('kind', 'bitbucket', 'project_key', 'TEST'), true)
      ON CONFLICT (name) DO UPDATE SET auth_value = EXCLUDED.auth_value
      RETURNING id
    `, [encrypt('test-token-r1')]);
    backendId = r1.rows[0].id;

    const r2 = await pool.query(`
      INSERT INTO mcp_service_bundles (name, label, description)
      VALUES ('r1-test-bundle', 'R1 Test', 'r1 test')
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
      RETURNING id
    `);
    bundleId = r2.rows[0].id;

    await pool.query(`
      INSERT INTO mcp_backend_bundles (backend_id, bundle_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [backendId, bundleId]);

    const r3 = await pool.query(`
      INSERT INTO mcp_workflows (name, description, steps, input_params)
      VALUES ('r1_test_workflow', 'r1 test', '[]'::jsonb, '[]'::jsonb)
      ON CONFLICT (tenant_key, workspace_key, name) DO UPDATE SET description = EXCLUDED.description
      RETURNING id
    `);
    workflowId = r3.rows[0].id;

    await pool.query(`
      INSERT INTO mcp_workflow_bundles (workflow_id, bundle_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [workflowId, bundleId]);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM mcp_workflow_bundles WHERE workflow_id = $1', [workflowId]);
      await pool.query('DELETE FROM mcp_backend_bundles WHERE backend_id = $1', [backendId]);
      await pool.query('DELETE FROM mcp_workflows WHERE id = $1', [workflowId]);
      await pool.query('DELETE FROM mcp_service_bundles WHERE id = $1', [bundleId]);
      await pool.query('DELETE FROM mcp_backends WHERE id = $1', [backendId]);
    } finally {
      await pool.end();
    }
  });

  it('resolves creds via workflow → bundle → backend join + decrypts token', async () => {
    const creds = await getWorkflowBackendCreds(pool, workflowId, 'bitbucket');
    expect(creds).not.toBeNull();
    expect(creds!.backend_name).toBe('bitbucket-test-r1');
    expect(creds!.base_url).toBe('https://example.test');
    expect(creds!.token).toBe('test-token-r1');
    expect(creds!.config['kind']).toBe('bitbucket');
    expect(creds!.config['project_key']).toBe('TEST');
  });

  it('returns null when no backend matches the kind', async () => {
    const creds = await getWorkflowBackendCreds(pool, workflowId, 'gitea');
    expect(creds).toBeNull();
  });

  it('returns null when workflow has no bundles', async () => {
    const orphan = await pool.query(`
      INSERT INTO mcp_workflows (name, description, steps, input_params)
      VALUES ('r1_test_orphan_wf', 'orphan', '[]'::jsonb, '[]'::jsonb)
      ON CONFLICT (tenant_key, workspace_key, name) DO UPDATE SET description = EXCLUDED.description
      RETURNING id
    `);
    const orphanId = orphan.rows[0].id;
    try {
      const creds = await getWorkflowBackendCreds(pool, orphanId, 'bitbucket');
      expect(creds).toBeNull();
    } finally {
      await pool.query('DELETE FROM mcp_workflows WHERE id = $1', [orphanId]);
    }
  });

  it('returns NULL token when backend has no auth_value set', async () => {
    // Keep the fixture independent from optional/demo seeds.
    const tmpBundle = await pool.query(`
      INSERT INTO mcp_service_bundles (name, label, description)
      VALUES ('r1-null-token-bundle', 'R1 NullTok', 't')
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id
    `);
    const tmpBundleId = tmpBundle.rows[0].id;
    const tmpWf = await pool.query(`
      INSERT INTO mcp_workflows (name, description, steps, input_params)
      VALUES ('r1_null_token_wf', 't', '[]'::jsonb, '[]'::jsonb)
      ON CONFLICT (tenant_key, workspace_key, name) DO UPDATE SET description = EXCLUDED.description RETURNING id
    `);
    const tmpWfId = tmpWf.rows[0].id;
    const bdef = await pool.query(`
      INSERT INTO mcp_backends (name, description, base_url, auth_type, auth_value, config, enabled)
      VALUES ('r1-null-token-backend', 't', 'https://null-token.test', 'bearer', NULL,
              jsonb_build_object('kind', 'bitbucket'), true)
      ON CONFLICT (name) DO UPDATE SET auth_value = NULL
      RETURNING id
    `);
    const bdefId = bdef.rows[0].id;
    try {
      await pool.query(`INSERT INTO mcp_backend_bundles (backend_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [bdefId, tmpBundleId]);
      await pool.query(`INSERT INTO mcp_workflow_bundles (workflow_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tmpWfId, tmpBundleId]);

      const creds = await getWorkflowBackendCreds(pool, tmpWfId, 'bitbucket');
      expect(creds).not.toBeNull();
      expect(creds!.token).toBeNull();    // not set yet
      expect(creds!.backend_name).toBe('r1-null-token-backend');
    } finally {
      await pool.query('DELETE FROM mcp_backend_bundles WHERE backend_id = $1 AND bundle_id = $2', [bdefId, tmpBundleId]);
      await pool.query('DELETE FROM mcp_workflow_bundles WHERE workflow_id = $1', [tmpWfId]);
      await pool.query('DELETE FROM mcp_workflows WHERE id = $1', [tmpWfId]);
      await pool.query('DELETE FROM mcp_service_bundles WHERE id = $1', [tmpBundleId]);
      await pool.query('DELETE FROM mcp_backends WHERE id = $1', [bdefId]);
    }
  });

  it('rejects invalid input', async () => {
    await expect(getWorkflowBackendCreds(pool, 0, 'bitbucket')).rejects.toThrow(/invalid workflowId/);
    await expect(getWorkflowBackendCreds(pool, workflowId, 'bad kind!')).rejects.toThrow(/invalid kind/);
  });
});
