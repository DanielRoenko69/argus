/**
 * Lightweight DB migration runner.
 *
 * - Tracks applied migrations in `mcp_schema_migrations` (filename PK).
 * - On first run against a legacy non-empty DB, the runner enters **baseline
 *   mode** for the fixed historical migration prefix through 131. Newer files
 *   must still run; otherwise adding a migration in the same release that
 *   introduces tracking would incorrectly mark that migration as applied.
 * - Set MIGRATE_MODE=force to bypass baseline and actually execute every
 *   unrecorded migration (use with care; expects all migrations to be
 *   idempotent).
 */

import type pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../lib/logger.js';

const LEGACY_BASELINE_MAX_MIGRATION = 131;
const MIGRATION_LOCK_KEY = 'argus:schema-migrations:v1';

function isLegacyBaselineMigration(file: string): boolean {
  const match = /^(\d+)_/.exec(file);
  if (!match) return false;
  const migrationNumber = Number(match[1]);
  return Number.isSafeInteger(migrationNumber)
    && migrationNumber <= LEGACY_BASELINE_MAX_MIGRATION;
}

export interface MigrateReport {
  baseline:  boolean;
  applied:   string[];
  skipped:   string[];
  failed:    Array<{ name: string; error: string }>;
}

export async function runPendingMigrations(
  pool: pg.Pool,
  migrationsDir: string,
): Promise<MigrateReport> {
  let files: string[];
  try {
    files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    logger.warn({ err, migrationsDir }, 'Migrations dir not found — skipping');
    return { baseline: false, applied: [], skipped: [], failed: [] };
  }

  const client = await pool.connect();
  try {
    // Serialize the entire read/decide/apply sequence across rolling replicas.
    // One held client is also essential for pool.max=1: nested checkouts would
    // deadlock while this session owns the advisory lock.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS mcp_schema_migrations (
        name        VARCHAR(255) PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        baseline    BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);

    const { rows: applied } = await client.query<{ name: string }>('SELECT name FROM mcp_schema_migrations');
    const appliedSet = new Set(applied.map((r) => r.name));
    let enteredBaselineMode = false;
    let freshInstall = false;

  // Baseline mode: tracking table just created (empty), but DB has migration-
  // era tables that tell us migrations were already applied via psql. Marker:
  // `mcp_user_upstream_tokens` (added in migration 086). Reliable because:
  //  - init.sql does NOT create it
  //  - Only present after migrations have been run end-to-end
  //  - Older marker `mcp_composites` no longer works because init.sql now
  //    creates that table to satisfy the FK from mcp_agents.composite_id.
  //
  // Decision tree:
  //   - tracking empty + mcp_user_upstream_tokens exists  → baseline (legacy DB)
  //   - tracking empty + only init.sql tables             → fresh DB, run all
  //   - tracking has entries                              → run unrecorded only
    const force = process.env['MIGRATE_MODE'] === 'force';
    if (appliedSet.size === 0 && files.length > 0) {
      const { rows: marker } = await client.query<{ has_late_marker: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'mcp_user_upstream_tokens'
        ) AS has_late_marker
      `);
      freshInstall = !marker[0]?.has_late_marker;
      if (marker[0]?.has_late_marker && !force) {
      // Legacy DB that already has the historical schema. Baseline only the
      // fixed prefix known to predate automatic migration tracking. Any newer
      // migration in this checkout must proceed through the normal apply loop.
        const legacyFiles = files.filter(isLegacyBaselineMigration);
        for (const f of legacyFiles) {
          await client.query(
            'INSERT INTO mcp_schema_migrations (name, baseline) VALUES ($1, TRUE) ON CONFLICT DO NOTHING',
            [f],
          );
          appliedSet.add(f);
        }
        enteredBaselineMode = true;
        logger.info(
          { count: legacyFiles.length, cutoff: LEGACY_BASELINE_MAX_MIGRATION },
          'Migration runner baselined historical migrations on existing DB',
        );
      } else if (freshInstall) {
        logger.info({ count: files.length }, 'Fresh DB detected — applying all migrations');
      }
      // Fall through to the normal apply loop below.
    }

    // Normal mode: run any unrecorded files in order
    const report: MigrateReport = { baseline: enteredBaselineMode, applied: [], skipped: [], failed: [] };

    for (const file of files) {
      if (appliedSet.has(file)) {
        report.skipped.push(file);
        continue;
      }
    // STOP after the first failure. Migrations are ordered and typically
    // dependent (a later one ALTERs a table an earlier one created). Continuing
    // to apply subsequent files on top of a broken/partial prefix only compounds
    // the damage and produces a confusing half-migrated schema. The failed file
    // stays unrecorded, so it (and the ones we skip here) are retried on the
    // next boot once the root cause is fixed.
      if (report.failed.length > 0) {
        report.skipped.push(file);
        continue;
      }
      const content = await fs.readFile(path.join(migrationsDir, file), 'utf-8');
      try {
        await client.query('BEGIN');
        // Transaction-local bootstrap context for migrations that need to
        // distinguish a genuinely empty installation from an upgrade. This
        // keeps historical seeds immutable while allowing newer migrations to
        // convert them into optional templates on fresh databases only.
        await client.query("SELECT set_config('argus.fresh_install', $1, true)", [freshInstall ? 'true' : 'false']);
        await client.query("SELECT set_config('argus.install_starter_agents', $1, true)", [
          process.env['ARGUS_INSTALL_STARTER_AGENTS'] === 'true' ? 'true' : 'false',
        ]);
        await client.query(content);
        await client.query('INSERT INTO mcp_schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        report.applied.push(file);
        logger.info({ migration: file }, 'Migration applied');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        report.failed.push({ name: file, error: msg });
        logger.error({ migration: file, err: msg }, 'Migration FAILED — halting migration run (subsequent migrations skipped to avoid a partial schema)');
      }
    }

    return report;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
