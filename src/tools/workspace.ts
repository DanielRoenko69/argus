/**
 * workspace.* tools â€” let worker agents drive the agent-workspace HTTP sidecar.
 *
 * Four tools: workspace_exec, workspace_read, workspace_write, workspace_ls.
 * All requests carry the shared X-Workspace-Secret header.
 */

import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../config/env.js';
import type { ToolResult } from './toolRunner.js';

export const WORKSPACE_TOOL_PREFIX = 'workspace_';

// Tool schemas (OpenAI-compatible function calling)

export interface WorkspaceToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
}

export const WORKSPACE_TOOLS: WorkspaceToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'workspace_exec',
      description:
        'Run a shell command inside the isolated /workspace container.\n' +
        'Use when: you need git, npm/yarn, python/pip, build commands, or anything ' +
        'beyond plain file ops. Examples: `git clone <url> <dir>`, `npm install`, ' +
        '`npm test`, `python3 -m pytest`, `cd dir && ./build.sh`.\n' +
        'Do NOT use for: simple reads/writes/dir listings â€” `workspace_read`/`workspace_write`/' +
        '`workspace_ls` are cheaper and clearer. Do NOT chain unrelated commands; one ' +
        'logical action per call so failures are isolated.\n' +
        'Returns: stdout, stderr, exit_code, duration_ms. Outputs over 256 KB are truncated.',
      parameters: {
        type: 'object',
        properties: {
          cmd:         { type: 'string', description: 'Shell command (passed to `sh -c`). Max 8192 chars.' },
          cwd:         { type: 'string', description: 'Working directory (must be under /workspace). Default /workspace.' },
          timeout_sec: { type: 'number', description: 'Hard timeout. Default 60. Use 120-180 for npm install / heavy builds. Max 300.' },
        },
        required: ['cmd'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_read',
      description:
        'Read a UTF-8 text file from /workspace.\n' +
        'Use when: you need to inspect file contents (source code, configs, logs).\n' +
        'Do NOT use for: discovering whether a file exists â€” use `workspace_ls` first.\n' +
        'Limits: max 1 MB; binary files come back as garbled text â€” avoid.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path under /workspace.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_write',
      description:
        'Atomically write a UTF-8 text file under /workspace (creates parent dirs).\n' +
        'Use when: you need to create or fully replace a file â€” source code, configs, etc.\n' +
        'Do NOT use for: appending to or partially editing a file â€” read it, modify in ' +
        'memory, then write back. Do NOT use for binary content.\n' +
        'Limit: 256 KB. For larger writes, split into multiple files or use `workspace_exec`.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Absolute path under /workspace.' },
          content: { type: 'string', description: 'Full file content (UTF-8 string). Replaces existing.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_ls',
      description:
        'List entries of a directory under /workspace.\n' +
        'Use when: you need to discover what files/subdirs exist before reading or editing.\n' +
        'Prefer this over `workspace_exec ls -la` â€” faster, structured output.\n' +
        'Returns: array of entries with name, type (file|dir|symlink), size_bytes, modified_iso.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute directory path under /workspace. Default /workspace.' },
        },
      },
    },
  },
];

// â”€â”€ HTTP client â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface ExecResp {
  stdout: string; stderr: string; exit_code: number;
  duration_ms: number; timed_out: boolean; truncated: boolean;
}
interface ReadResp { content: string; size_bytes: number; encoding: string }
interface WriteResp { size_bytes: number; path: string }
interface EditResp { size_bytes: number; path: string; replacements: number }
interface LsResp {
  path: string;
  entries: Array<{ name: string; type: string; size_bytes: number; modified_iso: string }>;
}

async function workspaceFetch<T>(
  endpoint: string,
  method: 'GET' | 'POST',
  body: unknown,
  outerTimeoutMs: number,
): Promise<T> {
  const url = `${AGENT_WORKSPACE_URL}${endpoint}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), outerTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type':       'application/json',
        'X-Workspace-Secret': WORKSPACE_SECRET,
      },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`workspace API ${res.status}: ${text.slice(0, 500)}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(t);
  }
}

