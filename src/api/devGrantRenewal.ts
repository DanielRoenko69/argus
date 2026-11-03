import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { checkpointGrantProvenance } from './codingCheckpointRetry.js';
import { ExecutionGrantError, signExecutionGrant, type ExecutionGrantClaims } from '../solutionPacks/executionGrant.js';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import { normalizeRole } from '../auth/roles.js';
import { fetchUserAgentPolicyData } from '../auth/userPolicyStore.js';
import { resolveAgentAccess } from '../auth/userPolicyResolver.js';
import { appendCanonicalAuditEvent } from '../audit/canonicalAuditStore.js';

const requestSchema = z.object({ grant: z.string().max(16384), threadId: z.string().uuid(), runId: z.string().uuid() }).strict();
const denied = () => new ExecutionGrantError(403, 'dev_grant_renewal_denied', 'Run authority is no longer renewable. No workflow action was dispatched.');
const equalIds = (a: unknown, b: number[]) => Array.isArray(a)
  && JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify([...b].sort((x, y) => x - y));

/** Keep the revocation identity and every authority claim unchanged. A renewed
 * bearer is short-lived; the historical bearer remains expired on ALL ordinary
 * endpoints. Renewal is available only to the trusted Pack's running execution. */
export async function renewDevGrant(pool: pg.Pool, secret: string, input: z.infer<typeof requestSchema>,
  audit = appendCanonicalAuditEvent): Promise<string> {
  const c = checkpointGrantProvenance(secret, input.grant);
  if (c.rootTraceId !== input.threadId || c.principalKind !== 'user' || !/^[1-9]\d*$/.test(c.principalId)
    || !c.workspaceRoot || !c.coreAgents?.length || c.resourceScope || c.aiopsServiceContext) throw denied();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the execution before its grant. Cancellation/revocation and a second
    // renewal serialize here; no stopped/queued/approval-waiting run can renew.
    const thread = (await client.query(`SELECT t.metadata, r.started_at FROM argus_langgraph_threads t
      JOIN argus_langgraph_runs r ON r.thread_id=t.thread_id
      WHERE t.thread_id=$1 AND r.run_id=$2 AND t.graph_id='coding_workflow'
        AND t.status='running' AND r.status='running' FOR UPDATE OF t,r`, [input.threadId, input.runId])).rows[0];
    const stored = (await client.query(`SELECT * FROM argus_execution_grants WHERE grant_id=$1 FOR UPDATE`, [c.jti])).rows[0];
    if (!thread || !thread.started_at || thread.metadata?.source !== 'a2a'
      || thread.metadata?.execution_grant_id !== c.jti || thread.metadata?.execution_principal !== c.sub
      || !equalIds(thread.metadata?.execution_bundle_ids, c.bundleIds)
      || !stored || stored.status !== 'active' || stored.root_trace_id !== input.threadId
      || stored.pack_id !== c.aud || stored.pack_agent_id !== c.agent
      || stored.principal_kind !== c.principalKind || stored.principal_id !== c.principalId
      || stored.tenant_key !== (c.tenantKey ?? 'default') || stored.workspace_key !== (c.workspaceKey ?? 'default')
      || !equalIds(stored.bundle_ids, c.bundleIds) || !equalIds(stored.core_agent_ids, c.coreAgentIds)
      || JSON.stringify(stored.tool_names ?? null) !== JSON.stringify(c.toolNames ?? null)) throw denied();
    const user = (await client.query(`SELECT role, allowed_bundles, entra_groups FROM mcp_users WHERE id=$1 AND enabled=true FOR SHARE`, [Number(c.principalId)])).rows[0];
    if (!user || !evaluatePermission({ role: normalizeRole(user.role) }, 'workflows.run').allowed
      || user.allowed_bundles !== null && c.bundleIds.some(id => !user.allowed_bundles.includes(id))) throw denied();
    if ((c.tenantKey ?? 'default') !== 'default' || (c.workspaceKey ?? 'default') !== 'default') {
      const member = await client.query(`SELECT 1 FROM mcp_workspace_memberships WHERE user_id=$1 AND tenant_key=$2 AND workspace_key=$3 FOR SHARE`,
        [Number(c.principalId), c.tenantKey, c.workspaceKey]);
      if (!member.rowCount) throw denied();
    }
    const agents = await client.query(`SELECT id,name FROM mcp_agents WHERE enabled=true AND id=ANY($1::int[]) FOR SHARE`, [c.coreAgentIds]);
    if (!equalIds(agents.rows.map(row => row.id), c.coreAgentIds)
      || c.coreAgents.some(a => !agents.rows.some(row => row.id === a.id && row.name === a.name))) throw denied();
    const bundles = await client.query(`SELECT id FROM mcp_service_bundles WHERE id=ANY($1::int[]) FOR SHARE`, [c.bundleIds]);
    if (!equalIds(bundles.rows.map(row => row.id), c.bundleIds)) throw denied();
    if (c.runtimeProfileOverrides?.length) {
      const profiles = await client.query(`SELECT id,runtime_type,name FROM mcp_agent_runtime_profiles WHERE enabled=true AND id=ANY($1::int[]) FOR SHARE`,
        [c.runtimeProfileOverrides.map(p => p.runtimeProfileId)]);
      if (c.runtimeProfileOverrides.some(p => !profiles.rows.some(r => r.id === p.runtimeProfileId && r.runtime_type === p.runtimeType && r.name === p.runtimeProfileName))) throw denied();
    }
    const rules = await fetchUserAgentPolicyData(client as unknown as pg.Pool, Number(c.principalId), user.entra_groups ?? []);
    if (!equalIds(resolveAgentAccess(rules, c.coreAgentIds), c.coreAgentIds)) throw denied();
    if (c.testEnvironmentPolicy && (process.env.ARGUS_GENERAL_STACKS_ENABLED !== 'true'
      || c.testEnvironmentPolicy === 'workspace-session-v1' && process.env.ARGUS_WORKSPACE_SESSIONS_ENABLED !== 'true')) throw denied();
    if (c.codeGeneration && process.env.ARGUS_CODE_GENERATION_ENABLED !== 'true') throw denied();
    const now = Math.floor(Date.now() / 1000);
    const storedExpiry = Math.floor(new Date(stored.expires_at).getTime() / 1000);
    // A lost response can be retrieved without extending the lease or duplicating
    // audit. Check current access even on this idempotent response path.
    const exp = storedExpiry > now + 600 ? storedExpiry : now + 3600;
    const fresh: ExecutionGrantClaims = { ...c, iat: exp - 3600, exp };
    if (exp !== storedExpiry) {
      await client.query(`UPDATE argus_execution_grants SET expires_at=to_timestamp($2) WHERE grant_id=$1`, [c.jti, exp]);
      await audit(client, {
        producer: { name: 'argus.dev.grant-renewal', eventId: `${c.jti}:${exp}` },
        environment: process.env.ARGUS_ENVIRONMENT || 'local', tenantKey: c.tenantKey, workspaceKey: c.workspaceKey,
        solution: 'argus.dev', actor: { type: 'service', id: 'argus.dev', authMethod: 'workspace-secret+execution-grant', effectiveRoles: [] },
        action: 'dev.execution_grant.renewed', outcome: 'success', risk: 'medium', resource: { type: 'execution_grant', id: c.jti },
        policy: { id: 'argus.dev.same-scope-renewal', version: '1', decision: 'allow' },
        correlation: { rootRunId: input.threadId, traceId: input.threadId, requestId: input.runId },
        payload: { before: { expiresAt: storedExpiry }, after: { expiresAt: exp }, context: { principal: c.sub, bundleIds: c.bundleIds } },
      });
    }
    const token = signExecutionGrant(secret, fresh);
    await client.query('COMMIT');
    return token;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export function createDevGrantRenewalRouter(pool: pg.Pool, secret: string) {
  const router = Router();
  router.post('/api/internal/dev-grants/renew', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const expected = Buffer.from(process.env.WORKSPACE_SECRET ?? '');
    const actual = Buffer.from(String(req.header('x-workspace-secret') ?? ''));
    if (!expected.length || actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
      res.status(401).json({ code: 'unauthorized' }); return;
    }
    if (process.env.ARGUS_DEV_GRANT_RENEWAL_ENABLED !== 'true') { res.status(409).json({ code: 'dev_grant_renewal_disabled' }); return; }
    try {
      const input = requestSchema.parse(req.body);
      res.json({ grant: await renewDevGrant(pool, secret, input) });
    } catch (error) {
      const known = error instanceof ExecutionGrantError;
      res.status(known ? error.status : 503).json({ code: known ? error.code : 'dev_grant_renewal_unavailable',
        error: known ? error.message : 'Grant renewal unavailable; no automatic retry or workflow action.' });
    }
  });
  return router;
}
