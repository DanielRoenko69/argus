import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPullRequestRequest, pullRequestUrl } from './gitProvider.js';
import type { GitCreds } from './state.js';

const creds = (kind: GitCreds['kind'], base_url: string): GitCreds => ({
  kind,
  base_url,
  token: 'secret',
  project_key: 'argus',
  user_slug: '',
  repo_slug: 'core',
  target_branch: 'main',
});

test('builds provider-specific pull request requests behind one merge interface', async () => {
  const input = { title: 'ARGUS-1', description: 'Create the change', head: 'feature/ARGUS-1', base: 'main' };
  const gitea = buildPullRequestRequest(creds('gitea', 'http://gitea:3000'), input);
  assert.equal(gitea.url, 'http://gitea:3000/api/v1/repos/argus/core/pulls');
  assert.equal((gitea.init.headers as Record<string, string>)['Authorization'], 'token secret');
  assert.deepEqual(JSON.parse(String(gitea.init.body)), { title: input.title, body: input.description, head: input.head, base: input.base });

  const github = buildPullRequestRequest(creds('github', 'https://api.github.com'), input);
  assert.equal(github.url, 'https://api.github.com/repos/argus/core/pulls');
  assert.equal((github.init.headers as Record<string, string>)['Accept'], 'application/vnd.github+json');
});

test('extracts pull request URLs from provider responses', () => {
  assert.equal(pullRequestUrl('gitea', { html_url: 'http://gitea/argus/core/pulls/1' }), 'http://gitea/argus/core/pulls/1');
  assert.equal(pullRequestUrl('github', { html_url: 'https://github.com/argus/core/pull/1' }), 'https://github.com/argus/core/pull/1');
  assert.equal(pullRequestUrl('bitbucket', { links: { self: [{ href: 'http://bitbucket/pr/1' }] } }), 'http://bitbucket/pr/1');
});
