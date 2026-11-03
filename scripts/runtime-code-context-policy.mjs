import dotenv from 'dotenv';
import pg from 'pg';
import { updateAgentRuntimeCodeContextPolicy } from '../dist/agents/runtimeProfiles.js';

dotenv.config();

const [profileName, mode, maxResultsRaw = '4', maxBytesRaw = '12000'] = process.argv.slice(2);
const databaseUrl = process.env.POSTGRES_CONNECTION_URL ?? '';
const actor = (process.env.ARGUS_POLICY_ACTOR ?? 'local-operator-cli').trim().slice(0, 128);

if (!databaseUrl) throw new Error('POSTGRES_CONNECTION_URL is required');
if (!profileName || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(profileName)) {
  throw new Error('Usage: npm run runtime:code-context -- <profile-name> <metadata_only|bounded_source> [max-results] [max-bytes]');
}

const maxResults = Number(maxResultsRaw);
const maxBytes = Number(maxBytesRaw);
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const selected = await pool.query(
    'SELECT id FROM mcp_agent_runtime_profiles WHERE name=$1 LIMIT 1',
    [profileName],
  );
  const profileId = Number(selected.rows[0]?.id ?? 0);
  if (!profileId) throw new Error(`Runtime profile '${profileName}' was not found`);

  const result = await updateAgentRuntimeCodeContextPolicy(pool, profileId, {
    mode,
    maxResults,
    maxBytes,
  });
  const auditState = profile => ({
    code_context_mode: profile.code_context_mode,
    code_context_max_results: profile.code_context_max_results,
    code_context_max_bytes: profile.code_context_max_bytes,
  });
  await pool.query(
    `INSERT INTO mcp_admin_audit_log
       (action, table_name, object_id, object_label, changed_by, changed_by_api_key, before_state, after_state)
     VALUES ($1,$2,$3,$4,$5,NULL,$6::jsonb,$7::jsonb)`,
    [
      'code_context_policy_updated',
      'mcp_agent_runtime_profiles',
      String(result.profile.id),
      result.profile.label,
      actor,
      JSON.stringify(auditState(result.before)),
      JSON.stringify(auditState(result.profile)),
    ],
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    actor,
    profile: {
      id: result.profile.id,
      name: result.profile.name,
      runtimeType: result.profile.runtime_type,
      assignedAgents: result.profile.assigned_agent_count,
      ...auditState(result.profile),
    },
  }, null, 2)}\n`);
} finally {
  await pool.end();
}
