import type pg from 'pg';
import { extractText } from './extract.js';
import { chunkText } from './chunk.js';
import { embedText } from '../ragClient.js';

// Cap chunks per document to bound embedding cost and query latency. Embedding
// dimensions are intentionally provider-neutral and enforced per corpus by
// pgvector's distance operator at query time.
const MAX_CHUNKS_PER_DOC = Number(process.env['KB_MAX_CHUNKS_PER_DOC'] ?? 5000);

/** Extract → chunk → embed → store a document + its chunks (one transaction). */
export async function ingestDocument(
  pool: pg.Pool,
  ragIndexId: number,
  name: string,
  buffer: Buffer,
): Promise<{ id: number; chunkCount: number }> {
  const text = await extractText(name, buffer);
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error('kb: no extractable text in file');
  if (chunks.length > MAX_CHUNKS_PER_DOC) {
    throw new Error(`kb: document too large — ${chunks.length} chunks exceeds the ${MAX_CHUNKS_PER_DOC} cap (set KB_MAX_CHUNKS_PER_DOC to raise it)`);
  }
  const embeddings: number[][] = [];
  for (const c of chunks) {
    const emb = await embedText(c);
    embeddings.push(emb);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO mcp_kb_documents (rag_index_id, name, byte_size, char_count, chunk_count)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ragIndexId, name, buffer.length, text.length, chunks.length],
    );
    const docId = rows[0].id as number;
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO mcp_kb_chunks (document_id, rag_index_id, chunk_index, content, embedding)
         VALUES ($1,$2,$3,$4,$5::halfvec)`,
        [docId, ragIndexId, i, chunks[i], `[${embeddings[i].join(',')}]`],
      );
    }
    await client.query('COMMIT');
    return { id: docId, chunkCount: chunks.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
