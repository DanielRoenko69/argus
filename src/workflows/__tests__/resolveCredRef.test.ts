import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { describeLiveDb } from '../../__tests__/helpers/liveDb.js';
import pg from 'pg';
import { encrypt } from '../../lib/encryption.js';
import { resolveBundleBackendCreds } from '../backendCredsStore.js';

describeLiveDb('resolveBundleBackendCreds — integration against live Postgres', () => {
  let pool: pg.Pool;
  let backendId: number;
  let bundleId: number;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env['POSTGRES_CONNECTION_URL']
        ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    });
    const r1 = await pool.query(`
      INSERT INTO mcp_backends (name, description, base_url, auth_type, auth_value, config, enabled)
      VALUES ('bitbucket-test-d2', 'd2 test', 'https://d2.test', 'bearer', $1,
              jsonb_build_object('kind', 'bitbucket'), true)
      ON CONFLICT (name) DO UPDATE SET auth_value = EXCLUDED.auth_value
      RETURNING id
    `, [encrypt('token-d2')]);
    backendId = r1.rows[0].id;
    const r2 = await pool.query(`
      INSERT INTO mcp_service_bundles (name, label, description)
      VALUES ('d2-test-bundle', 'D2 Test', 'd2 test')
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description
      RETURNING id
    `);
    bundleId = r2.rows[0].id;
    await pool.query(`
      INSERT INTO mcp_backend_bundles (backend_id, bundle_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `, [backendId, bundleId]);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query('DELETE FROM mcp_backend_bundles WHERE backend_id = $1', [backendId]);
      await pool.query('DELETE FROM mcp_service_bundles WHERE id = $1', [bundleId]);
      await pool.query('DELETE FROM mcp_backends WHERE id = $1', [backendId]);
    } finally {
      await pool.end();
    }
  });

  it('resolves bundle → backend creds + decrypts token', async () => {
    const creds = await resolveBundleBackendCreds(pool, bundleId);
    expect(creds).not.toBeNull();
    expect(creds!.backend_id).toBe(backendId);
    expect(creds!.backend_name).toBe('bitbucket-test-d2');
    expect(creds!.base_url).toBe('https://d2.test');
    expect(creds!.token).toBe('token-d2');
  });

  it('honours an explicit backend_cred_id pin within the bundle', async () => {
    const creds = await resolveBundleBackendCreds(pool, bundleId, backendId);
    expect(creds!.backend_id).toBe(backendId);
    expect(creds!.token).toBe('token-d2');
  });

  it('returns null when backend_cred_id is not in the bundle', async () => {
    const creds = await resolveBundleBackendCreds(pool, bundleId, 999999);
    expect(creds).toBeNull();
  });

  it('returns null for an empty/unknown bundle', async () => {
    const orphan = await pool.query(`
      INSERT INTO mcp_service_bundles (name, label, description)
      VALUES ('d2-orphan-bundle', 'D2 Orphan', 'no backends')
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id
    `);
    const orphanId = orphan.rows[0].id;
    try {
      expect(await resolveBundleBackendCreds(pool, orphanId)).toBeNull();
    } finally {
      await pool.query('DELETE FROM mcp_service_bundles WHERE id = $1', [orphanId]);
    }
  });

  it('rejects invalid bundleId', async () => {
    await expect(resolveBundleBackendCreds(pool, 0)).rejects.toThrow(/invalid bundleId/);
  });
});
