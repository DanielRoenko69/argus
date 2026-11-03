#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createEncryptedRecoveryBundle,
  openEncryptedRecoveryBundle,
  recoverySha256,
} from './lib/pilot-recovery-bundle.mjs';

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = 'argus-pilot-recovery';
const compose = ['compose', '-p', project, '-f', 'compose.pilot-recovery.yml'];
const sourcePort = Number(process.env.ARGUS_PILOT_SOURCE_DB_PORT || 55439);
const restorePort = Number(process.env.ARGUS_PILOT_RESTORE_DB_PORT || 55440);
const sourceUrl = `postgresql://argus_recovery:argus_recovery_local_only@127.0.0.1:${sourcePort}/argus_source`;
const restoreUrl = `postgresql://argus_recovery:argus_recovery_local_only@127.0.0.1:${restorePort}/argus_restore`;
const reportPath = resolve(root, process.env.ARGUS_PILOT_RECOVERY_REPORT || 'test-results/pilot-recovery-certification.json');
const bundlePath = resolve(root, process.env.ARGUS_PILOT_RECOVERY_BUNDLE || 'test-results/pilot-recovery.argus-backup.json');
const restoredWorkspace = resolve(root, '.tmp', 'pilot-recovery-restored-workspace');
const backupKey = process.env.ARGUS_PILOT_BACKUP_KEY
  || `ephemeral-certification-${randomBytes(32).toString('hex')}`;
const checks = [];
let cleanupStarted = false;

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer|key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1000) || 'unknown error';
}

function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', shell: false, windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim().slice(0, 128) : null;
}

function docker(args, label, input = undefined, binary = false) {
  const startedAt = Date.now();
  const result = spawnSync('docker', [...compose, ...args], {
    cwd: root,
    input,
    encoding: binary ? null : 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || Buffer.from(result.stderr || '').toString('utf8').slice(-2000);
    throw new Error(`${label} failed: ${detail}`);
  }
  checks.push({ label, status: 'passed', durationMs: Date.now() - startedAt });
  return result.stdout;
}

function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  spawnSync('docker', [...compose, 'down', '--volumes', '--remove-orphans'], {
    cwd: root, encoding: 'utf8', shell: false, windowsHide: true,
  });
}

async function configInventory() {
  const paths = ['docker-compose.yml', 'compose.pilot-recovery.yml', 'package-lock.json'];
  return Promise.all(paths.map(async path => ({
    path,
    sha256: recoverySha256(await readFile(resolve(root, path))),
  })));
}

async function seed(pool) {
  const suffix = randomBytes(6).toString('hex');
  const users = [];
  for (const tenant of ['tenant-a', 'tenant-b']) {
    const inserted = await pool.query(
      `INSERT INTO mcp_users (username,password_hash,display_name,role,enabled)
       VALUES ($1,$2,$3,'platform_admin',TRUE) RETURNING id,username`,
      [`pilot-recovery-${tenant}-${suffix}`, 'certification-only-not-a-login-hash', `Pilot ${tenant}`],
    );
    const user = inserted.rows[0];
    await pool.query('DELETE FROM mcp_workspace_memberships WHERE user_id=$1', [user.id]);
    await pool.query(
      `INSERT INTO mcp_workspace_memberships (user_id,tenant_key,workspace_key,is_default)
       VALUES ($1,$2,'shared-name',TRUE)`,
      [user.id, tenant],
    );
    users.push({ ...user, tenant });
  }

  const { executeCanonicalAuditedMutation } = await import('../dist/audit/canonicalAuditStore.js');
  const { createAuditReportDefinition } = await import('../dist/audit/reportStore.js');
  const events = [];
  const definitions = [];
  for (const user of users) {
    const scope = { tenantKey: user.tenant, workspaceKey: 'shared-name', environment: 'certification' };
    const event = await executeCanonicalAuditedMutation(
      pool,
      { name: 'pilot-recovery-certifier', eventId: `${user.tenant}-${suffix}` },
      scope,
      async () => ({ resourceId: 'same-named-resource' }),
      result => ({
        ...scope,
        solution: 'argus.core',
        actor: { type: 'system', id: 'pilot-recovery-certifier', authMethod: 'internal', effectiveRoles: ['system'] },
        action: 'pilot.recovery.seeded', outcome: 'success', risk: 'low',
        resource: { type: 'pilot_fixture', id: result.resourceId, revision: '1' },
        payload: { context: { tenant: user.tenant, secret: '[excluded]' } },
      }),
    );
    events.push(event.event);
    definitions.push(await createAuditReportDefinition(pool, {
      ...scope,
      name: 'Same named governance report', reportType: 'governance', cadence: 'manual',
      timezone: 'Europe/Berlin', scheduleHour: 8, scheduleWeekday: null, scheduleMonthday: null,
      windowDays: 30, filters: {}, formats: ['pdf', 'json', 'csv'], createdBy: String(user.id),
      now: new Date(),
    }));
  }
  return { users, events, definitions, latestDataAt: new Date() };
}

