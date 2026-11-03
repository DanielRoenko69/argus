import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  KeyRound,
  Search,
  Server,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import {
  capabilityToolKey,
  countCapabilitySources,
  filterAvailableCapabilities,
  type CapabilityAccessFilter,
  type CapabilityAssignmentFilter,
  type CapabilitySourceFilter,
} from '../capabilityCatalog';
import type { FabricManagementResponse, FabricToolAssignmentInput } from '../types';
import { EmptyState } from './Ui';

const MAX_SELECTED_CAPABILITIES = 500;

export function CapabilityDrawer({
  data,
  bundleId,
  bundleLabel,
  currentToolCount,
  currentBackendIds,
  saving,
  error,
  onClose,
  onAssign,
}: {
  data: FabricManagementResponse;
  bundleId: number;
  bundleLabel: string;
  currentToolCount: number;
  currentBackendIds: number[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onAssign: (input: FabricToolAssignmentInput) => void;
}) {
  const [search, setSearch] = useState('');
  const [access, setAccess] = useState<CapabilityAccessFilter>('all');
  const [assignment, setAssignment] = useState<CapabilityAssignmentFilter>('all');
  const [source, setSource] = useState<CapabilitySourceFilter>('all');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const allAvailable = useMemo(() => filterAvailableCapabilities(data.tools, bundleId, {
    search: '', access: 'all', assignment: 'all', source: 'all',
  }), [bundleId, data.tools]);
  const availableKeys = useMemo(() => new Set(allAvailable.map(capabilityToolKey)), [allAvailable]);
  const visible = useMemo(() => filterAvailableCapabilities(data.tools, bundleId, {
    search, access, assignment, source,
  }), [access, assignment, bundleId, data.tools, search, source]);
  const visibleKeys = useMemo(() => new Set(visible.map(capabilityToolKey)), [visible]);
  const selectedTools = allAvailable.filter(tool => selectedKeys.has(capabilityToolKey(tool)));
  const groups = useMemo(() => {
    const grouped = new Map<number | null, typeof visible>();
    for (const tool of visible) {
      const tools = grouped.get(tool.backendId) ?? [];
      tools.push(tool);
      grouped.set(tool.backendId, tools);
    }
    return [...grouped.entries()].map(([backendId, tools]) => ({
      backendId,
      backend: backendId == null ? null : data.backends.find(backend => backend.id === backendId),
      tools,
    }));
  }, [data.backends, visible]);
  const sourceOptions = useMemo(() => {
    const backendIds = new Set(allAvailable
      .map(tool => tool.backendId)
      .filter((backendId): backendId is number => backendId != null));
    return data.backends.filter(backend => backendIds.has(backend.id));
  }, [allAvailable, data.backends]);
  const hasDirectTools = allAvailable.some(tool => tool.backendId == null);
  const unassignedCount = allAvailable.filter(tool => tool.bundleIds.length === 0).length;
  const sharedCount = allAvailable.length - unassignedCount;
  const selectedUnassignedCount = selectedTools.filter(tool => tool.bundleIds.length === 0).length;
  const selectedSharedCount = selectedTools.length - selectedUnassignedCount;
  const currentBackendIdSet = new Set(currentBackendIds);
  const newConnectionCount = new Set(selectedTools
    .map(tool => tool.backendId)
    .filter((backendId): backendId is number => backendId != null && !currentBackendIdSet.has(backendId))).size;
  const selectionAtLimit = selectedTools.length >= MAX_SELECTED_CAPABILITIES;

  useEffect(() => {
    setSelectedKeys(current => new Set([...current].filter(key => availableKeys.has(key))));
  }, [availableKeys]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || saving) return;
      if (selectedKeys.size === 0 || window.confirm('Discard the selected capabilities?')) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, saving, selectedKeys.size]);

  const requestClose = () => {
    if (saving) return;
    if (selectedKeys.size > 0 && !window.confirm('Discard the selected capabilities?')) return;
    onClose();
  };
  const visibleSelectedCount = visible.filter(tool => selectedKeys.has(capabilityToolKey(tool))).length;
  const toggle = (key: string) => setSelectedKeys(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else if (next.size < MAX_SELECTED_CAPABILITIES) next.add(key);
    return next;
  });

  return (
    <div className="editor-layer capability-drawer-layer" role="presentation" onMouseDown={requestClose}>
      <section
        className="capability-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="capability-drawer-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="editor-header capability-drawer-header">
          <div>
            <span className="eyebrow">MCP FABRIC · CAPABILITY CATALOG</span>
            <h2 id="capability-drawer-title">Add capabilities to {bundleLabel}</h2>
            <p>Extend this authorization boundary without replacing existing connections, skills or policies.</p>
          </div>
          <button type="button" className="editor-close" aria-label="Close capability catalog" onClick={requestClose}>
            <X size={18} />
          </button>
        </header>

        <div className="capability-drawer-summary" aria-label="Available capability summary">
          <span><Wrench size={15} /><b>{allAvailable.length}</b><small>available</small></span>
          <span><ShieldCheck size={15} /><b>{unassignedCount}</b><small>unassigned</small></span>
          <span><Boxes size={15} /><b>{sharedCount}</b><small>shared boundaries</small></span>
          <span><Server size={15} /><b>{countCapabilitySources(allAvailable)}</b><small>sources</small></span>
        </div>

        <div className="capability-drawer-body">
          <section className="capability-catalog">
            <div className="capability-catalog-toolbar">
              <label className="search-field">
                <Search size={15} />
                <input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Search capability name or description" />
              </label>
              <select
                aria-label="Capability source"
                value={String(source)}
                onChange={event => setSource(event.target.value === 'all' || event.target.value === 'direct'
                  ? event.target.value
                  : Number(event.target.value))}
              >
                <option value="all">All sources</option>
                {hasDirectTools && <option value="direct">Direct / legacy</option>}
                {sourceOptions.map(backend => <option value={backend.id} key={backend.id}>{backend.name}</option>)}
              </select>
            </div>
            <div className="capability-filter-row">
              <div className="segmented-filter" aria-label="Capability access type">
                {(['all', 'read', 'write'] as const).map(value => (
                  <button type="button" className={access === value ? 'is-active' : ''} onClick={() => setAccess(value)} key={value}>
                    {value === 'all' ? 'All capability types' : value === 'read' ? 'Read / other' : 'Write flagged'}
                  </button>
                ))}
              </div>
              <div className="segmented-filter" aria-label="Capability assignment status">
                {([
                  ['all', 'All available'],
                  ['unassigned', 'Unassigned'],
                  ['governed', 'Other bundles'],
                ] as const).map(([value, label]) => (
                  <button type="button" className={assignment === value ? 'is-active' : ''} onClick={() => setAssignment(value)} key={value}>{label}</button>
                ))}
              </div>
            </div>
            <div className="capability-visible-selection">
              <span><b>{visible.length}</b> matching · <strong>{selectedTools.length}/{MAX_SELECTED_CAPABILITIES}</strong> selected</span>
              <div>
                <button type="button" disabled={visible.length === 0 || selectionAtLimit} onClick={() => setSelectedKeys(current => {
                  const next = new Set(current);
                  for (const tool of visible) {
                    if (next.size >= MAX_SELECTED_CAPABILITIES) break;
                    next.add(capabilityToolKey(tool));
                  }
                  return next;
                })}>Select visible</button>
                <button type="button" disabled={visibleSelectedCount === 0} onClick={() => setSelectedKeys(current => {
                  const next = new Set(current);
                  visibleKeys.forEach(key => next.delete(key));
                  return next;
                })}>Clear visible</button>
              </div>
            </div>
            {selectionAtLimit && (
              <div className="capability-selection-limit" role="status">
                Selection limit reached. Save this batch before assigning more capabilities.
              </div>
            )}

            {groups.length > 0 ? (
              <div className="capability-catalog-groups">
                {groups.map(group => (
                  <article key={group.backendId ?? 'direct'}>
                    <header>
                      <span className="server-icon"><Server size={14} /></span>
                      <div>
                        <b>{group.backend?.name ?? 'Direct / legacy tools'}</b>
                        <small>{group.tools.length} available · {group.backend?.type.toUpperCase() ?? 'DIRECT'}</small>
                      </div>
                    </header>
                    <div>
                      {group.tools.map(tool => {
                        const key = capabilityToolKey(tool);
                        const selected = selectedKeys.has(key);
                        const unavailableAtLimit = !selected && selectionAtLimit;
                        return (
                          <label className={`${selected ? 'is-selected' : ''}${unavailableAtLimit ? ' is-limit-disabled' : ''}`} key={key}>
                            <input type="checkbox" checked={selected} disabled={unavailableAtLimit} onChange={() => toggle(key)} />
                            <span className="connection-check">{selected && <Check size={11} />}</span>
                            <span>
                              <code>{tool.name}</code>
                              <small>{tool.description || 'No description provided'}</small>
                            </span>
                            <span className="capability-catalog-badges">
                              <em className={tool.isWrite ? 'is-write' : 'is-read'}>{tool.isWrite ? 'write flagged' : 'read / other'}</em>
                              <em className={tool.bundleIds.length === 0 ? 'is-unassigned' : ''}>
                                {tool.bundleIds.length === 0 ? 'unassigned' : `${tool.bundleIds.length} bundle${tool.bundleIds.length === 1 ? '' : 's'}`}
                              </em>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState
                title={allAvailable.length === 0 ? 'Bundle already contains the full catalog' : 'No matching capabilities'}
                description={allAvailable.length === 0
                  ? 'Discover a new connection or tool to extend this boundary.'
                  : 'Change the search phrase or catalog filters.'}
              />
            )}
          </section>

          <aside className="capability-assignment-preview">
            <div className="posture-section-title"><GitDiffIcon /><span><small>ASSIGNMENT DIFF</small><b>Review additive change</b></span></div>
            <div className="capability-preview-route">
              <span><Wrench size={15} /><b>{currentToolCount}</b><small>current tools</small></span>
              <ArrowRight size={15} />
              <span className="is-result"><CheckCircle2 size={15} /><b>{currentToolCount + selectedTools.length}</b><small>after save</small></span>
            </div>
            <div className="capability-preview-target">
              <span aria-hidden="true">+</span>
              <div><small>TARGET BUNDLE</small><b>{bundleLabel}</b></div>
              <em>{selectedTools.length} tools</em>
            </div>
            <div className="capability-preview-impact">
              <span><Server size={14} /><b>+{newConnectionCount}</b><small>new connection{newConnectionCount === 1 ? '' : 's'}</small></span>
              <span><ShieldCheck size={14} /><b>{selectedUnassignedCount}</b><small>first boundaries</small></span>
              <span><Boxes size={14} /><b>{selectedSharedCount}</b><small>shared tools</small></span>
            </div>
            <div className="capability-preview-selection">
              {selectedTools.slice(0, 8).map(tool => (
                <code key={capabilityToolKey(tool)}>{tool.name}</code>
              ))}
              {selectedTools.length > 8 && <small>+{selectedTools.length - 8} more</small>}
              {selectedTools.length === 0 && <p>Select capabilities from the catalog to build the assignment diff.</p>}
            </div>
            <div className="capability-preview-note">
              <KeyRound size={13} />
              <span>{selectedTools.some(tool => tool.bundleIds.length === 0)
                ? 'Unassigned tools become governed by this bundle immediately.'
                : 'Existing assignments remain intact; these capabilities become shared.'}</span>
            </div>
            {error && <div className="access-manager-error" role="alert">{error}</div>}
            <button
              type="button"
              className="button button-primary"
              disabled={saving || selectedTools.length === 0}
              onClick={() => onAssign({
                bundleId,
                tools: selectedTools.map(tool => ({ backendId: tool.backendId, name: tool.name })),
              })}
            >
              <ShieldCheck size={14} />
              {saving ? 'Adding capabilities…' : `Add ${selectedTools.length} capabilities`}
              <ArrowRight size={13} />
            </button>
          </aside>
        </div>
      </section>
    </div>
  );
}

function GitDiffIcon() {
  return <span className="capability-diff-icon" aria-hidden="true">+−</span>;
}
