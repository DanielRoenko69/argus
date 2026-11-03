import { describe, expect, it } from '@jest/globals';
import { loadRepositoryIssue } from '../repositoryIssueService.js';
import { GITEA_ISSUE_TEMPLATE } from '../repositoryIssue.js';

const row = { id: 1, backend_id: 1, name: 'gitea_demo', backend_name: 'gitea_demo', base_url: 'http://gitea:3000', config: { kind: 'gitea', owner: 'team', repo_slug: 'repo' }, tool_name: 'gitea_demo_get_issue' };
function pool(targets = [row], tools = [row], allowed: string[] = []) {
  return { query: async (sql: string, args: unknown[]) => {
    expect(sql).not.toContain('auth_value');
    if (sql.includes('WITH dynamic_candidates')) return { rows: allowed.map(name => ({ name })) };
    if (sql.includes('t.query_template')) {
      expect(sql).toContain('t.enabled=true'); expect(sql).toContain('COALESCE(t.is_write,false)=false');
      expect(args).toEqual([[47], GITEA_ISSUE_TEMPLATE]); return { rows: tools };
    }
    return { rows: targets };
  } } as never;
}
const input = { bundleIds: [47], reference: '5', rootTraceId: 'test' };
describe('issue MCP selection fails before provider invocation', () => {
  it('requires the selected Bundle tool policy', async () => {
    await expect(loadRepositoryIssue(pool(), {} as never, input)).rejects.toMatchObject({ status: 403 });
  });
  it('intersects the signed exact tool list', async () => {
    await expect(loadRepositoryIssue(pool([row], [row], [row.tool_name]), {} as never, { ...input, allowedTools: [] })).rejects.toMatchObject({ status: 403 });
  });
  it('rejects duplicate tools and multiple checkouts', async () => {
    await expect(loadRepositoryIssue(pool([row], [row, row], [row.tool_name]), {} as never, input)).rejects.toMatchObject({ status: 403 });
    await expect(loadRepositoryIssue(pool([row, { ...row, base_url: 'http://another' }]), {} as never, input)).rejects.toMatchObject({ status: 422 });
  });
});
