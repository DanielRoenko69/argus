import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, Cloud, Database, KeyRound, Network, Save, Search, Server, Trash2, X } from 'lucide-react';
import type {
  KnowledgeAdapterConfig,
  KnowledgeProviderDefinition,
  KnowledgeProviderField,
  KnowledgeProviderId,
  KnowledgeSource,
  KnowledgeSourceMutation,
} from '../types';

interface KnowledgeEditorProps {
  source: KnowledgeSource | null;
  providers: KnowledgeProviderDefinition[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: KnowledgeSourceMutation) => void;
  onDelete: (source: KnowledgeSource) => void;
}

function ProviderIcon({ provider }: { provider: KnowledgeProviderId }) {
  if (provider === 'pgvector') return <Database size={17} />;
  if (provider === 'qdrant' || provider === 'milvus') return <Server size={17} />;
  if (provider === 'azure_ai_search' || provider === 'pinecone') return <Cloud size={17} />;
  if (provider === 'opensearch' || provider === 'elasticsearch') return <Search size={17} />;
  return <Network size={17} />;
}

function sourceFieldValue(source: KnowledgeSource | null, field: KnowledgeProviderField): string {
  if (!source) return field.default_value ?? '';
  if (field.key.startsWith('adapter_config.')) {
    const key = field.key.slice('adapter_config.'.length) as keyof KnowledgeAdapterConfig;
    return source.adapter_config?.[key] ?? field.default_value ?? '';
  }
  const value = source[field.key as 'endpoint' | 'index_name' | 'semantic_config' | 'vector_field'];
  return value == null ? field.default_value ?? '' : String(value);
}

