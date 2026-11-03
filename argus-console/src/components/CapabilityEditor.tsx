import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Braces,
  Check,
  Code2,
  Database,
  KeyRound,
  Link2,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type {
  CapabilityMutation,
  CapabilityParameter,
  CapabilityStudioItem,
  CapabilityStudioResponse,
} from '../types';

type CapabilityImplementation = 'postgresql' | 'http' | 'connected';

function initialImplementation(capability: CapabilityStudioItem | null): CapabilityImplementation {
  if (!capability || capability.backend === 'postgresql') return 'postgresql';
  if (capability.backend === 'http') return 'http';
  return 'connected';
}

function capabilityMethod(template: string): string | null {
  return template.trim().split('\n', 1)[0]?.match(/^(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase() ?? null;
}

function isWriteTemplate(implementation: CapabilityImplementation, template: string): boolean {
  if (implementation === 'postgresql') return false;
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(capabilityMethod(template) ?? '');
}

export function CapabilityEditor({
  capability,
  bundles,
  backends,
  saving,
  deleting,
  error,
  onClose,
  onSave,
  onDelete,
}: {
  capability: CapabilityStudioItem | null;
  bundles: CapabilityStudioResponse['bundles'];
  backends: CapabilityStudioResponse['backends'];
  saving: boolean;
  deleting: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: CapabilityMutation) => void;
  onDelete: (() => void) | null;
}) {
  const implementation = initialImplementation(capability);
  const [source, setSource] = useState<CapabilityImplementation>(implementation);
  const [name, setName] = useState(capability?.name ?? '');
  const [description, setDescription] = useState(capability?.description ?? '');
  const [category, setCategory] = useState(capability?.category ?? 'Operations');
  const [queryTemplate, setQueryTemplate] = useState(capability?.queryTemplate ?? '');
  const [backendName, setBackendName] = useState(
    capability?.backend.startsWith('custom:') ? capability.backend.slice('custom:'.length) : '',
  );
  const [parameters, setParameters] = useState<CapabilityParameter[]>(capability?.parameters ?? []);
  const [enabled, setEnabled] = useState(capability?.enabled ?? true);
  const [bundleIds, setBundleIds] = useState<number[]>(capability?.bundleIds ?? []);
  const [allowUnscoped, setAllowUnscoped] = useState((capability?.bundleIds.length ?? 1) === 0);
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high'>(capability?.riskLevel ?? 'low');
  const [requiredAuthMode, setRequiredAuthMode] = useState<'service-account' | 'permissive' | 'strict' | null>(
    capability?.requiredAuthMode ?? null,
  );
  const [dirty, setDirty] = useState(false);
  const [validationError, setValidationError] = useState('');
  const customBackends = useMemo(() => backends.filter(backend => backend.type === 'http'), [backends]);
  const writeFlagged = isWriteTemplate(source, queryTemplate);
  const busy = saving || deleting;

  useEffect(() => {
    if (!backendName && customBackends.length > 0) setBackendName(customBackends[0]!.name);
  }, [backendName, customBackends]);

  useEffect(() => {
    if (!writeFlagged || riskLevel !== 'low') return;
    setRiskLevel('high');
  }, [riskLevel, writeFlagged]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      if (!dirty || window.confirm('Discard the unsaved capability changes?')) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [busy, dirty, onClose]);

  const change = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setDirty(true);
    setValidationError('');
  };
  const requestClose = () => {
    if (busy) return;
    if (dirty && !window.confirm('Discard the unsaved capability changes?')) return;
    onClose();
  };
  const updateParameter = (index: number, patch: Partial<CapabilityParameter>) => {
    change(setParameters, parameters.map((parameter, parameterIndex) =>
      parameterIndex === index ? { ...parameter, ...patch } : parameter));
  };
  const removeParameter = (index: number) => {
    change(setParameters, parameters.filter((_, parameterIndex) => parameterIndex !== index));
  };
  const toggleBundle = (bundleId: number) => {
    const next = bundleIds.includes(bundleId)
      ? bundleIds.filter(id => id !== bundleId)
      : [...bundleIds, bundleId];
    change(setBundleIds, next);
    if (next.length > 0) setAllowUnscoped(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalizedName)) {
      setValidationError('Use a stable lowercase name with letters, numbers, _ or -.');
      return;
    }
    if (!queryTemplate.trim()) {
      setValidationError('Define the capability implementation before saving.');
      return;
    }
    if (source === 'connected' && !backendName) {
      setValidationError('Select a connected HTTP system.');
      return;
    }
    if (bundleIds.length === 0 && !allowUnscoped) {
      setValidationError('Select a bundle or explicitly confirm unscoped access.');
      return;
    }
    const parameterNames = parameters.map(parameter => parameter.name.trim());
    if (parameterNames.some(parameterName => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parameterName))) {
      setValidationError('Every parameter needs a valid unique name.');
      return;
    }
    if (new Set(parameterNames).size !== parameterNames.length) {
      setValidationError('Parameter names must be unique.');
      return;
    }
    onSave({
      name: normalizedName,
      description: description.trim(),
      backend: source === 'postgresql' ? 'postgresql' : source === 'http' ? 'http' : `custom:${backendName}`,
      queryTemplate: queryTemplate.trim(),
      parameters: parameters.map((parameter, index) => ({
        ...parameter,
        name: parameterNames[index]!,
        description: parameter.description.trim(),
        ...(parameter.default?.trim() ? { default: parameter.default.trim() } : { default: undefined }),
      })),
      category: category.trim(),
      enabled,
      bundleIds,
      allowUnscoped,
      riskLevel,
      requiredAuthMode: source === 'connected' ? requiredAuthMode : null,
    });
  };

  return (
    <div className="editor-layer" role="presentation" onMouseDown={requestClose}>
      <section className="bundle-editor capability-editor" role="dialog" aria-modal="true" aria-labelledby="capability-editor-title" onMouseDown={event => event.stopPropagation()}>
        <header className="editor-header">
          <div>
            <span className="eyebrow">MCP FABRIC · CAPABILITY STUDIO</span>
            <h2 id="capability-editor-title">{capability ? `Edit ${capability.name}` : 'Create managed capability'}</h2>
            <p>Define implementation, typed inputs and the authorization boundaries that can expose this tool.</p>
          </div>
          <button type="button" className="editor-close" aria-label="Close capability editor" onClick={requestClose}><X size={18} /></button>
        </header>

        <form className="bundle-editor-form capability-editor-form" onSubmit={submit}>
          <div className="editor-form-column">
            <section className="editor-section">
              <div className="editor-section-heading">
                <span><Wrench size={16} /></span>
                <div><small>DEFINITION</small><h3>Name and purpose</h3></div>
                <strong>{enabled ? 'Enabled' : 'Draft'}</strong>
              </div>
              <div className="editor-field-grid">
                <label className="editor-field">
                  <span>Stable name <em>required</em></span>
                  <input
                    autoFocus
                    disabled={Boolean(capability)}
                    maxLength={64}
                    value={name}
                    onChange={event => change(setName, event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_'))}
                    placeholder="incident_lookup"
                  />
                  <small>Names are immutable because workflows and policies reference them.</small>
                </label>
                <label className="editor-field">
                  <span>Category</span>
                  <input maxLength={64} value={category} onChange={event => change(setCategory, event.target.value)} placeholder="Operations" />
                </label>
              </div>
              <label className="editor-field">
                <span>Description</span>
                <textarea rows={3} maxLength={500} value={description} onChange={event => change(setDescription, event.target.value)} placeholder="What this capability lets an agent or workflow do." />
                <small>{description.length}/500 · This text becomes model-visible tool context.</small>
              </label>
              <label className="editor-toggle-row capability-enabled-toggle">
                <input type="checkbox" checked={enabled} onChange={event => change(setEnabled, event.target.checked)} />
                <span><b>Available to runtimes</b><small>Disabled capabilities remain editable but cannot execute.</small></span>
                <em>{enabled ? 'ON' : 'OFF'}</em>
              </label>
            </section>

            <section className="editor-section">
              <div className="editor-section-heading">
                <span><Code2 size={16} /></span>
                <div><small>IMPLEMENTATION</small><h3>Execution source</h3></div>
                <strong className={writeFlagged ? 'is-risk' : ''}>{writeFlagged ? 'WRITE FLAGGED' : 'READ / OTHER'}</strong>
              </div>
              <div className="capability-source-switch" role="group" aria-label="Capability implementation type">
                {([
                  ['postgresql', Database, 'PostgreSQL', 'Read-only parameterized query'],
                  ['http', Link2, 'Direct HTTP', 'Absolute egress-checked URL'],
                  ['connected', Braces, 'Connected system', 'Reuse stored connection auth'],
                ] as const).map(([value, Icon, label, detail]) => (
                  <button
                    type="button"
                    className={source === value ? 'is-active' : ''}
                    disabled={Boolean(capability)}
                    onClick={() => change(setSource, value)}
                    key={value}
                  >
                    <Icon size={15} /><span><b>{label}</b><small>{detail}</small></span>{source === value && <Check size={13} />}
                  </button>
                ))}
              </div>
              {source === 'connected' && (
                <label className="editor-field">
                  <span>Connected HTTP system <em>required</em></span>
                  <select disabled={Boolean(capability)} value={backendName} onChange={event => change(setBackendName, event.target.value)}>
                    {customBackends.map(backend => (
                      <option value={backend.name} key={backend.id}>{backend.name}{backend.enabled ? '' : ' · disabled'}</option>
                    ))}
                  </select>
                  <small>Credentials remain stored on the connection and never enter this template.</small>
                </label>
              )}
              <label className="editor-field">
                <span>{source === 'postgresql' ? 'Read-only SQL' : source === 'http' ? 'HTTP request template' : 'Relative request template'} <em>required</em></span>
                <textarea
                  className="prompt-textarea capability-code-editor"
                  rows={9}
                  maxLength={50_000}
                  value={queryTemplate}
                  onChange={event => change(setQueryTemplate, event.target.value)}
                  placeholder={source === 'postgresql'
                    ? 'SELECT id, status FROM incidents WHERE id = {{incidentId}}'
                    : source === 'http'
                      ? 'GET https://api.example.com/incidents/{{incidentId}}'
                      : 'POST /issues\nContent-Type: application/json\n\n{"title":"{{title}}"}'}
                />
                <small>{source === 'postgresql'
                  ? 'Exactly one SELECT/WITH/EXPLAIN/VALUES statement. Argus runs it in a read-only transaction.'
                  : 'Supported methods: GET, POST, PUT, PATCH, DELETE. Write methods are flagged automatically.'}</small>
              </label>
              {source === 'http' && (
                <div className="capability-inline-warning"><AlertTriangle size={14} /><span>Do not place credentials in this template. Use a connected system when authentication is required.</span></div>
              )}
            </section>

            <section className="editor-section">
              <div className="editor-section-heading">
                <span><Braces size={16} /></span>
                <div><small>INPUT CONTRACT</small><h3>Typed parameters</h3></div>
                <button type="button" className="editor-inline-action" onClick={() => change(setParameters, [
                  ...parameters,
                  { name: '', type: 'string', description: '', required: true },
                ])}><Plus size={12} />Add parameter</button>
              </div>
              {parameters.length > 0 ? (
                <div className="capability-parameter-list">
                  {parameters.map((parameter, index) => (
                    <article key={`${index}-${parameter.name}`}>
                      <div>
                        <label><span>Name</span><input value={parameter.name} onChange={event => updateParameter(index, { name: event.target.value })} placeholder="incidentId" /></label>
                        <label><span>Type</span><select value={parameter.type} onChange={event => updateParameter(index, { type: event.target.value as CapabilityParameter['type'] })}><option value="string">String</option><option value="number">Number</option><option value="boolean">Boolean</option></select></label>
                        <label><span>Default</span><input value={parameter.default ?? ''} onChange={event => updateParameter(index, { default: event.target.value })} placeholder="Optional" /></label>
                        <label className="parameter-required"><input type="checkbox" checked={parameter.required} onChange={event => updateParameter(index, { required: event.target.checked })} /><span>Required</span></label>
                        <button type="button" aria-label={`Remove parameter ${parameter.name || index + 1}`} onClick={() => removeParameter(index)}><Trash2 size={13} /></button>
                      </div>
                      <input value={parameter.description} onChange={event => updateParameter(index, { description: event.target.value })} placeholder="Description visible to the model" maxLength={200} />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="capability-parameter-empty"><Braces size={17} /><span><b>No runtime inputs</b><small>Add a parameter for every {'{{placeholder}}'} used by the implementation.</small></span></div>
              )}
            </section>
          </div>

          <div className="editor-form-column">
            <section className="editor-section capability-scope-section">
              <div className="editor-section-heading">
                <span><ShieldCheck size={16} /></span>
                <div><small>AUTHORIZATION</small><h3>Bundle boundaries</h3></div>
                <strong>{bundleIds.length || 'GLOBAL'}</strong>
              </div>
              <p className="editor-section-copy">Only principals that can enter one of these bundles can discover and execute the capability.</p>
              <div className="capability-bundle-picker">
                {bundles.map(bundle => {
                  const selected = bundleIds.includes(bundle.id);
                  return (
                    <label className={selected ? 'is-selected' : ''} key={bundle.id}>
                      <input type="checkbox" checked={selected} onChange={() => toggleBundle(bundle.id)} />
                      <span className="connection-check">{selected && <Check size={11} />}</span>
                      <span aria-hidden="true">{bundle.icon || '◈'}</span>
                      <span><b>{bundle.label}</b><small>{bundle.name}</small></span>
                    </label>
                  );
                })}
              </div>
              {bundleIds.length === 0 && (
                <label className={`capability-unscoped-gate${allowUnscoped ? ' is-confirmed' : ''}`}>
                  <input type="checkbox" checked={allowUnscoped} onChange={event => change(setAllowUnscoped, event.target.checked)} />
                  <AlertTriangle size={15} />
                  <span><b>Allow without a bundle boundary</b><small>This exposes the capability to unrestricted legacy identities. Confirm only when intentional.</small></span>
                </label>
              )}
            </section>

            <section className="editor-section">
              <div className="editor-section-heading">
                <span><ShieldCheck size={16} /></span>
                <div><small>RUNTIME GUARDRAILS</small><h3>Risk and upstream identity</h3></div>
              </div>
              <label className="editor-field">
                <span>Risk classification</span>
                <select value={riskLevel} onChange={event => change(setRiskLevel, event.target.value as typeof riskLevel)}>
                  {!writeFlagged && <option value="low">Low · informational</option>}
                  <option value="medium">Medium · consequential</option>
                  <option value="high">High · human oversight</option>
                </select>
                <small>{writeFlagged ? 'Write methods require medium or high risk.' : 'Choose based on the impact of returned information.'}</small>
              </label>
              {source === 'connected' && (
                <label className="editor-field">
                  <span>Upstream authentication</span>
                  <select value={requiredAuthMode ?? ''} onChange={event => change(setRequiredAuthMode, event.target.value ? event.target.value as Exclude<typeof requiredAuthMode, null> : null)}>
                    <option value="">Follow connection default</option>
                    <option value="service-account">Service account</option>
                    <option value="permissive">Require user OAuth (legacy permissive)</option>
                    <option value="strict">Require user identity</option>
                  </select>
                  <small>Use strict for destructive or identity-sensitive operations.</small>
                </label>
              )}
              <div className={`capability-risk-preview risk-${riskLevel}`}>
                {writeFlagged ? <AlertTriangle size={17} /> : <ShieldCheck size={17} />}
                <span><small>EFFECTIVE POSTURE</small><b>{writeFlagged ? 'State-changing capability' : 'Read / other capability'}</b><em>{riskLevel} risk</em></span>
              </div>
            </section>

            {capability && (
              <section className="editor-section capability-dependency-card">
                <div className="editor-section-heading">
                  <span><KeyRound size={16} /></span>
                  <div><small>DEPENDENCIES</small><h3>Safe lifecycle</h3></div>
                </div>
                <div><span><b>{capability.workflowCount}</b><small>workflow references</small></span><span><b>{bundleIds.length}</b><small>bundle boundaries</small></span></div>
                <p>{capability.workflowCount > 0
                  ? 'Deletion remains blocked until every referencing workflow is updated.'
                  : 'No workflow currently blocks deletion. The audit trail will retain the final configuration snapshot.'}</p>
              </section>
            )}
          </div>

          <footer className="editor-footer capability-editor-footer">
            <div>
              {onDelete && (
                <button
                  type="button"
                  className="button button-danger"
                  disabled={busy || (capability?.workflowCount ?? 0) > 0}
                  onClick={() => {
                    if (window.confirm(`Delete ${capability?.name}? This cannot be undone.`)) onDelete();
                  }}
                ><Trash2 size={14} />{deleting ? 'Deleting…' : 'Delete capability'}</button>
              )}
            </div>
            <div className="editor-footer-status">
              {(validationError || error) && <span className="editor-error" role="alert">{validationError || error}</span>}
            </div>
            <div>
              <button type="button" className="button button-secondary" disabled={busy} onClick={requestClose}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={busy}><Save size={14} />{saving ? 'Saving…' : capability ? 'Save capability' : 'Create capability'}</button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
