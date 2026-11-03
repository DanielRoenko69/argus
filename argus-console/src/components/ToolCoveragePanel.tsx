import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { capabilityToolKey } from '../capabilityCatalog';
import type {
  FabricManagementResponse,
  FabricToolAssignmentInput,
} from '../types';

export function ToolCoveragePanel({
  data,
  saving,
  error,
  onAssign,
}: {
  data: FabricManagementResponse;
  saving: boolean;
  error: string | null;
  onAssign: (input: FabricToolAssignmentInput) => void;
}) {
  const enabledTools = useMemo(() => data.tools.filter(tool => tool.enabled), [data.tools]);
  const unassignedTools = useMemo(
    () => enabledTools.filter(tool => tool.bundleIds.length === 0),
    [enabledTools],
  );
  const unassignedKeys = useMemo(() => new Set(unassignedTools.map(capabilityToolKey)), [unassignedTools]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bundleId, setBundleId] = useState<number>(data.bundles[0]?.id ?? 0);
  const assignedCount = enabledTools.length - unassignedTools.length;
  const coveragePercent = enabledTools.length === 0 ? 100 : Math.round((assignedCount / enabledTools.length) * 100);

  useEffect(() => {
    setSelectedKeys(current => {
      return new Set([...current].filter(key => unassignedKeys.has(key)));
    });
  }, [unassignedKeys]);

  useEffect(() => {
    if (!data.bundles.some(bundle => bundle.id === bundleId)) {
      setBundleId(data.bundles[0]?.id ?? 0);
    }
  }, [bundleId, data.bundles]);

  const groups = useMemo(() => {
    const grouped = new Map<number | null, typeof unassignedTools>();
    for (const tool of unassignedTools) {
      const group = grouped.get(tool.backendId) ?? [];
      group.push(tool);
      grouped.set(tool.backendId, group);
    }
    return [...grouped.entries()].map(([backendId, tools]) => ({
      backendId,
      backend: backendId == null ? null : data.backends.find(item => item.id === backendId),
      tools,
    }));
  }, [data.backends, unassignedTools]);
  const selectedTools = unassignedTools
    .filter(tool => selectedKeys.has(capabilityToolKey(tool)))
    .map(tool => ({ backendId: tool.backendId, name: tool.name }));

  return (
    <section className={`tool-coverage-panel${unassignedTools.length > 0 ? ' has-gaps' : ' is-complete'}`}>
      <header className="tool-coverage-heading">
        <span className="tool-coverage-icon">
          {unassignedTools.length > 0 ? <AlertTriangle size={18} /> : <ShieldCheck size={18} />}
        </span>
        <div>
          <span className="eyebrow">CATALOG COVERAGE</span>
          <h2>{unassignedTools.length > 0 ? `${unassignedTools.length} tools bypass bundle boundaries` : 'Every tool has a bundle boundary'}</h2>
          <p>Unassigned backend tools remain globally unscoped for backwards compatibility.</p>
        </div>
        <div className="tool-coverage-score">
          <strong>{coveragePercent}%</strong>
          <span>{assignedCount}/{enabledTools.length} covered</span>
        </div>
      </header>

      <div className="tool-coverage-progress"><span style={{ width: `${coveragePercent}%` }} /></div>

      {unassignedTools.length > 0 ? (
        <div className="tool-coverage-body">
          <section className="tool-coverage-inventory">
            <div className="tool-coverage-toolbar">
              <div>
                <span className="eyebrow">UNASSIGNED INVENTORY</span>
                <b>Select tools to contain</b>
              </div>
              <button
                type="button"
                onClick={() => setSelectedKeys(
                  selectedKeys.size === unassignedTools.length ? new Set() : new Set(unassignedKeys),
                )}
              >
                {selectedKeys.size === unassignedTools.length ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="tool-coverage-groups">
              {groups.map(group => (
                <article key={group.backendId ?? 'direct'}>
                  <header>
                    <span className="server-icon"><Wrench size={13} /></span>
                    <div><b>{group.backend?.name ?? 'Direct / legacy tools'}</b><small>{group.tools.length} unassigned tools</small></div>
                  </header>
                  <div>
                    {group.tools.map(tool => {
                      const key = capabilityToolKey(tool);
                      const checked = selectedKeys.has(key);
                      return (
                        <label className={checked ? 'is-selected' : ''} key={key}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedKeys(current => {
                              const next = new Set(current);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })}
                          />
                          <span className="connection-check">{checked && <Check size={11} />}</span>
                          <code>{tool.name}</code>
                          {tool.isWrite && <em>write</em>}
                        </label>
                      );
                    })}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <aside className="tool-coverage-action">
            <div className="posture-section-title"><Boxes size={15} /><span><small>CONTAINMENT</small><b>Assign to bundle</b></span></div>
            <p>The assignment is additive. Existing bundle connections, skills and tool policies remain intact.</p>
            <label className="editor-field">
              <span>Target bundle</span>
              <select value={bundleId} onChange={event => setBundleId(Number(event.target.value))}>
                {data.bundles.map(bundle => (
                  <option value={bundle.id} key={bundle.id}>{bundle.label} · {bundle.toolCount} tools</option>
                ))}
              </select>
            </label>
            <div className="tool-coverage-selection">
              <span><CheckCircle2 size={14} /><b>{selectedTools.length}</b> selected</span>
              <small>across {new Set(selectedTools.map(tool => tool.backendId)).size} connections</small>
            </div>
            <div className="tool-coverage-note">
              <AlertTriangle size={13} />
              <span>Selected tools become governed by this bundle immediately after saving.</span>
            </div>
            {error && <div className="access-manager-error" role="alert">{error}</div>}
            <button
              type="button"
              className="button button-primary"
              disabled={saving || bundleId < 1 || selectedTools.length === 0}
              onClick={() => onAssign({ bundleId, tools: selectedTools })}
            >
              <ShieldCheck size={14} />{saving ? 'Assigning…' : `Assign ${selectedTools.length} tools`}<ArrowRight size={13} />
            </button>
          </aside>
        </div>
      ) : (
        <div className="tool-coverage-complete">
          <CheckCircle2 size={16} />
          <span>New tools will appear here automatically if a connection is not attached to a bundle.</span>
        </div>
      )}
    </section>
  );
}
