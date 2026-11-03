import type { RepositoryGraphEdge, RepositoryGraphNode } from './types';

interface RepositoryGraphListFallbackProps {
  nodes: RepositoryGraphNode[];
  edges: RepositoryGraphEdge[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}

export function RepositoryGraphListFallback({ nodes, edges, selectedNodeId, onSelect }: RepositoryGraphListFallbackProps) {
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const relationCounts = new Map<string, { inbound: number; outbound: number }>();
  for (const node of nodes) relationCounts.set(node.id, { inbound: 0, outbound: 0 });
  for (const edge of edges) {
    const source = relationCounts.get(edge.source);
    const target = relationCounts.get(edge.target);
    if (source) source.outbound += 1;
    if (target) target.inbound += 1;
  }

  return <div className="repository-graph-list" aria-label="Accessible repository graph">
    <table>
      <caption>Nodes in the current immutable graph view</caption>
      <thead><tr><th scope="col">Node</th><th scope="col">Type</th><th scope="col">Location</th><th scope="col">Inbound</th><th scope="col">Outbound</th></tr></thead>
      <tbody>{nodes.map(node => {
        const counts = relationCounts.get(node.id) ?? { inbound: 0, outbound: 0 };
        const location = node.metadata.path ?? node.metadata.filePath ?? node.metadata.qualifiedName ?? '—';
        return <tr key={node.id} className={node.id === selectedNodeId ? 'is-selected' : ''}>
          <th scope="row"><button type="button" aria-pressed={node.id === selectedNodeId} onClick={() => onSelect(node.id)}>{node.label}</button></th>
          <td>{node.type}</td><td><code>{String(location)}</code></td><td>{counts.inbound}</td><td>{counts.outbound}</td>
        </tr>;
      })}</tbody>
    </table>

    <table>
      <caption>Directed relations in the current immutable graph view</caption>
      <thead><tr><th scope="col">Relation</th><th scope="col">Source</th><th scope="col">Target</th></tr></thead>
      <tbody>{edges.map(edge => <tr key={edge.id}>
        <td>{edge.type}</td>
        <td>{nodeById.get(edge.source)?.label ?? 'Unknown'} <code>{edge.source}</code></td>
        <td>{nodeById.get(edge.target)?.label ?? 'Unknown'} <code>{edge.target}</code></td>
      </tr>)}</tbody>
    </table>
  </div>;
}
