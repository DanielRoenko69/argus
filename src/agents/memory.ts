/**
 * Agent Memory — embed, store, and retrieve cross-session memories via pgvector.
 *
 * Memory taxonomy (memory_type column)
 * ------------------------------------
 *   working     — session-scoped scratch; auto-expired with the session
 *   episodic    — time-bound event ("on 2026-05 user restarted pod X"); has valid_until
 *   semantic    — persistent fact ("user is IT-Ops Engineer at Argus"); no expiry by default
 *   procedural  — preference / how-to ("user prefers kubectl output over JSON")
 *
 * Retrieval boosts kinds with different weights so episodic and working
 * memories outrank stale semantic ones at equal cosine similarity. Stale
 * entries (valid_until in the past) are filtered out in SQL.
 */
import pg from 'pg';
import { createHash } from 'crypto';
import { logger } from '../lib/logger.js';
import { getRedisClient } from '../lib/redis.js';
import type { ContentPart } from './types.js';
import { chatCompletion, createEmbedding, firstText } from '../llm/client.js';
import type { LlmTarget } from '../llm/types.js';

const EMBED_MODEL = process.env['EMBEDDING_MODEL'] ?? 'text-embedding-3-large';
const TOP_K       = 5;
const SIMILARITY_THRESHOLD = 0.72; // cosine similarity (0-1); tune down if too few results

/**
 * Automatic cross-session memory is intentionally opt-in because it needs a
 * separate embedding provider. Subscription runtimes such as Codex and Claude
 * Code provide chat/tool execution, but no embedding endpoint. Keeping this
 * decision separate prevents a successful subscription turn from triggering a
 * second, implicitly configured provider call after the response completed.
 *
 * Explicit workflow memory nodes are not governed by this switch: operators
 * who use those nodes receive the normal provider configuration error instead
 * of a silent no-op.
 */
export function isAutomaticAgentMemoryEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env['ARGUS_AGENT_MEMORY_AUTO_ENABLED'] === 'true';
}

// Multipliers applied to raw cosine similarity per memory kind.
// > 1.0 boosts (current session > recent events > stable facts > preferences).
const KIND_WEIGHTS: Record<string, number> = {
  working:    1.20,
  episodic:   1.00,
  semantic:   0.90,
  procedural: 0.85,
};

export type MemoryKind = 'working' | 'episodic' | 'semantic' | 'procedural';

export interface AgentMemory {
  id:          number;
  content:     string;
  memory_type: string;
  importance:  number;
  created_at:  string;
  similarity:  number;
}

/** Call the configured direct embedding provider and return the vector. Redis-cached 24h. */
export async function embedText(text: string): Promise<number[]> {
  const redis = getRedisClient();
  const cacheKey = redis
    ? `embed:${createHash('sha256').update(`${EMBED_MODEL}:${text}`).digest('hex')}`
    : null;

  if (redis && cacheKey) {
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) return JSON.parse(hit) as number[];
  }

  const data = await createEmbedding(EMBED_MODEL, text);
  const embedding = data.data?.[0]?.embedding;
  // audit A3: validate the shape — an error-shaped 200 or a wrong-dim model
  // would otherwise yield undefined/garbage that fails deep inside the ::vector
  // insert and gets silently swallowed by callers (silent memory loss).
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`Embedding API returned no/malformed vector for model ${EMBED_MODEL}`);
  }

  if (redis && cacheKey) {
    redis.setex(cacheKey, 86_400, JSON.stringify(embedding)).catch(() => {});
  }
  return embedding;
}

// Similarity threshold above which a new memory is considered to UPDATE an existing one
// rather than being inserted as a new entry (Mem0-style contradiction handling).
const CONTRADICTION_THRESHOLD = 0.88;

/**
 * Store a single memory entry — with Mem0-style contradiction handling.
 * If an existing memory for this agent is very similar (≥ 0.88), the new fact
 * replaces it instead of being appended. This prevents memory drift over time.
 *
 * `kind` chooses the memory type (defaults to 'semantic' for backwards compat
 * with old callers that used the un-typed string 'fact'). `validDays` is only
 * meaningful for kind='episodic' — semantic and procedural facts have no
 * expiry by default, working memories are pruned with the session.
 */
