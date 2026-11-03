import type pg from 'pg';
import type { RagIndex } from '../types.js';
import type { RagResult } from '../ragClient.js';
import { embedText } from '../ragClient.js';

/** Cosine-similarity search over a provider-neutral pgvector corpus. */
export async function searchPgvectorRag(
  idx: RagIndex,
  query: string,
  pool: pg.Pool,
  signal?: AbortSignal,
): Promise<RagResult[]> {
  const emb = await embedText(query, signal);
  const vec = `[${emb.join(',')}]`;
  const { rows } = await pool.query(
    `SELECT c.id, c.content, d.name AS source, 1 - (c.embedding <=> $1::halfvec) AS score
       FROM mcp_kb_chunks c JOIN mcp_kb_documents d ON d.id = c.document_id
      WHERE c.rag_index_id = $2
      ORDER BY c.embedding <=> $1::halfvec
      LIMIT $3`,
    [vec, idx.id, idx.top_k],
  );
  return rows.map((r: { id: number | string; content: string; source: string; score: number | string }) => ({
    id: String(r.id),
    score: Number(r.score),
    content: r.content,
    source: r.source,
  }));
}
