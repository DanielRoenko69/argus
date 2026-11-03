import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getEvaluationComparisons, getEvaluationComparison, runEvaluationComparison, cancelEvaluationComparison } from '../api';
import type { AgentSummary, EvaluationDataset, EvaluationComparisonDetail } from '../types';
import { ErrorState, LoadingState } from './Ui';
import { EvaluationComparisonDialog } from './EvaluationComparisonDialog';
import { EvaluationAnswerComparison } from './EvaluationAnswerComparison';
import { EvaluationExportButtons } from './EvaluationExportButtons';
import { EvaluationReleasePanel } from './EvaluationReleasePanel';
import { AgentPromptWorkbench,type PromptComparisonPreset } from './AgentPromptWorkbench';
import { PromptReleasePanel } from './PromptReleasePanel';
import { AgentSkillWorkbench,type SkillComparisonPreset } from './AgentSkillWorkbench';
import { SkillReleasePanel } from './SkillReleasePanel';

type Props={ datasets:EvaluationDataset[]; agents:AgentSummary[];
  onSelectExperiment:(id:number)=>void };

function ComparisonControls({ detail,onChanged,onSelectExperiment }:{ detail:EvaluationComparisonDetail; onChanged:()=>Promise<void>; onSelectExperiment:(id:number)=>void }) {
  const [acknowledged,setAcknowledged]=useState(false);
  // Retain the key after a network error: repeating a click must not repeat dispatch.
  const [requestId]=useState(() => crypto.randomUUID());
  const [cancelId]=useState(() => crypto.randomUUID());
  const run=useMutation({ mutationFn:runEvaluationComparison,onSuccess:onChanged });
  const cancel=useMutation({ mutationFn:cancelEvaluationComparison,onSuccess:onChanged });
  const c=detail.comparison, s=detail.summary;
  const needsReview=detail.records.some(r => !['queued','completed'].includes(r.experiment.status));
  const busy=run.isPending || cancel.isPending;
  return <div className="evaluation-comparison-detail">
    <div className="panel-heading"><h3>{c.name} · #{c.id}</h3><span className={`evaluation-status is-${c.status}`}>{c.status}</span></div>
    <p role="status">{s.completed_steps} / {s.total_steps} experiments completed · Overall gate: <strong>{s.comparison_state}</strong></p>
    {c.stop_reason && <p role="status">Stopped: <code>{c.stop_reason}</code>. Inspect the experiments below. For access or routing changes, restore the authorized target or save a new comparison; no fallback target was used.</p>}
    <p>{c.order_mode==='alternating' ? 'Alternating by round: A → B, then B → A.' : 'Baseline first in every round: A → B.'} Each experiment runs the complete dataset.</p>
    <p>{s.planned_requests} planned requests · {s.remaining_requests} unstarted requests · Cost coverage {s.cost_coverage.measured}/{s.cost_coverage.total} attempts · Known subtotal ${s.cost_coverage.known_subtotal_usd.toFixed(6)} (catalog estimate; missing costs are unknown).</p>
    {['queued','running'].includes(c.status) && <button className="button button-secondary" disabled={busy || c.cancel_requested}
      onClick={() => cancel.mutate({ id:c.id,requestId:cancelId })}>{c.cancel_requested ? 'Comparison cancellation requested…' : 'Cancel comparison'}</button>}
    {!['running','completed'].includes(c.status) && <>
      {needsReview ? <p role="status">This series needs review. Open the stopped experiment below, inspect its history and explicitly retry eligible technical cases. Resume never repeats requests automatically.</p> : <fieldset className="evaluation-retry-options"><legend>{c.status==='queued' ? 'Start saved comparison' : 'Resume saved comparison'}</legend>
        <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />
          <span>I authorize {s.remaining_requests} new provider requests. API charges or subscription quota apply according to the selected targets; retries are separate.</span></label>
        <button className="button button-primary" disabled={busy || !acknowledged} onClick={() => run.mutate({ id:c.id,requestId })}>
          {run.isPending ? 'Starting comparison…' : c.status==='queued' ? 'Start comparison' : 'Resume comparison'}</button>
      </fieldset>}
    </>}
    {c.status==='running' && <p>Only one experiment runs at a time. Technical failures stop the series; failed quality assertions remain evidence and do not trigger a retry.</p>}
    {(run.error || cancel.error) && <ErrorState error={(run.error || cancel.error) as Error} />}
    <ol className="evaluation-comparison-steps" aria-label="Comparison execution order">
      {detail.records.map(r => <li key={r.position}><span>Round {r.round} · {r.variant==='baseline' ? 'A · Baseline' : 'B · Candidate'}</span>
        <code>{r.experiment.model_ref}</code><span className={`evaluation-status is-${r.experiment.status}`}>{r.experiment.status}</span>
        <button className="button button-ghost" onClick={() => onSelectExperiment(r.experiment.id)}>Inspect experiment #{r.experiment.id}</button></li>)}
    </ol>
    <div className="evaluation-comparison-rounds">{s.rounds.map(r => <p key={r.round}>Round {r.round}: <strong>{r.evidence?.comparison_state ?? 'inconclusive'}</strong>
      {r.evidence?.result ? ` · score difference ${r.evidence.result.scoreDelta.toFixed(4)}` : ' · waiting for complete paired evidence'}</p>)}</div>
    <small>{s.note}</small>
    <EvaluationExportButtons id={c.id} complete={c.status==='completed' && ['passed','failed'].includes(s.comparison_state)} />
    {c.status==='completed' && (detail.records.some(r=>r.variant==='candidate' && r.experiment.configuration_snapshot?.['prompt_revision'])
      ? <PromptReleasePanel key={c.id} id={c.id} passed={s.comparison_state==='passed'} />
      : detail.records.some(r=>r.variant==='candidate' && r.experiment.configuration_snapshot?.['skill_revision'])
      ? <SkillReleasePanel key={c.id} id={c.id} passed={s.comparison_state==='passed'} />
      : <EvaluationReleasePanel key={c.id} id={c.id} passed={s.comparison_state==='passed'} />)}
    <EvaluationAnswerComparison detail={detail} />
  </div>;
}

export function EvaluationComparisonPanel({ datasets,agents,onSelectExperiment }:Props) {
  const client=useQueryClient();
  const [showForm,setShowForm]=useState(false);
  const [promptPreset,setPromptPreset]=useState<PromptComparisonPreset|undefined>();
  const [skillPreset,setSkillPreset]=useState<SkillComparisonPreset|undefined>();
  const [params,setParams]=useSearchParams();
  const raw=params.get('comparison'),parsed=Number(raw);
  const selected=raw && /^\d+$/.test(raw) && Number.isSafeInteger(parsed) && parsed>0 ? parsed : null;
  const setSelected=(id:number|null) => setParams(previous => { const next=new URLSearchParams(previous); if (id) next.set('comparison',String(id)); else next.delete('comparison'); return next; });
  const comparisons=useQuery({ queryKey:['evaluation-comparisons'],queryFn:getEvaluationComparisons,
    refetchInterval:q => q.state.data?.comparisons.some(c => c.status==='running') ? 3000 : false });
  const detail=useQuery({ queryKey:['evaluation-comparison',selected],queryFn:() => getEvaluationComparison(selected!),enabled:selected!==null,
    refetchInterval:q => q.state.data?.comparison.status==='running' || q.state.data?.records.some(r => r.experiment.status==='running') ? 3000 : false });
  const refresh=async () => { await Promise.all([
    client.invalidateQueries({ queryKey:['evaluation-comparisons'] }),client.invalidateQueries({ queryKey:['evaluation-comparison'] }),
    client.invalidateQueries({ queryKey:['evaluation-experiments'] }),client.invalidateQueries({ queryKey:['evaluation-experiment'] }),
  ]); };
  return <section className="panel evaluation-comparisons" aria-label="Paired comparisons">
    <div className="panel-heading"><div><span className="eyebrow">PAIRED EVALUATIONS</span><h2>Baseline vs candidate</h2></div>
      <button className="button button-primary" aria-expanded={showForm} onClick={() => { setPromptPreset(undefined);setSkillPreset(undefined);setShowForm(!showForm); }}>{showForm ? 'Close comparison form' : 'New paired comparison'}</button></div>
    <p>Freeze A and B together. Repeat the same cases with controlled order. Saving is token-free; execution is a separate, explicit step.</p>
    <AgentPromptWorkbench agents={agents} onCompare={preset=>{ setSkillPreset(undefined);setPromptPreset(preset);setShowForm(true); }} />
    <AgentSkillWorkbench agents={agents} onCompare={preset=>{ setPromptPreset(undefined);setSkillPreset(preset);setShowForm(true); }} />
    {showForm && <EvaluationComparisonDialog promptPreset={promptPreset} skillPreset={skillPreset} datasets={datasets} agents={agents} onClose={() => setShowForm(false)} onCreated={async id => { setSelected(id); await refresh(); }} />}
    {comparisons.isLoading && <LoadingState label="Loading comparisons…" />}
    {comparisons.error && <ErrorState error={comparisons.error} />}
    {comparisons.data && !comparisons.data.comparisons.length && <p>No comparisons yet. Create and activate a test set below, then choose two configurations.</p>}
    {!!comparisons.data?.comparisons.length && <label className="editor-field"><span>Saved comparison</span><select value={selected ?? ''} onChange={e => setSelected(Number(e.target.value) || null)}><option value="">Choose comparison</option>
      {comparisons.data.comparisons.map(c => <option key={c.id} value={c.id}>#{c.id} · {c.name} · {c.status}</option>)}</select></label>}
    {selected && detail.isLoading && <LoadingState label="Loading comparison evidence…" />}
    {detail.error && <ErrorState error={detail.error} />}
    {detail.data && <ComparisonControls key={`${selected}:${detail.data.comparison.status}:${detail.data.comparison.started_at}`} detail={detail.data} onChanged={refresh} onSelectExperiment={onSelectExperiment} />}
  </section>;
}
