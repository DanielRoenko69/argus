import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditScope } from '../audit/canonicalAuditTypes.js';
import { API_MODEL_ASSIGNMENT_SQL, deleteModelInTransaction } from './modelAssignments.js';

export function retirementNames(names: string[]): string[] {
  if (!names.length || names.length > 10 || names.some(n => !n.trim() || n !== n.trim()
    || n.length > 240 || /[\x00-\x1f\x7f]/.test(n))) {
    throw new Error('Specify 1–10 exact model aliases; no blanks or control characters.');
  }
  return [...new Set(names)].sort();
}

/** Safe metadata only: no credentials, prompts, answers or historical run data. */
export async function planModelRetirement(client: pg.PoolClient, names: string[], scope: CanonicalAuditScope) {
  const aliases = retirementNames(names);
  const models = (await client.query(`SELECT id,model_name,display_name,provider_id,
      upstream_model_name,enabled,updated_at FROM mcp_models
      WHERE model_name=ANY($1::text[]) ORDER BY model_name,id`, [aliases])).rows;
  const assignments = (await client.query(`SELECT agent.id,agent.name,agent.model,agent.runtime_profile_id,
      runtime.runtime_type,runtime.enabled AS runtime_enabled,runtime.model AS runtime_model,
      ${API_MODEL_ASSIGNMENT_SQL} AS api_dependency
    FROM mcp_agents agent LEFT JOIN mcp_agent_runtime_profiles runtime ON runtime.id=agent.runtime_profile_id
    WHERE agent.model=ANY($1::text[]) ORDER BY agent.id`, [aliases])).rows;
  const identity = (await client.query('SELECT current_database() AS database,current_user AS operator')).rows[0];
  const plan = { version: 1, scope: { environment:scope.environment,
    workspaceKey:scope.workspaceKey ?? 'default',tenantKey:scope.tenantKey ?? 'default' },
    identity,aliases,models,assignments };
  const missing = aliases.filter(n => !models.some(m => m.model_name===n));
  const blocked = assignments.filter(a => a.api_dependency);
  return { ...plan,sha256:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    removable:missing.length===0 && blocked.length===0,missing,
    blocking_agent_ids:blocked.map(a => a.id) };
}

/** Explicit database-operator maintenance, not a browser/SSO impersonation path. */
export async function retireModels(pool:pg.Pool,names:string[],reviewedSha256:string,scope:CanonicalAuditScope) {
  const aliases=retirementNames(names);
  if (!/^[a-f0-9]{64}$/.test(reviewedSha256)) throw new Error('A reviewed dry-run SHA-256 is required.');
  return executeCanonicalAuditedMutation(pool,
    { name:'model-retirement-operator',eventId:reviewedSha256 },scope,
    async client => {
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query('LOCK TABLE mcp_models, mcp_agents, mcp_agent_runtime_profiles IN SHARE ROW EXCLUSIVE MODE');
      const plan=await planModelRetirement(client,aliases,scope);
      if (plan.sha256!==reviewedSha256) throw new Error('Model configuration changed. Review a new dry-run before applying.');
      if (!plan.removable) throw new Error('Models are missing or still required by API Agents. No changes applied.');
      for (const model of plan.models) {
        if (!await deleteModelInTransaction(client,Number(model.id))) throw new Error('Model deletion failed. No changes applied.');
      }
      return plan;
    },plan => ({ ...scope,actor:{ type:'system',id:'model-retirement-operator',
      authMethod:'database-operator',effectiveRoles:['database-maintenance'] },
      action:'llm.models.retired',outcome:'success',risk:'medium',
      resource:{ type:'model-catalog',id:reviewedSha256 },
      payload:{ before:{ models:plan.models },after:{ removed_model_ids:plan.models.map(m => m.id) },
        context:{ aliases,reviewed_sha256:reviewedSha256,database_role:plan.identity.operator,
          preserved:['agents','runtime-profiles','providers','credentials','runs','evaluations'] } },
    }));
}
