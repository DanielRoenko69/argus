import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeWorkspaceTool } from './workspace.js';
import type { ToolResult } from './toolRunner.js';

export type RuntimeWorkspaceAccess = 'read' | 'write';

const WORKSPACE_ROOT = /^\/workspace\/[^/]+$/;

export function assertRuntimeWorkspaceRoot(value: string): string {
  const resolved = path.posix.resolve(value);
  if (!WORKSPACE_ROOT.test(resolved) || resolved !== value) {
    throw new Error('runtime workspace root must be one exact child of /workspace');
  }
  return resolved;
}

export function assertRuntimeWorkspacePath(value: string, workspaceRoot: string): string {
  const root = assertRuntimeWorkspaceRoot(workspaceRoot);
  const resolved = path.posix.resolve(value);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`path must stay inside ${root}`);
  }
  return resolved;
}

function resultError(cause: unknown) {
  return {
    content: [{ type: 'text' as const, text: cause instanceof Error ? cause.message : 'runtime workspace request failed' }],
    isError: true,
  };
}

function mcpResult(result: ToolResult): {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: result.content.map(item => ({ type: 'text' as const, text: item.text })),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

/**
 * Register the only local capabilities a managed runtime may receive.
 * Shell execution intentionally remains owned by Argus Dev, which runs the
 * deterministic test/diff/git stages after the Hermes turn.
 */
export function registerRuntimeWorkspaceTools(
  server: McpServer,
  workspaceRoot: string,
  access: RuntimeWorkspaceAccess,
): void {
  const root = assertRuntimeWorkspaceRoot(workspaceRoot);

  server.tool(
    'workspace_ls',
    `List files inside the Argus-owned run workspace ${root}. Paths outside this exact workspace are rejected.`,
    { path: z.string().optional().describe(`Absolute directory under ${root}. Defaults to the workspace root.`) },
    async ({ path: requested }) => {
      try {
        const target = assertRuntimeWorkspacePath(requested || root, root);
        return mcpResult(await executeWorkspaceTool('workspace_ls', { path: target }, root));
      } catch (cause) {
        return resultError(cause);
      }
    },
  );

  server.tool(
    'workspace_read',
    `Read one UTF-8 file inside the Argus-owned run workspace ${root}.`,
    { path: z.string().min(1).describe(`Absolute file path under ${root}.`) },
    async ({ path: requested }) => {
      try {
        const target = assertRuntimeWorkspacePath(requested, root);
        return mcpResult(await executeWorkspaceTool('workspace_read', { path: target }, root));
      } catch (cause) {
        return resultError(cause);
      }
    },
  );

  if (access !== 'write') return;
  server.tool(
    'workspace_edit',
    `Replace one exact text block in an existing UTF-8 file inside ${root}. The edit fails closed when the old text is missing or ambiguous.`,
    {
      path: z.string().min(1).describe(`Absolute file path under ${root}.`),
      old_text: z.string().min(1).max(128 * 1024).describe('Exact existing text to replace. Include enough surrounding lines to make it unique.'),
      new_text: z.string().max(128 * 1024).describe('Replacement text.'),
      replace_all: z.boolean().optional().describe('Replace every exact occurrence. Defaults to false.'),
    },
    async ({ path: requested, old_text, new_text, replace_all }) => {
      try {
        const target = assertRuntimeWorkspacePath(requested, root);
        return mcpResult(await executeWorkspaceTool('workspace_edit', {
          path: target,
          old_text,
          new_text,
          replace_all: replace_all === true,
        }, root));
      } catch (cause) {
        return resultError(cause);
      }
    },
  );
  server.tool(
    'workspace_write',
    `Atomically replace one UTF-8 file inside the Argus-owned run workspace ${root}. Argus Dev retains branch, test, commit, push and approval ownership.`,
    {
      path: z.string().min(1).describe(`Absolute file path under ${root}.`),
      content: z.string().max(256 * 1024).describe('Complete UTF-8 file content.'),
    },
    async ({ path: requested, content }) => {
      try {
        const target = assertRuntimeWorkspacePath(requested, root);
        return mcpResult(await executeWorkspaceTool('workspace_write', { path: target, content }, root));
      } catch (cause) {
        return resultError(cause);
      }
    },
  );
}
