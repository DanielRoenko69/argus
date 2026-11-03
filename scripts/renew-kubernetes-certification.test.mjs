import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve('.');
const runner = resolve('scripts/renew-kubernetes-certification.mjs');
const contractPath = resolve('demo/aiops/kubernetes/connector-contract.in-cluster.json');

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [runner, ...args], { cwd: root, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolveRun({ status, stdout, stderr }));
  });
}

async function startImportServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      url: request.url,
      apiKey: request.headers['x-api-key'],
      body: JSON.parse(body),
    });
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ certification: { backendId: 42, reportSha256: 'b'.repeat(64) } }));
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  };
}

test('runs a connector certification and uploads only the bounded report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'argus-cert-renewal-'));
  const apiKey = 'ak_test-secret-that-must-not-be-logged';
  const apiKeyFile = join(directory, 'api-key');
  const reportPath = join(directory, 'report.json');
  const certifier = join(directory, 'certifier.mjs');
  const contractSource = await readFile(contractPath, 'utf8');
  const contract = JSON.parse(contractSource);
  const report = {
    apiVersion: 'certification.argus.eu/v1alpha1',
    kind: 'KubernetesConnectorCertificationReport',
    targetId: contract.metadata.targetId,
    platform: contract.spec.platform,
    profile: contract.spec.profile,
    overall: 'passed',
    checks: [{ id: 'connector.ready', status: 'passed', detail: 'connector is ready' }],
    generatedAt: new Date().toISOString(),
    contractSha256: createHash('sha256').update(contractSource).digest('hex'),
  };
  await writeFile(apiKeyFile, apiKey, 'utf8');
  await writeFile(certifier, `import { writeFile } from 'node:fs/promises';\nconst output=process.argv[process.argv.indexOf('--report')+1];\nawait writeFile(output, ${JSON.stringify(JSON.stringify(report))});\n`, 'utf8');
  const core = await startImportServer();
  try {
    const result = await run([
      '--contract', contractPath,
      '--report', reportPath,
      '--certifier', certifier,
      '--api-key-file', apiKeyFile,
      '--core-url', core.url,
      '--in-cluster',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(core.requests.length, 1);
    assert.equal(core.requests[0].url, '/api/certifications/kubernetes');
    assert.equal(core.requests[0].apiKey, apiKey);
    assert.equal(core.requests[0].body.report.overall, 'passed');
    assert.doesNotMatch(result.stdout + result.stderr, /test-secret-that-must-not-be-logged/);
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('uploads a synthetic failed report when cluster collection crashes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'argus-cert-renewal-failure-'));
  const apiKeyFile = join(directory, 'api-key');
  const reportPath = join(directory, 'missing-report.json');
  const certifier = join(directory, 'failed-certifier.mjs');
  await writeFile(apiKeyFile, 'ak_failure-test', 'utf8');
  await writeFile(certifier, `process.stderr.write('kubectl could not reach the cluster\\n');\nprocess.exitCode=1;\n`, 'utf8');
  const core = await startImportServer();
  try {
    const result = await run([
      '--contract', contractPath,
      '--report', reportPath,
      '--certifier', certifier,
      '--api-key-file', apiKeyFile,
      '--core-url', core.url,
    ]);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(core.requests.length, 1);
    assert.equal(core.requests[0].body.report.overall, 'failed');
    assert.equal(core.requests[0].body.report.checks[0].id, 'runner.execution');
    assert.match(core.requests[0].body.report.checks[0].detail, /could not reach/);
  } finally {
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
});