export async function storeMemory(
  pool:       pg.Pool,
  agentId:    number,
  sessionId:  string,
  content:    string,
  kindOrLegacy: MemoryKind | string = 'semantic',
  importance:  number = 0.5,
  validDays:   number | null = null,
): Promise<void> {
  // Translate legacy 'fact' → 'semantic' for old call sites
  const kind: MemoryKind = (kindOrLegacy === 'fact' ? 'semantic' : kindOrLegacy) as MemoryKind;
  const validUntil = validDays !== null
    ? new Date(Date.now() + validDays * 86_400_000).toISOString()
    : null;

  try {
    const embedding = await embedText(content);
    const embeddingJson = JSON.stringify(embedding);

    // Check for near-duplicate / contradicting memory of the same kind
    const { rows: similar } = await pool.query<{ id: number; similarity: number }>(
      `SELECT id, (1 - (embedding <=> $1::vector))::float AS similarity
       FROM mcp_agent_memory
       WHERE agent_id = $2
         AND memory_type = $3
         AND (1 - (embedding <=> $1::vector)) >= $4
       ORDER BY similarity DESC
       LIMIT 1`,
      [embeddingJson, agentId, kind, CONTRADICTION_THRESHOLD],
    );

    if (similar.length > 0) {
      // UPDATE existing memory — new fact supersedes the old one.
      // valid_from gets bumped to now() so re-mention refreshes the validity window.
      await pool.query(
        `UPDATE mcp_agent_memory
         SET content = $1, embedding = $2::vector, importance = $3,
             session_id = $4, last_accessed_at = now(),
             valid_from = now(), valid_until = $5
         WHERE id = $6`,
        [content, embeddingJson, importance, sessionId, validUntil, similar[0].id],
      );
      logger.debug({ agentId, id: similar[0].id, kind, similarity: similar[0].similarity },
        'Memory updated (contradiction/supersede)');
    } else {
      await pool.query(
        `INSERT INTO mcp_agent_memory
           (agent_id, session_id, content, embedding, memory_type, importance, valid_until)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7)`,
        [agentId, sessionId, content, embeddingJson, kind, importance, validUntil],
      );
    }
  } catch (err) {
    logger.warn({ err }, 'storeMemory: skipping');
  }
}

/**
 * Retrieve the most relevant memories for a query.
 *
 * Filters out expired episodic memories (valid_until in the past) at the SQL
 * level. Working memories are only returned for their own session.
 *
 * After raw cosine ranking, kind-weights re-score so a recent episodic
 * memory will outrank a slightly more similar but generic semantic fact.
 * We over-fetch by 3× topK to give the boost room to reorder.
 *
 * Returns [] on any error so memory failures never break the agent loop.
 */
