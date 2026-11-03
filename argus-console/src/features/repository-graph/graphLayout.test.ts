import { describe, expect, it } from 'vitest';
import { graphEdgePath, layoutRepositoryGraph } from './graphLayout';
import type { RepositoryGraphEdge, RepositoryGraphNode } from './types';

const nodes: RepositoryGraphNode[] = [
  { id: 'symbol:2', type: 'symbol', label: 'beta', href: null, metadata: {} },
  { id: 'file:1', type: 'file', label: 'core.ts', href: null, metadata: {} },
  { id: 'symbol:1', type: 'symbol', label: 'alpha', href: null, metadata: {} },
];
const edges: RepositoryGraphEdge[] = [
  { id: 'declares:1', source: 'file:1', target: 'symbol:1', type: 'declares' },
  { id: 'calls:1', source: 'symbol:1', target: 'symbol:2', type: 'calls' },
  { id: 'calls:2', source: 'symbol:2', target: 'symbol:1', type: 'calls' },
  { id: 'self:1', source: 'symbol:2', target: 'symbol:2', type: 'calls' },
];

describe('layoutRepositoryGraph', () => {
  it('is deterministic and bounded for cyclic graphs', () => {
    const first = layoutRepositoryGraph(nodes, edges);
    const second = layoutRepositoryGraph([...nodes].reverse(), [...edges].reverse());

    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(3);
    expect(first.width).toBeGreaterThanOrEqual(720);
    expect(first.height).toBeGreaterThanOrEqual(360);
    expect(first.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it('renders a visible loop for self edges', () => {
    const layout = layoutRepositoryGraph(nodes, edges);
    const node = layout.nodes.find(candidate => candidate.id === 'symbol:2');
    expect(node).toBeDefined();
    expect(graphEdgePath(node!, node!)).toContain(' C ');
  });

  it('lays out repository architecture modules in a bounded grid', () => {
    const architectureNodes: RepositoryGraphNode[] = [
      { id: 'repository:root', type: 'repository', label: 'org/repo', href: null, metadata: {} },
      ...Array.from({ length: 12 }, (_, index): RepositoryGraphNode => ({
        id: `module:${index}`, type: 'module', label: `module-${index}`, href: null, metadata: {},
      })),
    ];
    const result = layoutRepositoryGraph(architectureNodes, architectureNodes.slice(1).map(node => ({
      id: `contains:${node.id}`, source: 'repository:root', target: node.id, type: 'contains',
    })));
    const repository = result.nodes.find(node => node.type === 'repository')!;
    const moduleColumns = new Set(result.nodes.filter(node => node.type === 'module').map(node => node.x));

    expect(repository.x).toBeLessThan(Math.min(...moduleColumns));
    expect(moduleColumns.size).toBeGreaterThan(1);
    expect(result.width).toBeGreaterThanOrEqual(720);
    expect(result.height).toBeGreaterThanOrEqual(360);
  });

  it('centers a focused node between its inbound and outbound neighbors', () => {
    const result = layoutRepositoryGraph(nodes, edges, 'symbol:1');
    const focus = result.nodes.find(node => node.id === 'symbol:1')!;
    const inbound = result.nodes.find(node => node.id === 'file:1')!;
    const outbound = result.nodes.find(node => node.id === 'symbol:2')!;

    expect(inbound.x).toBeLessThan(focus.x);
    expect(outbound.x).toBeGreaterThan(focus.x);
    expect(focus.x).toBeCloseTo((result.width - 184) / 2);
  });
});
