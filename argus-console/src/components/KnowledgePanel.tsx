import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Database,
  FileText,
  FlaskConical,
  Search,
  Settings2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { deleteKnowledgeDocument, evaluateKnowledgeSource, testKnowledgeSource, uploadKnowledgeDocuments } from '../api';
import { EmptyState, timeAgo } from './Ui';
import type { KnowledgeProviderDefinition, KnowledgeSource } from '../types';

export function KnowledgePanel({ source, provider, onClose, onEdit }: { source: KnowledgeSource; provider?: KnowledgeProviderDefinition; onClose: () => void; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [query, setQuery] = useState('');
  const [sampleSize, setSampleSize] = useState('10');
  const [notice, setNotice] = useState('');
  const [deleteDocumentId, setDeleteDocumentId] = useState<number | null>(null);
  const isBuiltIn = source.provider === 'pgvector';

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.classList.remove('has-dialog'); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['knowledge-catalog'] });
  const uploadMutation = useMutation({
    mutationFn: () => uploadKnowledgeDocuments(source.id, files),
    onSuccess: async result => {
      setFiles([]);
      setNotice(`${result.documents.length} document${result.documents.length === 1 ? '' : 's'} indexed${result.failed.length ? ` · ${result.failed.length} failed` : ''}.`);
      await refresh();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (documentId: number) => deleteKnowledgeDocument(source.id, documentId),
    onSuccess: async () => { setDeleteDocumentId(null); setNotice('Document and its chunks deleted.'); await refresh(); },
  });
  const testMutation = useMutation({ mutationFn: (value: string) => testKnowledgeSource(source.id, value) });
  const evalMutation = useMutation({ mutationFn: (size: number) => evaluateKnowledgeSource(source.id, size) });
  const busy = uploadMutation.isPending || deleteMutation.isPending || testMutation.isPending || evalMutation.isPending;
  const error = uploadMutation.error?.message || deleteMutation.error?.message || testMutation.error?.message || evalMutation.error?.message;

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) testMutation.mutate(query.trim());
  };

  return <div className="editor-layer knowledge-panel-layer" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
    <section className="knowledge-panel" role="dialog" aria-modal="true" aria-labelledby="knowledge-panel-title" onMouseDown={event => event.stopPropagation()}>
      <header className="editor-header knowledge-panel-header"><div><span className="eyebrow">KNOWLEDGE SOURCE</span><h2 id="knowledge-panel-title">{source.label}</h2><p>{source.description || 'No source description provided.'}</p></div><div className="knowledge-panel-header-actions"><span className={`knowledge-provider-badge is-${source.provider}`}>{source.provider === 'pgvector' ? 'Built-in · pgvector' : provider?.label ?? source.provider}</span><button className="button button-secondary" type="button" disabled={busy} onClick={onEdit}><Settings2 size={14} />Configure</button><button className="editor-close" type="button" aria-label="Close knowledge source" disabled={busy} onClick={onClose}><X size={18} /></button></div></header>

      <div className="knowledge-panel-body">
        <div className="knowledge-panel-main">
          {notice && <div className="knowledge-inline-notice"><CheckCircle2 size={14} />{notice}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={12} /></button></div>}
          {error && <div className="editor-error" role="alert"><AlertTriangle size={14} />{error}</div>}

          <section className="knowledge-workbench-section">
            <div className="knowledge-section-heading"><span><Search size={16} /></span><div><small>RETRIEVAL PLAYGROUND</small><h3>Test what an agent retrieves</h3></div><strong>TOP {source.top_k}</strong></div>
            <form className="knowledge-search-form" onSubmit={submitSearch}><label><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Ask a question grounded in this source…" /></label><button className="button button-primary" type="submit" disabled={busy || !query.trim()}>{testMutation.isPending ? 'Searching…' : 'Run retrieval'}</button></form>
            {testMutation.data ? <div className="knowledge-results"><div className="knowledge-results-summary"><span><CheckCircle2 size={13} />{testMutation.data.results_count} results</span><code>{testMutation.data.query}</code></div>{testMutation.data.results.length ? testMutation.data.results.map((result, index) => <article key={`${result.id}-${index}`}><span className="knowledge-result-rank">{index + 1}</span><div><header><b>{result.source || `Chunk ${result.id}`}</b><em>{Number.isFinite(result.score) ? `${Math.round(result.score * 100)}%` : '—'}</em></header><p>{result.content || 'No text payload was returned by the provider.'}</p></div></article>) : <EmptyState title="No matching chunks" description="Try a broader query or add more documents to this source." />}</div> : <div className="knowledge-playground-empty"><FlaskConical size={19} /><span><b>Run a real provider query</b><small>The result cards show the exact chunks and scores available to an agent.</small></span></div>}
          </section>

          <section className="knowledge-workbench-section">
            <div className="knowledge-section-heading"><span><BarChart3 size={16} /></span><div><small>QUALITY</small><h3>Retrieval evaluation</h3></div><strong>HIT@5</strong></div>
            <p className="knowledge-section-copy">{provider?.capabilities.evaluation === false ? `${provider.label} supports retrieval, but not portable schema-independent corpus sampling. Retrieval tests remain available above.` : 'Generate grounded test questions from sampled chunks and measure whether the source chunk returns in the first five results.'}</p>
            <div className="knowledge-eval-controls"><label className="editor-field"><span>Sample size</span><input type="number" min="5" max="50" value={sampleSize} disabled={provider?.capabilities.evaluation === false} onChange={event => setSampleSize(event.target.value)} /></label><button className="button button-secondary" type="button" disabled={busy || provider?.capabilities.evaluation === false} onClick={() => evalMutation.mutate(Math.min(50, Math.max(5, Number(sampleSize) || 10)))}><BarChart3 size={14} />{evalMutation.isPending ? 'Evaluating…' : provider?.capabilities.evaluation === false ? 'Not supported' : 'Run evaluation'}</button></div>
            {evalMutation.data && <div className={`knowledge-eval-result${evalMutation.data.error ? ' is-error' : ''}`}><strong>{evalMutation.data.error ? 'Evaluation unavailable' : `${Math.round(evalMutation.data.hit_at_5 * 100)}%`}</strong><span>{evalMutation.data.error || `${evalMutation.data.hits} of ${evalMutation.data.evaluated} grounded questions retrieved their source chunk.`}</span>{evalMutation.data.langfuse_dataset && <code>{evalMutation.data.langfuse_dataset}</code>}</div>}
          </section>
        </div>

        <aside className="knowledge-document-column">
          <section className="knowledge-document-header"><span><FileText size={16} /></span><div><small>{isBuiltIn ? 'MANAGED DOCUMENTS' : `EXTERNAL ${provider?.target_label?.toUpperCase() ?? 'CORPUS'}`}</small><h3>{isBuiltIn ? `${source.documents.length} documents` : source.index_name || provider?.label}</h3></div>{isBuiltIn && <strong>{source.documents.reduce((total, document) => total + document.chunk_count, 0)} CHUNKS</strong>}</section>
          {isBuiltIn ? <>
            <label className={`knowledge-upload-zone${files.length ? ' has-files' : ''}`}><input type="file" multiple accept=".txt,.md,.pdf" onChange={event => setFiles(Array.from(event.target.files ?? []))} /><Upload size={21} /><span><b>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected` : 'Choose knowledge documents'}</b><small>TXT, Markdown or PDF · maximum 25 MB each</small></span></label>
            {files.length > 0 && <div className="knowledge-upload-selection"><div>{files.map(file => <span key={`${file.name}-${file.size}`}><FileText size={12} />{file.name}<small>{Math.max(1, Math.round(file.size / 1024))} KB</small></span>)}</div><button className="button button-primary" type="button" disabled={busy} onClick={() => uploadMutation.mutate()}><Upload size={14} />{uploadMutation.isPending ? 'Chunking and embedding…' : 'Index files'}</button></div>}
            <div className="knowledge-document-list">{source.documents.length ? source.documents.map(document => <article key={document.id}><span><FileText size={14} /></span><div><b>{document.name}</b><small>{document.chunk_count} chunks · {timeAgo(document.created_at)}</small></div>{deleteDocumentId === document.id ? <div className="knowledge-document-confirm"><button type="button" className="is-danger" disabled={busy} onClick={() => deleteMutation.mutate(document.id)}>Confirm</button><button type="button" onClick={() => setDeleteDocumentId(null)}>Cancel</button></div> : <button type="button" aria-label={`Delete ${document.name}`} disabled={busy} onClick={() => setDeleteDocumentId(document.id)}><Trash2 size={13} /></button>}</article>) : <EmptyState title="No documents indexed" description="Upload the first files to make this source searchable." />}</div>
          </> : <div className="knowledge-external-note"><Database size={18} /><span><b>Corpus managed by provider</b><small>Argus retrieves from this source without taking ownership of its external documents.</small><code>{source.endpoint}</code></span></div>}
        </aside>
      </div>
    </section>
  </div>;
}
