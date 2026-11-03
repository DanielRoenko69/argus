import type { GitCreds } from './state.js';

export interface PullRequestInput {
  title: string;
  description: string;
  head: string;
  base: string;
}

export interface PullRequestHttpRequest {
  url: string;
  init: RequestInit;
}

/** Provider-aware clone URL for the git backend selected through an Argus bundle. */
export function buildCloneUrl(creds: GitCreds): string {
  const base = creds.base_url.replace(/\/+$/, '');
  if (creds.kind === 'bitbucket') {
    const repoPath = creds.user_slug
      ? `/scm/~${creds.user_slug}/${creds.repo_slug}.git`
      : `/scm/${creds.project_key}/${creds.repo_slug}.git`;
    return `${base}${repoPath}`;
  }
  const owner = creds.project_key || creds.user_slug;
  return `${base}/${owner}/${creds.repo_slug}.git`;
}

/** Git smart-HTTP authentication is provider-specific. */
export function buildGitAuthFlag(creds: GitCreds): string {
  if (!creds.token) return '';
  if (creds.kind === 'gitea') {
    const username = creds.project_key || creds.user_slug || 'git';
    const encoded = Buffer.from(`${username}:${creds.token}`, 'utf8').toString('base64');
    return ` -c http.extraheader="Authorization: Basic ${encoded}"`;
  }
  if (creds.kind === 'github') {
    const encoded = Buffer.from(`x-access-token:${creds.token}`, 'utf8').toString('base64');
    return ` -c http.extraheader="Authorization: Basic ${encoded}"`;
  }
  return ` -c http.extraheader="Authorization: Bearer ${creds.token}"`;
}

export function buildCiUrl(creds: GitCreds): string {
  if (creds.kind === 'gitea') {
    const owner = creds.project_key || creds.user_slug;
    // Keep provider API/clone traffic on the internal Compose hostname while
    // allowing evidence links to open from the user's browser.
    const base = (process.env['GITEA_PUBLIC_URL']?.trim() || creds.base_url).replace(/\/+$/, '');
    return `${base}/${owner}/${creds.repo_slug}/actions`;
  }
  return process.env['JENKINS_BUILD_URL'] ?? '';
}

/** Build the provider-specific merge/pull-request request. */
export function buildPullRequestRequest(creds: GitCreds, input: PullRequestInput): PullRequestHttpRequest {
  const base = creds.base_url.replace(/\/+$/, '');
  if (creds.kind === 'bitbucket') {
    const prPath = creds.user_slug
      ? `/rest/api/1.0/users/${creds.user_slug}/repos/${creds.repo_slug}/pull-requests`
      : `/rest/api/1.0/projects/${creds.project_key}/repos/${creds.repo_slug}/pull-requests`;
    const projectKey = creds.user_slug ? `~${creds.user_slug}` : creds.project_key;
    return {
      url: `${base}${prPath}`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${creds.token ?? ''}` },
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          fromRef: { id: `refs/heads/${input.head}`, repository: { slug: creds.repo_slug, project: { key: projectKey } } },
          toRef: { id: `refs/heads/${input.base}`, repository: { slug: creds.repo_slug, project: { key: projectKey } } },
        }),
      },
    };
  }

  const owner = creds.project_key || creds.user_slug;
  if (creds.kind === 'gitea') {
    return {
      url: `${base}/api/v1/repos/${owner}/${creds.repo_slug}/pulls`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `token ${creds.token ?? ''}` },
        body: JSON.stringify({ title: input.title, body: input.description, head: input.head, base: input.base }),
      },
    };
  }

  if (creds.kind === 'github') {
    const apiBase = base.includes('api.github.com') ? base : 'https://api.github.com';
    return {
      url: `${apiBase}/repos/${owner}/${creds.repo_slug}/pulls`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${creds.token ?? ''}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ title: input.title, body: input.description, head: input.head, base: input.base }),
      },
    };
  }

  throw new Error(`Unsupported merge provider '${String(creds.kind)}'`);
}

/** Extract the browser/API URL from each provider's successful response. */
export function pullRequestUrl(kind: GitCreds['kind'], payload: unknown): string {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  if (kind === 'bitbucket') {
    const links = body['links'];
    if (links && typeof links === 'object' && !Array.isArray(links)) {
      const self = (links as Record<string, unknown>)['self'];
      if (Array.isArray(self) && self[0] && typeof self[0] === 'object') {
        const href = (self[0] as Record<string, unknown>)['href'];
        if (typeof href === 'string') return href;
      }
    }
  }
  const value = body['html_url'] ?? body['web_url'] ?? body['url'];
  return typeof value === 'string' ? value : '';
}

/** Convert provider URLs into browser-facing links without changing API URLs. */
export function toBrowserProviderUrl(creds: GitCreds, value: string): string {
  if (creds.kind !== 'gitea' || !value) return value;
  const publicBase = process.env['GITEA_PUBLIC_URL']?.trim().replace(/\/+$/, '') ?? '';
  if (!publicBase) return value;
  try {
    const url = new URL(value);
    return `${publicBase}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}
