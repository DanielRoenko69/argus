import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { GlobalSearchInputError, normalizeGlobalSearchInput, searchWorkspaceResources } from '../globalSearch.js';

const user: SessionUser = {
  id: 7,
  username: 'alex',
  display_name: 'Alex',
  role: 'viewer',
  allowed_bundles: [3],
  entra_groups: [],
};
const scope = { tenantKey: 'tenant-a', workspaceKey: 'engineering' };

describe('global workspace search', () => {
  it('normalizes bounded inputs and rejects broad or malformed searches', () => {
    expect(normalizeGlobalSearchInput('  code   review ', '4')).toEqual({ query: 'code review', limit: 4 });
    expect(() => normalizeGlobalSearchInput('x', 5)).toThrow(GlobalSearchInputError);
    expect(() => normalizeGlobalSearchInput('x'.repeat(81), 5)).toThrow('80 characters');
    expect(() => normalizeGlobalSearchInput('agent', 11)).toThrow('between 1 and 10');
  });

  it('searches only readable resource families, preserves bundle scope and ranks exact labels first', async () => {
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      expect(params).toEqual(['planner', [3], 'tenant-a', 'engineering', 7]);
      expect(sql).toContain("position(lower($1) in lower(concat_ws(' ', candidate.name");
      expect(sql).not.toContain("LIKE '%' || lower($1)");
      if (sql.includes('FROM mcp_agents')) {
        expect(sql).toContain('candidate.bundle_ids && $2::int[]');
        return { rows: [
          { id: 2, name: 'planner_helper', label: 'Planner helper', description: 'Assists planning', status: 'Ready' },
          { id: 1, name: 'planner', label: 'Planner', description: 'Plans implementation work', status: 'Ready' },
        ] };
      }
      if (sql.includes('FROM mcp_workflows')) {
        expect(sql).toContain('scope.bundle_id = ANY($2::int[])');
        return { rows: [] };
      }
      if (sql.includes('FROM mcp_skills')) return { rows: [] };
      if (sql.includes('FROM mcp_rag_indexes')) return { rows: [] };
      if (sql.includes('FROM mcp_service_bundles')) {
        expect(sql).toContain('candidate.id = ANY($2::int[])');
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    let clock = 1_000;
    const result = await searchWorkspaceResources(
      { query } as unknown as pg.Pool,
      user,
      scope,
      { query: 'planner', limit: 2 },
      () => clock += 4,
    );

    expect(query).toHaveBeenCalledTimes(5);
    expect(result.results.map(item => item.title)).toEqual(['Planner', 'Planner helper']);
    expect(result.results[0]).toMatchObject({ type: 'agent', href: '/build/agents?agent=1', score: 100 });
    expect(result.durationMs).toBe(4);
  });

  it('does not query resource families without their read permission', async () => {
    const query = jest.fn(async () => ({ rows: [] }));
    const result = await searchWorkspaceResources(
      { query } as unknown as pg.Pool,
      { ...user, role: 'chat_user' },
      scope,
      { query: 'agent', limit: 5 },
      () => 1_000,
    );

    expect(query).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(result.counts).toEqual({});
  });

  it('binds every catalog query to the selected scope without leaking legacy catalogs', async () => {
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      expect(params.slice(2, 4)).toEqual(['tenant-b', 'operations']);
      if (sql.includes('FROM mcp_workflows')) {
        expect(sql).toContain('candidate.tenant_key = $3');
        expect(sql).toContain('candidate.workspace_key = $4');
      } else {
        expect(sql).toContain("$3::text = 'default' AND $4::text = 'default'");
      }
      return { rows: [] };
    });

    await searchWorkspaceResources(
      { query } as unknown as pg.Pool,
      user,
      { tenantKey: 'tenant-b', workspaceKey: 'operations' },
      { query: 'shared', limit: 5 },
    );
    expect(query).toHaveBeenCalledTimes(5);
  });
});
