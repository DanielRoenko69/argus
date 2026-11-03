import { describe, it, expect } from '@jest/globals';
import type pg from 'pg';
import { agentAccessGate, agentVisibleToRole, agentRoleGate } from '../agentStore.js';

// Minimal pool stub: agentRoleGate issues exactly one SELECT min_role query.
function poolReturning(rows: Array<{ min_role: string | null }>): pg.Pool {
  return { query: async () => ({ rows, rowCount: rows.length }) } as unknown as pg.Pool;
}

describe('agentVisibleToRole', () => {
  it('NULL/empty min_role → visible to every role', () => {
    for (const r of ['platform_admin','operations_admin','developer','agent_operator','viewer','chat_user', undefined]) {
      expect(agentVisibleToRole(null, r)).toBe(true);
      expect(agentVisibleToRole(undefined, r)).toBe(true);
      expect(agentVisibleToRole('', r)).toBe(true);
    }
  });

  it('min_role=developer → developer and higher pass, lower fail', () => {
    expect(agentVisibleToRole('developer', 'platform_admin')).toBe(true);
    expect(agentVisibleToRole('developer', 'operations_admin')).toBe(true);
    expect(agentVisibleToRole('developer', 'developer')).toBe(true);
    expect(agentVisibleToRole('developer', 'agent_operator')).toBe(false);
    expect(agentVisibleToRole('developer', 'viewer')).toBe(false);
    expect(agentVisibleToRole('developer', 'chat_user')).toBe(false);
  });

  it('undefined caller role maps to viewer (weight 10) and fails a developer gate (weight 30)', () => {
    expect(agentVisibleToRole('developer', undefined)).toBe(false);
  });

  it('legacy alias "admin" maps to platform_admin and passes any gate', () => {
    expect(agentVisibleToRole('developer', 'admin')).toBe(true);
  });

  it('unrecognized min_role falls back to viewer weight — chat_user blocked, viewer passes', () => {
    // normalizeRole() maps an unknown string to viewer (weight 10). A DB typo
    // therefore gates at viewer, never crashes. T3 rejects bad values at the write path.
    expect(agentVisibleToRole('develoer', 'chat_user')).toBe(false);
    expect(agentVisibleToRole('develoer', 'viewer')).toBe(true);
  });
});

describe('agentRoleGate (DB-backed verdict used by the use-gates)', () => {
  it("'not_found' when the agent row is missing", async () => {
    expect(await agentRoleGate(poolReturning([]), 8, 'platform_admin')).toBe('not_found');
  });

  it("'ok' for NULL min_role regardless of caller role", async () => {
    expect(await agentRoleGate(poolReturning([{ min_role: null }]), 8, 'chat_user')).toBe('ok');
  });

  it("'forbidden' when the caller role is below min_role", async () => {
    expect(await agentRoleGate(poolReturning([{ min_role: 'developer' }]), 8, 'chat_user')).toBe('forbidden');
    expect(await agentRoleGate(poolReturning([{ min_role: 'developer' }]), 8, 'viewer')).toBe('forbidden');
  });

  it("'ok' when the caller role meets or exceeds min_role", async () => {
    expect(await agentRoleGate(poolReturning([{ min_role: 'developer' }]), 8, 'developer')).toBe('ok');
    expect(await agentRoleGate(poolReturning([{ min_role: 'developer' }]), 8, 'platform_admin')).toBe('ok');
  });

  it("'forbidden' for an undefined caller role against a gated agent (fails closed as viewer)", async () => {
    expect(await agentRoleGate(poolReturning([{ min_role: 'developer' }]), 8, undefined)).toBe('forbidden');
  });
});

function accessPool(options: {
  agent?: Record<string, unknown>;
  userRules?: Array<{ agent_id: number; effect: 'allow' | 'deny' }>;
  groupRules?: Array<{ agent_id: number; effect: 'allow' | 'deny' }>;
} = {}): pg.Pool {
  const agent = options.agent ?? {
    id: 8, enabled: true, visibility: 'internal', min_role: null, bundle_ids: null,
  };
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM mcp_agents a')) return { rows: [agent] };
      if (sql.includes('FROM mcp_user_agent_rules')) return { rows: options.userRules ?? [] };
      if (sql.includes('FROM mcp_group_agent_rules')) return { rows: options.groupRules ?? [] };
      return { rows: [] };
    },
  } as unknown as pg.Pool;
}

describe('agentAccessGate (shared full execution boundary)', () => {
  it('allows an unrestricted authenticated agent', async () => {
    await expect(agentAccessGate(accessPool(), 8, {
      id: 4, role: 'developer', allowed_bundles: null, entra_groups: [],
    })).resolves.toMatchObject({ verdict: 'ok', agent: { id: 8 } });
  });

  it('blocks public agents for chat_user callers', async () => {
    const pool = accessPool({ agent: { id: 8, enabled: true, visibility: 'public', min_role: null, bundle_ids: null } });
    await expect(agentAccessGate(pool, 8, {
      id: 4, role: 'chat_user', allowed_bundles: null, entra_groups: [],
    })).resolves.toMatchObject({ verdict: 'forbidden' });
  });

  it('blocks bundle-incompatible agents and explicit deny rules', async () => {
    await expect(agentAccessGate(accessPool({ agent: { id: 8, enabled: true, visibility: 'internal', min_role: null, bundle_ids: [9] } }), 8, {
      id: 4, role: 'developer', allowed_bundles: [3], entra_groups: [],
    })).resolves.toMatchObject({ verdict: 'forbidden' });
    await expect(agentAccessGate(accessPool({ userRules: [{ agent_id: 8, effect: 'deny' }] }), 8, {
      id: 4, role: 'developer', allowed_bundles: null, entra_groups: [],
    })).resolves.toMatchObject({ verdict: 'forbidden' });
  });

  it('enforces bundle scope for service identities without applying end-user policies', async () => {
    await expect(agentAccessGate(accessPool({ agent: { id: 8, enabled: true, visibility: 'internal', min_role: null, bundle_ids: [9] } }), 8, {
      id: 0, role: 'platform_admin', allowed_bundles: [3], entra_groups: [], service: true,
    })).resolves.toMatchObject({ verdict: 'forbidden' });

    await expect(agentAccessGate(accessPool({ agent: { id: 8, enabled: true, visibility: 'internal', min_role: null, bundle_ids: [9] } }), 8, {
      id: 0, role: 'platform_admin', allowed_bundles: [9], entra_groups: [], service: true,
    })).resolves.toMatchObject({ verdict: 'ok' });
  });

  it('allows a signed execution grant to select an agent outside its persistent bundle assignment', async () => {
    await expect(agentAccessGate(accessPool({ agent: { id: 8, enabled: true, visibility: 'internal', min_role: null, bundle_ids: [9] } }), 8, {
      id: 0, role: 'platform_admin', allowed_bundles: [3], entra_groups: [], service: true,
    }, { allowServiceBundleOverride: true })).resolves.toMatchObject({ verdict: 'ok' });
  });
});
