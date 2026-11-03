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
    const child = spawn(process.execPath, ['scripts/llm-provider-fault-gate.mjs'], {
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

function faultServer() {
  return createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const marker = String(body.messages?.[0]?.content || '');
    if (marker.includes('401')) {
      response.writeHead(401); response.end('{"error":"unauthorized"}'); return;
    }
    if (marker.includes('429')) {
      response.writeHead(429, { 'retry-after': '1' }); response.end('{"error":"rate_limit"}'); return;
    }
    if (marker.includes('500')) {
      response.writeHead(500); response.end('{"error":"server"}'); return;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
}

async function listen(server) {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  return `http://127.0.0.1:${address.port}/v1`;
}

test('reports not_run without explicit fault-provider configuration', async () => {
  const reportPath = 'test-results/llm-faults-not-run.json';
  const result = await run({ ARGUS_LLM_FAULT_BASE_URL: '', ARGUS_LLM_FAULT_REQUIRED: '', ARGUS_LLM_FAULT_REPORT: reportPath });
  assert.equal(result.code, 0);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.overall, 'not_run');
  await rm(resolve(root, reportPath), { force: true });
});

test('certifies 401, 429, 500 and bounded timeout behavior', async () => {
  const server = faultServer();
  const baseUrl = await listen(server);
  const reportPath = 'test-results/llm-faults-passed.json';
  const result = await run({
    ARGUS_LLM_FAULT_BASE_URL: baseUrl,
    ARGUS_LLM_FAULT_REQUIRED: '1',
    ARGUS_LLM_FAULT_TIMEOUT_MS: '300',
    ARGUS_LLM_FAULT_REPORT: reportPath,
  });
  await new Promise(resolveClose => server.close(resolveClose));
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(resolve(root, reportPath), 'utf8'));
  assert.equal(report.overall, 'passed');
  assert.equal(report.checks.length, 4);
  assert.ok(report.checks.every(check => !('body' in check) && !('error' in check)));
  await rm(resolve(root, reportPath), { force: true });
});
