import { createHash } from 'crypto';
import type { RagIndex, Citation, ChatMessage } from './types.js';
import { getRedisClient } from '../lib/redis.js';
import { decrypt } from '../lib/encryption.js';
import { chatCompletion, createEmbedding, firstText } from '../llm/client.js';

const EMBED_MODEL = process.env['EMBEDDING_MODEL'] ?? 'text-embedding-3-large';

// HyDE: generate hypothetical answer before embedding to improve recall
const HYDE_ENABLED = process.env['RAG_HYDE_ENABLED'] === 'true';
const HYDE_MODEL   = process.env['RAG_HYDE_MODEL'] ?? 'gpt-4o-mini';

async function generateHypotheticalAnswer(query: string): Promise<string> {
  try {
    const data = await chatCompletion({
      model: HYDE_MODEL,
      messages: [
        { role: 'system', content: 'Write a concise 2-3 sentence factual answer to the question below as if you found it in technical documentation. Answer directly without preamble.' },
        { role: 'user', content: query },
      ],
      max_tokens: 150,
      temperature: 0,
    }, { timeoutMs: 5_000 });
    return firstText(data) || query;
  } catch {
    return query; // fail open — fall back to original query
  }
}

/** Embed arbitrary text via the configured direct provider (redis-cached). No HyDE. */
export async function embedText(text: string, signal?: AbortSignal): Promise<number[]> {
  const redis = getRedisClient();
  const cacheKey = redis
    ? `embed:${createHash('sha256').update(`${EMBED_MODEL}:${text}`).digest('hex')}`
    : null;
  if (redis && cacheKey) {
    const hit = await redis.get(cacheKey).catch(() => null);
    if (hit) return JSON.parse(hit) as number[];
  }
  const data = signal
    ? await createEmbedding(EMBED_MODEL, text, { signal })
    : await createEmbedding(EMBED_MODEL, text);
  const embedding = data.data?.[0]?.embedding;
  // Guard against a malformed/empty response so callers fail fast with a clear error rather than
  // pushing undefined/garbage into a `::vector` insert (mirrors the guard in agents/memory.ts).
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`Embedding API returned no vector for model ${EMBED_MODEL}`);
  }
  if (redis && cacheKey) redis.setex(cacheKey, 86_400, JSON.stringify(embedding)).catch(() => {});
  return embedding;
}

async function embedQuery(query: string, signal?: AbortSignal): Promise<number[]> {
  const textToEmbed = HYDE_ENABLED ? await generateHypotheticalAnswer(query) : query;
  return embedText(textToEmbed, signal);
}

