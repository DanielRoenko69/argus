import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock3,
  Gauge,
  Pencil,
  Plus,
  Target,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  createNativeSlo,
  deleteNativeSlo,
  getNativeDependencyMap,
  getNativeSlos,
  getOverview,
  updateNativeSlo,
} from '../api';
import { isPlatformAdminRole } from '../access';
import { ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { ObserveWorkspaceTabs } from '../features/observe/ObserveWorkspaceTabs';
import type { NativeAlertScopeKind, NativeSlo, NativeSloMetric, NativeSloMutation } from '../types';

const emptySlo: NativeSloMutation = {
  name: '', description: '', metric: 'success_rate', target: 95, windowMinutes: 1440,
  minSamples: 20, scopeKind: 'all', scopeValue: null, enabled: true,
};

function mutationValue(slo: NativeSlo): NativeSloMutation {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, evaluation: _evaluation, ...input } = slo;
  return input;
}

function formatSloValue(metric: NativeSloMetric, value: number | null): string {
  if (value == null) return '—';
  return metric === 'success_rate'
    ? `${value.toFixed(1)}%`
    : value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value.toFixed(0)}ms`;
}

function scopeLabel(slo: Pick<NativeSloMutation, 'scopeKind' | 'scopeValue'>): string {
  return slo.scopeKind === 'all' ? 'All executions' : `${slo.scopeKind} · ${slo.scopeValue}`;
}

function SloEditor({
  initial,
  targets,
  pending,
  error,
  onCancel,
  onSave,
}: {
  initial: NativeSloMutation;
  targets: Array<{ id: string; kind: string; name: string }>;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (input: NativeSloMutation) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = <K extends keyof NativeSloMutation>(key: K, value: NativeSloMutation[K]) => setDraft(current => ({ ...current, [key]: value }));
  const options = targets.filter(target => target.kind === draft.scopeKind);
  const isNew = !initial.name;
  return <section className="panel slo-editor-panel">
    <div className="panel-heading"><div><span className="eyebrow">OBJECTIVE BUILDER</span><h2>{isNew ? 'New service-level objective' : 'Edit objective'}</h2></div><button type="button" className="icon-button" aria-label="Close SLO editor" onClick={onCancel}><X size={15} /></button></div>
    <div className="slo-editor-grid">
      <label className="alert-field field-wide"><span>Name</span><input value={draft.name} onChange={event => set('name', event.target.value)} placeholder="Planner reliability" /></label>
      <label className="alert-field field-wide"><span>Description</span><input value={draft.description} onChange={event => set('description', event.target.value)} placeholder="Reliability objective for production planning runs." /></label>
      <label className="alert-field"><span>Signal</span><select value={draft.metric} onChange={event => {
        const metric = event.target.value as NativeSloMetric;
        setDraft(current => ({ ...current, metric, target: metric === 'success_rate' ? 95 : 30_000 }));
      }}><option value="success_rate">Success rate</option><option value="p95_latency_ms">P95 latency</option></select></label>
      <label className="alert-field"><span>Objective</span><div className="alert-input-unit"><input type="number" min="0.01" max={draft.metric === 'success_rate' ? 100 : undefined} step="any" value={draft.target} onChange={event => set('target', Number(event.target.value))} /><em>{draft.metric === 'success_rate' ? '%' : 'ms'}</em></div></label>
      <label className="alert-field"><span>Window</span><select value={draft.windowMinutes} onChange={event => set('windowMinutes', Number(event.target.value))}><option value={60}>1 hour</option><option value={360}>6 hours</option><option value={1440}>24 hours</option><option value={10080}>7 days</option><option value={43200}>30 days</option></select></label>
      <label className="alert-field"><span>Minimum samples</span><input type="number" min="1" value={draft.minSamples} onChange={event => set('minSamples', Number(event.target.value))} /></label>
      <label className="alert-field"><span>Component type</span><select value={draft.scopeKind} onChange={event => {
        const scopeKind = event.target.value as NativeAlertScopeKind;
        setDraft(current => ({ ...current, scopeKind, scopeValue: null }));
      }}><option value="all">All executions</option><option value="agent">Agent</option><option value="workflow">Workflow</option><option value="model">Model</option><option value="tool">Tool</option></select></label>
      <label className="alert-field field-wide"><span>Component</span><select disabled={draft.scopeKind === 'all'} value={draft.scopeValue ?? ''} onChange={event => set('scopeValue', event.target.value || null)}><option value="">Select a component…</option>{options.map(target => <option value={target.id} key={`${target.kind}-${target.id}`}>{target.name}</option>)}</select></label>
      <div className="alert-toggle-group"><label><input type="checkbox" checked={draft.enabled} onChange={event => set('enabled', event.target.checked)} /><span>Objective enabled</span></label></div>
    </div>
    {error && <div className="editor-error" role="alert"><TriangleAlert size={14} />{error}</div>}
    <footer className="alert-editor-actions"><button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button><button className="button button-primary" type="button" disabled={pending || !draft.name.trim() || draft.scopeKind !== 'all' && !draft.scopeValue} onClick={() => onSave(draft)}>{pending ? 'Saving…' : 'Save objective'}</button></footer>
  </section>;
}

export function SlosPage() {
  const client = useQueryClient();
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview });
  const slos = useQuery({ queryKey: ['native-slos'], queryFn: getNativeSlos, refetchInterval: 30_000 });
  const dependencies = useQuery({ queryKey: ['native-dependencies', 24], queryFn: () => getNativeDependencyMap(24) });
  const [editor, setEditor] = useState<NativeSlo | 'new' | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ['native-slos'] }),
    client.invalidateQueries({ queryKey: ['native-service-health'] }),
  ]);
  const save = useMutation({
    mutationFn: (input: NativeSloMutation) => editor === 'new' ? createNativeSlo(input) : updateNativeSlo(editor!.id, input),
    onSuccess: () => { setEditor(null); void refresh(); },
  });
  const remove = useMutation({ mutationFn: deleteNativeSlo, onSuccess: () => { setDeleteTarget(null); void refresh(); } });
  const toggle = useMutation({
    mutationFn: ({ slo, enabled }: { slo: NativeSlo; enabled: boolean }) => updateNativeSlo(slo.id, { ...mutationValue(slo), enabled }),
    onSuccess: () => { void refresh(); },
  });

  if (overview.isLoading || slos.isLoading) return <LoadingState label="Evaluating service-level objectives…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  const isAdmin = isPlatformAdminRole(overview.data?.user.role);
  if (!isAdmin) return <div className="state-panel state-error" role="alert"><TriangleAlert size={22} /><div><b>Platform administrator access required</b><span>SLOs evaluate cross-platform and component-specific telemetry.</span></div></div>;
  if (slos.error) return <ErrorState error={slos.error} />;
  if (!slos.data) return null;
  const targets = (dependencies.data?.nodes ?? [])
    .filter(node => ['agent', 'workflow', 'model', 'tool'].includes(node.kind))
    .map(node => ({ id: node.kind === 'agent' || node.kind === 'workflow' ? node.id.split(':').slice(1).join(':') : node.name, kind: node.kind, name: node.name }));

  return <>
    <PageHeader eyebrow="OBSERVE · SLOS" title="Service-level objectives" description="Define reliability and latency objectives globally or for a specific agent, workflow, model, or tool." actions={<button className="button button-primary" type="button" onClick={() => { save.reset(); setEditor('new'); }}><Plus size={14} />New objective</button>} />
    <ObserveWorkspaceTabs active="health" section="slos" isAdmin={isAdmin} />
    <section className="metric-grid slo-metrics">
      <article className="metric-card"><span className="metric-icon violet"><Target size={17} /></span><div><span>Enabled</span><strong>{slos.data.summary.enabled}</strong><small>{slos.data.slos.length} configured</small></div></article>
      <article className="metric-card"><span className="metric-icon teal"><CheckCircle2 size={17} /></span><div><span>Meeting target</span><strong>{slos.data.summary.met}</strong><small>enough evidence</small></div></article>
      <article className="metric-card"><span className={`metric-icon ${slos.data.summary.breached ? 'red' : 'teal'}`}><TriangleAlert size={17} /></span><div><span>Breached</span><strong>{slos.data.summary.breached}</strong><small>needs attention</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><Clock3 size={17} /></span><div><span>No data</span><strong>{slos.data.summary.noData}</strong><small>below sample floor</small></div></article>
    </section>

    {editor && <SloEditor key={editor === 'new' ? 'new' : editor.id} initial={editor === 'new' ? emptySlo : mutationValue(editor)} targets={targets} pending={save.isPending} error={save.error?.message ?? null} onCancel={() => setEditor(null)} onSave={input => save.mutate(input)} />}

    <section className="panel slo-list-panel">
      <div className="panel-heading"><div><span className="eyebrow">OBJECTIVES</span><h2>Evaluated policies</h2></div><small>live native telemetry</small></div>
      <div className="slo-objective-grid">{slos.data.slos.map(slo => <article className={`slo-objective-card state-${slo.evaluation.state}`} key={slo.id}>
        <header><span>{slo.metric === 'success_rate' ? <Target size={15} /> : <Gauge size={15} />}</span><em className={`slo-state is-${slo.evaluation.state}`}>{slo.evaluation.state.replace('_', ' ')}</em><label className="switch"><input type="checkbox" checked={slo.enabled} disabled={toggle.isPending} onChange={event => toggle.mutate({ slo, enabled: event.target.checked })} /><i /></label></header>
        <h3>{slo.name}</h3><p>{slo.description || `${slo.metric === 'success_rate' ? 'Reliability' : 'Latency'} objective for ${scopeLabel(slo)}.`}</p>
        <div className="slo-objective-values"><div><span>Actual</span><strong>{formatSloValue(slo.metric, slo.evaluation.actual)}</strong></div><div><span>Target</span><strong>{slo.metric === 'success_rate' ? '≥ ' : '≤ '}{formatSloValue(slo.metric, slo.target)}</strong></div></div>
        {slo.evaluation.errorBudgetRemainingPercent != null && <div className="slo-budget"><span><i style={{ width: `${slo.evaluation.errorBudgetRemainingPercent}%` }} /></span><small>{slo.evaluation.errorBudgetRemainingPercent.toFixed(0)}% error budget remaining · {slo.evaluation.burnRate?.toFixed(2)}× burn</small></div>}
        <dl><div><dt>Scope</dt><dd>{scopeLabel(slo)}</dd></div><div><dt>Window</dt><dd>{slo.windowMinutes >= 1440 ? `${slo.windowMinutes / 1440}d` : `${slo.windowMinutes / 60}h`}</dd></div><div><dt>Evidence</dt><dd>{slo.evaluation.sampleCount} / {slo.minSamples}</dd></div></dl>
        <footer><span>Evaluated {timeAgo(slo.evaluation.evaluatedAt)}</span><div><button type="button" onClick={() => { save.reset(); setEditor(slo); }}><Pencil size={12} />Edit</button>{deleteTarget === slo.id ? <><button type="button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="is-danger" type="button" disabled={remove.isPending} onClick={() => remove.mutate(slo.id)}>Confirm</button></> : <button className="is-danger" type="button" onClick={() => setDeleteTarget(slo.id)}><Trash2 size={12} />Delete</button>}</div></footer>
      </article>)}</div>
    </section>
  </>;
}
