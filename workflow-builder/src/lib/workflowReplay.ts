import type { Edge, Node } from 'reactflow';
import type { WorkflowReplay, WorkflowReplayStepStatus } from '@/api/replay';

export type ReplayNodeStatus = WorkflowReplayStepStatus | 'not-run';
export type ReplayEdgeStatus = 'selected' | 'skipped' | 'inactive';

export interface ReplayGraph {
  nodes: Node[];
  edges: Edge[];
}

const TRAVERSED = new Set<ReplayNodeStatus>(['running', 'completed', 'failed']);

function replayNodeClass(className: string | undefined, status: ReplayNodeStatus): string {
  return [className, 'builder-replay-node', `is-replay-${status}`].filter(Boolean).join(' ');
}

function edgeReplayStatus(source: ReplayNodeStatus, target: ReplayNodeStatus): ReplayEdgeStatus {
  if (source === 'skipped' || target === 'skipped') return 'skipped';
  if (TRAVERSED.has(source) && TRAVERSED.has(target)) return 'selected';
  return 'inactive';
}

export function decorateWorkflowReplay(nodes: Node[], edges: Edge[], replay: WorkflowReplay | null): ReplayGraph {
  if (!replay) return { nodes, edges };

  const statusByNode = new Map<string, ReplayNodeStatus>();
  const replayNodes = nodes.map((node) => {
    const status: ReplayNodeStatus = replay.steps[node.id]?.status ?? 'not-run';
    statusByNode.set(node.id, status);
    return {
      ...node,
      className: replayNodeClass(node.className, status),
      data: { ...node.data, replayStatus: status },
    };
  });

  const replayEdges = edges.map((edge) => {
    const selectedTarget = replay.steps[edge.source]?.selectedTarget;
    const status = selectedTarget
      ? edge.target === selectedTarget ? 'selected' : 'skipped'
      : edgeReplayStatus(
        statusByNode.get(edge.source) ?? 'not-run',
        statusByNode.get(edge.target) ?? 'not-run',
      );
    return {
      ...edge,
      data: { ...edge.data, replayStatus: status },
    };
  });

  return { nodes: replayNodes, edges: replayEdges };
}