export interface RagResult {
  id: string;
  score: number;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

/** Resolve api_key: decrypt if encrypted, expand env var references ($VAR_NAME). */
export function resolveRagApiKey(raw: string | null): string {
  if (!raw) return '';
  const plain = decrypt(raw) ?? '';
  if (plain.startsWith('$')) return process.env[plain.slice(1)] ?? '';
  return plain;
}

/** Search Azure AI Search and return top-k results as plain text snippets. */
export async function searchAzureAISearch(index: RagIndex, query: string, signal?: AbortSignal): Promise<RagResult[]> {
  const apiKey = resolveRagApiKey(index.api_key);
  if (!apiKey) throw new Error(`No API key configured for RAG index "${index.name}"`);

  const url = `${index.endpoint.replace(/\/$/, '')}/indexes/${encodeURIComponent(index.index_name)}/docs/search?api-version=2023-11-01`;

  const body: Record<string, unknown> = {
    search: query,
    top: index.top_k,
    select: '*',
  };

  if (index.semantic_config) {
    body.queryType = 'semantic';
    body.semanticConfiguration = index.semantic_config;
    body.captions = 'extractive';
    body.answers = 'extractive';
  }

  // ── Hybrid (BM25 keyword + vector) when vector_field is configured ──
  if (index.vector_field) {
    try {
      const embedding = await embedQuery(query, signal);
      body.vectorQueries = [{
        kind:   'vector',
        vector: embedding,
        fields: index.vector_field,
        k:      index.top_k,
      }];
      // searchMode 'all' tightens BM25 (all terms must match), 'any' is laxer
      body.searchMode = body.searchMode ?? 'any';
    } catch (err) {
      // Embedding failure → fall back to keyword-only, log but don't block
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(JSON.stringify({ level: 'warn', msg: 'Hybrid embedding failed — falling back to BM25-only', err: msg, index: index.name }));
    }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Azure AI Search error ${response.status}: ${errText}`);
  }

  const data = await response.json() as { value?: Record<string, unknown>[] };
  const docs = data.value ?? [];

  return docs.map((doc, i) => {
    const adapter = index.adapter_config ?? {};
    // Extract content from common field names
    const content = String(
      doc[adapter.text_field ?? 'content'] ?? doc['chunk'] ?? doc['text'] ?? doc['body'] ?? JSON.stringify(doc)
    );
    const source = String(doc[adapter.source_field ?? 'source'] ?? doc['sourcefile'] ?? doc['url'] ?? doc['title'] ?? '');
    const score = typeof doc['@search.score'] === 'number' ? doc['@search.score'] : 0;
    const id = String(doc[adapter.id_field ?? 'id'] ?? doc['chunk_id'] ?? i);

    return { id, score, content, source, metadata: doc };
  });
}

/**
 * Normalize retrieved data before it is placed in a model prompt.
 *
 * This is deliberately not a keyword filter: legitimate documents may contain
 * words such as "ignore" or "system". Instead, remove invisible control and
 * bidirectional-isolation characters that can hide/reshape delimiters while
 * keeping the visible document text intact. XML escaping below provides the
 * actual boundary protection.
 */
export function sanitizeRetrievedText(value: unknown, maxLength = 800): string {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .slice(0, maxLength);
}

/** Escape XML special chars to prevent prompt injection via RAG content. */
function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Search Qdrant vector store — embeds query first, then does cosine similarity search. */
export async function searchQdrantRag(index: RagIndex, query: string, signal?: AbortSignal): Promise<RagResult[]> {
  const vector = await embedQuery(query, signal);
  const apiKey = resolveRagApiKey(index.api_key);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['api-key'] = apiKey;

  const res = await fetch(
    `${index.endpoint.replace(/\/$/, '')}/collections/${encodeURIComponent(index.index_name)}/points/search`,
    { method: 'POST', headers, body: JSON.stringify({ vector, limit: index.top_k, with_payload: true }), signal },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Qdrant search error ${res.status}: ${errText}`);
  }

  const data = await res.json() as { result: Array<{ id: string | number; score: number; payload: Record<string, unknown> }> };
  const adapter = index.adapter_config ?? {};
  return (data.result ?? []).map(hit => ({
    id:      String(hit.id),
    score:   hit.score,
    content: String(hit.payload[adapter.text_field ?? 'text'] ?? hit.payload['text'] ?? hit.payload['content'] ?? hit.payload['body'] ?? ''),
    source:  String(hit.payload[adapter.source_field ?? 'source'] ?? hit.payload['url'] ?? hit.payload['title'] ?? ''),
    metadata: hit.payload,
  }));
}

/** Format RAG results as a context block for the system prompt. */
export function formatRagContext(results: RagResult[], indexLabel: string): string {
  if (results.length === 0) return '';
  const safeIndexLabel = sanitizeRetrievedText(indexLabel, 300);
  const snippets = results.map((r, i) => {
    const id = sanitizeRetrievedText(r.id, 160);
    const source = sanitizeRetrievedText(r.source ?? '', 300);
    const content = sanitizeRetrievedText(r.content, 800);
    const score = Number.isFinite(r.score) ? r.score.toFixed(6) : '0';
    return `<retrieved_document number="${i + 1}" id="${escXml(id)}" source="${escXml(source)}" score="${score}">\n` +
      `<content>${escXml(content)}</content>\n` +
      '</retrieved_document>';
  }).join('\n\n');
  return `<rag_context source="${escXml(safeIndexLabel)}">\n${snippets}\n</rag_context>`;
}

/** Map raw RAG results → display Citations (truncated snippet, source fallback, index label). */
export function toCitations(results: RagResult[], indexLabel: string): Citation[] {
  return results.map((r) => ({
    source: r.source ?? '',
    snippet: (r.content ?? '').slice(0, 300),
    score: r.score,
    index: indexLabel,
  }));
}

/**
 * Attach citations to the FINAL assistant message in a turn (the RAG-informed answer). A tool-use turn
 * emits tool-calling assistant messages BEFORE the final answer, so the LAST assistant message is the
 * one the user perceives as the answer. No-op when there are no citations or no assistant message.
 * Mutates in place.
 */
export function attachCitationsToLastAssistant(messages: ChatMessage[], citations: Citation[]): void {
  if (citations.length === 0) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') {
      messages[i]!.citations = citations;
      return;
    }
  }
}
