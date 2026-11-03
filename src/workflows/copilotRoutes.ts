/**
 * Phase 6 — Workflow Copilot.
 *
 *   POST /api/workflows/copilot
 *     body: { workflow_id, prompt, current_nodes?: Block[], current_edges?: Edge[] }
 *     → returns: { rationale, add_nodes: Block[], update_nodes: NodeUpdate[], add_edges: Edge[] }
 *
 * The LLM is called through the direct provider-neutral agent runtime —
 * the same routing used by continuousEval and agentRunner.
 * Output is constrained to JSON via response_format=json_object.
 *
 * The endpoint pulls the requesting user's accessible palette (skills,
 * agents, tools) and includes it in the system prompt so the LLM can only
 * suggest entities the user can actually use.
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { getRbacUser, isAdmin } from './rbacHelpers.js';
import { runAgentChatSync } from '../agents/agentRunner.js';
import { createSession } from '../agents/agentStore.js';
import { validateWorkflowSteps } from './builderRoutes.js';
import type { WorkflowStep, StepType } from './types.js';
import type { Config } from '../config/env.js';
import { normalizeNodeArgs, type CopilotBlock } from './copilotNormalize.js';
import { loadAccessibleWorkflowTools, type WorkflowToolParameter } from './integrationCatalog.js';

export { normalizeNodeArgs } from './copilotNormalize.js';

// Resolve the copilot agent id at request time (cheap query, ~1ms).
// Lets ops swap the agent without restarting.
async function getCopilotAgentId(pool: pg.Pool): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM mcp_agents WHERE name = 'workflow_copilot' AND enabled = true LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

interface CopilotEdge {
  source: string;
  target: string;
}
interface CopilotNodeUpdate {
  id: string;
  data: Record<string, unknown>;
}
interface CopilotResponse {
  rationale: string;
  add_nodes: CopilotBlock[];
  update_nodes: CopilotNodeUpdate[];
  add_edges: CopilotEdge[];
  input_params?: CopilotInputParam[];
}

export interface CopilotInputParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string | number | boolean;
}

// System prompts now live in the workflow_copilot agent's skills
// (workflow-copilot-builder + workflow-copilot-field, see migration 090).
// We only need to pass the dynamic context (palette + existing nodes)
// or (current field + user hint) as the user message.

const NODE_TYPE_DESCRIPTIONS = `
Available node types (use these in your "type" field exactly):

TRIGGERS (entry points, no input):
- trigger.manual          {}                       — runs on Run button
- trigger.schedule        { cron_expr: "0 9 * * *" } — cron schedule
- trigger.webhook         { webhook_path: "/foo" }   — POST trigger

LOGIC:
- logic.condition         { condition: "<JS expr>" } — gate flow on expression
- logic.function          { function_code: "return …" } — controlled synchronous data transform
- logic.for_each          { mode: "transform", items: "{{ steps.rows.result }}", function_code: "return { index, item };", concurrency: 4, retries: 0, on_item_error: "stop" } — bounded ordered item processing; mode may be "subworkflow" with target_workflow_id
- logic.parallel          {}                       — fan-out into branches
- logic.response          { value: "<template>" }    — terminal, returns value
- logic.wait              { seconds: 5 }            — pause
- logic.note              { text: "..." }            — sticky comment, no exec

ARGUS-NATIVE (bind to real Argus resources — only use IDs from the palette):
- argus.tool              { tool: "<name from palette.tools>" }
- argus.agent             { agent_role: "<role from palette.agents>" OR agent_id: <id>, prompt: "..." }
- argus.skill             { skill_id: <id from palette.skills> }
- argus.knowledge         { index_name: "<name from palette.rag_indexes>", query: "...", top_k: 5 }
- argus.memory            { operation: "retrieve"|"store", agent_id: <id>, query: "..." }

Template variables in any string field:
  {{ input.<name> }}        - workflow input parameters
  {{ steps.<id>.result }}   - result of an upstream step (by step id)
  {{ steps.<id>.status }}   - "completed" | "failed" | "skipped"
`.trim();

// LEGACY — kept for fallback if no copilot agent exists.
// Should match content of mcp_skills.workflow-copilot-builder.
const SYSTEM_PROMPT_TEMPLATE = `You are the Argus Workflow Copilot. The user is editing a visual
 workflow on a canvas. They will describe what they want; you propose nodes and edges
to add, or safe data-only updates to existing nodes. You never delete nodes, change
an existing node id/type/position, or remove existing edges.

You MUST respond with a JSON object matching this exact schema (no markdown, no prose):

{
  "rationale": "<one sentence: what you'll add and why>",
  "add_nodes": [
    {
      "id": "<unique id like 'step.abc123' — must NOT collide with existing nodes>",
      "type": "<one of the node types below>",
      "position": { "x": <number>, "y": <number> },
      "data": { "label": "<short name>", ...type-specific fields... }
    }
  ],
  "update_nodes": [
    {
      "id": "<id from EXISTING_NODES>",
      "data": { "<only changed data fields>": "<new value>" }
    }
  ],
  "add_edges": [
    { "source": "<node id>", "target": "<node id>" }
  ]
}

${NODE_TYPE_DESCRIPTIONS}

CRITICAL RULES:
- Use ONLY node types listed above.
- For argus.agent/skill/tool steps: use ONLY ids/names from the user's accessible PALETTE (below).
- Generate unique node ids that don't collide with EXISTING_NODES.
- When fixing an existing node, use update_nodes and include only changed data fields. Never duplicate it in add_nodes.
- update_nodes may reference only ids from EXISTING_NODES and may never contain id, type or position inside data.
- Position new nodes ~250px right of the last existing node, or at {x:50, y:150} if canvas empty.
- Put every tool parameter and Agent prompt under data.args.
- Keep Agent binding metadata at data.agent_role or data.agent_id; never put either binding inside data.args.
- Never invent provider resource IDs from display names. In particular, a Slack channel name such as "coding-ops" is NOT a channel_id. Unless the user supplies a concrete Slack ID (C..., G... or D...), use {{ input.notification_channel }} as data.args.channel_id; Argus will create the required run input.
- Keep "rationale" short (1 sentence).
- If the user's request is unclear, return rationale explaining what info you need and empty add_nodes/update_nodes/add_edges.
`.trim();

export interface PaletteEntry {
  skills: Array<{ id: number; name: string; label: string }>;
  agents: Array<{ id: number; name: string; label: string; agent_mode: string; agent_role?: string | null }>;
  tools: Array<{
    id: number;
    name: string;
    backend: string;
    parameters: WorkflowToolParameter[];
    action_label?: string;
    integration_id?: string;
    integration_label?: string;
    connection_name?: string | null;
    is_write?: boolean;
    risk_level?: 'low' | 'medium' | 'high';
  }>;
  rag_indexes?: Array<{ id: number; name: string; label: string; provider: string }>;
}

async function loadAccessiblePalette(pool: pg.Pool, allowedBundles: number[] | null): Promise<PaletteEntry> {
  const admin = allowedBundles === null;
  const bundles = admin ? null : (allowedBundles ?? []);

  const skillsQ = admin
    ? pool.query<{ id: number; name: string; label: string }>(
        `SELECT id, name, label FROM mcp_skills WHERE enabled = true ORDER BY name LIMIT 40`)
    : pool.query<{ id: number; name: string; label: string }>(
        `SELECT s.id, s.name, s.label FROM mcp_skills s
         WHERE s.enabled = true
           AND (NOT EXISTS (SELECT 1 FROM mcp_bundle_skills bs WHERE bs.skill_id = s.id)
                OR EXISTS (SELECT 1 FROM mcp_bundle_skills bs WHERE bs.skill_id = s.id AND bs.bundle_id = ANY($1::int[])))
         ORDER BY s.name LIMIT 40`,
        [bundles]
      );
  const agentsQ = admin
    ? pool.query<{ id: number; name: string; label: string; agent_mode: string; agent_role: string | null }>(
        `SELECT id, name, label, agent_mode, agent_role FROM mcp_agents WHERE enabled = true ORDER BY name LIMIT 40`)
    : pool.query<{ id: number; name: string; label: string; agent_mode: string; agent_role: string | null }>(
        `SELECT id, name, label, agent_mode, agent_role FROM mcp_agents
         WHERE enabled = true
           AND (bundle_ids IS NULL OR bundle_ids = '{}' OR bundle_ids && $1::int[])
         ORDER BY name LIMIT 40`,
        [bundles]
      );
  const toolsQ = loadAccessibleWorkflowTools(pool, allowedBundles);

  const ragIndexesQ = admin
    ? pool.query<{ id: number; name: string; label: string; provider: string }>(
        `SELECT id, name, label, provider
         FROM mcp_rag_indexes
         WHERE enabled = true
         ORDER BY label, name LIMIT 100`)
    : pool.query<{ id: number; name: string; label: string; provider: string }>(
        `SELECT DISTINCT r.id, r.name, r.label, r.provider
         FROM mcp_rag_indexes r
         JOIN mcp_agent_rag_indexes ar ON ar.rag_index_id = r.id
         JOIN mcp_agents a ON a.id = ar.agent_id
         WHERE r.enabled = true
           AND a.enabled = true
           AND (a.bundle_ids IS NULL OR a.bundle_ids = '{}' OR a.bundle_ids && $1::int[])
         ORDER BY r.label, r.name LIMIT 100`,
        [bundles]
      );

  const [s, a, tools, r] = await Promise.all([skillsQ, agentsQ, toolsQ, ragIndexesQ]);
  return {
    skills: s.rows,
    agents: a.rows,
    rag_indexes: r.rows,
    tools: tools.slice(0, 100),
  };
}

function promptSafeNodeData(data: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(data ?? {}, (key, value) => (
      /api.?key|access.?token|secret|password|authorization/i.test(key) ? '[redacted]' : value
    )).slice(0, 2_000);
  } catch {
    return '{}';
  }
}

function buildUserPrompt(
  userPrompt: string,
  palette: PaletteEntry,
  currentNodes: CopilotBlock[],
  currentEdges: CopilotEdge[],
): string {
  const paletteSection = [
    'PALETTE (only use these refs):',
    'Skills:',
    palette.skills.map((s) => `  - id=${s.id} name="${s.name}" label="${s.label}"`).join('\n') || '  (none)',
    'Agents:',
    palette.agents.map((a) => `  - id=${a.id} name="${a.name}" role="${a.agent_role ?? ''}" mode=${a.agent_mode}`).join('\n') || '  (none)',
    'Tools:',
    palette.tools.map((t) => {
      const args = t.parameters.length > 0
        ? ` args=[${t.parameters.map((p) => `${p.name}:${p.type}${p.required ? '!' : ''}${p.description ? ` (${p.description})` : ''}`).join(', ')}]`
        : ' args=(freeform)';
      const provider = t.integration_label || t.connection_name || t.backend;
      return `  - "${t.name}" action="${t.action_label ?? t.name}" integration="${provider}" connection="${t.connection_name ?? 'default'}" risk=${t.risk_level ?? 'low'}${args}`;
    }).join('\n') || '  (none)',
    'Knowledge Sources:',
    (palette.rag_indexes ?? []).map((source) =>
      `  - name="${source.name}" label="${source.label}" provider=${source.provider}`
    ).join('\n') || '  (none)',
  ].join('\n');

  const existingNodeDetails = currentNodes
    .map((n) => `  - id=${n.id} type=${n.type} data=${promptSafeNodeData(n.data)}`)
    .join('\n');
  const existingSection = currentNodes.length > 0
    ? `EXISTING_NODES on canvas (data may be redacted or truncated; update only fields you were asked to change):\n${existingNodeDetails.slice(0, 24_000)}`
    : 'EXISTING_NODES on canvas: (empty canvas)';
  const existingEdgesSection = currentEdges.length > 0
    ? `EXISTING_EDGES on canvas:\n${currentEdges.map((edge) => `  - ${edge.source} -> ${edge.target}`).join('\n')}`
    : 'EXISTING_EDGES on canvas: (none)';

  return [
    paletteSection,
    '',
    'RESOURCE ID RULES:',
    '- Never invent provider resource IDs from display names.',
    '- A Slack channel name such as "coding-ops" is not a channel_id.',
    '- Unless the user supplies a concrete Slack ID beginning with C, G or D, use {{ input.notification_channel }} as data.args.channel_id. Argus will create the required run input.',
    '- To fix an existing node, return update_nodes with that exact existing id and only the changed data fields. Never recreate an existing node.',
    '',
    existingSection,
    existingEdgesSection,
    '',
    `USER REQUEST: ${userPrompt}`,
  ].join('\n');
}

/**
 * Fix A — palette-aware required-arg check (the structural linter
 * `validateWorkflowSteps` is schema-blind, so it cannot catch this).
 *
 * For each argus.tool node, look the tool up in the palette and verify every
 * REQUIRED parameter is supplied in `data.args` with a non-empty value. This is
 * the copilot's #1 reliability gap on long tool chains: it picks the right tool
 * but emits empty args. Returns flat issue strings (one per missing required
 * arg) to feed the SAME corrective re-prompt + warnings[] path the linter uses.
 *
 * Must run AFTER normalizeNodeArgs (so args live under `data.args`). Skips:
 * non-tool nodes, nodes missing the `tool` key (the linter flags those),
 * unknown tools, and tools with no params / only-optional params.
 *
 * Pure / no DB — exported for unit testing.
 */
