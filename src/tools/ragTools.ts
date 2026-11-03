/**
 * Agentic RAG — exposes each RAG index assigned to an agent as a tool the
 * agent can call on demand. Complements the auto-injection of RAG context
 * (the agent gets seed context AND can search further as needed).
 *
 * Tool name convention: `rag_<index-name>` (sanitized for Anthropic later).
 */

import type pg from 'pg';
import { formatRagContext } from '../agents/ragClient.js';
import { searchRagIndex } from '../agents/ragSearch.js';
import type { RagIndex } from '../agents/types.js';
import type { ToolResult } from './toolRunner.js';
import { logger } from '../lib/logger.js';

export const RAG_TOOL_PREFIX = 'rag_';

export interface RagToolDef {
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

function buildToolName(indexName: string): string {
  // Index names are already kebab-case slugs, but defend against odd chars.
  const safe = indexName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${RAG_TOOL_PREFIX}${safe}`;
}

function buildDescription(idx: RagIndex): string {
  const base = idx.description?.trim() || `Knowledge base "${idx.label}"`;
  return (
    `Search the "${idx.label}" knowledge base via vector similarity.\n` +
    `${base}\n` +
    `Use when: you need facts/procedures/docs from this specific source. ` +
    `Returns top-${idx.top_k} most relevant snippets with citations. ` +
    `Be specific in queries — use natural-language sentences (not single keywords).`
  );
}

/**
 * Fetch the RAG indexes assigned to this agent (priority-ordered) and produce
 * one tool definition per index.
 */
export async function getAgentRagTools(pool: pg.Pool, agentId: number): Promise<RagToolDef[]> {
  const { rows } = await pool.query<RagIndex>(
    `SELECT r.* FROM mcp_rag_indexes r
     JOIN mcp_agent_rag_indexes ar ON ar.rag_index_id = r.id
     WHERE ar.agent_id = $1 AND r.enabled = true
     ORDER BY ar.priority, r.label`,
    [agentId],
  );

  return rows.map((idx) => ({
    type: 'function' as const,
    function: {
      name: buildToolName(idx.name),
      description: buildDescription(idx),
      parameters: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Natural-language search query. Be specific.' },
          top_k: { type: 'number', description: `How many results (default ${idx.top_k}, max 10).` },
        },
        required: ['query'],
      },
    },
  }));
}

/** Find the RAG index by tool-name reverse-lookup (slug after the rag_ prefix). */
async function resolveIndex(pool: pg.Pool, toolName: string): Promise<RagIndex | null> {
  const indexSlug = toolName.slice(RAG_TOOL_PREFIX.length);
  // Search by `name` column matching the sanitized slug. Since buildToolName
  // is deterministic, we reverse it by trying both raw and reverse-sanitized forms.
  const { rows } = await pool.query<RagIndex>(
    `SELECT * FROM mcp_rag_indexes
     WHERE enabled = true
       AND (name = $1 OR regexp_replace(name, '[^a-zA-Z0-9_-]', '_', 'g') = $1)
     LIMIT 1`,
    [indexSlug],
  );
  return rows[0] ?? null;
}

/**
 * Execute a RAG tool call. Top-K is clamped to 10 to keep responses sane.
 */
export async function executeRagTool(
  pool: pg.Pool,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const idx = await resolveIndex(pool, toolName);
  if (!idx) {
    return {
      content: [{ type: 'text', text: `Unknown RAG tool: ${toolName}` }],
      isError: true,
    };
  }

  const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
  if (!query) {
    return {
      content: [{ type: 'text', text: 'query argument is required (non-empty string)' }],
      isError: true,
    };
  }

  const requestedK = typeof args['top_k'] === 'number' ? args['top_k'] : undefined;
  const effectiveIdx: RagIndex = requestedK
    ? { ...idx, top_k: Math.max(1, Math.min(10, Math.floor(requestedK))) }
    : idx;

  try {
    const results = await searchRagIndex(effectiveIdx, query, pool);
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No results in "${idx.label}" for: ${query}` }] };
    }
    const text = formatRagContext(results, idx.label);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, tool: toolName, query }, 'RAG tool error');
    return {
      content: [{ type: 'text', text: `RAG search failed: ${msg}` }],
      isError: true,
    };
  }
}
