import { describe, expect, it } from '@jest/globals';
import { repositoryCheckoutBlocker } from '../repositoryCheckout.js';

const target = { backend_id: 1, backend_name: 'gitea-demo', base_url: 'http://gitea:3000', config: { kind: 'gitea', owner: 'demo-demo', repo: 'gem-demo-work' } };
function pool(rows: unknown[]) { return { query: async (sql: string, args: unknown[]) => {
  expect(sql).not.toContain('auth_value');
  expect(args).toEqual([[47, 3, 4]]);
  return { rows };
} } as never; }
describe('repository checkout guard', () => {
  it('accepts one matching repository plus non-checkout bundles', async () => {
    expect(await repositoryCheckoutBlocker(pool([target, { ...target, config: { kind: 'mcp' }, backend_name: 'code-index' }]), [47, 3, 4], 'demo-demo/gem-demo-work')).toBeNull();
  });
  it('rejects mismatches and missing targets', async () => {
    expect(await repositoryCheckoutBlocker(pool([target]), [47, 3, 4], 'argus/sample')).toMatch(/does not match/);
    expect(await repositoryCheckoutBlocker(pool([]), [47, 3, 4])).toMatch(/no concrete/);
  });
  it('rejects ambiguous repositories independently of selection order', async () => {
    const other = { ...target, config: { kind: 'gitea', owner: 'argus', repo: 'sample' } };
    for (const rows of [[target, other], [other, target]]) {
      expect(await repositoryCheckoutBlocker(pool(rows), [47, 3, 4])).toMatch(/multiple/);
    }
  });
  it('deduplicates a shared target, but not equal repository names on different servers', async () => {
    expect(await repositoryCheckoutBlocker(pool([target, target]), [47, 3, 4])).toBeNull();
    expect(await repositoryCheckoutBlocker(pool([target, { ...target, base_url: 'http://other:3000' }]), [47, 3, 4])).toMatch(/multiple/);
  });
});