// â”€â”€ Output formatting for the LLM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function formatExec(r: ExecResp): string {
  const parts: string[] = [`## exit_code: ${r.exit_code}  duration: ${r.duration_ms}ms`];
  if (r.timed_out)  parts.push('## TIMEOUT â€” process killed');
  if (r.truncated)  parts.push('## OUTPUT TRUNCATED');
  parts.push('## stdout:');
  parts.push(r.stdout || '(empty)');
  if (r.stderr) {
    parts.push('## stderr:');
    parts.push(r.stderr);
  }
  return parts.join('\n');
}

function formatLs(r: LsResp): string {
  if (r.entries.length === 0) return `(empty directory: ${r.path})`;
  const rows = r.entries.map(e =>
    `${e.type.padEnd(8)} ${String(e.size_bytes).padStart(10)}  ${e.modified_iso}  ${e.name}`,
  );
  return `path: ${r.path}\ntype     size_bytes  modified                  name\n${rows.join('\n')}`;
}

// â”€â”€ Public dispatcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function executeWorkspaceTool(
  toolName: string,
  args: Record<string, unknown>,
  scopeRoot?: string,
): Promise<ToolResult> {
  if (!WORKSPACE_SECRET) {
    return {
      content: [{ type: 'text', text: 'workspace tools disabled: WORKSPACE_SECRET is not set' }],
      isError: true,
    };
  }

  try {
    if (toolName === 'workspace_exec') {
      const cmd        = String(args['cmd'] ?? '');
      const cwd        = typeof args['cwd'] === 'string' ? args['cwd'] : undefined;
      const timeoutSec = typeof args['timeout_sec'] === 'number' ? args['timeout_sec'] : undefined;
      const outerMs    = ((timeoutSec ?? 60) + 5) * 1000;
      const r = await workspaceFetch<ExecResp>('/exec', 'POST', { cmd, cwd, timeoutSec }, outerMs);
      return {
        content: [{ type: 'text', text: formatExec(r) }],
        isError: r.exit_code !== 0 || r.timed_out,
      };
    }

    if (toolName === 'workspace_read') {
      const r = await workspaceFetch<ReadResp>('/read', 'POST', {
        path: args['path'],
        ...(scopeRoot ? { scope_root: scopeRoot } : {}),
      }, 30_000);
      return { content: [{ type: 'text', text: r.content }] };
    }

    if (toolName === 'workspace_write') {
      const r = await workspaceFetch<WriteResp>(
        '/write', 'POST',
        { path: args['path'], content: args['content'], ...(scopeRoot ? { scope_root: scopeRoot } : {}) },
        30_000,
      );
      return { content: [{ type: 'text', text: `Wrote ${r.size_bytes} bytes to ${r.path}` }] };
    }

    if (toolName === 'workspace_edit') {
      const r = await workspaceFetch<EditResp>(
        '/edit', 'POST',
        {
          path: args['path'],
          old_text: args['old_text'],
          new_text: args['new_text'],
          replace_all: args['replace_all'] === true,
          ...(scopeRoot ? { scope_root: scopeRoot } : {}),
        },
        30_000,
      );
      return {
        content: [{ type: 'text', text: `Edited ${r.path} (${r.replacements} replacement${r.replacements === 1 ? '' : 's'}, ${r.size_bytes} bytes)` }],
      };
    }

    if (toolName === 'workspace_ls') {
      const p = typeof args['path'] === 'string' && args['path'] ? args['path'] : '/workspace';
      const query = new URLSearchParams({ path: p });
      if (scopeRoot) query.set('scope_root', scopeRoot);
      const r = await workspaceFetch<LsResp>(`/ls?${query.toString()}`, 'GET', undefined, 15_000);
      return { content: [{ type: 'text', text: formatLs(r) }] };
    }

    return {
      content: [{ type: 'text', text: `unknown workspace tool: ${toolName}` }],
      isError: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `workspace error: ${msg}` }], isError: true };
  }
}
