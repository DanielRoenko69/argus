import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Braces,
  CheckCircle2,
  CircleDashed,
  FileCode2,
  Globe2,
  KeyRound,
  Link2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  countOpenApiSourceHealth,
  filterOpenApiSources,
  formatOpenApiSourceAuth,
  OPEN_API_SOURCE_STATUS_META,
  shortSourceDigest,
  type OpenApiSourceListFilter,
} from '../openApiSourceHealth';
import type {
  OpenApiCapabilitySource,
  OpenApiImportSource,
  OpenApiSourceCheckResult,
  OpenApiSourceOperationRef,
  OpenApiSourceRetirementConfirmation,
  OpenApiSourceRetirementPreview,
  OpenApiSourceRetirementResult,
} from '../types';
import { timeAgo } from './Ui';

const MAX_OPEN_API_SPEC_BYTES = 2 * 1024 * 1024;
const FOCUSABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href]';

function operationRow(
  operation: OpenApiSourceOperationRef,
  change: 'added' | 'removed',
) {
  return (
    <article className={`source-diff-operation is-${change}`} key={`${change}:${operation.key}`}>
      <span className={`source-diff-symbol is-${change}`}>{change === 'added' ? <Plus size={12} /> : <Minus size={12} />}</span>
      <em className={`method-${operation.method.toLowerCase()}`}>{operation.method}</em>
      <div><code>{operation.name}</code><small>{operation.path}</small></div>
      <span className={!operation.supported ? 'is-unsupported' : operation.isWrite ? 'is-write' : 'is-read'}>{!operation.supported ? 'UNSUPPORTED' : operation.isWrite ? 'WRITE' : 'READ'}</span>
      {operation.workflowCount > 0 && <strong>{operation.workflowCount} workflow{operation.workflowCount === 1 ? '' : 's'}</strong>}
    </article>
  );
}

