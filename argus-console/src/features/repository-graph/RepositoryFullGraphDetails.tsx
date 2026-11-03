import { Boxes, FileCode2, Waypoints } from 'lucide-react';
import type { RepositoryFullGraph } from './types';

interface RepositoryFullGraphDetailsProps {
  graph: RepositoryFullGraph;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}

interface Neighbor { id: string; label: string; relation: string }

export function RepositoryFullGraphDetails({ graph, selectedNodeId, onSelect }: RepositoryFullGraphDetailsProps) {
  if (!selectedNodeId) return <aside className="repository-full-graph-details" aria-label="Complete graph node details">
    <div className="repository-full-graph-empty"><Waypoints size={20} /><b>Select a point</b><span>Inspect a file, function or symbol from the complete graph.</span></div>
  </aside>;

  const [type, id] = selectedNodeId.split(':', 2);
  const fileIndex = type === 'file' ? graph.files.findIndex(file => file[0] === id) : -1;
  const symbolIndex = type === 'symbol' ? graph.symbols.findIndex(symbol => symbol[0] === id) : -1;
  if (fileIndex < 0 && symbolIndex < 0) return null;

  const isFile = fileIndex >= 0;
  const file = isFile ? graph.files[fileIndex]! : graph.files[graph.symbols[symbolIndex]![3]]!;
  const symbol = isFile ? null : graph.symbols[symbolIndex]!;
  const neighbors: Neighbor[] = [];
  let totalRelations = 0;
  if (isFile) {
    graph.symbols.forEach(candidate => {
      if (candidate[3] !== fileIndex) return;
      totalRelations += 1;
      if (neighbors.length < 40) neighbors.push({ id: `symbol:${candidate[0]}`, label: candidate[1], relation: 'declares' });
    });
  } else {
    totalRelations += 1;
    neighbors.push({ id: `file:${file[0]}`, label: file[1].split('/').at(-1) ?? file[1], relation: 'declared by' });
    graph.edges.forEach(edge => {
      if (edge[0] !== symbolIndex && edge[1] !== symbolIndex) return;
      totalRelations += 1;
      if (neighbors.length >= 40) return;
      const outbound = edge[0] === symbolIndex;
      const neighborIndex = outbound ? edge[1] : edge[0];
      const neighbor = graph.symbols[neighborIndex];
      if (!neighbor) return;
      const relation = graph.relationTypes[edge[2]] ?? 'related';
      neighbors.push({ id: `symbol:${neighbor[0]}`, label: neighbor[1], relation: outbound ? relation : `${relation} · inbound` });
    });
  }

  return <aside className="repository-full-graph-details" aria-label="Complete graph node details">
    <div className="repository-full-graph-node-heading">
      <span>{isFile ? <FileCode2 size={16} /> : <Waypoints size={16} />}</span>
      <div><small>{isFile ? 'FILE' : symbol ? symbol[2].toUpperCase() : ''}</small><h3>{isFile ? file[1].split('/').at(-1) : symbol?.[1]}</h3><code>{selectedNodeId}</code></div>
    </div>
    <dl>
      <div><dt>Module</dt><dd><Boxes size={11} />{file[3]}</dd></div>
      <div><dt>Path</dt><dd title={file[1]}>{file[1]}</dd></div>
      <div><dt>Language</dt><dd>{file[2] ?? 'unknown'}</dd></div>
      {symbol && <><div><dt>Kind</dt><dd>{symbol[2]}</dd></div><div><dt>Lines</dt><dd>{symbol[4]}–{symbol[5]}</dd></div></>}
      <div><dt>Degree</dt><dd>{totalRelations}</dd></div>
    </dl>
    <section><h4>Neighbors <span>{totalRelations}</span></h4>
      {neighbors.map((neighbor, index) => <button key={`${neighbor.relation}:${neighbor.id}:${index}`} type="button" onClick={() => onSelect(neighbor.id)}><span>{neighbor.label}</span><small>{neighbor.relation}</small></button>)}
      {totalRelations > neighbors.length && <p>Showing the first {neighbors.length} of {totalRelations} direct relations.</p>}
    </section>
  </aside>;
}
