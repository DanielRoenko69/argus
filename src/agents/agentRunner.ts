/**
 * Agent Runner — provider-neutral agentic LLM loop with tool calling.
 * Streams SSE tokens back to the caller via an AsyncGenerator.
 */

import pg from 'pg';
import { randomUUID } from 'crypto';
import { agentPromptEvidence } from './promptEvidence.js';
import type { Config } from '../config/env.js';
import type { ChatMessage, ContentPart, ToolCall, PrContext, RagIndex, Citation } from './types.js';
import { agentAccessGate, getAgent, getSession, appendMessages, createSession, appendBranch, replaceSessionMessages, updateSessionPrContext, type AgentAccessUser } from './agentStore.js';
import { resolveActivePath, chainBranch, normalizeLinear, ancestorsInclusive } from './messageTree.js';
import {
  registerSessionStart,
  recordIterationStart,
  recordToolCallStart,
  recordToolCallEnd,
  recordTokenUsage,
  recordStreaming,
  unregisterSession,
} from './activeSessions.js';
import { formatRagContext, toCitations, attachCitationsToLastAssistant } from './ragClient.js';
import { searchRagIndex } from './ragSearch.js';
import { executeTool } from '../tools/toolRunner.js';
import { getAllRemoteTools } from '../backends/remoteMcpClients.js';
import { loadDynamicTools } from '../tools/dynamic/index.js';
import { logger } from '../lib/logger.js';
import { writeAuditEntry } from '../lib/audit.js';
import { readPinnedAgentSkills } from './skillStore.js';
import {
  retrieveMemories,
  formatMemoryContext,
  extractAndStoreMemories,
  isAutomaticAgentMemoryEnabled,
} from './memory.js';
import { runClaudeWorkerAgent, type WorkerToolExecutionResult } from './claudeRunner.js';
import { runCompactingWorkerAgent } from './sdkRunner.js';
import { scoreAgentTurn } from './continuousEval.js';
import { filterToolsForTask } from './toolSearch.js';
import type { ToolDef } from './toolSearch.js';
import {
  extractRequestedFileTargets,
  scopeSolutionPackWorkerTools,
  solutionPackToolCatalogPrompt,
  validateExecutionResourceScopeCall,
} from './solutionPackToolScope.js';
import type { ExecutionResourceScope } from '../solutionPacks/executionTargets.js';
import { buildStableSystemPrompt, buildWorkerStandards } from './promptBuilder.js';
import { wrapToolOutput } from './toolOutputTagging.js';
import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET, USE_SDK_RUNNER } from '../config/env.js';
import { decrypt } from '../lib/encryption.js';
import { writeImmutableAudit } from '../audit/immutableAudit.js';
import { openTrace, enterTraceContext, withTraceContext } from '../lib/langfuseTracing.js';
import { streamChatCompletion } from '../llm/client.js';
import { resolveRegisteredLlmTarget } from '../llm/modelRegistry.js';
import type { LlmTarget } from '../llm/types.js';
import { getAgentRuntimeAssignment } from './runtimeProfiles.js';
import { getAgentRuntimeExecutor, type ManagedAgentRuntimeContext } from './runtimeExecutor.js';
import { assertAttachedHermesExecutionScope, buildAttachedHermesInput, buildManagedHermesInput } from './hermesRuntimeExecutor.js';
import {
  formatManagedRuntimeMemoryContext,
  parseManagedRuntimeMemoryOutput,
  recordManagedRuntimeMemoryProposal,
  retrieveManagedRuntimeMemories,
} from './managedRuntimeMemory.js';
import { assertAgentExecutionReady } from './agentReadiness.js';
import { intersectAgentBundleScope } from '../auth/bundleScope.js';
import { WORKSPACE_TOOLS } from '../tools/workspace.js';
import { getAgentRagTools } from '../tools/ragTools.js';
import {
  callSubagentSingle,
  callSubagentsParallel,
  formatParallelResults,
  subagentToolDefs,
  getSubagentDepth,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_TOOL_SINGLE,
  SUBAGENT_TOOL_PARALLEL,
  type SubagentCall,
} from './subagents.js';
import { runPreToolHooks, runPostToolHooks } from './hooks/index.js';
import type { HookContext } from './hooks/index.js';
import { ensureCodegraphReady } from './workspace/codegraphPrejob.js';
import {
  ensureNativeWorkspaceCodeIndex,
  resolveNativeCodeBundleAccess,
  type NativeCodeBundleAccess,
} from '../codeIntelligence/workspaceIndexer.js';
import { tokenUsageEvent } from './tokenUsage.js';
import { resolveModelParams, type ParamOverrides } from './modelParams.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { isToolAllowedByPatterns, type ToolPatternPolicy } from '../auth/apiKeyRbac.js';
import { buildAgentRepositoryKnowledge } from './codeIndexKnowledge.js';

function approvalScope(parameters: Record<string, unknown>, sessionId: string): string {
  const parts = Object.entries(parameters)
    .filter(([key]) => /cluster|namespace|environment|repo|repository|branch|project|resource|target/i.test(key))
    .slice(0, 3)
    .map(([key, value]) => `${key}:${typeof value === 'string' ? value.slice(0, 80) : String(JSON.stringify(value) ?? value).slice(0, 80)}`);
  return parts.length > 0 ? parts.join(' · ') : `session:${sessionId.slice(0, 8)}`;
}

function redactApprovalParameters(value: unknown, key = '', depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (/(?:secret|token|password|credential|private.?key|api.?key|authorization)/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactApprovalParameters(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([childKey, childValue]) => [
      childKey,
      redactApprovalParameters(childValue, childKey, depth + 1),
    ]));
  }
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  return value;
}
import {
  finishTelemetrySpan,
  finishTelemetryTrace,
  getNativeTelemetryContext,
  startTelemetrySpan,
  startTelemetryTrace,
  withNativeTelemetryContext,
  type TelemetryHandle,
} from '../observability/telemetryStore.js';
import { boundAgentToolResult, SOLUTION_PACK_TOOL_RESULT_MAX_CHARS } from './toolResultBounds.js';

//ï¿½??ï¿½?? Helpers ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??

function composePrContextBlock(agent: { agent_mode: string; pr_branch?: string | null; pr_number?: number | null; ticket_id?: string | null; task_type?: string | null; bitbucket_repo?: string | null; allowed_paths?: string[] | null }, sessionPrCtx?: PrContext | null): string {
  const branch = sessionPrCtx?.branch ?? agent.pr_branch ?? null;
  const prNumber = sessionPrCtx?.pr_number ?? agent.pr_number ?? null;
  const ticketId = sessionPrCtx?.ticket_id ?? agent.ticket_id ?? null;
  const taskType = sessionPrCtx?.task_type ?? agent.task_type ?? null;
  const repo = sessionPrCtx?.repo ?? agent.bitbucket_repo ?? null;
  const allowedPaths = sessionPrCtx?.allowed_paths ?? agent.allowed_paths ?? null;
  const buildLog = sessionPrCtx?.build_log ?? null;

  if (!branch && !ticketId && !buildLog) return '';

  const modeLabel = agent.agent_mode === 'reviewer'
    ? 'REVIEWER (read-only, mache KEINE Code-ï¿½?nderungen)'
    : 'WORKER (kannst Code lesen und schreiben)';

  const lines: string[] = [
    '## PR Context',
    `- Modus: ${modeLabel}`,
  ];
  if (branch)      lines.push(`- Branch: ${branch}`);
  if (prNumber)    lines.push(`- PR: #${prNumber}`);
  if (ticketId)    lines.push(`- Ticket: ${ticketId}`);
  if (taskType)    lines.push(`- Aufgabe: ${taskType}`);
  if (repo)        lines.push(`- Repo: ${repo}`);
  if (allowedPaths?.length) lines.push(`- Erlaubte Pfade: ${allowedPaths.join(', ')}`);
  if (buildLog)    lines.push(`\n### Build-Fehler Log:\n\`\`\`\n${buildLog.slice(0, 3000)}\n\`\`\``);
  if (sessionPrCtx?.code_index_snapshot_id && sessionPrCtx.code_index_commit_sha) {
    lines.push(`- Native code index snapshot: ${sessionPrCtx.code_index_snapshot_id}`);
    lines.push(`- Code evidence commit: ${sessionPrCtx.code_index_commit_sha}`);
    lines.push('- Use argus_code_search with this exact snapshot before broad repository exploration when the tool is available.');
  }

  return '\n\n' + lines.join('\n');
}

/** Build the gateway user-message content: plain string, or a multimodal array when images are present. */
export function buildUserContent(text: string, images?: { dataUrl: string; name?: string }[]): string | ContentPart[] {
  if (!images || images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((i) => ({ type: 'image_url' as const, image_url: { url: i.dataUrl } })),
  ];
}

/** What to persist for the user turn: text + a compact image marker (never base64). */
export function userPersistText(text: string, images?: { dataUrl: string; name?: string }[]): string {
  if (!images || images.length === 0) return text;
  const names = images.map((i) => i.name ?? 'image').join(', ');
  return `${text} [Bild: ${names}]`;
}

// ── Provider-neutral tool interfaces ──────────────────────────────

interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
      [key: string]: unknown;
    };
  };
}

// ï¿½??ï¿½?? Tool list helpers ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??

function globMatch(pattern: string, name: string): boolean {
  // Simple glob: '*' matches anything, no path separator logic needed
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(name);
}

/**
 * Resolve `..` segments without depending on Node's path module ï¿½?? works for
 * `/workspace/foo/../bar` ï¿½?? `/workspace/bar`. Anything outside `/workspace`
 * stays as-is so the caller's match still rejects it.
 */