export async function retrieveMemories(
  pool:    pg.Pool,
  agentId: number,
  query:   string,
  topK     = TOP_K,
  sessionId: string | null = null,
): Promise<AgentMemory[]> {
  try {
    const embedding = await embedText(query);
    const { rows } = await pool.query<AgentMemory>(
      `SELECT id, content, memory_type, importance, created_at,
              (1 - (embedding <=> $1::vector))::float AS similarity
       FROM mcp_agent_memory
       WHERE agent_id = $2
         AND (valid_until IS NULL OR valid_until > NOW())
         AND (memory_type <> 'working' OR session_id = $3)
         AND (1 - (embedding <=> $1::vector)) > $4
       ORDER BY similarity DESC
       LIMIT $5`,
      [JSON.stringify(embedding), agentId, sessionId, SIMILARITY_THRESHOLD, topK * 3],
    );

    // Re-rank by kind-weighted similarity so episodic > semantic at parity.
    const reranked = rows
      .map((r) => {
        const weight = KIND_WEIGHTS[r.memory_type] ?? 1.0;
        return { row: r, score: r.similarity * weight };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.row);

    if (reranked.length > 0) {
      // Fire-and-forget access tracking
      pool.query(
        `UPDATE mcp_agent_memory
         SET last_accessed_at = now(), access_count = access_count + 1
         WHERE id = ANY($1)`,
        [reranked.map(r => r.id)],
      ).catch(() => {});
    }
    return reranked;
  } catch (err) {
    logger.warn({ err }, 'retrieveMemories: skipping');
    return [];
  }
}

/** Format memories into an XML block for injection into messages. */
export function formatMemoryContext(memories: AgentMemory[]): string {
  if (memories.length === 0) return '';
  const items = memories.map(m => `- ${m.content}`).join('\n');
  return `<agent_memory>\n${items}\n</agent_memory>`;
}

/**
 * After a completed turn, use the LLM to extract key facts and store them.
 * Called fire-and-forget — never awaited by the main agent loop.
 */
export async function extractAndStoreMemories(
  pool:      pg.Pool,
  agentId:   number,
  sessionId: string,
  messages:  Array<{ role: string; content: string | ContentPart[] | null }>,
  llmUrl:    string,
  llmKey:    string,
  model:     string,
  llmTargetOverride?: LlmTarget,
): Promise<void> {
  const conversation = messages
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content && typeof m.content === 'string')
    .map(m => `${m.role}: ${m.content as string}`)
    .join('\n')
    .slice(0, 4000); // cap token usage

  if (!conversation) return;

  try {
    const data = await chatCompletion({
      model,
      messages: [
        {
          role:    'system',
          content:
            'Extract 3-5 memorable facts from this conversation that would help future interactions.\n' +
            'Classify EACH fact as one of:\n' +
            '  - "episodic"   : a time-bound event ("on YYYY-MM-DD user did X")\n' +
            '  - "semantic"   : a stable fact about the user/context ("user works at X")\n' +
            '  - "procedural" : a preference about HOW to do things ("prefers Y over Z")\n' +
            'For episodic facts, include "valid_days" (default 90).\n' +
            'Return ONLY a JSON object:\n' +
            '  {"facts":[{"content":"...","kind":"episodic|semantic|procedural","importance":0.5,"valid_days":90}]}\n' +
            'No prose, no markdown fences.',
        },
        { role: 'user', content: conversation },
      ],
      max_tokens: 500,
      temperature: 0,
    }, {
      apiKeyOverride: llmKey || undefined,
      targetOverride: llmTargetOverride,
    });
    const content = firstText(data) || '{}';

    interface ExtractedFact {
      content?: string;
      kind?: string;
      importance?: number;
      valid_days?: number;
    }
    interface ExtractResult {
      facts?: ExtractedFact[];
    }

    let parsed: ExtractResult;
    try { parsed = JSON.parse(content) as ExtractResult; } catch { return; }
    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];

    await Promise.all(
      facts
        .filter((f): f is Required<Pick<ExtractedFact, 'content'>> & ExtractedFact =>
          typeof f === 'object' && f !== null
          && typeof f.content === 'string'
          && f.content.trim().length > 0,
        )
        .map((f) => {
          const kind: MemoryKind =
            f.kind === 'episodic' || f.kind === 'semantic' || f.kind === 'procedural'
              ? f.kind
              : 'semantic';
          const importance = typeof f.importance === 'number' ? f.importance : 0.6;
          // Only episodic gets a TTL; semantic/procedural live indefinitely
          // until the compactor or a contradicting fact replaces them.
          const validDays = kind === 'episodic'
            ? (typeof f.valid_days === 'number' && f.valid_days > 0 ? f.valid_days : 90)
            : null;
          return storeMemory(pool, agentId, sessionId, f.content.trim(), kind, importance, validDays);
        }),
    );
    logger.debug({ agentId, count: facts.length }, 'Memories extracted and stored');
  } catch (err) {
    logger.warn({ err }, 'extractAndStoreMemories: skipping');
  }
}