export function findMissingRequiredArgs(
  nodes: CopilotBlock[],
  palette: PaletteEntry,
): string[] {
  const byName = new Map(palette.tools.map((t) => [t.name, t]));
  const issues: string[] = [];

  for (const n of nodes) {
    if (n.type !== 'argus.tool') continue;
    const data = (n.data ?? {}) as Record<string, unknown>;
    const toolName = typeof data['tool'] === 'string' ? data['tool'] : undefined;
    if (!toolName) continue; // missing `tool` is the linter's job

    const tool = byName.get(toolName);
    if (!tool || tool.parameters.length === 0) continue; // unknown or freeform → can't check

    const args = (data['args'] !== null && typeof data['args'] === 'object')
      ? (data['args'] as Record<string, unknown>)
      : {};
    const id = n.id ?? '?';

    for (const p of tool.parameters) {
      if (!p.required) continue;
      const v = args[p.name];
      const missing = v === undefined || v === null
        || (typeof v === 'string' && v.trim() === '');
      if (missing) {
        issues.push(`${id}: missing required arg '${p.name}' for tool '${toolName}'`);
      }
    }
  }
  return issues;
}

const COPILOT_ACTION_VERBS = new Set([
  'get', 'list', 'search', 'query', 'describe', 'inspect', 'read', 'fetch', 'count', 'show',
  'create', 'send', 'post', 'update', 'delete', 'merge', 'close', 'approve', 'write', 'push',
  'run', 'trigger', 'deploy', 'restart', 'scale', 'patch', 'apply', 'download', 'upload', 'reply',
]);