async function snapshot(pool, usernames) {
  const [migrations, users, memberships, events, reports] = await Promise.all([
    pool.query('SELECT name,baseline FROM mcp_schema_migrations ORDER BY name'),
    pool.query('SELECT id,username,role,enabled FROM mcp_users WHERE username=ANY($1::text[]) ORDER BY username', [usernames]),
    pool.query(`SELECT u.username,m.tenant_key,m.workspace_key,m.is_default
                  FROM mcp_workspace_memberships m JOIN mcp_users u ON u.id=m.user_id
                 WHERE u.username=ANY($1::text[]) ORDER BY u.username,m.tenant_key,m.workspace_key`, [usernames]),
    pool.query(`SELECT tenant_key,workspace_key,environment,producer_name,producer_event_id,
                       resource_type,resource_id,event_hash,previous_hash
                  FROM mcp_canonical_audit_events
                 WHERE producer_name='pilot-recovery-certifier' ORDER BY tenant_key,sequence`),
    pool.query(`SELECT id,tenant_key,workspace_key,environment,name,report_type,cadence,formats
                  FROM mcp_audit_report_definitions
                 WHERE name='Same named governance report' ORDER BY tenant_key,id`),
  ]);
  const data = {
    migrations: migrations.rows,
    users: users.rows,
    memberships: memberships.rows,
    events: events.rows,
    reports: reports.rows,
  };
  return { data, sha256: recoverySha256(Buffer.from(JSON.stringify(data), 'utf8')) };
}

async function verifyIsolation(pool, definitions) {
  const { getAuditReportDefinition, listAuditReportDefinitions } = await import('../dist/audit/reportStore.js');
  const tenantA = await listAuditReportDefinitions(pool, 'shared-name', 'tenant-a');
  const tenantB = await listAuditReportDefinitions(pool, 'shared-name', 'tenant-b');
  const cross = await getAuditReportDefinition(pool, definitions[0].id, 'shared-name', 'tenant-b');
  if (tenantA.length !== 1 || tenantB.length !== 1 || tenantA[0].tenantKey === tenantB[0].tenantKey || cross !== null) {
    throw new Error('restored report definitions crossed the tenant boundary');
  }
}

