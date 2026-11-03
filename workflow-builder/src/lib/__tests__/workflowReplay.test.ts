import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import type { WorkflowReplay } from '@/api/replay';
import { decorateWorkflowReplay } from '../workflowReplay';

const nodes: Node[] = ['start', 'route', 'planner', 'reviewer', 'response'].map((id) => ({
  id, type: id === 'route' ? 'logic.router' : 'argus.agent', position: { x: 0, y: 0 }, data: {},
}));
const edges: Edge[] = [
  ['start-route', 'start', 'route'],
  ['route-planner', 'route', 'planner'],
  ['route-reviewer', 'route', 'reviewer'],
  ['planner-response', 'planner', 'response'],
  ['reviewer-response', 'reviewer', 'response'],
].map(([id, source, target]) => ({ id, source, target }));

const withoutRuntimeEvidence = {
  agentRole: null, agentId: null, agentName: null, traceId: null, sessionId: null,
  runtimeRunId: null, telemetryStatus: null, model: null, provider: null,
  runtimeType: null, runtimeProfile: null, reasoningEffort: null,
};

const replay: WorkflowReplay = {
  traceId: '927d3c7a-4b82-4693-bf67-9e96159990c1', status: 'completed', currentStage: 'response', completed: true,
  canCancel: false, approval: null,
  steps: {
    start: { ...withoutRuntimeEvidence, id: 'start', label: 'Start', type: 'trigger.manual', status: 'completed', result: '', durationMs: 0, selectedTarget: null },
    route: { ...withoutRuntimeEvidence, id: 'route', label: 'Route', type: 'logic.router', status: 'completed', result: 'plan', durationMs: 1, selectedTarget: 'planner' },
    planner: { ...withoutRuntimeEvidence, id: 'planner', label: 'Planner', type: 'argus.agent', status: 'completed', result: 'ok', durationMs: 50, selectedTarget: null },
    reviewer: { ...withoutRuntimeEvidence, id: 'reviewer', label: 'Reviewer', type: 'argus.agent', status: 'skipped', result: 'not selected', durationMs: 0, selectedTarget: null },
    response: { ...withoutRuntimeEvidence, id: 'response', label: 'Response', type: 'logic.response', status: 'completed', result: 'done', durationMs: 1, selectedTarget: null },
  },
};

describe('decorateWorkflowReplay', () => {
  it('highlights the traversed route and dims the skipped branch without mutating the saved graph', () => {
    const decorated = decorateWorkflowReplay(nodes, edges, replay);
    expect(decorated.nodes.find((node) => node.id === 'planner')?.className).toContain('is-replay-completed');
    expect(decorated.nodes.find((node) => node.id === 'reviewer')?.className).toContain('is-replay-skipped');
    expect(decorated.edges.map((edge) => [edge.id, edge.data?.replayStatus])).toEqual([
      ['start-route', 'selected'],
      ['route-planner', 'selected'],
      ['route-reviewer', 'skipped'],
      ['planner-response', 'selected'],
      ['reviewer-response', 'skipped'],
    ]);
    expect(nodes.every((node) => node.className == null)).toBe(true);
    expect(edges.every((edge) => edge.data == null)).toBe(true);
  });

  it('marks the exact router connection as selected before the target node has started', () => {
    const runningReplay: WorkflowReplay = {
      ...replay,
      status: 'running',
      completed: false,
      steps: {
        start: replay.steps.start,
        route: replay.steps.route,
      },
    };

    const decorated = decorateWorkflowReplay(nodes, edges, runningReplay);
    expect(decorated.edges.find((edge) => edge.id === 'route-planner')?.data?.replayStatus).toBe('selected');
    expect(decorated.edges.find((edge) => edge.id === 'route-reviewer')?.data?.replayStatus).toBe('skipped');
  });
});
