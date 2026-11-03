// Node-type registry — single source of truth for what kinds of nodes
// exist, what category they belong to, what default data they carry,
// and which React component renders them.
//
// Patterned after sim/apps/sim/blocks/registry.ts (Apache 2.0).

import type { ComponentType } from 'react';
import type { NodeProps } from 'reactflow';

export type NodeCategory = 'triggers' | 'logic' | 'argus';

export interface NodeDefinition {
  type: string;                  // unique key, also React Flow node-type
  label: string;                 // display name
  category: NodeCategory;
  icon: string;                  // lucide-react icon name (rendered in Sidebar)
  description: string;
  // Initial data for a freshly dropped instance:
  defaultData: () => Record<string, unknown>;
  // Schema for the properties-panel form (rendered field-by-field):
  fields: FieldSchema[];
}

export type FieldSchema =
  | { name: string; label: string; type: 'text'; placeholder?: string; default?: string }
  | { name: string; label: string; type: 'textarea'; rows?: number; placeholder?: string; default?: string }
  | { name: string; label: string; type: 'number'; min?: number; max?: number; default?: number }
  | { name: string; label: string; type: 'boolean'; default?: boolean }
  | { name: string; label: string; type: 'select-static'; options: Array<{ value: string; label: string }>; default?: string }
  | { name: string; label: string; type: 'select-agents' }
  | { name: string; label: string; type: 'select-agent-rags' }
  | { name: string; label: string; type: 'select-rags' }
  | { name: string; label: string; type: 'select-tools' }
  | { name: string; label: string; type: 'select-skills' }
  | { name: string; label: string; type: 'select-workflows' }
  | { name: string; label: string; type: 'select-k8s-namespace' }
  | { name: string; label: string; type: 'select-k8s-pod'; namespace_field?: string };

// Registry is populated from each node's own file via registerNode().
const registry = new Map<string, NodeDefinition>();
const components = new Map<string, ComponentType<NodeProps>>();

export function registerNode(def: NodeDefinition, component: ComponentType<NodeProps>): void {
  registry.set(def.type, def);
  components.set(def.type, component);
}

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return registry.get(type);
}

export function getAllNodeDefinitions(): NodeDefinition[] {
  return Array.from(registry.values());
}

export function getNodeTypes(): Record<string, ComponentType<NodeProps>> {
  return Object.fromEntries(components);
}

export function getNodesByCategory(category: NodeCategory): NodeDefinition[] {
  return getAllNodeDefinitions().filter((n) => n.category === category);
}
