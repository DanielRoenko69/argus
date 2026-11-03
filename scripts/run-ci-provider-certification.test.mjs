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
    const child = spawn(process.execPath, ['scripts/run-ci-provider-certification.mjs'], { cwd: root, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('reports not_run when live provider canaries are disabled', async () => {
  const reportPath = 'test-results/provider-certification-test-disabled.json';
  const result = await run({ ARGUS_CI_CANARIES_ENABLED: '0', ARGUS_PROVIDER_CERTIFICATION_REPORT: reportPath });
  assert.equal(result.code, 0);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.overall, 'not_run');
  assert.ok(report.providers.every(item => item.status === 'not_run'));
  await rm(resolve(root, reportPath), { force: true });
});

test('maps a configured LangGraph result into a passing required-provider report', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/ci/canaries');
    assert.equal(request.headers['x-workspace-secret'], 'test-workspace-secret');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ results: [{
      provider: 'github', external_id: '42', status: 'ok', http_status: 200,
      latency_ms: 12, provider_status: 'completed',
    }] }));
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  const reportPath = 'test-results/provider-certification-test-live.json';
  const result = await run({
    ARGUS_CI_CANARIES_ENABLED: '1',
    ARGUS_CI_CANARY_TARGETS: JSON.stringify([{ provider: 'github', run_id: '42', token_env: 'GITHUB_CI_TOKEN' }]),
    GITHUB_CI_TOKEN: 'provider-secret-that-must-not-be-written',
    ARGUS_CI_CANARIES_REQUIRED_PROVIDERS: 'github',
    LANGGRAPH_URL: `http://127.0.0.1:${address.port}`,
    WORKSPACE_SECRET: 'test-workspace-secret',
    ARGUS_PROVIDER_CERTIFICATION_REPORT: reportPath,
  });
  await new Promise(resolveClose => server.close(resolveClose));
  assert.equal(result.code, 0, result.stderr);
  const reportText = await readFile(resolve(root, reportPath), 'utf8');
  const report = JSON.parse(reportText);
  assert.equal(report.overall, 'passed');
  assert.equal(report.providers.find(item => item.provider === 'github').status, 'passed');
  assert.equal(report.required_missing.length, 0);
  assert.equal(reportText.includes('provider-secret-that-must-not-be-written'), false);
  await rm(resolve(root, reportPath), { force: true });
});