function normalizedAction(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function copilotActionHint(tool: PaletteEntry['tools'][number]): string {
  const explicit = normalizedAction(tool.action_label ?? '');
  if (explicit) return explicit;
  const segments = normalizedAction(tool.name).split('_').filter(Boolean);
  const verbIndex = segments.findIndex(segment => COPILOT_ACTION_VERBS.has(segment));
  return (verbIndex >= 0 ? segments.slice(verbIndex) : segments).join('_');
}

/**
 * Preserve the concrete tool chosen from the current RBAC-filtered palette and
 * attach a provider-neutral contract. Templates and cloned workflows can then
 * resolve the same intent against another user's MCP Fabric connection.
 */
export function enrichCopilotToolBindings(
  nodes: CopilotBlock[],
  palette: PaletteEntry,
): CopilotBlock[] {
  const byName = new Map(palette.tools.map(tool => [tool.name, tool]));
  return nodes.map(node => {
    if (node.type !== 'argus.tool') return node;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const toolName = typeof data['tool'] === 'string' ? data['tool'].trim() : '';
    const tool = byName.get(toolName);
    const integrationId = tool?.integration_id?.trim();
    const actionHint = tool ? copilotActionHint(tool) : '';
    if (!tool || !integrationId || !actionHint) return node;

    const requiredParameters = tool.parameters
      .filter(parameter => parameter.required)
      .map(parameter => parameter.name);
    const toolBinding: Record<string, unknown> = {
      integration_id: integrationId,
      action_hints: [actionHint],
      access: tool.is_write ? 'write' : 'read',
    };
    if (requiredParameters.length > 0) {
      toolBinding['required_parameters'] = requiredParameters;
    }
    return {
      ...node,
      data: {
        ...data,
        integration_id: integrationId,
        tool_binding: toolBinding,
      },
    };
  });
}

const INPUT_REFERENCE = /^\s*\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;
const SLACK_RESOURCE_ID = /^[CGD][A-Z0-9]{8,}$/;

/**
 * Provider resource display names are not API identifiers. Convert unresolved
 * Slack destinations into an explicit workflow input so the Run modal can ask
 * for the environment-specific channel id instead of persisting a value that
 * Slack will reject with channel_not_found.
 */
export function parameterizeCopilotResourceArgs(
  nodes: CopilotBlock[],
  palette: PaletteEntry,
): { nodes: CopilotBlock[]; inputParams: CopilotInputParam[] } {
  const tools = new Map(palette.tools.map(tool => [tool.name, tool]));
  const inputs = new Map<string, CopilotInputParam>();
  const normalized = nodes.map(node => {
    if (node.type !== 'argus.tool') return node;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const toolName = typeof data['tool'] === 'string' ? data['tool'].trim() : '';
    const tool = tools.get(toolName);
    const integrationId = tool?.integration_id ?? (typeof data['integration_id'] === 'string' ? data['integration_id'] : '');
    if (integrationId !== 'slack') return node;
    const args = data['args'] && typeof data['args'] === 'object' && !Array.isArray(data['args'])
      ? data['args'] as Record<string, unknown>
      : {};
    const rawChannel = typeof args['channel_id'] === 'string' ? args['channel_id'].trim() : '';
    if (!rawChannel) return node;

    const inputMatch = INPUT_REFERENCE.exec(rawChannel);
    if (SLACK_RESOURCE_ID.test(rawChannel)) return node;
    const inputName = inputMatch?.[1] ?? 'notification_channel';
    const requestedDestination = inputMatch ? '' : rawChannel;
    inputs.set(inputName, {
      name: inputName,
      type: 'string',
      description: requestedDestination
        ? `Slack channel ID for requested destination "${requestedDestination}" (for example C01234567)`
        : 'Slack channel ID (for example C01234567)',
      required: true,
    });
    const reference = `{{ input.${inputName} }}`;
    if (rawChannel === reference) return node;
    return {
      ...node,
      data: {
        ...data,
        args: { ...args, channel_id: reference },
      },
    };
  });
  return { nodes: normalized, inputParams: [...inputs.values()] };
}

function prepareCopilotNodes(nodes: CopilotBlock[], palette: PaletteEntry): {
  nodes: CopilotBlock[];
  inputParams: CopilotInputParam[];
} {
  return parameterizeCopilotResourceArgs(
    enrichCopilotToolBindings(nodes.map(normalizeNodeArgs), palette),
    palette,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeCopilotData(
  current: Record<string, unknown>,
  proposed: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(proposed)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    merged[key] = isRecord(value) && isRecord(current[key])
      ? mergeCopilotData(current[key], value)
      : value;
  }
  return merged;
}

function materializeCopilotUpdates(
  currentNodes: CopilotBlock[],
  updates: CopilotNodeUpdate[],
): CopilotBlock[] {
  const currentById = new Map(currentNodes.map(node => [node.id, node]));
  return updates.flatMap(update => {
    const current = currentById.get(update.id);
    if (!current) return [];
    const normalizedUpdate = normalizeNodeArgs({
      id: update.id,
      type: current.type,
      data: update.data,
    });
    return [{ ...current, data: mergeCopilotData(current.data ?? {}, normalizedUpdate.data) }];
  });
}

function prepareCopilotUpdates(
  currentNodes: CopilotBlock[],
  updates: CopilotNodeUpdate[],
  palette: PaletteEntry,
): { updates: CopilotNodeUpdate[]; nodes: CopilotBlock[]; inputParams: CopilotInputParam[] } {
  const prepared = parameterizeCopilotResourceArgs(
    enrichCopilotToolBindings(materializeCopilotUpdates(currentNodes, updates), palette),
    palette,
  );
  const preparedById = new Map(prepared.nodes.map(node => [node.id, node.data]));
  return {
    updates: updates.map(update => ({
      id: update.id,
      data: preparedById.get(update.id) ?? update.data,
    })),
    nodes: prepared.nodes,
    inputParams: prepared.inputParams,
  };
}

function combineInputParams(...groups: CopilotInputParam[][]): CopilotInputParam[] {
  const combined = new Map<string, CopilotInputParam>();
  for (const group of groups) {
    for (const parameter of group) combined.set(parameter.name, parameter);
  }
  return [...combined.values()];
}

function prepareCopilotResponse(
  response: CopilotResponse,
  currentNodes: CopilotBlock[],
  palette: PaletteEntry,
): { response: CopilotResponse; changedNodes: CopilotBlock[] } {
  const added = prepareCopilotNodes(response.add_nodes, palette);
  const updated = prepareCopilotUpdates(currentNodes, response.update_nodes, palette);
  return {
    response: {
      ...response,
      add_nodes: added.nodes,
      update_nodes: updated.updates,
      input_params: combineInputParams(added.inputParams, updated.inputParams),
    },
    changedNodes: [...added.nodes, ...updated.nodes],
  };
}

/**
 * Reject tool names invented by the model before they reach the canvas. The
 * prompt contains only RBAC-filtered tools, but prompt instructions alone are
 * not an authorization or correctness boundary.
 */
export function findUnavailableTools(
  nodes: CopilotBlock[],
  palette: PaletteEntry,
): string[] {
  const available = new Set(palette.tools.map(tool => tool.name));
  const issues: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'argus.tool') continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const toolName = typeof data['tool'] === 'string' ? data['tool'].trim() : '';
    if (toolName && !available.has(toolName)) {
      issues.push(`${node.id ?? '?'}: tool '${toolName}' is not available in the user's MCP bundle palette`);
    }
  }
  return issues;
}

