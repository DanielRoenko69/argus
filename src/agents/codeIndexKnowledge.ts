import type pg from 'pg';
import { searchCodeIndex } from '../codeIntelligence/retrieval.js';
import { logger } from '../lib/logger.js';
import { formatRagContext } from './ragClient.js';

const MAX_SNAPSHOTS_PER_TURN = 3;
const RESULTS_PER_SNAPSHOT = 3;

interface AssignedSnapshotRow extends pg.QueryResultRow {
  snapshot_id: number | string;
  repository_key: string;
  branch_name: string;
  commit_sha: string;
}

export interface AgentRepositoryKnowledgeResult {
  context: string;
  snapshotCount: number;
  evidenceCount: number;
}

/**
 * Retrieve bounded, commit-pinned Graphify evidence assigned to an Agent.
 * Snapshot Bundle authorization is re-evaluated by searchCodeIndex on every
 * turn; a stale or no-longer-authorized assignment therefore fails closed.
 */
export async function buildAgentRepositoryKnowledge(
  pool: pg.Pool,
  agentId: number,
  query: string,
  allowedBundleIds: number[] | null,
): Promise<AgentRepositoryKnowledgeResult> {
  let assigned: pg.QueryResult<AssignedSnapshotRow>;
  try {
    assigned = await pool.query<AssignedSnapshotRow>(
      `SELECT assignment.snapshot_id, snapshot.repository_key, snapshot.branch_name, snapshot.commit_sha
         FROM mcp_agent_code_index_snapshots assignment
         JOIN mcp_code_index_snapshots snapshot ON snapshot.id=assignment.snapshot_id
        WHERE assignment.agent_id=$1 AND snapshot.status='ready'
        ORDER BY assignment.priority, assignment.snapshot_id
        LIMIT $2`,
      [agentId, MAX_SNAPSHOTS_PER_TURN],
    );
  } catch (error) {
    logger.warn({ err: error, agentId }, 'Assigned repository knowledge catalog could not be loaded');
    return { context: '', snapshotCount: 0, evidenceCount: 0 };
  }

  const contexts: string[] = [];
  let evidenceCount = 0;
  for (const row of assigned.rows) {
    try {
      const result = await searchCodeIndex(pool, {
        snapshotId: Number(row.snapshot_id),
        query,
        limit: RESULTS_PER_SNAPSHOT,
        strategy: 'hybrid_graph',
        allowedBundleIds,
      });
      evidenceCount += result.evidence.length;
      const formatted = formatRagContext(result.evidence.map(evidence => ({
        id: String(evidence.documentId),
        score: evidence.scores.fused,
        content: evidence.content,
        source: `${evidence.filePath}${evidence.startLine == null ? '' : `#L${evidence.startLine}`}`,
      })), `Graphify · ${row.repository_key} · ${row.branch_name} · ${row.commit_sha.slice(0, 12)}`);
      if (formatted) contexts.push(formatted);
    } catch (error) {
      logger.warn({ err: error, agentId, snapshotId: Number(row.snapshot_id) },
        'Assigned repository knowledge was unavailable or outside the effective Bundle scope');
    }
  }

  return {
    context: contexts.join('\n\n'),
    snapshotCount: contexts.length,
    evidenceCount,
  };
}
