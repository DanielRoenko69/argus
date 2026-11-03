/**
 * RAG reranker — sends candidate documents through a cross-encoder model
 * and returns them re-sorted by query-document relevance.
 *
 * Three providers supported:
 *   - tei:    self-hosted HuggingFace Text Embeddings Inference (recommended,
 *             on-prem, default model BAAI/bge-reranker-v2-m3 multilingual)
 *   - cohere: rerank-multilingual-v3.0 (cloud, good DE+EN, paid after free tier)
 *   - voyage: rerank-2 (cloud, code/technical-focused)
 *
 * Configuration:
 *   RAG_RERANKER_PROVIDER  = none | tei | cohere | voyage   (default: none)
 *   TEI_RERANKER_URL       = http://tei-reranker            (Docker service name)
 *   COHERE_API_KEY         = ...
 *   VOYAGE_API_KEY         = ...
 *   RAG_RERANKER_COHERE_MODEL = rerank-multilingual-v3.0    (override)
 *   RAG_RERANKER_VOYAGE_MODEL = rerank-2                    (override)
 *
 * If the configured provider is unavailable, rerank() returns null and the
 * caller falls back to the original vector-search ranking — fully graceful,
 * never blocks RAG.
 */

import { logger } from '../lib/logger.js';

const PROVIDER     = (process.env['RAG_RERANKER_PROVIDER'] ?? 'none').toLowerCase();
const TEI_URL      = (process.env['TEI_RERANKER_URL'] ?? 'http://tei-reranker').replace(/\/$/, '');
const COHERE_KEY   = process.env['COHERE_API_KEY'] ?? '';
const VOYAGE_KEY   = process.env['VOYAGE_API_KEY'] ?? '';
const COHERE_MODEL = process.env['RAG_RERANKER_COHERE_MODEL'] ?? 'rerank-multilingual-v3.0';
const VOYAGE_MODEL = process.env['RAG_RERANKER_VOYAGE_MODEL'] ?? 'rerank-2';

export interface RerankResult {
  /** index back into the original `documents` array */
  index: number;
  /** 0..1 relevance score from the cross-encoder */
  relevance_score: number;
}

export function isRerankerEnabled(): boolean {
  if (PROVIDER === 'tei')    return TEI_URL.length > 0;
  if (PROVIDER === 'cohere') return COHERE_KEY.length > 0;
  if (PROVIDER === 'voyage') return VOYAGE_KEY.length > 0;
  return false;
}

/**
 * Rerank `documents` against `query`. Returns null if the configured provider
 * is unavailable or the call fails — caller should keep the original order.
 */
export async function rerank(
  query: string,
  documents: string[],
  topN: number,
): Promise<RerankResult[] | null> {
  if (documents.length === 0) return [];
  if (PROVIDER === 'tei')    return rerankTei(query, documents, topN);
  if (PROVIDER === 'cohere') return rerankCohere(query, documents, topN);
  if (PROVIDER === 'voyage') return rerankVoyage(query, documents, topN);
  return null;
}

// ── TEI (self-hosted HuggingFace) ─────────────────────────────────

// bge-reranker-base has a 512-token limit (query + document combined).
// Code chunks tokenize at ~2 chars/token (vs ~4 for prose), so we use a
// conservative 800-char limit → ~400 tokens max, leaving headroom for the query.
const TEI_MAX_DOC_CHARS = 800;

async function rerankTei(query: string, documents: string[], topN: number): Promise<RerankResult[] | null> {
  try {
    const truncated = documents.map(d => d.length > TEI_MAX_DOC_CHARS ? d.slice(0, TEI_MAX_DOC_CHARS) + '…' : d);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const res = await fetch(`${TEI_URL}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, texts: truncated, raw_scores: false }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: text.slice(0, 200) }, 'TEI rerank HTTP error');
      return null;
    }
    const data = await res.json() as Array<{ index: number; score: number }>;
    // TEI returns sorted descending by score; keep top_n
    return data
      .slice(0, topN)
      .map((r) => ({ index: r.index, relevance_score: r.score }));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'TEI rerank failed');
    return null;
  }
}

// ── Cohere ────────────────────────────────────────────────────────

async function rerankCohere(query: string, documents: string[], topN: number): Promise<RerankResult[] | null> {
  if (!COHERE_KEY) return null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch('https://api.cohere.com/v2/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${COHERE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:     COHERE_MODEL,
        query,
        documents,
        top_n:     Math.min(topN, documents.length),
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: text.slice(0, 200) }, 'Cohere rerank HTTP error');
      return null;
    }
    const data = await res.json() as {
      results?: Array<{ index: number; relevance_score: number }>;
    };
    return data.results ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Cohere rerank failed');
    return null;
  }
}

// ── Voyage ────────────────────────────────────────────────────────

async function rerankVoyage(query: string, documents: string[], topN: number): Promise<RerankResult[] | null> {
  if (!VOYAGE_KEY) return null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:      VOYAGE_MODEL,
        query,
        documents,
        top_k:      Math.min(topN, documents.length),
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: text.slice(0, 200) }, 'Voyage rerank HTTP error');
      return null;
    }
    const data = await res.json() as {
      data?: Array<{ index: number; relevance_score: number }>;
    };
    return data.data ?? null;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Voyage rerank failed');
    return null;
  }
}
