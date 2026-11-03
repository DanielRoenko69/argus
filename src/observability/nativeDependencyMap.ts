import type pg from 'pg';
import type { WorkflowStep } from '../workflows/types.js';
import type { NativeServiceHealthComponent, NativeServiceHealthState } from './nativeServiceHealth.js';

export type NativeDependencyNodeKind = 'workflow' | 'agent' | 'model' | 'tool' | 'knowledge';
export type NativeDependencyEvidence = 'configured' | 'observed' | 'both';

export interface NativeDependencyNode {
  id: string;
  kind: NativeDependencyNodeKind;
  name: string;
  detail: string;
  state: NativeServiceHealthState;
  calls: number;
  failures: number;
}

export interface NativeDependencyEdge {
  id: string;
  source: string;
  target: string;
  relation: 'invokes' | 'calls' | 'uses' | 'queries';
  evidence: NativeDependencyEvidence;
  calls: number;
  failures: number;
}

interface AgentRow { id: number; name: string; label: string | null; model: string; enabled: boolean }
interface WorkflowRow { id: number; name: string; enabled: boolean; steps: WorkflowStep[] }
interface KnowledgeRow { id: number; name: string; label: string | null; provider: string; enabled: boolean; agent_id: number }
interface ObservedRow {
  trace_kind: string;
  agent_id: number | null;
  agent_name: string | null;
  workflow_id: number | null;
  workflow_name: string | null;
  span_kind: string;
  model: string | null;
  provider: string | null;
  tool_name: string | null;
  calls: string;
  failures: string;
}
interface ObservedInvocationRow {
  parent_kind: string;
  parent_agent_id: number | null;
  parent_agent_name: string | null;
  parent_workflow_id: number | null;
  parent_workflow_name: string | null;
  child_kind: string;
  child_agent_id: number | null;
  child_agent_name: string | null;
  child_workflow_id: number | null;
  child_workflow_name: string | null;
  calls: string;
  failures: string;
}

function componentState(
  components: NativeServiceHealthComponent[],
  kind: NativeDependencyNodeKind,
  name: string,
): NativeServiceHealthState {
  if (kind === 'knowledge') return 'no_data';
  return components.find(component => component.kind === kind && component.name === name)?.state ?? 'no_data';
}

