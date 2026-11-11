import { describe, it, expect, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { renewDevGrant, createDevGrantRenewalRouter } from '../devGrantRenewal.js';
import { signExecutionGrant, verifyExecutionGrant, type ExecutionGrantClaims } from '../../solutionPacks/executionGrant.js';

const secret = 'renewal-fixture-only-'.repeat(3);
function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const claims: ExecutionGrantClaims = { v: 1, jti: randomUUID(), iss: 'argus.core', aud: 'argus.dev', agent: 'coding-orchestrator',
    sub: 'user:3', principalKind: 'user', principalId: '3', tenantKey: 'default', workspaceKey: 'default',
    bundleIds: [50, 3, 4], coreAgentIds: [2], coreAgents: [{ id: 2, name: 'coder' }],
    messageId: randomUUID(), rootTraceId: randomUUID(), workspaceRoot: '/workspace/TEST', executionSurface: 'agent',
    policy: 'mcp-bundle-v1', iat: now - 7200, exp: now - 3600 };
  const stored: any = { status: 'active', root_trace_id: claims.rootTraceId, pack_id: claims.aud, pack_agent_id: claims.agent,
    principal_kind: 'user', principal_id: '3', bundle_ids: claims.bundleIds, core_agent_ids: claims.coreAgentIds,
    tenant_key: 'default', workspace_key: 'default', expires_at: new Date(claims.exp * 1000), tool_names: null };
  const state: any = { thread: { started_at: new Date(claims.iat * 1000), metadata: { source: 'a2a', execution_grant_id: claims.jti,
    execution_principal: 'user:3', execution_bundle_ids: claims.bundleIds } },
    user: { role: 'developer', allowed_bundles: claims.bundleIds, entra_groups: ['team'] }, rules: [], agents: claims.coreAgents,
    bundles: claims.bundleIds.map(id => ({ id })) };
  const query = jest.fn<(...args: any[]) => any>().mockImplementation(async (sql: string, args: any[]) => {
    if (sql.includes('JOIN argus_langgraph_runs')) return { rows: state.thread ? [state.thread] : [] };
    if (sql.startsWith('SELECT * FROM argus_execution_grants')) return { rows: [stored] };
    if (sql.includes('FROM mcp_users')) return { rows: state.user ? [state.user] : [] };
    if (sql.includes('FROM mcp_agents')) return { rows: state.agents };
    if (sql.includes('FROM mcp_service_bundles')) return { rows: state.bundles };
    if (sql.includes('FROM mcp_user_agent_rules') || sql.includes('FROM mcp_group_agent_rules')) return { rows: state.rules };
    if (sql.startsWith('UPDATE argus_execution_grants')) stored.expires_at = new Date(args[1] * 1000);
    return { rows: [] };
  });
  const client = { query, release: jest.fn() };
  const pool = { connect: jest.fn<(...args: any[]) => any>().mockResolvedValue(client) };
  const audit = jest.fn<(...args: any[]) => any>().mockResolvedValue({});
  const input = { grant: signExecutionGrant(secret, claims), threadId: claims.rootTraceId, runId: randomUUID() };
  const renew = () => renewDevGrant(pool as never, secret, input, audit);
  return { claims, stored, state, query, audit, input, renew, pool };
}
describe('same-scope active Dev grant renewal', () => {
  it('renews an expired bearer without extending the old bearer or changing any scope/identity claim', async () => {
    const f = fixture(); const renewed = verifyExecutionGrant(secret, await f.renew());
    expect(() => verifyExecutionGrant(secret, f.input.grant)).toThrow('expired');
    expect(renewed).toEqual({ ...f.claims, iat: renewed.iat, exp: renewed.exp });
    expect(renewed.exp - renewed.iat).toBe(3600); expect(f.audit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain(f.input.grant);
    expect(f.query).toHaveBeenLastCalledWith('COMMIT');
  });
  it('repeated requests return the same lease without duplicate renewal/audit, but still recheck revocation', async () => {
    const f = fixture(); expect(await f.renew()).toBe(await f.renew()); expect(f.audit).toHaveBeenCalledTimes(1);
    f.stored.status = 'revoked'; await expect(f.renew()).rejects.toThrow('no longer renewable');
  });
  it('fails closed for inactive run, changed owner, scope, disabled user, permissions and agent denials', async () => {
    const mutations = [
      (f: ReturnType<typeof fixture>) => { f.state.thread = null; },
      (f: ReturnType<typeof fixture>) => { f.state.thread.metadata.execution_grant_id = randomUUID(); },
      (f: ReturnType<typeof fixture>) => { f.state.thread.metadata.execution_principal = 'user:4'; },
      (f: ReturnType<typeof fixture>) => { f.stored.status = 'revoked'; },
      (f: ReturnType<typeof fixture>) => { f.stored.bundle_ids = [50]; },
      (f: ReturnType<typeof fixture>) => { f.stored.workspace_key = 'other'; },
      (f: ReturnType<typeof fixture>) => { f.state.user = null; },
      (f: ReturnType<typeof fixture>) => { f.state.user.role = 'viewer'; },
      (f: ReturnType<typeof fixture>) => { f.state.user.allowed_bundles = [3]; },
      (f: ReturnType<typeof fixture>) => { f.state.rules = [{ agent_id: 2, effect: 'deny' }]; },
      (f: ReturnType<typeof fixture>) => { f.state.agents = []; },
      (f: ReturnType<typeof fixture>) => { f.state.bundles = []; },
    ];
    for (const mutate of mutations) {
      const f = fixture(); mutate(f); await expect(f.renew()).rejects.toThrow();
      expect(f.audit).not.toHaveBeenCalled(); expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
    }
  });
  it('rejects a forged signature before DB access and rolls back if audit fails', async () => {
    const f = fixture(); f.input.grant += 'forged'; await expect(f.renew()).rejects.toThrow(); expect(f.pool.connect).not.toHaveBeenCalled();
    const g = fixture(); g.audit.mockRejectedValue(new Error('audit unavailable')); await expect(g.renew()).rejects.toThrow('audit unavailable');
    expect(g.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
  it('requires a private service secret, not an SSO cookie or execution bearer alone', async () => {
    const f = fixture(); const route = createDevGrantRenewalRouter(f.pool as never, secret).stack[0]!.route!;
    const res: any = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
    await route.stack[0]!.handle({ header: () => '', body: f.input } as never, res, () => {});
    expect(res.status).toHaveBeenCalledWith(401); expect(f.pool.connect).not.toHaveBeenCalled();
  });
});