function resolvePosixPath(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * Validate workspace tool args against agent.allowed_paths.
 * Returns null if allowed (or no constraint), otherwise an error string.
 *
 * Note: for `workspace_exec`, only the cwd is validated. A cmd like
 * `cd /etc && cat passwd` cannot be statically checked. The path-validation
 * inside the workspace sidecar still rejects /etc as cwd, but a chained
 * `cd` inside `sh -c` is only constrained by file permissions in the
 * sandbox container itself.
 */
function validateWorkspacePathAccess(
  toolName: string,
  args: Record<string, unknown>,
  allowedPaths: string[] | null,
): string | null {
  if (!toolName.startsWith('workspace_')) return null;
  if (!allowedPaths || allowedPaths.length === 0) return null;  // no constraint

  let target: string;
  if (toolName === 'workspace_exec') {
    target = typeof args['cwd'] === 'string' ? args['cwd'] : '/workspace';
  } else if (toolName === 'workspace_ls') {
    target = typeof args['path'] === 'string' ? args['path'] : '/workspace';
  } else {  // workspace_read, workspace_write
    target = typeof args['path'] === 'string' ? args['path'] : '';
  }
  if (!target) return `${toolName}: missing path argument`;

  const resolved = resolvePosixPath(target);
  const ok = allowedPaths.some(p => globMatch(p, resolved));
  if (!ok) {
    return `${toolName} blocked by allowed_paths policy: '${resolved}' is not allowed. ` +
           `Permitted patterns: ${allowedPaths.join(', ')}`;
  }
  return null;
}

function applyPatternFilters(
  toolNames: string[],
  allowPatterns: string[],
  denyPatterns: string[],
): string[] {
  let filtered = toolNames;
  if (allowPatterns.length > 0) {
    filtered = filtered.filter(n => allowPatterns.some(p => globMatch(p, n)));
  }
  if (denyPatterns.length > 0) {
    filtered = filtered.filter(n => !denyPatterns.some(p => globMatch(p, n)));
  }
  return filtered;
}

type CodexReasoningEffort = NonNullable<LlmTarget['runtimeReasoningEffort']>;

function codexReasoningEffort(value: string | null | undefined): CodexReasoningEffort {
  return value === 'minimal' || value === 'low' || value === 'medium'
    || value === 'high' || value === 'xhigh'
    ? value
    : 'high';
}

function codexRuntimeTimeoutMs(): number {
  const configured = Number.parseInt(process.env['ARGUS_CODEX_TIMEOUT_SEC'] ?? '600', 10);
  const seconds = Number.isFinite(configured) ? Math.max(30, Math.min(1_800, configured)) : 600;
  // Leave a small transport margin beyond the workspace runner's own timeout.
  return (seconds + 10) * 1_000;
}

function claudeCodeRuntimeTimeoutMs(): number {
  const configured = Number.parseInt(process.env['ARGUS_CLAUDE_TIMEOUT_SEC'] ?? '900', 10);
  const seconds = Number.isFinite(configured) ? Math.max(30, Math.min(1_800, configured)) : 900;
  return (seconds + 10) * 1_000;
}

function applyScopedWorkspaceDefaults(
  toolName: string,
  args: Record<string, unknown>,
  allowedPaths: string[] | null,
): void {
  if (!allowedPaths?.length) return;
  const root = allowedPaths.find(path => /^\/workspace\/[A-Za-z0-9-]+$/.test(path));
  if (!root) return;
  if (toolName === 'workspace_ls' && (typeof args['path'] !== 'string' || !args['path'])) {
    args['path'] = root;
  }
  if (toolName === 'workspace_exec' && (typeof args['cwd'] !== 'string' || !args['cwd'])) {
    args['cwd'] = root;
  }
}

/**
 * Tool calls are model output and must never be trusted as authorization.
 * Only names from the exact catalog advertised for this turn may reach hooks
 * or an executor. This closes the gap where a model could hallucinate a valid
 * but bundle-external tool name.
 */
export function validateAdvertisedToolCall(
  toolName: string,
  advertisedToolNames: ReadonlySet<string>,
): string | null {
  return advertisedToolNames.has(toolName)
    ? null
    : `Tool '${toolName}' is not available to this agent.`;
}

export async function buildToolList(
  pool: pg.Pool,
  compositeId: number | null,
  agentId: number,
  allowedTools?: string[] | null,
  agentBundleIds?: number[] | null,
  userBundleIds?: number[] | null,
  callingUser?: AgentAccessUser,
): Promise<LlmTool[]> {
  let tools: LlmTool[] = [];

  // Remote MCP tools
  for (const rt of getAllRemoteTools()) {
    const schema = rt.inputSchema && typeof rt.inputSchema === 'object' && !Array.isArray(rt.inputSchema)
      ? rt.inputSchema
      : {};
    const properties = schema['properties'] && typeof schema['properties'] === 'object' && !Array.isArray(schema['properties'])
      ? schema['properties'] as Record<string, Record<string, unknown>>
      : {};
    const required = Array.isArray(schema['required'])
      ? schema['required'].filter((value): value is string => typeof value === 'string')
      : [];
    tools.push({
      type: 'function',
      function: {
        name: rt.prefixedName,
        description: rt.description ?? '',
        parameters: {
          ...schema,
          type: 'object',
          properties,
          ...(required.length ? { required } : {}),
        },
      },
    });
  }

  // Dynamic DB tools
  const dynTools = await loadDynamicTools(pool);
  for (const t of dynTools) {
    if (!t.enabled) continue;
    const params: Record<string, { type: string; description?: string }> = {};
    const required: string[] = [];
    const paramDefs = typeof t.parameters === 'string' ? JSON.parse(t.parameters) : (t.parameters ?? []);
    for (const p of paramDefs) {
      params[p.name] = { type: p.type ?? 'string', description: p.description };
      if (p.required) required.push(p.name);
    }
    tools.push({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: { type: 'object', properties: params, required: required.length ? required : undefined },
      },
    });
  }

  // Builtin workspace tools (only if secret is configured)
  if (WORKSPACE_SECRET) {
    for (const wt of WORKSPACE_TOOLS) tools.push(wt);
  }

  // Agentic RAG ï¿½?? one tool per assigned RAG index
  try {
    const ragTools = await getAgentRagTools(pool, agentId);
    for (const rt of ragTools) tools.push(rt);
  } catch (err) {
    logger.warn({ err, agentId }, 'failed to load RAG tools');
  }

  // Explicit Agent bundles are an authorization boundary for backend-owned
  // capabilities. Workspace and the Agent's own RAG tools remain local.
  if (agentBundleIds && agentBundleIds.length > 0) {
    const allowedFromBundles = await loadAllowedToolNames(pool, agentBundleIds, {
      includeUnscoped: false,
    });
    tools = tools.filter(tool =>
      allowedFromBundles.has(tool.function.name)
      || tool.function.name.startsWith('workspace_')
      || tool.function.name.startsWith('rag_'),
    );
  }

  // Resolve the composite in two phases. Bundle inclusion constrains only the
  // backend-owned catalog assembled above. Glob patterns are deliberately
  // applied later, after synthetic sub-agent tools have been appended, so a
  // composite remains the final advertised capability boundary.
  let compositeAllowPatterns: string[] = [];
  let compositeDenyPatterns: string[] = [];
  if (compositeId !== null) {
    const { rows } = await pool.query(
      'SELECT included_bundle_ids, tool_allow_patterns, tool_deny_patterns FROM mcp_composites WHERE id=$1',
      [compositeId],
    );
    const comp = rows[0];
    if (comp) {
      // Step 1: bundle-inclusion filter
      const bundleIds: number[] = comp.included_bundle_ids ?? [];
      if (bundleIds.length > 0) {
        const scopedBundleIds = userBundleIds == null
          ? bundleIds
          : bundleIds.filter(id => userBundleIds.includes(id));
        const allowedFromBundles = await loadAllowedToolNames(pool, scopedBundleIds, {
          includeUnscoped: false,
        });
        // Builtin tools (workspace_*, rag_*) bypass bundle inclusion ï¿½?? they are
        // always available; allow/deny patterns still gate them.
        tools = tools.filter(t =>
          allowedFromBundles.has(t.function.name)
          || t.function.name.startsWith('workspace_')
          || t.function.name.startsWith('rag_'),
        );
      }

      compositeAllowPatterns = comp.tool_allow_patterns ?? [];
      compositeDenyPatterns = comp.tool_deny_patterns ?? [];
    }
  }

  // Synthetic multi-agent tools include the real agent list to prevent ID
  // hallucination. They are still capabilities and must therefore pass the
  // same composite allow/deny boundary as every other advertised tool.
  const { rows: agentRows } = await pool.query<{
    id: number;
    name: string;
    label: string;
    agent_mode: string;
    bundle_ids: number[] | null;
  }>(
    'SELECT id, name, label, agent_mode, bundle_ids FROM mcp_agents WHERE enabled = true AND id != $1 ORDER BY id',
    [agentId],
  ).catch(() => ({ rows: [] as Array<{
    id: number;
    name: string;
    label: string;
    agent_mode: string;
    bundle_ids: number[] | null;
  }> }));
  const visibleAgentRows = callingUser
    ? (await Promise.all(agentRows.map(async agent => {
      const access = await agentAccessGate(pool, agent.id, callingUser);
      return access.verdict === 'ok' ? agent : null;
    }))).filter((agent): agent is typeof agentRows[number] => agent !== null)
    : agentRows.filter(agent =>
      userBundleIds == null
        || !agent.bundle_ids?.length
        || agent.bundle_ids.some(id => userBundleIds.includes(id)),
    );
  for (const t of subagentToolDefs(visibleAgentRows) as LlmTool[]) tools.push(t);

  if (compositeAllowPatterns.length > 0 || compositeDenyPatterns.length > 0) {
    const names = tools.map(t => t.function.name);
    const kept = new Set(applyPatternFilters(names, compositeAllowPatterns, compositeDenyPatterns));
    tools = tools.filter(t => kept.has(t.function.name));
  }

  // ── Fail-closed explicit allowlist ────────────────────────────────────────
  // Applied AFTER every source (dynamic DB, remote MCP, workspace, composite,
  // subagent) so no future tool source can bypass this gate.
  // Semantics:
  //   undefined / null  → all tools (normal behaviour, no regression)
  //   []                → no tools (public/restricted mode)
  //   ['a', 'b']        → only the named tools
  if (Array.isArray(allowedTools)) {
    const allow = new Set(allowedTools);
    tools = tools.filter(t => allow.has(t.function.name));
  }

  return tools;
}

// ï¿½??ï¿½?? RAG context injection ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??

export async function buildRagContext(
  pool: pg.Pool,
  agentId: number,
  query: string,
  ragIndexIds?: number[], // Item 3: restrict to this subset of bound indexes; undefined/empty = all
  citationsOut?: Citation[], // when provided, filled with structured citations (authenticated /chat)
): Promise<string> {
  // Byte-equivalent base query for the no-ids path; only append the subset
  // filter (and the extra param) when a non-empty id list is provided.
  const filterIds = Array.isArray(ragIndexIds) && ragIndexIds.length > 0;
  const sql = filterIds
    ? `SELECT r.* FROM mcp_rag_indexes r
     JOIN mcp_agent_rag_indexes ar ON ar.rag_index_id = r.id
     WHERE ar.agent_id = $1 AND r.enabled = true AND ar.rag_index_id = ANY($2::int[])
     ORDER BY ar.priority, r.label`
    : `SELECT r.* FROM mcp_rag_indexes r
     JOIN mcp_agent_rag_indexes ar ON ar.rag_index_id = r.id
     WHERE ar.agent_id = $1 AND r.enabled = true
     ORDER BY ar.priority, r.label`;
  const { rows } = await pool.query<{
    id: number; label: string; provider: string; endpoint: string;
    index_name: string; api_key: string | null; semantic_config: string | null; top_k: number;
  }>(
    sql,
    filterIds ? [agentId, ragIndexIds] : [agentId],
  );

  const parts: string[] = [];
  for (const idx of rows) {
    try {
      const results = await searchRagIndex(idx as RagIndex, query, pool);
      if (results.length > 0) {
        parts.push(formatRagContext(results, idx.label));
        if (citationsOut) citationsOut.push(...toCitations(results, idx.label));
      }
    } catch (err) {
      logger.warn({ err, index: idx.label }, 'RAG search failed ï¿½?? skipping');
    }
  }
  return parts.join('\n\n');
}

// ï¿½??ï¿½?? Main runner ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??

