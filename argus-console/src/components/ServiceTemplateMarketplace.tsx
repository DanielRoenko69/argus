import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Check, ExternalLink, KeyRound, PackageSearch, Search, ShieldCheck, Wrench, X } from 'lucide-react';
import { getServiceTemplateCatalog, installServiceTemplate } from '../api';
import type { FabricManagementBundle, ServiceTemplateInstallResult, ServiceTemplateSummary } from '../types';
import { ErrorState, LoadingState } from './Ui';
import { BrandIcon } from './BrandIcon';

function initialFields(template: ServiceTemplateSummary): Record<string, string> {
  return Object.fromEntries(template.fields.map(field => [field.name, field.default ?? '']));
}

function isWriteMethod(method: string | null): boolean {
  return !method || !['GET', 'HEAD', 'SELECT'].includes(method);
}

export function ServiceTemplateMarketplace({
  bundles,
  initialSelection = null,
  onClose,
  onInstalled,
}: {
  bundles: FabricManagementBundle[];
  initialSelection?: string | null;
  onClose: () => void;
  onInstalled: (result: ServiceTemplateInstallResult) => void;
}) {
  const catalog = useQuery({ queryKey: ['mcp-fabric', 'templates'], queryFn: getServiceTemplateCatalog, staleTime: 60_000 });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [bundleId, setBundleId] = useState(bundles[0]?.id ? String(bundles[0].id) : '');
  const [fields, setFields] = useState<Record<string, string>>({});
  const initialSelectionApplied = useRef(false);
  const selected = catalog.data?.templates.find(template => template.id === selectedId) ?? null;
  const filtered = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (catalog.data?.templates ?? []).filter(template => {
      if (category !== 'all' && template.category !== category) return false;
      return !normalized || `${template.name} ${template.description} ${template.tags.join(' ')} ${template.tools.map(tool => tool.nameSuffix).join(' ')}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [catalog.data, category, search]);
  const install = useMutation({
    mutationFn: () => installServiceTemplate(selected!.id, { prefix, fields, bundleId: Number(bundleId) }),
    onSuccess: result => {
      onInstalled(result);
      onClose();
    },
  });

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || install.isPending) return;
      if (selectedId) setSelectedId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('has-dialog');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [install.isPending, onClose, selectedId]);

  const selectTemplate = (template: ServiceTemplateSummary) => {
    setSelectedId(template.id);
    setPrefix(template.id.replace(/[^a-z0-9_-]/g, '_').slice(0, 64));
    setFields(initialFields(template));
    setBundleId(current => current || (bundles[0]?.id ? String(bundles[0].id) : ''));
    install.reset();
  };
  useEffect(() => {
    if (!initialSelection || initialSelectionApplied.current || !catalog.data) return;
    const template = catalog.data.templates.find(candidate => candidate.id === initialSelection);
    initialSelectionApplied.current = true;
    if (template) selectTemplate(template);
  }, [catalog.data, initialSelection]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selected?.installable || !bundleId || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(prefix)) return;
    install.mutate();
  };
  const writeCount = selected?.tools.filter(tool => isWriteMethod(tool.method)).length ?? 0;

  return (
    <div className="marketplace-layer" role="presentation" onMouseDown={() => !install.isPending && onClose()}>
      <section className="marketplace-shell service-template-shell" role="dialog" aria-modal="true" aria-labelledby="service-template-title" onMouseDown={event => event.stopPropagation()}>
        <header className="marketplace-header">
          <div className="marketplace-title">
            <span><PackageSearch size={20} /></span>
            <div><small>MCP FABRIC · CONNECTION BLUEPRINTS</small><h2 id="service-template-title">Install governed connectors</h2><p>Create a staged connection and its capabilities, bound to an access bundle from the first write.</p></div>
          </div>
          <div className="marketplace-header-actions"><button type="button" aria-label="Close connector templates" disabled={install.isPending} onClick={onClose}><X size={18} /></button></div>
        </header>

        <div className="marketplace-stats">
          <span><b>{catalog.data?.templates.length ?? '—'}</b> connector blueprints</span>
          <span><b>{catalog.data?.categories.length ?? '—'}</b> domains</span>
          <span><b>{catalog.data?.templates.reduce((sum, template) => sum + template.tools.length, 0) ?? '—'}</b> predefined capabilities</span>
          <span className="marketplace-safety"><ShieldCheck size={14} />Installed disabled · bundle required</span>
        </div>

        <div className="marketplace-toolbar">
          <label className="marketplace-search"><Search size={16} /><input autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Search connectors and capabilities" />{search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}><X size={13} /></button>}</label>
        </div>

        <nav className="marketplace-filters" aria-label="Connector categories">
          <button type="button" className={category === 'all' ? 'is-active' : ''} onClick={() => setCategory('all')}>All</button>
          {catalog.data?.categories.map(item => <button type="button" className={category === item.id ? 'is-active' : ''} onClick={() => setCategory(item.id)} key={item.id}>{item.label} <small>{item.templateCount}</small></button>)}
        </nav>

        <div className={`marketplace-content${selected ? ' has-detail' : ''}`}>
          <div className="marketplace-results">
            {catalog.isLoading ? <LoadingState label="Loading connector blueprints…" /> : catalog.error ? <ErrorState error={catalog.error} /> : (
              <>
                <div className="marketplace-result-count"><span>{filtered.length} result{filtered.length === 1 ? '' : 's'}</span><small>Secrets are encrypted server-side and never returned to this catalog.</small></div>
                {filtered.length > 0 ? <div className="marketplace-grid">{filtered.map(template => {
                  const writes = template.tools.filter(tool => isWriteMethod(tool.method)).length;
                  return <article className={`marketplace-card service-template-card${selectedId === template.id ? ' is-selected' : ''}${template.installable ? '' : ' is-blocked'}`} key={template.id}>
                    <button type="button" onClick={() => selectTemplate(template)}>
                      <div className="marketplace-card-head"><BrandIcon brand={template.id} label={template.name} className="marketplace-icon" /><span className={`publisher-badge ${template.certification.status === 'certified' ? 'publisher-vendor' : 'publisher-community'}`}>{template.certification.status === 'certified' ? <><ShieldCheck size={11} />Contract</> : <><AlertTriangle size={11} />Review</>}</span></div>
                      <h3>{template.name}</h3><span className="marketplace-publisher">{template.backendType.toUpperCase()} · {template.tools.length} capabilities</span><p>{template.description}</p>
                      <div className="marketplace-tags">{template.tags.slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}</div>
                      <footer><span>{template.category}</span><strong>{writes > 0 ? `${writes} governed writes` : 'Read-oriented'} <ArrowRight size={12} /></strong></footer>
                    </button>
                  </article>;
                })}</div> : <div className="marketplace-empty"><PackageSearch size={28} /><b>No matching connectors</b><span>Try another system, capability or domain.</span></div>}
              </>
            )}
          </div>

          {selected && <aside className="marketplace-detail service-template-detail">
            <div className="marketplace-detail-head"><BrandIcon brand={selected.id} label={selected.name} className="marketplace-detail-icon" /><div><span className="eyebrow">{selected.category} · {selected.backendType}</span><h3>{selected.name}</h3><p>{selected.tools.length} predefined capabilities</p></div><button type="button" aria-label="Close connector details" disabled={install.isPending} onClick={() => setSelectedId(null)}><X size={15} /></button></div>
            {!selected.installable && <div className="service-template-blocked" role="alert"><AlertTriangle size={17} /><div><b>Native installation blocked</b><span>{selected.unavailableReason}</span></div></div>}
            <div className="service-template-certified"><ShieldCheck size={15} /><span><b>{selected.certification.certifiedCount}/{selected.certification.totalCount} tool contracts certified</b><small>Live credentials are tested separately.</small></span></div>
            <p className="marketplace-detail-description">{selected.description}</p>
            {selected.docsUrl && <a className="service-template-docs" href={selected.docsUrl} target="_blank" rel="noreferrer">Vendor documentation <ExternalLink size={12} /></a>}

            <form className="service-template-form" onSubmit={submit}>
              <label><span>Technical prefix</span><input value={prefix} disabled={install.isPending || !selected.installable} pattern="[a-z0-9][a-z0-9_-]{1,63}" required onChange={event => setPrefix(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64))} /><small>Names the connection and prefixes every capability.</small></label>
              <label><span>Required access bundle</span><select value={bundleId} disabled={install.isPending || !selected.installable} required onChange={event => setBundleId(event.target.value)}><option value="">Choose a governed boundary</option>{bundles.map(bundle => <option value={bundle.id} key={bundle.id}>{bundle.icon} {bundle.label}</option>)}</select><small>Native installs cannot create unscoped capabilities.</small></label>
              {selected.fields.map(field => <label key={field.name}><span>{field.label}{field.required ? ' *' : ''}</span>{field.type === 'select' ? <select value={fields[field.name] ?? ''} required={field.required} disabled={install.isPending || !selected.installable} onChange={event => setFields(current => ({ ...current, [field.name]: event.target.value }))}><option value="">Choose…</option>{field.options.map(option => <option value={option} key={option}>{option}</option>)}</select> : <input type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'} value={fields[field.name] ?? ''} required={field.required} autoComplete={field.type === 'password' ? 'new-password' : 'off'} placeholder={field.placeholder ?? undefined} disabled={install.isPending || !selected.installable} onChange={event => setFields(current => ({ ...current, [field.name]: event.target.value }))} />}{field.type === 'password' && <small><KeyRound size={11} />Encrypted at rest; never returned after submission.</small>}</label>)}

              <div className="service-template-capabilities"><div><span>Capability preview</span><b>{selected.tools.length}</b></div>{selected.tools.length > 0 ? <div>{selected.tools.slice(0, 10).map(tool => <code className={isWriteMethod(tool.method) ? 'is-write' : ''} key={tool.nameSuffix}>{tool.method ?? 'CALL'} · {prefix || selected.id}_{tool.nameSuffix}</code>)}{selected.tools.length > 10 && <span>+{selected.tools.length - 10} more</span>}</div> : <p>Capabilities can be added in Capability Studio after the connection is verified.</p>}</div>
              {writeCount > 0 && <div className="service-template-governance"><Wrench size={15} /><span><b>{writeCount} write-capable operation{writeCount === 1 ? '' : 's'}</b> will be risk-labelled and remain behind the disabled connection until verification.</span></div>}
              {bundles.length === 0 && <div className="service-template-blocked" role="alert"><AlertTriangle size={16} /><span>Create an access bundle before installing a connector template.</span></div>}
              {install.error && <div className="editor-error" role="alert"><AlertTriangle size={14} />{install.error.message}</div>}
              <div className="marketplace-detail-actions"><button type="button" className="button button-secondary" disabled={install.isPending} onClick={() => setSelectedId(null)}>Back</button><button type="submit" className="button button-primary" disabled={install.isPending || !selected.installable || !bundleId || bundles.length === 0}>{install.isPending ? 'Installing…' : <><Check size={15} />Install staged connector</>}</button></div>
            </form>
          </aside>}
        </div>
      </section>
    </div>
  );
}
