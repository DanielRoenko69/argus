import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Beaker, CheckCircle2, FlaskConical, Play, Plus, ShieldCheck, SquareActivity } from 'lucide-react';
import {
  activateEvaluationDataset,
  addEvaluationCase,
  createEvaluationDataset,
  createEvaluationExperiment,
  getAgents,
  getLlmCatalog,
  getEvaluationDataset,
  getEvaluationDatasets,
  getEvaluationExperiment,
  getEvaluationRegression,
  getEvaluationExperiments,
  runEvaluationExperiment,
  cancelEvaluationExperiment,
  retryEvaluationExperiment,
} from '../api';
import { EmptyState, ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { AgentWorkspaceTabs } from '../features/agents/AgentWorkspaceTabs';
import { EvaluationComparisonPanel } from '../components/EvaluationComparisonPanel';
import { EvaluationCaseEditor } from '../components/EvaluationCaseEditor';
import { EvaluationStarterSets } from '../components/EvaluationStarterSets';
import { useSearchParams } from 'react-router-dom';
import type { AgentSummary, EvaluationExperiment, EvaluationExperimentDetail } from '../types';

function pretty(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function statusClass(status: string): string {
  return `evaluation-status is-${status}`;
}

function DatasetCreator({ agents, saving, onSave }: { agents: AgentSummary[]; saving: boolean; onSave: (input: Record<string, unknown>) => void }) {
  const [key, setKey] = useState('argus-dev-regression');
  const [name, setName] = useState('Argus Dev regression set');
  const [version, setVersion] = useState('1');
  const [agentId, setAgentId] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ dataset_key: key.trim(), name: name.trim(), version: Number(version), agent_id: agentId ? Number(agentId) : null, description: 'Curated, redacted cases for repeatable agent evaluation.' });
  };
  return <form className="evaluation-inline-form" onSubmit={submit}>
    <div className="policy-field-grid">
      <label className="editor-field"><span>Dataset key</span><input required maxLength={160} value={key} onChange={event => setKey(event.target.value)} /></label>
      <label className="editor-field"><span>Name</span><input required maxLength={240} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="editor-field"><span>Version</span><input required type="number" min={1} value={version} onChange={event => setVersion(event.target.value)} /></label>
      <label className="editor-field"><span>Default agent</span><select value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">Choose later</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.label || agent.name}</option>)}</select></label>
    </div>
    <button className="button button-primary" type="submit" disabled={saving || !key.trim() || !name.trim()}><Plus size={14} />{saving ? 'Creating…' : 'Create draft'}</button>
  </form>;
}

