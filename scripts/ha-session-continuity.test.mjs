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
    const child = spawn(process.execPath, ['scripts/ha-session-continuity.mjs'], {
      cwd: root, env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

function fixtureServer({ registration = false } = {}) {
  return createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (registration && request.url === '/auth/register') {
      response.writeHead(302, {
        'set-cookie': 'argus_session=ha-test-session; Path=/; HttpOnly',
        location: '/home',
      });
      response.end();
      return;
    }
    if (request.url === '/api/me') {
      const valid = request.headers.cookie === 'argus_session=ha-test-session';
      response.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
      response.end(valid ? '{"id":"ha-user"}' : '{"error":"unauthorized"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
}

async function listen(server) {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  return `http://127.0.0.1:${address.port}`;
}

test('reports not_run without explicit HA configuration', async () => {
  const reportPath = 'test-results/ha-test-not-run.json';
  const result = await run({
    ARGUS_HA_REQUIRED: '',
    ARGUS_HA_REPORT: reportPath,
  });
  assert.equal(result.code, 0);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.status, 'not_run');
  await rm(resolve(root, reportPath), { force: true });
});

test('carries a session from replica A to B and across restart', async () => {
  const primary = fixtureServer({ registration: true });
  const secondary = fixtureServer();
  const primaryUrl = await listen(primary);
  const secondaryUrl = await listen(secondary);
  const reportPath = 'test-results/ha-test-passed.json';
  const result = await run({
    ARGUS_HA_PRIMARY_URL: primaryUrl,
    ARGUS_HA_SECONDARY_URL: secondaryUrl,
    ARGUS_HA_TIMEOUT_MS: '15000',
    ARGUS_HA_RESTART_COMMAND_JSON: JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
    ARGUS_HA_REQUIRED: '1',
    ARGUS_HA_REPORT: reportPath,
  });
  await Promise.all([
    new Promise(resolveClose => primary.close(resolveClose)),
    new Promise(resolveClose => secondary.close(resolveClose)),
  ]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.status, 'passed');
  assert.equal(report.checks.session_on_primary.ok, true);
  assert.equal(report.checks.session_on_secondary.ok, true);
  assert.equal(report.checks.session_after_restart.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /ha-test-session|password|cookie/i);
  await rm(resolve(root, reportPath), { force: true });
});
