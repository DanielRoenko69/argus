/**
 * Knowledge search tool â€” semantic search over Qdrant collections.
 *
 * Embeds the query via the configured direct LLM provider, then queries Qdrant for the
 * most relevant document chunks. Silently skips if QDRANT_URL is not set.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { createHash } from 'crypto';
import { getRedisClient } from '../../lib/redis.js';
import { createEmbedding } from '../../llm/client.js';

const EMBED_MODEL = process.env['EMBEDDING_MODEL']  ?? 'text-embedding-3-large';
const EMBED_CACHE_TTL_SEC = 86_400;   // 24h — embeddings are deterministic per (model,text)

interface QdrantHit {
  id:      string | number;
  score:   number;
  payload: Record<string, unknown>;
}

async function embedQuery(query: string): Promise<number[]> {
  // Cache embeddings: deterministic per (model, text), saves ~30-50 %
  // upstream-token cost on RAG-heavy workloads.
  const redis = getRedisClient();
  const cacheKey = redis
    ? `embed:${createHash('sha256').update(`${EMBED_MODEL}:${query}`).digest('hex')}`
    : null;
  if (redis && cacheKey) {
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) return JSON.parse(hit) as number[];
  }

  const data = await createEmbedding(EMBED_MODEL, query);
  const embedding = data.data[0]?.embedding;
  if (!embedding) throw new Error(`Embedding API returned no vector for ${EMBED_MODEL}`);

  if (redis && cacheKey) {
    redis.setex(cacheKey, EMBED_CACHE_TTL_SEC, JSON.stringify(embedding)).catch(() => {});
  }
  return embedding;
}

async function searchQdrant(
  qdrantUrl: string,
  qdrantApiKey: string,
  collection: string,
  vector: number[],
  topK: number,
): Promise<QdrantHit[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (qdrantApiKey) headers['api-key'] = qdrantApiKey;

  const res = await fetch(`${qdrantUrl}/collections/${collection}/points/search`, {
    method:  'POST',
    headers,
    body: JSON.stringify({ vector, limit: topK, with_payload: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Qdrant search HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { result: QdrantHit[] };
  return data.result ?? [];
}

function formatHits(hits: QdrantHit[]): string {
  if (hits.length === 0) return 'No relevant documents found.';
  return hits.map((h, i) => {
    const p = h.payload;
    const title  = typeof p['title']  === 'string' ? p['title']  : '';
    const text   = typeof p['text']   === 'string' ? p['text']   : '';
    const source = typeof p['source'] === 'string' ? p['source'] : '';
    const url    = typeof p['url']    === 'string' ? p['url']    : '';
    const score  = h.score.toFixed(3);

    return [
      `[${i + 1}] ${title || '(no title)'} (score: ${score})`,
      source ? `Source: ${source}` : '',
      url    ? `URL: ${url}`       : '',
      text   ? `\n${text.slice(0, 600)}${text.length > 600 ? 'â€¦' : ''}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');
}

export function registerKnowledgeTools(server: McpServer, config: Config): void {
  if (!config.qdrantUrl) {
    logger.debug('QDRANT_URL not set â€” search_knowledge tool not registered');
    return;
  }

  server.tool(
    'search_knowledge',
    'Semantic search over the knowledge base (runbooks, Confluence pages, documentation). ' +
    'Returns the most relevant document chunks for a natural-language query. ' +
    'Use this to look up procedures, architecture docs, or incident runbooks.',
    {
      query:      z.string().min(1).describe('Natural-language search query'),
      collection: z.string().default('knowledge').describe('Qdrant collection name (default: knowledge)'),
      top_k:      z.number().int().min(1).max(20).default(5).describe('Number of results to return (default: 5)'),
    },
    async ({ query, collection, top_k }) => {
      try {
        const vector = await embedQuery(query);
        const hits   = await searchQdrant(config.qdrantUrl, config.qdrantApiKey, collection, vector, top_k);
        return { content: [{ type: 'text', text: formatHits(hits) }] };
      } catch (err) {
        logger.warn({ err }, 'search_knowledge: error');
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Knowledge search failed: ${msg}` }] };
      }
    },
  );

  logger.info({ qdrantUrl: config.qdrantUrl }, 'search_knowledge tool registered');
}
