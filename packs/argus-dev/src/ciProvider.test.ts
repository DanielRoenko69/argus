import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { buildCiRerunRequest, normalizeCiRerunResult, requestCiRerun } from './ciProvider.js';
import type { CiRun, GitCreds } from './state.js';

const creds = (kind: GitCreds['kind'] = 'gitea'): GitCreds => ({
  kind,
  base_url: kind === 'github' ? 'https://api.github.com' : 'https://git.example',
  token: 'secret-token',
  project_key: 'argus',
  user_slug: '',
  repo_slug: 'core',
  target_branch: 'main',
});

const run = (provider: CiRun['provider']): CiRun => ({
  provider,
  external_id: '42',
  workflow: 'checks',
  status: 'failure',
  conclusion: 'failure',
  branch: 'feature/recover',
  commit_sha: 'abc123',
  run_url: `https://${provider}.example/runs/42`,
  updated_at: '2026-08-08T10:00:00.000Z',
});

test('builds provider-specific retry requests behind one CI interface', () => {
  const github = buildCiRerunRequest('github', run('github'), creds('github'));
  assert.equal(github.url, 'https://api.github.com/repos/argus/core/actions/runs/42/rerun');
  assert.equal((github.init.headers as Record<string, string>).Authorization, 'Bearer secret-token');

  const gitlab = buildCiRerunRequest('gitlab', run('gitlab'), creds());
  assert.equal(gitlab.url, 'https://git.example/api/v4/projects/argus%2Fcore/pipelines/42/retry');
  assert.equal((gitlab.init.headers as Record<string, string>)['PRIVATE-TOKEN'], 'secret-token');

  const jenkins = buildCiRerunRequest('jenkins', run('jenkins'), creds());
  assert.equal(jenkins.url, 'https://jenkins.example/runs/42/rebuild');
  assert.equal((jenkins.init.headers as Record<string, string>)['X-Jenkins-Token'], 'secret-token');
});

test('normalizes rerun responses into queued Argus evidence', () => {
  const rerun = normalizeCiRerunResult('github', run('github'), {
    workflow_run: {
      id: 99,
      name: 'checks',
      head_branch: 'feature/recover',
      head_sha: 'def456',
      html_url: 'https://github.com/argus/core/actions/runs/99',
    },
  });
  assert.deepEqual(rerun, {
    provider: 'github',
    external_id: '99',
    workflow: 'checks',
    status: 'queued',
    conclusion: '',
    branch: 'feature/recover',
    commit_sha: 'def456',
    run_url: 'https://github.com/argus/core/actions/runs/99',
    updated_at: rerun.updated_at,
  });
});

test('executes isolated HTTP retry smoke fixtures for every supported provider', async () => {
  const requests: Array<{ path: string; authorization?: string; privateToken?: string; jenkinsToken?: string }> = [];
  const server = http.createServer((req, res) => {
    requests.push({
      path: req.url ?? '',
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      privateToken: typeof req.headers['private-token'] === 'string' ? req.headers['private-token'] : undefined,
      jenkinsToken: typeof req.headers['x-jenkins-token'] === 'string' ? req.headers['x-jenkins-token'] : undefined,
    });
    const path = req.url ?? '';
    const response = path.startsWith('/github/')
      ? { workflow_run: { id: 101, name: 'GitHub checks', head_branch: 'feature/recover', head_sha: 'gh-sha', html_url: 'http://fixture/github/runs/101' } }
      : path.startsWith('/gitlab/')
        ? { id: 102, name: 'GitLab pipeline', ref: 'feature/recover', sha: 'gl-sha', web_url: 'http://fixture/gitlab/pipelines/102' }
        : path.startsWith('/jenkins/')
          ? { number: 103, job_name: 'argus', branch: 'feature/recover', scm: { commit: 'jenkins-sha' }, full_url: 'http://fixture/jenkins/job/argus/103' }
          : { id: 104, name: 'Gitea checks', head_branch: 'feature/recover', head_sha: 'gitea-sha', html_url: 'http://fixture/gitea/runs/104' };
    const body = JSON.stringify(response);
    res.writeHead(201, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const envKeys = ['GITHUB_CI_API_BASE_URL', 'GITLAB_CI_BASE_URL', 'JENKINS_CI_BASE_URL', 'GITEA_CI_API_BASE_URL'] as const;
  const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    GITHUB_CI_API_BASE_URL: `${base}/github`,
    GITLAB_CI_BASE_URL: `${base}/gitlab`,
    JENKINS_CI_BASE_URL: `${base}/jenkins/job/argus/42`,
    GITEA_CI_API_BASE_URL: `${base}/gitea`,
  });

  try {
    const cases: Array<{ provider: 'github' | 'gitlab' | 'jenkins' | 'gitea'; expectedId: string; expectedCommit: string }> = [
      { provider: 'github', expectedId: '101', expectedCommit: 'gh-sha' },
      { provider: 'gitlab', expectedId: '102', expectedCommit: 'gl-sha' },
      { provider: 'jenkins', expectedId: '103', expectedCommit: 'jenkins-sha' },
      { provider: 'gitea', expectedId: '104', expectedCommit: 'gitea-sha' },
    ];
    for (const item of cases) {
      const result = await requestCiRerun(item.provider, run(item.provider), creds('gitea'));
      assert.equal(result.external_id, item.expectedId);
      assert.equal(result.commit_sha, item.expectedCommit);
      assert.equal(result.status, 'queued');
    }
  } finally {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  assert.equal(requests.length, 4);
  assert.equal(requests[0]?.path, '/github/repos/argus/core/actions/runs/42/rerun');
  assert.equal(requests[0]?.authorization, 'Bearer secret-token');
  assert.equal(requests[1]?.path, '/gitlab/api/v4/projects/argus%2Fcore/pipelines/42/retry');
  assert.equal(requests[1]?.privateToken, 'secret-token');
  assert.equal(requests[2]?.path, '/jenkins/job/argus/42/rebuild');
  assert.equal(requests[2]?.jenkinsToken, 'secret-token');
  assert.equal(requests[3]?.path, '/gitea/api/v1/repos/argus/core/actions/runs/42/rerun');
  assert.equal(requests[3]?.authorization, 'token secret-token');
});
