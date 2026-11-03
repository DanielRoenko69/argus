/**
 * codegraphPrejob — runs in agentRunner BEFORE the first LLM iteration when
 * the agent is worker-mode with codegraph_enabled=true and has a gitea_project.
 *
 * Behaviour:
 *   - Marks graphify-out/ as checkout-local infrastructure in
 *     .git/info/exclude, then runs `graphify update .` via the
 *     agent-workspace sidecar. This is AST-only (no LLM cost), ~30s for a
 *     typical repo, and bootstraps graphify-out/ if it doesn't yet exist.
 *     The local exclude prevents generated graph files from being mistaken
 *     for agent-authored delivery evidence without changing the repository's
 *     tracked .gitignore policy.
 *   - Semantic extraction (`graphify extract`) is intentionally NOT triggered
 *     here — it costs money and time. Admins run it manually via workspace_exec
 *     when ready.
 *
 * Fail-open: any error is logged but never propagates. Agent continues
 * without codegraph_* tools functioning; user gets normal grep/read.
 */

import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface CodegraphPrejobInput {
  codegraph_enabled: boolean;
  gitea_project: string | null;
  workspace_dir?: string;
}

function validWorkspaceRoot(value: string | undefined): value is string {
  return typeof value === 'string' && /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

async function exec(cmd: string, cwd: string, timeoutSec = 120): Promise<{ ok: boolean; stderr: string }> {
  try {
    const res = await fetch(`${AGENT_WORKSPACE_URL.replace(/\/+$/, '')}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Secret': WORKSPACE_SECRET },
      body: JSON.stringify({ cmd, cwd, timeoutSec }),
    });
    if (!res.ok) return { ok: false, stderr: `HTTP ${res.status}` };
    const body = await res.json() as { stdout: string; stderr: string; exit_code: number };
    return { ok: body.exit_code === 0, stderr: body.stderr };
  } catch (err) {
    return { ok: false, stderr: String(err) };
  }
}

export async function ensureCodegraphReady(agent: CodegraphPrejobInput): Promise<void> {
  if (!agent.codegraph_enabled || !agent.gitea_project) return;
  if (!validWorkspaceRoot(agent.workspace_dir)) {
    logger.warn({ project: agent.gitea_project },
      'codegraphPrejob: no exact execution workspace; refusing to index the shared workspace root');
    return;
  }

  // Graphify's `update` command always writes graphify-out/ below the indexed
  // checkout. Keep those generated files out of git status/diff evidence by
  // using Git's checkout-local exclude file. Tracked files remain visible.
  const command = [
    'git_dir="$(git rev-parse --git-dir)"',
    'mkdir -p "$git_dir/info"',
    'touch "$git_dir/info/exclude"',
    '{ grep -qxF "/graphify-out/" "$git_dir/info/exclude" || printf "\\n/graphify-out/\\n" >> "$git_dir/info/exclude"; }',
    'graphify update . 2>&1',
  ].join(' && ');
  const r = await exec(command, agent.workspace_dir, 120);
  if (!r.ok) {
    logger.warn({ project: agent.gitea_project, stderr: r.stderr.slice(0, 300) },
      'codegraphPrejob: graphify update failed, agent continues without codegraph');
    return;
  }
  logger.info({ project: agent.gitea_project }, 'codegraphPrejob: graph ready');
}
