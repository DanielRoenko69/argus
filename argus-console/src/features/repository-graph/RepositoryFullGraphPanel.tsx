import { ArrowLeft, Search, Waypoints } from 'lucide-react';
import type { RepositoryFullGraph } from './types';

interface RepositoryFullGraphPanelProps {
  graph: RepositoryFullGraph;
  search: string;
  onSearchChange: (value: string) => void;
  onSearch: () => void;
  onBack: () => void;
}

export function RepositoryFullGraphPanel({ graph, search, onSearchChange, onSearch, onBack }: RepositoryFullGraphPanelProps) {
  const modules = [...new Set(graph.files.map(file => file[3]))];
  return <aside className="repository-full-graph-panel" aria-label="Complete repository graph controls">
    <div className="repository-full-graph-panel-title"><Waypoints size={15} /><div><b>Complete code graph</b><span>Canvas overview · no drill-down required</span></div></div>
    <form onSubmit={event => { event.preventDefault(); onSearch(); }}>
      <label htmlFor="repository-full-graph-search">Find a file or function</label>
      <div><Search size={14} /><input id="repository-full-graph-search" value={search} placeholder="Path, function or class" onChange={event => onSearchChange(event.target.value)} /><button type="submit">Find</button></div>
    </form>
    <dl className="repository-full-graph-stats">
      <div><dt>Nodes</dt><dd>{(graph.files.length + graph.symbols.length).toLocaleString()}</dd></div>
      <div><dt>Relations</dt><dd>{(graph.symbols.length + graph.edges.length).toLocaleString()}</dd></div>
      <div><dt>Files</dt><dd>{graph.files.length.toLocaleString()}</dd></div>
      <div><dt>Functions &amp; symbols</dt><dd>{graph.symbols.length.toLocaleString()}</dd></div>
      <div><dt>Module clusters</dt><dd>{modules.length.toLocaleString()}</dd></div>
    </dl>
    <p>Colors group code by top-level module. Scroll to zoom, drag to pan, and click a point for details.</p>
    <button className="repository-full-graph-back" type="button" onClick={onBack}><ArrowLeft size={13} />Back to module overview</button>
  </aside>;
}