export function KnowledgeEditor({ source, providers, busy, error, onClose, onSave, onDelete }: KnowledgeEditorProps) {
  const initialProvider = (source?.provider as KnowledgeProviderId | undefined) ?? providers[0]?.id ?? 'pgvector';
  const [provider, setProvider] = useState<KnowledgeProviderId>(initialProvider);
  const [name, setName] = useState(source?.name ?? '');
  const [label, setLabel] = useState(source?.label ?? '');
  const [description, setDescription] = useState(source?.description ?? '');
  const [topK, setTopK] = useState(String(source?.top_k ?? 5));
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => {
    const definition = providers.find(item => item.id === initialProvider);
    return Object.fromEntries((definition?.fields ?? []).map(field => [field.key, sourceFieldValue(source, field)]));
  });
  const [keyMode, setKeyMode] = useState<'keep' | 'replace' | 'clear'>(source?.api_key ? 'keep' : 'replace');
  const [apiKey, setApiKey] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteName, setDeleteName] = useState('');
  const definition = useMemo(
    () => providers.find(item => item.id === provider) ?? providers.find(item => item.id === 'pgvector'),
    [provider, providers],
  );
  const isBuiltIn = definition?.kind === 'built_in';

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.classList.remove('has-dialog'); window.removeEventListener('keydown', onKey); };
  }, [busy, onClose]);

  const selectProvider = (next: KnowledgeProviderId) => {
    setProvider(next);
    const nextDefinition = providers.find(item => item.id === next);
    setFieldValues(current => ({
      ...current,
      ...Object.fromEntries((nextDefinition?.fields ?? []).map(field => [field.key, current[field.key] ?? field.default_value ?? ''])),
    }));
    setKeyMode('replace');
    setApiKey('');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      if (!definition) throw new Error('The selected knowledge provider is unavailable.');
      const normalizedName = name.trim();
      const parsedTopK = Number(topK);
      if (!source && !/^[a-z0-9_-]+$/.test(normalizedName)) throw new Error('Technical name must use lowercase letters, numbers, _ or -.');
      if (!label.trim()) throw new Error('Display name is required.');
      for (const field of definition.fields) {
        if (field.required && !(fieldValues[field.key] ?? field.default_value ?? '').trim()) throw new Error(`${field.label} is required.`);
      }
      if (!Number.isInteger(parsedTopK) || parsedTopK < 1 || parsedTopK > 50) throw new Error('Top-K must be between 1 and 50.');
      if (definition.credential.mode === 'required' && !source?.api_key && keyMode !== 'replace') throw new Error(`${definition.credential.label} is required.`);
      if (definition.credential.mode === 'required' && keyMode === 'replace' && !apiKey.trim()) throw new Error(`${definition.credential.label} is required.`);
      if (definition.credential.mode === 'required' && keyMode === 'clear') throw new Error(`${definition.credential.label} cannot be removed from this provider.`);

      const adapterConfig = Object.fromEntries(
        definition.fields
          .filter(field => field.key.startsWith('adapter_config.'))
          .map(field => [field.key.slice('adapter_config.'.length), (fieldValues[field.key] ?? field.default_value ?? '').trim()])
          .filter(([, value]) => value),
      ) as KnowledgeAdapterConfig;
      const keyValue = keyMode === 'keep' ? undefined : keyMode === 'clear' ? null : apiKey.trim() || undefined;
      setValidation(null);
      onSave({
        ...(!source ? { name: normalizedName } : {}),
        label: label.trim(),
        description: description.trim(),
        provider,
        endpoint: (fieldValues.endpoint ?? '').trim().replace(/\/+$/, ''),
        index_name: (fieldValues.index_name ?? '').trim(),
        ...(keyValue !== undefined ? { api_key: keyValue } : {}),
        semantic_config: (fieldValues.semantic_config ?? '').trim() || null,
        vector_field: (fieldValues.vector_field ?? '').trim() || null,
        adapter_config: adapterConfig,
        top_k: parsedTopK,
        enabled,
      });
    } catch (caught) {
      setValidation(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return <div className="editor-layer" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
    <section className="bundle-editor knowledge-editor" role="dialog" aria-modal="true" aria-labelledby="knowledge-editor-title" onMouseDown={event => event.stopPropagation()}>
      <header className="editor-header">
        <div><span className="eyebrow">ARGUS KNOWLEDGE</span><h2 id="knowledge-editor-title">{source ? `Configure ${source.label}` : 'Add knowledge source'}</h2><p>Choose a registered adapter. Every provider uses the same governed retrieval contract.</p></div>
        <button className="editor-close" type="button" aria-label="Close knowledge editor" disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      <form className="knowledge-editor-form" onSubmit={submit}>
        <section className="editor-section">
          <div className="editor-section-heading"><span><Database size={17} /></span><div><small>PROVIDER REGISTRY</small><h3>Storage and retrieval engine</h3></div>{source && <strong>LOCKED AFTER CREATE</strong>}</div>
          <div className="knowledge-provider-grid">{providers.map(option => {
            const selected = provider === option.id;
            return <label className={selected ? 'is-selected' : ''} key={option.id}>
              <input type="radio" name="knowledge-provider" value={option.id} checked={selected} disabled={source != null} onChange={() => selectProvider(option.id)} />
              <span className="connection-check">{selected && <CheckCircle2 size={12} />}</span>
              <span className="knowledge-provider-icon"><ProviderIcon provider={option.id} /></span>
              <span><b>{option.label}</b><small>{option.description}</small></span>
            </label>;
          })}</div>
        </section>

        <section className="editor-section">
          <div className="editor-section-heading"><span><Database size={17} /></span><div><small>IDENTITY</small><h3>Name and behavior</h3></div><strong>{enabled ? 'ACTIVE' : 'DISABLED'}</strong></div>
          <div className="knowledge-field-grid"><label className="editor-field"><span>Technical name <em>required</em></span><input required disabled={source != null} value={name} onChange={event => setName(event.target.value)} placeholder="engineering-handbook" /></label><label className="editor-field"><span>Display name <em>required</em></span><input required value={label} onChange={event => setLabel(event.target.value)} placeholder="Engineering Handbook" /></label></div>
          <label className="editor-field"><span>Description</span><textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="What knowledge this source contains and which agents should use it." /></label>
          <label className="editor-field knowledge-top-k"><span>Results per query</span><input type="number" min="1" max="50" value={topK} onChange={event => setTopK(event.target.value)} /><small>The reranker can reduce a wider candidate set back to this Top-K.</small></label>
          <label className="agent-switch"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span className="connection-check">{enabled && <CheckCircle2 size={12} />}</span><span><b>Knowledge source enabled</b><small>Disabled sources remain configured but are skipped during agent retrieval.</small></span></label>
        </section>

        {!isBuiltIn && definition && <section className="editor-section">
          <div className="editor-section-heading"><span><ProviderIcon provider={provider} /></span><div><small>ADAPTER CONFIGURATION</small><h3>{definition.label} · {definition.target_label}</h3></div><strong>{definition.capabilities.evaluation ? 'SEARCH + EVAL' : 'SEARCH'}</strong></div>
          <div className="knowledge-field-grid knowledge-adapter-fields">{definition.fields.map(field => <label className="editor-field" key={field.key}><span>{field.label}{field.required && <em>required</em>}</span>{field.input === 'select' ? <select value={fieldValues[field.key] ?? field.default_value ?? ''} onChange={event => setFieldValues(current => ({ ...current, [field.key]: event.target.value }))}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input required={field.required} type={field.input === 'url' ? 'url' : 'text'} value={fieldValues[field.key] ?? field.default_value ?? ''} onChange={event => setFieldValues(current => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} />}{field.description && <small>{field.description}</small>}</label>)}</div>

          {definition.credential.mode !== 'none' && <div className="knowledge-key-block"><div className="editor-section-heading compact"><span><KeyRound size={15} /></span><div><small>CREDENTIAL</small><h3>{definition.credential.label}</h3></div><strong>{source?.api_key ? 'CONFIGURED' : definition.credential.mode.toUpperCase()}</strong></div>{source?.api_key && <div className="agent-key-actions"><button type="button" className={keyMode === 'keep' ? 'is-active' : ''} onClick={() => setKeyMode('keep')}>Keep current</button><button type="button" className={keyMode === 'replace' ? 'is-active' : ''} onClick={() => setKeyMode('replace')}>Replace</button>{definition.credential.mode !== 'required' && <button type="button" className={keyMode === 'clear' ? 'is-danger' : ''} onClick={() => setKeyMode('clear')}>Remove</button>}</div>}{keyMode === 'replace' && <label className="editor-field"><span>{source?.api_key ? 'New credential' : definition.credential.label}</span><input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={definition.credential.placeholder} /><small>Environment references are resolved server-side. Saved values are never returned.</small></label>}{keyMode === 'clear' && <div className="agent-warning"><AlertTriangle size={14} /><span>The stored credential will be removed on save.</span></div>}</div>}
        </section>}

        {isBuiltIn && <section className="knowledge-built-in-note"><Database size={18} /><span><b>No external service required</b><small>Documents are chunked and stored in the existing Argus PostgreSQL instance with pgvector HNSW retrieval.</small></span></section>}
        {(validation || error) && <div className="editor-error" role="alert"><AlertTriangle size={15} /><span>{validation || error}</span></div>}
        <footer className="editor-footer knowledge-editor-footer"><div>{source && (!deleteArmed ? <button className="button editor-delete" type="button" disabled={busy} onClick={() => setDeleteArmed(true)}><Trash2 size={14} />Delete source</button> : <div className="agent-delete-confirm"><input value={deleteName} onChange={event => setDeleteName(event.target.value)} placeholder={`Type ${source.name}`} aria-label="Confirm knowledge source name" /><button className="button button-danger" type="button" disabled={busy || deleteName !== source.name} onClick={() => onDelete(source)}>Confirm delete</button><button className="button button-secondary" type="button" onClick={() => { setDeleteArmed(false); setDeleteName(''); }}>Cancel</button></div>)}</div><div><button className="button button-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={busy}><Save size={14} />{busy ? 'Saving…' : source ? 'Save source' : 'Create source'}</button></div></footer>
      </form>
    </section>
  </div>;
}
