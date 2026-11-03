import { Filter, Search } from 'lucide-react';
import type {
  RepositoryGraphDirection,
  RepositoryGraphFiltersState,
  RepositoryGraphNodeType,
} from './types';

interface RepositoryGraphFiltersProps {
  search: string;
  filters: RepositoryGraphFiltersState;
  availableEdgeTypes: string[];
  disabled?: boolean;
  onSearchChange: (value: string) => void;
  onSearch: () => void;
  onFiltersChange: (filters: RepositoryGraphFiltersState) => void;
  onApply: () => void;
}

function toggleValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter(candidate => candidate !== value) : [...values, value];
}

export function RepositoryGraphFilters({
  search,
  filters,
  availableEdgeTypes,
  disabled = false,
  onSearchChange,
  onSearch,
  onFiltersChange,
  onApply,
}: RepositoryGraphFiltersProps) {
  const changeNodeType = (nodeType: RepositoryGraphNodeType) => {
    const nodeTypes = toggleValue(filters.nodeTypes, nodeType);
    if (nodeTypes.length) onFiltersChange({ ...filters, nodeTypes });
  };
  const changeDirection = (direction: RepositoryGraphDirection) => onFiltersChange({ ...filters, direction });
  const changeEdgeType = (edgeType: string) => {
    const effective = filters.edgeTypes.length ? filters.edgeTypes : availableEdgeTypes;
    const next = toggleValue(effective, edgeType);
    onFiltersChange({ ...filters, edgeTypes: next.length === availableEdgeTypes.length ? [] : next });
  };

  return (
    <aside className="repository-graph-filters" aria-label="Repository graph filters">
      <form onSubmit={event => { event.preventDefault(); onSearch(); }}>
        <label htmlFor="repository-graph-search">Find a file or symbol</label>
        <div className="repository-graph-search-field">
          <Search aria-hidden="true" size={15} />
          <input
            id="repository-graph-search"
            value={search}
            disabled={disabled}
            placeholder="agentRunner or src/agents"
            onChange={event => onSearchChange(event.target.value)}
          />
          <button type="submit" disabled={disabled || !search.trim()}>Search</button>
        </div>
      </form>

      <fieldset>
        <legend>Node types</legend>
        {(['file', 'symbol'] as const).map(nodeType => (
          <label key={nodeType}>
            <input
              type="checkbox"
              checked={filters.nodeTypes.includes(nodeType)}
              disabled={disabled}
              onChange={() => changeNodeType(nodeType)}
            />
            <span>{nodeType === 'file' ? 'Files' : 'Symbols'}</span>
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Relations</legend>
        {availableEdgeTypes.length ? availableEdgeTypes.map(edgeType => (
          <label key={edgeType}>
            <input
              type="checkbox"
              checked={filters.edgeTypes.length === 0 || filters.edgeTypes.includes(edgeType)}
              disabled={disabled}
              onChange={() => changeEdgeType(edgeType)}
            />
            <span>{edgeType}</span>
          </label>
        )) : <p>Relation filters appear after the first neighborhood loads.</p>}
      </fieldset>

      <div className="repository-graph-filter-selects">
        <label>Direction
          <select value={filters.direction} disabled={disabled} onChange={event => changeDirection(event.target.value as RepositoryGraphDirection)}>
            <option value="both">Both</option>
            <option value="outbound">Outbound</option>
            <option value="inbound">Inbound</option>
          </select>
        </label>
        <label>Depth
          <select value={filters.depth} disabled={disabled} onChange={event => onFiltersChange({ ...filters, depth: Number(event.target.value) })}>
            {[0, 1, 2, 3].map(depth => <option key={depth} value={depth}>{depth}</option>)}
          </select>
        </label>
      </div>

      <button className="repository-graph-apply" type="button" disabled={disabled} onClick={onApply}>
        <Filter aria-hidden="true" size={14} />Apply filters
      </button>
    </aside>
  );
}