/** Validate the graph identity boundary the generic step linter cannot see. */
export function findCopilotGraphIssues(
  currentNodes: CopilotBlock[],
  addNodes: CopilotBlock[],
  addEdges: CopilotEdge[],
  updateNodes: CopilotNodeUpdate[] = [],
): string[] {
  const currentIds = new Set(currentNodes.map(node => node.id).filter((id): id is string => Boolean(id)));
  const knownIds = new Set(currentIds);
  const issues: string[] = [];
  for (const node of addNodes) {
    const id = node.id?.trim();
    if (!id) {
      issues.push(`${node.type}: proposed node is missing a stable id`);
      continue;
    }
    if (knownIds.has(id)) {
      issues.push(`${id}: proposed node id collides with an existing or proposed node`);
      continue;
    }
    knownIds.add(id);
  }
  const updatedIds = new Set<string>();
  for (const update of updateNodes) {
    const id = update.id?.trim();
    if (!id || !currentIds.has(id)) {
      issues.push(`${id || '?'}: update references a node that is not on the current canvas`);
      continue;
    }
    if (updatedIds.has(id)) {
      issues.push(`${id}: node is updated more than once`);
      continue;
    }
    updatedIds.add(id);
  }
  for (const edge of addEdges) {
    if (!knownIds.has(edge.source) || !knownIds.has(edge.target)) {
      issues.push(`${edge.source} -> ${edge.target}: edge references a missing node`);
    }
  }
  return issues;
}

