/**
 * ragEval.ts — RAG evaluation via LLM-generated questions + Hit@5 metric.
 *
 * Triggered by POST /api/admin/rag-indexes/:id/eval.
 * Runs entirely in Node — no Python process needed.
 *
 * Flow:
 *   1. Fetch N sample chunks from built-in pgvector, Qdrant, or Azure AI Search
 *   2. Generate one test question per chunk via claude-haiku-4-5
 *   3. Query the same index with that question
 *   4. Hit@5 = source chunk in Top-5 results?
 *   5. Upload results to Langfuse Dataset + Scores
 */

import type pg from 'pg';
import type { RagIndex } from './types.js';

import { searchRagIndex } from './ragSearch.js';
import { sampleRagProvider } from './ragProviderRegistry.js';
import { logger } from '../lib/logger.js';
import { chatCompletion, firstText } from '../llm/client.js';
import { hasLlmCredentials } from '../llm/targets.js';

const RAG_EVAL_MODEL = process.env['RAG_EVAL_MODEL'] ?? 'claude-haiku-4-5';

const LANGFUSE_PUB  = process.env['LANGFUSE_PUBLIC_KEY'] ?? '';
const LANGFUSE_SEC  = process.env['LANGFUSE_SECRET_KEY'] ?? '';
const LANGFUSE_HOST = process.env['LANGFUSE_HOST']       ?? 'http://langfuse:3100';

export interface EvalDetail {
  question: string;
  chunk_id: string;
  hit: boolean;
}

export interface EvalResult {
  index: string;
  sample_size: number;
  evaluated: number;
  hits: number;
  hit_at_5: number;
  details: EvalDetail[];
  langfuse_dataset?: string;
  langfuse_run?: string;
  error?: string;
}

/** Search via Argus's full pipeline: Hybrid Search (BM25 + Vector) + TEI Reranker.
 *  Identical to what the Knowledge Agent experiences in production. */
async function searchIndex(rag: RagIndex, query: string, pool?: pg.Pool): Promise<string[]> {
  const results = await searchRagIndex(rag, query, pool);
  return results.map(r => r.id);
}

// ── Question generation ────────────────────────────────────────────

async function generateQuestion(chunk: { id: string; content: string }): Promise<string | null> {
  const content = (chunk.content ?? '').slice(0, 1500);
  if (!content.trim()) return null;

  const data = await chatCompletion({
    model: RAG_EVAL_MODEL,
    max_tokens: 150,
    messages: [{
      role: 'user',
      content:
        'Read this text and write ONE specific question (max 15 words) whose answer can only be found in this text. ' +
        'Output ONLY the question, nothing else.\n\n' +
        `Text:\n${content}`,
    }],
  }, { timeoutMs: 15_000 });
  return firstText(data).trim() || null;
}

// ── Langfuse upload ────────────────────────────────────────────────

async function uploadToLangfuse(
  indexName: string,
  details: EvalDetail[],
  hitRate: number,
  runName: string,
): Promise<{ dataset: string; run: string }> {
  if (!LANGFUSE_PUB || !LANGFUSE_SEC) return { dataset: '', run: '' };

  const auth = 'Basic ' + Buffer.from(`${LANGFUSE_PUB}:${LANGFUSE_SEC}`).toString('base64');
  const base = LANGFUSE_HOST.replace(/\/+$/, '');
  const h = { 'Content-Type': 'application/json', Authorization: auth };
  const datasetName = `rag-eval-${indexName}`;

  // Create dataset (ignore 409 if already exists)
  await fetch(`${base}/api/public/datasets`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ name: datasetName }),
  }).catch(() => {});

  // Upload dataset items
  for (const r of details) {
    await fetch(`${base}/api/public/dataset-items`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        datasetName,
        input:          { question: r.question },
        expectedOutput: { source_chunk_id: r.chunk_id },
      }),
    }).catch(() => {});
  }

  // Create trace for this run
  const traceId = `rag-eval-${indexName}-${Date.now()}`;
  await fetch(`${base}/api/public/traces`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      id: traceId, name: runName,
      tags: [indexName, 'rag-eval'],
      metadata: { index: indexName, hit_rate: hitRate, evaluated: details.length },
    }),
  }).catch(() => {});

  // Score: overall Hit@5
  await fetch(`${base}/api/public/scores`, {
    method: 'POST', headers: h,
    body: JSON.stringify({
      traceId, name: 'hit_at_5_overall', value: hitRate, dataType: 'NUMERIC',
      comment: `${details.filter(d => d.hit).length}/${details.length} chunks found in Top-5`,
    }),
  }).catch(() => {});

  return { dataset: datasetName, run: runName };
}

// ── Main entry point ───────────────────────────────────────────────

export async function runRagEval(rag: RagIndex, sampleSize = 20, pool?: pg.Pool): Promise<EvalResult> {
  if (!hasLlmCredentials(RAG_EVAL_MODEL)) {
    return { index: rag.index_name, sample_size: sampleSize, evaluated: 0, hits: 0, hit_at_5: 0, details: [], error: `No direct provider credentials configured for ${RAG_EVAL_MODEL}` };
  }

  const runName = `eval-${new Date().toISOString().slice(0, 16).replace('T', '-')}`;

  logger.info({ indexName: rag.index_name, sampleSize }, 'RAG eval: starting');

  let chunks: Array<{ id: string; content: string; path?: string }>;
  try {
    chunks = await sampleRagProvider(rag, sampleSize, pool);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'RAG eval: failed to fetch chunks');
    return { index: rag.index_name, sample_size: sampleSize, evaluated: 0, hits: 0, hit_at_5: 0, details: [], error: msg };
  }

  const details: EvalDetail[] = [];

  for (const chunk of chunks) {
    try {
      const question = await generateQuestion(chunk);
      if (!question) continue;
      const top5 = await searchIndex(rag, question, pool).catch((): string[] => []);
      details.push({ question, chunk_id: chunk.id, hit: top5.includes(chunk.id) });
    } catch (err) {
      logger.warn({ chunkId: chunk.id, err }, 'RAG eval: skipping chunk');
    }
  }

  const evaluated = details.length;
  const hits      = details.filter(d => d.hit).length;
  const hit_at_5  = evaluated > 0 ? hits / evaluated : 0;

  logger.info({ indexName: rag.index_name, hit_at_5, hits, evaluated }, 'RAG eval: complete');

  const { dataset, run } = await uploadToLangfuse(rag.index_name, details, hit_at_5, runName).catch(() => ({ dataset: '', run: '' }));

  return {
    index: rag.index_name,
    sample_size: sampleSize,
    evaluated,
    hits,
    hit_at_5,
    details,
    ...(dataset ? { langfuse_dataset: dataset, langfuse_run: run } : {}),
  };
}
