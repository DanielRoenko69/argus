import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Boxes,
  Check,
  KeyRound,
  LockKeyhole,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { HealthBadge } from './Ui';
import type {
  FabricBundleMutation,
  FabricManagementBackend,
  FabricManagementBundle,
  FabricManagementSkill,
  FabricManagementTool,
} from '../types';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128);
}

export function BundleEditor({
  bundle,
  backends,
  skills,
  tools,
  saving,
  deleting,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  bundle: FabricManagementBundle | null;
  backends: FabricManagementBackend[];
  skills: FabricManagementSkill[];
  tools: FabricManagementTool[];
  saving: boolean;
  deleting: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: FabricBundleMutation) => void;
  onDelete: (() => void) | null;
}) {
  const [label, setLabel] = useState(bundle?.label ?? '');
  const [name, setName] = useState(bundle?.name ?? '');
  const [nameTouched, setNameTouched] = useState(Boolean(bundle));
  const [description, setDescription] = useState(bundle?.description ?? '');
  const [icon, setIcon] = useState(bundle?.icon ?? '');
  const [backendIds, setBackendIds] = useState<number[]>(bundle?.backendIds ?? []);
  const [skillIds, setSkillIds] = useState<number[]>(bundle?.skillIds ?? []);
  const [toolPolicies, setToolPolicies] = useState(() => new Map(
    (bundle?.toolPolicies ?? []).map(policy => [policy.backendId, {
      mode: policy.mode,
      allowedToolNames: [...policy.allowedToolNames],
    }]),
  ));
  const [policyBackendId, setPolicyBackendId] = useState<number | null>(bundle?.backendIds[0] ?? null);
  const [toolSearch, setToolSearch] = useState('');
  const [backendSearch, setBackendSearch] = useState('');
  const [skillSearch, setSkillSearch] = useState('');
  const [dirty, setDirty] = useState(false);
  const selected = useMemo(() => new Set(backendIds), [backendIds]);
  const selectedSkills = useMemo(() => new Set(skillIds), [skillIds]);
  const policyBackend = useMemo(
    () => backends.find(backend => backend.id === policyBackendId) ?? null,
    [backends, policyBackendId],
  );
  const activePolicy = policyBackendId == null
    ? null
    : toolPolicies.get(policyBackendId) ?? { mode: 'all' as const, allowedToolNames: [] };
  const policyTools = useMemo(() => {
    if (policyBackendId == null) return [];
    const discovered = tools
      .filter(tool => tool.backendId === policyBackendId)
      .map(tool => ({ ...tool, unavailable: false }));
    const discoveredNames = new Set(discovered.map(tool => tool.name));
    const unavailable = (activePolicy?.allowedToolNames ?? [])
      .filter(name => !discoveredNames.has(name))
      .map(name => ({
        backendId: policyBackendId,
        name,
        description: 'Previously allowed, but not present in the latest discovery.',
        source: 'remote' as const,
        enabled: false,
        isWrite: false,
        unavailable: true,
      }));
    const normalized = toolSearch.trim().toLowerCase();
    return [...discovered, ...unavailable]
      .filter(tool => !normalized || `${tool.name} ${tool.description}`.toLowerCase().includes(normalized))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [activePolicy?.allowedToolNames, policyBackendId, toolSearch, tools]);
  const visibleBackends = useMemo(() => {
    const normalized = backendSearch.trim().toLowerCase();
    return backends.filter(backend =>
      !normalized
      || `${backend.name} ${backend.description} ${backend.type} ${backend.endpoint}`.toLowerCase().includes(normalized),
    );
  }, [backendSearch, backends]);
  const visibleSkills = useMemo(() => {
    const normalized = skillSearch.trim().toLowerCase();
    return skills.filter(skill =>
      !normalized
      || `${skill.name} ${skill.label} ${skill.description} ${skill.category ?? ''}`.toLowerCase().includes(normalized),
    );
  }, [skillSearch, skills]);

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving && !deleting) {
        if (!dirty || window.confirm('Ungespeicherte Änderungen verwerfen?')) onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('has-dialog');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [deleting, dirty, onClose, saving]);

  const updateLabel = (value: string) => {
    setLabel(value);
    if (!bundle && !nameTouched) setName(slugify(value));
    setDirty(true);
  };
  const toggleBackend = (id: number) => {
    setBackendIds(current => {
      if (current.includes(id)) {
        const next = current.filter(value => value !== id);
        if (policyBackendId === id) setPolicyBackendId(next[0] ?? null);
        return next;
      }
      setToolPolicies(policies => {
        if (policies.has(id)) return policies;
        const next = new Map(policies);
        next.set(id, { mode: 'all' as const, allowedToolNames: [] });
        return next;
      });
      setPolicyBackendId(id);
      return [...current, id];
    });
    setDirty(true);
  };
  const setPolicyMode = (mode: 'all' | 'selected') => {
    if (policyBackendId == null) return;
    setToolPolicies(current => {
      const next = new Map(current);
      const existing = next.get(policyBackendId);
      next.set(policyBackendId, {
        mode,
        allowedToolNames: mode === 'all' ? [] : existing?.allowedToolNames ?? [],
      });
      return next;
    });
    setDirty(true);
  };
  const setAllowedToolNames = (names: string[]) => {
    if (policyBackendId == null) return;
    setToolPolicies(current => {
      const next = new Map(current);
      next.set(policyBackendId, {
        mode: 'selected',
        allowedToolNames: [...new Set(names)],
      });
      return next;
    });
    setDirty(true);
  };
  const toggleTool = (name: string) => {
    const names = activePolicy?.allowedToolNames ?? [];
    setAllowedToolNames(names.includes(name) ? names.filter(value => value !== name) : [...names, name]);
  };
  const toggleSkill = (id: number) => {
    setSkillIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
    setDirty(true);
  };
  const requestClose = () => {
    if (saving || deleting) return;
    if (!dirty || window.confirm('Ungespeicherte Änderungen verwerfen?')) onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      ...(!bundle ? { name } : {}),
      label,
      description,
      icon,
      // Bundle prompts are a legacy transport field. Agent identity and
      // instructions are configured in Agent Studio; preserve old values but
      // never create a second source of truth here.
      agentRole: bundle?.agentRole ?? null,
      systemPrompt: bundle?.systemPrompt ?? null,
      backendIds,
      skillIds,
      toolPolicies: backendIds.map(backendId => {
        const policy = toolPolicies.get(backendId);
        return {
          backendId,
          mode: policy?.mode ?? 'all',
          allowedToolNames: policy?.mode === 'selected' ? policy.allowedToolNames : [],
        };
      }),
    });
  };

  return (
    <div className="editor-layer" role="presentation" onMouseDown={requestClose}>
      <section
        className="bundle-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bundle-editor-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="editor-header">
          <div>
            <span className="eyebrow">MCP FABRIC · ACCESS CONTROL</span>
            <h2 id="bundle-editor-title">{bundle ? `Edit ${bundle.label}` : 'Create backend bundle'}</h2>
            <p>Define the reusable access boundary and the systems whose capabilities it exposes.</p>
          </div>
          <button type="button" className="editor-close" aria-label="Close bundle editor" onClick={requestClose}>
            <X size={18} />
          </button>
        </header>

        <form className="bundle-editor-form" onSubmit={submit}>
          <div className="editor-form-column">
            <section className="editor-section">
              <div className="editor-section-heading">
                <span><Boxes size={17} /></span>
                <div><small>IDENTITY</small><h3>Bundle definition</h3></div>
              </div>
              <div className="editor-field-grid">
                <label className="editor-field">
                  <span>Display name <em>required</em></span>
                  <input autoFocus required maxLength={256} value={label} onChange={event => updateLabel(event.target.value)} placeholder="Incident Operations" />
                </label>
                <label className="editor-field icon-field">
                  <span>Icon</span>
                  <input maxLength={32} value={icon} onChange={event => { setIcon(event.target.value); setDirty(true); }} placeholder="◈" />
                </label>
              </div>
              <label className="editor-field">
                <span>Internal name {!bundle && <em>required</em>}</span>
                <input
                  required
                  disabled={Boolean(bundle)}
                  maxLength={128}
                  pattern="[a-z0-9][a-z0-9_]*"
                  value={name}
                  onChange={event => { setName(event.target.value.toLowerCase()); setNameTouched(true); setDirty(true); }}
                  placeholder="incident_operations"
                />
                <small>{bundle ? 'Stable after creation to preserve MCP endpoints.' : `Endpoint: /mcp/group/${name || 'bundle_name'}`}</small>
              </label>
              <label className="editor-field">
                <span>Description</span>
                <textarea rows={3} maxLength={5000} value={description} onChange={event => { setDescription(event.target.value); setDirty(true); }} placeholder="What this access boundary contains and who should use it." />
              </label>
            </section>

            <section className="editor-section">
              <div className="editor-section-heading">
                <span><Wrench size={17} /></span>
                <div><small>REUSABLE EXPERTISE</small><h3>Bound skills</h3></div>
                <strong>{skillIds.length} selected</strong>
              </div>
              <p className="editor-section-description">Selected skills are exposed as MCP prompts and become reusable context for eligible consumers.</p>
              <label className="editor-search">
                <Search size={15} />
                <input value={skillSearch} onChange={event => setSkillSearch(event.target.value)} placeholder="Search skills and categories" />
              </label>
              <div className="picker-actions">
                <button type="button" onClick={() => {
                  setSkillIds(current => [...new Set([...current, ...visibleSkills.map(skill => skill.id)])]);
                  setDirty(true);
                }}>Select visible</button>
                <button type="button" onClick={() => {
                  const visibleIds = new Set(visibleSkills.map(skill => skill.id));
                  setSkillIds(current => current.filter(id => !visibleIds.has(id)));
                  setDirty(true);
                }}>Clear visible</button>
              </div>
              <div className="skill-option-list">
                {visibleSkills.map(skill => (
                  <label className={`skill-option${selectedSkills.has(skill.id) ? ' is-selected' : ''}`} key={skill.id}>
                    <input type="checkbox" checked={selectedSkills.has(skill.id)} onChange={() => toggleSkill(skill.id)} />
                    <span className="connection-check">{selectedSkills.has(skill.id) && <Check size={13} />}</span>
                    <span className="skill-option-icon">{skill.icon || '◆'}</span>
                    <span className="skill-option-copy">
                      <b>{skill.label}</b>
                      <code>{skill.name}</code>
                    </span>
                    {skill.category && <em>{skill.category}</em>}
                  </label>
                ))}
                {visibleSkills.length === 0 && <div className="picker-empty">No matching skills.</div>}
              </div>
            </section>
          </div>

          <section className="editor-section connection-picker">
            <div className="editor-section-heading">
              <span><Server size={17} /></span>
              <div><small>CONNECTIONS</small><h3>Servers in this bundle</h3></div>
              <strong>{backendIds.length} selected</strong>
            </div>
            <p className="editor-section-description">Add servers first, then decide whether the bundle exposes all capabilities or only an explicit allowlist.</p>
            <label className="editor-search">
              <Search size={15} />
              <input value={backendSearch} onChange={event => setBackendSearch(event.target.value)} placeholder="Search connections" />
            </label>
            <div className="picker-actions">
              <button type="button" onClick={() => {
                const ids = backends.map(backend => backend.id);
                setBackendIds(ids);
                setToolPolicies(current => {
                  const next = new Map(current);
                  ids.forEach(id => {
                    if (!next.has(id)) next.set(id, { mode: 'all' as const, allowedToolNames: [] });
                  });
                  return next;
                });
                setPolicyBackendId(current => current ?? ids[0] ?? null);
                setDirty(true);
              }}>Select all</button>
              <button type="button" onClick={() => {
                setBackendIds([]);
                setPolicyBackendId(null);
                setDirty(true);
              }}>Clear</button>
            </div>
            <div className="connection-option-list">
              {visibleBackends.map(backend => (
                <label className={`connection-option${selected.has(backend.id) ? ' is-selected' : ''}`} key={backend.id}>
                  <input type="checkbox" checked={selected.has(backend.id)} onChange={() => toggleBackend(backend.id)} />
                  <span className="connection-check">{selected.has(backend.id) && <Check size={13} />}</span>
                  <span className="connection-option-icon"><Server size={16} /></span>
                  <span className="connection-option-copy">
                    <b>{backend.name}</b>
                    <small>{backend.endpoint || backend.description || 'Internal connection'}</small>
                    <em>{backend.toolCount} tools · {backend.type.toUpperCase()}</em>
                  </span>
                  <HealthBadge state={backend.state} />
                </label>
              ))}
              {visibleBackends.length === 0 && <div className="picker-empty">No matching connections.</div>}
            </div>
            <div className="tool-policy-panel">
              <div className="tool-policy-heading">
                <span><ShieldCheck size={15} /></span>
                <div>
                  <small>TOOL ACCESS</small>
                  <b>Capabilities in this bundle</b>
                </div>
                {activePolicy?.mode === 'selected' && (
                  <em>{activePolicy.allowedToolNames.length} allowed</em>
                )}
              </div>
              {backendIds.length === 0 ? (
                <div className="tool-policy-empty">
                  <LockKeyhole size={18} />
                  <span>Select a connection to configure its tools.</span>
                </div>
              ) : (
                <>
                  <label className="tool-policy-backend">
                    <span>Connection</span>
                    <select
                      value={policyBackendId ?? ''}
                      onChange={event => {
                        setPolicyBackendId(Number(event.target.value));
                        setToolSearch('');
                      }}
                    >
                      {backendIds.map(id => {
                        const backend = backends.find(candidate => candidate.id === id);
                        return backend && <option value={id} key={id}>{backend.name}</option>;
                      })}
                    </select>
                  </label>
                  <div className="tool-policy-modes" role="group" aria-label="Tool access mode">
                    <button
                      type="button"
                      className={activePolicy?.mode === 'all' ? 'is-active' : ''}
                      onClick={() => setPolicyMode('all')}
                    >
                      <Wrench size={14} />
                      <span><b>All tools</b><small>Includes future discoveries</small></span>
                    </button>
                    <button
                      type="button"
                      className={activePolicy?.mode === 'selected' ? 'is-active' : ''}
                      onClick={() => setPolicyMode('selected')}
                    >
                      <LockKeyhole size={14} />
                      <span><b>Selected only</b><small>Future tools stay denied</small></span>
                    </button>
                  </div>
                  {activePolicy?.mode === 'selected' && (
                    <div className="tool-allowlist">
                      <label className="editor-search">
                        <Search size={15} />
                        <input
                          value={toolSearch}
                          onChange={event => setToolSearch(event.target.value)}
                          placeholder={`Search ${policyBackend?.name ?? ''} tools`}
                        />
                      </label>
                      <div className="picker-actions">
                        <button type="button" onClick={() => setAllowedToolNames(
                          tools.filter(tool => tool.backendId === policyBackendId).map(tool => tool.name),
                        )}>Allow discovered</button>
                        <button type="button" onClick={() => setAllowedToolNames([])}>Deny all</button>
                      </div>
                      <div className="tool-option-list">
                        {policyTools.map(tool => {
                          const allowed = activePolicy.allowedToolNames.includes(tool.name);
                          return (
                            <label className={`tool-option${allowed ? ' is-selected' : ''}${tool.unavailable ? ' is-unavailable' : ''}`} key={tool.name}>
                              <input type="checkbox" checked={allowed} onChange={() => toggleTool(tool.name)} />
                              <span className="connection-check">{allowed && <Check size={13} />}</span>
                              <span className="tool-option-copy">
                                <b>{tool.name}</b>
                                <small>{tool.description || 'No description provided'}</small>
                              </span>
                              <span className="tool-option-badges">
                                {tool.isWrite && <em className="is-write">WRITE</em>}
                                <em>{tool.unavailable ? 'MISSING' : tool.source.toUpperCase()}</em>
                              </span>
                            </label>
                          );
                        })}
                        {policyTools.length === 0 && (
                          <div className="picker-empty compact">No discovered tools match this filter.</div>
                        )}
                      </div>
                      <p className="tool-policy-safety"><LockKeyhole size={12} /> Newly discovered tools require explicit approval in this mode.</p>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="assignment-note">
              <KeyRound size={15} />
              <span>Bundle grants still combine with user, agent, API-key and tool allow/deny policies.</span>
            </div>
          </section>

          {error && (
            <div className="editor-error" role="alert">
              <AlertTriangle size={16} /><span>{error}</span>
            </div>
          )}

          <footer className="editor-footer">
            <div>
              {onDelete && (
                <button
                  className="button editor-delete"
                  type="button"
                  disabled={saving || deleting}
                  onClick={() => {
                    if (window.confirm(`Bundle „${bundle?.label}“ löschen? Connections und Tools bleiben erhalten.`)) onDelete();
                  }}
                >
                  <Trash2 size={15} />{deleting ? 'Deleting…' : 'Delete bundle'}
                </button>
              )}
            </div>
            <div>
              <button className="button button-secondary" type="button" disabled={saving || deleting} onClick={requestClose}>Cancel</button>
              <button className="button button-primary" type="submit" disabled={saving || deleting || !label.trim() || !name.trim()}>
                {saving ? 'Saving…' : bundle ? 'Save changes' : 'Create bundle'}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
