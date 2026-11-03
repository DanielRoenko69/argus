import pg from 'pg';
import { ingestDocument } from '../agents/kb/ingest.js';

const { Pool } = pg;

const RUNBOOK = `# Argus.AIOps local incident correlation runbook

Service: argus-core
Environment: local-demo
Owner: Argus platform operations

## Purpose

Use this runbook to validate a read-only, multi-signal investigation. A valid
investigation queries metrics, logs and traces for the same service and bounded
time window. It must not restart, deploy, scale or mutate infrastructure.

## Correlation procedure

1. Confirm Prometheus target health and check bounded golden-signal queries.
2. Query Loki for {service="argus-core", environment="local-demo"} in the
   incident window. Preserve trace_id metadata in the evidence summary.
3. Search Jaeger for service argus-core over the same window and retrieve the
   matching trace. Inspect the critical path and error status.
4. Treat a postgres.query timeout followed by an HTTP 503 as dependency
   evidence only when logs and the corresponding trace share a trace ID.
5. Separate correlation from causation. Missing deployment events, database
   metrics or peer instances remain explicit evidence gaps.

## Local demonstration signal

The Argus.AIOps demo intentionally emits a warning log for a simulated
PostgreSQL timeout, an error trace with a postgres.query child span and a parent
HTTP 503 span. These signals are synthetic validation data, not a production
outage. No remediation or escalation is required when the source is
argus-aiops-demo and the real Prometheus target remains healthy.
`;

async function main(): Promise<void> {
  const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
  if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL is required');

  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    const indexResult = await pool.query<{ id: number }>(
      `INSERT INTO mcp_rag_indexes (
         name, label, description, provider, endpoint, index_name, adapter_config, top_k, enabled
       ) VALUES (
         'argus-aiops-runbooks', 'Argus.AIOps Runbooks',
         'Locally embedded operational runbooks and reviewed incident guidance for Argus.AIOps.',
         'pgvector', '', 'argus-aiops-runbooks', $1, 5, true
       )
       ON CONFLICT (name) DO UPDATE SET
         label = EXCLUDED.label,
         description = EXCLUDED.description,
         provider = EXCLUDED.provider,
         endpoint = EXCLUDED.endpoint,
         index_name = EXCLUDED.index_name,
         adapter_config = EXCLUDED.adapter_config,
         top_k = EXCLUDED.top_k,
         enabled = true,
         updated_at = now()
       RETURNING id`,
      [JSON.stringify({ source: 'argus-aiops-demo', content: 'reviewed-runbooks' })],
    );
    const ragIndexId = indexResult.rows[0]?.id;
    if (!ragIndexId) throw new Error('Argus.AIOps RAG index was not created');

    const assignment = await pool.query(
      `INSERT INTO mcp_agent_rag_indexes (agent_id, rag_index_id, priority)
       SELECT id, $1, 0 FROM mcp_agents WHERE name = 'aiops-knowledge'
       ON CONFLICT (agent_id, rag_index_id) DO UPDATE SET priority = EXCLUDED.priority`,
      [ragIndexId],
    );
    if (assignment.rowCount !== 1) throw new Error('aiops-knowledge agent is not installed');

    const documentName = 'argus-aiops-local-incident-correlation.md';
    const ingested = await ingestDocument(pool, ragIndexId, documentName, Buffer.from(RUNBOOK, 'utf8'));
    await pool.query(
      `DELETE FROM mcp_kb_documents
        WHERE rag_index_id = $1 AND name = $2 AND id <> $3`,
      [ragIndexId, documentName, ingested.id],
    );

    process.stdout.write(`${JSON.stringify({
      ok: true,
      index: 'argus-aiops-runbooks',
      agent: 'aiops-knowledge',
      document: documentName,
      chunks: ingested.chunkCount,
    })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(cause => {
  process.stderr.write(`[aiops-knowledge-seed] failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
