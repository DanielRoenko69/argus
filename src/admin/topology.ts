/**
 * Topology endpoint — assembles a Cytoscape-shaped {nodes, edges} graph of
 * the agent/RAG/model/backend/composite relationships.
 *
 * This lives in src/admin because it models the full Argus control plane.
 * ---------------------------------------------------------
 * The graph mixes agent-runtime entities (mcp_agents, mcp_rag_indexes,
 * mcp_backends) with the direct-provider model catalog (mcp_models). Putting it on the
 * existing /api/admin/* surface keeps it reachable for any admin
 * session — operations admin and platform admin alike.
 *
 * Output shape
 * ------------
 *   {
 *     nodes: [{ data: { id, label, type, ...meta } }],
 *     edges: [{ data: { source, target, type, ...meta } }],
 *     stats: { agents, rags, models, backends, composites, edges }
 *   }
 *
 * `type` discriminates the node class for styling on the client
 * (agent / rag / model / backend / composite).
 *
 * Missing tables (older deployments) are tolerated — we degrade to an
 * empty bucket for that class so the graph still renders.
 */

import type { Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';

type NodeType = 'agent' | 'rag' | 'model' | 'backend' | 'composite' | 'bundle' | 'tool';
// Edge directions are oriented for hierarchical LR layout:
//   tool → backend → bundle → composite → agent → {rag, model}
//                                         rag/agent ─embeds-via→ model
// Every edge points toward the consumer/dependency. Source is left, target
// is right under dagre LR, so dagre lays everything out:
//   [tools, backends, bundles, composites]  →  [agents]  →  [rag, model]
//        upstream (left)                       (centre)       downstream (right)
type EdgeType =
  | 'tool-on-backend'      // tool → backend
  | 'backend-in-bundle'    // backend → bundle
  | 'tool-in-bundle'       // tool → bundle
  | 'bundle-in-composite'  // bundle → composite
  | 'composite-used-by'    // composite → agent
  | 'uses-rag'             // agent → rag
  | 'uses-model'           // agent → model (chat/completion model)
  | 'embeds-via';          // {rag, agent} → embedding-model (implicit via EMBEDDING_MODEL env)

interface CyNode {
  data: {
    id: string;
    label: string;
    type: NodeType;
    [key: string]: unknown;
  };
}

interface CyEdge {
  data: {
    id: string;
    source: string;
    target: string;
    type: EdgeType;
    [key: string]: unknown;
  };
}

async function tableExists(pool: pg.Pool, name: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1) AS exists`,
      [name],
    );
    return Boolean(rows[0]?.exists);
  } catch {
    return false;
  }
}

// ── Glob pattern helpers ───────────────────────────────────────
// Composite allow/deny patterns are simple globs: `workspace_*`, `*_search`,
// `atlassian_jira_get*`. We translate to anchored regex with `.*` for `*`,
// after escaping other regex metacharacters.
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * Empty allow → everything is allowed by default.
 * Any deny match always wins, even over an explicit allow match.
 */
function isToolAllowedByPatterns(toolName: string, allow: string[], deny: string[]): boolean {
  for (const p of deny) {
    if (globToRegex(p).test(toolName)) return false;
  }
  if (allow.length === 0) return true;
  for (const p of allow) {
    if (globToRegex(p).test(toolName)) return true;
  }
  return false;
}

export interface TopologyOptions {
  /** Include individual tool nodes (and tool→backend / bundle→tool edges). Default false because there can be 50-100+. */
  includeTools?: boolean;
}

/** Build the full graph. Returns Cytoscape-compatible JSON. */
export async function buildTopology(
  pool: pg.Pool,
  opts: TopologyOptions = {},
): Promise<{ nodes: CyNode[]; edges: CyEdge[]; stats: Record<string, number> }> {
  const nodes: CyNode[] = [];
  const edges: CyEdge[] = [];
  const stats: Record<string, number> = { agents: 0, rags: 0, models: 0, backends: 0, composites: 0, bundles: 0, tools: 0, edges: 0 };
  const includeTools = opts.includeTools === true;

  // ── Agents ──────────────────────────────────────────────────────
  if (await tableExists(pool, 'mcp_agents')) {
    const { rows } = await pool.query<{
      id: number; name: string; label: string | null; agent_mode: string;
      model: string | null; composite_id: number | null; enabled: boolean;
    }>(`SELECT id, name, label, agent_mode, model, composite_id, enabled FROM mcp_agents`);
    for (const a of rows) {
      nodes.push({
        data: {
          id: `agent:${a.id}`,
          label: a.label ?? a.name,
          type: 'agent',
          mode: a.agent_mode,
          model: a.model,
          enabled: a.enabled,
        },
      });
      stats.agents += 1;

      // composite → agent (composite "feeds into" agent). Direction is
      // composite→agent (not agent→composite) so a hierarchical LR layout
      // places the whole upstream chain on the left and the agent in the
      // centre — between its sources (composites) and its targets (RAG/Model).
      if (a.composite_id !== null) {
        edges.push({
          data: {
            id: `composite:${a.composite_id}->agent:${a.id}`,
            source: `composite:${a.composite_id}`,
            target: `agent:${a.id}`,
            type: 'composite-used-by',
          },
        });
      }
    }
  }

  // ── RAG indexes ────────────────────────────────────────────────
  if (await tableExists(pool, 'mcp_rag_indexes')) {
    const { rows } = await pool.query<{
      id: number; name: string; label: string | null; provider: string;
      endpoint: string | null; enabled: boolean;
    }>(`SELECT id, name, label, provider, endpoint, enabled FROM mcp_rag_indexes`);
    for (const r of rows) {
      nodes.push({
        data: {
          id: `rag:${r.id}`,
          label: r.label ?? r.name,
          type: 'rag',
          provider: r.provider,
          endpoint: r.endpoint,
          enabled: r.enabled,
        },
      });
      stats.rags += 1;
    }
  }

  // ── agent ↔ rag edges ───────────────────────────────────────────
  if (await tableExists(pool, 'mcp_agent_rag_indexes')) {
    const { rows } = await pool.query<{ agent_id: number; rag_index_id: number; priority: number | null }>(
      `SELECT agent_id, rag_index_id, priority FROM mcp_agent_rag_indexes`,
    );
    for (const e of rows) {
      edges.push({
        data: {
          id: `agent:${e.agent_id}->rag:${e.rag_index_id}`,
          source: `agent:${e.agent_id}`,
          target: `rag:${e.rag_index_id}`,
          type: 'uses-rag',
          priority: e.priority,
        },
      });
    }
  }

  // ── Models ──────────────────────────────────────────────────────
  if (await tableExists(pool, 'mcp_models')) {
    const { rows } = await pool.query<{
      model_name: string; model_group: string | null; provider: string; enabled: boolean;
    }>(`SELECT DISTINCT ON (model_name) model_name, model_group, provider, enabled
        FROM mcp_models WHERE enabled = true ORDER BY model_name`);
    for (const m of rows) {
      nodes.push({
        data: {
          id: `model:${m.model_name}`,
          label: m.model_name,
          type: 'model',
          provider: m.provider,
          group: m.model_group,
        },
      });
      stats.models += 1;
    }
  }

  // ── agent → model edges (string match on model_name) ────────────
  // Build a quick set of known model names so we don't emit dangling edges
  const modelIds = new Set(nodes.filter((n) => n.data.type === 'model').map((n) => n.data.id));
  for (const n of nodes) {
    if (n.data.type !== 'agent') continue;
    const model = n.data.model as string | null;
    if (!model) continue;
    const targetId = `model:${model}`;
    if (!modelIds.has(targetId)) continue;
    edges.push({
      data: {
        id: `${n.data.id}->${targetId}`,
        source: n.data.id,
        target: targetId,
        type: 'uses-model',
      },
    });
  }

  // ── Embedding-model edges ───────────────────────────────────────
  // The embedding model isn't stored on any agent row — it's a global
  // EMBEDDING_MODEL env var (default text-embedding-3-large), so the
  // agent→model edges above never wire it up. The node ends up orphaned
  // in the graph even though every RAG and every memory-enabled agent
  // depends on it.
  //
  // Surface that dependency explicitly:
  //   1. Each RAG → embedding-model (RAG queries are embedded before vector search)
  //   2. Each agent with at least one mcp_agent_memory row → embedding-model
  //      (pgvector memory writes/reads go through the embedding model)
  const embeddingModel = process.env['EMBEDDING_MODEL'] ?? 'text-embedding-3-large';
  const embeddingNodeId = `model:${embeddingModel}`;
  if (modelIds.has(embeddingNodeId)) {
    for (const n of nodes) {
      if (n.data.type !== 'rag') continue;
      edges.push({
        data: {
          id: `${n.data.id}->${embeddingNodeId}`,
          source: n.data.id,
          target: embeddingNodeId,
          type: 'embeds-via',
          purpose: 'rag-query',
        },
      });
    }
    if (await tableExists(pool, 'mcp_agent_memory')) {
      const agentNodeIds = new Set(
        nodes.filter((n) => n.data.type === 'agent').map((n) => n.data.id),
      );
      const { rows } = await pool.query<{ agent_id: number }>(
        `SELECT DISTINCT agent_id FROM mcp_agent_memory`,
      );
      for (const r of rows) {
        const sourceId = `agent:${r.agent_id}`;
        if (!agentNodeIds.has(sourceId)) continue;
        edges.push({
          data: {
            id: `${sourceId}->${embeddingNodeId}`,
            source: sourceId,
            target: embeddingNodeId,
            type: 'embeds-via',
            purpose: 'agent-memory',
          },
        });
      }
    }
  }

  // ── Backends ────────────────────────────────────────────────────
  if (await tableExists(pool, 'mcp_backends')) {
    const { rows } = await pool.query<{
      id: number; name: string; base_url: string; backend_type: string | null; enabled: boolean;
    }>(`SELECT id, name, base_url, backend_type, enabled FROM mcp_backends`);
    for (const b of rows) {
      nodes.push({
        data: {
          id: `backend:${b.id}`,
          label: b.name,
          type: 'backend',
          base_url: b.base_url,
          backend_type: b.backend_type ?? 'http',
          enabled: b.enabled,
        },
      });
      stats.backends += 1;
    }
  }

  // ── Composites ─────────────────────────────────────────────────
  if (await tableExists(pool, 'mcp_composites')) {
    const { rows } = await pool.query<{
      id: number; name: string; enabled: boolean;
      included_bundle_ids: number[] | null;
      tool_allow_patterns: string[] | null;
      tool_deny_patterns: string[] | null;
    }>(`SELECT id, name, enabled, included_bundle_ids, tool_allow_patterns, tool_deny_patterns FROM mcp_composites`);
    for (const c of rows) {
      nodes.push({
        data: {
          id: `composite:${c.id}`,
          label: c.name,
          type: 'composite',
          enabled: c.enabled,
          included_bundle_ids: c.included_bundle_ids ?? [],
          tool_allow_patterns: c.tool_allow_patterns ?? [],
          tool_deny_patterns:  c.tool_deny_patterns  ?? [],
        },
      });
      stats.composites += 1;

      // bundle → composite edges. Direction is bundle→composite (not the
      // other way) so a hierarchical LR layout chains
      // tool → backend → bundle → composite ← agent neatly.
      for (const bid of c.included_bundle_ids ?? []) {
        // included_bundle_ids kann null-Eintraege enthalten (alte Daten).
        // Sonst entstuende eine Edge zum nicht-existenten bundle:null Node -> Cytoscape-Crash.
        if (bid == null) continue;
        edges.push({
          data: {
            id: `bundle:${bid}->composite:${c.id}`,
            source: `bundle:${bid}`,
            target: `composite:${c.id}`,
            type: 'bundle-in-composite',
          },
        });
      }
    }
  }

  // ── Service bundles ────────────────────────────────────────────
  if (await tableExists(pool, 'mcp_service_bundles')) {
    const { rows } = await pool.query<{ id: number; name: string; label: string | null; icon: string | null }>(
      `SELECT id, name, label, icon FROM mcp_service_bundles`,
    );
    for (const b of rows) {
      nodes.push({
        data: {
          id: `bundle:${b.id}`,
          label: b.label || b.name,
          type: 'bundle',
          icon: b.icon || null,
        },
      });
      stats.bundles += 1;
    }
  }

  // ── backend → bundle edges (n:m via mcp_backend_bundles) ───────
  if (await tableExists(pool, 'mcp_backend_bundles')) {
    const { rows } = await pool.query<{ backend_id: number; bundle_id: number }>(
      `SELECT backend_id, bundle_id FROM mcp_backend_bundles`,
    );
    for (const e of rows) {
      edges.push({
        data: {
          id: `backend:${e.backend_id}->bundle:${e.bundle_id}`,
          source: `backend:${e.backend_id}`,
          target: `bundle:${e.bundle_id}`,
          type: 'backend-in-bundle',
        },
      });
    }
  }

  // ── Tools (optional — opt-in via ?tools=true) ──────────────────
  //
  // Only tools that some composite *actually permits* (allow ∧ ¬deny) are
  // included. Orphan tools — enabled in mcp_tools but blocked or never
  // matched by any composite — would just be visual noise on the graph.
  if (includeTools && await tableExists(pool, 'mcp_tools')) {
    const { rows: toolRows } = await pool.query<{
      id: number; name: string; backend: string | null; category: string | null; enabled: boolean;
    }>(`SELECT id, name, backend, category, enabled FROM mcp_tools WHERE enabled = true`);
    const toolById = new Map(toolRows.map((t) => [t.id, t]));

    // Build the bundle → tool list once. Used both for the bundle membership
    // edges and for resolving "which tools are reachable through which composite".
    const toolsByBundle = new Map<number, number[]>();
    if (await tableExists(pool, 'mcp_tool_bundles')) {
      const { rows } = await pool.query<{ tool_id: number; bundle_id: number }>(
        `SELECT tool_id, bundle_id FROM mcp_tool_bundles`,
      );
      for (const r of rows) {
        if (!toolById.has(r.tool_id)) continue; // disabled tool
        let arr = toolsByBundle.get(r.bundle_id);
        if (!arr) { arr = []; toolsByBundle.set(r.bundle_id, arr); }
        arr.push(r.tool_id);
      }
    }

    // For each composite, compute its effective allowed tool-id set.
    // A tool is "allowed" if it lives in one of the composite's included
    // bundles AND survives the allow/deny pattern filter on its name.
    const allowedToolIds = new Set<number>();
    for (const n of nodes) {
      if (n.data.type !== 'composite') continue;
      const includedBundleIds = (n.data['included_bundle_ids'] as number[] | undefined) ?? [];
      const allow = (n.data['tool_allow_patterns'] as string[] | undefined) ?? [];
      const deny  = (n.data['tool_deny_patterns']  as string[] | undefined) ?? [];

      // Empty included_bundle_ids = wildcard (all bundles). To stay
      // conservative we still require the allow/deny filter to pass.
      const bundleIds = includedBundleIds.length > 0
        ? includedBundleIds
        : Array.from(toolsByBundle.keys());

      for (const bid of bundleIds) {
        for (const tid of toolsByBundle.get(bid) ?? []) {
          const tool = toolById.get(tid);
          if (!tool) continue;
          if (isToolAllowedByPatterns(tool.name, allow, deny)) {
            allowedToolIds.add(tid);
          }
        }
      }
    }

    // Backend name → id lookup for the tool→backend edge
    const backendIdByName = new Map<string, number>();
    if (await tableExists(pool, 'mcp_backends')) {
      const { rows } = await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM mcp_backends`,
      );
      for (const b of rows) backendIdByName.set(b.name, b.id);
    }

    // Reverse-index: for each tool, which bundles does it belong to?
    // Used as a fallback edge when the tool has no real backend node
    // (builtin: / custom: prefix) — otherwise the tool would float orphaned.
    const bundlesByTool = new Map<number, number[]>();
    for (const [bid, toolIds] of toolsByBundle) {
      for (const tid of toolIds) {
        let arr = bundlesByTool.get(tid);
        if (!arr) { arr = []; bundlesByTool.set(tid, arr); }
        arr.push(bid);
      }
    }

    // Emit allowed tool nodes + their tool→backend edges.
    // The data flow is intentionally tool → backend → bundle (not
    // tool → bundle directly). Only fall back to tool → bundle when the
    // tool's backend string doesn't resolve to a real backend node —
    // i.e. for `builtin:*` and `custom:*` internal handlers.
    for (const tid of allowedToolIds) {
      const t = toolById.get(tid);
      if (!t) continue;
      nodes.push({
        data: {
          id: `tool:${t.id}`,
          label: t.name,
          type: 'tool',
          category: t.category,
          backend: t.backend,
          enabled: t.enabled,
        },
      });
      stats.tools += 1;

      // mcp_tools.backend conventions:
      //   "<name>"           → real mcp_backends row (e.g. "gitea")
      //   "custom:<name>"    → real mcp_backends row, prefixed (REST-API tool)
      //   "builtin:<key>"    → internal handler (k8s/grafana/opensearch SDK), no backend row
      //   "postgresql" / "opensearch" / "http" → builtin transport, no backend row
      const BUILTIN_TRANSPORTS = new Set(['postgresql', 'opensearch', 'http']);
      let backendName: string | null = null;
      if (t.backend) {
        if (t.backend.startsWith('custom:')) {
          backendName = t.backend.slice('custom:'.length);
        } else if (t.backend.startsWith('builtin:') || BUILTIN_TRANSPORTS.has(t.backend)) {
          backendName = null;
        } else {
          backendName = t.backend;
        }
      }
      const resolvedBackendId = backendName ? backendIdByName.get(backendName) : undefined;

      if (resolvedBackendId !== undefined) {
        edges.push({
          data: {
            id: `tool:${t.id}->backend:${resolvedBackendId}`,
            source: `tool:${t.id}`,
            target: `backend:${resolvedBackendId}`,
            type: 'tool-on-backend',
          },
        });
      } else {
        // No real backend (builtin/custom or unknown name) — attach
        // directly to each bundle that owns the tool so it isn't orphaned.
        for (const bid of bundlesByTool.get(tid) ?? []) {
          edges.push({
            data: {
              id: `tool:${tid}->bundle:${bid}`,
              source: `tool:${tid}`,
              target: `bundle:${bid}`,
              type: 'tool-in-bundle',
            },
          });
        }
      }
    }
  }

  stats.edges = edges.length;
  return { nodes, edges, stats };
}

