import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pg from 'pg';
import type { Config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerDynamicTools, registerDynamicTool, loadDynamicTools, buildInputSchema } from '../tools/dynamic/index.js';
import { registerResources } from '../tools/resources/index.js';
import { registerKnowledgeTools } from '../tools/knowledge/index.js';
import { registerPrompts } from '../tools/prompts/index.js';
import type { DynamicToolRow, ToolParameter } from '../tools/dynamic/index.js';
import { getRemoteConnections, executeRemoteTool } from '../backends/remoteMcpClients.js';
import { getCustomBackends } from '../backends/customBackends.js';
import { listBundles, getBundleTools } from '../bundles/serviceBundles.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { loadWorkflows, createExecution, updateExecution } from '../workflows/workflowStore.js';
import { executeWorkflow } from '../workflows/executor.js';
import { executeTool } from '../tools/toolRunner.js';
import { registerRuntimeWorkspaceTools, type RuntimeWorkspaceAccess } from '../tools/runtimeWorkspace.js';
import { makeHookedToolRunner } from '../workflows/hookedToolRunner.js';
import { buildRealRunners } from '../workflows/executeRoutes.js';
import {
  applyWorkflowAgentAssignments,
  preflightWorkflowAgents,
  workflowExecutionSnapshot,
} from '../workflows/agentContracts.js';
import { writeAuditEntry } from '../lib/audit.js';
import { isToolAllowed } from '../auth/apiKeyRbac.js';
import { toolCallCounter, toolDurationHistogram } from '../lib/metrics.js';
import { runPostToolHooks, runPreToolHooks, type HookContext } from '../agents/hooks/index.js';
import { registerArgusObservabilityTools } from '../observability/observabilityTools.js';
import { registerArgusCodeIntelligenceTools } from '../codeIntelligence/tools.js';
import {
  registerHermesDevBridgeTools,
  type HermesDevBridge,
  type HermesDevBridgeCaller,
} from '../solutionPacks/hermesDevBridge.js';

const { Pool } = pg;

// ── Shared Pool Singleton ────────────────────────────────────
// Reused across all createMcpServer() calls — avoids spawning a new
// connection pool per MCP session.
let _sharedPool: pg.Pool | null = null;

function getSharedPool(connectionUrl: string): pg.Pool {
  if (!_sharedPool) {
    _sharedPool = new Pool({ connectionString: connectionUrl });
  }
  return _sharedPool;
}

// ── Session Context (RBAC) ──────────────────────────────────

export interface SessionContext {
  apiKeyPrefix: string | null;
  tenantKey?: string;
  workspaceKey?: string;
  allowedBundles: number[] | null; // null = unrestricted
  allowedTools: string[] | null;   // whitelist patterns, null = all allowed
  deniedTools: string[] | null;    // blacklist patterns, null = none denied
  systemPrompt?: string | null;
  agentRole?: string | null;
  sessionId?: string | null;       // für Message Filter Payload
  compositeId?: number | null;     // für Composite MCP Endpoints
  callingUser?: { id: number; entra_groups: string[] } | null;
  /** Exact Core agent selected by an isolated external runtime lease. */
  agentId?: number | null;
  agentName?: string | null;
  /** Opaque Core-side lease ID; never a bearer credential. */
  runtimeLeaseId?: string | null;
  /** Signed per-run workspace scope for a managed external runtime. */
  runtimeWorkspaceRoot?: string | null;
  runtimeWorkspaceAccess?: RuntimeWorkspaceAccess | null;
}

export interface McpServerResult {
  server: McpServer;
  dynamicTools: DynamicToolRow[];
}

export interface McpServerOptions {
  /** If set, only register remote MCP tools from this backend name. */
  filterBackend?: string;
  /**
   * Build the deliberately narrow MCP catalog for an isolated external
   * runtime. It contains only Bundle-authorized dynamic, remote MCP and
   * Bundle-owned native tools. Generic Core built-ins, prompts, resources,
   * knowledge and workflow tools are absent even from tools/list.
   */
  runtimeLease?: boolean;
  /**
   * Build the personal-Hermes ingress catalog. It intentionally contains only
   * the Argus Dev bridge tools and can never be combined with a worker runtime
   * lease, preventing recursive Argus Dev delegation from a child Hermes.
   */
  hermesDevBridge?: {
    bridge: HermesDevBridge;
    caller: HermesDevBridgeCaller;
  };
}