function validateResponse(raw: unknown): CopilotResponse {
  if (!raw || typeof raw !== 'object') throw new Error('LLM returned non-object');
  const r = raw as Partial<CopilotResponse>;
  if (typeof r.rationale !== 'string') throw new Error('missing rationale');
  if (!Array.isArray(r.add_nodes)) throw new Error('missing add_nodes[]');
  if (!Array.isArray(r.add_edges)) throw new Error('missing add_edges[]');
  const updateNodes = r.update_nodes ?? [];
  if (!Array.isArray(updateNodes)) throw new Error('update_nodes must be an array');
  // Light sanity-check on each node
  for (const n of r.add_nodes) {
    if (!n.type || typeof n.type !== 'string') throw new Error('node missing type');
    if (!n.data || typeof n.data !== 'object') throw new Error(`node ${n.id ?? '?'} missing data`);
  }
  for (const update of updateNodes) {
    if (!update || typeof update.id !== 'string' || !update.id.trim()) throw new Error('node update missing id');
    if (!isRecord(update.data)) throw new Error(`node update ${update.id} missing data`);
    if ('id' in update.data || 'type' in update.data || 'position' in update.data) {
      throw new Error(`node update ${update.id} may only change data fields`);
    }
  }
  return { rationale: r.rationale, add_nodes: r.add_nodes, update_nodes: updateNodes, add_edges: r.add_edges };
}

