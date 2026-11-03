// Auto-layout nodes via dagre — top-down with right-going edges.
import dagre from 'dagre';
import type { Node, Edge } from 'reactflow';

const NODE_W = 220;
const NODE_H = 80;

export function autoLayout(nodes: Node[], edges: Edge[], direction: 'TB' | 'LR' = 'LR'): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, ranksep: 80, nodesep: 40, edgesep: 10, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map((n) => {
    const layouted = g.node(n.id);
    if (!layouted) return n;
    return {
      ...n,
      position: { x: layouted.x - NODE_W / 2, y: layouted.y - NODE_H / 2 },
    };
  });
}