function ExperimentCard({ experiment, selected, onSelect, onRun, running }: { experiment: EvaluationExperiment; selected: boolean; onSelect: () => void; onRun: () => void; running: boolean }) {
  return <article className={`evaluation-experiment-card${selected ? ' is-selected' : ''}`}>
    <div className="evaluation-card-top"><span className="evaluation-icon"><FlaskConical size={17} /></span><span className={statusClass(experiment.status)}>{experiment.status}</span></div>
    <h3><button type="button" className="button button-ghost" aria-pressed={selected} onClick={onSelect}>{experiment.dataset_key ?? `Dataset #${experiment.dataset_id}`} · #{experiment.id}</button></h3>
    <p><code>{experiment.model_ref}</code>{experiment.dataset_version ? ` · v${experiment.dataset_version}` : ''}</p>
    <small>{experiment.created_at ? timeAgo(experiment.created_at) : '—'}{experiment.baseline_experiment_id ? ` · baseline #${experiment.baseline_experiment_id}` : ''}</small>
    <small>{experiment.evidence_kind === 'frozen_v1' ? 'Frozen snapshot · isolated answer evaluation' : 'Legacy smoke · not quality evidence'}</small>
    {experiment.readiness && <p>{experiment.readiness.reason}</p>}
    {experiment.status === 'queued' && !experiment.comparison_id && <button className="button button-secondary" type="button" disabled={running || !experiment.readiness?.startable} onClick={event => { event.stopPropagation(); onRun(); }}><Play size={13} />{running ? 'Starting…' : 'Run experiment'}</button>}
    {experiment.comparison_id && <small>Managed by comparison #{experiment.comparison_id} · start and stop the series above.</small>}
  </article>;
}

function EvaluationRunControls({ record,busy,onCancel,onRetry }: { record:EvaluationExperimentDetail; busy:boolean; onCancel:()=>void; onRetry:(caseIds:number[],requestId:string)=>void }) {
  const [selected,setSelected]=useState<number[]>([]);
  const [acknowledged,setAcknowledged]=useState(false);
  const [requestId,setRequestId]=useState(() => crypto.randomUUID());
  const p=record.progress;
  const eligible=p?.retryable_case_ids ?? [];
  const choose=(ids:number[]) => { setSelected(ids); setRequestId(crypto.randomUUID()); };
  return <section className="panel" aria-label="Selected evaluation controls">
    <div className="panel-heading"><h2>Experiment #{record.experiment.id} · {record.experiment.status}</h2>
      {!record.experiment.comparison_id && ['queued','running'].includes(record.experiment.status) && <button className="button button-secondary" disabled={busy || record.cancellation_requested} onClick={onCancel}>
        {record.cancellation_requested ? 'Cancellation requested…' : 'Cancel experiment'}</button>}
    </div>
    {p && <p role="status">{p.completed_cases} / {p.total_cases} cases judged · {p.recorded_attempts} recorded attempts · {p.pending_attempts} attempts without a recorded outcome</p>}
    {record.experiment.status==='interrupted' && <p>Execution was interrupted. No requests were automatically repeated. An unanswered provider request may still have incurred costs.</p>}
    {record.cancellation_requested && record.experiment.status==='running' && <p>Stopping new cases and requesting transport cancellation. Provider-side completion and billing cannot be guaranteed.</p>}
    {eligible.length>0 && <fieldset className="evaluation-retry-options"><legend>Retry technical cases</legend>
      <p>Previous answers and usage remain in the history. Already judged cases, including failed assertions, cannot be retried here.</p>
      {eligible.map(id => <label key={id}><input type="checkbox" checked={selected.includes(id)} disabled={busy}
        onChange={event => choose(event.target.checked ? [...selected,id] : selected.filter(n => n!==id))} /> <span>{record.experiment.expected_cases?.find(c => c.id===id)?.case_key ?? `Case #${id}`}</span></label>)}
      <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /> <span>I understand this creates new requests and may duplicate costs for uncertain attempts.</span></label>
      <button className="button button-primary" disabled={busy || !acknowledged || !selected.some(id => eligible.includes(id))}
        onClick={() => onRetry(selected.filter(id => eligible.includes(id)),requestId)}>Retry selected cases</button>
    </fieldset>}
    {!!record.attempts?.length && <details><summary>Attempt history ({record.attempts.length})</summary>
      {record.attempts.map(a => <p key={`${a.case_id}:${a.attempt}`}>Case #{a.case_id} · Attempt {a.attempt} · {record.results.find(r => r.case_id===a.case_id && r.attempt===a.attempt)?.status ?? 'Outcome unknown / pending'} · {timeAgo(a.started_at)}</p>)}
    </details>}
  </section>;
}

export function EvaluationPage() {
  const [params,setParams]=useSearchParams();
  const client = useQueryClient();
  const datasetsQuery = useQuery({ queryKey: ['evaluation-datasets'], queryFn: getEvaluationDatasets, staleTime: 5_000 });
  const experimentsQuery = useQuery({ queryKey: ['evaluation-experiments'], queryFn: getEvaluationExperiments, staleTime: 5_000, refetchInterval: query => query.state.data?.experiments.some(e => e.status==='running') ? 5_000 : false });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: getAgents, staleTime: 30_000 });
  const catalog = useQuery({ queryKey:['llm-catalog'],queryFn:getLlmCatalog,staleTime:30000 });
  const [datasetId, setDatasetId] = useState<number | null>(() => { const id=Number(params.get('dataset')); return Number.isSafeInteger(id) && id>0 ? id : null; });
  const [experimentId, setExperimentId] = useState<number | null>(() => { const id=Number(params.get('experiment')); return Number.isSafeInteger(id) && id>0 ? id : null; });
  const selectedDataset = useQuery({ queryKey: ['evaluation-dataset', datasetId], queryFn: () => getEvaluationDataset(datasetId!), enabled: datasetId != null });
  const selectedExperiment = useQuery({ queryKey: ['evaluation-experiment', experimentId], queryFn: () => getEvaluationExperiment(experimentId!), enabled: experimentId != null, refetchInterval: query => query.state.data?.experiment.status==='running' ? 3_000 : false });
  const regression = useQuery({ queryKey: ['evaluation-regression', experimentId,selectedExperiment.data?.experiment.status], queryFn: () => getEvaluationRegression(experimentId!), enabled: experimentId != null, refetchInterval: selectedExperiment.data?.experiment.status==='running' ? 3_000 : false });
  const [notice, setNotice] = useState('');
  const [modelRef, setModelRef] = useState('');
  const [baselineExperimentId, setBaselineExperimentId] = useState('');
  const datasetSave = useMutation({ mutationFn: createEvaluationDataset, onSuccess: async result => { setDatasetId(result.dataset.id); setNotice(`Draft “${result.dataset.name}” created.`); await client.invalidateQueries({ queryKey: ['evaluation-datasets'] }); } });
  const caseSave = useMutation({ mutationFn: ({ id, input }: { id: number; input: Record<string, unknown> }) => addEvaluationCase(id, input), onSuccess: async () => { setNotice('Evaluation case added.'); await Promise.all([client.invalidateQueries({ queryKey: ['evaluation-datasets'] }), client.invalidateQueries({ queryKey: ['evaluation-dataset', datasetId] })]); } });
  const activate = useMutation({ mutationFn: activateEvaluationDataset, onSuccess: async result => { setNotice(`Dataset “${result.dataset.name}” is active.`); await Promise.all([client.invalidateQueries({ queryKey: ['evaluation-datasets'] }), client.invalidateQueries({ queryKey: ['evaluation-dataset', result.dataset.id] })]); } });
  const experimentSave = useMutation({ mutationFn: createEvaluationExperiment, onSuccess: async result => { setExperimentId(result.experiment.id); setNotice('Configuration snapshot saved. Starting is explicit; only verified isolated targets can run.'); await client.invalidateQueries({ queryKey: ['evaluation-experiments'] }); } });
  const run = useMutation({ mutationFn: runEvaluationExperiment, onSuccess: async () => { setNotice('Experiment runner started.'); await Promise.all([client.invalidateQueries({ queryKey: ['evaluation-experiments'] }), client.invalidateQueries({ queryKey: ['evaluation-experiment', experimentId] })]); } });
  const refreshExecution=async () => { await Promise.all([client.invalidateQueries({ queryKey:['evaluation-experiments'] }),client.invalidateQueries({ queryKey:['evaluation-experiment',experimentId] }),client.invalidateQueries({ queryKey:['evaluation-regression',experimentId] })]); };
  const cancel=useMutation({ mutationFn:cancelEvaluationExperiment,onSuccess:async () => { setNotice('Cancellation requested; recorded evidence is retained.'); await refreshExecution(); } });
  const retry=useMutation({ mutationFn:retryEvaluationExperiment,onSuccess:async () => { setNotice('Selected cases accepted. Previous attempts remain visible.'); await refreshExecution(); } });

  useEffect(() => { if (datasetId == null && datasetsQuery.data?.datasets[0]) setDatasetId(datasetsQuery.data.datasets[0].id); }, [datasetId, datasetsQuery.data?.datasets]);
  useEffect(() => { if (experimentId == null && experimentsQuery.data?.experiments[0]) setExperimentId(experimentsQuery.data.experiments[0].id); }, [experimentId, experimentsQuery.data?.experiments]);
  useEffect(() => {
    if (selectedExperiment.data?.experiment.comparison_id) void client.invalidateQueries({ queryKey:['evaluation-comparison',selectedExperiment.data.experiment.comparison_id] });
  },[client,selectedExperiment.data?.experiment.comparison_id,selectedExperiment.data?.experiment.status]);

  const datasets = datasetsQuery.data?.datasets ?? [];
  const experiments = experimentsQuery.data?.experiments ?? [];
  const activeDatasets = useMemo(() => datasets.filter(dataset => dataset.status === 'active' && dataset.contract_version === 1), [datasets]);

  const mutationError = [datasetSave.error, caseSave.error, activate.error, experimentSave.error, run.error,cancel.error,retry.error].find(Boolean);
  if (datasetsQuery.isLoading || experimentsQuery.isLoading || agentsQuery.isLoading) return <LoadingState label="Loading Evaluation Lab…" />;
  if (datasetsQuery.error || experimentsQuery.error || agentsQuery.error) return <ErrorState error={(datasetsQuery.error || experimentsQuery.error || agentsQuery.error) as Error} />;

  return <>
    <PageHeader eyebrow="BUILD · EVALUATION LAB" title="Native evaluation" description="Compare frozen cases using deterministic assertions and isolated API or supported Codex execution. This measures answers, not completed real-world actions." actions={<span className="page-action-note"><ShieldCheck size={14} />Admin-only · audited</span>} />
    <AgentWorkspaceTabs active="evaluations" />
    <p><a href="/observe/quality">Quality Inbox: review operational evidence and turn it into test cases</a></p>
    <div className="connection-notice" role="status">Isolated API / Codex · Starting uses API billing or Codex subscription quota, depending on the selected target. At most one model request per case; no tools, automatic RAG, memory, LLM judge or automatic retries. No API fallback. Create new snapshots for newly supported runtimes; historical snapshots stay unchanged.</div>
    {mutationError && <div className="editor-error" role="alert">{mutationError instanceof Error ? mutationError.message : 'Evaluation operation failed'}</div>}
    {notice && <div className="connection-notice is-success" role="status"><CheckCircle2 size={15} />{notice}</div>}
    <section className="metric-grid build-metrics" aria-label="Evaluation summary">
      <article className="metric-card"><span className="metric-icon violet"><Beaker size={17} /></span><div><span>Datasets</span><strong>{datasets.length}</strong><small>{activeDatasets.length} active</small></div></article>
      <article className="metric-card"><span className="metric-icon blue"><SquareActivity size={17} /></span><div><span>Curated cases</span><strong>{datasets.reduce((sum, item) => sum + item.case_count, 0)}</strong><small>redacted inputs</small></div></article>
      <article className="metric-card"><span className="metric-icon teal"><FlaskConical size={17} /></span><div><span>Experiments</span><strong>{experiments.length}</strong><small>{experiments.filter(item => item.status === 'running').length} running</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><ShieldCheck size={17} /></span><div><span>Safety boundary</span><strong>Isolated</strong><small>reference-only · API / Codex</small></div></article>
    </section>

    <EvaluationComparisonPanel datasets={activeDatasets} agents={agentsQuery.data ?? []} onSelectExperiment={setExperimentId} />
    <EvaluationStarterSets datasets={datasets} onSelect={id => { setDatasetId(id); setParams(previous => { const next=new URLSearchParams(previous); next.set('dataset',String(id)); return next; }); }} />
    {selectedExperiment.error && <ErrorState error={selectedExperiment.error} />}
    {regression.error && <ErrorState error={regression.error} />}
    {selectedExperiment.data && <EvaluationRunControls key={`${experimentId}:${selectedExperiment.data.experiment.status}`} record={selectedExperiment.data} busy={run.isPending || cancel.isPending || retry.isPending} onCancel={() => cancel.mutate(experimentId!)} onRetry={(caseIds,requestId) => retry.mutate({ id:experimentId!,caseIds,requestId })} />}
    <div className="evaluation-layout">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DATASETS</span><h2>Frozen evaluation inputs</h2></div><small>versioned and append-only</small></div>
        <DatasetCreator agents={agentsQuery.data ?? []} saving={datasetSave.isPending} onSave={input => datasetSave.mutate(input)} />
        {datasets.length ? <div className="evaluation-dataset-list">{datasets.map(dataset => <button className={`evaluation-dataset-row${dataset.id === datasetId ? ' is-selected' : ''}`} type="button" key={dataset.id} onClick={() => setDatasetId(dataset.id)}><span><b>{dataset.name}</b><small>{dataset.dataset_key} · v{dataset.version}</small></span><span><strong>{dataset.case_count}</strong> cases</span><span className={statusClass(dataset.status)}>{dataset.status}</span></button>)}</div> : <EmptyState title="No datasets yet" description="Create a draft to start curating your first regression cases." />}
      </section>

      <section className="panel evaluation-dataset-detail">
        {selectedDataset.isLoading ? <LoadingState label="Loading test set…" /> : selectedDataset.error ? <ErrorState error={selectedDataset.error} /> : selectedDataset.data ? <>
          <div className="panel-heading"><div><span className="eyebrow">TEST SET WORKBENCH</span><h2>{selectedDataset.data.dataset.name}</h2></div><span className={statusClass(selectedDataset.data.dataset.status)}>{selectedDataset.data.dataset.status}</span></div>
          <p className="evaluation-muted">{selectedDataset.data.dataset.description || 'No description.'}</p>
          {selectedDataset.data.dataset.contract_version!==1 && <p role="status" className="connection-notice">Legacy test set: read-only. Create a new draft on the left using the same dataset key and a higher version to add cases and activate it. Historical evidence is never overwritten.</p>}
          <div className="evaluation-case-list">{selectedDataset.data.cases.map(item => <details key={item.id}>
            <summary><b>{item.case_key}</b><span>{item.rules?.assertions.length ?? 0} criteria</span></summary>
            <pre>{pretty(item.input_redacted)}</pre>
            {item.expected_output!=null && <><h4>Expected answer / reviewer notes</h4><pre>{pretty(item.expected_output)}</pre></>}
            {item.source_trace_id && <p>Curated source: <a href={`/observe/logs?trace=${encodeURIComponent(item.source_trace_id)}${item.source_span_id ? `&span=${encodeURIComponent(item.source_span_id)}` : ''}`}>Open source trace{item.source_span_id ? ' and span' : ''}</a> · Observed output is not ground truth.</p>}
            {item.context_redacted!=null && <><h4>Reference context</h4><pre>{pretty(item.context_redacted)}</pre></>}
            <details><summary>Stored criteria and evidence digest</summary><pre>{pretty(item.rules)}</pre><code>{item.input_sha256}</code></details>
          </details>)}</div>
          <div className="evaluation-actions">{selectedDataset.data.dataset.status==='draft' && selectedDataset.data.dataset.contract_version===1 && <>
            <EvaluationCaseEditor key={selectedDataset.data.dataset.id} datasetId={selectedDataset.data.dataset.id} saving={caseSave.isPending} onSave={(id,input) => caseSave.mutate({ id,input })} />
            <p className="evaluation-muted">Activation freezes the cases and criteria. Later edits need a new version.</p>
            <button className="button button-primary" type="button" disabled={!selectedDataset.data.cases.length || activate.isPending || caseSave.isPending} onClick={() => activate.mutate(selectedDataset.data.dataset.id)}><CheckCircle2 size={14} />{activate.isPending ? 'Activating…' : 'Activate dataset'}</button>
          </>}{selectedDataset.data.dataset.status==='active' && <span className="evaluation-ready"><CheckCircle2 size={15} />Frozen content · create a new version to edit</span>}</div>
        </> : <EmptyState title="Select a dataset" description="Choose a dataset on the left to inspect cases and activation state." />}
      </section>
    </div>

    <section className="panel evaluation-experiments"><div className="panel-heading"><div><span className="eyebrow">EXPERIMENTS</span><h2>Model comparison runs</h2></div><div className="panel-heading-actions"><select aria-label="Active evaluation dataset" value={activeDatasets.some(item => item.id === datasetId) ? datasetId ?? '' : ''} onChange={event => { setDatasetId(Number(event.target.value)); setBaselineExperimentId(''); }}><option value="">Choose active dataset</option>{activeDatasets.map(item => <option key={item.id} value={item.id}>{item.dataset_key} · v{item.version}</option>)}</select><select aria-label="Pinned baseline experiment" value={baselineExperimentId} onChange={event => setBaselineExperimentId(event.target.value)}><option value="">No baseline</option>{experiments.filter(item => item.evidence_kind === 'frozen_v1' && item.status === 'completed' && item.dataset_id === datasetId).map(item => <option key={item.id} value={item.id}>Baseline #{item.id} · {item.model_ref}</option>)}</select><select aria-label="Pinned model reference" value={modelRef} onChange={event => setModelRef(event.target.value)} disabled={catalog.isLoading || !!catalog.error}><option value="">{catalog.error ? 'Model catalog unavailable' : 'Choose API model'}</option>{catalog.data?.models.filter(m => m.enabled && m.providerEnabled).map(m => <option key={m.id} value={m.modelName}>{m.displayName || m.modelName} · {m.providerLabel}</option>)}</select><button className="button button-primary" type="button" disabled={!activeDatasets.length || experimentSave.isPending || !modelRef.trim()} onClick={() => { const selected = activeDatasets.find(item => item.id === datasetId) ?? activeDatasets[0]; if (selected) experimentSave.mutate({ dataset_id: selected.id, agent_id: selected.agent_id, model_ref: modelRef.trim(), baseline_experiment_id: baselineExperimentId ? Number(baselineExperimentId) : null, evaluator_config: { version: 'argus.deterministic.v1' } }); }}><Plus size={14} />Save snapshot</button></div></div>{experiments.length ? <div className="evaluation-experiment-grid">{experiments.map(experiment => <ExperimentCard key={experiment.id} experiment={experiment} selected={experiment.id === experimentId} onSelect={() => setExperimentId(experiment.id)} onRun={() => { setExperimentId(experiment.id); run.mutate(experiment.id); }} running={run.isPending && experiment.id === run.variables} />)}</div> : <EmptyState title="No experiments yet" description="Activate a dataset, then create a pinned model experiment." />}{selectedExperiment.data && <div className="evaluation-results"><div><span className="eyebrow">SELECTED RUN</span><h3>Experiment #{selectedExperiment.data.experiment.id} · {selectedExperiment.data.experiment.model_ref}</h3></div><span className={statusClass(selectedExperiment.data.experiment.status)}>{selectedExperiment.data.experiment.status}</span>{regression.data && <div className={`evaluation-regression ${regression.data.result?.status === 'failed' ? 'is-failed' : regression.data.result?.status === 'passed' ? 'is-passed' : ''}`}><div><b>Regression gate</b><small>{regression.data.result ? `${regression.data.result.status} · Δ ${regression.data.result.scoreDelta.toFixed(4)}` : regression.data.reason}</small></div>{regression.data.result && <span className={statusClass(regression.data.result.status)}>{regression.data.result.status}</span>}</div>}<div className="evaluation-result-grid">{selectedExperiment.data.results.map(result => <div key={result.id}><span className={statusClass(result.status)}>{result.status}</span><b>Case #{result.case_id} · Attempt {result.attempt}</b><small>{result.latency_ms ?? '—'} ms · Score {result.scores.overall == null ? 'unknown' : `${Math.round(result.scores.overall * 100)}%`}{result.error_message ? ` · ${result.error_message}` : ''}</small><small>Tokens: {result.input_tokens ?? 'unknown'} in / {result.output_tokens ?? 'unknown'} out · Cost: {result.cost_usd == null ? 'unknown' : `${Number(result.cost_usd).toFixed(6)} (catalog estimate)`}</small><details><summary>Answer and checks</summary><pre>{pretty(result.output_redacted)}</pre><pre>{pretty(result.evidence?.judgement)}</pre></details></div>)}</div></div>}</section>
  </>;
}
