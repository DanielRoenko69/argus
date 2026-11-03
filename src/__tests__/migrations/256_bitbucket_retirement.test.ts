import { afterAll, beforeAll, expect, it } from '@jest/globals';
import { describeLiveDb } from '../helpers/liveDb.js';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

describeLiveDb('Migration 256 — legacy Bitbucket placeholder retirement', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env['POSTGRES_CONNECTION_URL']
        ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('removes the untouched bitbucket-default placeholder', async () => {
    const { rows } = await pool.query(`
      SELECT id
        FROM mcp_backends
       WHERE name = 'bitbucket-default'
         AND base_url = 'https://bitbucket.example.com'
         AND auth_type = 'bearer'
         AND auth_value IS NULL
         AND config = jsonb_build_object(
           'kind', 'bitbucket',
           'project_key', '',
           'user_slug', '',
           'repo_slug', '',
           'default_target_branch', 'master'
         )
    `);

    expect(rows).toHaveLength(0);
  });

  it('keeps the reusable coding-ops bundle', async () => {
    const { rows } = await pool.query(`
      SELECT name FROM mcp_service_bundles WHERE name = 'coding-ops'
    `);

    expect(rows).toHaveLength(1);
  });

  it('leaves no coding-ops link to the retired placeholder', async () => {
    const { rows } = await pool.query(`
      SELECT 1
        FROM mcp_backend_bundles bb
        JOIN mcp_backends b ON b.id = bb.backend_id
        JOIN mcp_service_bundles sb ON sb.id = bb.bundle_id
       WHERE b.name = 'bitbucket-default'
         AND b.base_url = 'https://bitbucket.example.com'
         AND sb.name = 'coding-ops'
    `);

    expect(rows).toHaveLength(0);
  });

  it('preserves an operator-configured backend with the historical name', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO mcp_backends (
          name, description, base_url, auth_type, auth_value,
          health_path, default_headers, timeout_ms, tls_skip_verify, enabled,
          backend_type, config
        ) VALUES (
          'bitbucket-default',
          'Operator-configured Bitbucket backend',
          'https://bitbucket.corp.example',
          'bearer',
          'encrypted-operator-token',
          '/status',
          '{}'::jsonb,
          30000,
          false,
          true,
          'http',
          '{"kind":"bitbucket","project_key":"ARGUS","repo_slug":"core"}'::jsonb
        )
      `);

      const migration = await readFile(
        'db/migrations/256_retire_legacy_bitbucket_default.sql',
        'utf8',
      );
      await client.query(migration);

      const { rows } = await client.query(`
        SELECT base_url, auth_value
          FROM mcp_backends
         WHERE name = 'bitbucket-default'
      `);
      expect(rows).toEqual([{
        base_url: 'https://bitbucket.corp.example',
        auth_value: 'encrypted-operator-token',
      }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