// ── Per-field magic-wand prompt template ───────────────────────
const FIELD_SYSTEM_PROMPT = `You are the Argus Field-Wand. The user is editing a single
text field in a workflow-builder node and wants help rewriting it.

You will receive: field name, current value, the user's hint, and the surrounding
node context. Return ONLY the new field value as plain text (no markdown, no
quotes, no JSON wrapper). Be concise — match the original length and style.

If the field is JavaScript / code / cron / template string, return only valid
content of that kind. Never include explanatory prose.`.trim();

// Map the copilot's existing-canvas + proposed nodes/edges into the
// WorkflowStep[] shape the validator (validateWorkflowSteps) expects.
// Edges become depends_on links (target depends on source).
function toValidatorSteps(
  currentNodes: CopilotBlock[],
  addNodes: CopilotBlock[],
  currentEdges: CopilotEdge[],
  addEdges: CopilotEdge[],
  updateNodes: CopilotNodeUpdate[] = [],
): WorkflowStep[] {
  const updatesById = new Map(updateNodes.map(update => [update.id, update.data]));
  const updatedCurrent = currentNodes.map(node => {
    const update = node.id ? updatesById.get(node.id) : undefined;
    return update ? { ...node, data: mergeCopilotData(node.data ?? {}, update) } : node;
  });
  const all = [...updatedCurrent, ...addNodes];
  const dependsOn = new Map<string, string[]>();
  for (const e of [...currentEdges, ...addEdges]) {
    const list = dependsOn.get(e.target) ?? [];
    list.push(e.source);
    dependsOn.set(e.target, list);
  }
  return all.map((n) => {
    const data = (n.data ?? {}) as Record<string, unknown>;
    const id = n.id ?? '?';
    const step: WorkflowStep = {
      id,
      label: typeof data['label'] === 'string' ? (data['label'] as string) : id,
      type: n.type as StepType | string,
      args: {},
    };
    const depends = dependsOn.get(id);
    if (depends && depends.length > 0) step.depends_on = depends;
    if (typeof data['tool'] === 'string') step.tool = data['tool'] as string;
    const agentRole = typeof data['agent_role'] === 'string' ? data['agent_role'].trim().toLowerCase() : '';
    if (agentRole) step.agent_role = agentRole;
    else if (typeof data['agent_id'] === 'number') step.agent_id = data['agent_id'] as number;
    if (typeof data['skill_id'] === 'number') step.skill_id = data['skill_id'] as number;
    if (typeof data['function_code'] === 'string') step.function_code = data['function_code'] as string;
    if (typeof data['condition'] === 'string') step.condition = data['condition'] as string;
    return step;
  });
}

// Flatten validator errors into a flat string[] for the soft-fail `warnings`
// field returned to the client (and for the corrective re-prompt).
function flattenErrors(errors: Array<{ stepId: string; issue: string }>): string[] {
  return errors.map((e) => `${e.stepId}: ${e.issue}`);
}

