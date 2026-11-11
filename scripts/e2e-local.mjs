#!/usr/bin/env node
/**
 * Cross-platform local E2E runner.
 *
 * The former shell wrapper was convenient on Linux/macOS but made the
 * documented npm command unusable from PowerShell. Keep the exact same
 * disposable Compose lifecycle in Node so Docker Desktop works directly on
 * Windows as well as from Unix shells.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectName = 'argus-e2e';
const composeFile = 'deploy/compose/e2e/compose.e2e.yml';
// The E2E stack is the first Compose file, so pin the project directory to the
// repository root: relative paths and .env resolve exactly as before the move.
const composePrefix = ['compose', '-p', projectName, '--project-directory', root, '-f', composeFile];
const haProjectName = 'argus-ha';
const haComposePrefix = [
  'compose', '-p', haProjectName, '--project-directory', root,
  '-f', composeFile,
  '-f', 'deploy/compose/e2e/compose.ha.e2e.yml',
  '-f', 'deploy/compose/e2e/compose.ha.browser.e2e.yml',
];
let cleanupInProgress = false;
let haCleanupInProgress = false;

function docker(args) {
  const result = spawnSync('docker', [...composePrefix, ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const signal = result.signal ? ` (${result.signal})` : '';
    throw new Error(`docker compose ${args.join(' ')} failed with exit code ${result.status}${signal}`);
  }
}

function dockerHa(args) {
  const result = spawnSync('docker', [...haComposePrefix, ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const signal = result.signal ? ` (${result.signal})` : '';
    throw new Error(`docker compose ${haComposePrefix.slice(1).join(' ')} ${args.join(' ')} failed with exit code ${result.status}${signal}`);
  }
}

function cleanup() {
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  const result = spawnSync('docker', [...composePrefix, 'down', '--volumes', '--remove-orphans'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    process.exitCode ||= 1;
  }
  cleanupInProgress = false;
}

function cleanupHa() {
  if (haCleanupInProgress) return;
  haCleanupInProgress = true;
  const result = spawnSync('docker', [...haComposePrefix, 'down', '--volumes', '--remove-orphans'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    process.exitCode ||= 1;
  }
  haCleanupInProgress = false;
}

process.on('SIGINT', () => {
  cleanup();
  cleanupHa();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  cleanupHa();
  process.exit(143);
});

try {
  cleanup();
  cleanupHa();
  docker(['up', '--build', '--detach', 'postgres', 'redis', 'keycloak', 'fake-openai', 'fake-mcp', 'fake-workspace', 'argus', 'langgraph']);
  docker(['run', '--rm', 'playwright']);
  docker(['restart', 'argus']);
  docker(['up', '--detach', '--wait', 'argus']);
  docker(['run', '--rm', '-e', 'ARGUS_E2E_RECOVERY_PHASE=resume', 'playwright']);
  docker(['restart', 'langgraph']);
  docker(['up', '--detach', '--wait', 'langgraph']);
  docker(['run', '--rm', '-e', 'ARGUS_E2E_RECOVERY_PHASE=langgraph-resume', 'playwright']);

  // The standard stack has one Argus replica. Run the opt-in HA browser journey
  // in its dedicated two-replica overlay so every E2E spec is exercised.
  cleanup();
  dockerHa(['up', '--build', '--detach', 'postgres', 'qdrant', 'redis', 'keycloak', 'fake-openai', 'fake-anthropic', 'fake-workspace', 'callback-capture', 'argus-a', 'argus-b']);
  dockerHa(['run', '--rm', 'playwright-ha']);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
  cleanupHa();
}
