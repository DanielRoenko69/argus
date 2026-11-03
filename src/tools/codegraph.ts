/**
 * codegraph_* MCP tools — query a repo's knowledge graph (graphify-out/)
 * via the agent-workspace HTTP sidecar.
 *
 * Three tools:
 *   codegraph_query   — BFS traversal scoped to a question
 *   codegraph_path    — shortest path between two named nodes
 *   codegraph_explain — concept + neighbours
 *
 * All three shell into `graphify <subcommand>` inside the workspace
 * container, which must have the graphify CLI installed AND a built
 * graphify-out/ for the current checkout (created by the pre-job hook in
 * codegraphPrejob.ts).
 */

import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../config/env.js';
import type { ToolResult } from './toolRunner.js';

export const CODEGRAPH_TOOL_PREFIX = 'codegraph_';

export interface CodegraphToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required?: string[] };
  };
}

export const CODEGRAPH_TOOLS: CodegraphToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'codegraph_query',
      description:
        'Query the repo knowledge graph (graphify-out/) for a topic. Returns a scoped subgraph (~5-50 nodes) much smaller than greping the corpus. ' +
        'BEST queries use code-symbol terms ("oauth jwt middleware", "destructive cmd guard hook"), NOT natural-language ("how does auth work"). ' +
        'Returns: NODE / EDGE listing with file paths + line numbers. Use this BEFORE workspace_read when exploring an unfamiliar area.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Topical terms, ideally matching symbol names or doc headings.' },
          budget:   { type: 'number', description: 'Max output tokens (default 2000).' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codegraph_path',
      description:
        'Shortest path between two named code symbols, classes, or files in the knowledge graph. ' +
        'Use when you already know symbol names and want to understand HOW they connect. ' +
        'Returns: hop-by-hop edge list (e.g. "A -imports_from-> B -calls-> C"). Single tool-call replaces 5-10 grep+read cycles.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source symbol/file (exact name preferred).' },
          to:   { type: 'string', description: 'Target symbol/file.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codegraph_explain',
      description:
        'Plain-language summary of a single concept: which file defines it, its methods/properties, who imports it, what it imports. ' +
        'Replaces "Read file + Grep usages + List methods" with one call.',
      parameters: {
        type: 'object',
        properties: {
          concept: { type: 'string', description: 'Symbol, class, function, or file name as it appears in the codebase.' },
        },
        required: ['concept'],
      },
    },
  },
];

/**
 * Defuse a string for safe embedding inside a `"..."` shell argument.
 * Double-quotes are replaced with single-quotes so the shell cannot use them
 * to terminate the surrounding quoted argument (e.g. `foo"; rm -rf /` →
 * `foo'; rm -rf /` which stays harmlessly inside the outer `"..."`).
 * Other expansion metacharacters ($, `, \) are backslash-escaped.
 */
function escapeDoubleQuoted(s: string): string {
  return s
    .replace(/\\/g, '\\\\')  // backslash first (must be before other replacements)
    .replace(/"/g, "'")       // replace " with ' — prevents arg termination
    .replace(/\$/g, '\\$')    // prevent variable expansion
    .replace(/`/g, '\\`');    // prevent command substitution
}

interface ExecResp { stdout: string; stderr: string; exit_code: number; duration_ms: number }

function workspaceRoot(value: string | undefined): string {
  if (typeof value === 'string' && /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return value;
  throw new Error('codegraph tool requires an exact execution-grant-bound workspace');
}

async function workspaceExec(cmd: string, cwd: string, timeoutSec = 30): Promise<ExecResp> {
  const res = await fetch(`${AGENT_WORKSPACE_URL.replace(/\/+$/, '')}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Secret': WORKSPACE_SECRET },
    body: JSON.stringify({ cmd, cwd, timeoutSec }),
  });
  if (!res.ok) throw new Error(`workspace exec returned ${res.status}`);
  return await res.json() as ExecResp;
}

export async function executeCodegraphTool(
  name: string,
  args: Record<string, unknown>,
  executionWorkspaceRoot?: string,
): Promise<ToolResult> {
  let cmd: string;
  switch (name) {
    case 'codegraph_query': {
      const q = escapeDoubleQuoted(String(args['question'] ?? ''));
      const budget = Number(args['budget']) > 0 ? ` --budget ${Math.floor(Number(args['budget']))}` : '';
      cmd = `graphify query "${q}"${budget}`;
      break;
    }
    case 'codegraph_path': {
      const a = escapeDoubleQuoted(String(args['from'] ?? ''));
      const b = escapeDoubleQuoted(String(args['to']   ?? ''));
      cmd = `graphify path "${a}" "${b}"`;
      break;
    }
    case 'codegraph_explain': {
      const c = escapeDoubleQuoted(String(args['concept'] ?? ''));
      cmd = `graphify explain "${c}"`;
      break;
    }
    default:
      throw new Error(`unknown codegraph tool: ${name}`);
  }

  const r = await workspaceExec(cmd, workspaceRoot(executionWorkspaceRoot));
  const text = r.stdout || r.stderr || '(no output)';
  const isError = r.exit_code !== 0;
  return { content: [{ type: 'text', text }], isError };
}
