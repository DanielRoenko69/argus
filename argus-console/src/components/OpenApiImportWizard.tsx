import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  CheckCircle2,
  FileCode2,
  Globe2,
  KeyRound,
  Layers3,
  Link2,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  DEFAULT_OPEN_API_OPERATION_FILTERS,
  filterOpenApiOperations,
  getSelectableOpenApiOperationKeys,
  isOpenApiOperationSelectable,
  sanitizeOpenApiPrefix,
  summarizeOpenApiOperations,
  toggleOpenApiOperation,
  toggleVisibleOpenApiOperations,
  type OpenApiOperationFilter,
} from '../openApiImport';
import type {
  CapabilityStudioResponse,
  OpenApiImportMutation,
  OpenApiImportResult,
  OpenApiImportSource,
  OpenApiPreview,
  OpenApiPreviewOperation,
} from '../types';

type SourceMode = 'url' | 'text' | 'file';
type Phase = 'editing' | 'previewing' | 'ready' | 'importing' | 'complete';

const MAX_OPEN_API_SPEC_BYTES = 2 * 1024 * 1024;
const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const STEPS = [
  { label: 'Source', detail: 'Load specification', icon: FileCode2 },
  { label: 'Review', detail: 'Select operations', icon: Braces },
  { label: 'Govern', detail: 'Secure and scope', icon: ShieldCheck },
  { label: 'Result', detail: 'Import summary', icon: CheckCircle2 },
] as const;

function operationView(operation: OpenApiPreviewOperation) {
  return {
    ...operation,
    collision: operation.change === 'collision' ? operation.collisionReason || true : false,
    unsupported: operation.supported ? false : operation.warnings.length > 0 ? operation.warnings : true,
  };
}

function authLabel(preview: OpenApiPreview): string {
  if (preview.security.auth_type === 'header') return `API key · ${preview.security.headerName}`;
  if (preview.security.auth_type === 'bearer') return 'Bearer token';
  if (preview.security.auth_type === 'basic') return 'Basic authentication';
  return preview.security.note ? 'Manual configuration needed' : 'No authentication';
}