/**
 * Build a subgraph around a single agent — the agent itself plus its
 * direct neighbours (RAGs, model, composite). Used by the mini-graph on
 * the agent detail page.
 */
export async function buildAgentTopology(pool: pg.Pool, agentId: number): Promise<{ nodes: CyNode[]; edges: CyEdge[] }> {
  const full = await buildTopology(pool);
  const focus = `agent:${agentId}`;
  // Keep the focus node and anything reachable via one edge
  const keepIds = new Set<string>([focus]);
  for (const e of full.edges) {
    if (e.data.source === focus) keepIds.add(e.data.target);
    if (e.data.target === focus) keepIds.add(e.data.source);
  }
  const nodes = full.nodes.filter((n) => keepIds.has(n.data.id));
  const edges = full.edges.filter((e) => keepIds.has(e.data.source) && keepIds.has(e.data.target));
  return { nodes, edges };
}

// ── Route handlers ─────────────────────────────────────────────

export function handleTopologyGet(pool: pg.Pool) {
  return async (req: Request, res: Response): Promise<void> => {
    const includeTools = req.query['tools'] === 'true' || req.query['tools'] === '1';
    try {
      const data = await buildTopology(pool, { includeTools });
      res.json(data);
    } catch (err) {
      logger.error({ err }, 'Failed to build topology');
      res.status(500).json({ error: 'Failed to build topology' });
    }
  };
}

export function handleAgentTopologyGet(pool: pg.Pool) {
  return async (req: Request, res: Response): Promise<void> => {
    const rawId = req.params['id'];
    const id = parseInt(typeof rawId === 'string' ? rawId : '0', 10);
    if (!id) { res.status(400).json({ error: 'Invalid agent id' }); return; }
    try {
      const data = await buildAgentTopology(pool, id);
      res.json(data);
    } catch (err) {
      logger.error({ err, id }, 'Failed to build agent topology');
      res.status(500).json({ error: 'Failed to build agent topology' });
    }
  };
}
