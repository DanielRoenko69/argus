import type { RepositoryGraphEdge, RepositoryGraphNode } from './types';

export const GRAPH_NODE_WIDTH = 184;
export const GRAPH_NODE_HEIGHT = 62;
const COLUMN_GAP = 82;
const ROW_GAP = 34;
const PADDING = 42;

export interface PositionedRepositoryGraphNode extends RepositoryGraphNode {
  x: number;
  y: number;
}

export interface RepositoryGraphLayout {
  width: number;
  height: number;
  nodes: PositionedRepositoryGraphNode[];
}

function lexicalNode(left: RepositoryGraphNode, right: RepositoryGraphNode): number {
  return left.type.localeCompare(right.type) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

function layoutArchitecture(nodes: RepositoryGraphNode[]): RepositoryGraphLayout | null {
  const repository = nodes.find(node => node.type === 'repository');
  const modules = nodes.filter(node => node.type === 'module').sort(lexicalNode);
  if (!repository || modules.length + 1 !== nodes.length) return null;

  const columnCount = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(modules.length / 1.5))));
  const rowCount = Math.max(1, Math.ceil(modules.length / columnCount));
  const moduleStartX = PADDING + GRAPH_NODE_WIDTH + COLUMN_GAP;
  const width = Math.max(720, moduleStartX + columnCount * GRAPH_NODE_WIDTH + Math.max(0, columnCount - 1) * COLUMN_GAP + PADDING);
  const height = Math.max(360, PADDING * 2 + rowCount * GRAPH_NODE_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP);
  const positioned: PositionedRepositoryGraphNode[] = [{
    ...repository,
    x: PADDING,
    y: Math.max(PADDING, (height - GRAPH_NODE_HEIGHT) / 2),
  }];
  modules.forEach((module, index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    positioned.push({
      ...module,
      x: moduleStartX + column * (GRAPH_NODE_WIDTH + COLUMN_GAP),
      y: PADDING + row * (GRAPH_NODE_HEIGHT + ROW_GAP),
    });
  });
  return { width, height, nodes: positioned };
}

function layoutFocusedNeighborhood(
  nodes: RepositoryGraphNode[],
  edges: RepositoryGraphEdge[],
  focusNodeId: string | null,
): RepositoryGraphLayout | null {
  if (!focusNodeId) return null;
  const focus = nodes.find(node => node.id === focusNodeId);
  if (!focus) return null;

  const inboundIds = new Set(edges.filter(edge => edge.target === focusNodeId && edge.source !== focusNodeId).map(edge => edge.source));
  const outboundIds = new Set(edges.filter(edge => edge.source === focusNodeId && edge.target !== focusNodeId).map(edge => edge.target));
  const inbound = nodes.filter(node => inboundIds.has(node.id) && !outboundIds.has(node.id)).sort(lexicalNode);
  const outbound = nodes.filter(node => outboundIds.has(node.id)).sort(lexicalNode);
  const remaining = nodes.filter(node => node.id !== focusNodeId && !inboundIds.has(node.id) && !outboundIds.has(node.id)).sort(lexicalNode);
  outbound.push(...remaining);
  const rowCount = Math.max(1, inbound.length, outbound.length);
  const width = Math.max(720, PADDING * 2 + GRAPH_NODE_WIDTH * 3 + COLUMN_GAP * 2);
  const height = Math.max(360, PADDING * 2 + rowCount * GRAPH_NODE_HEIGHT + Math.max(0, rowCount - 1) * ROW_GAP);
  const centerX = (width - GRAPH_NODE_WIDTH) / 2;
  const centerY = (height - GRAPH_NODE_HEIGHT) / 2;
  const columnTop = (count: number): number => Math.max(PADDING, (height - (count * GRAPH_NODE_HEIGHT + Math.max(0, count - 1) * ROW_GAP)) / 2);
  const positionColumn = (column: RepositoryGraphNode[], x: number): PositionedRepositoryGraphNode[] => {
    const top = columnTop(column.length);
    return column.map((node, row) => ({ ...node, x, y: top + row * (GRAPH_NODE_HEIGHT + ROW_GAP) }));
  };

  return {
    width,
    height,
    nodes: [
      ...positionColumn(inbound, PADDING),
      { ...focus, x: centerX, y: centerY },
      ...positionColumn(outbound, width - PADDING - GRAPH_NODE_WIDTH),
    ],
  };
}