async function main() {
  const startedAt = new Date();
  cleanup();
  cleanupStarted = false;
  docker(['up', '--detach', '--wait', 'pilot-source-db', 'pilot-restore-db'], 'fresh-source-and-restore-databases');
  const source = new Pool({ connectionString: sourceUrl, max: 2 });
  const target = new Pool({ connectionString: restoreUrl, max: 2 });
  try {
    const migrationStarted = Date.now();
    const { runPendingMigrations } = await import('../dist/db/migrate.js');
    const migrated = await runPendingMigrations(source, resolve(root, 'db/migrations'));
    if (migrated.failed.length) throw new Error(`source migrations failed: ${JSON.stringify(migrated.failed)}`);
    checks.push({ label: 'source-migrations', status: 'passed', durationMs: Date.now() - migrationStarted, applied: migrated.applied.length });
    const repeated = await runPendingMigrations(source, resolve(root, 'db/migrations'));
    if (repeated.failed.length || repeated.applied.length) {
      throw new Error(`source migrations were not idempotent: ${JSON.stringify(repeated)}`);
    }
    checks.push({ label: 'source-migration-idempotency', status: 'passed', durationMs: 0, applied: 0 });

    const seeded = await seed(source);
    await verifyIsolation(source, seeded.definitions);
    checks.push({ label: 'source-two-tenant-isolation', status: 'passed', durationMs: 0 });
    const sourceSnapshot = await snapshot(source, seeded.users.map(user => user.username));

    const backupStartedAt = new Date();
    const databaseArchive = Buffer.from(docker([
      'exec', '-T', 'pilot-source-db', 'pg_dump', '-U', 'argus_recovery', '-d', 'argus_source',
      '--format=custom', '--no-owner', '--no-acl',
    ], 'postgres-custom-backup', undefined, true));
    const workspaceFiles = seeded.users.map(user => ({
      path: `runs/${user.tenant}/shared-name/recovery-receipt.json`,
      content: Buffer.from(JSON.stringify({ tenantKey: user.tenant, workspaceKey: 'shared-name', state: 'sealed' })),
    }));
    const bundle = createEncryptedRecoveryBundle({
      databaseArchive,
      gitRevision: process.env.GIT_REVISION || gitRevision(),
      workspaceFiles,
      configuration: await configInventory(),
      wormReceipts: seeded.events.map(event => ({
        objectKey: `${event.tenantKey}/${event.workspaceKey}/${event.eventId}`,
        digest: event.eventHash,
        providerRole: 'independent-retention-boundary',
      })),
    }, backupKey, backupStartedAt);
    await mkdir(dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, `${JSON.stringify(bundle)}\n`, 'utf8');
    if (JSON.stringify(bundle).includes(backupKey)) throw new Error('encrypted bundle exposed its encryption key');
    checks.push({ label: 'encrypted-versioned-backup-bundle', status: 'passed', durationMs: Date.now() - backupStartedAt.getTime() });

    const restoreStartedAt = Date.now();
    const opened = openEncryptedRecoveryBundle(JSON.parse(await readFile(bundlePath, 'utf8')), backupKey);
    docker([
      'exec', '-T', 'pilot-restore-db', 'pg_restore', '--exit-on-error', '--no-owner', '--no-acl',
      '-U', 'argus_recovery', '-d', 'argus_restore',
    ], 'fresh-database-restore', opened.databaseArchive, false);
    await rm(restoredWorkspace, { recursive: true, force: true });
    for (const file of opened.workspaceFiles) {
      const targetPath = resolve(restoredWorkspace, file.path);
      const targetRelative = relative(restoredWorkspace, targetPath);
      if (!targetRelative || targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
        throw new Error('workspace restore path escaped its target boundary');
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content);
    }
    const targetSnapshot = await snapshot(target, seeded.users.map(user => user.username));
    if (targetSnapshot.sha256 !== sourceSnapshot.sha256) throw new Error('restored database snapshot differs from source');
    await verifyIsolation(target, seeded.definitions);
    for (const file of opened.workspaceFiles) {
      if (recoverySha256(await readFile(resolve(restoredWorkspace, file.path))) !== file.sha256) {
        throw new Error(`restored workspace artifact differs: ${file.path}`);
      }
    }
    const rtoMs = Date.now() - restoreStartedAt;
    const rpoMs = Math.max(0, backupStartedAt.getTime() - seeded.latestDataAt.getTime());
    checks.push({ label: 'restored-state-and-scope-verification', status: 'passed', durationMs: rtoMs });
    const report = {
      schemaVersion: 1,
      kind: 'argus.pilot-recovery-certification',
      status: 'passed',
      generatedAt: new Date().toISOString(),
      source: { snapshotSha256: sourceSnapshot.sha256 },
      restored: { snapshotSha256: targetSnapshot.sha256, freshDatabase: true, workspaceFiles: opened.manifest.workspace.fileCount },
      backup: {
        encrypted: true,
        cipher: bundle.cipher,
        manifestSha256: bundle.manifestSha256,
        bundleSha256: recoverySha256(await readFile(bundlePath)),
        databaseSha256: opened.manifest.database.sha256,
        wormReceiptCount: opened.manifest.wormReceipts.length,
        containsPlaintextKey: JSON.stringify(bundle).includes(backupKey),
      },
      objectives: {
        measuredRpoMs: rpoMs, targetRpoMs: 15 * 60_000, rpoPassed: rpoMs <= 15 * 60_000,
        measuredRtoMs: rtoMs, targetRtoMs: 60 * 60_000, rtoPassed: rtoMs <= 60 * 60_000,
      },
      findings: [],
      checks,
      note: 'The WORM system remains an independent retention boundary. This bundle preserves scoped receipts and digests, not a mutable replacement for provider Object Lock.',
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath, objectives: report.objectives, checks }, null, 2)}\n`);
  } finally {
    await source.end().catch(() => undefined);
    await target.end().catch(() => undefined);
    await rm(restoredWorkspace, { recursive: true, force: true });
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

try {
  await main();
} catch (error) {
  const failed = {
    schemaVersion: 1,
    kind: 'argus.pilot-recovery-certification',
    status: 'failed',
    generatedAt: new Date().toISOString(),
    error: safeError(error),
    checks,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(failed, null, 2)}\n`, 'utf8');
  process.stderr.write(`${failed.error}\n`);
  process.exitCode = 2;
} finally {
  cleanup();
}
