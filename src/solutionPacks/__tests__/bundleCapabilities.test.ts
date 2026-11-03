import { describe, expect, it } from '@jest/globals';
import { checkBundleCapabilities } from '../bundleCapabilities.js';

function poolFor(rows: {
  bundles?: Array<{ id: number; name: string }>;
  backends?: Array<{
    bundle_id: number;
    signal: string;
    backend_id?: number;
    backend_name?: string;
    backend_type?: 'http' | 'mcp' | 'builtin';
    enabled?: boolean;
    trust_status?: 'unverified' | 'trusted' | 'changed' | 'quarantined' | null;
    config?: Record<string, unknown> | null;
  }>;
  tools?: Array<{ bundle_id: number; signal: string }>;
  toolBackends?: Array<{ backend_id: number }>;
}) {
  return {
    query: async (sql: string) => {
      const normalized = String(sql).toUpperCase();
      if (normalized.includes('REQUIRED_TOOL_BACKEND_SCOPE')) return { rows: rows.toolBackends ?? [] };
      if (normalized.includes('FROM MCP_SERVICE_BUNDLES')) return { rows: rows.bundles ?? [] };
      if (normalized.includes('FROM MCP_TOOL_BUNDLES TB')) return { rows: rows.tools ?? [] };
      if (normalized.includes('FROM MCP_BACKEND_BUNDLES BB')) return { rows: rows.backends ?? [] };
      return { rows: rows.tools ?? [] };
    },
  } as never;
}

describe('MCP Fabric bundle capability preflight', () => {
  it('recognizes a Gitea bundle as repository and CI capable', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [{ id: 3, name: 'argus-dev-demo' }],
        backends: [{ bundle_id: 3, signal: 'gitea_local http' }],
      }),
      [3],
      ['repository', 'ci'],
    );

    expect(result).toMatchObject({ ok: true, provided: ['repository', 'ci'], missing: [], operationalBlockers: [] });
  });

  it('distinguishes a concrete Git checkout source from repository MCP tools', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [
          { id: 3, name: 'argus-dev-demo' },
          { id: 7, name: 'github-tools' },
        ],
        backends: [
          {
            bundle_id: 3,
            signal: 'gitea_local http repository ci',
            config: { kind: 'gitea', owner: 'argus', repo_slug: 'argus-dev-sample' },
          },
          {
            bundle_id: 7,
            signal: 'github repository actions ci',
            config: {},
          },
        ],
      }),
      [3, 7],
      ['repository', 'repository-checkout', 'ci'],
    );

    expect(result.ok).toBe(true);
    expect(result.bundles.find(bundle => bundle.bundleId === 3)?.categories)
      .toEqual(expect.arrayContaining(['repository', 'repository-checkout', 'ci']));
    expect(result.bundles.find(bundle => bundle.bundleId === 7)?.categories)
      .not.toContain('repository-checkout');
  });

  it('blocks a coding workspace when only remote repository tools are selected', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [{ id: 7, name: 'github-tools' }],
        backends: [{ bundle_id: 7, signal: 'github repository actions ci' }],
      }),
      [7],
      ['repository', 'repository-checkout', 'ci'],
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['repository-checkout']);
  });

  it('blocks preflight when a selected Bundle connection is disabled', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [{ id: 3, name: 'argus-dev-demo' }],
        backends: [
          { bundle_id: 3, signal: 'gitea_local http', backend_id: 5, backend_name: 'gitea_local', backend_type: 'http', enabled: true },
          { bundle_id: 3, signal: 'langgraph_local http', backend_id: 8, backend_name: 'langgraph_local', backend_type: 'http', enabled: false },
        ],
      }),
      [3],
      ['repository', 'ci'],
    );

    expect(result).toMatchObject({
      ok: false,
      missing: [],
      operationalBlockers: ["argus-dev-demo: connection 'langgraph_local' is disabled"],
      operationalIssues: [{
        bundleId: 3,
        bundleName: 'argus-dev-demo',
        backendId: 8,
        backendName: 'langgraph_local',
        kind: 'connection_disabled',
        recovery: 'enable_connection',
        message: "argus-dev-demo: connection 'langgraph_local' is disabled",
      }],
    });
  });

  it('returns a machine-readable catalog review target when MCP trust changed', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [{ id: 7, name: 'coding-ops' }],
        backends: [{
          bundle_id: 7,
          signal: 'github repository actions ci',
          backend_id: 208,
          backend_name: 'github_argus_core',
          backend_type: 'mcp',
          enabled: true,
          trust_status: 'changed',
        }],
      }),
      [7],
      ['repository', 'ci'],
    );

    expect(result).toMatchObject({
      ok: false,
      missing: [],
      operationalIssues: [{
        backendId: 208,
        backendName: 'github_argus_core',
        kind: 'catalog_changed',
        recovery: 'review_catalog',
      }],
    });
  });

  it('scopes operational blockers to backends owning explicitly requested tools', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [{ id: 28, name: 'argus-aiops-observe' }],
        backends: [
          { bundle_id: 28, signal: 'prometheus metrics', backend_id: 24, backend_name: 'aiops-prometheus', backend_type: 'http', enabled: true },
          { bundle_id: 28, signal: 'kubernetes runtime', backend_id: 42, backend_name: 'aiops-kubernetes', backend_type: 'mcp', enabled: true, trust_status: 'changed' },
        ],
        toolBackends: [{ backend_id: 24 }],
      }),
      [28],
      ['metrics'],
      { requiredToolNames: ['aiops_prometheus_query'] },
    );

    expect(result).toMatchObject({ ok: true, missing: [], operationalBlockers: [], operationalIssues: [] });
  });

  it('reports missing categories instead of issuing an incomplete scope', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [{ id: 7, name: 'plain-workspace' }],
        backends: [{ bundle_id: 7, signal: 'filesystem workspace' }],
      }),
      [7],
      ['repository', 'ci'],
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['repository', 'ci']);
  });

  it('recognizes provider-neutral AIOps evidence and runtime categories', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [{ id: 11, name: 'aiops-observe' }],
        backends: [
          { bundle_id: 11, signal: 'prometheus production metrics promql' },
          { bundle_id: 11, signal: 'grafana loki logging logql' },
          { bundle_id: 11, signal: 'tempo distributed tracing traceql' },
          { bundle_id: 11, signal: 'kubernetes k8s runtime' },
          { bundle_id: 11, signal: 'backstage service catalog topology' },
          { bundle_id: 11, signal: 'pagerduty incident on-call' },
        ],
      }),
      [11],
      ['metrics', 'logs', 'traces', 'runtime', 'topology', 'incident'],
    );

    expect(result.ok).toBe(true);
    expect(result.provided).toEqual(expect.arrayContaining([
      'metrics', 'logs', 'traces', 'runtime', 'topology', 'incident',
    ]));
    expect(result.missing).toEqual([]);
  });

  it('fails closed when an AIOps workflow requests an unknown category', async () => {
    const result = await checkBundleCapabilities(
      poolFor({
        bundles: [{ id: 12, name: 'prometheus-readonly' }],
        backends: [{ bundle_id: 12, signal: 'prometheus metrics' }],
      }),
      [12],
      ['metrics', 'future-aiops-capability'],
    );

    expect(result.ok).toBe(false);
    expect(result.provided).toContain('metrics');
    expect(result.missing).toEqual(['future-aiops-capability']);
  });
});
