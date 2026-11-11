#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = 'argus-golden-path-e2e';
const compose = ['compose', '-p', project, '--project-directory', root, '-f', 'deploy/compose/e2e/compose.e2e.yml', '-f', 'deploy/compose/e2e/compose.golden-path.e2e.yml'];
const reportPath = resolve(root, 'test-results', 'golden-path-certification.json');
const checks = [];
let cleanupStarted = false;

function docker(args, label) {
  const startedAt = Date.now();
  const result = spawnSync('docker', [...compose, ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const status = result.status === 0 ? 'passed' : 'failed';
  if (label) checks.push({ label, status, durationMs: Date.now() - startedAt });
  if (result.status !== 0) throw new Error(`${label ?? 'docker compose'} failed with exit code ${result.status}`);
}

function ensureSigningKey() {
  const result = spawnSync(process.execPath, ['scripts/ensure-audit-signing-key.mjs'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`audit signing key preparation failed with exit code ${result.status}`);
  checks.push({ label: 'audit-signing-key', status: 'passed', durationMs: 0 });
}

function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const result = spawnSync('docker', [...compose, 'down', '--volumes', '--remove-orphans'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) checks.push({ label: 'cleanup', status: 'failed', durationMs: 0 });
}

function writeReport(status, error = null) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'argus.golden-path-certification',
    status,
    generatedAt: new Date().toISOString(),
    checks,
    error,
  }, null, 2)}\n`);
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

try {
  ensureSigningKey();
  cleanup();
  cleanupStarted = false;
  docker(['up', '--build', '--detach', 'postgres', 'qdrant', 'redis', 'keycloak', 'fake-openai', 'fake-mcp', 'fake-workspace', 'argus', 'langgraph'], 'fresh-stack');
  docker([
    'run', '--rm', '-e', 'ARGUS_GOLDEN_PATH_CERT_PHASE=prepare', 'playwright',
    'sh', '-c', 'npm ci --no-audit --no-fund && npx playwright test tests/golden-path-certification.spec.ts --reporter=line',
  ], 'read-only-approve-reject');
  docker(['restart', 'argus'], 'argus-restart');
  docker(['up', '--detach', '--wait', 'argus'], 'argus-recovery');
  docker([
    'run', '--rm', '-e', 'ARGUS_GOLDEN_PATH_CERT_PHASE=resume', 'playwright',
    'sh', '-c', 'npm ci --no-audit --no-fund && npx playwright test tests/golden-path-certification.spec.ts --reporter=line',
  ], 'restart-replay-resume');
  writeReport('passed');
} catch (error) {
  writeReport('failed', error instanceof Error ? error.message : String(error));
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
}