export async function* runAgentChat(
  agentId: number,
  sessionId: string,
  userMessage: string,
  pool: pg.Pool,
  config: Config,
  modelOverride?: string, // optional: override agent.model for this turn
  callingUser?: AgentAccessUser, // SSO user context; undefined for API-key callers
  ragIndexIds?: number[], // Item 3: restrict RAG injection to this subset of the agent's bound indexes
  allowedTools?: string[] | null, // Fail-closed tool allowlist: undefined/null = all; [] = none; [...] = exact set
  disableMemory?: boolean, // When true, skip memory read + write (public mode — prevents cross-session data leak)
  emitUsage?: boolean, // when true, emit one token_usage SSE event at turn-end (authenticated /chat only; default off = public-safe)
  userImages?: { dataUrl: string; name?: string }[], // multimodal image_url blocks for THIS turn only (authenticated /chat; public path omits)
  paramOverrides?: ParamOverrides, // per-request temperature/max_tokens/top_p (authenticated /chat; clamped upstream)
  regenerate?: boolean, // re-run the last user turn → append an assistant SIBLING (no new user message)
  branchOpts?: { fromId: string | null }, // edit: branch the new user turn at this node (the edited msg's parent)
  technicalIdentityToolPolicy?: ToolPatternPolicy,
  executionBundleIds?: number[], // Exact Solution Pack grant scope; overrides the Agent's persistent bundles.
  captureFullToolResults = false, // Signed non-streaming Pack calls may retain a bounded result for normalization.
  executionResourceScope?: ExecutionResourceScope, // Signed provider target enforced on every matching tool call.
  managedRuntimeContext?: ManagedAgentRuntimeContext,
  runtimeProfileId?: number, // Core-verified task override; never accepted from an ordinary chat body.
): AsyncGenerator<string> {
  // Recursion guard: a sub-agent that itself spawns sub-agents must terminate
  // within MAX_SUBAGENT_DEPTH levels to avoid runaway costs / infinite chains.
  const depth = getSubagentDepth(sessionId);
  if (depth >= MAX_SUBAGENT_DEPTH) {
    yield `data: ${JSON.stringify({ delta: `(subagent depth limit ${MAX_SUBAGENT_DEPTH} reached ï¿½?? declining further nesting)` })}\n\n`;
    yield 'data: [DONE]\n\n';
    return;
  }

  const agent = await getAgent(pool, agentId, { unmasked: true });
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  const access = await agentAccessGate(pool, agentId, callingUser, {
    allowServiceBundleOverride: callingUser?.service === true
      && technicalIdentityToolPolicy?.apiKeyPrefix?.startsWith('eg_') === true
      && executionBundleIds != null,
  });
  if (access.verdict === 'not_found') throw new Error(`Agent ${agentId} not found`);
  if (access.verdict === 'forbidden') throw new Error(`Agent ${agentId} is not permitted for this caller`);
  const policyCallingUser = callingUser?.service ? undefined : callingUser;

  // Persistent Agent capabilities may never widen the authenticated user's
  // bundle scope. Signed execution grants are narrowed by the same rule when
  // a session user is present.
  const effectiveBundleIds = intersectAgentBundleScope(
    executionBundleIds ?? agent.bundle_ids,
    callingUser?.allowed_bundles,
  );

  const session = await getSession(pool, sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  // A tool-less HTTP Bundle is valid only when the request carries a verified
  // signed execution grant and the session is bound to that grant's workspace.
  // This keeps ordinary Agent/API-key execution fail-closed.
  const isWorkspaceBoundExecutionGrant = technicalIdentityToolPolicy?.apiKeyPrefix?.startsWith('eg_') === true
    && Boolean(session.pr_context?.workspace_dir)
    && Boolean(WORKSPACE_SECRET);

  // One control-plane decision is shared by Agent Studio and every execution
  // path. Explicit Bundle assignments therefore fail before prompt assembly
  // when a connection is disabled, disconnected, untrusted or resolves to no
  // allowed tools. A signed Solution Pack grant may intentionally replace the
  // persistent Agent Bundle scope for its short-lived turn.
  await assertAgentExecutionReady(pool, agent, {
    bundleIds: effectiveBundleIds,
    allowedToolNames: allowedTools,
    allowToollessBundles: isWorkspaceBoundExecutionGrant,
  });

  const runtimeAssignment = await getAgentRuntimeAssignment(pool, agentId, runtimeProfileId);
  if (runtimeAssignment?.profile_id != null && runtimeAssignment.profile_enabled === false) {
    throw new Error(`Runtime profile '${runtimeAssignment.profile_name ?? runtimeAssignment.profile_id}' is disabled`);
  }
  const usesCodexRuntime = runtimeAssignment?.runtime_type === 'codex';
  const usesClaudeCodeRuntime = runtimeAssignment?.runtime_type === 'claude-code';
  const usesHermesRuntime = runtimeAssignment?.runtime_type === 'hermes';
  if ((usesCodexRuntime || usesClaudeCodeRuntime) && !WORKSPACE_SECRET) {
    throw new Error(`${usesCodexRuntime ? 'Codex' : 'Claude Code'} subscription runtime requires WORKSPACE_SECRET`);
  }
  const effectiveModel = usesCodexRuntime
    ? runtimeAssignment.model?.trim() || 'gpt-5.6-terra'
    : usesClaudeCodeRuntime
      ? runtimeAssignment.model?.trim() || 'claude-subscription'
    : usesHermesRuntime
      ? runtimeAssignment.model?.trim() || 'hermes-upstream'
    : modelOverride ?? agent.model ?? 'claude-opus-4-6';

  const isSolutionPackWorker = agent.agent_mode === 'worker'
    && technicalIdentityToolPolicy?.apiKeyPrefix?.startsWith('eg_') === true;
  // Load once: the evidence and the injected bytes must describe the same pins.
  // Hermes and narrow Pack workers do not consume these modules on this path.
  const loadedSkills = isSolutionPackWorker || usesHermesRuntime ? [] : await readPinnedAgentSkills(pool,agentId);
  const skillEvidence = { agent_skill_revisions:loadedSkills.map(s=>({ skill_id:s.id,revision_id:s.revision_id,content_sha256:s.content_sha256 })),
    agent_skill_injection:isSolutionPackWorker || usesHermesRuntime ? 'not_applied_on_this_path' : 'pinned' };

  const ambientTelemetry = getNativeTelemetryContext();
  const tenantKey = ambientTelemetry?.tenantKey ?? callingUser?.tenantKey ?? 'default';
  const workspaceKey = ambientTelemetry?.workspaceKey ?? callingUser?.workspaceKey ?? 'default';

  // Register this session in the live-activity-dashboard registry.
  // Best-effort, process-local; no failure-mode (in-memory only).
  registerSessionStart({
    sessionId,
    agentId,
    agentName: agent.name,
    agentMode: agent.agent_mode,
    callingUserId: policyCallingUser?.id,
    tenantKey,
    workspaceKey,
    userMessage,
  });

  // ── Open Langfuse trace for the entire agent turn ────────────────────
  // This makes the full request appear as ONE trace in Langfuse with the
  // downstream LLM/embedding calls nested as child generations (via the
  // X-Langfuse-Trace-Id header propagation to the gateway).
  const traceName = agent.agent_mode === 'worker' ? 'agent.worker'
                  : agent.agent_mode === 'reviewer' ? 'agent.reviewer'
                  : 'agent.chat';
  const traceTags = [
    `mode:${agent.agent_mode}`,
    `model:${effectiveModel}`,
    `agent:${agent.name}`,
    ...(runtimeAssignment?.runtime_type ? [`runtime:${runtimeAssignment.runtime_type}`] : []),
    ...(session.pr_context?.ticket_id ? [`ticket:${session.pr_context.ticket_id}`] : []),
  ];
  const traceCtx = openTrace({
    name:      traceName,
    sessionId,
    tags:      traceTags,
    metadata: {
      agent_id:    agentId,
      ...agentPromptEvidence(agent),
      ...skillEvidence,
      agent_name:  agent.name,
      agent_mode:  agent.agent_mode,
      agent_role: ambientTelemetry?.agentRole ?? agent.agent_role ?? null,
      workflow_step_id: ambientTelemetry?.workflowStepId ?? null,
      task_type: session.pr_context?.task_type ?? agent.task_type ?? null,
      model:       effectiveModel,
      runtime_profile_id: runtimeAssignment?.profile_id ?? null,
      runtime_profile: runtimeAssignment?.profile_name ?? null,
      runtime_type: runtimeAssignment?.runtime_type ?? 'argus',
      reasoning_effort: runtimeAssignment?.reasoning_effort ?? null,
      ticket_id:   session.pr_context?.ticket_id ?? null,
      pr_branch:   session.pr_context?.branch ?? null,
      subagent_depth: depth,
    },
    input: userMessage,
  });
  // Activate ambient trace context so downstream code (memory.embedText,
  // ragClient.embedQuery, extractAndStoreMemories, ...) can propagate the
  // X-Langfuse-Trace-Id header without explicit threading.
  if (traceCtx.trace.enabled) enterTraceContext(traceCtx.trace.id);

  let telemetryTrace: TelemetryHandle | null = null;
  let telemetryFinished = false;
  let inputCostPer1k = 0;
  let outputCostPer1k = 0;
  let telemetryCostUsd = 0;
  let turnPromptTokens = 0;
  let turnCompletionTokens = 0;
  let lastFullContent = '';
  let telemetryTerminalError: string | null = null;
  let codeIndexSnapshotId: number | null = null;

  try {
  if (usesHermesRuntime) {
    const managedHermes = runtimeAssignment?.execution_strategy === 'managed';
    if (!managedHermes) {
      assertAttachedHermesExecutionScope({
        agentMode: agent.agent_mode,
        hasTechnicalIdentityToolPolicy: technicalIdentityToolPolicy != null,
        hasExecutionBundleOverride: executionBundleIds != null,
        hasToolAllowlist: allowedTools != null,
        hasImages: Boolean(userImages?.length),
        isConversationBranchOperation: Boolean(regenerate || branchOpts),
      });
    } else {
      const managedAgentMode = agent.agent_mode === 'worker' || agent.agent_mode === 'reviewer';
      if (!managedRuntimeContext
        || !managedAgentMode
        || technicalIdentityToolPolicy?.apiKeyPrefix?.startsWith('eg_') !== true
        || executionBundleIds == null
        || !session.pr_context?.workspace_dir) {
        throw new Error('Managed Hermes requires an Argus Dev execution grant bound to one workspace');
      }
      if (managedRuntimeContext.bundleIds.length === 0) {
        throw new Error('Managed Hermes requires at least one operator-approved read-only Bundle');
      }
      if (managedRuntimeContext.workspaceRoot !== session.pr_context.workspace_dir) {
        throw new Error('Managed Hermes workspace does not match the Argus Agent session scope');
      }
      if (userImages?.length || regenerate || branchOpts) {
        throw new Error('Managed Hermes worker turns do not support images or conversation branch operations');
      }
    }
    const runtimeExecutor = getAgentRuntimeExecutor('hermes');
    if (!runtimeExecutor || !runtimeAssignment) {
      throw new Error('Hermes runtime executor is not configured');
    }
    const runtimeProfileId = runtimeAssignment.profile_id;
    if (runtimeProfileId == null) {
      throw new Error('Hermes runtime assignment has no governed runtime profile');
    }

    let managedMemoryContext = '';
    let managedMemoryContextCount = 0;
    if (managedHermes && runtimeAssignment.memory_policy !== 'none') {
      try {
        const memories = await retrieveManagedRuntimeMemories(
          pool,
          agentId,
          managedRuntimeContext!.workspaceRoot,
        );
        managedMemoryContext = formatManagedRuntimeMemoryContext(memories);
        managedMemoryContextCount = memories.length;
      } catch (error) {
        logger.warn({
          err: error,
          agentId,
          runtimeProfileId: runtimeAssignment.profile_id,
          workspaceRoot: managedRuntimeContext!.workspaceRoot,
        }, 'Managed Hermes memory context is unavailable; continuing without memory');
      }
    }

    const runtimeInput = managedHermes
      ? buildManagedHermesInput(
        agent.system_prompt,
        userMessage,
        managedRuntimeContext!.workspaceRoot,
        managedRuntimeContext!.workspaceAccess,
        {
          context: managedMemoryContext,
          allowProposals: runtimeAssignment.memory_policy === 'propose_write',
        },
      )
      : buildAttachedHermesInput(agent.system_prompt, userMessage);
    const runtimeProvider = managedHermes ? 'hermes-managed' : 'hermes-attached';
    const runtimeTrust = managedHermes ? 'core_governed' : 'external_attested';

    let sessionMessages = session.messages ?? [];
    let activeLeafId = session.active_leaf_id ?? null;
    if (activeLeafId === null && sessionMessages.length > 0) {
      const normalized = normalizeLinear(sessionMessages);
      await replaceSessionMessages(pool, sessionId, normalized.messages, normalized.leafId);
      sessionMessages = normalized.messages;
      activeLeafId = normalized.leafId;
    }
    const userBranch = chainBranch(activeLeafId, [{ role: 'user', content: userMessage }]);
    await appendBranch(pool, sessionId, userBranch.chained, userBranch.leafId);

    telemetryTrace = startTelemetryTrace({
      externalTraceId: traceCtx.trace.enabled ? traceCtx.trace.id : null,
      name: traceName,
      kind: 'agent',
      sessionId,
      userId: policyCallingUser?.id ?? ambientTelemetry?.userId ?? null,
      agentId,
      tenantKey: ambientTelemetry?.tenantKey,
      workspaceKey: ambientTelemetry?.workspaceKey,
      model: effectiveModel,
      provider: runtimeProvider,
      input: userMessage,
      metadata: {
        agent_name: agent.name,
        ...agentPromptEvidence(agent),
        ...skillEvidence,
        agent_mode: agent.agent_mode,
        runtime_profile_id: runtimeAssignment.profile_id,
        runtime_profile_name: runtimeAssignment.profile_name,
        runtime_type: 'hermes',
        runtime_trust: runtimeTrust,
        workspace_policy: runtimeAssignment.workspace_policy,
        memory_policy: runtimeAssignment.memory_policy,
        native_tool_policy: runtimeAssignment.native_tool_policy,
      },
    });

    const result = await runtimeExecutor.execute(runtimeAssignment, {
      text: runtimeInput,
      ...(managedHermes ? { managed: managedRuntimeContext! } : {}),
    });
    const parsedRuntimeOutput = managedHermes
      ? parseManagedRuntimeMemoryOutput(result.output)
      : { output: result.output, proposals: [], rejectedCount: 0 };
    if (managedHermes && !parsedRuntimeOutput.output) {
      throw new Error('Managed Hermes returned only memory proposals without agent output');
    }
    const memoryProposalIds: string[] = [];
    let memoryProposalStoreErrors = 0;
    if (managedHermes
      && runtimeAssignment.memory_policy === 'propose_write'
      && parsedRuntimeOutput.proposals.length > 0) {
      for (const proposal of parsedRuntimeOutput.proposals) {
        try {
          const stored = await recordManagedRuntimeMemoryProposal(pool, {
            agentId,
            runtimeProfileId,
            workspaceRoot: managedRuntimeContext!.workspaceRoot,
            proposal,
            sourceTraceId: managedRuntimeContext!.rootTraceId,
            sourceRuntimeRunId: result.externalRunId,
            sourceSessionId: sessionId,
            principal: {
              kind: managedRuntimeContext!.principal.kind,
              id: managedRuntimeContext!.principal.id,
            },
          });
          memoryProposalIds.push(stored.id);
        } catch (error) {
          memoryProposalStoreErrors += 1;
          logger.warn({
            err: error,
            agentId,
            runtimeProfileId: runtimeAssignment.profile_id,
            rootTraceId: managedRuntimeContext!.rootTraceId,
          }, 'Managed Hermes memory proposal could not be recorded');
        }
      }
    }
    const runtimeOutput = parsedRuntimeOutput.output;
    lastFullContent = runtimeOutput;
    turnPromptTokens = result.usage?.inputTokens ?? 0;
    turnCompletionTokens = result.usage?.outputTokens ?? 0;
    const runtimeEstimatedCostUsd = result.usage?.estimatedCostUsd ?? 0;
    const assistantBranch = chainBranch(userBranch.leafId, [{ role: 'assistant', content: runtimeOutput }]);
    await appendBranch(pool, sessionId, assistantBranch.chained, assistantBranch.leafId);
    if (runtimeOutput) {
      recordStreaming(sessionId);
      yield `data: ${JSON.stringify({ delta: runtimeOutput })}\n\n`;
    }
    yield `data: ${JSON.stringify({
      runtime_run_id: result.externalRunId,
      runtime_trust: result.trust,
      managed_memory_context_count: managedMemoryContextCount,
      managed_memory_proposal_ids: memoryProposalIds,
      managed_memory_rejected_count: parsedRuntimeOutput.rejectedCount,
      managed_memory_store_errors: memoryProposalStoreErrors,
    })}\n\n`;
    writeImmutableAudit(pool, {
      eventType: 'request_success',
      apiKeyPrefix: `agent__${agentId}`,
      model: effectiveModel,
      provider: runtimeProvider,
      sessionId,
      inputTokens: turnPromptTokens,
      outputTokens: turnCompletionTokens,
      riskLevel: ((agent as unknown as Record<string, unknown>).risk_level as 'low' | 'medium' | 'high') ?? 'low',
    });
    traceCtx.setOutput(runtimeOutput);
    if (telemetryTrace) {
      finishTelemetryTrace(telemetryTrace, {
        status: 'completed',
        output: runtimeOutput,
        inputTokens: turnPromptTokens,
        outputTokens: turnCompletionTokens,
        totalCostUsd: runtimeEstimatedCostUsd,
        metadata: {
          external_run_id: result.externalRunId,
          runtime_trust: result.trust,
          managed_memory_context_count: managedMemoryContextCount,
          managed_memory_proposal_count: memoryProposalIds.length,
          managed_memory_rejected_count: parsedRuntimeOutput.rejectedCount,
          managed_memory_store_errors: memoryProposalStoreErrors,
          runtime_cache_read_input_tokens: result.usage?.cacheReadInputTokens ?? 0,
          runtime_cache_write_input_tokens: result.usage?.cacheWriteInputTokens ?? 0,
          runtime_reasoning_tokens: result.usage?.reasoningTokens ?? 0,
          runtime_api_calls: result.usage?.apiCalls ?? 0,
          runtime_reported_total_tokens: result.usage?.totalTokens ?? turnPromptTokens + turnCompletionTokens,
        },
      });
      telemetryFinished = true;
    }
    unregisterSession(sessionId, 'done');
    if (emitUsage && (turnPromptTokens + turnCompletionTokens) > 0) {
      yield tokenUsageEvent(turnPromptTokens, turnCompletionTokens, effectiveModel, 0, 0);
    }
    yield 'data: [DONE]\n\n';
    return;
  }

  // A subscription runtime replaces only the LLM completion. Argus Core keeps
  // ownership of the tool loop, MCP credentials, grants and policy checks.
  const agentApiKey = usesCodexRuntime || usesClaudeCodeRuntime ? '' : decrypt(agent.llm_api_key);
  const llmTarget: LlmTarget = usesCodexRuntime || usesClaudeCodeRuntime
    ? {
        provider: usesCodexRuntime ? 'openai-compatible' : 'anthropic',
        baseUrl: AGENT_WORKSPACE_URL.replace(/\/+$/, ''),
        apiKey: WORKSPACE_SECRET,
        authType: 'none',
        model: effectiveModel,
        timeoutMs: usesCodexRuntime ? codexRuntimeTimeoutMs() : claudeCodeRuntimeTimeoutMs(),
        supportsReasoning: usesCodexRuntime,
        runtimeType: usesCodexRuntime ? 'codex-subscription' : 'claude-code-subscription',
        ...(usesCodexRuntime ? { runtimeReasoningEffort: codexReasoningEffort(runtimeAssignment.reasoning_effort) } : {}),
        runtimeAgentId: agentId,
        runtimeWorkingDirectory: '/runtime',
      }
    : await resolveRegisteredLlmTarget(pool, effectiveModel, agentApiKey, agent.llm_credential_profile_id);
  // Kept as compatibility arguments until the worker/memory signatures are
  // simplified; calls themselves resolve through src/llm.
  const llmUrl = llmTarget.baseUrl;
  const llmKey = llmTarget.apiKey;
  const pricing = await pool.query<{ input_cost_per_1k: number | null; output_cost_per_1k: number | null }>(
    'SELECT input_cost_per_1k, output_cost_per_1k FROM mcp_models WHERE model_name = $1 LIMIT 1',
    [effectiveModel],
  ).catch(() => ({ rows: [] }));
  inputCostPer1k = Number(pricing.rows[0]?.input_cost_per_1k ?? 0);
  outputCostPer1k = Number(pricing.rows[0]?.output_cost_per_1k ?? 0);
  const telemetryUserId = policyCallingUser?.id ?? ambientTelemetry?.userId ?? null;
  telemetryTrace = startTelemetryTrace({
    externalTraceId: traceCtx.trace.enabled ? traceCtx.trace.id : null,
    name: traceName,
    kind: 'agent',
    sessionId,
    userId: telemetryUserId,
    agentId,
    tenantKey,
    workspaceKey,
    model: effectiveModel,
    provider: llmTarget.runtimeType ?? llmTarget.provider,
    input: userMessage,
    metadata: {
      agent_name: agent.name,
      ...agentPromptEvidence(agent),
      ...skillEvidence,
      agent_mode: agent.agent_mode,
      agent_role: ambientTelemetry?.agentRole ?? agent.agent_role ?? null,
      workflow_step_id: ambientTelemetry?.workflowStepId ?? null,
      task_type: session.pr_context?.task_type ?? agent.task_type ?? null,
      subagent_depth: depth,
      ticket_id: session.pr_context?.ticket_id ?? null,
      credential_profile_id: llmTarget.credentialProfileId ?? null,
      credential_profile_name: llmTarget.credentialProfileName ?? null,
      runtime_profile_id: runtimeAssignment?.profile_id ?? null,
      runtime_profile_name: runtimeAssignment?.profile_name ?? null,
      runtime_type: runtimeAssignment?.runtime_type ?? 'argus',
      reasoning_effort: runtimeAssignment?.reasoning_effort ?? null,
    },
  });
  if (llmTarget.runtimeType === 'codex-subscription' && telemetryTrace) {
    llmTarget.runtimeRootTraceId = telemetryTrace.rootTraceId;
  }

  // Build tool list (allowedTools enforces fail-closed filter after every source)
  // Never carry stale code evidence across a reused worker session. A snapshot
  // is reattached below only after Core verifies the exact current Git HEAD.
  if (session.pr_context?.code_index_snapshot_id || session.pr_context?.code_index_commit_sha) {
    const { code_index_snapshot_id: _snapshot, code_index_commit_sha: _commit, ...freshContext } = session.pr_context;
    session.pr_context = freshContext;
  }
  let nativeCodeAccess: NativeCodeBundleAccess | null = null;
  if (session.pr_context?.workspace_dir && effectiveBundleIds && effectiveBundleIds.length > 0) {
    try {
      nativeCodeAccess = await resolveNativeCodeBundleAccess(pool, effectiveBundleIds);
    } catch (error) {
      logger.warn({ err: error, agentId }, 'Native code Bundle scope could not be resolved; indexing remains disabled');
    }
  }
  if (session.pr_context?.workspace_dir
    && effectiveBundleIds && effectiveBundleIds.length > 0
    && nativeCodeAccess?.canIndex) {
    const indexSpan = telemetryTrace ? startTelemetrySpan({
      traceId: telemetryTrace.id,
      name: 'code_intelligence.index',
      kind: 'rag',
      input: { workspaceRoot: session.pr_context.workspace_dir },
      metadata: { provider: 'graphify' },
    }) : null;
    try {
      const codeIndex = await ensureNativeWorkspaceCodeIndex(pool, {
        workspaceRoot: session.pr_context.workspace_dir,
        repositoryKey: session.pr_context.repo ?? null,
        branchHint: session.pr_context.branch ?? agent.pr_branch,
        executionBundleIds: effectiveBundleIds,
      }, nativeCodeAccess);
      codeIndexSnapshotId = codeIndex.id;
      session.pr_context = {
        ...session.pr_context,
        code_index_snapshot_id: codeIndex.id,
        code_index_commit_sha: codeIndex.commitSha,
      };
      await updateSessionPrContext(pool, sessionId, session.pr_context);
      if (indexSpan) finishTelemetrySpan(indexSpan, {
        status: 'completed',
        output: { snapshotId: codeIndex.id, commitSha: codeIndex.commitSha },
        metadata: {
          snapshot_id: codeIndex.id, repository_key: codeIndex.repositoryKey,
          branch_name: codeIndex.branchName, commit_sha: codeIndex.commitSha,
          provider: codeIndex.provider, files: codeIndex.fileCount,
          symbols: codeIndex.symbolCount, edges: codeIndex.edgeCount,
          documents: codeIndex.documentCount,
        },
      });
    } catch (error) {
      if (indexSpan) finishTelemetrySpan(indexSpan, { status: 'failed', error });
      logger.warn({ err: error, agentId, workspaceRoot: session.pr_context.workspace_dir },
        'Native code indexing failed open; worker retains workspace tools without stale code evidence');
    }
  }
  let tools = await buildToolList(
    pool,
    agent.composite_id,
    agentId,
    allowedTools,
    effectiveBundleIds,
    callingUser?.allowed_bundles,
    callingUser,
  );
  if (technicalIdentityToolPolicy) {
    tools = tools.filter(tool => isToolAllowedByPatterns(
      technicalIdentityToolPolicy,
      tool.function.name,
    ));
  }

  // A bundle remains the authorization boundary, but a signed Solution Pack
  // task receives a smaller execution surface. In particular, implementation
  // workers cannot drift into shell/Gitea/LangGraph loops before changing code.
  const solutionPackTools = isSolutionPackWorker
    ? scopeSolutionPackWorkerTools(tools as ToolDef[], session.pr_context?.task_type)
    : null;
  const effectiveTools = agent.agent_mode === 'worker'
    ? solutionPackTools ?? filterToolsForTask(tools as ToolDef[], userMessage)
    : tools;
  const advertisedToolNames = new Set(effectiveTools.map(tool => tool.function.name));

  logger.debug({ total: tools.length, filtered: effectiveTools.length, mode: agent.agent_mode }, 'tool list sizes');

  // RAG context for this query
  // Authenticated /chat (emitUsage) collects structured citations; public/worker pass undefined → none.
  const citations: Citation[] = [];
  const ragSpan = telemetryTrace ? startTelemetrySpan({
    traceId: telemetryTrace.id,
    name: 'rag.context',
    kind: 'rag',
    input: { queryLength: userMessage.length, restrictedIndexIds: ragIndexIds ?? null },
    metadata: { agent_id: agentId },
  }) : null;
  let ragContext: string;
  let repositorySnapshotCount = 0;
  let repositoryEvidenceCount = 0;
  try {
    // Argus.Dev already places the Knowledge Agent's retrieved context in the
    // signed worker task. Injecting the same RAG corpus again more than doubles
    // a small local model's system context and can make it ignore required tool
    // calls. Interactive/direct worker turns retain normal RAG injection.
    ragContext = isSolutionPackWorker
      ? ''
      : await buildRagContext(pool, agentId, userMessage, ragIndexIds, emitUsage ? citations : undefined);
    if (!isSolutionPackWorker && codeIndexSnapshotId === null) {
      const repositoryKnowledge = await buildAgentRepositoryKnowledge(
        pool,
        agentId,
        userMessage,
        effectiveBundleIds ?? null,
      );
      repositorySnapshotCount = repositoryKnowledge.snapshotCount;
      repositoryEvidenceCount = repositoryKnowledge.evidenceCount;
      if (repositoryKnowledge.context) {
        ragContext = [ragContext, repositoryKnowledge.context].filter(Boolean).join('\n\n');
      }
    }
    if (ragSpan) finishTelemetrySpan(ragSpan, {
      status: 'completed',
      metadata: {
        citation_count: citations.length,
        context_size: ragContext.length,
        repository_snapshot_count: repositorySnapshotCount,
        repository_evidence_count: repositoryEvidenceCount,
      },
    });
  } catch (error) {
    if (ragSpan) finishTelemetrySpan(ragSpan, { status: 'failed', error });
    throw error;
  }
  if (emitUsage && citations.length > 0) {
    yield `data: ${JSON.stringify({ citations })}\n\n`;
  }

  // Solution Pack tasks carry a narrow workflow contract in the user message;
  // keep their worker prefix lean and deterministic for local 7B models.
  const skillContents = loadedSkills.map(s=>s.content);
  const prContextBlock = composePrContextBlock(agent, session.pr_context);
  const effectiveAllowedPaths = session.pr_context?.allowed_paths ?? agent.allowed_paths;

  // Cross-session agent memory (retrieved before prompt assembly so it can
  // live in the cache-busting tail of the system prompt rather than as a
  // fake user/assistant turn between history and the new question).
  // Pass sessionId so working-memories from this session are eligible alongside
  // long-lived semantic/episodic/procedural ones.
  // Skip memory read in public/restricted mode — prevents cross-session data leaks
  // (memory is filtered by agent_id only, not by user; a public session could otherwise
  // read memories written by internal users of the same agent).
  const automaticMemoryEnabled = !disableMemory && isAutomaticAgentMemoryEnabled();
  const memories      = automaticMemoryEnabled ? await retrieveMemories(pool, agentId, userMessage, undefined, sessionId) : [];
  const memoryContext = formatMemoryContext(memories);

  // Stable-order system prompt: static prefix (persona/skills/standards)
  // is identical across turns and therefore implicit-cacheable on
  // OpenAI/Azure and explicit-cacheable on Anthropic. RAG + memory live
  // at the tail and only invalidate the cache from that point downward.
  const systemPrompt = buildStableSystemPrompt({
    agentPrompt:     agent.system_prompt,
    skills:          skillContents,
    prContextBlock,
    workerStandards: agent.agent_mode === 'worker'
      ? [
          buildWorkerStandards(Boolean(WORKSPACE_SECRET)),
          ...(isSolutionPackWorker ? [solutionPackToolCatalogPrompt(effectiveTools as ToolDef[])] : []),
        ].join('\n\n')
      : '',
    ragContext,
    memoryBlock:     memoryContext,
    untrustedToolEnforcement: agent.untrusted_tool_output_enforcement,
  });

  // Upgrade a legacy (pre-tree, id-less) chat session in place: assign ids + a linear parentId
  // chain + set the active leaf, so continuation AND regenerate connect to the existing history
  // (without this, the next append would start a disconnected root and truncate prior history).
  // Worker mode stays linear (skipped) — it persists id-less turns and never sets active_leaf.
  let sessionMessages = session.messages ?? [];
  let activeLeafId = session.active_leaf_id ?? null;
  if (agent.agent_mode !== 'worker' && activeLeafId === null && sessionMessages.length > 0) {
    const norm = normalizeLinear(sessionMessages);
    await replaceSessionMessages(pool, sessionId, norm.messages, norm.leafId);
    sessionMessages = norm.messages;
    activeLeafId = norm.leafId;
  }

  // Active-branch path (root→leaf). Null leaf ⇒ whole array (legacy/linear).
  const activePath = resolveActivePath(sessionMessages, activeLeafId);

  // branchParentId = the node the new assistant run hangs under.
  let branchParentId: string | null = null;
  let historyMessages: ChatMessage[];
  if (regenerate) {
    // Drop the trailing assistant variant (+ its tool messages): history ends at the last user turn.
    const lastUserIdx = activePath.map((m) => m.role).lastIndexOf('user');
    const upToUser = lastUserIdx >= 0 ? activePath.slice(0, lastUserIdx + 1) : activePath;
    historyMessages = upToUser.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');
    branchParentId = lastUserIdx >= 0 ? (activePath[lastUserIdx].id ?? null) : activeLeafId;
    // Fail-safe: a chat session is normalized above so the last user always has an id; a null parent
    // here means a non-tree session (e.g. worker) — regenerate would orphan the variant, so refuse.
    if (branchParentId === null) {
      yield `data: ${JSON.stringify({ error: 'Regenerate is not available for this conversation.' })}\n\n`;
      yield 'data: [DONE]\n\n';
      unregisterSession(sessionId, 'done');
      return;
    }
  } else if (branchOpts) {
    // Edit: branch a new user turn at the edited message's parent. History = root→that parent
    // ([] when editing the first message). The new user message becomes a sibling of the edited one.
    historyMessages = ancestorsInclusive(sessionMessages, branchOpts.fromId)
      .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');
  } else {
    historyMessages = activePath.filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');
  }

  const messages: ChatMessage[] = regenerate
    ? [{ role: 'system', content: systemPrompt }, ...historyMessages] // user turn already last in history
    : [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: buildUserContent(userMessage, userImages) },
      ];

  // Persist the new user message. Worker mode stays LINEAR (the tree is a chat-only feature; the
  // worker runner persists its assistant/tool turns via plain appendMessages and returns before the
  // tree-aware assistant append below — so setting active_leaf here would orphan that output and
  // truncate worker history). Chat mode appends the user turn as a branch child + advances the leaf.
  // Regenerate reuses the existing user turn (no new user message).
  if (!regenerate) {
    if (agent.agent_mode === 'worker') {
      await appendMessages(pool, sessionId, [{ role: 'user', content: userPersistText(userMessage, userImages) }]);
    } else {
      const userParent = branchOpts ? branchOpts.fromId : activeLeafId;
      const { chained, leafId } = chainBranch(userParent, [
        { role: 'user', content: userPersistText(userMessage, userImages) },
      ]);
      await appendBranch(pool, sessionId, chained, leafId);
      branchParentId = leafId;
    }
  }

  // ï¿½??ï¿½?? Claude-native routing for worker agents ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??
  if (agent.agent_mode === 'worker') {
    const toolExecutor = async (
      name: string,
      args: unknown,
      toolCallId?: string,
    ): Promise<WorkerToolExecutionResult> => {
      const argRecord = (args ?? {}) as Record<string, unknown>;
      applyScopedWorkspaceDefaults(name, argRecord, effectiveAllowedPaths);
      const denial = validateAdvertisedToolCall(name, advertisedToolNames)
        ?? validateWorkspacePathAccess(name, argRecord, effectiveAllowedPaths)
        ?? validateExecutionResourceScopeCall(name, argRecord, executionResourceScope);
      if (denial) {
        const denialText = `Error: ${denial}`;
        writeAuditEntry({
          apiKeyPrefix: technicalIdentityToolPolicy?.apiKeyPrefix ?? 'agent__',
          tool: name,
          parameters: argRecord,
          durationMs: 0,
          resultSize: denialText.length,
          isError: true,
          errorMessage: denial,
        }).catch(() => {});
        return { result: denialText };
      }
      // Wrap tool execution in a Langfuse span for worker-path tool calls
      // (same shape as the chat-path wrapping below).
      const localToolSpan = telemetryTrace ? startTelemetrySpan({
        traceId: telemetryTrace.id,
        name: `tool.${name}`,
        kind: 'tool',
        toolName: name,
        input: argRecord,
        metadata: {
          agent_mode: 'worker',
          ...(toolCallId ? { tool_call_id: toolCallId } : {}),
        },
      }) : null;
      let localToolError = false;
      try {
      const executeObservedTool = () => traceCtx.trace.span(
        { name: `tool.${name}`, input: argRecord },
        async (span) => {
          let out: string;
          let isErr = false;
          try {
            if (name === SUBAGENT_TOOL_SINGLE) {
              const { agent_id, message } = argRecord as { agent_id: number; message: string };
              const r = await callSubagentSingle(agent_id, message, pool, config, sessionId, callingUser);
              if (r.error) { isErr = true; out = `Error: ${r.error}`; }
              else { out = r.response || '(empty response)'; }
            } else if (name === SUBAGENT_TOOL_PARALLEL) {
              const calls = (argRecord['calls'] as SubagentCall[]) ?? [];
              const results = await callSubagentsParallel(calls, pool, config, sessionId, callingUser);
              out = formatParallelResults(results);
              if (results.some(r => r.error)) isErr = true;
            } else {
              const result = await executeTool(name, argRecord, {
                config, pool, allowedBundles: effectiveBundleIds,
                workspaceRoot: session.pr_context?.workspace_dir,
                repositoryKey: agent.gitea_project ?? undefined,
                branchHint: session.pr_context?.branch ?? agent.pr_branch,
              });
              const text = result.content.map(c => c.text).join('\n');
              if (result.isError) { isErr = true; out = `Error: ${text}`; }
              else { out = text; }
            }
          } catch (err) {
            isErr = true;
            out = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
          }
          span.setOutput(out.slice(0, 1000));
          span.setMetadata({ is_error: isErr, output_size: out.length });
          localToolError = isErr;
          return out;
        },
      );
      const output = await (localToolSpan && telemetryTrace
        ? withNativeTelemetryContext({
          rootTraceId: telemetryTrace.rootTraceId,
          traceId: telemetryTrace.id,
          spanId: localToolSpan.id,
          userId: telemetryUserId,
          agentId,
          tenantKey: telemetryTrace.tenantKey,
          workspaceKey: telemetryTrace.workspaceKey,
        }, executeObservedTool)
        : executeObservedTool());
      if (localToolSpan) finishTelemetrySpan(localToolSpan, {
        status: localToolError ? 'failed' : 'completed',
        output,
        error: localToolError ? output : undefined,
      });
      const boundedOutput = boundAgentToolResult(
        name,
        output,
        isSolutionPackWorker
          ? Math.min(config.maxResultSizeBytes, SOLUTION_PACK_TOOL_RESULT_MAX_CHARS)
          : config.maxResultSizeBytes,
      );
      return {
        result: boundedOutput,
        ...(telemetryTrace ? { traceId: telemetryTrace.id } : {}),
        ...(localToolSpan ? { spanId: localToolSpan.id } : {}),
      };
      } catch (error) {
        if (localToolSpan) finishTelemetrySpan(localToolSpan, { status: 'failed', error });
        throw error;
      }
    };

    // Route through compacting runner when feature flag is enabled.
    // The compacting runner has an identical signature ï¿½?? it just pre-processes
    // historyMessages before delegating to runClaudeWorkerAgent.
    type WorkerRunner = typeof runClaudeWorkerAgent;
    const workerRunner: WorkerRunner = USE_SDK_RUNNER ? runCompactingWorkerAgent : runClaudeWorkerAgent;
    const requiredWorkspaceWritePaths = agent.name === 'coder'
      && session.pr_context?.task_type === 'implement_ticket'
      ? extractRequestedFileTargets(userMessage)
      : [];
    const requiredWorkerToolSequence = agent.name === 'coder'
      && session.pr_context?.task_type === 'implement_ticket'
      ? [
          'workspace_ls',
          'workspace_read',
          ...(requiredWorkspaceWritePaths.length === 0 ? ['workspace_write'] : []),
        ]
      : [];

    // Codegraph pre-job: refresh graphify-out so codegraph_* tools have a fresh graph.
    // Awaited (not fire-and-forget) because the agent will likely call codegraph_*
    // in its first iteration and a missing graph would waste an LLM call.
    await ensureCodegraphReady({
      codegraph_enabled: agent.codegraph_enabled && codeIndexSnapshotId === null,
      gitea_project: agent.gitea_project,
      workspace_dir: session.pr_context?.workspace_dir,
    });

    let workerFullContent = '';
    let workerIterations = 0;
    let workerTermination = 'unknown_error';
    const workerFinishReasons: Array<{
      iteration: number;
      finishReason: string | null;
      termination: string;
      inputTokens: number;
      outputTokens: number;
    }> = [];
    const workerLlmSpan = telemetryTrace ? startTelemetrySpan({
      traceId: telemetryTrace.id,
      name: 'llm.worker',
      kind: 'llm',
      model: effectiveModel,
      provider: llmTarget.runtimeType ?? llmTarget.provider,
      input: { messageCount: historyMessages.length + 1, availableTools: effectiveTools.length },
      metadata: {
        agent_mode: agent.agent_mode,
        sdk_runner: USE_SDK_RUNNER,
        lean_solution_pack_prompt: isSolutionPackWorker,
        system_prompt_chars: systemPrompt.length,
      },
    }) : null;
    try {
      for await (const chunk of workerRunner(
        agentId,
        sessionId,
        systemPrompt,
        historyMessages,
        userMessage,
        effectiveTools,
        toolExecutor,
        agent.max_iterations ?? 10,
        agent.max_tokens ?? 4096,
        pool,
        llmUrl,
        llmKey,
        effectiveModel || 'claude-opus-4-6', // modelOverride > agent.model > default
        agent.thinking_budget ?? 0,            // extended-thinking budget (mig 078)
        agent.untrusted_tool_output_enforcement ?? true, // A2AS tagging (mig 080)
        policyCallingUser,                     // End-user identity for per-user policy gate
        llmTarget,
        requiredWorkerToolSequence,
        requiredWorkspaceWritePaths,
        automaticMemoryEnabled,
      )) {
        if (chunk.delta)       { workerFullContent += chunk.delta; lastFullContent = workerFullContent; recordStreaming(sessionId); yield `data: ${JSON.stringify({ delta: chunk.delta })}\n\n`; }
        if (chunk.tool_call)   { recordToolCallStart(sessionId, { id: chunk.tool_call.id, name: chunk.tool_call.name, args: chunk.tool_call.args }); yield `data: ${JSON.stringify({ tool_call: chunk.tool_call })}\n\n`; }
        if (chunk.tool_result) {
          const toolResult = captureFullToolResults && typeof chunk.tool_result.result === 'string'
            ? {
                tool_call_id: chunk.tool_result.id,
                name: chunk.tool_result.name,
                preview: chunk.tool_result.result.slice(0, 256 * 1024),
                ...(chunk.tool_result.traceId ? { trace_id: chunk.tool_result.traceId } : {}),
                ...(chunk.tool_result.spanId ? { span_id: chunk.tool_result.spanId } : {}),
              }
            : {
                tool_call_id: chunk.tool_result.id,
                name: chunk.tool_result.name,
                preview: chunk.tool_result.preview,
                ...(chunk.tool_result.traceId ? { trace_id: chunk.tool_result.traceId } : {}),
                ...(chunk.tool_result.spanId ? { span_id: chunk.tool_result.spanId } : {}),
              };
          recordToolCallEnd(sessionId, chunk.tool_result.id, { preview: chunk.tool_result.preview });
          yield `data: ${JSON.stringify({ tool_result: toolResult })}\n\n`;
        }
        if (chunk.telemetry) {
          const inputTokens = Math.max(0, chunk.telemetry.inputTokens);
          const outputTokens = Math.max(0, chunk.telemetry.outputTokens);
          const iterationCost = (inputTokens / 1000) * inputCostPer1k
            + (outputTokens / 1000) * outputCostPer1k;
          turnPromptTokens += inputTokens;
          turnCompletionTokens += outputTokens;
          telemetryCostUsd += iterationCost;
          workerIterations = Math.max(workerIterations, chunk.telemetry.iteration);
          workerTermination = chunk.telemetry.termination;
          workerFinishReasons.push({
            iteration: chunk.telemetry.iteration,
            finishReason: chunk.telemetry.finishReason,
            termination: chunk.telemetry.termination,
            inputTokens,
            outputTokens,
          });
          recordTokenUsage(sessionId, { input: inputTokens, output: outputTokens, costUsd: iterationCost });
        }
        if (chunk.terminal) workerTermination = chunk.terminal;
        if (chunk.error)       { telemetryTerminalError = chunk.error; yield `data: ${JSON.stringify({ error: chunk.error, termination: chunk.terminal ?? workerTermination })}\n\n`; }
      }
      if (workerLlmSpan) finishTelemetrySpan(workerLlmSpan, {
        status: telemetryTerminalError ? 'failed' : 'completed',
        output: workerFullContent,
        error: telemetryTerminalError,
        inputTokens: turnPromptTokens,
        outputTokens: turnCompletionTokens,
        totalCostUsd: telemetryCostUsd,
        metadata: {
          iterations: workerIterations,
          termination: workerTermination,
          finish_reasons: workerFinishReasons,
          code_index_snapshot_id: codeIndexSnapshotId,
        },
      });
    } catch (error) {
      telemetryTerminalError = error instanceof Error ? error.message : String(error);
      if (workerLlmSpan) finishTelemetrySpan(workerLlmSpan, {
        status: 'failed',
        output: workerFullContent,
        error,
        inputTokens: turnPromptTokens,
        outputTokens: turnCompletionTokens,
        totalCostUsd: telemetryCostUsd,
        metadata: {
          iterations: workerIterations,
          termination: workerTermination,
          finish_reasons: workerFinishReasons,
        },
      });
      throw error;
    }
    // Fire-and-forget quality evaluation ï¿½?? does not block the response
    scoreAgentTurn({
      agentId,
      sessionId,
      userMessage,
      response: workerFullContent,
      ragContext: ragContext || undefined,
      nativeTraceId: telemetryTrace?.id,
    });
    traceCtx.setOutput(workerFullContent);
    if (telemetryTrace) {
      finishTelemetryTrace(telemetryTrace, {
        status: telemetryTerminalError ? 'failed' : 'completed',
        output: workerFullContent,
        error: telemetryTerminalError,
        inputTokens: turnPromptTokens,
        outputTokens: turnCompletionTokens,
        totalCostUsd: telemetryCostUsd,
        metadata: {
          iterations: workerIterations,
          termination: workerTermination,
          finish_reasons: workerFinishReasons,
        },
      });
      telemetryFinished = true;
    }
    unregisterSession(sessionId, telemetryTerminalError ? 'error' : 'done', telemetryTerminalError ?? undefined);
    if (emitUsage && (turnPromptTokens + turnCompletionTokens) > 0) {
      yield tokenUsageEvent(turnPromptTokens, turnCompletionTokens, effectiveModel, inputCostPer1k, outputCostPer1k);
    }
    yield 'data: [DONE]\n\n';
    return;
  }
  // ï¿½??ï¿½?? End Claude routing ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??

  let iterations = 0;
  const maxIterations = agent.max_iterations ?? 10;
  const newAssistantMessages: ChatMessage[] = [];

  // ── Wall-clock session timeout (T4) ────────────────────────────────
  // Uses the in-scope `config` (already injected) to avoid re-parsing env vars.
  // MAX_AGENT_SESSION_SECONDS=0 disables the timeout (legacy behaviour).
  const sessionStartMs = Date.now();
  const maxSessionSeconds = config.maxAgentSessionSeconds || 0;
  const maxSessionMs = maxSessionSeconds * 1000;
  const timeoutReached = (): boolean =>
    maxSessionMs > 0 && (Date.now() - sessionStartMs) > maxSessionMs;

  while (iterations < maxIterations) {
    iterations++;
    recordIterationStart(sessionId, iterations);

    // Abort BEFORE the next LLM call (never mid-tool-round — leaves no
    // dangling tool_use without tool_result in the message history).
    if (timeoutReached()) {
      telemetryTerminalError = `Session-Timeout nach ${maxSessionSeconds}s erreicht — Abbruch.`;
      yield `data: ${JSON.stringify({ error: telemetryTerminalError })}\n\n`;
      break;
    }

    // Direct provider call. src/llm normalizes OpenAI and Anthropic streaming
    // into one event shape so this tool loop stays provider-independent.
    const gp = resolveModelParams(agent, paramOverrides);
    const body = {
      model: effectiveModel,
      messages,
      temperature: gp.temperature,
      max_tokens: gp.max_tokens,
      ...(gp.top_p !== undefined ? { top_p: gp.top_p } : {}),
      ...(effectiveTools.length > 0 ? { tools: effectiveTools, tool_choice: 'auto' as const } : {}),
      ...((agent.thinking_budget ?? 0) > 0
        ? { thinking: { type: 'enabled' as const, budget_tokens: agent.thinking_budget } }
        : {}),
    };

    let fullContent = '';
    lastFullContent = '';
    const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
    let finishReason: string | null = null;
    let iterationPromptTokens = 0;
    let iterationCompletionTokens = 0;
    const llmSpan = telemetryTrace ? startTelemetrySpan({
      traceId: telemetryTrace.id,
      name: `llm.iteration.${iterations}`,
      kind: 'llm',
      model: effectiveModel,
      provider: llmTarget.runtimeType ?? llmTarget.provider,
      input: { messageCount: messages.length, availableTools: effectiveTools.length },
      metadata: { iteration: iterations },
    }) : null;

    try {
    for await (const chunk of streamChatCompletion(body, { apiKeyOverride: agentApiKey, targetOverride: llmTarget })) {
      if (chunk.usage) {
        const promptTokens = chunk.usage.prompt_tokens ?? 0;
        const completionTokens = chunk.usage.completion_tokens ?? 0;
        turnPromptTokens += promptTokens;
        turnCompletionTokens += completionTokens;
        iterationPromptTokens += promptTokens;
        iterationCompletionTokens += completionTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (delta.content) {
        fullContent += delta.content;
        lastFullContent += delta.content;
        yield `data: ${JSON.stringify({ delta: delta.content })}\n\n`;
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!pendingToolCalls.has(tc.index)) {
            pendingToolCalls.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
          }
          const entry = pendingToolCalls.get(tc.index)!;
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
        }
      }
    }
    } catch (error) {
      if (llmSpan) finishTelemetrySpan(llmSpan, {
        status: 'failed',
        output: fullContent,
        error,
        inputTokens: iterationPromptTokens,
        outputTokens: iterationCompletionTokens,
      });
      throw error;
    }
    const iterationCost = (iterationPromptTokens / 1000) * inputCostPer1k
      + (iterationCompletionTokens / 1000) * outputCostPer1k;
    telemetryCostUsd += iterationCost;
    recordTokenUsage(sessionId, {
      input: iterationPromptTokens,
      output: iterationCompletionTokens,
      costUsd: iterationCost,
    });
    if (llmSpan) finishTelemetrySpan(llmSpan, {
      status: 'completed',
      output: fullContent,
      inputTokens: iterationPromptTokens,
      outputTokens: iterationCompletionTokens,
      totalCostUsd: iterationCost,
      metadata: { finish_reason: finishReason },
    });

    // Build assistant message
    const toolCallsList: ToolCall[] = Array.from(pendingToolCalls.values()).map(tc => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2)}`,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    }));

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: fullContent || null,
      ...(toolCallsList.length > 0 ? { tool_calls: toolCallsList } : {}),
    };
    messages.push(assistantMsg);
    newAssistantMessages.push(assistantMsg);

    // No tool calls ï¿½?? done
    if (finishReason === 'stop' || toolCallsList.length === 0) break;

    // Abort BEFORE launching parallel tool execution — prevents a runaway
    // tool round when the timeout fires between LLM response and tool dispatch.
    if (timeoutReached()) {
      telemetryTerminalError = `Session-Timeout nach ${maxSessionSeconds}s erreicht — Tool-Calls abgebrochen.`;
      yield `data: ${JSON.stringify({ error: telemetryTerminalError })}\n\n`;
      break;
    }

    // Execute all tool calls in parallel
    interface ToolExecResult {
      toolMsg:     ChatMessage;
      callEvent:   string;   // SSE payload for tool_call notification
      resultEvent: string;   // SSE payload for tool_result notification
      toolCallId:  string;   // for active-sessions registry
      toolName:    string;
      toolArgs:    Record<string, unknown>;
      toolResult:  string;
      toolIsError: boolean;
      durationMs: number;
      traceId?: string;
      spanId?: string;
      approval?: NonNullable<import('./hooks/types.js').HookResult['metadata']>['approval'];
    }

    const toolExecResults = await Promise.all(toolCallsList.map(async (tc): Promise<ToolExecResult> => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* empty args */ }
      applyScopedWorkspaceDefaults(tc.function.name, args, effectiveAllowedPaths);

      let resultText: string;
      let isError = false;
      const toolStart = Date.now();
      const localToolSpan = telemetryTrace ? startTelemetrySpan({
        traceId: telemetryTrace.id,
        name: `tool.${tc.function.name}`,
        kind: 'tool',
        toolName: tc.function.name,
        input: args,
        metadata: { iteration: iterations, tool_call_id: tc.id },
      }) : null;

      // A tool call is untrusted model output. Enforce the exact catalog that
      // was advertised for this turn before hooks or any executor can run.
      const catalogDenial = validateAdvertisedToolCall(tc.function.name, advertisedToolNames);
      const denial = catalogDenial
        ?? validateWorkspacePathAccess(tc.function.name, args, effectiveAllowedPaths)
        ?? validateExecutionResourceScopeCall(tc.function.name, args, executionResourceScope);
      if (denial) {
        const denialText = `Error: ${denial}`;
        writeAuditEntry({
          apiKeyPrefix: technicalIdentityToolPolicy?.apiKeyPrefix ?? 'agent__',
          tool: tc.function.name,
          parameters: args,
          durationMs: Date.now() - toolStart,
          resultSize: denialText.length,
          isError: true,
          errorMessage: denial,
        }).catch(() => {});
        if (localToolSpan) finishTelemetrySpan(localToolSpan, {
          status: 'failed',
          output: denialText,
          error: denial,
          metadata: {
            denied: true,
            denial_source: catalogDenial ? 'advertised_tool_catalog' : 'workspace_path_policy',
          },
        });
        const toolMsg: ChatMessage = {
          role: 'tool', content: denialText,
          tool_call_id: tc.id, name: tc.function.name,
        };
        return {
          toolMsg,
          callEvent:   JSON.stringify({ tool_call:   { id: tc.id, name: tc.function.name, args } }),
          resultEvent: JSON.stringify({ tool_result: { tool_call_id: tc.id, name: tc.function.name, preview: denialText, duration_ms: Date.now() - toolStart, is_error: true, ...(telemetryTrace ? { trace_id: telemetryTrace.id } : {}), ...(localToolSpan ? { span_id: localToolSpan.id } : {}) } }),
          toolCallId:  tc.id,
          toolName:    tc.function.name,
          toolArgs:    args,
          toolResult:  denialText,
          toolIsError: true,
          durationMs: Date.now() - toolStart,
          ...(telemetryTrace ? { traceId: telemetryTrace.id } : {}),
          ...(localToolSpan ? { spanId: localToolSpan.id } : {}),
        };
      }

      const hookCtxBase: HookContext = {
        agentId, agentName: agent.name, sessionId,
        toolName: tc.function.name, toolArgs: args,
        iteration: iterations, agentDepth: depth,
        userId: policyCallingUser?.id,
        userGroups: policyCallingUser?.entra_groups,
      };
      const preOutcome = await runPreToolHooks(pool, hookCtxBase);
      // Hoisted so the audit log + SSE event payloads below reflect what
      // actually executed (which may be hook-modified args), not the original.
      let finalArgs: Record<string, unknown> = args;
      if (preOutcome.decision === 'block') {
        resultText = `[hook:${preOutcome.hookName}] ${preOutcome.reason}`;
        isError = true;
      } else {
        finalArgs = preOutcome.decision === 'modify' && preOutcome.modifiedArgs
          ? preOutcome.modifiedArgs
          : args;

        try {
          // Wrap tool execution in a Langfuse span so OPs can see tool
          // latencies + which tool failed inside the agent.chat trace.
          const executeObservedTool = () => traceCtx.trace.span(
            {
              name:     `tool.${tc.function.name}`,
              input:    finalArgs,
              metadata: { iteration: iterations, tool_call_id: tc.id },
            },
            async (span) => {
              let out: string;
              if (tc.function.name === SUBAGENT_TOOL_SINGLE) {
                const { agent_id, message } = finalArgs as { agent_id: number; message: string };
                const r = await callSubagentSingle(agent_id, message, pool, config, sessionId, callingUser);
                if (r.error) { isError = true; out = `Error: ${r.error}`; }
                else { out = r.response || '(empty response)'; }
              } else if (tc.function.name === SUBAGENT_TOOL_PARALLEL) {
                const calls = ((finalArgs as { calls?: SubagentCall[] }).calls) ?? [];
                const results = await callSubagentsParallel(calls, pool, config, sessionId, callingUser);
                out = formatParallelResults(results);
                if (results.some(r => r.error)) isError = true;
              } else {
                const result = await executeTool(tc.function.name, finalArgs, {
                  config, pool, allowedBundles: effectiveBundleIds,
                  workspaceRoot: session.pr_context?.workspace_dir,
                  repositoryKey: agent.gitea_project ?? undefined,
                  branchHint: session.pr_context?.branch ?? agent.pr_branch,
                });
                out = result.content.map(c => c.text).join('\n');
                if (result.isError) { isError = true; out = `Error: ${out}`; }
              }
              span.setOutput(out.slice(0, 1000));
              span.setMetadata({ is_error: isError, output_size: out.length });
              return out;
            },
          );
          resultText = await (localToolSpan && telemetryTrace
            ? withNativeTelemetryContext({
              rootTraceId: telemetryTrace.rootTraceId,
              traceId: telemetryTrace.id,
              spanId: localToolSpan.id,
              userId: telemetryUserId,
              agentId,
              tenantKey: telemetryTrace.tenantKey,
              workspaceKey: telemetryTrace.workspaceKey,
            }, executeObservedTool)
            : executeObservedTool());
        } catch (err) {
          isError = true;
          resultText = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
        }

        await runPostToolHooks(pool, {
          ...hookCtxBase, toolArgs: finalArgs, toolResult: resultText, toolIsError: isError,
        });
      }

      writeAuditEntry({
        apiKeyPrefix: technicalIdentityToolPolicy?.apiKeyPrefix ?? 'agent__',
        tool:         tc.function.name,
        parameters:   finalArgs,
        durationMs:   Date.now() - toolStart,
        resultSize:   resultText.length,
        isError,
        errorMessage: isError ? resultText.slice(0, 500) : undefined,
      }).catch(() => {});

      if (localToolSpan) finishTelemetrySpan(localToolSpan, {
        status: isError ? 'failed' : 'completed',
        output: resultText,
        error: isError ? resultText : undefined,
        metadata: { output_size: resultText.length, duration_ms: Date.now() - toolStart },
      });

      const boundedResultText = boundAgentToolResult(tc.function.name, resultText, config.maxResultSizeBytes);
      const wrappedResult = agent.untrusted_tool_output_enforcement
        ? wrapToolOutput(tc.function.name, tc.id, boundedResultText)
        : boundedResultText;

      return {
        toolMsg: {
          role:         'tool',
          content:      wrappedResult,
          tool_call_id: tc.id,
          name:         tc.function.name,
        },
        callEvent:   JSON.stringify({ tool_call:   { id: tc.id, name: tc.function.name, args: finalArgs } }),
        resultEvent: JSON.stringify({ tool_result: { tool_call_id: tc.id, name: tc.function.name, preview: boundedResultText, duration_ms: Date.now() - toolStart, is_error: isError, ...(telemetryTrace ? { trace_id: telemetryTrace.id } : {}), ...(localToolSpan ? { span_id: localToolSpan.id } : {}) } }),
        toolCallId:  tc.id,
        toolName:    tc.function.name,
        toolArgs:    finalArgs,
        toolResult:  boundedResultText,
        toolIsError: isError,
        durationMs: Date.now() - toolStart,
        ...(telemetryTrace ? { traceId: telemetryTrace.id } : {}),
        ...(localToolSpan ? { spanId: localToolSpan.id } : {}),
        ...(preOutcome.metadata?.approval ? { approval: preOutcome.metadata.approval } : {}),
      };
    }));

    // Yield events and add results to messages (deterministic order)
    const toolResultMessages: ChatMessage[] = [];
    for (const r of toolExecResults) {
      recordToolCallStart(sessionId, { id: r.toolCallId, name: r.toolName, args: r.toolArgs });
      yield `data: ${r.callEvent}\n\n`;
      recordToolCallEnd(sessionId, r.toolCallId, { isError: r.toolIsError, preview: r.toolResult });
      yield `data: ${r.resultEvent}\n\n`;
      if (r.approval) {
        yield `data: ${JSON.stringify({ approval_requested: {
          approval_id: String(r.approval.approvalId),
          action_description: r.approval.reason,
          tool_name: r.approval.toolName,
          target_scope: approvalScope(r.approval.parameters, r.approval.sessionId),
          parameters: redactApprovalParameters(r.approval.parameters) as Record<string, unknown>,
          risk_level: r.approval.riskLevel,
          risk_score: r.approval.riskScore,
          risk_factors: r.approval.riskFactors,
          expected_impacts: [],
          ttl_seconds: 1800,
          created_at: new Date().toISOString(),
        } })}\n\n`;
      }
      messages.push(r.toolMsg);
      toolResultMessages.push(r.toolMsg);
    }
    newAssistantMessages.push(...toolResultMessages);
  }

  // Attach citations to the FINAL assistant message (the RAG-informed answer; a tool-use turn emits
  // tool-calling assistant messages BEFORE the final answer).
  attachCitationsToLastAssistant(newAssistantMessages, citations);

  // Persist all new messages as a branch under the user turn (chained ids + active-leaf move).
  if (newAssistantMessages.length > 0) {
    const { chained, leafId } = chainBranch(branchParentId, newAssistantMessages);
    await appendBranch(pool, sessionId, chained, leafId);
  }

  // Fire-and-forget quality evaluation ï¿½?? does not block the response
  scoreAgentTurn({
    agentId,
    sessionId,
    userMessage,
    response: lastFullContent,
    ragContext: ragContext || undefined,
    nativeTraceId: telemetryTrace?.id,
  });

  // Fire-and-forget memory extraction from this turn.
  // Explicitly capture the trace id so the async work can re-enter the ALS
  // context — relying on enterWith() inheritance is fragile across the
  // boundary where the parent trace has already been .end()ed.
  // Skip entirely in public/restricted mode (disableMemory=true) — no writes
  // either, so public sessions cannot pollute internal agent memories.
  const memTraceId = traceCtx.trace.enabled ? traceCtx.trace.id : null;
  if (automaticMemoryEnabled) {
    Promise.resolve().then(() => {
      const fn = () => extractAndStoreMemories(
        pool, agentId, sessionId,
        ([...historyMessages, { role: 'user', content: userMessage }, ...newAssistantMessages] as Array<{ role: string; content: string | null }>),
        llmUrl, llmKey,
        effectiveModel,
        llmTarget,
      );
      return memTraceId ? withTraceContext({ traceId: memTraceId }, fn) : fn();
    }).catch(() => {});
  }

  // Immutable audit ï¿½?? one entry per agent turn (EU AI Act compliance)
  writeImmutableAudit(pool, {
    eventType: 'request_success',
    apiKeyPrefix: `agent__${agentId}`,
    model: effectiveModel,
    provider: llmTarget.runtimeType ?? llmTarget.provider,
    sessionId,
    riskLevel: ((agent as unknown as Record<string, unknown>).risk_level as 'low' | 'medium' | 'high') ?? 'low',
  });

  traceCtx.setOutput(lastFullContent);
  if (telemetryTrace) {
    finishTelemetryTrace(telemetryTrace, {
      status: telemetryTerminalError ? 'failed' : 'completed',
      output: lastFullContent,
      error: telemetryTerminalError,
      inputTokens: turnPromptTokens,
      outputTokens: turnCompletionTokens,
      totalCostUsd: telemetryCostUsd,
      metadata: { iterations, code_index_snapshot_id: codeIndexSnapshotId },
    });
    telemetryFinished = true;
  }
  unregisterSession(sessionId, telemetryTerminalError ? 'error' : 'done', telemetryTerminalError ?? undefined);
  if (emitUsage && (turnPromptTokens + turnCompletionTokens) > 0) {
    yield tokenUsageEvent(turnPromptTokens, turnCompletionTokens, effectiveModel, inputCostPer1k, outputCostPer1k);
  }
  yield 'data: [DONE]\n\n';
  } catch (err) {
    unregisterSession(sessionId, 'error', err instanceof Error ? err.message : String(err));
    if (telemetryTrace && !telemetryFinished) {
      finishTelemetryTrace(telemetryTrace, {
        status: 'failed',
        output: lastFullContent,
        error: err,
        inputTokens: turnPromptTokens,
        outputTokens: turnCompletionTokens,
        totalCostUsd: telemetryCostUsd,
      });
      telemetryFinished = true;
    }
    traceCtx.recordError(err);
    throw err;
  } finally {
    if (telemetryTrace && !telemetryFinished) {
      finishTelemetryTrace(telemetryTrace, {
        status: 'cancelled',
        output: lastFullContent,
        inputTokens: turnPromptTokens,
        outputTokens: turnCompletionTokens,
        totalCostUsd: telemetryCostUsd,
      });
      telemetryFinished = true;
    }
    await traceCtx.end();
  }
}

// ï¿½??ï¿½?? Non-streaming runner (for Jenkins / webhooks) ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??ï¿½??

export interface AgentChatResult {
  response: string;
  session_id: string;
  tool_calls: Array<{
    name: string;
    args: Record<string, unknown>;
    result: string;
    tool_call_id?: string;
    trace_id?: string;
    span_id?: string;
  }>;
  iterations: number;
  runtime_run_id?: string;
  /** Structured sources from automatic RAG injection for governed callers. */
  citations?: Citation[];
}

export interface AgentChatSyncOptions {
  /** Optional fail-closed tool set for controlled evaluation/replay runs. */
  allowedTools?: string[] | null;
  /** Pin a candidate model without mutating the agent declaration. */
  modelOverride?: string;
  /** Exact signed Solution Pack Bundle scope for both catalog and dispatch. */
  executionBundleIds?: number[];
  /** Preserve bounded tool results for signed Pack-side evidence normalization. */
  captureToolResults?: boolean;
  /** Exact signed provider target enforced at tool-dispatch time. */
  executionResourceScope?: ExecutionResourceScope;
  /** Core-only scope used when the selected Agent profile is Managed Hermes. */
  managedRuntimeContext?: ManagedAgentRuntimeContext;
  /** Core-verified, task-bound profile override from a signed execution grant. */
  runtimeProfileId?: number;
}

export async function runAgentChatSync(
  agentId: number,
  sessionId: string,
  userMessage: string,
  pool: pg.Pool,
  config: Config,
  ragIndexIds?: number[], // Item 3: restrict RAG injection to this subset of the agent's bound indexes
  callingUser?: AgentAccessUser, // audit #11: SSO identity for per-user policy gate on workflow/copilot/linter agent steps
  technicalIdentityToolPolicy?: ToolPatternPolicy,
  disableMemory = false, // Orchestrated/service turns must not queue optional memory LLM work behind the critical path.
  options?: AgentChatSyncOptions,
): Promise<AgentChatResult> {
  const toolCalls: AgentChatResult['tool_calls'] = [];
  const citations: Citation[] = [];
  let response = '';
  let iterations = 0;
  let runnerError: string | null = null;
  let runtimeRunId: string | undefined;

  for await (const chunk of runAgentChat(
    agentId,
    sessionId,
    userMessage,
    pool,
    config,
    options?.modelOverride,
    callingUser,
    ragIndexIds,
    options?.allowedTools,
    disableMemory,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    technicalIdentityToolPolicy,
    options?.executionBundleIds,
    options?.captureToolResults === true,
    options?.executionResourceScope,
    options?.managedRuntimeContext,
    options?.runtimeProfileId,
  )) {
    if (chunk.startsWith('data: ')) {
      const raw = chunk.slice(6).trim();
      if (raw === '[DONE]') continue;
      try {
        const evt = JSON.parse(raw) as Record<string, unknown>;
        if (typeof evt['delta'] === 'string') {
          response += evt['delta'];
          iterations++;
        } else if (typeof evt['runtime_run_id'] === 'string') {
          runtimeRunId = evt['runtime_run_id'];
        } else if (Array.isArray(evt['citations'])) {
          for (const value of evt['citations'].slice(0, 100)) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
            const citation = value as Record<string, unknown>;
            if (typeof citation['source'] !== 'string' || typeof citation['index'] !== 'string') continue;
            citations.push({
              source: citation['source'].slice(0, 1_000),
              snippet: typeof citation['snippet'] === 'string' ? citation['snippet'].slice(0, 4_000) : '',
              score: typeof citation['score'] === 'number' && Number.isFinite(citation['score']) ? citation['score'] : 0,
              index: citation['index'].slice(0, 256),
            });
          }
        } else if (evt['tool_call']) {
          const tc = evt['tool_call'] as { id?: string; name: string; args: Record<string, unknown> };
          toolCalls.push({
            name: tc.name,
            args: tc.args,
            result: '',
            ...(tc.id ? { tool_call_id: tc.id } : {}),
          });
        } else if (evt['tool_result']) {
          const tr = evt['tool_result'] as {
            tool_call_id?: string;
            name: string;
            preview: string;
            trace_id?: string;
            span_id?: string;
          };
          const last = tr.tool_call_id
            ? [...toolCalls].reverse().find(t => t.tool_call_id === tr.tool_call_id)
            : [...toolCalls].reverse().find(t => t.name === tr.name && t.result === '');
          if (last) {
            last.result = tr.preview;
            if (tr.tool_call_id) last.tool_call_id = tr.tool_call_id;
            if (tr.trace_id) last.trace_id = tr.trace_id;
            if (tr.span_id) last.span_id = tr.span_id;
          }
        } else if (typeof evt['error'] === 'string') {
          const termination = typeof evt['termination'] === 'string' ? ` [${evt['termination']}]` : '';
          runnerError = `${evt['error']}${termination}`;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  if (runnerError) throw new Error(runnerError);
  return {
    response,
    session_id: sessionId,
    tool_calls: toolCalls,
    iterations,
    citations,
    ...(runtimeRunId ? { runtime_run_id: runtimeRunId } : {}),
  };
}
