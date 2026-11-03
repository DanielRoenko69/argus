/**
 * Unified Tool Runner — executes any tool (dynamic, remote MCP) by name.
 * Used by the Workflow Executor and the manual /run endpoint.
 */

import type pg from 'pg';
import type { Config } from '../config/env.js';
import {
  loadDynamicTools,
  renderTemplate,
  renderSqlTemplate,
  executePg,
  executeHttp,
  parseHttpRequestSpec,
} from './dynamic/index.js';
import type { DynamicToolRow, ToolParameter } from './dynamic/index.js';
import { findConnectionForTool, executeRemoteTool, getAllRemoteTools } from '../backends/remoteMcpClients.js';
import { parseCustomBackendRef, findBackendByName, executeCustomBackend } from '../backends/customBackends.js';
import type { CredOverride } from '../backends/customBackends.js';
import { executeWorkspaceTool, WORKSPACE_TOOL_PREFIX } from './workspace.js';
import { executeRagTool, RAG_TOOL_PREFIX } from './ragTools.js';
import { executeCodegraphTool, CODEGRAPH_TOOL_PREFIX } from './codegraph.js';
import { logger } from '../lib/logger.js';
import { executeArgusObservabilityTool, isArgusObservabilityTool } from '../observability/observabilityTools.js';
import { executeArgusCodeIntelligenceTool, isArgusCodeIntelligenceTool } from '../codeIntelligence/tools.js';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolRunnerContext {
  config: Config;
  pool: pg.Pool;
  allowedBundles?: number[] | null;
  workspaceRoot?: string;
  repositoryKey?: string;
  branchHint?: string | null;
  /** Compatibility field. Generic tool-result caching is currently disabled. */
  skipCache?: boolean;
}

/**
 * Execute any tool by name.
 * Dispatch order: remote MCP → dynamic tool (DB)
 *
 * `credOverride` binds a visual workflow step to a backend. The HTTP adapter
 * selects user OAuth or explicit service identity at call time. It cannot lower
 * backend policy. Shared result caching is deliberately disabled: name+args is
 * not an authorization boundary, nor does it invalidate on token revocation.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolRunnerContext,
  credOverride?: CredOverride,
): Promise<ToolResult> {
  // 0a. Workspace tools are stateful — skip cache entirely, early return
  if (toolName.startsWith(WORKSPACE_TOOL_PREFIX)) {
    return executeWorkspaceTool(toolName, args);
  }

  let result: ToolResult;

  // 0b. Agentic RAG tools
  if (toolName.startsWith(RAG_TOOL_PREFIX)) {
    result = await executeRagTool(ctx.pool, toolName, args);

  // 0c. codegraph tools — scoped knowledge-graph queries via workspace sidecar
  } else if (toolName.startsWith(CODEGRAPH_TOOL_PREFIX)) {
    result = await executeCodegraphTool(toolName, args, ctx.workspaceRoot);

  // 0d. Native read-only Argus investigation tools
  } else if (isArgusObservabilityTool(toolName)) {
    result = await executeArgusObservabilityTool(
      ctx.pool,
      toolName,
      args,
      ctx.allowedBundles ?? null,
    );

  // 0e. Native, immutable and bundle-scoped code retrieval
  } else if (isArgusCodeIntelligenceTool(toolName)) {
    result = await executeArgusCodeIntelligenceTool(
      ctx.pool,
      toolName,
      args,
      ctx.allowedBundles ?? null,
      {
        workspaceRoot: ctx.workspaceRoot,
        repositoryKey: ctx.repositoryKey,
        branchHint: ctx.branchHint,
      },
    );

  // 1. Remote MCP tool
  } else {
    const remoteConn = findConnectionForTool(toolName);
    if (remoteConn) {
      if (credOverride && (credOverride.token !== null || credOverride.backendId !== remoteConn.backendId)) {
        return { content: [{ type: 'text', text: 'Credential reference does not match the remote MCP connection' }], isError: true };
      }
      const r = await executeRemoteTool(toolName, args);
      result = { content: r.content.map(c => ({ type: 'text' as const, text: c.text })), isError: r.isError };

    // 2. Dynamic tool from DB
    } else {
      const allTools = await loadDynamicTools(ctx.pool);
      const dynamicTool = allTools.find(t => t.name === toolName);
      result = dynamicTool
        ? await executeDynamicToolStandalone(dynamicTool, args, ctx, credOverride)
        : { content: [{ type: 'text', text: `Tool '${toolName}' not found` }], isError: true };
    }
  }

  return result;
}

/**
 * Execute a dynamic tool outside of the MCP server context.
 * Mirrors the logic in registerDynamicTool() callback.
 */
async function executeDynamicToolStandalone(
  tool: DynamicToolRow,
  args: Record<string, unknown>,
  ctx: ToolRunnerContext,
  credOverride?: CredOverride,
): Promise<ToolResult> {
  try {
    if (!tool.query_template) {
      return {
        content: [{ type: 'text', text: `Error: Tool '${tool.name}' has no query template` }],
        isError: true,
      };
    }

    const paramDefs: ToolParameter[] =
      typeof tool.parameters === 'string' ? JSON.parse(tool.parameters) : tool.parameters;
    let result: string;

    const customRef = parseCustomBackendRef(tool.backend);
    if (customRef) {
      const backend = findBackendByName(customRef);
      if (!backend) {
        return {
          content: [{ type: 'text', text: `Custom backend '${customRef}' not found or disabled` }],
          isError: true,
        };
      }
      const rendered = renderTemplate(tool.query_template, args, paramDefs);
      const request = parseHttpRequestSpec(rendered);
      result = await executeCustomBackend(
        backend,
        request.method,
        request.target,
        request.body,
        tool.required_auth_mode ?? null,
        credOverride,
        request.headers,
      );
    } else {
      if (credOverride) throw new Error('Credential references require a matching custom HTTP backend');
      if (tool.required_auth_mode && tool.required_auth_mode !== 'service-account') {
        throw new Error('User OAuth requires a configured custom backend; no service fallback was used');
      }
      switch (tool.backend) {
        case 'postgresql': {
          const { sql, values } = renderSqlTemplate(tool.query_template, args, paramDefs);
          result = await executePg(ctx.pool, sql, values);
          break;
        }
        case 'http': {
          const rendered = renderTemplate(tool.query_template, args, paramDefs);
          result = await executeHttp(rendered);
          break;
        }
        default:
          return {
            content: [{ type: 'text', text: `Unknown backend: ${tool.backend}` }],
            isError: true,
          };
      }
    }

    return { content: [{ type: 'text', text: result }] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error executing tool '${tool.name}': ${message}` }],
      isError: true,
    };
  }
}

/**
 * List all available tools (for the workflow step builder dropdown).
 */
export async function listAllTools(ctx: ToolRunnerContext): Promise<Array<{
  name: string;
  type: 'dynamic' | 'remote';
  description: string;
  backend: string;
}>> {
  const tools: Array<{ name: string; type: 'dynamic' | 'remote'; description: string; backend: string }> = [];

  // DB tools (dynamic)
  const dbTools = await loadDynamicTools(ctx.pool);
  for (const t of dbTools) {
    tools.push({
      name: t.name,
      type: 'dynamic',
      description: t.description,
      backend: t.backend,
    });
  }

  // Remote MCP tools
  for (const rt of getAllRemoteTools()) {
    tools.push({
      name: rt.prefixedName,
      type: 'remote',
      description: rt.description,
      backend: 'remote-mcp',
    });
  }

  return tools;
}