export function layoutRepositoryGraph(
  nodes: RepositoryGraphNode[],
  edges: RepositoryGraphEdge[],
  focusNodeId: string | null = null,
): RepositoryGraphLayout {
  if (nodes.length === 0) return { width: 720, height: 360, nodes: [] };
  const focused = layoutFocusedNeighborhood(nodes, edges, focusNodeId);
  if (focused) return focused;
  const architecture = layoutArchitecture(nodes);
  if (architecture) return architecture;

  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(nodes.map(node => [node.id, 0]));
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) continue;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const ordered = [...nodes].sort(lexicalNode);
  const roots = ordered.filter(node => (indegree.get(node.id) ?? 0) === 0);
  const queue = [...(roots.length ? roots : ordered.slice(0, 1))].map(node => ({ id: node.id, level: 0 }));
  const levels = new Map<string, number>();
  while (queue.length) {
    const next = queue.shift();
    if (!next) break;
    const previous = levels.get(next.id);
    if (previous != null && previous <= next.level) continue;
    levels.set(next.id, next.level);
    const targets = [...new Set(outgoing.get(next.id) ?? [])].sort();
    for (const target of targets) queue.push({ id: target, level: Math.min(next.level + 1, 7) });
  }

  let nextComponentLevel = Math.max(0, ...levels.values()) + 1;
  for (const node of ordered) {
    if (levels.has(node.id)) continue;
    levels.set(node.id, nextComponentLevel);
    const componentQueue = [node.id];
    while (componentQueue.length) {
      const source = componentQueue.shift();
      if (!source) break;
      const sourceLevel = levels.get(source) ?? nextComponentLevel;
      for (const target of [...new Set(outgoing.get(source) ?? [])].sort()) {
        if (levels.has(target)) continue;
        levels.set(target, Math.min(sourceLevel + 1, nextComponentLevel + 3));
        componentQueue.push(target);
      }
    }
    nextComponentLevel = Math.max(nextComponentLevel + 1, ...levels.values()) + 1;
  }

  const columns = new Map<number, RepositoryGraphNode[]>();
  for (const node of ordered) {
    const level = levels.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }
  const levelValues = [...columns.keys()].sort((left, right) => left - right);
  const levelIndex = new Map(levelValues.map((level, index) => [level, index]));
  const tallestColumn = Math.max(...[...columns.values()].map(column => column.length));
  const width = Math.max(720, PADDING * 2 + levelValues.length * GRAPH_NODE_WIDTH + Math.max(0, levelValues.length - 1) * COLUMN_GAP);
  const height = Math.max(360, PADDING * 2 + tallestColumn * GRAPH_NODE_HEIGHT + Math.max(0, tallestColumn - 1) * ROW_GAP);

  const positioned: PositionedRepositoryGraphNode[] = [];
  for (const [level, column] of columns) {
    const columnHeight = column.length * GRAPH_NODE_HEIGHT + Math.max(0, column.length - 1) * ROW_GAP;
    const top = Math.max(PADDING, (height - columnHeight) / 2);
    column.forEach((node, row) => positioned.push({
      ...node,
      x: PADDING + (levelIndex.get(level) ?? 0) * (GRAPH_NODE_WIDTH + COLUMN_GAP),
      y: top + row * (GRAPH_NODE_HEIGHT + ROW_GAP),
    }));
  }

  return { width, height, nodes: positioned.sort((left, right) => left.id.localeCompare(right.id)) };
}

export function graphEdgePath(
  source: PositionedRepositoryGraphNode,
  target: PositionedRepositoryGraphNode,
): string {
  if (source.id === target.id) {
    const x = source.x + GRAPH_NODE_WIDTH - 24;
    const y = source.y + 10;
    return `M ${x} ${y} C ${x + 42} ${y - 38}, ${x + 52} ${y + 46}, ${x + 4} ${y + 34}`;
  }
  const sourceX = source.x + GRAPH_NODE_WIDTH;
  const sourceY = source.y + GRAPH_NODE_HEIGHT / 2;
  const targetX = target.x;
  const targetY = target.y + GRAPH_NODE_HEIGHT / 2;
  const bend = Math.max(36, Math.abs(targetX - sourceX) * 0.46);
  return `M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}`;
}
