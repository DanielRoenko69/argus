import { Boxes, FileCode2, RefreshCw, Search, Waypoints } from 'lucide-react';
import type { RepositoryGraphOverview } from './types';

interface RepositoryGraphArchitecturePanelProps {
  overview: RepositoryGraphOverview | null;
  search: string;
  visibleModules: number;
  focusedModule: string | null;
  visibleNeighbors: number;
  shownDependencies: number;
  totalDependencies: number;
  busy: boolean;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onShowAll: () => void;
  onShowFullGraph: () => void;
}

export function RepositoryGraphArchitecturePanel({
  overview,
  search,
  visibleModules,
  focusedModule,
  visibleNeighbors,
  shownDependencies,
  totalDependencies,
  busy,
  onSearchChange,
  onRefresh,
  onShowAll,
  onShowFullGraph,
}: RepositoryGraphArchitecturePanelProps) {
  return <aside className="repository-graph-architecture-panel" aria-label="Repository architecture filters">
    <label htmlFor="repository-architecture-search">Filter modules</label>
    <div className="repository-graph-architecture-search">
      <Search aria-hidden="true" size={14} />
      <input
        id="repository-architecture-search"
        value={search}
        placeholder="Path or language"
        onChange={event => onSearchChange(event.target.value)}
      />
    </div>

    <section className="repository-graph-architecture-summary" aria-label="Architecture summary">
      <h3>Snapshot contents</h3>
      <dl>
        <div><dt><Boxes size={13} />Modules</dt><dd>{overview?.totals.modules ?? '—'}</dd></div>
        <div><dt><FileCode2 size={13} />Files</dt><dd>{overview?.totals.files ?? '—'}</dd></div>
        <div><dt><Waypoints size={13} />Symbols</dt><dd>{overview?.totals.symbols ?? '—'}</dd></div>
        <div><dt>Relations</dt><dd>{overview?.totals.edges ?? '—'}</dd></div>
        <div><dt>Documents</dt><dd>{overview?.totals.documents ?? '—'}</dd></div>
        <div><dt>Test files</dt><dd>{overview?.totals.testFiles ?? '—'}</dd></div>
      </dl>
    </section>

    {overview && <p className="repository-graph-architecture-visible">
      {focusedModule
        ? <>Focused on <b>{focusedModule}</b> with <b>{Math.max(0, visibleNeighbors - 1)}</b> direct neighbors and <b>{shownDependencies}</b> dependencies.</>
        : <>Showing <b>{visibleModules}</b> of <b>{overview.modules.length}</b> returned modules and the <b>{shownDependencies}</b> strongest of <b>{totalDependencies}</b> dependencies.</>}
    </p>}
    <p className="repository-graph-architecture-note">
      Click a module to focus its direct neighbors. Double-click it to load the underlying files, symbols and relations.
    </p>
    {focusedModule && <button className="repository-graph-architecture-reset" type="button" onClick={onShowAll}>Show full architecture</button>}
    {!focusedModule && <button className="repository-graph-code-atlas" type="button" disabled={busy} onClick={onShowFullGraph}>
      <Waypoints aria-hidden="true" size={14} />
      <span>Show complete code graph<small>{(overview?.totals.files ?? 0).toLocaleString()} files · {(overview?.totals.symbols ?? 0).toLocaleString()} symbols · all indexed connections</small></span>
    </button>}
    <button className="repository-graph-architecture-refresh" type="button" disabled={busy} onClick={onRefresh}>
      <RefreshCw aria-hidden="true" size={13} />Refresh immutable overview
    </button>
  </aside>;
}
