import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/chaos-recovery-gate.mjs'], { cwd: root, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('reports not_run without explicit chaos configuration', async () => {
  const reportPath = 'test-results/chaos-test-not-run.json';
  const result = await run({ ARGUS_CHAOS_HEALTH_URLS: '', ARGUS_CHAOS_REPORT: reportPath });
  assert.equal(result.code, 0);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.status, 'not_run');
  await rm(resolve(root, reportPath), { force: true });
});

test('checks all configured replicas before and after an argv-only restart command', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  const health = `http://127.0.0.1:${address.port}/health`;
  const reportPath = 'test-results/chaos-test-passed.json';
  const result = await run({
    ARGUS_CHAOS_HEALTH_URLS: `${health},${health}`,
    ARGUS_CHAOS_RESTART_COMMAND_JSON: JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
    ARGUS_CHAOS_REQUIRED: '1',
    ARGUS_CHAOS_POLL_MS: '250',
    ARGUS_CHAOS_REPORT: reportPath,
  });
  await new Promise(resolveClose => server.close(resolveClose));
  assert.equal(result.code, 0, result.stderr);
  const reportText = await readFile(resolve(root, reportPath), 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(report.status, 'passed');
  assert.equal(report.replica_count, 2);
  assert.equal(report.checks.restart_command.ok, true);
  assert.equal(report.checks.after_restart.ok, true);
  await rm(resolve(root, reportPath), { force: true });
});
