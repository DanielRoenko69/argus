/**
 * Unified RAG search entry point — wraps the provider-specific search
 * through the Knowledge provider registry with optional reranking.
 *
 * If reranking is enabled, fetches up to 3× the requested top_k as candidates
 * and passes them through the cross-encoder. If disabled or rerank fails,
 * returns the underlying vector-search results unchanged.
 *
 * Langfuse tracing: when LANGFUSE_PUBLIC_KEY is set, each search call creates
 * a trace with two spans — "retrieve" (before reranking) and "rerank" (after)
 * so you can see exactly what the reranker changed.
 */

import { trace, SpanStatusCode } from '@opentelemetry/api';
import type pg from 'pg';
import type { RagIndex } from './types.js';
import type { RagResult } from './ragClient.js';
import { searchRagProvider } from './ragProviderRegistry.js';
import { rerank, isRerankerEnabled } from './reranker.js';
import { logger } from '../lib/logger.js';

const tracer = trace.getTracer('ai-ops-rag');

const CANDIDATE_MULTIPLIER = 3;
const MAX_CANDIDATES       = 25;

function searchTimeoutMs(): number {
  const configured = Number.parseInt(process.env['RAG_SEARCH_TIMEOUT_MS'] ?? '30000', 10);
  return Number.isFinite(configured) ? Math.max(1_000, Math.min(120_000, configured)) : 30_000;
}

// ── Langfuse helpers ───────────────────────────────────────────────

const LANGFUSE_PUB  = process.env['LANGFUSE_PUBLIC_KEY'] ?? '';
const LANGFUSE_SEC  = process.env['LANGFUSE_SECRET_KEY'] ?? '';
const LANGFUSE_HOST = (process.env['LANGFUSE_HOST'] ?? 'http://langfuse:3100').replace(/\/+$/, '');
const langfuseEnabled = !!(LANGFUSE_PUB && LANGFUSE_SEC && !LANGFUSE_PUB.includes('changeme'));

function langfuseAuth(): string {
  return 'Basic ' + Buffer.from(`${LANGFUSE_PUB}:${LANGFUSE_SEC}`).toString('base64');
}