/**
 * Prune expired memories. Runs as part of the 6h memory job.
 *
 * Removes:
 *   - episodic memories whose valid_until is in the past
 *   - working memories older than 24h (a stale browser tab or crashed
 *     agent can leave these dangling — we don't get a session-close hook
 *     for every termination path)
 *
 * Returns the number of rows deleted.
 */
export async function pruneExpiredMemories(pool: pg.Pool): Promise<number> {
  try {
    const r1 = await pool.query(
      `DELETE FROM mcp_agent_memory
       WHERE memory_type = 'episodic' AND valid_until IS NOT NULL AND valid_until < NOW()`,
    );
    const r2 = await pool.query(
      `DELETE FROM mcp_agent_memory
       WHERE memory_type = 'working' AND created_at < NOW() - INTERVAL '24 hours'`,
    );
    const total = (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    if (total > 0) {
      logger.info({ episodic_expired: r1.rowCount, working_stale: r2.rowCount }, 'pruneExpiredMemories: rows deleted');
    }
    return total;
  } catch (err) {
    logger.warn({ err }, 'pruneExpiredMemories: failed');
    return 0;
  }
}

/**
 * Consolidation job — merges near-duplicate memories (similarity > 0.9) per agent.
 * Runs as a background job every 6h. Reduces memory table bloat and improves retrieval quality.
 */
export async function consolidateMemories(pool: pg.Pool, llmUrl: string, llmKey: string, model: string): Promise<void> {
  try {
    const { rows: agents } = await pool.query<{ agent_id: number; count: string }>(
      `SELECT agent_id, COUNT(*) as count FROM mcp_agent_memory GROUP BY agent_id HAVING COUNT(*) >= 4`,
    );

    let merged = 0;
    for (const { agent_id } of agents) {
      // Find pairs with similarity > 0.9 (sequential scan is fine for small tables)
      const { rows: pairs } = await pool.query<{
        id_a: number; id_b: number; content_a: string; content_b: string; similarity: number;
      }>(
        `SELECT a.id AS id_a, b.id AS id_b, a.content AS content_a, b.content AS content_b,
                (1 - (a.embedding <=> b.embedding))::float AS similarity
         FROM mcp_agent_memory a
         JOIN mcp_agent_memory b ON b.agent_id = a.agent_id AND b.id > a.id
         WHERE a.agent_id = $1
           AND (1 - (a.embedding <=> b.embedding)) > 0.9
         ORDER BY similarity DESC
         LIMIT 10`,
        [agent_id],
      );

      for (const pair of pairs) {
        // Verify both still exist (earlier merge in this loop may have deleted them)
        const { rows: existing } = await pool.query(
          `SELECT id FROM mcp_agent_memory WHERE id = ANY($1)`,
          [[pair.id_a, pair.id_b]],
        );
        if (existing.length < 2) continue;

        // Ask LLM to merge the two facts into one
        const mergeData = await chatCompletion({
          model,
          messages: [
            { role: 'system', content: 'Merge these two similar facts into one concise sentence. Return ONLY the merged fact, nothing else.' },
            { role: 'user', content: `Fact A: ${pair.content_a}\nFact B: ${pair.content_b}` },
          ],
          max_tokens: 100,
          temperature: 0,
        }, { apiKeyOverride: llmKey || undefined, timeoutMs: 8_000 }).catch(() => null);

        if (!mergeData) continue;
        const merged_content = firstText(mergeData).trim();
        if (!merged_content) continue;

        // Delete originals and insert merged
        await pool.query(`DELETE FROM mcp_agent_memory WHERE id = ANY($1)`, [[pair.id_a, pair.id_b]]);
        await storeMemory(pool, agent_id, 'consolidated', merged_content, 'fact', 0.8);
        merged++;
      }
    }

    if (merged > 0) logger.info({ merged }, 'Memory consolidation complete');
  } catch (err) {
    logger.warn({ err }, 'consolidateMemories: failed');
  }
}
