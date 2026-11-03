import type { CiRun, GitCreds } from './state.js';

export interface CiRerunRequest {
  url: string;
  init: RequestInit;
}

export interface CiRerunResult {
  provider: CiRun['provider'];
  external_id: string;
  workflow: string;
  status: CiRun['status'];
  conclusion: string;
  branch: string;
  commit_sha: string;
  run_url: string;
  updated_at: string;
}

export type CiRerunProvider = Exclude<CiRun['provider'], 'unknown' | 'bitbucket'>;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function ownerAndRepo(creds: GitCreds): { owner: string; repo: string } {
  const owner = (creds.project_key || creds.user_slug || '').trim();
  const repo = creds.repo_slug.trim();
  if (!owner || !repo) throw new Error('CI retry requires provider owner and repository credentials');
  return { owner, repo };
}

function bearerHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra };
}

/** Build the provider-owned retry request without executing it. */
export function buildCiRerunRequest(provider: CiRerunProvider, run: CiRun, creds: GitCreds): CiRerunRequest {
  if (!run.external_id) throw new Error(`${provider} CI retry requires an external run id`);
  const { owner, repo } = ownerAndRepo(creds);
  const token = creds.token || process.env[`${provider.toUpperCase()}_CI_TOKEN`] || '';
  if (!token) throw new Error(`${provider} CI retry requires a provider token`);

  if (provider === 'github') {
    const base = (process.env['GITHUB_CI_API_BASE_URL'] || 'https://api.github.com').replace(/\/+$/, '');
    return {
      url: `${base}/repos/${encoded(owner)}/${encoded(repo)}/actions/runs/${encoded(run.external_id)}/rerun`,
      init: { method: 'POST', headers: bearerHeaders(token, { 'X-GitHub-Api-Version': '2022-11-28' }), body: '{}' },
    };
  }

  if (provider === 'gitlab') {
    const base = (process.env['GITLAB_CI_BASE_URL'] || creds.base_url).replace(/\/+$/, '');
    const project = encoded(`${owner}/${repo}`);
    return {
      url: `${base}/api/v4/projects/${project}/pipelines/${encoded(run.external_id)}/retry`,
      init: { method: 'POST', headers: { Accept: 'application/json', 'PRIVATE-TOKEN': token } },
    };
  }

  if (provider === 'jenkins') {
    const base = (process.env['JENKINS_CI_BASE_URL'] || run.run_url).replace(/\/+$/, '');
    return {
      url: `${base}/rebuild`,
      init: { method: 'POST', headers: bearerHeaders(token, { 'X-Jenkins-Token': token }) },
    };
  }

  const giteaBase = (process.env['GITEA_CI_API_BASE_URL'] || creds.base_url).replace(/\/+$/, '');
  return {
    url: `${giteaBase}/api/v1/repos/${encoded(owner)}/${encoded(repo)}/actions/runs/${encoded(run.external_id)}/rerun`,
    init: { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `token ${token}` }, body: '{}' },
  };
}

/** Build a read-only provider probe for live staging canaries. */
export function buildCiProbeRequest(
  provider: CiRerunProvider,
  run: CiRun,
  creds: GitCreds,
  options: { ignoreEnvBase?: boolean } = {},
): CiRerunRequest {
  if (!run.external_id) throw new Error(`${provider} CI probe requires an external run id`);
  const { owner, repo } = ownerAndRepo(creds);
  const token = creds.token || process.env[`${provider.toUpperCase()}_CI_TOKEN`] || '';
  if (!token) throw new Error(`${provider} CI probe requires a provider token`);
  const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache' } as Record<string, string>;

  if (provider === 'github') {
    const base = (options.ignoreEnvBase ? creds.base_url : process.env['GITHUB_CI_API_BASE_URL'] || creds.base_url || 'https://api.github.com').replace(/\/+$/, '');
    return {
      url: `${base}/repos/${encoded(owner)}/${encoded(repo)}/actions/runs/${encoded(run.external_id)}`,
      init: { method: 'GET', headers: { ...headers, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' } },
    };
  }

  if (provider === 'gitlab') {
    const base = (options.ignoreEnvBase ? creds.base_url : process.env['GITLAB_CI_BASE_URL'] || creds.base_url).replace(/\/+$/, '');
    return {
      url: `${base}/api/v4/projects/${encoded(`${owner}/${repo}`)}/pipelines/${encoded(run.external_id)}`,
      init: { method: 'GET', headers: { ...headers, 'PRIVATE-TOKEN': token } },
    };
  }

  if (provider === 'jenkins') {
    const base = (options.ignoreEnvBase ? run.run_url : process.env['JENKINS_CI_BASE_URL'] || run.run_url).replace(/\/+$/, '');
    return {
      url: base,
      init: { method: 'GET', headers: { ...headers, Authorization: `Bearer ${token}`, 'X-Jenkins-Token': token } },
    };
  }

  const base = (options.ignoreEnvBase ? creds.base_url : process.env['GITEA_CI_API_BASE_URL'] || creds.base_url).replace(/\/+$/, '');
  return {
    url: `${base}/api/v1/repos/${encoded(owner)}/${encoded(repo)}/actions/runs/${encoded(run.external_id)}`,
    init: { method: 'GET', headers: { ...headers, Authorization: `token ${token}` },
    },
  };
}

/** Execute a provider retry and normalize its response into Argus evidence. */
export async function requestCiRerun(
  provider: CiRerunProvider,
  previous: CiRun,
  creds: GitCreds,
): Promise<CiRerunResult> {
  const request = buildCiRerunRequest(provider, previous, creds);
  const response = await fetch(request.url, request.init);
  const raw = await response.text().catch(() => '');
  let payload: unknown = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
  if (!response.ok) throw new Error(`${provider} retry ${response.status}: ${raw.slice(0, 300)}`);
  return normalizeCiRerunResult(provider, previous, payload);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string {
  return values.map(value => String(value ?? '').trim()).find(Boolean) ?? '';
}

/** Convert a provider retry response into the durable Argus CI evidence shape. */
export function normalizeCiRerunResult(provider: CiRerunProvider, previous: CiRun, payload: unknown): CiRerunResult {
  const body = record(payload);
  const run = record(body['workflow_run'] ?? body['pipeline'] ?? body['build'] ?? body['run'] ?? body);
  const scm = record(run['scm']);
  const externalId = text(run['id'], run['number'], run['run_number'], previous.external_id).slice(0, 256);
  const runUrl = text(run['html_url'], run['web_url'], run['full_url'], run['url'], previous.run_url).slice(0, 2048);
  return {
    provider,
    external_id: externalId,
    workflow: text(run['name'], run['workflow_name'], run['job_name'], previous.workflow, 'External CI/CD').slice(0, 256),
    status: 'queued',
    conclusion: '',
    branch: text(run['head_branch'], run['ref'], run['branch'], previous.branch).slice(0, 256),
    commit_sha: text(run['head_sha'], run['sha'], run['commit_sha'], scm['commit'], scm['sha'], previous.commit_sha).slice(0, 128),
    run_url: runUrl,
    updated_at: new Date().toISOString(),
  };
}
