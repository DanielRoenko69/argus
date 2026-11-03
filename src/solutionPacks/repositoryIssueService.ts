import type pg from 'pg';
import type { Config } from '../config/env.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { makeHookedToolRunner } from '../workflows/hookedToolRunner.js';
import { redact } from '../lib/redaction.js';
import { withRequestContext } from '../lib/requestContext.js';
import { toBrowserProviderUrl } from '../integrations/ciProviderAdapters.js';
import { startTelemetrySpan, finishTelemetrySpan } from '../observability/telemetryStore.js';
import { repositoryCheckoutBlocker } from './repositoryCheckout.js';
import { GITEA_ISSUE_TEMPLATE, RepositoryIssueError, issueNumber, issueSnapshot, parseIssueToolResponse } from './repositoryIssue.js';

export async function loadRepositoryIssue(pool: pg.Pool, config: Config, input: {
  bundleIds: number[]; reference: string; rootTraceId: string; userId?: number; userGroups?: string[];
  allowedTools?: string[]; expectedSha256?: string;
}) {
  const blocker = await repositoryCheckoutBlocker(pool, input.bundleIds);
  if (blocker) throw new RepositoryIssueError(422, blocker);
  const { rows } = await pool.query<{
    id: number; name: string; base_url: string; config: Record<string, unknown>; tool_name: string;
  }>(`SELECT DISTINCT b.id, b.name, b.base_url, b.config, t.name AS tool_name
       FROM mcp_backends b JOIN mcp_backend_bundles bb ON bb.backend_id=b.id
       JOIN mcp_tools t ON t.backend='custom:' || b.name
      WHERE bb.bundle_id=ANY($1::int[]) AND b.enabled=true AND t.enabled=true
        AND b.config->>'kind'='gitea' AND t.query_template=$2 AND COALESCE(t.is_write,false)=false`,
  [input.bundleIds, GITEA_ISSUE_TEMPLATE]);
  const allowed = await loadAllowedToolNames(pool, input.bundleIds, { includeUnscoped: false });
  const candidates = rows.filter(row => allowed.has(row.tool_name)
    && (!input.allowedTools || input.allowedTools.includes(row.tool_name)));
  if (candidates.length !== 1) throw new RepositoryIssueError(403,
    'Select exactly one authorized Gitea get_issue tool for this checkout. Add the read-only tool from the Gitea template to its Bundle.');
  const row = candidates[0]!;
  const owner = String(row.config['project_key'] ?? row.config['owner'] ?? '');
  const repo = String(row.config['repo_slug'] ?? row.config['repo'] ?? '');
  if (![owner, repo].every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,100}$/.test(part) && part !== '..')) {
    throw new RepositoryIssueError(422, 'The selected Gitea connection needs a concrete owner and repository.');
  }
  const gitOrigin = row.base_url.replace(/\/+$/, '');
  const publicBase = String(row.config['public_base_url'] || toBrowserProviderUrl('gitea', gitOrigin)).replace(/\/+$/, '');
  for (const base of [gitOrigin, publicBase]) {
    const url = new URL(base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new RepositoryIssueError(422, 'Invalid configured Gitea origin.');
    }
  }
  const target = { repository: `${owner}/${repo}`, gitOrigin, publicBase, backendId: row.id, toolName: row.tool_name };
  const number = issueNumber(input.reference, target);
  const span = startTelemetrySpan({ traceId: input.rootTraceId, name: 'repository.issue.read', kind: 'tool',
    input: { repository: target.repository, number }, metadata: { toolName: row.tool_name, bundleIds: input.bundleIds } });
  try {
    const { executeTool } = await import('../tools/toolRunner.js');
    const run = makeHookedToolRunner(pool, config, { source: 'argus.dev.issue', sessionId: input.rootTraceId, userId: input.userId, userGroups: input.userGroups },
      async (name, args) => {
        // Hooks may deny the read, never redirect it to a different issue/repository.
        if (name !== row.tool_name || args.owner !== owner || args.repo !== repo || args.index !== number) {
          throw new RepositoryIssueError(403, 'Issue read scope was changed by policy.');
        }
        return executeTool(name, args, { config, pool, allowedBundles: input.bundleIds, skipCache: true });
      });
    const result = await withRequestContext({ callingUser: input.userId ? { id: input.userId, entra_groups: input.userGroups ?? [] } : undefined },
      () => run(row.tool_name, { owner, repo, index: number }));
    const raw = parseIssueToolResponse(result);
    const snapshot = issueSnapshot(raw, target, number, text => redact(text, { forceEnabled: true }).text);
    if (input.expectedSha256 && snapshot.sha256 !== input.expectedSha256) {
      throw new RepositoryIssueError(409, 'Issue changed since preview. Load and review the current issue before starting.');
    }
    finishTelemetrySpan(span, { status: 'completed', output: { repository: snapshot.repository, number, sha256: snapshot.sha256 } });
    return snapshot;
  } catch (error) {
    finishTelemetrySpan(span, { status: 'failed', error: 'repository_issue_read_failed' });
    throw error;
  }
}
