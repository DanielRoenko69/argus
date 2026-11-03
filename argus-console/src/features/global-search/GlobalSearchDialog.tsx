import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bot,
  Boxes,
  ChevronLeft,
  GitBranch,
  Library,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { searchWorkspace } from '../../api';
import type { ConsoleNavigationCapabilityResponse, GlobalSearchResourceType } from '../../types';
import {
  isWorkspaceNavItemVisible,
  workspaceIcons,
  workspaceSections,
} from '../../components/WorkspaceSidebar';
import './globalSearch.css';

interface GlobalSearchDialogProps {
  capabilities?: ConsoleNavigationCapabilityResponse;
  canAdmin: boolean;
  onClose: () => void;
}

const resourceMeta: Record<GlobalSearchResourceType, { label: string; icon: LucideIcon }> = {
  agent: { label: 'Agents', icon: Bot },
  workflow: { label: 'Workflows', icon: GitBranch },
  skill: { label: 'Skills', icon: Sparkles },
  knowledge: { label: 'Knowledge', icon: Library },
  bundle: { label: 'Access bundles', icon: Boxes },
};

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

export function GlobalSearchDialog({ capabilities, canAdmin, onClose }: GlobalSearchDialogProps) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  const debouncedQuery = useDebouncedValue(normalizedQuery, 180);
  const canSearchResources = capabilities?.navigation.canSearchWorkspaceResources ?? false;
  const resourceSearch = useQuery({
    queryKey: ['workspace-search', debouncedQuery],
    queryFn: () => searchWorkspace(debouncedQuery),
    enabled: canSearchResources && debouncedQuery.length >= 2,
    staleTime: 15_000,
    retry: false,
  });

  const navigationResults = useMemo(() => {
    const needle = normalizedQuery.toLocaleLowerCase();
    return workspaceSections
      .flatMap(section => section.items)
      .concat([{ label:'Quality Inbox',href:'/observe/quality',icon:'clipboard-check',adminOnly:true }])
      .filter(item => isWorkspaceNavItemVisible(item, capabilities, canAdmin))
      .filter(item => !needle || `${item.label} ${item.href}`.toLocaleLowerCase().includes(needle));
  }, [canAdmin, capabilities, normalizedQuery]);

  const resourceGroups = useMemo(() => {
    const groups = new Map<GlobalSearchResourceType, NonNullable<typeof resourceSearch.data>['results']>();
    for (const result of resourceSearch.data?.results ?? []) {
      groups.set(result.type, [...(groups.get(result.type) ?? []), result]);
    }
    return [...groups.entries()];
  }, [resourceSearch.data]);

  return (
    <div className="command-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="command-dialog global-search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search Argus"
        onMouseDown={event => event.stopPropagation()}
      >
        <label className="command-input">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search agents, workflows, skills, knowledge…"
          />
          <kbd>esc</kbd>
        </label>
        <div className="command-results global-search-results" aria-live="polite">
          {normalizedQuery.length < 2 && canSearchResources && (
            <p className="global-search-hint">Type at least two characters to search authorized workspace resources.</p>
          )}

          {resourceSearch.isFetching && <p className="global-search-state">Searching workspace…</p>}
          {resourceSearch.isError && (
            <p className="global-search-state is-error">Workspace resources are unavailable. Navigation still works.</p>
          )}

          {resourceGroups.map(([type, results]) => {
            const meta = resourceMeta[type];
            const Icon = meta.icon;
            return (
              <div className="global-search-group" key={type}>
                <span className="command-group-label">{meta.label}</span>
                {results.map(result => (
                  <Link to={result.href} key={`${result.type}-${result.id}`} onClick={onClose}>
                    <span><Icon size={17} /></span>
                    <span className="global-search-copy">
                      <b>{result.title}</b>
                      <small>{result.description || result.subtitle}</small>
                    </span>
                    {result.status && <em>{result.status}</em>}
                    <ChevronLeft size={14} className="command-arrow" />
                  </Link>
                ))}
              </div>
            );
          })}

          {navigationResults.length > 0 && (
            <div className="global-search-group">
              <span className="command-group-label">Navigate</span>
              {navigationResults.map(item => {
                const Icon = workspaceIcons[item.icon];
                return (
                  <Link to={item.href} key={`${item.href}-${item.label}`} onClick={onClose}>
                    <span><Icon size={17} /></span>
                    <span className="global-search-copy"><b>{item.label}</b><small>{item.href}</small></span>
                    <ChevronLeft size={14} className="command-arrow" />
                  </Link>
                );
              })}
            </div>
          )}

          {normalizedQuery.length >= 2
            && !resourceSearch.isFetching
            && resourceGroups.length === 0
            && navigationResults.length === 0 && (
            <div className="command-empty">No authorized resource or page matches “{normalizedQuery}”.</div>
          )}
        </div>
        <footer className="global-search-footer">
          <span>Results respect your role and Bundle scope.</span>
          {resourceSearch.data && <span>{resourceSearch.data.durationMs} ms</span>}
        </footer>
      </section>
    </div>
  );
}
