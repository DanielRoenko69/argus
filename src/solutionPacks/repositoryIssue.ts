import { createHash } from 'node:crypto';

export const GITEA_ISSUE_TEMPLATE = 'GET /api/v1/repos/{{owner}}/{{repo}}/issues/{{index}}';
export interface IssueTarget { repository: string; gitOrigin: string; publicBase: string; backendId: number; toolName: string }
export interface RepositoryIssueSnapshot {
  version: 1; provider: 'gitea'; repository: string; gitOrigin: string; number: number;
  url: string; title: string; body: string; state: string; updatedAt: string;
  fetchedAt: string; sha256: string; toolName: string; backendId: number;
}
export class RepositoryIssueError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Custom-backend MCP tools wrap their bounded JSON in an HTTP status envelope. */
export function parseIssueToolResponse(result: { isError?: boolean; content: Array<{ text: string }> }): unknown {
  const text = result.content.map(item => item.text).join('\n');
  if (result.isError && /^\[hook:/.test(text)) {
    throw new RepositoryIssueError(403, 'Issue read blocked by tool policy. An administrator must authorize the selected get_issue tool for this user; no permission fallback was attempted.');
  }
  if (result.isError || Buffer.byteLength(text) > 128_000) {
    throw new RepositoryIssueError(502, 'Gitea issue read failed or returned an oversized response.');
  }
  const json = text.replace(/^HTTP 200 [^\r\n]{0,80}\r?\n\r?\n/, '');
  try { return JSON.parse(json); }
  catch { throw new RepositoryIssueError(502, 'Gitea issue read returned invalid or truncated JSON.'); }
}

/** A pasted URL is an identifier, never a fetch destination. */
export function issueNumber(reference: string, target: IssueTarget): number {
  const raw = reference.trim();
  let number = raw.replace(/^#/, '');
  if (!/^\d+$/.test(number)) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new RepositoryIssueError(400, 'Use a Gitea issue URL or a positive issue number.'); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || /[%\\]/.test(raw)) {
      throw new RepositoryIssueError(400, 'Use a plain Gitea issue URL without credentials, query parameters or encoded paths.');
    }
    const prefix = [target.gitOrigin, target.publicBase].map(base => `${base.replace(/\/+$/, '')}/${target.repository}/issues/`)
      .find(base => `${url.origin}${url.pathname}`.startsWith(base));
    if (!prefix) throw new RepositoryIssueError(403, 'Issue URL does not belong to the selected repository connection.');
    number = `${url.origin}${url.pathname}`.slice(prefix.length);
  }
  if (!/^[1-9]\d{0,8}$/.test(number)) throw new RepositoryIssueError(400, 'Issue number must be a positive integer of at most 9 digits.');
  return Number(number);
}

export function issueSnapshot(raw: unknown, target: IssueTarget, number: number, sanitize: (text: string) => string): RepositoryIssueSnapshot {
  const value = raw as Record<string, unknown> | null;
  if (!value || Array.isArray(value) || value.number !== number || value.pull_request
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 512
    || (value.body != null && typeof value.body !== 'string') || String(value.body ?? '').length > 40_000
    || !['open', 'closed'].includes(String(value.state)) || typeof value.updated_at !== 'string'
    || !Number.isFinite(Date.parse(value.updated_at))) {
    throw new RepositoryIssueError(422, 'Issue response is invalid, is a pull request, or exceeds the 40000-character limit.');
  }
  // Revalidate the provider's own repository reference; never forward provider-controlled links.
  if (typeof value.html_url !== 'string' || issueNumber(value.html_url, target) !== number) {
    throw new RepositoryIssueError(422, 'Issue response does not match the selected repository.');
  }
  const content = { version: 1 as const, provider: 'gitea' as const,
    repository: target.repository, gitOrigin: target.gitOrigin, number,
    url: `${target.publicBase}/${target.repository}/issues/${number}`,
    title: sanitize(value.title), body: sanitize(String(value.body ?? '')), state: String(value.state),
    updatedAt: value.updated_at, toolName: target.toolName, backendId: target.backendId };
  return { ...content, fetchedAt: new Date().toISOString(), sha256: createHash('sha256').update(JSON.stringify(content)).digest('hex') };
}