export function registerCopilotRoutes(
  app: Express,
  pool: pg.Pool,
  config: Config,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
): void {
  // ── POST /api/workflows/copilot-field ─────────────────────────
  // Per-field magic-wand: rewrites a single string field via the
  // workflow_copilot Argus Agent (system-prompt = workflow-copilot-field skill).
  app.post('/api/workflows/copilot-field', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      field_name?: string;
      current_value?: string;
      user_hint?: string;
      node_type?: string;
      node_label?: string;
    };
    const fieldName = String(body.field_name ?? '').slice(0, 64);
    const userHint  = String(body.user_hint ?? '').trim();
    if (!fieldName || !userHint) {
      res.status(400).json({ error: 'field_name and user_hint required' });
      return;
    }
    const agentId = await getCopilotAgentId(pool);
    if (!agentId) {
      res.status(503).json({ error: 'workflow_copilot agent not found (run migration 090)' });
      return;
    }
    const userMsg = [
      `Mode: per-field rewrite (return ONLY the new value as plain text).`,
      `Node type: ${body.node_type ?? '?'}`,
      `Node label: ${body.node_label ?? '?'}`,
      `Field: ${fieldName}`,
      `Current value:`,
      String(body.current_value ?? '(empty)').slice(0, 2000),
      ``,
      `User request: ${userHint.slice(0, 800)}`,
    ].join('\n');
    try {
      const sessionId = `copilot-field-${randomUUID()}`;
      await createSession(pool, agentId, sessionId);
      const result = await runAgentChatSync(agentId, sessionId, userMsg, pool, config);
      res.json({ value: result.response.trim() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'copilot-field: failed');
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/workflows/copilot', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as {
      workflow_id?: number;
      prompt?: string;
      current_nodes?: CopilotBlock[];
      current_edges?: CopilotEdge[];
    };
    const userPrompt = String(body.prompt ?? '').trim();
    if (!userPrompt) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    if (userPrompt.length > 2000) {
      res.status(400).json({ error: 'prompt too long (max 2000 chars)' });
      return;
    }
    const agentId = await getCopilotAgentId(pool);
    if (!agentId) {
      res.status(503).json({ error: 'workflow_copilot agent not found (run migration 090)' });
      return;
    }

    const user = getRbacUser(req);
    const palette = await loadAccessiblePalette(
      pool,
      isAdmin(user) ? null : (user.allowed_bundles ?? [])
    );
    const currentNodes = Array.isArray(body.current_nodes) ? body.current_nodes.slice(0, 250) : [];
    const currentEdges = Array.isArray(body.current_edges) ? body.current_edges.slice(0, 500) : [];
    const userMessage = buildUserPrompt(userPrompt, palette, currentNodes, currentEdges);

    // Stage 1: call the agent — any throw (network, gateway, timeout) → 500
    const sessionId = `copilot-${randomUUID()}`;
    let agentResult: Awaited<ReturnType<typeof runAgentChatSync>>;
    try {
      // Create the session before calling the agent — runAgentChatSync requires
      // the session to already exist (getSession throws otherwise).
      await createSession(pool, agentId, sessionId);
      // The agent's bound skills (workflow-copilot-builder) carry the system
      // prompt and JSON-output rules. We pass only the dynamic context.
      agentResult = await runAgentChatSync(agentId, sessionId, userMessage, pool, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'copilot: failed');
      res.status(500).json({ error: msg });
      return;
    }

    // Stage 2: parse JSON. On failure do ONE repair re-prompt (Fix B) before
    // the 422 — vague prompts make the agent emit prose / fenced / truncated
    // output; a targeted "return ONLY valid JSON" nudge (reusing the session)
    // recovers most of them, and tells the agent that if the request is too
    // vague it should still return valid JSON with empty add_nodes + an
    // explanatory rationale. Only 422 if the repair also fails to parse.
    let content = agentResult.response;
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      logger.warn({ sessionId }, 'copilot: first response not valid JSON — repair re-prompt');
      const repairMsg = [
        'Your previous response was NOT valid JSON and could not be parsed.',
        'Return ONLY a single valid JSON object matching the required schema',
        '{ "rationale": "...", "add_nodes": [...], "update_nodes": [...], "add_edges": [...] } —',
        'no markdown, no code fences, no prose before or after.',
        'If your previous answer was cut off or incomplete, return a MORE COMPACT',
        'workflow with fewer nodes so the entire JSON object fits and closes.',
        'If the request is too vague to design a concrete workflow, still return',
        'that JSON object with empty add_nodes/update_nodes/add_edges and a rationale that says',
        'what specific information you need.',
      ].join(' ');
      try {
        const repair = await runAgentChatSync(agentId, sessionId, repairMsg, pool, config);
        content = repair.response;
        parsed = JSON.parse(content);
      } catch {
        res.status(422).json({ error: 'agent did not return valid JSON', raw: content.slice(0, 400) });
        return;
      }
    }

    // Stage 3: validate schema — structurally invalid → 422
    let validated: CopilotResponse;
    try {
      validated = validateResponse(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'copilot: failed');
      res.status(422).json({ error: msg, raw: content.slice(0, 400) });
      return;
    }

    // Normalize: move flat arg keys in each node's `data` into `data.args` so
    // the canvas ToolConfigForm and the workflow serializer see consistent shape.
    // Done here (after schema validation, before the linter) so both the
    // self-validate lint AND the final res.json see normalized nodes.
    let prepared = prepareCopilotResponse(validated, currentNodes, palette);
    validated = prepared.response;
    let changedNodes = prepared.changedNodes;

    // ── Stage 4: self-validate loop ─────────────────────────────────
    // Run the SAME linter the manual /validate route uses against
    // currentNodes + proposed nodes/edges. On errors, do ONE corrective
    // re-prompt that names the errors. If it's still invalid, soft-fail:
    // return the best-effort result WITH warnings[] at HTTP 200 instead
    // of hard-failing. The re-prompt agent call has its OWN try/catch so a
    // re-prompt failure degrades to the first result + a warning — it must
    // NEVER leave the response unsent (preserves Stage-1's no-empty-response
    // guarantee). No outer try/catch is introduced here.
    // Worst-case agent calls for one request = 3 (Stage-1 + Fix-B JSON repair +
    // this corrective re-prompt); each is one-shot, no loop, so the bound holds.
    let lint = validateWorkflowSteps(
      toValidatorSteps(currentNodes, validated.add_nodes, currentEdges, validated.add_edges, validated.update_nodes)
    );
    // Fix A: combine the structural linter ERRORS (lint.warnings are advisory
    // and intentionally not surfaced here) with palette-aware missing required
    // args (empty-arg tool nodes — the copilot's #1 reliability gap). Both feed
    // the SAME corrective re-prompt + warnings[] path.
    let issues = [
      ...flattenErrors(lint.errors),
      ...findCopilotGraphIssues(currentNodes, validated.add_nodes, validated.add_edges, validated.update_nodes),
      ...findUnavailableTools(changedNodes, palette),
      ...findMissingRequiredArgs(changedNodes, palette),
    ];

    if (issues.length > 0) {
      logger.warn({ sessionId, issues }, 'copilot: first attempt failed validation — re-prompting once');
      const correctiveMsg = [
        userMessage,
        '',
        'YOUR PREVIOUS RESPONSE FAILED VALIDATION. Fix these issues and return a corrected JSON object (same schema). Put tool parameters and the Agent prompt under data.args. Keep Agent binding metadata at data.agent_role or data.agent_id, never inside data.args:',
        ...issues.map((i) => `  - ${i}`),
      ].join('\n');

      // The re-prompt re-uses the SAME sessionId so the agent has the
      // conversational context of its first (rejected) answer.
      try {
        const reResult = await runAgentChatSync(agentId, sessionId, correctiveMsg, pool, config);
        const reparsed = JSON.parse(reResult.response);
        validated = validateResponse(reparsed);
        // Re-normalize the corrected nodes exactly like the first pass — without
        // this, re-prompted args would stay flat in `data` (dropped by the
        // serializer) AND findMissingRequiredArgs below would mis-fire.
        prepared = prepareCopilotResponse(validated, currentNodes, palette);
        validated = prepared.response;
        changedNodes = prepared.changedNodes;
        lint = validateWorkflowSteps(
          toValidatorSteps(currentNodes, validated.add_nodes, currentEdges, validated.add_edges, validated.update_nodes)
        );
        issues = [
          ...flattenErrors(lint.errors),
          ...findCopilotGraphIssues(currentNodes, validated.add_nodes, validated.add_edges, validated.update_nodes),
          ...findUnavailableTools(changedNodes, palette),
          ...findMissingRequiredArgs(changedNodes, palette),
        ];
      } catch (reErr) {
        // Re-prompt threw, or produced unparseable / structurally-invalid JSON.
        // Keep the first (valid-shape) `validated` result and surface a warning.
        // Soft-fail — still HTTP 200, never an unsent/500 response.
        const reMsg = reErr instanceof Error ? reErr.message : String(reErr);
        logger.warn({ sessionId, reMsg }, 'copilot: corrective re-prompt failed — soft-failing with first result');
        res.json({ ...validated, warnings: [...issues, `re-prompt failed: ${reMsg}`] });
        return;
      }

      if (issues.length > 0) {
        // Still invalid after one corrective attempt → soft fail (200 + warnings).
        logger.warn({ sessionId, issues }, 'copilot: still invalid after re-prompt — returning with warnings');
        res.json({ ...validated, warnings: issues });
        return;
      }
    }

    // Valid (either first try or after one corrective re-prompt).
    res.json(validated);
  });
}

/**
 * Test seam (P2-4): exposes the RBAC-filtered palette loader so unit tests can
 * assert tool parameters are included and bundle filtering still applies.
 * Not used by production routes.
 */
export function loadAccessiblePaletteForTest(
  pool: pg.Pool,
  allowedBundles: number[] | null,
): Promise<PaletteEntry> {
  return loadAccessiblePalette(pool, allowedBundles);
}
