import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { getNativeDependencyMap } from '../nativeDependencyMap.js';

describe('native dependency map', () => {
  it('merges configured workflow topology with observed runtime calls', async () => {
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('FROM mcp_agents ORDER BY')) return { rows: [{ id: 7, name: 'planner', label: 'Planner', model: 'gpt-5.1', enabled: true }] };
      if (text.includes('FROM mcp_workflows ORDER BY')) return { rows: [{
        id: 4, name: 'release_guard', enabled: true,
        steps: [
          { id: 'plan', label: 'Plan', type: 'argus.agent', agent_id: 7, args: {} },
          { id: 'pods', label: 'Pods', type: 'argus.tool', tool: 'kubernetes_get_pods', args: {} },
        ],
      }] };
      if (text.includes('FROM mcp_agent_rag_indexes')) return { rows: [] };
      if (text.includes('FROM mcp_observability_spans')) return { rows: [{
        trace_kind: 'agent', agent_id: 7, agent_name: 'planner', workflow_id: null, workflow_name: null,
        span_kind: 'llm', model: 'gpt-5.1', provider: 'openai', tool_name: null, calls: '12', failures: '1',
      }] };
      if (text.includes('FROM mcp_observability_traces child')) return { rows: [{
        parent_kind: 'workflow', parent_agent_id: null, parent_agent_name: null,
        parent_workflow_id: 4, parent_workflow_name: 'release_guard',
        child_kind: 'agent', child_agent_id: 7, child_agent_name: 'planner',
        child_workflow_id: null, child_workflow_name: null, calls: '2', failures: '0',
      }] };
      return { rows: [] };
    });
    const result = await getNativeDependencyMap({ query } as unknown as pg.Pool, 24, [{
      id: 'agent:7', kind: 'agent', name: 'planner', detail: '', state: 'degraded', executions: 12,
      failures: 1, successRate: 91.7, p95DurationMs: 2000, costUsd: 1,
    }]);
    expect(result.nodes.map(node => node.id)).toEqual(expect.arrayContaining(['workflow:4', 'agent:7', 'model:gpt-5.1', 'tool:kubernetes_get_pods']));
    expect(result.nodes.find(node => node.id === 'agent:7')?.state).toBe('degraded');
    expect(result.edges.find(edge => edge.source === 'agent:7' && edge.target === 'model:gpt-5.1')?.evidence).toBe('both');
    expect(result.edges.find(edge => edge.source === 'workflow:4' && edge.target === 'agent:7')?.evidence).toBe('both');
    expect(result.edges.find(edge => edge.source === 'workflow:4' && edge.target === 'agent:7')?.calls).toBe(2);
    expect(result.summary.observedEdges).toBe(2);
  });
});
