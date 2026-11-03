import { describe, expect, it } from '@jest/globals';
import type { ToolDef } from '../toolSearch.js';
import {
  extractRequestedFileTargets,
  solutionPackToolCatalogPrompt,
  scopeSolutionPackWorkerTools,
  validateExecutionResourceScopeCall,
} from '../solutionPackToolScope.js';

function tool(name: string): ToolDef {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
  };
}

const catalog = [
  tool('workspace_ls'),
  tool('workspace_read'),
  tool('workspace_write'),
  tool('workspace_exec'),
  tool('gitea_get_issue'),
  tool('langgraph_run'),
];

describe('scopeSolutionPackWorkerTools', () => {
  it('gives implementation workers only list, read and write access', () => {
    expect(scopeSolutionPackWorkerTools(catalog, 'implement_ticket')?.map(item => item.function.name))
      .toEqual(['workspace_ls', 'workspace_read', 'workspace_write']);
  });

  it('gives test workers execution access but no write access', () => {
    expect(scopeSolutionPackWorkerTools(catalog, 'run_tests')?.map(item => item.function.name))
      .toEqual(['workspace_ls', 'workspace_read', 'workspace_exec']);
  });

  it('defers unknown tasks to the normal worker tool search', () => {
    expect(scopeSolutionPackWorkerTools(catalog, 'review_pr')).toBeNull();
    expect(scopeSolutionPackWorkerTools(catalog, undefined)).toBeNull();
  });
});

describe('extractRequestedFileTargets', () => {
  it('counts positive ticket targets and ignores forbidden files and later plan context', () => {
    const message =
      'Ticket request:\nDo not create src/index.js. Modify src/app.js and test/app.test.js.\n\n' +
      'Plan:\nInspect docs/architecture.md and package metadata.';
    expect(extractRequestedFileTargets(message)).toEqual(['src/app.js', 'test/app.test.js']);
  });
});

describe('solutionPackToolCatalogPrompt', () => {
  it('advertises only exact post-policy names for text-only runtimes', () => {
    const prompt = solutionPackToolCatalogPrompt([
      tool('aiops_prometheus_query'),
      tool('aiops_prometheus_targets'),
    ]);
    expect(prompt).toContain('aiops_prometheus_query(none)');
    expect(prompt).toContain('aiops_prometheus_targets(none)');
    expect(prompt).toContain('"name":"EXACT_NAME_FROM_THE_LIST"');
    expect(prompt).not.toContain('workspace_exec');
  });

  it('forbids evidence claims when the signed catalog is empty', () => {
    expect(solutionPackToolCatalogPrompt([])).toMatch(/No tools are authorized.*Do not claim/s);
  });
});

describe('validateExecutionResourceScopeCall', () => {
  const scope = {
    kind: 'kubernetes' as const,
    backendId: 7,
    targetId: 'local-kind',
    cluster: 'argus-aiops',
    namespace: 'argus-demo',
    environment: 'local-demo',
  };

  it('allows only the namespace signed into a Kubernetes execution grant', () => {
    expect(validateExecutionResourceScopeCall(
      'aiops_kubernetes_k8s_get_resources',
      { namespace: 'argus-demo', resource_type: 'pods' },
      scope,
    )).toBeNull();
    expect(validateExecutionResourceScopeCall(
      'aiops_kubernetes_k8s_get_resources',
      { namespace: 'kube-system', resource_type: 'pods' },
      scope,
    )).toMatch(/must use the signed Kubernetes namespace 'argus-demo'/);
  });

  it('rejects cluster-wide Kubernetes calls and ignores unrelated providers', () => {
    expect(validateExecutionResourceScopeCall(
      'aiops_kubernetes_k8s_get_events',
      { namespace: 'argus-demo', all_namespaces: true },
      scope,
    )).toMatch(/cannot request all Kubernetes namespaces/);
    expect(validateExecutionResourceScopeCall('aiops_prometheus_query', { query: 'up' }, scope)).toBeNull();
  });
});