export function OpenApiImportWizard({
  bundles,
  initialSource,
  onPreview,
  onImport,
  onComplete,
  onClose,
}: {
  bundles: CapabilityStudioResponse['bundles'];
  initialSource?: OpenApiImportSource;
  onPreview: (input: OpenApiImportSource) => Promise<OpenApiPreview>;
  onImport: (input: OpenApiImportMutation) => Promise<OpenApiImportResult>;
  onComplete: (result: OpenApiImportResult, preview: OpenApiPreview) => Promise<void> | void;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [phase, setPhase] = useState<Phase>('editing');
  const [sourceMode, setSourceMode] = useState<SourceMode>(initialSource?.specText ? 'text' : 'url');
  const [specUrl, setSpecUrl] = useState(initialSource?.specUrl ?? '');
  const [specText, setSpecText] = useState(initialSource?.specText ?? '');
  const [fileName, setFileName] = useState('');
  const [prefix, setPrefix] = useState(initialSource?.namePrefix ?? '');
  const [baseUrl, setBaseUrl] = useState(initialSource?.baseUrl ?? '');
  const [preview, setPreview] = useState<OpenApiPreview | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState(DEFAULT_OPEN_API_OPERATION_FILTERS);
  const [bundleIds, setBundleIds] = useState<number[]>([]);
  const [createDefaultBundle, setCreateDefaultBundle] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [credential, setCredential] = useState('');
  const [basicUser, setBasicUser] = useState('');
  const [basicPassword, setBasicPassword] = useState('');
  const [confirmWrites, setConfirmWrites] = useState(false);
  const [confirmReimport, setConfirmReimport] = useState(false);
  const [confirmRemovals, setConfirmRemovals] = useState(false);
  const [acknowledgeUnsupportedAuth, setAcknowledgeUnsupportedAuth] = useState(false);
  const [error, setError] = useState('');
  const [completionWarning, setCompletionWarning] = useState('');
  const [result, setResult] = useState<OpenApiImportResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const busy = phase === 'previewing' || phase === 'importing';

  useEffect(() => {
    document.body.classList.add('has-dialog');
    return () => {
      document.body.classList.remove('has-dialog');
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty && phase !== 'complete' && !window.confirm('Discard this OpenAPI import?')) return;
    onClose();
  }, [busy, dirty, onClose, phase]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)]
        .filter(element => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  const sourceInput = (): OpenApiImportSource => ({
    ...(sourceMode === 'url' ? { specUrl: specUrl.trim() } : { specText: specText.trim() }),
    ...(prefix.trim() ? { namePrefix: sanitizeOpenApiPrefix(prefix) } : {}),
    ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
  });

  const invalidatePreview = () => {
    setPreview(null);
    setSelectedKeys(new Set());
    setResult(null);
    setCompletionWarning('');
    setStep(0);
    setFurthestStep(0);
    setPhase('editing');
    setDirty(true);
    setError('');
  };

  const loadPreview = async () => {
    const input = sourceInput();
    if (sourceMode === 'url' && !input.specUrl) {
      setError('Enter an OpenAPI document URL.');
      return;
    }
    if (sourceMode !== 'url' && !input.specText) {
      setError(sourceMode === 'file' ? 'Choose an OpenAPI file.' : 'Paste an OpenAPI document.');
      return;
    }
    if (sourceMode !== 'url' && new Blob([specText]).size > MAX_OPEN_API_SPEC_BYTES) {
      setError('OpenAPI documents are limited to 2 MB.');
      return;
    }
    if (input.specUrl) {
      try {
        const parsed = new URL(input.specUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
      } catch {
        setError('Enter a valid HTTP or HTTPS OpenAPI document URL without embedded credentials.');
        return;
      }
    }
    setError('');
    setCompletionWarning('');
    setPhase('previewing');
    try {
      const next = await onPreview(input);
      setPreview(next);
      setPrefix(next.prefix);
      setSelectedKeys(getSelectableOpenApiOperationKeys(next.operations.map(operationView)));
      setBundleIds(next.existing.assignedBundleIds.filter(id => id !== next.existing.defaultBundleId));
      setCreateDefaultBundle(next.existing.defaultBundleOwned);
      setConfirmWrites(false);
      setConfirmReimport(false);
      setConfirmRemovals(false);
      setAcknowledgeUnsupportedAuth(false);
      setEnabled(false);
      setStep(1);
      setFurthestStep(1);
      setPhase('ready');
      setDirty(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'OpenAPI preview failed.');
      setPhase('editing');
    }
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_OPEN_API_SPEC_BYTES) {
      setError('OpenAPI files are limited to 2 MB.');
      input.value = '';
      return;
    }
    try {
      const text = await file.text();
      setSpecText(text);
      setFileName(file.name);
      invalidatePreview();
    } catch {
      setError('The selected OpenAPI file could not be read.');
    } finally {
      input.value = '';
    }
  };

  const views = useMemo(() => (preview?.operations ?? []).map(operationView), [preview]);
  const visibleOperations = useMemo(
    () => filterOpenApiOperations(views, filters),
    [filters, views],
  );
  const summary = useMemo(() => summarizeOpenApiOperations(views, selectedKeys), [selectedKeys, views]);
  const visibleSelectableKeys = useMemo(
    () => getSelectableOpenApiOperationKeys(visibleOperations),
    [visibleOperations],
  );
  const allVisibleSelected = visibleSelectableKeys.size > 0
    && [...visibleSelectableKeys].every(key => selectedKeys.has(key));
  const selectedWrites = views.filter(operation => selectedKeys.has(operation.key) && operation.isWrite).length;
  const selectedReads = summary.selected - selectedWrites;

  const toggleBundle = (bundleId: number) => {
    setBundleIds(current => current.includes(bundleId)
      ? current.filter(id => id !== bundleId)
      : [...current, bundleId]);
    setDirty(true);
    setError('');
  };

  const goToGovernance = () => {
    if (summary.selected === 0) {
      setError('Select at least one importable operation.');
      return;
    }
    if (!preview?.existing.backendOwned) {
      setError('The generated connection name is owned by another source. Change the prefix and preview again.');
      return;
    }
    setError('');
    setStep(2);
    setFurthestStep(current => Math.max(current, 2));
  };

  const runImport = async () => {
    if (!preview) return;
    if (preview.security.note && enabled) {
      setError('Unsupported or ambiguous authentication can only be imported staged.');
      return;
    }
    if (!createDefaultBundle && bundleIds.length === 0) {
      setError('Create the dedicated bundle or select at least one existing bundle.');
      return;
    }
    if (selectedWrites > 0 && !confirmWrites) {
      setError('Confirm the selected write operations before importing.');
      return;
    }
    if (preview.existing.importedToolCount > 0 && !confirmReimport) {
      setError('Confirm that this import updates the existing generated connection.');
      return;
    }
    if (preview.removals.length > 0 && !confirmRemovals) {
      setError('Confirm the source operations that will be removed.');
      return;
    }
    if (preview.security.note && !acknowledgeUnsupportedAuth) {
      setError('Acknowledge the unsupported authentication details.');
      return;
    }
    setError('');
    setCompletionWarning('');
    setPhase('importing');
    let imported: OpenApiImportResult;
    try {
      imported = await onImport({
        ...sourceInput(),
        previewDigest: preview.previewDigest,
        selectedOperationKeys: [...selectedKeys],
        bundleIds,
        createDefaultBundle,
        enabled,
        confirmWrites,
        confirmReimport,
        confirmRemovals,
        acknowledgeUnsupportedAuth,
        ...(credential ? { credential } : {}),
        ...(basicUser ? { basicUser, basicPassword } : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'OpenAPI import failed.');
      setPhase('ready');
      return;
    }

    setCredential('');
    setBasicPassword('');
    setResult(imported);
    setStep(3);
    setFurthestStep(3);
    setPhase('complete');
    setDirty(false);
    try {
      await onComplete(imported, preview);
    } catch {
      setCompletionWarning('The import completed, but the capability list could not be refreshed automatically. Reload the page to see the latest state.');
    }
  };

  const canPreserveCredential = preview?.existing.credentialReusable === true;
  const inputCredentialMissing = preview != null
    && preview.security.auth_type !== 'none'
    && !canPreserveCredential
    && (preview.security.auth_type === 'basic' ? !basicUser : !credential);
  const unsupportedAuth = Boolean(preview?.security.note);

  const updateConfirmation = (setter: (value: boolean) => void, value: boolean) => {
    setter(value);
    setDirty(true);
    setError('');
  };

  return (
    <div className="editor-layer openapi-import-layer" role="presentation" onMouseDown={requestClose}>
      <section ref={dialogRef} className="bundle-editor connection-wizard openapi-import-wizard" role="dialog" aria-modal="true" aria-labelledby="openapi-import-title" aria-describedby="openapi-import-description" onMouseDown={event => event.stopPropagation()}>
        <header className="editor-header">
          <div>
            <span className="eyebrow">MCP FABRIC · CAPABILITY STUDIO</span>
            <h2 id="openapi-import-title">Import OpenAPI capabilities</h2>
            <p id="openapi-import-description">Turn selected API operations into governed Argus capabilities, an isolated connection and explicit bundle boundaries.</p>
          </div>
          <button type="button" className="editor-close" aria-label="Close OpenAPI importer" onClick={requestClose}><X size={18} /></button>
        </header>

        <nav className="connection-wizard-steps openapi-import-steps" aria-label="OpenAPI import progress">
          {STEPS.map((wizardStep, index) => {
            const Icon = wizardStep.icon;
            const available = index <= furthestStep;
            return (
              <button type="button" className={`${index === step ? 'is-active' : ''}${index < step || phase === 'complete' ? ' is-complete' : ''}`} disabled={!available || busy} aria-current={index === step ? 'step' : undefined} onClick={() => { if (index === 2) { goToGovernance(); return; } setStep(index); setError(''); }} key={wizardStep.label}>
                <span>{index < step || phase === 'complete' ? <Check size={14} /> : <Icon size={14} />}</span>
                <div><b>{wizardStep.label}</b><small>{wizardStep.detail}</small></div>
              </button>
            );
          })}
        </nav>

        <div className="openapi-import-content">
          {step === 0 && (
            <div className="openapi-source-stage">
              <section className="editor-section">
                <div className="editor-section-heading"><span><FileCode2 size={17} /></span><div><small>STEP 1 · SOURCE</small><h3>OpenAPI document</h3></div><strong>MAX 2 MB</strong></div>
                <div className="openapi-source-switch" role="group" aria-label="OpenAPI source type">
                  {([
                    ['url', Globe2, 'From URL', 'Fetch a public specification'],
                    ['text', Braces, 'Paste spec', 'JSON or YAML document'],
                    ['file', Upload, 'Local file', 'Read JSON or YAML locally'],
                  ] as const).map(([value, Icon, label, detail]) => (
                    <button type="button" className={sourceMode === value ? 'is-active' : ''} aria-pressed={sourceMode === value} onClick={() => { setSourceMode(value); invalidatePreview(); }} key={value}>
                      <Icon size={16} /><span><b>{label}</b><small>{detail}</small></span>{sourceMode === value && <Check size={13} />}
                    </button>
                  ))}
                </div>
                {sourceMode === 'url' ? (
                  <label className="editor-field"><span>Specification URL <em>required</em></span><input autoFocus type="url" maxLength={2048} value={specUrl} onChange={event => { setSpecUrl(event.target.value); invalidatePreview(); }} placeholder="https://api.example.com/openapi.json" /><small>Redirects, private networks and destinations outside the egress policy are rejected.</small></label>
                ) : sourceMode === 'text' ? (
                  <label className="editor-field"><span>OpenAPI JSON or YAML <em>required</em></span><textarea autoFocus className="openapi-spec-input" rows={14} value={specText} onChange={event => { setSpecText(event.target.value); invalidatePreview(); }} placeholder={'openapi: 3.1.0\ninfo:\n  title: Example API\npaths: {}'} /><small>{new Blob([specText]).size.toLocaleString()} / 2,097,152 bytes</small></label>
                ) : (
                  <div className={`openapi-file-drop${fileName ? ' has-file' : ''}`}>
                    <input ref={fileInputRef} type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" tabIndex={-1} aria-hidden="true" onChange={handleFile} />
                    <FileCode2 size={28} /><span><b>{fileName || 'Choose an OpenAPI file'}</b><small>{fileName ? `${new Blob([specText]).size.toLocaleString()} bytes loaded locally` : 'JSON, YAML or YML · maximum 2 MB'}</small></span>
                    <button type="button" className="button button-secondary" onClick={() => fileInputRef.current?.click()}>{fileName ? 'Replace file' : 'Browse file'}</button>
                  </div>
                )}
                <div className="editor-field-grid">
                  <label className="editor-field"><span>Capability prefix</span><input maxLength={32} value={prefix} onChange={event => { setPrefix(event.target.value ? sanitizeOpenApiPrefix(event.target.value) : ''); invalidatePreview(); }} placeholder="Derived from API title" /><small>Stable connection and capability namespace.</small></label>
                  <label className="editor-field"><span>Base URL override</span><input type="url" maxLength={2048} value={baseUrl} onChange={event => { setBaseUrl(event.target.value); invalidatePreview(); }} placeholder="Use first server from spec" /><small>Required for relative or variable-based server URLs.</small></label>
                </div>
              </section>
              <aside className="wizard-context-card openapi-source-context">
                <span><WandSparkles size={22} /></span><small>NATIVE IMPORT</small><h3>What Argus creates</h3>
                <div><b><Link2 size={13} />One isolated connection</b><p>Service credentials stay encrypted and reusable.</p></div>
                <div><b><Braces size={13} />Selected capabilities</b><p>Stable names, typed parameters and write flags.</p></div>
                <div><b><Layers3 size={13} />Explicit boundaries</b><p>No imported connection is left globally unscoped.</p></div>
                <div><b><ShieldCheck size={13} />Governance defaults</b><p>Writes start high-risk and imports remain auditable.</p></div>
              </aside>
            </div>
          )}

          {step === 1 && preview && (
            <div className="openapi-review-stage">
              <section className="openapi-operation-catalog">
                <div className="openapi-preview-identity">
                  <span><Braces size={18} /></span><div><small>OPENAPI {preview.openapiVersion}</small><h3>{preview.title}</h3><p>{preview.baseUrl}</p></div><code>{preview.prefix}</code>
                </div>
                <div className="openapi-operation-toolbar">
                  <label className="search-field"><Search size={14} /><input aria-label="Search OpenAPI operations" value={filters.search} onChange={event => setFilters(current => ({ ...current, search: event.target.value }))} placeholder="Search methods, paths and capability names" /></label>
                  <div className="segmented-filter" role="group" aria-label="Filter OpenAPI operations">
                    {(['all', 'read', 'write', 'changes', 'conflicts'] as OpenApiOperationFilter[]).map(value => <button type="button" className={filters.filter === value ? 'is-active' : ''} aria-pressed={filters.filter === value} onClick={() => setFilters(current => ({ ...current, filter: value }))} key={value}>{value}</button>)}
                  </div>
                </div>
                <div className="openapi-selection-row"><span><b>{summary.selected}</b> of {summary.selectable} importable selected · {visibleOperations.length} visible</span><button type="button" disabled={visibleSelectableKeys.size === 0} onClick={() => { setSelectedKeys(current => toggleVisibleOpenApiOperations(current, visibleOperations)); setConfirmWrites(false); setDirty(true); setError(''); }}>{allVisibleSelected ? 'Clear visible' : 'Select visible'}</button></div>
                <div className="openapi-operation-list" aria-label="OpenAPI operations">
                  {visibleOperations.map(operation => {
                    const selectable = isOpenApiOperationSelectable(operation);
                    return (
                      <label className={`${selectedKeys.has(operation.key) ? 'is-selected' : ''}${selectable ? '' : ' is-blocked'}`} key={operation.key}>
                        <input type="checkbox" disabled={!selectable} checked={selectedKeys.has(operation.key)} onChange={() => { setSelectedKeys(current => toggleOpenApiOperation(current, operation)); setConfirmWrites(false); setDirty(true); setError(''); }} />
                        <span className="connection-check">{selectedKeys.has(operation.key) && <Check size={11} />}</span>
                        <em className={`method-${operation.method.toLowerCase()}`}>{operation.method}</em>
                        <span><b>{operation.name}</b><code>{operation.path}</code><small>{operation.description || 'No operation description'}</small></span>
                        <span className="openapi-operation-meta"><i className={operation.isWrite ? 'is-write' : 'is-read'}>{operation.isWrite ? 'WRITE · HIGH' : 'READ · LOW'}</i><i className={`change-${operation.change}`}>{operation.change}</i><small>{operation.parameterCount} inputs</small></span>
                      </label>
                    );
                  })}
                  {visibleOperations.length === 0 && <div className="openapi-operation-empty" role="status"><Search size={18} /><b>No operations match these filters</b><small>Change the search or operation filter to continue.</small></div>}
                </div>
              </section>
              <aside className="openapi-review-summary">
                <div className="editor-section-heading"><span><ShieldCheck size={16} /></span><div><small>PREVIEW</small><h3>Import impact</h3></div></div>
                <div className="openapi-summary-grid"><span><b>{summary.selected}</b><small>selected</small></span><span><b>{selectedReads}</b><small>reads</small></span><span className={selectedWrites ? 'is-warning' : ''}><b>{selectedWrites}</b><small>writes</small></span><span><b>{preview.counts.update}</b><small>updates</small></span></div>
                <div className="openapi-security-summary"><KeyRound size={15} /><span><small>DETECTED AUTH</small><b>{authLabel(preview)}</b></span></div>
                {preview.warnings.map(warning => <div className="capability-inline-warning" key={warning}><AlertTriangle size={14} />{warning}</div>)}
                {preview.removals.length > 0 && <div className="openapi-removal-preview"><small>SOURCE REMOVALS</small>{preview.removals.map(removal => <span key={removal.name}><code>{removal.name}</code><em>{removal.workflowCount} workflows</em></span>)}</div>}
                <button type="button" className="button button-secondary openapi-change-source" onClick={() => setStep(0)}><RefreshCw size={13} />Change source</button>
              </aside>
            </div>
          )}

          {step === 2 && preview && (
            <div className="openapi-govern-stage">
              <section className="editor-section">
                <div className="editor-section-heading"><span><KeyRound size={16} /></span><div><small>UPSTREAM IDENTITY</small><h3>{authLabel(preview)}</h3></div><strong>SERVICE ACCOUNT</strong></div>
                {preview.security.auth_type === 'header' || preview.security.auth_type === 'bearer' ? (
                  <label className="editor-field"><span>{preview.security.auth_type === 'header' ? `${preview.security.headerName} value` : 'Bearer token'}{!canPreserveCredential && <em> required to activate</em>}</span><input type="password" autoComplete="new-password" value={credential} onChange={event => { setCredential(event.target.value); setDirty(true); setError(''); }} placeholder={canPreserveCredential ? 'Leave blank to preserve encrypted credential' : 'Enter credential or import disabled'} /><small>The secret is sent only during import and never returned by the API.</small></label>
                ) : preview.security.auth_type === 'basic' ? (
                  <div className="editor-field-grid"><label className="editor-field"><span>Username</span><input value={basicUser} onChange={event => { setBasicUser(event.target.value); setDirty(true); }} /></label><label className="editor-field"><span>Password</span><input type="password" autoComplete="new-password" value={basicPassword} onChange={event => { setBasicPassword(event.target.value); setDirty(true); }} /></label></div>
                ) : (
                  <div className={`openapi-auth-note${preview.security.note ? ' is-warning' : ''}`}><KeyRound size={16} /><span><b>{preview.security.note ? 'Authentication needs manual follow-up' : 'No upstream credential required'}</b><small>{preview.security.note || 'The specification does not declare a service credential.'}</small></span></div>
                )}
                <label className={`editor-toggle-row capability-enabled-toggle${unsupportedAuth ? ' is-blocked' : ''}`}><input type="checkbox" checked={enabled} disabled={unsupportedAuth} onChange={event => { setEnabled(event.target.checked); setDirty(true); setError(''); }} /><span><b>Activate imported capabilities immediately</b><small>{unsupportedAuth
                  ? 'Unavailable until the unsupported or ambiguous authentication is configured manually.'
                  : preview.existing.importedToolCount > 0 && !enabled
                    ? 'A staged reimport disables every generated capability on this connection for safe verification.'
                    : 'Keep off to verify the connection and definitions before runtime discovery.'}</small></span><em>{enabled ? 'ACTIVE' : 'STAGED'}</em></label>
                {enabled && inputCredentialMissing && <div className="capability-inline-warning"><AlertTriangle size={14} />Provide a credential or keep this authenticated import staged.</div>}
              </section>

              <section className="editor-section">
                <div className="editor-section-heading"><span><Layers3 size={16} /></span><div><small>AUTHORIZATION BOUNDARIES</small><h3>Bundle scope</h3></div><strong>{bundleIds.length + (createDefaultBundle ? 1 : 0)} BOUNDARIES</strong></div>
                <label className={`openapi-default-bundle${createDefaultBundle ? ' is-selected' : ''}${preview.existing.defaultBundleOwned ? '' : ' is-blocked'}`}><input type="checkbox" disabled={!preview.existing.defaultBundleOwned} checked={createDefaultBundle} onChange={event => { setCreateDefaultBundle(event.target.checked); setDirty(true); setError(''); }} /><span className="connection-check">{createDefaultBundle && <Check size={11} />}</span><Layers3 size={16} /><span><b>Dedicated “{preview.prefix}” bundle</b><small>{preview.existing.defaultBundleId ? 'Reuse the importer-owned boundary' : 'Create an isolated boundary for this API'}</small></span></label>
                <div className="capability-bundle-picker openapi-bundle-picker">
                  {bundles.filter(bundle => bundle.id !== preview.existing.defaultBundleId).map(bundle => (
                    <label className={bundleIds.includes(bundle.id) ? 'is-selected' : ''} key={bundle.id}><input type="checkbox" checked={bundleIds.includes(bundle.id)} onChange={() => toggleBundle(bundle.id)} /><span className="connection-check">{bundleIds.includes(bundle.id) && <Check size={11} />}</span><span>{bundle.icon || '◈'}</span><span><b>{bundle.label}</b><small>{bundle.name}</small></span></label>
                  ))}
                </div>
              </section>

              <aside className="openapi-confirmation-panel">
                <div className="openapi-import-recap"><small>IMPORT PLAN</small><h3>{summary.selected} capabilities</h3><p>{selectedReads} reads · {selectedWrites} writes · {bundleIds.length + (createDefaultBundle ? 1 : 0)} boundaries</p></div>
                {selectedWrites > 0 && <label className={confirmWrites ? 'is-confirmed' : ''}><input type="checkbox" checked={confirmWrites} onChange={event => updateConfirmation(setConfirmWrites, event.target.checked)} /><LockKeyhole size={15} /><span><b>Confirm {selectedWrites} write operations</b><small>Writes are imported high-risk and remain subject to approval policy.</small></span></label>}
                {preview.existing.importedToolCount > 0 && <label className={confirmReimport ? 'is-confirmed' : ''}><input type="checkbox" checked={confirmReimport} onChange={event => updateConfirmation(setConfirmReimport, event.target.checked)} /><RefreshCw size={15} /><span><b>Confirm governed reimport</b><small>Stable capability IDs and governance overrides are preserved.</small></span></label>}
                {preview.removals.length > 0 && <label className={confirmRemovals ? 'is-confirmed' : ''}><input type="checkbox" checked={confirmRemovals} onChange={event => updateConfirmation(setConfirmRemovals, event.target.checked)} /><AlertTriangle size={15} /><span><b>Confirm {preview.removals.length} removals</b><small>Definitions absent from the source are removed after preflight.</small></span></label>}
                {preview.security.note && <label className={acknowledgeUnsupportedAuth ? 'is-confirmed' : ''}><input type="checkbox" checked={acknowledgeUnsupportedAuth} onChange={event => updateConfirmation(setAcknowledgeUnsupportedAuth, event.target.checked)} /><KeyRound size={15} /><span><b>Acknowledge auth follow-up</b><small>Import staged and configure the connection before activation.</small></span></label>}
                <div className="openapi-safety-note"><ShieldCheck size={15} /><span><b>Atomic and auditable</b><small>Ownership, spec digest, collisions and bundle state are checked again server-side.</small></span></div>
              </aside>
            </div>
          )}

          {step === 3 && preview && result && (
            <div className="openapi-result-stage" role="status" aria-live="polite">
              <span className="openapi-result-icon"><CheckCircle2 size={34} /></span><small>IMPORT COMPLETE</small><h2>{preview.title} is now governed by Argus</h2><p>The connection, selected capabilities and authorization boundaries committed atomically.</p>
              <div className="openapi-result-metrics"><span><b>{result.inserted.read + result.inserted.write}</b><small>created</small></span><span><b>{result.updated.read + result.updated.write}</b><small>updated</small></span><span><b>{result.removed.length}</b><small>removed</small></span><span><b>{result.bundleIds.length}</b><small>boundaries</small></span></div>
              <div className="openapi-result-checks"><span><Check size={13} />Spec digest verified</span><span><Check size={13} />Connection stored securely</span><span><Check size={13} />Capabilities synchronized</span><span><Check size={13} />Bundle scope enforced</span></div>
              {result.warnings.map(warning => <div className="capability-inline-warning" key={warning}><AlertTriangle size={14} />{warning}</div>)}
              {completionWarning && <div className="capability-inline-warning"><AlertTriangle size={14} />{completionWarning}</div>}
              <div className="openapi-result-actions"><a className="button button-secondary" href={`/mcp-fabric/bundles/${result.bundleId}`}><Layers3 size={14} />Open bundle</a><a className="button button-secondary" href="/mcp-fabric#connections"><Link2 size={14} />View connection</a><button type="button" className="button button-primary" onClick={requestClose}>View capabilities <ArrowRight size={14} /></button></div>
            </div>
          )}
        </div>

        {step < 3 && (
          <footer className="editor-footer openapi-import-footer">
            <button type="button" className="button button-ghost" disabled={busy || step === 0} onClick={() => { setStep(current => Math.max(0, current - 1)); setError(''); }}><ArrowLeft size={14} />Back</button>
            <div>{error && <span className="editor-error" role="alert"><AlertTriangle size={14} />{error}</span>}</div>
            {step === 0 ? <button type="button" className="button button-primary" disabled={busy} onClick={loadPreview}>{phase === 'previewing' ? <RefreshCw className="spin" size={14} /> : <WandSparkles size={14} />}{phase === 'previewing' ? 'Building preview…' : 'Preview operations'}</button>
              : step === 1 ? <button type="button" className="button button-primary" onClick={goToGovernance}>Govern {summary.selected} selected <ArrowRight size={14} /></button>
                : <button type="button" className="button button-primary" disabled={busy || enabled && inputCredentialMissing} onClick={runImport}>{phase === 'importing' ? <RefreshCw className="spin" size={14} /> : <ShieldCheck size={14} />}{phase === 'importing' ? 'Importing atomically…' : enabled ? 'Import and activate' : 'Import staged'}</button>}
          </footer>
        )}
      </section>
    </div>
  );
}