export function mcpCatalogSections(options?: McpServerOptions): {
  genericCore: boolean;
  bundleOwnedBuiltins: boolean;
} {
  const backendFiltered = Boolean(options?.filterBackend);
  return {
    genericCore: !backendFiltered && !options?.runtimeLease,
    // Runtime leases are already restricted to operator-approved read-only
    // Bundles. Native handlers still intersect the exact Bundle tool names.
    bundleOwnedBuiltins: !backendFiltered,
  };
}

// ── Bundle filtering ────────────────────────────────────────

function filterByBundles(tools: DynamicToolRow[], allowed: number[] | null): DynamicToolRow[] {
  if (allowed == null) return tools;
  const set = new Set(allowed);
  return tools.filter(t =>
    t.bundle_ids.length === 0 || t.bundle_ids.some(id => set.has(id))
  );
}

// ── Main factory ────────────────────────────────────────────

export async function createMcpServer(config: Config, sessionCtx?: SessionContext, options?: McpServerOptions): Promise<McpServerResult> {
  const server = new McpServer({
    name: 'argus',
    version: '1.0.0',
  }, {
    capabilities: {
      logging: {},
      tools: { listChanged: true },
      resources: {},
      prompts: {},
    },
  });

  const allowedBundles = sessionCtx?.allowedBundles ?? null;
  let bundleAllowedToolNames: Set<string> | null = null;
  if (allowedBundles != null && config.postgresEnabled) {
    try {
      bundleAllowedToolNames = await loadAllowedToolNames(
        getSharedPool(config.postgresConnectionUrl),
        allowedBundles,
        { includeUnscoped: false },
      );
    } catch (error) {
      bundleAllowedToolNames = new Set();
      logger.error({ err: error, allowedBundles }, 'Bundle tool policy resolution failed — denying scoped tools');
    }
  }
  const apiKeyPrefix = sessionCtx?.apiKeyPrefix ?? null;
  const runtimeHookPool = config.postgresEnabled
    ? getSharedPool(config.postgresConnectionUrl)
    : null;
  const toolFilter = (sessionCtx?.allowedTools || sessionCtx?.deniedTools)
    ? { allowed_tools: sessionCtx.allowedTools ?? null, denied_tools: sessionCtx.deniedTools ?? null,
        key_prefix: '', label: '', allowed_bundles: null, scope: 'both' as const, enabled: true, key_hash: null }
    : null;

  // ── Audit-logging wrapper: intercept every server.tool() registration ──
  const origTool = server.tool.bind(server);
  (server as unknown as Record<string, unknown>).tool = function auditWrappedTool(...registerArgs: unknown[]) {
    // server.tool() has multiple overloads; the callback is always the last argument
    const lastIdx = registerArgs.length - 1;
    const originalCb = registerArgs[lastIdx] as (...cbArgs: unknown[]) => Promise<unknown>;
    const toolName: string = registerArgs[0] as string;

    registerArgs[lastIdx] = async (...cbArgs: unknown[]) => {
      // ── Tool RBAC enforcement ──────────────────────────────
      if (toolFilter && !isToolAllowed(toolFilter, toolName)) {
        const denial = `Tool '${toolName}' ist für diesen API-Key nicht erlaubt.`;
        writeAuditEntry({
          apiKeyPrefix: apiKeyPrefix ?? '',
          tool: toolName,
          parameters: (cbArgs[0] && typeof cbArgs[0] === 'object')
            ? cbArgs[0] as Record<string, unknown>
            : {},
          durationMs: 0,
          resultSize: denial.length,
          isError: true,
          errorMessage: denial,
        }).catch(() => {});
        return {
          content: [{ type: 'text', text: denial }],
          isError: true,
        };
      }

      // ── Shared runtime controls (built-ins + external policies) ──
      let callArgsForHooks = (cbArgs[0] && typeof cbArgs[0] === 'object')
        ? cbArgs[0] as Record<string, unknown>
        : {};
      const hookContext: HookContext = {
        agentId: sessionCtx?.agentId ?? 0,
        agentName: sessionCtx?.agentName ?? 'mcp-client',
        sessionId: sessionCtx?.sessionId ?? `mcp:${apiKeyPrefix ?? 'anonymous'}`,
        toolName,
        toolArgs: callArgsForHooks,
        iteration: 1,
        agentDepth: 0,
        apiKeyPrefix,
        userId: sessionCtx?.callingUser?.id,
        userGroups: sessionCtx?.callingUser?.entra_groups ?? [],
      };
      if (runtimeHookPool) {
        const pre = await runPreToolHooks(runtimeHookPool, hookContext);
        if (pre.decision === 'block') {
          writeAuditEntry({
            apiKeyPrefix: apiKeyPrefix ?? '',
            tool: toolName,
            parameters: callArgsForHooks,
            durationMs: 0,
            resultSize: 0,
            isError: true,
            errorMessage: `[HOOK_BLOCKED:${pre.hookName}] ${pre.reason}`,
          }).catch(() => {});
          return {
            content: [{ type: 'text', text: `Tool '${toolName}' was blocked by runtime control '${pre.hookName}': ${pre.reason}` }],
            isError: true,
          };
        }
        if (pre.decision === 'modify' && pre.modifiedArgs) {
          callArgsForHooks = pre.modifiedArgs;
          hookContext.toolArgs = pre.modifiedArgs;
          cbArgs = [pre.modifiedArgs, ...cbArgs.slice(1)];
        }
      }

      const start = Date.now();
      let isError = false;
      let errorMessage: string | undefined;
      let resultSize = 0;
      try {
        const result = await originalCb(...cbArgs);
        const r = result as { content?: Array<{ text?: string }>; isError?: boolean };
        if (r?.isError) {
          isError = true;
          errorMessage = r.content?.[0]?.text?.slice(0, 500);
        }
        resultSize = r?.content?.reduce((s, c) => s + (c.text?.length ?? 0), 0) ?? 0;
        if (runtimeHookPool) {
          await runPostToolHooks(runtimeHookPool, {
            ...hookContext,
            toolArgs: callArgsForHooks,
            toolResult: r?.content?.map(item => item.text ?? '').join('\n') ?? '',
            toolIsError: isError,
          });
        }
        return result;
      } catch (err) {
        isError = true;
        errorMessage = err instanceof Error ? err.message : String(err);
        if (runtimeHookPool) {
          await runPostToolHooks(runtimeHookPool, {
            ...hookContext,
            toolArgs: callArgsForHooks,
            toolResult: errorMessage,
            toolIsError: true,
          });
        }
        throw err;
      } finally {
        const durationMs = Date.now() - start;
        const status = isError ? 'error' : 'success';
        // Prometheus metrics
        toolCallCounter.inc({ tool: toolName, status });
        toolDurationHistogram.observe({ tool: toolName }, durationMs / 1000);
        // Extract args: for Zod-validated tools the first cbArg is the parsed args object
        const callArgs = (cbArgs[0] && typeof cbArgs[0] === 'object') ? cbArgs[0] as Record<string, unknown> : {};
        writeAuditEntry({
          apiKeyPrefix: apiKeyPrefix ?? '',
          tool: toolName,
          parameters: callArgs,
          durationMs,
          resultSize,
          isError,
          errorMessage,
        }).catch(() => {}); // fire-and-forget
      }
    };

    return (origTool as (...a: unknown[]) => unknown)(...registerArgs);
  };

  if (options?.hermesDevBridge) {
    if (options.runtimeLease || options.filterBackend) {
      throw new Error('Hermes Dev bridge cannot be combined with another MCP catalog mode');
    }
    registerHermesDevBridgeTools(
      server,
      options.hermesDevBridge.bridge,
      options.hermesDevBridge.caller,
    );
    return { server, dynamicTools: [] };
  }

  if (options?.runtimeLease && sessionCtx?.runtimeWorkspaceRoot && sessionCtx.runtimeWorkspaceAccess) {
    registerRuntimeWorkspaceTools(
      server,
      sessionCtx.runtimeWorkspaceRoot,
      sessionCtx.runtimeWorkspaceAccess,
    );
  }

  // ── Dynamic tools from DB ──────────────────────────────────
  let allTools: DynamicToolRow[] = [];

  if (!options?.filterBackend) {
    const sections = mcpCatalogSections(options);
    // Full endpoint: register all tool categories
    const dynamicTools = await registerDynamicTools(server, config, allowedBundles, bundleAllowedToolNames);
    allTools = dynamicTools;
    if (sections.genericCore) {
      registerListServiceBundles(server, config, allowedBundles);
      registerResources(server, config);
      registerKnowledgeTools(server, config);
      registerPrompts(server, config, sessionCtx, getSharedPool(config.postgresConnectionUrl));
      await registerWorkflowTools(server, config, allowedBundles, toolFilter, sessionCtx?.callingUser ?? undefined);
    }
    if (sections.bundleOwnedBuiltins && config.postgresEnabled) {
      await registerArgusObservabilityTools(
        server,
        getSharedPool(config.postgresConnectionUrl),
        bundleAllowedToolNames,
        allowedBundles,
      );
      await registerArgusCodeIntelligenceTools(
        server,
        getSharedPool(config.postgresConnectionUrl),
        bundleAllowedToolNames,
        allowedBundles,
      );
    }
  }

  // Remote MCP tools — optionally filtered to a single backend
  registerRemoteMcpTools(server, allowedBundles, bundleAllowedToolNames, options?.filterBackend);

  return { server, dynamicTools: allTools };
}

