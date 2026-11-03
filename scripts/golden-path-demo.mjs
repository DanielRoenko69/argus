#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = 'argus-golden-path-demo';
const compose = ['compose', '-p', project, '-f', 'compose.e2e.yml', '-f', 'compose.golden-path.e2e.yml'];
const statePath = resolve(root, 'e2e', 'test-results', 'golden-path-restart-state.json');
const publicOrigin = `http://127.0.0.1:${process.env.ARGUS_E2E_PORT ?? '3100'}`;

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed with exit code ${result.status}`);
}

function docker(args) {
  run('docker', [...compose, ...args]);
}

function down() {
  docker(['down', '--volumes', '--remove-orphans']);
}

if (process.argv.includes('--down')) {
  down();
  process.stdout.write('Golden Path demo environment removed.\n');
  process.exit(0);
}

try {
  run(process.execPath, ['scripts/ensure-audit-signing-key.mjs']);
  down();
  docker(['up', '--build', '--detach', 'postgres', 'qdrant', 'redis', 'keycloak', 'fake-openai', 'fake-mcp', 'fake-workspace', 'argus', 'langgraph']);
  docker(['run', '--rm', '-e', 'ARGUS_GOLDEN_PATH_CERT_PHASE=prepare', 'playwright', 'npx', 'playwright', 'test', 'tests/golden-path-certification.spec.ts', '--reporter=line']);
  if (!existsSync(statePath)) throw new Error(`Golden Path demo state was not created: ${statePath}`);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const runId = encodeURIComponent(String(state.restart.runId));
  const traceId = encodeURIComponent(String(state.restart.traceId));
  const approvalId = encodeURIComponent(String(state.approvalId));
  process.stdout.write(`
ARGUS GOLDEN PATH DEMO IS READY

  Login:       ${publicOrigin}/login
  User:        e2e-admin
  Password:    ArgusE2e42!
  Run API:     ${publicOrigin}/api/ui/golden-path/v1/runs/${runId}
  Approval:    ${publicOrigin}/runs/approvals/${approvalId}
  Trace:       ${publicOrigin}/observe/logs?traceId=${traceId}
  Reports:     ${publicOrigin}/observe/audit?tab=reports

  Runtime mode: real workflow engine, mockMode=false
  Providers: deterministic disposable Gitea/Slack/OpenAI fixtures
  Teardown: npm run demo:golden-path:down

The final prepared run is intentionally waiting at its Human Approval Gate.
`);
} catch (error) {
  try { down(); } catch { /* preserve the original failure */ }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
