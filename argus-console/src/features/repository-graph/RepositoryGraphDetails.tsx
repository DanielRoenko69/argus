import { ArrowDownLeft, ArrowUpRight, Box, ExternalLink, GitFork, Search } from 'lucide-react';
import type { RepositoryGraphEdge, RepositoryGraphNode } from './types';

interface RepositoryGraphDetailsProps {
  node: RepositoryGraphNode | null;
  nodes: RepositoryGraphNode[];
  edges: RepositoryGraphEdge[];
  busy?: boolean;
  onSelect: (nodeId: string) => void;
  onExplore: (nodeId: string) => void;
}

function metadataLabel(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
}

export function RepositoryGraphDetails({ node, nodes, edges, busy = false, onSelect, onExplore }: RepositoryGraphDetailsProps) {
  if (!node) {
    return <aside className="repository-graph-details is-empty" aria-label="Graph node details">
      <Search aria-hidden="true" size={21} />
      <b>Select a graph node</b>
      <p>Inspect its immutable metadata and relationships without changing the snapshot.</p>
    </aside>;
  }

  const nodeById = new Map(nodes.map(candidate => [candidate.id, candidate]));
  const inbound = edges.filter(edge => edge.target === node.id);
  const outbound = edges.filter(edge => edge.source === node.id);

  const relations = (items: RepositoryGraphEdge[], direction: 'inbound' | 'outbound') => items.map(edge => {
    const relatedId = direction === 'inbound' ? edge.source : edge.target;
    const related = nodeById.get(relatedId);
    return <li key={`${direction}:${edge.id}`}>
      <button type="button" disabled={!related} onClick={() => related && onSelect(related.id)}>
        {direction === 'inbound' ? <ArrowDownLeft aria-hidden="true" size={12} /> : <ArrowUpRight aria-hidden="true" size={12} />}
        <span><b>{related?.label ?? relatedId}</b><small>{edge.type}{edge.metadata?.['relationCount'] ? ` · ${edge.metadata['relationCount']} relations` : ''}</small></span>
      </button>
    </li>;
  });

  return <aside className="repository-graph-details" aria-label="Graph node details">
    <header>
      <span><Box aria-hidden="true" size={16} /></span>
      <div><small>{node.type}</small><h3>{node.label}</h3><code>{node.id}</code></div>
    </header>

    <dl>
      {Object.entries(node.metadata).map(([key, value]) => <div key={key}>
        <dt>{metadataLabel(key)}</dt><dd>{value == null ? '—' : String(value)}</dd>
      </div>)}
    </dl>

    {node.href && <a className="repository-graph-authorized-link" href={node.href}>
      <ExternalLink aria-hidden="true" size={13} />Open authorized source
    </a>}

    <section>
      <h4>Inbound <span>{inbound.length}</span></h4>
      {inbound.length ? <ul>{relations(inbound, 'inbound')}</ul> : <p>No inbound relations in this view.</p>}
    </section>
    <section>
      <h4>Outbound <span>{outbound.length}</span></h4>
      {outbound.length ? <ul>{relations(outbound, 'outbound')}</ul> : <p>No outbound relations in this view.</p>}
    </section>

    <button className="repository-graph-explore" type="button" disabled={busy} onClick={() => onExplore(node.id)}>
      <GitFork aria-hidden="true" size={14} />{node.type === 'module' ? 'Open module code' : node.type === 'repository' ? 'Open repository code' : 'Load direct neighborhood'}
    </button>
  </aside>;
}
