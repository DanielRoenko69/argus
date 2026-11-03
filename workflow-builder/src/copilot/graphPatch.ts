import { addEdge, type Edge, type Node } from 'reactflow';
import type { CopilotSuggestion } from '@/api/copilot';

export interface CopilotGraphPatch {
  nodes: Node[];
  edges: Edge[];
  addedNodeIds: string[];
  updatedNodeIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeNodeData(
  current: Record<string, unknown>,
  proposed: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(proposed)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    merged[key] = isRecord(value) && isRecord(current[key])
      ? mergeNodeData(current[key], value)
      : value;
  }
  return merged;
}

function normalizeAgentBindingData(
  type: string | undefined,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (type !== 'argus.agent') return value;
  const args = isRecord(value.args) ? { ...value.args } : null;
  const nestedRole = args?.agent_role;
  const nestedId = args?.agent_id;
  const role = typeof value.agent_role === 'string' && value.agent_role.trim()
    ? value.agent_role.trim().toLowerCase()
    : typeof nestedRole === 'string' && nestedRole.trim()
      ? nestedRole.trim().toLowerCase()
      : null;
  const agentId = typeof value.agent_id === 'number' && Number.isSafeInteger(value.agent_id) && value.agent_id > 0
    ? value.agent_id
    : typeof nestedId === 'number' && Number.isSafeInteger(nestedId) && nestedId > 0
      ? nestedId
      : null;
  if (args) {
    delete args.agent_role;
    delete args.agent_id;
  }
  return {
    ...value,
    ...(args ? { args } : {}),
    ...(role ? { agent_role: role } : agentId ? { agent_id: agentId } : {}),
  };
}

/**
 * Build the exact graph that will be validated and persisted for a Copilot
 * proposal. The function is deliberately pure so preview, validation, save and
 * canvas application cannot drift apart.
 */
export function buildCopilotGraphPatch(
  currentNodes: Node[],
  currentEdges: Edge[],
  suggestion: CopilotSuggestion,
  createId: () => string = () => crypto.randomUUID().slice(0, 8),
): CopilotGraphPatch {
  const usedIds = new Set(currentNodes.map(node => node.id));
  const idMap = new Map<string, string>();
  const addedNodes: Node[] = [];
  const updates = new Map<string, Record<string, unknown>>();

  for (const update of suggestion.update_nodes ?? []) {
    const id = update.id?.trim();
    if (!id || !usedIds.has(id)) {
      throw new Error(`Copilot update references missing node '${id || '?'}'`);
    }
    if (updates.has(id)) {
      throw new Error(`Copilot proposed more than one update for node '${id}'`);
    }
    if (!isRecord(update.data)) {
      throw new Error(`Copilot update for node '${id}' is missing data`);
    }
    const current = currentNodes.find(node => node.id === id);
    updates.set(id, normalizeAgentBindingData(current?.type, update.data));
  }

  for (const block of suggestion.add_nodes) {
    const requestedId = block.id?.trim();
    if (requestedId && usedIds.has(requestedId)) {
      throw new Error(`Copilot node id '${requestedId}' already exists on the canvas`);
    }
    let id = requestedId || `${block.type}.${createId()}`;
    while (usedIds.has(id)) id = `${block.type}.${createId()}`;
    usedIds.add(id);
    if (requestedId) idMap.set(requestedId, id);
    addedNodes.push({
      id,
      type: block.type,
      position: block.position ?? { x: 100, y: 100 },
      data: normalizeAgentBindingData(block.type, block.data),
    });
  }

  let edges = [...currentEdges];
  for (const edge of suggestion.add_edges) {
    const source = idMap.get(edge.source) ?? edge.source;
    const target = idMap.get(edge.target) ?? edge.target;
    if (!usedIds.has(source) || !usedIds.has(target)) {
      throw new Error(`Copilot edge '${source} -> ${target}' references a missing node`);
    }
    edges = addEdge({ source, target, sourceHandle: null, targetHandle: null }, edges);
  }

  return {
    nodes: [
      ...currentNodes.map(node => {
        const data = updates.get(node.id);
        return data ? { ...node, data: mergeNodeData(node.data as Record<string, unknown>, data) } : node;
      }),
      ...addedNodes,
    ],
    edges,
    addedNodeIds: addedNodes.map(node => node.id),
    updatedNodeIds: [...updates.keys()],
  };
}