// ── list_service_bundles (session-scoped) ───────────────────

function registerListServiceBundles(server: McpServer, config: Config, allowedBundles: number[] | null): void {
  if (!config.postgresEnabled) return;

  const bundlePool = getSharedPool(config.postgresConnectionUrl);
  server.tool(
    'list_service_bundles',
    'Alle konfigurierten Service-Bundles auflisten mit deren zugeordneten Tools. Nutze dies um herauszufinden welche Services konfiguriert sind.',
    {},
    async () => {
      try {
        let bundles = await listBundles(bundlePool);

        if (allowedBundles != null) {
          const allowed = new Set(allowedBundles);
          bundles = bundles.filter(b => allowed.has(b.id));
        }

        const result = await Promise.all(bundles.map(async (b) => {
          const tools = await getBundleTools(bundlePool, b.id);
          return {
            name: b.name,
            label: b.label,
            description: b.description,
            backends: b.backend_count,
            tools: tools.map(t => ({ name: t.name, description: t.description })),
          };
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error listing bundles: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}

// ── JSON Schema → Zod conversion for remote tool schemas ────

function jsonSchemaToZod(inputSchema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const properties = (inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set((inputSchema.required ?? []) as string[]);

  for (const [key, prop] of Object.entries(properties)) {
    let schema: z.ZodTypeAny;
    switch (prop.type) {
      case 'number':
      case 'integer':
        schema = z.number();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      case 'array':
        schema = z.array(z.unknown());
        break;
      case 'object':
        schema = z.record(z.unknown());
        break;
      default:
        schema = z.string();
    }
    if (prop.description) schema = schema.describe(prop.description);
    if (!required.has(key)) schema = schema.optional();
    shape[key] = schema;
  }

  return shape;
}

// ── Register tools from connected remote MCP servers ────────

function registerRemoteMcpTools(
  server: McpServer,
  allowedBundles: number[] | null,
  allowedToolNames: Set<string> | null,
  filterBackend?: string,
): void {
  const connections = getRemoteConnections();
  let totalRegistered = 0;

  const backends = getCustomBackends();
  const backendBundleMap = new Map<number, number[]>();
  for (const b of backends) {
    backendBundleMap.set(b.id, b.bundle_ids);
  }

  for (const conn of connections.values()) {
    if (!conn.connected) continue;

    // Backend filter: only tools from this specific backend
    if (filterBackend && conn.backendName !== filterBackend) continue;

    if (allowedBundles != null) {
      const bundleIds = backendBundleMap.get(conn.backendId) ?? [];
      if (bundleIds.length > 0 && !bundleIds.some(id => allowedBundles.includes(id))) {
        continue;
      }
    }

    for (const tool of conn.tools) {
      if (allowedBundles != null && !allowedToolNames?.has(tool.prefixedName)) continue;
      const zodSchema = jsonSchemaToZod(tool.inputSchema);
      const prefixed = tool.prefixedName;

      // audit M3: a remote tool whose prefixed name collides with a builtin /
      // dynamic / another-backend tool makes the SDK's server.tool() THROW
      // ("Tool X is already registered"), which would 500 the ENTIRE /mcp
      // session — a single misnamed federated backend taking down all tool
      // access. Skip + log the collision instead of letting it propagate.
      try {
        server.tool(
          prefixed,
          `[${conn.backendName}] ${tool.description}`,
          zodSchema,
          async (args) => {
            const result = await executeRemoteTool(prefixed, args as Record<string, unknown>);
            return {
              content: result.content.map(c => ({ type: 'text' as const, text: c.text })),
              isError: result.isError,
            };
          },
        );
        totalRegistered++;
      } catch (err) {
        logger.warn(
          { backend: conn.backendName, tool: prefixed, err: err instanceof Error ? err.message : String(err) },
          'remote MCP tool name collision — skipping this tool',
        );
      }
    }
  }

  if (totalRegistered > 0) {
    logger.info({ count: totalRegistered }, 'Remote MCP tools registered as proxies');
  }
}

// ── Workflow tools ──────────────────────────────────────────

async function registerWorkflowTools(
  server: McpServer,
  config: Config,
  allowedBundles: number[] | null,
  toolFilter: import('../auth/apiKeyRbac.js').ApiKeyRbacEntry | null = null,
  callingUser?: NonNullable<SessionContext['callingUser']>,
): Promise<void> {
  if (!config.postgresEnabled) return;

  const pool = getSharedPool(config.postgresConnectionUrl);
  try {
    // Check if workflows table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'mcp_workflows'
      ) AS exists
    `);
    if (!tableCheck.rows[0]?.exists) return;

    const workflows = await loadWorkflows(pool, allowedBundles);
    const enabledWorkflows = workflows.filter(w => w.enabled);

    for (const workflow of enabledWorkflows) {
      const toolName = `workflow_${workflow.name}`;

      // Build Zod schema from input_params
      const inputSchema: Record<string, z.ZodTypeAny> = {};
      for (const param of workflow.input_params) {
        let schema: z.ZodTypeAny;
        switch (param.type) {
          case 'number': schema = z.number().describe(param.description); break;
          case 'boolean': schema = z.boolean().describe(param.description); break;
          default: schema = z.string().describe(param.description); break;
        }
        if (!param.required) schema = schema.optional();
        inputSchema[param.name] = schema;
      }

      server.tool(
        toolName,
        `[Workflow] ${workflow.description}`,
        inputSchema,
        async (args) => {
          const execPool = getSharedPool(config.postgresConnectionUrl);
          const agentPreflight = await preflightWorkflowAgents(execPool, workflow);
          if (!agentPreflight.ready) {
            return {
              content: [{
                type: 'text' as const,
                text: `Workflow Agent contract is not ready:\n${agentPreflight.blockers.map(blocker => `- ${blocker}`).join('\n')}`,
              }],
              isError: true,
            };
          }
          const resolvedWorkflow = applyWorkflowAgentAssignments(workflow, agentPreflight);
          const executionId = await createExecution(
            execPool,
            workflow.id,
            'mcp_tool',
            args as Record<string, unknown>,
            workflowExecutionSnapshot(agentPreflight),
          );
          const toolRunnerCtx = { config, pool: execPool, allowedBundles };

          // M3: enforce tool RBAC inside workflow steps — same rules as direct tool calls.
          const rbacFilteredRunner = (name: string, toolArgs: Record<string, unknown>) => {
            if (toolFilter && !isToolAllowed(toolFilter, name)) {
              return Promise.resolve({
                content: [{ type: 'text' as const, text: `Tool '${name}' ist für diesen API-Key nicht erlaubt (Workflow-Step).` }],
                isError: true,
              });
            }
            return executeTool(name, toolArgs, toolRunnerCtx);
          };
          // Audit #1: the public /mcp tool path also bypassed the tool-execution
          // hooks. Wrap the RBAC-filtered runner so destructive-cmd / PII / cost
          // guards fire for MCP-client-driven workflow steps too. A verified
          // user-bound MCP session retains that identity; service keys do not
          // borrow an unrelated ambient browser identity.
          const hookedRunner = makeHookedToolRunner(execPool, config, {
            source: 'mcp_tool',
            sessionId: `mcp:${executionId}`,
            userId: callingUser?.id,
            userGroups: callingUser?.entra_groups,
            workflowId: workflow.id,
            workflowExecutionId: executionId,
          }, rbacFilteredRunner);
          const runners = buildRealRunners(
            execPool,
            config,
            hookedRunner,
            new Set([workflow.id]),
            0,
            callingUser,
          );
          const result = await executeWorkflow({
            workflow: resolvedWorkflow,
            inputs: args as Record<string, unknown>,
            toolRunner: hookedRunner,
            runners,
            executionId,
            triggeredBy: 'mcp_tool',
          });

          await updateExecution(execPool, executionId, result.status, result.stepResults, result.error);

          // Collect step outputs
          const outputs: string[] = [`## Workflow: ${workflow.name} (${result.status})\n`];
          for (const [stepId, sr] of Object.entries(result.stepResults)) {
            outputs.push(`### Step: ${stepId} (${sr.status}, ${sr.duration_ms}ms)`);
            if (sr.result) outputs.push(typeof sr.result === 'string' ? sr.result : JSON.stringify(sr.result, null, 2));
            if (sr.error) outputs.push(`Error: ${sr.error}`);
          }

          return {
            content: [{ type: 'text' as const, text: outputs.join('\n\n') }],
            isError: result.status === 'failed',
          };
        },
      );
    }

    if (enabledWorkflows.length > 0) {
      logger.info({ count: enabledWorkflows.length }, 'Workflow tools registered');
    }
  } catch (err) {
    logger.debug({ err }, 'Workflow tools registration skipped (table may not exist yet)');
  }
}