export async function getNativeDependencyMap(
  pool: pg.Pool,
  hours: number,
  healthComponents: NativeServiceHealthComponent[],
): Promise<{
  nodes: NativeDependencyNode[];
  edges: NativeDependencyEdge[];
  summary: { nodes: number; edges: number; configuredEdges: number; observedEdges: number; unhealthyNodes: number };
}> {
  const windowHours = Math.max(1, Math.min(hours, 24 * 90));
  const [agentResult, workflowResult, knowledgeResult, observedResult, invocationResult] = await Promise.all([
    pool.query<AgentRow>('SELECT id, name, label, model, enabled FROM mcp_agents ORDER BY enabled DESC, name'),
    pool.query<WorkflowRow>('SELECT id, name, enabled, steps FROM mcp_workflows ORDER BY enabled DESC, name'),
    pool.query<KnowledgeRow>(
      `SELECT rag.id, rag.name, rag.label, rag.provider, rag.enabled, assignment.agent_id
         FROM mcp_agent_rag_indexes assignment
         JOIN mcp_rag_indexes rag ON rag.id=assignment.rag_index_id
        WHERE rag.enabled
        ORDER BY rag.name`,
    ),
    pool.query<ObservedRow>(
      `SELECT trace.kind AS trace_kind,
              trace.agent_id,
              COALESCE(agent.name, trace.metadata->>'agent_name') AS agent_name,
              workflow_execution.workflow_id,
              workflow.name AS workflow_name,
              span.kind AS span_kind,
              span.model,
              span.provider,
              span.tool_name,
              count(*)::text AS calls,
              count(*) FILTER (WHERE span.status='failed')::text AS failures
         FROM mcp_observability_spans span
         JOIN mcp_observability_traces trace ON trace.id=span.trace_id
         LEFT JOIN mcp_agents agent ON agent.id=trace.agent_id
         LEFT JOIN mcp_workflow_executions workflow_execution ON workflow_execution.id=trace.workflow_execution_id
         LEFT JOIN mcp_workflows workflow ON workflow.id=workflow_execution.workflow_id
        WHERE span.started_at >= now() - interval '1 hour' * $1
          AND span.kind IN ('llm','tool')
        GROUP BY trace.kind, trace.agent_id, COALESCE(agent.name, trace.metadata->>'agent_name'),
                 workflow_execution.workflow_id, workflow.name, span.kind, span.model, span.provider, span.tool_name`,
      [windowHours],
    ),
    pool.query<ObservedInvocationRow>(
      `SELECT parent.kind AS parent_kind,
              parent.agent_id AS parent_agent_id,
              COALESCE(parent_agent.name, parent.metadata->>'agent_name') AS parent_agent_name,
              parent_workflow_execution.workflow_id AS parent_workflow_id,
              parent_workflow.name AS parent_workflow_name,
              child.kind AS child_kind,
              child.agent_id AS child_agent_id,
              COALESCE(child_agent.name, child.metadata->>'agent_name') AS child_agent_name,
              child_workflow_execution.workflow_id AS child_workflow_id,
              child_workflow.name AS child_workflow_name,
              count(*)::text AS calls,
              count(*) FILTER (WHERE child.status='failed')::text AS failures
         FROM mcp_observability_traces child
         JOIN mcp_observability_traces parent ON parent.id=child.parent_trace_id
         LEFT JOIN mcp_agents parent_agent ON parent_agent.id=parent.agent_id
         LEFT JOIN mcp_workflow_executions parent_workflow_execution
           ON parent_workflow_execution.id=parent.workflow_execution_id
         LEFT JOIN mcp_workflows parent_workflow ON parent_workflow.id=parent_workflow_execution.workflow_id
         LEFT JOIN mcp_agents child_agent ON child_agent.id=child.agent_id
         LEFT JOIN mcp_workflow_executions child_workflow_execution
           ON child_workflow_execution.id=child.workflow_execution_id
         LEFT JOIN mcp_workflows child_workflow ON child_workflow.id=child_workflow_execution.workflow_id
        WHERE child.started_at >= now() - interval '1 hour' * $1
          AND parent.kind IN ('agent','workflow')
          AND child.kind IN ('agent','workflow')
        GROUP BY parent.kind, parent.agent_id,
                 COALESCE(parent_agent.name, parent.metadata->>'agent_name'),
                 parent_workflow_execution.workflow_id, parent_workflow.name,
                 child.kind, child.agent_id,
                 COALESCE(child_agent.name, child.metadata->>'agent_name'),
                 child_workflow_execution.workflow_id, child_workflow.name`,
      [windowHours],
    ),
  ]);

  const nodes = new Map<string, NativeDependencyNode>();
  const edges = new Map<string, NativeDependencyEdge>();
  const addNode = (id: string, kind: NativeDependencyNodeKind, name: string, detail: string, calls = 0, failures = 0) => {
    const current = nodes.get(id);
    if (current) {
      current.calls += calls;
      current.failures += failures;
      if (current.detail === 'Runtime dependency' && detail !== current.detail) current.detail = detail;
      return;
    }
    nodes.set(id, { id, kind, name, detail, state: componentState(healthComponents, kind, name), calls, failures });
  };
  const addEdge = (
    source: string,
    target: string,
    relation: NativeDependencyEdge['relation'],
    evidence: Exclude<NativeDependencyEvidence, 'both'>,
    calls = 0,
    failures = 0,
  ) => {
    const id = `${source}->${target}:${relation}`;
    const current = edges.get(id);
    if (current) {
      if (current.evidence !== evidence) current.evidence = 'both';
      current.calls += calls;
      current.failures += failures;
      return;
    }
    edges.set(id, { id, source, target, relation, evidence, calls, failures });
  };

  const agentById = new Map(agentResult.rows.map(agent => [agent.id, agent]));
  const workflowById = new Map(workflowResult.rows.map(workflow => [workflow.id, workflow]));
  for (const agent of agentResult.rows) {
    const agentNode = `agent:${agent.id}`;
    const modelNode = `model:${agent.model}`;
    addNode(agentNode, 'agent', agent.name, agent.enabled ? agent.label || 'Argus agent' : 'Disabled agent');
    addNode(modelNode, 'model', agent.model, 'Configured model');
    addEdge(agentNode, modelNode, 'uses', 'configured');
  }
  for (const workflow of workflowResult.rows) {
    const workflowNode = `workflow:${workflow.id}`;
    addNode(workflowNode, 'workflow', workflow.name, workflow.enabled ? 'Argus workflow' : 'Disabled workflow');
    for (const step of workflow.steps ?? []) {
      const type = step.type ?? 'argus.tool';
      if (type === 'argus.agent' && step.agent_id) {
        const agent = agentById.get(step.agent_id);
        const target = `agent:${step.agent_id}`;
        addNode(target, 'agent', agent?.name ?? `Agent #${step.agent_id}`, agent?.label || 'Workflow agent');
        addEdge(workflowNode, target, 'invokes', 'configured');
      } else if ((type === 'argus.tool' || type === 'tool') && step.tool) {
        const target = `tool:${step.tool}`;
        addNode(target, 'tool', step.tool, 'Workflow capability');
        addEdge(workflowNode, target, 'calls', 'configured');
      } else if (type === 'argus.knowledge') {
        const indexName = String(step.args?.['index_name'] ?? '').trim();
        if (indexName) {
          const target = `knowledge:${indexName}`;
          addNode(target, 'knowledge', indexName, 'Workflow knowledge source');
          addEdge(workflowNode, target, 'queries', 'configured');
        }
      } else if (type === 'argus.workflow') {
        const targetId = Number(step.args?.['target_workflow_id'] ?? step.args?.['workflow_id'] ?? step.args?.['target_id'] ?? 0);
        if (targetId) {
          const targetWorkflow = workflowById.get(targetId);
          const target = `workflow:${targetId}`;
          addNode(target, 'workflow', targetWorkflow?.name ?? `Workflow #${targetId}`, 'Sub-workflow');
          addEdge(workflowNode, target, 'invokes', 'configured');
        }
      }
    }
  }
  for (const knowledge of knowledgeResult.rows) {
    const source = `agent:${knowledge.agent_id}`;
    const agent = agentById.get(knowledge.agent_id);
    const target = `knowledge:${knowledge.name}`;
    addNode(source, 'agent', agent?.name ?? `Agent #${knowledge.agent_id}`, agent?.label || 'Argus agent');
    addNode(target, 'knowledge', knowledge.label || knowledge.name, knowledge.provider);
    addEdge(source, target, 'queries', 'configured');
  }

  for (const observed of observedResult.rows) {
    const source = observed.trace_kind === 'agent' && observed.agent_id
      ? `agent:${observed.agent_id}`
      : observed.trace_kind === 'workflow' && observed.workflow_id
        ? `workflow:${observed.workflow_id}`
        : null;
    if (!source) continue;
    const sourceKind = observed.trace_kind === 'agent' ? 'agent' : 'workflow';
    const sourceName = sourceKind === 'agent'
      ? observed.agent_name ?? `Agent #${observed.agent_id}`
      : observed.workflow_name ?? `Workflow #${observed.workflow_id}`;
    addNode(source, sourceKind, sourceName, 'Observed runtime');
    const calls = Number(observed.calls);
    const failures = Number(observed.failures);
    if (observed.span_kind === 'llm' && observed.model) {
      const target = `model:${observed.model}`;
      addNode(target, 'model', observed.model, observed.provider || 'Observed model', calls, failures);
      addEdge(source, target, 'uses', 'observed', calls, failures);
    } else if (observed.span_kind === 'tool' && observed.tool_name) {
      const target = `tool:${observed.tool_name}`;
      addNode(target, 'tool', observed.tool_name, 'Observed capability', calls, failures);
      addEdge(source, target, 'calls', 'observed', calls, failures);
    }
  }

  for (const invocation of invocationResult.rows) {
    const source = invocation.parent_kind === 'agent' && invocation.parent_agent_id
      ? `agent:${invocation.parent_agent_id}`
      : invocation.parent_kind === 'workflow' && invocation.parent_workflow_id
        ? `workflow:${invocation.parent_workflow_id}`
        : null;
    const target = invocation.child_kind === 'agent' && invocation.child_agent_id
      ? `agent:${invocation.child_agent_id}`
      : invocation.child_kind === 'workflow' && invocation.child_workflow_id
        ? `workflow:${invocation.child_workflow_id}`
        : null;
    if (!source || !target) continue;
    const sourceKind = invocation.parent_kind as 'agent' | 'workflow';
    const targetKind = invocation.child_kind as 'agent' | 'workflow';
    const sourceName = sourceKind === 'agent'
      ? invocation.parent_agent_name ?? `Agent #${invocation.parent_agent_id}`
      : invocation.parent_workflow_name ?? `Workflow #${invocation.parent_workflow_id}`;
    const targetName = targetKind === 'agent'
      ? invocation.child_agent_name ?? `Agent #${invocation.child_agent_id}`
      : invocation.child_workflow_name ?? `Workflow #${invocation.child_workflow_id}`;
    const calls = Number(invocation.calls);
    const failures = Number(invocation.failures);
    addNode(source, sourceKind, sourceName, 'Observed runtime');
    addNode(target, targetKind, targetName, 'Observed nested execution', calls, failures);
    addEdge(source, target, 'invokes', 'observed', calls, failures);
  }

  const nodeList = [...nodes.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
  const edgeList = [...edges.values()].sort((left, right) => right.failures - left.failures || right.calls - left.calls || left.id.localeCompare(right.id));
  return {
    nodes: nodeList,
    edges: edgeList,
    summary: {
      nodes: nodeList.length,
      edges: edgeList.length,
      configuredEdges: edgeList.filter(edge => edge.evidence === 'configured' || edge.evidence === 'both').length,
      observedEdges: edgeList.filter(edge => edge.evidence === 'observed' || edge.evidence === 'both').length,
      unhealthyNodes: nodeList.filter(node => node.state === 'degraded' || node.state === 'critical').length,
    },
  };
}
