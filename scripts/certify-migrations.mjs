#!/usr/bin/env node
/**
 * Upgrade/idempotency gate for a disposable PostgreSQL database.
 *
 * It never points at POSTGRES_CONNECTION_URL implicitly. Set
 * MIGRATION_CERTIFICATION_DATABASE_URL to an explicitly disposable database;
 * without it the result is `not_run` rather than mutating a developer DB.
 */

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
const migrationDir = resolve(process.env.ARGUS_MIGRATION_DIR || 'db/migrations');
const reportPath = process.env.ARGUS_MIGRATION_CERTIFICATION_REPORT || 'test-results/migration-certification.json';
const databaseUrl = (process.env.MIGRATION_CERTIFICATION_DATABASE_URL || '').trim();
const required = process.env.MIGRATION_CERTIFICATION_REQUIRED === '1';

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 320) || 'unknown error';
}

async function listMigrations() {
  const files = (await readdir(migrationDir)).filter(file => file.endsWith('.sql')).sort();
  const parsed = files.map(file => {
    const match = /^(\d+)_([^/]+)\.sql$/.exec(file);
    return match ? { file, number: Number(match[1]) } : { file, number: null };
  });
  const invalid = parsed.filter(item => item.number === null).map(item => item.file);
  const duplicates = [...new Set(parsed.filter(item => item.number !== null).map(item => item.number))]
    .filter(number => parsed.filter(item => item.number === number).length > 1);
  const numericOrder = [...parsed].sort((left, right) => (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER)).map(item => item.file);
  const ordered = invalid.length === 0 && numericOrder.join('\n') === files.join('\n');
  return { files, count: files.length, invalid, duplicates, ordered };
}

async function main() {
  const listing = await listMigrations();
  const report = {
    generated_at: new Date().toISOString(),
    status: 'not_run',
    migration_count: listing.count,
    naming: { invalid: listing.invalid, duplicate_numbers: listing.duplicates, ordered: listing.ordered },
    database: 'disposable database not configured',
  };
  if (listing.invalid.length || listing.duplicates.length || !listing.ordered) {
    report.status = 'failed';
    report.database = 'not checked because migration ordering is invalid';
  } else if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
    try {
      // Load the compiled runner so this gate certifies the exact application
      // migration implementation shipped in the release image.
      const { runPendingMigrations } = await import('../dist/db/migrate.js');
      const first = await runPendingMigrations(pool, migrationDir);
      const second = await runPendingMigrations(pool, migrationDir);
      const { rows } = await pool.query('SELECT count(*)::int AS count FROM mcp_schema_migrations');
      report.database = {
        schema_rows: Number(rows[0]?.count ?? 0),
        first_run: { applied: first.applied.length, skipped: first.skipped.length, failed: first.failed.length, baseline: first.baseline },
        second_run: { applied: second.applied.length, skipped: second.skipped.length, failed: second.failed.length, baseline: second.baseline },
      };
      report.status = first.failed.length || second.failed.length || second.applied.length ? 'failed' : 'passed';
    } catch (error) {
      report.status = 'failed';
      report.database = safeError(error);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (required && report.status !== 'passed') process.exitCode = 2;
  if (report.status === 'failed') process.exitCode = 2;
}

try { await main(); } catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