async function lfPost(path: string, body: unknown): Promise<void> {
  if (!langfuseEnabled) return;
  await fetch(`${LANGFUSE_HOST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: langfuseAuth() },
    body: JSON.stringify(body),
  }).catch((err) => logger.debug({ err }, 'Langfuse post failed (non-fatal)'));
}

function toResultSummary(results: RagResult[]): Array<{ rank: number; id: string; score: number; preview: string }> {
  return results.map((r, i) => ({
    rank:    i + 1,
    id:      r.id,
    score:   Math.round(r.score * 1000) / 1000,
    preview: (r.content ?? '').slice(0, 120) + (r.content?.length ?? 0 > 120 ? '…' : ''),
  }));
}

// ── Main search function ───────────────────────────────────────────

export async function searchRagIndex(idx: RagIndex, query: string, pool?: pg.Pool): Promise<RagResult[]> {
  const useRerank = isRerankerEnabled();
  const desiredK  = idx.top_k;
  const fetchK    = useRerank ? Math.min(desiredK * CANDIDATE_MULTIPLIER, MAX_CANDIDATES) : desiredK;

  // HyDE: per-Index opt-in. Generate a hypothetical answer doc, then embed
  // *that* instead of the literal query. Higher recall for sparse queries.
  // Failure-mode: any error in HyDE generation → fall back to original query.
  let effectiveQuery = query;
  // Note: idx may not have hyde_enabled if it's an older row; default false
  if ((idx as RagIndex & { hyde_enabled?: boolean }).hyde_enabled) {
    try {
      const { generateHypotheticalDoc } = await import('./hyde.js');
      const pseudo = await generateHypotheticalDoc(query);
      if (pseudo && pseudo.trim().length > 0) {
        effectiveQuery = pseudo;
      }
    } catch (err) {
      // log + continue with original query
      const { logger } = await import('../lib/logger.js');
      logger.warn({ err: String(err), index: idx.name }, 'HyDE failed, using original query');
    }
  }

  const fetchIdx: RagIndex = { ...idx, top_k: fetchK };

  // pgvector requires a DB pool; fail fast with a self-describing error rather
  // than dereferencing an undefined pool inside the provider call (the `pool as
  // pg.Pool` cast below would otherwise mask a missing pool at compile time).
  if (idx.provider === 'pgvector' && !pool) {
    throw new Error(`pgvector RAG index "${idx.name}" requires a DB pool, but none was passed to searchRagIndex`);
  }

  // ── Stage 1: Retrieve ────────────────────────────────────────────
  const t0 = Date.now();
  const retrieveSpan = tracer.startSpan('rag.retrieve');
  retrieveSpan.setAttributes({
    'rag.fetch_k': fetchK,
    'openinference.span.kind': 'RETRIEVER',
    'input.value': query.slice(0, 500),
  });
  let candidates: RagResult[];
  const timeoutMs = searchTimeoutMs();
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort(new Error(`RAG search timed out after ${timeoutMs}ms`));
        reject(new Error(`RAG search for "${idx.label}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    candidates = await Promise.race([
      searchRagProvider(fetchIdx, effectiveQuery, pool, controller.signal),
      timeout,
    ]);
    retrieveSpan.setAttributes({
      'rag.candidates_count': candidates.length,
      'output.value': JSON.stringify(candidates.slice(0, 5).map(c => ({
        document_id: c.id,
        score: c.score,
        document_content: (c.content ?? '').slice(0, 200),
      }))),
    });
    retrieveSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    retrieveSpan.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    retrieveSpan.recordException(err instanceof Error ? err : new Error(String(err)));
    retrieveSpan.end();
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  retrieveSpan.end();
  const retrieveMs = Date.now() - t0;

  if (!useRerank || candidates.length <= desiredK) {
    const final = candidates.slice(0, desiredK);

    // Langfuse: trace without reranking
    if (langfuseEnabled) {
      const traceId = `rag-${idx.name}-${Date.now()}`;
      void lfPost('/api/public/traces', {
        id: traceId, name: `rag_search:${idx.name}`,
        input:    { query, index: idx.name, reranker: false },
        output:   { results: toResultSummary(final) },
        metadata: { provider: idx.provider, top_k: desiredK, reranker_enabled: false },
        tags:     [idx.name, 'rag-search'],
      });
    }

    return final;
  }

  // ── Stage 2: Rerank ──────────────────────────────────────────────
  const docs = candidates.map((c) => c.content);
  const t1 = Date.now();
  const rerankSpan = tracer.startSpan('rag.rerank');
  rerankSpan.setAttributes({
    'rag.candidates_in': candidates.length,
    'openinference.span.kind': 'RERANKER',
    'input.value': query.slice(0, 500),
  });
  let reranked: Awaited<ReturnType<typeof rerank>>;
  try {
    reranked = await rerank(query, docs, desiredK);
    rerankSpan.setAttributes({
      'rag.results_out': reranked?.length ?? 0,
      'output.value': JSON.stringify((reranked ?? []).slice(0, 5).map(r => ({
        document_id: candidates[r.index]?.id ?? '',
        relevance_score: r.relevance_score,
      }))),
    });
    rerankSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    rerankSpan.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
    rerankSpan.recordException(err instanceof Error ? err : new Error(String(err)));
    rerankSpan.end();
    throw err;
  }
  rerankSpan.end();
  const rerankMs = Date.now() - t1;

  if (!reranked || reranked.length === 0) {
    logger.debug({ index: idx.name }, 'Reranker returned nothing — using original order');
    return candidates.slice(0, desiredK);
  }

  const finalResults = reranked
    .map((r) => {
      const orig = candidates[r.index];
      if (!orig) return null;
      return { ...orig, score: r.relevance_score };
    })
    .filter((x): x is RagResult => x !== null);

  // ── Langfuse: trace with both stages ──────────────────────────────
  if (langfuseEnabled) {
    const traceId = `rag-${idx.name}-${Date.now()}`;

    // Detect rank changes caused by reranker
    const rankChanges = finalResults.map((res, newRank) => {
      const oldRank = candidates.findIndex(c => c.id === res.id);
      return { id: res.id, old_rank: oldRank + 1, new_rank: newRank + 1, delta: oldRank - newRank };
    });

    void lfPost('/api/public/traces', {
      id: traceId, name: `rag_search:${idx.name}`,
      input:    { query, index: idx.name, reranker: true },
      output:   { results: toResultSummary(finalResults) },
      metadata: {
        provider:          idx.provider,
        top_k:             desiredK,
        candidates_fetched: candidates.length,
        reranker_enabled:  true,
        retrieve_ms:       retrieveMs,
        rerank_ms:         rerankMs,
        rank_changes:      rankChanges,
      },
      tags: [idx.name, 'rag-search', 'reranked'],
    });

    // Span 1: retrieve results (before reranking)
    void lfPost('/api/public/observations', {
      traceId, type: 'SPAN',
      name:       'retrieve',
      startTime:  new Date(t0).toISOString(),
      endTime:    new Date(t0 + retrieveMs).toISOString(),
      input:      { query, top_k: fetchK },
      output:     { candidates: toResultSummary(candidates.slice(0, desiredK)) },
      metadata:   { provider: idx.provider, total_candidates: candidates.length },
    });

    // Span 2: rerank results (after reranking)
    void lfPost('/api/public/observations', {
      traceId, type: 'SPAN',
      name:       'rerank',
      startTime:  new Date(t1).toISOString(),
      endTime:    new Date(t1 + rerankMs).toISOString(),
      input:      { query, candidates_count: candidates.length },
      output:     { reranked: toResultSummary(finalResults), rank_changes: rankChanges },
      metadata:   { model: 'bge-reranker-base', provider: 'tei' },
    });
  }

  return finalResults;
}
