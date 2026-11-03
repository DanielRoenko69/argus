/**
 * Provider-neutral CI webhook adapters.
 *
 * Providers use different payloads and status vocabularies. Argus stores one
 * normalized evidence shape so LangGraph workflows and the UI do not need to
 * know whether a run came from Gitea Actions, GitHub Actions, GitLab CI or
 * Jenkins.
 */

export type CiProvider = 'gitea' | 'github' | 'gitlab' | 'jenkins' | 'bitbucket' | 'unknown';
export type ExternalCiStatus = 'queued' | 'running' | 'success' | 'failure' | 'canceled' | 'unknown';

export interface NormalizedCiRun {
  provider: CiProvider;
  external_id: string;
  workflow: string;
  status: ExternalCiStatus;
  conclusion: string;
  branch: string;
  commit_sha: string;
  run_url: string;
  updated_at: string;
}

export interface NormalizedCiWebhookEvent {
  repository: string;
  branch: string;
  ciRun: NormalizedCiRun;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function text(...values: unknown[]): string {
  return values.map(value => String(value ?? '').trim()).find(Boolean) ?? '';
}

function repositoryName(...values: unknown[]): string {
  let value = text(...values).toLowerCase();
  if (!value) return '';
  try {
    value = new URL(value).pathname;
  } catch {
    // Provider payloads normally contain owner/repo already.
  }
  return value.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
}

/** Normalize common provider statuses into Argus' durable lifecycle. */
export function normalizeCiStatus(status: unknown, conclusion: unknown): ExternalCiStatus {
  const state = text(status).toLowerCase().replace(/[- ]/g, '_');
  const result = text(conclusion).toLowerCase().replace(/[- ]/g, '_');
  if (['queued', 'waiting', 'requested', 'pending', 'created'].includes(state)) return 'queued';
  if (['in_progress', 'running', 'active', 'building'].includes(state)) return 'running';
  if (['success', 'passed', 'pass'].includes(result) || ['success', 'passed'].includes(state)) return 'success';
  if (['cancelled', 'canceled', 'aborted'].includes(result) || ['cancelled', 'canceled', 'aborted'].includes(state)) return 'canceled';
  if (['failure', 'failed', 'failure', 'timed_out', 'action_required', 'unstable'].includes(result)
    || ['failure', 'failed', 'error', 'unstable'].includes(state)) return 'failure';
  return 'unknown';
}

function giteaOrGithub(provider: CiProvider, payload: RecordValue): NormalizedCiWebhookEvent {
  const run = record(payload['workflow_run'] ?? payload['workflowRun'] ?? payload['run']);
  const repository = record(payload['repository']);
  const repoName = repositoryName(repository['full_name'], repository['path_with_namespace'], payload['repository_full_name']);
  const branch = text(run['head_branch'], run['head_ref'], run['ref']);
  const commitSha = text(run['head_sha'], run['sha'], run['commit_sha']);
  const externalId = text(run['id'], run['workflow_id'], run['run_number']);
  const runUrl = text(run['html_url'], run['web_url'], run['url']);
  return {
    repository: repoName,
    branch,
    ciRun: {
      provider,
      external_id: externalId.slice(0, 256),
      workflow: text(run['name'], run['workflow_name'], 'External CI/CD').slice(0, 256),
      status: normalizeCiStatus(run['status'], run['conclusion']),
      conclusion: text(run['conclusion'], run['status']).slice(0, 128),
      branch: branch.slice(0, 256),
      commit_sha: commitSha.slice(0, 128),
      run_url: runUrl.slice(0, 2048),
      updated_at: new Date().toISOString(),
    },
  };
}

function gitlab(payload: RecordValue): NormalizedCiWebhookEvent {
  const run = record(payload['object_attributes'] ?? payload['pipeline'] ?? payload['build']);
  const project = record(payload['project']);
  const repoName = repositoryName(project['path_with_namespace'], project['web_url'], payload['repository']);
  const branch = text(run['ref'], run['branch']);
  const commitSha = text(run['sha'], run['commit_sha']);
  return {
    repository: repoName,
    branch,
    ciRun: {
      provider: 'gitlab',
      external_id: text(run['id'], run['pipeline_id']).slice(0, 256),
      workflow: text(run['name'], project['name'], 'GitLab CI').slice(0, 256),
      status: normalizeCiStatus(run['status'], run['status']),
      conclusion: text(run['status']).slice(0, 128),
      branch: branch.slice(0, 256),
      commit_sha: commitSha.slice(0, 128),
      run_url: text(run['web_url'], run['url']).slice(0, 2048),
      updated_at: new Date().toISOString(),
    },
  };
}

function jenkins(payload: RecordValue): NormalizedCiWebhookEvent {
  const run = record(payload['build'] ?? payload['run'] ?? payload);
  const scm = record(payload['scm']);
  const repo = record(payload['repository']);
  const repoName = repositoryName(repo['full_name'], repo['url'], payload['repository_full_name']);
  const branch = text(payload['branch'], scm['branch'], run['branch'], run['display_name']);
  const commitSha = text(scm['commit'], scm['commit_sha'], payload['commit_sha']);
  return {
    repository: repoName,
    branch,
    ciRun: {
      provider: 'jenkins',
      external_id: text(run['number'], run['id'], payload['build_number']).slice(0, 256),
      workflow: text(run['job_name'], run['name'], payload['job_name'], 'Jenkins').slice(0, 256),
      status: normalizeCiStatus(run['phase'], run['status'] ?? run['result']),
      conclusion: text(run['result'], run['status'], run['phase']).slice(0, 128),
      branch: branch.slice(0, 256),
      commit_sha: commitSha.slice(0, 128),
      run_url: text(run['full_url'], run['url'], payload['build_url']).slice(0, 2048),
      updated_at: new Date().toISOString(),
    },
  };
}

export function normalizeCiWebhookEvent(provider: CiProvider, payload: unknown): NormalizedCiWebhookEvent {
  const body = record(payload);
  if (provider === 'gitlab') return gitlab(body);
  if (provider === 'jenkins') return jenkins(body);
  return giteaOrGithub(provider, body);
}

/** Convert internal provider URLs to browser-facing URLs when configured. */
export function toBrowserProviderUrl(provider: CiProvider, value: string): string {
  if (!value) return value;
  const envName: Partial<Record<CiProvider, string>> = {
    gitea: 'GITEA_PUBLIC_URL',
    gitlab: 'GITLAB_PUBLIC_URL',
    jenkins: 'JENKINS_PUBLIC_URL',
  };
  const configured = provider === 'jenkins'
    ? process.env['ARGUS_JENKINS_PUBLIC_URL'] ?? process.env['JENKINS_PUBLIC_URL']
    : envName[provider] ? process.env[envName[provider]!] : undefined;
  const publicBase = configured?.trim().replace(/\/+$/, '') ?? '';
  if (!publicBase) return value;
  try {
    const url = new URL(value);
    return `${publicBase}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}
