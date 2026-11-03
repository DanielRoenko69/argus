import type pg from 'pg';

// A concrete enabled external profile owns execution. The legacy Agent.model
// value is not an API assignment in that case. Unknown/incomplete profiles
// remain dependencies, as do disabled Agents with a real direct API selection.
export const API_MODEL_ASSIGNMENT_SQL = `NOT EXISTS (
  SELECT 1 FROM mcp_agent_runtime_profiles runtime
   WHERE runtime.id=agent.runtime_profile_id
     AND runtime.runtime_type IN ('codex','claude-code','hermes')
     AND runtime.enabled=true AND NULLIF(btrim(runtime.model),'') IS NOT NULL
)`;

/** Caller owns the transaction (and, for operator cleanup, canonical audit). */
export async function deleteModelInTransaction(client: pg.PoolClient, id: number): Promise<boolean> {
  // Agent.model is a legacy text reference, not a foreign key. Prevent an
  // assignment/profile change between the dependency check and deletion.
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query('LOCK TABLE mcp_models, mcp_agents, mcp_agent_runtime_profiles IN SHARE ROW EXCLUSIVE MODE');
  const assigned = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mcp_agents agent
       JOIN mcp_models model ON model.model_name=agent.model
      WHERE model.id=$1 AND ${API_MODEL_ASSIGNMENT_SQL}`, [id],
  );
  if (Number(assigned.rows[0]?.count ?? 0) > 0) {
    throw new Error('Modell kann nicht gelöscht werden, solange Agents es als API-Modell verwenden');
  }
  return (await client.query('DELETE FROM mcp_models WHERE id=$1', [id])).rowCount === 1;
}
