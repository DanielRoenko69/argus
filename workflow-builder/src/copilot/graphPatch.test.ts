import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { buildCopilotGraphPatch } from './graphPatch';

const node = (id: string): Node => ({
  id,
  type: 'trigger.manual',
  position: { x: 0, y: 0 },
  data: { label: id },
});

describe('buildCopilotGraphPatch', () => {
  it('extends the current graph while preserving existing topology', () => {
    const currentNodes = [node('start'), node('read')];
    const currentEdges: Edge[] = [{ id: 'start-read', source: 'start', target: 'read' }];

    const patch = buildCopilotGraphPatch(currentNodes, currentEdges, {
      rationale: 'Add an agent and response',
      add_nodes: [
        { id: 'triage', type: 'argus.agent', position: { x: 300, y: 0 }, data: { label: 'Triage', agent_role: 'planner' } },
        { id: 'done', type: 'logic.response', position: { x: 600, y: 0 }, data: { label: 'Done', value: '{{ steps.triage.result }}' } },
      ],
      add_edges: [
        { source: 'read', target: 'triage' },
        { source: 'triage', target: 'done' },
      ],
    });

    expect(patch.nodes.map(candidate => candidate.id)).toEqual(['start', 'read', 'triage', 'done']);
    expect(patch.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['start', 'read'],
      ['read', 'triage'],
      ['triage', 'done'],
    ]);
    expect(patch.addedNodeIds).toEqual(['triage', 'done']);
    expect(patch.updatedNodeIds).toEqual([]);
  });

  it('updates an existing node without changing its identity, type, position or unrelated args', () => {
    const notify: Node = {
      id: 'notify', type: 'argus.tool', position: { x: 400, y: 80 },
      data: { label: 'Post to Slack', tool: 'slack_post_message', args: { channel_id: 'coding-ops', text: 'Keep me' } },
    };

    const patch = buildCopilotGraphPatch([notify], [], {
      rationale: 'Use a runtime channel input',
      add_nodes: [],
      update_nodes: [{ id: 'notify', data: { args: { channel_id: '{{ input.notification_channel }}' } } }],
      add_edges: [],
    });

    expect(patch.nodes[0]).toMatchObject({
      id: 'notify', type: 'argus.tool', position: { x: 400, y: 80 },
      data: {
        label: 'Post to Slack', tool: 'slack_post_message',
        args: { channel_id: '{{ input.notification_channel }}', text: 'Keep me' },
      },
    });
    expect(patch.updatedNodeIds).toEqual(['notify']);
  });

  it('repairs Agent binding metadata that the Copilot nested below data.args', () => {
    const patch = buildCopilotGraphPatch([], [], {
      rationale: 'Add a planner',
      add_nodes: [{
        id: 'plan', type: 'argus.agent', position: { x: 100, y: 100 },
        data: { label: 'Plan', args: { agent_role: ' Planner ', prompt: 'Plan it' } },
      }],
      add_edges: [],
    });

    expect(patch.nodes[0]?.data).toEqual({
      label: 'Plan',
      agent_role: 'planner',
      args: { prompt: 'Plan it' },
    });
  });

  it('rejects updates for nodes that are not on the current canvas', () => {
    expect(() => buildCopilotGraphPatch([node('start')], [], {
      rationale: 'Bad update',
      add_nodes: [],
      update_nodes: [{ id: 'missing', data: { label: 'Nope' } }],
      add_edges: [],
    })).toThrow("Copilot update references missing node 'missing'");
  });

  it('rejects colliding node ids instead of silently rewiring the workflow', () => {
    expect(() => buildCopilotGraphPatch([node('start')], [], {
      rationale: 'Bad proposal',
      add_nodes: [{ id: 'start', type: 'logic.response', position: { x: 0, y: 0 }, data: { label: 'Collision' } }],
      add_edges: [],
    })).toThrow("Copilot node id 'start' already exists");
  });

  it('rejects edges that do not resolve to the merged graph', () => {
    expect(() => buildCopilotGraphPatch([node('start')], [], {
      rationale: 'Bad edge',
      add_nodes: [],
      add_edges: [{ source: 'start', target: 'missing' }],
    })).toThrow("Copilot edge 'start -> missing' references a missing node");
  });
});
