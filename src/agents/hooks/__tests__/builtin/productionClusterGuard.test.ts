import { makeProductionClusterGuard } from '../../builtin/productionClusterGuard.js';
import type { HookContext } from '../../types.js';

function mockPool(
  agentRow: { production_cluster_access: boolean } | undefined,
  prodNames: string[] = ['prod', 'production'],
): never {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('mcp_platform_settings')) {
        // pg returns JSONB pre-parsed as native JS value.
        return { rows: [{ value: prodNames }] };
      }
      if (sql.includes('mcp_agents')) {
        return { rows: agentRow ? [agentRow] : [] };
      }
      return { rows: [] };
    }),
  } as never;
}

const ctxFor = (overrides: Partial<HookContext> = {}): HookContext => ({
  agentId: 42,
  agentName: 'k8s-ops',
  sessionId: 'sess1',
  toolName: 'k8s_apply',
  toolArgs: { target_cluster: 'prod', manifest: '...' },
  iteration: 1,
  agentDepth: 0,
  ...overrides,
});

describe('production-cluster-guard', () => {
  it('skips when enforce=false', async () => {
    const hook = makeProductionClusterGuard(
      mockPool({ production_cluster_access: false }),
      { enforce: () => false },
    );
    expect(await hook.preToolUse!(ctxFor())).toBeNull();
  });

  it('blocks destructive prod tool when agent lacks access', async () => {
    const hook = makeProductionClusterGuard(
      mockPool({ production_cluster_access: false }),
      { enforce: () => true },
    );
    const res = await hook.preToolUse!(ctxFor());
    expect((res as { block: string }).block).toMatch(/production-cluster-guard/);
  });

  it('allows when agent has production_cluster_access', async () => {
    const hook = makeProductionClusterGuard(
      mockPool({ production_cluster_access: true }),
      { enforce: () => true },
    );
    expect(await hook.preToolUse!(ctxFor())).toBeNull();
  });

  it('allows non-destructive tool on prod', async () => {
    const hook = makeProductionClusterGuard(
      mockPool({ production_cluster_access: false }),
      { enforce: () => true },
    );
    expect(
      await hook.preToolUse!(ctxFor({ toolName: 'k8s_get_pods' })),
    ).toBeNull();
  });

  it('detects prod via namespace', async () => {
    const hook = makeProductionClusterGuard(
      mockPool({ production_cluster_access: false }),
      { enforce: () => true },
    );
    const res = await hook.preToolUse!(
      ctxFor({ toolArgs: { namespace: 'prod-payments' } }),
    );
    expect((res as { block: string }).block).toMatch(/production-cluster-guard/);
  });

  it('detects workspace_exec kubectl apply prod', async () => {
    const hook = makeProductionClusterGuard(
      mockPool({ production_cluster_access: false }),
      { enforce: () => true },
    );
    const res = await hook.preToolUse!(
      ctxFor({
        toolName: 'workspace_exec',
        toolArgs: { cmd: 'kubectl apply -f deploy.yaml', target_cluster: 'prod' },
      }),
    );
    expect((res as { block: string }).block).toMatch(/production-cluster-guard/);
  });

  it('fails closed when agent row missing', async () => {
    const hook = makeProductionClusterGuard(
      mockPool(undefined),
      { enforce: () => true },
    );
    const res = await hook.preToolUse!(ctxFor());
    expect((res as { block: string }).block).toMatch(/production-cluster-guard/);
  });
});
