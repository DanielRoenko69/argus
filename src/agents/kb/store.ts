import type pg from 'pg';
export interface KbDocument { id: number; name: string; chunk_count: number; created_at: string }
export async function listKbDocuments(pool: pg.Pool, ragIndexId: number): Promise<KbDocument[]> {
  const { rows } = await pool.query<KbDocument>(
    `SELECT id, name, chunk_count, created_at FROM mcp_kb_documents WHERE rag_index_id=$1 ORDER BY created_at DESC`,
    [ragIndexId],
  );
  return rows;
}
/** Delete a document scoped to its index (chunks cascade). Returns false if no such doc in that index. */
export async function deleteKbDocument(pool: pg.Pool, ragIndexId: number, docId: number): Promise<boolean> {
  const res = await pool.query('DELETE FROM mcp_kb_documents WHERE id=$1 AND rag_index_id=$2', [docId, ragIndexId]);
  return (res.rowCount ?? 0) > 0;
}
