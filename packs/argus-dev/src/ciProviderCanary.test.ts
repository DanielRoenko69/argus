import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  parseCiCanaryTargets,
  runCiProviderCanary,
  type CiCanaryTarget,
} from './ciProviderCanary.js';

test('parses opt-in canary targets without storing provider secrets', () => {
  const targets = parseCiCanaryTargets(JSON.stringify([
    { provider: 'github', base_url: 'https://github.example', owner: 'argus', repo: 'core', run_id: '101', token_env: 'GITHUB_CANARY_TOKEN' },
    { provider: 'gitlab', base_url: 'https://gitlab.example', owner: 'argus', repo: 'core', run_id: '102', token_env: 'GITLAB_CANARY_TOKEN' },
  ]), {
    GITHUB_CANARY_TOKEN: 'github-secret',
    GITLAB_CANARY_TOKEN: 'gitlab-secret',
  });
  assert.equal(targets.length, 2);
  assert.equal(targets[0]?.provider, 'github');
  assert.equal(targets[0]?.creds.token, 'github-secret');
  assert.equal(targets[0]?.run.external_id, '101');
});

test('runs read-only HTTP probes for GitHub, GitLab, Jenkins and Gitea fixtures', async () => {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    const url = req.url ?? '';
    const payload = url.includes('/github/')
      ? { workflow_run: { id: 101, status: 'completed', conclusion: 'success' } }
      : url.includes('/gitlab/')
        ? { id: 102, status: 'success' }
        : url.includes('/jenkins/')
          ? { number: 103, result: 'SUCCESS' }
          : { id: 104, status: 'success' };
    const body = JSON.stringify(payload);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const targets = parseCiCanaryTargets([
    { provider: 'github', base_url: base, owner: 'argus', repo: 'core', run_id: '101', token_env: 'CANARY_TOKEN' },
    { provider: 'gitlab', base_url: base, owner: 'argus', repo: 'core', run_id: '102', token_env: 'CANARY_TOKEN' },
    { provider: 'jenkins', base_url: base, owner: 'argus', repo: 'core', run_id: '103', run_url: `${base}/jenkins/job/argus/103`, token_env: 'CANARY_TOKEN' },
    { provider: 'gitea', base_url: base, owner: 'argus', repo: 'core', run_id: '104', token_env: 'CANARY_TOKEN' },
  ], { CANARY_TOKEN: 'fixture-token' });

  try {
    const results = await Promise.all(targets.map((target: CiCanaryTarget) => runCiProviderCanary(target, 5_000)));
    assert.deepEqual(results.map(result => result.status), ['ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(results.map(result => result.provider_status), ['success', 'success', 'SUCCESS', 'success']);
    assert.deepEqual(paths, [
      '/repos/argus/core/actions/runs/101',
      '/api/v4/projects/argus%2Fcore/pipelines/102',
      '/jenkins/job/argus/103',
      '/api/v1/repos/argus/core/actions/runs/104',
    ]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