export function OpenApiSourcePanel({
  sources,
  loading,
  error,
  initialSourceId,
  onCheck,
  onRefresh,
  onReimport,
  onPreviewRetirement,
  onRetire,
  onRetired,
  onClose,
}: {
  sources: OpenApiCapabilitySource[];
  loading: boolean;
  error: string | null;
  initialSourceId?: number;
  onCheck: (id: number, specText?: string) => Promise<OpenApiSourceCheckResult>;
  onRefresh: () => Promise<void> | void;
  onReimport: (source: OpenApiImportSource) => void;
  onPreviewRetirement: (id: number) => Promise<OpenApiSourceRetirementPreview>;
  onRetire: (id: number, confirmation: OpenApiSourceRetirementConfirmation) => Promise<OpenApiSourceRetirementResult>;
  onRetired: (result: OpenApiSourceRetirementResult) => Promise<void> | void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<OpenApiSourceListFilter>('all');
  const [selectedId, setSelectedId] = useState<number | null>(initialSourceId ?? null);
  const [checkingId, setCheckingId] = useState<number | null>(null);
  const [checks, setChecks] = useState<Map<number, OpenApiSourceCheckResult>>(new Map());
  const [specText, setSpecText] = useState('');
  const [fileName, setFileName] = useState('');
  const [localError, setLocalError] = useState('');
  const [retirement, setRetirement] = useState<OpenApiSourceRetirementPreview | null>(null);
  const [retirementLoading, setRetirementLoading] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [retirementConfirmation, setRetirementConfirmation] = useState('');
  const [retirementError, setRetirementError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const counts = useMemo(() => countOpenApiSourceHealth(sources), [sources]);
  const visibleSources = useMemo(
    () => filterOpenApiSources(sources, search, statusFilter),
    [search, sources, statusFilter],
  );
  const selected = sources.find(source => source.id === selectedId) ?? null;
  const check = selected ? checks.get(selected.id) ?? null : null;
  const effectiveStatus = check?.status ?? selected?.status ?? 'unchecked';
  const busy = checkingId != null || retiring;
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (selectedId != null && sources.some(source => source.id === selectedId)) return;
    if (loading && selectedId != null) return;
    const preferred = sources.find(source => source.status === 'drifted')
      ?? sources.find(source => source.status === 'error')
      ?? sources[0]
      ?? null;
    setSelectedId(preferred?.id ?? null);
  }, [loading, selectedId, sources]);

  useEffect(() => {
    setSpecText('');
    setFileName('');
    setLocalError('');
    setRetirement(null);
    setRetirementConfirmation('');
    setRetirementError('');
  }, [selectedId]);

  useEffect(() => {
    document.body.classList.add('has-dialog');
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
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
    return () => {
      document.body.classList.remove('has-dialog');
      window.removeEventListener('keydown', handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);

  const requestClose = () => {
    if (!busy) onClose();
  };

  const runCheck = async () => {
    if (!selected || !selected.source.canCheck) return;
    if (selected.source.kind === 'text') {
      if (!specText.trim()) {
        setLocalError('Paste or upload the current OpenAPI document before checking this text source.');
        return;
      }
      if (new Blob([specText]).size > MAX_OPEN_API_SPEC_BYTES) {
        setLocalError('OpenAPI documents are limited to 2 MB.');
        return;
      }
    }
    setCheckingId(selected.id);
    setLocalError('');
    try {
      const result = await onCheck(selected.id, selected.source.kind === 'text' ? specText : undefined);
      setChecks(current => new Map(current).set(selected.id, result));
    } catch (caught) {
      setChecks(current => {
        const next = new Map(current);
        next.delete(selected.id);
        return next;
      });
      setLocalError(caught instanceof Error ? caught.message : 'The source check could not complete.');
    } finally {
      setCheckingId(null);
      try { await onRefresh(); } catch { /* The existing panel data remains usable. */ }
    }
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_OPEN_API_SPEC_BYTES) {
      setLocalError('OpenAPI files are limited to 2 MB.');
      input.value = '';
      return;
    }
    try {
      setSpecText(await file.text());
      setFileName(file.name);
      setLocalError('');
      setChecks(current => {
        const next = new Map(current);
        if (selected) next.delete(selected.id);
        return next;
      });
    } catch {
      setLocalError('The selected OpenAPI file could not be read.');
    } finally {
      input.value = '';
    }
  };

  const changeSpecText = (value: string) => {
    setSpecText(value);
    setFileName('');
    setLocalError('');
    setChecks(current => {
      const next = new Map(current);
      if (selected) next.delete(selected.id);
      return next;
    });
  };

  const showReimport = Boolean(selected && (effectiveStatus === 'drifted' || !selected.source.canCheck));
  const canReimport = Boolean(selected && showReimport
    && (selected.source.kind === 'url'
      ? selected.source.url
      : specText && (!selected.source.canCheck || check)));
  const reimport = () => {
    if (!selected || !canReimport) return;
    onReimport({
      ...(selected.source.kind === 'url'
        ? { specUrl: selected.source.url! }
        : { specText }),
      namePrefix: selected.prefix,
      ...(selected.source.baseUrlOverride
        ? { baseUrl: selected.source.baseUrlOverride }
        : {}),
    });
  };

  const previewRetirement = async () => {
    if (!selected || busy || retirementLoading) return;
    setRetirementLoading(true);
    setRetirementError('');
    setRetirementConfirmation('');
    try {
      setRetirement(await onPreviewRetirement(selected.id));
    } catch (caught) {
      setRetirement(null);
      setRetirementError(caught instanceof Error ? caught.message : 'The retirement impact could not be loaded.');
    } finally {
      setRetirementLoading(false);
    }
  };

  const confirmRetirement = async () => {
    if (!selected || !retirement || retirement.source.id !== selected.id
      || retirementConfirmation !== retirement.confirmation.expectedPrefix) return;
    setRetiring(true);
    setRetirementError('');
    try {
      const result = await onRetire(selected.id, retirement.confirmation);
      await onRetired(result);
    } catch (caught) {
      setRetirement(null);
      setRetirementConfirmation('');
      setRetirementError(caught instanceof Error ? caught.message : 'The source could not be retired. Load a fresh impact preview and try again.');
    } finally {
      setRetiring(false);
    }
  };

  return (
    <div className="editor-layer openapi-source-layer" role="presentation" onMouseDown={requestClose}>
      <section ref={dialogRef} className="openapi-source-panel" role="dialog" aria-modal="true" aria-labelledby="openapi-source-title" aria-describedby="openapi-source-description" onMouseDown={event => event.stopPropagation()}>
        <header className="editor-header openapi-source-header">
          <div>
            <span className="eyebrow">MCP FABRIC · SOURCE OBSERVABILITY</span>
            <h2 id="openapi-source-title">OpenAPI source health</h2>
            <p id="openapi-source-description">Compare imported baselines with their current source. Retirement requires a fresh impact review and explicit confirmation.</p>
          </div>
          <button type="button" className="editor-close" aria-label="Close OpenAPI source health" disabled={busy} onClick={requestClose}><X size={18} /></button>
        </header>

        <div className="openapi-source-summary" aria-label="OpenAPI source health summary">
          <span><Braces size={15} /><b>{counts.total}</b><small>imported sources</small></span>
          <span className="is-current"><CheckCircle2 size={15} /><b>{counts.current}</b><small>current</small></span>
          <span className={counts.drifted ? 'is-drifted' : ''}><RefreshCw size={15} /><b>{counts.drifted}</b><small>drift detected</small></span>
          <span className={counts.error ? 'is-error' : ''}><AlertTriangle size={15} /><b>{counts.error}</b><small>unavailable</small></span>
        </div>

        <div className="openapi-source-layout">
          <aside className="openapi-source-catalog">
            <div className="openapi-source-toolbar">
              <label className="search-field"><Search size={14} /><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Search imported sources" /></label>
              <select aria-label="Source health" value={statusFilter} onChange={event => setStatusFilter(event.target.value as OpenApiSourceListFilter)}>
                <option value="all">All health states</option>
                <option value="drifted">Drift detected</option>
                <option value="error">Unavailable</option>
                <option value="unchecked">Unchecked</option>
                <option value="current">Current</option>
              </select>
            </div>
            <div className="openapi-source-result-count"><span><b>{visibleSources.length}</b> matching sources</span><button type="button" disabled={loading || busy} onClick={() => void onRefresh()}><RefreshCw className={loading ? 'spin' : ''} size={12} />Refresh</button></div>
            <div className="openapi-source-list" aria-label="Imported OpenAPI sources">
              {visibleSources.map(source => {
                const meta = OPEN_API_SOURCE_STATUS_META[source.status];
                return (
                  <button type="button" className={`${selected?.id === source.id ? 'is-selected' : ''} status-${source.status}`} aria-pressed={selected?.id === source.id} onClick={() => setSelectedId(source.id)} key={source.id}>
                    <span className="openapi-source-kind">{source.source.kind === 'url' ? <Globe2 size={15} /> : <FileCode2 size={15} />}</span>
                    <span><b>{source.name}</b><code>{source.prefix}</code><small>{source.checkedAt ? `Checked ${timeAgo(source.checkedAt)}` : `Imported ${timeAgo(source.importedAt)}`}</small></span>
                    <em>{meta.label}</em>
                  </button>
                );
              })}
              {!loading && visibleSources.length === 0 && <div className="openapi-source-list-empty"><Search size={17} /><b>No matching sources</b><small>Change the search or health filter.</small></div>}
              {loading && sources.length === 0 && <div className="openapi-source-list-empty"><RefreshCw className="spin" size={17} /><b>Loading source health…</b></div>}
            </div>
          </aside>

          <main className="openapi-source-detail" aria-live="polite">
            {(error || localError) && <div className="editor-error openapi-source-error" role="alert"><AlertTriangle size={14} />{localError || error}</div>}
            {selected ? (
              <>
                <section className="openapi-source-identity">
                  <span className={`source-health-orb status-${effectiveStatus}`}>{effectiveStatus === 'current' ? <CheckCircle2 size={19} /> : effectiveStatus === 'unchecked' ? <CircleDashed size={19} /> : <RefreshCw size={19} />}</span>
                  <div><small>{selected.source.kind === 'url' ? 'REMOTE OPENAPI SOURCE' : 'MANUAL OPENAPI SOURCE'}</small><h3>{selected.name}</h3><p>{selected.source.url || 'Upload or paste the current specification to compare it.'}</p></div>
                  <span className={`source-health-badge status-${effectiveStatus}`}>{OPEN_API_SOURCE_STATUS_META[effectiveStatus].label}</span>
                </section>

                <section className="openapi-source-baseline">
                  <div><small>IMPORTED BASELINE</small><b>{selected.baseline.operationCount} operations</b><code title={selected.baseline.specDigest ?? undefined}>spec {shortSourceDigest(selected.baseline.specDigest)}</code></div>
                  <div><small>MANIFEST</small><b>{shortSourceDigest(selected.baseline.manifestDigest)}</b><code>imported {timeAgo(selected.importedAt)}</code></div>
                  <div><small>LAST CHECK</small><b>{selected.checkedAt ? timeAgo(selected.checkedAt) : 'Never'}</b><code>{selected.backendEnabled ? 'connection active' : 'connection disabled'}</code></div>
                </section>

                {selected.source.kind === 'text' && (
                  <section className="openapi-text-source-input">
                    <header><span><Upload size={15} /></span><div><small>LOCAL CHECK INPUT</small><h3>Current OpenAPI document</h3></div><strong>NOT STORED</strong></header>
                    <textarea aria-label="Current OpenAPI document" rows={7} value={specText} onChange={event => changeSpecText(event.target.value)} placeholder={'openapi: 3.1.0\ninfo:\n  title: Example API\npaths: {}'} />
                    <footer><span>{fileName || 'Paste JSON/YAML or choose a local file'} · {new Blob([specText]).size.toLocaleString()} / 2,097,152 bytes</span><input ref={fileInputRef} type="file" accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml" tabIndex={-1} aria-hidden="true" onChange={handleFile} /><button type="button" className="button button-secondary" onClick={() => fileInputRef.current?.click()}><Upload size={12} />{fileName ? 'Replace file' : 'Choose file'}</button></footer>
                  </section>
                )}

                <div className="openapi-source-check-actions">
                  <span><ShieldCheck size={14} /><small>Read-only check · no automatic reimport</small></span>
                  <button type="button" className="button button-secondary" disabled={busy || !selected.source.canCheck} onClick={() => void runCheck()}><RefreshCw className={checkingId === selected.id ? 'spin' : ''} size={13} />{checkingId === selected.id ? 'Checking source…' : 'Check now'}</button>
                </div>
                {!selected.source.canCheck && <div className="capability-inline-warning"><AlertTriangle size={14} />This legacy source has no checkable origin. Reimport it once to establish source tracking.</div>}

                {check ? (
                  <section className="openapi-source-diff">
                    <header>
                      <div><small>OBSERVED OPENAPI {check.observed.openapiVersion}</small><h3>{check.observed.title}</h3><p>Checked {timeAgo(check.checkedAt)}</p></div>
                      <div className="openapi-diff-counts"><span className="is-added">+{check.diff.summary.added}<small>added</small></span><span className="is-changed">~{check.diff.summary.changed}<small>changed</small></span><span className="is-removed">−{check.diff.summary.removed}<small>removed</small></span></div>
                    </header>

                    {(check.diff.baseUrl.changed || check.diff.auth.changed) && (
                      <div className="openapi-config-drift">
                        {check.diff.baseUrl.changed && <article><Link2 size={15} /><div><small>BASE URL CHANGED</small><code>{check.diff.baseUrl.before || 'None'}</code><ArrowRight size={12} /><code>{check.diff.baseUrl.after || 'None'}</code></div></article>}
                        {check.diff.auth.changed && <article><KeyRound size={15} /><div><small>AUTHENTICATION CHANGED</small><code>{formatOpenApiSourceAuth(check.diff.auth.before)}</code><ArrowRight size={12} /><code>{formatOpenApiSourceAuth(check.diff.auth.after)}</code></div></article>}
                      </div>
                    )}

                    {check.status === 'current' ? (
                      <div className="openapi-source-current"><CheckCircle2 size={21} /><span><b>Source matches the imported baseline</b><small>No capability, base URL or authentication changes were detected.</small></span></div>
                    ) : (
                      <div className="openapi-diff-operation-groups">
                        {check.diff.added.length > 0 && <section><h4><Plus size={12} />Added operations <span>{check.diff.added.length}</span></h4>{check.diff.added.map(operation => operationRow(operation, 'added'))}</section>}
                        {check.diff.changed.length > 0 && <section><h4><RefreshCw size={12} />Changed operations <span>{check.diff.changed.length}</span></h4>{check.diff.changed.map(item => (
                          <article className="source-diff-operation is-changed" key={`changed:${item.after.key}`}>
                            <span className="source-diff-symbol is-changed"><RefreshCw size={12} /></span><em className={`method-${item.after.method.toLowerCase()}`}>{item.after.method}</em><div><code>{item.after.name}</code><small>{item.after.path}</small><span>{item.changes.map(change => <i key={change}>{change}</i>)}</span></div><span className={!item.after.supported ? 'is-unsupported' : item.after.isWrite ? 'is-write' : 'is-read'}>{!item.after.supported ? 'UNSUPPORTED' : item.after.isWrite ? 'WRITE' : 'READ'}</span>{item.after.workflowCount > 0 && <strong>{item.after.workflowCount} workflow{item.after.workflowCount === 1 ? '' : 's'}</strong>}
                          </article>
                        ))}</section>}
                        {check.diff.removed.length > 0 && <section><h4><Minus size={12} />Removed operations <span>{check.diff.removed.length}</span></h4>{check.diff.removed.map(operation => operationRow(operation, 'removed'))}</section>}
                      </div>
                    )}
                  </section>
                ) : selected.lastCheck ? (
                  <section className={`openapi-last-check status-${selected.status}`}>
                    {selected.status === 'error' ? <AlertTriangle size={18} /> : selected.status === 'current' ? <CheckCircle2 size={18} /> : <RefreshCw size={18} />}
                    <div><small>LATEST STORED CHECK</small><b>{OPEN_API_SOURCE_STATUS_META[selected.status].label}</b><p>{selected.status === 'drifted' && selected.lastCheck.summary ? `${selected.lastCheck.summary.added} added · ${selected.lastCheck.summary.changed} changed · ${selected.lastCheck.summary.removed} removed. Check now to load the review diff.` : selected.status === 'error' ? `The source was unavailable${selected.lastCheck.errorCode ? ` · ${selected.lastCheck.errorCode}` : ''}.` : 'The source matched the imported baseline.'}</p></div>
                  </section>
                ) : (
                  <section className="openapi-last-check status-unchecked"><CircleDashed size={18} /><div><small>SOURCE NOT CHECKED</small><b>Establish current source health</b><p>Run a read-only comparison against the imported manifest.</p></div></section>
                )}

                {showReimport && (
                  <section className="openapi-reimport-cta">
                    <span><Braces size={18} /></span><div><small>{selected.source.canCheck ? 'MANUAL REVIEW' : 'ESTABLISH BASELINE'}</small><b>{selected.source.canCheck ? 'Review a governed reimport' : 'Upgrade source tracking'}</b><p>The existing wizard will build a fresh preview and require write, update and removal confirmations again.</p></div>
                    <button type="button" className="button button-primary" disabled={!canReimport || busy} onClick={reimport}>{selected.source.canCheck ? 'Review reimport' : 'Review tracked reimport'} <ArrowRight size={13} /></button>
                    {!canReimport && selected.source.kind === 'text' && <small>{selected.source.canCheck ? 'Check the pasted document first so it can be handed to the importer without storing it.' : 'Paste the current document to hand it directly to the importer without storing it.'}</small>}
                  </section>
                )}

                <section className={`openapi-retirement-zone${retirement ? ' is-reviewing' : ''}`}>
                  <header>
                    <span><Trash2 size={16} /></span>
                    <div><small>SOURCE LIFECYCLE</small><b>Retire imported source</b><p>Remove its managed connection and imported capabilities. Existing bundles and workflows are preserved.</p></div>
                    {!retirement && (
                      <button type="button" className="button button-secondary" disabled={busy || retirementLoading} onClick={() => void previewRetirement()}>
                        {retirementLoading ? <RefreshCw className="spin" size={12} /> : <Trash2 size={12} />}
                        {retirementLoading ? 'Loading impact…' : 'Review retirement'}
                      </button>
                    )}
                  </header>
                  {retirementError && <div className="editor-error openapi-retirement-error" role="alert"><AlertTriangle size={13} />{retirementError}</div>}
                  {retirement && retirement.source.id === selected.id && (
                    <div className="openapi-retirement-review">
                      <div className="openapi-retirement-impact" aria-label="Retirement impact">
                        <span><b>{retirement.impact.capabilities.length}</b><small>capabilities deleted</small></span>
                        <span><b>{retirement.impact.bundles.length}</b><small>bundles preserved</small></span>
                        <span><b>{retirement.impact.workflows.length}</b><small>workflows preserved</small></span>
                      </div>
                      <div className="openapi-retirement-warning"><AlertTriangle size={15} /><span><b>This cannot be undone from Argus.</b><small>Preserved workflows may fail until their references are replaced. Audit history remains available.</small></span></div>
                      {retirement.impact.capabilities.length > 0 && (
                        <div className="openapi-retirement-items"><small>CAPABILITIES TO DELETE</small><div>{retirement.impact.capabilities.slice(0, 8).map(capability => <code key={capability.id}>{capability.name}{capability.isWrite ? ' · WRITE' : ''}</code>)}</div>{retirement.impact.capabilities.length > 8 && <em>+{retirement.impact.capabilities.length - 8} more</em>}</div>
                      )}
                      {(retirement.impact.bundles.length > 0 || retirement.impact.workflows.length > 0) && (
                        <div className="openapi-retirement-preserved">
                          {retirement.impact.bundles.length > 0 && <span><small>PRESERVED BUNDLES</small><b>{retirement.impact.bundles.map(bundle => bundle.label).join(', ')}</b></span>}
                          {retirement.impact.workflows.length > 0 && <span><small>IMPACTED WORKFLOWS</small><b>{retirement.impact.workflows.map(workflow => workflow.name).join(', ')}</b></span>}
                        </div>
                      )}
                      <label className="openapi-retirement-confirmation">
                        <span>Type <code>{retirement.confirmation.expectedPrefix}</code> to confirm retirement</span>
                        <input autoComplete="off" value={retirementConfirmation} onChange={event => setRetirementConfirmation(event.target.value)} aria-label={`Type ${retirement.confirmation.expectedPrefix} to confirm retirement`} />
                      </label>
                      <footer>
                        <button type="button" className="button button-secondary" disabled={retiring} onClick={() => { setRetirement(null); setRetirementConfirmation(''); setRetirementError(''); }}>Cancel</button>
                        <button type="button" className="button button-danger" disabled={retiring || retirementConfirmation !== retirement.confirmation.expectedPrefix} onClick={() => void confirmRetirement()}><Trash2 size={12} />{retiring ? 'Retiring source…' : `Retire ${retirement.confirmation.expectedPrefix}`}</button>
                      </footer>
                    </div>
                  )}
                </section>
              </>
            ) : !loading && (
              <div className="openapi-source-detail-empty"><FileCode2 size={24} /><b>No imported OpenAPI sources yet</b><p>Use Import OpenAPI in Capability Studio to create the first tracked source.</p></div>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
