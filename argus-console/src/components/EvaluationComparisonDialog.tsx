import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { createEvaluationComparison, getEvaluationTargets, preflightEvaluationComparison } from '../api';
import type { AgentSummary, EvaluationDataset, EvaluationComparisonInput, EvaluationPreflight } from '../types';
import { ErrorState, LoadingState } from './Ui';
import { PromptDiff,type PromptComparisonPreset } from './AgentPromptWorkbench';
import type { SkillComparisonPreset } from './AgentSkillWorkbench';

function TargetChoice({ label,agentId,model,onChange }:{ label:string; agentId:number; model:string; onChange:(model:string)=>void }) {
  const targets=useQuery({ queryKey:['evaluation-targets',agentId],queryFn:() => getEvaluationTargets(agentId),enabled:agentId>0 });
  const runtime=!!targets.data?.agent.runtime_type && targets.data.agent.runtime_type!=='argus';
  return <>
    {targets.isLoading && <LoadingState label="Loading execution choices…" />}
    {targets.error && <ErrorState error={targets.error} />}
    {targets.data && <p className="evaluation-muted">{targets.data.agent.runtime_label} · {targets.data.agent.default_model}{targets.data.agent.reasoning_effort ? ` · ${targets.data.agent.reasoning_effort}` : ''}</p>}
    {targets.data?.blocker && <p role="status" className="connection-notice">{targets.data.blocker}</p>}
    <label className="editor-field"><span>{label} {runtime ? 'Runtime model' : 'API model'}</span><select required value={model} disabled={!agentId || targets.isLoading || !!targets.error || !!targets.data?.blocker} onChange={e => onChange(e.target.value)}>
      <option value="">{runtime ? 'Choose assigned runtime' : 'Choose API model'}</option>{targets.data?.targets.map(t => <option key={t.id} value={t.model_ref} disabled={!t.selectable}>{t.label} · {t.effective_model} · {t.provider_label}{t.reason ? ` — ${t.reason}` : ''}</option>)}
    </select></label>
    {targets.data?.targets.find(t => t.model_ref===model) && <small>Effective model: {targets.data.targets.find(t => t.model_ref===model)!.effective_model}</small>}
    {runtime && <small>{targets.data?.note}</small>}
  </>;
}

function Preview({ data }:{ data:EvaluationPreflight }) {
  return <section className="evaluation-preview" aria-label="Comparison preflight">
    <h3>Review {data.comparison_kind==='model' ? 'model comparison' : 'Agent configuration comparison'}</h3>
    <p>{data.dataset.name} · v{data.dataset.version} · {data.repetitions} rounds × 2 configurations × {data.dataset.case_count} cases = <strong>{data.planned_requests} planned provider requests</strong>.</p>
    <div className="evaluation-ab-grid">{([{ label:'A · Baseline',v:data.baseline },{ label:'B · Candidate',v:data.candidate }]).map(({ label,v }) => <article key={label}>
      <h4>{label}</h4><p>{v.agent_name}</p><b>{v.effective_model}</b><p>{v.runtime_label} · {v.skill_count} Skills</p>
      <small>{v.max_tokens===null ? `Runtime reasoning: ${String(v.reasoning_effort)} · API temperature/output settings are not applied` : `Temperature ${String(v.temperature)} · Existing output setting ${String(v.max_tokens)} tokens`}</small>
    </article>)}</div>
    <p>{data.differences.length ? `Changed: ${data.differences.map(k => ({ agent_id:'Agent',model_ref:'model alias',effective_model:'effective model',runtime_label:'runtime',prompt_sha256:'system prompt',skills_sha256:'Skills',max_tokens:'output setting',thinking_budget:'thinking setting',reasoning_effort:'reasoning',temperature:'temperature' }[k] ?? k)).join(', ')}.` : 'No configuration differences.'}</p>
    <p>Both variants use the same frozen tasks, reference context and checks. {data.order_mode==='alternating' ? 'Order alternates A→B / B→A.' : 'A runs before B in every round.'}</p>
    {data.warnings.map(w => <p key={w} className="evaluation-muted">{w}</p>)}
  </section>;
}

export function EvaluationComparisonDialog({ datasets,agents,onClose,onCreated,promptPreset,skillPreset }:{ datasets:EvaluationDataset[]; agents:AgentSummary[]; onClose:()=>void; onCreated:(id:number)=>Promise<void>;promptPreset?:PromptComparisonPreset;skillPreset?:SkillComparisonPreset }) {
  const dialog=useRef<HTMLDialogElement>(null);
  const preset=promptPreset ?? skillPreset;
  const [name,setName]=useState(preset ? `${skillPreset ? 'Skill' : 'Prompt'} #${preset.revision.id} vs active` : 'Baseline vs candidate'),[datasetId,setDatasetId]=useState('');
  const [aAgent,setAAgent]=useState(preset ? String(preset.agentId) : ''),[bAgent,setBAgent]=useState(preset ? String(preset.agentId) : ''),[aModel,setAModel]=useState(preset?.modelRef ?? ''),[bModel,setBModel]=useState(preset?.modelRef ?? '');
  const [repetitions,setRepetitions]=useState(1),[order,setOrder]=useState<'alternating'|'baseline_first'>('alternating');
  const [requestId,setRequestId]=useState(() => crypto.randomUUID());
  const [review,setReview]=useState<{ input:EvaluationComparisonInput; data:EvaluationPreflight }|null>(null);
  const preview=useMutation({ mutationFn:preflightEvaluationComparison,onSuccess:(data,input) => setReview({ data,input }) });
  const save=useMutation({ mutationFn:createEvaluationComparison,onSuccess:async d => { await onCreated(d.comparison.id); onClose(); } });
  const busy=preview.isPending || save.isPending;
  useEffect(() => {
    const before=document.activeElement as HTMLElement|null,el=dialog.current!;
    if (el.showModal) el.showModal(); else el.setAttribute('open','');
    return () => { el.close?.(); before?.focus(); };
  },[]);
  useEffect(() => { if (review) dialog.current?.querySelector<HTMLElement>('h2')?.focus(); },[review]);
  const dataset=datasets.find(d => d.id===Number(datasetId));
  const aId=Number(aAgent || dataset?.agent_id || 0),bId=Number(bAgent || dataset?.agent_id || 0);
  const valid=!!name.trim() && !!dataset && !!aId && !!bId && !!aModel && !!bModel && Number.isInteger(repetitions) && repetitions>=1 && repetitions<=10;
  const submit=(event:FormEvent) => {
    event.preventDefault();
    if (review) save.mutate({ requestId,input:{ ...review.input,reviewed_preflight_sha256:review.data.preflight_sha256 } });
    else if (valid) preview.mutate({ name:name.trim(),dataset_id:dataset!.id,baseline:{ agent_id:aId,model_ref:aModel },candidate:{ agent_id:bId,model_ref:bModel,...(promptPreset ? { prompt_revision_id:promptPreset.revision.id } : skillPreset ? { skill_revision_id:skillPreset.revision.id } : {}) },repetitions,order_mode:order });
  };
  return <dialog ref={dialog} className="evaluation-dialog" aria-labelledby="evaluation-dialog-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={e => {
      if (e.key!=='Tab') return;
      const controls=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]'))
        .filter(el => el.tabIndex>=0 && !el.hasAttribute('disabled') && el.getClientRects().length>0 && !el.closest('fieldset[disabled]'));
      const first=controls[0],last=controls.at(-1),active=document.activeElement;
      if (first && last && ((e.shiftKey && active===first) || (!e.shiftKey && active===last) || !controls.includes(active as HTMLElement))) {
        e.preventDefault(); (e.shiftKey ? last : first).focus();
      }
    }}>
    <form onSubmit={submit}>
      <header className="editor-header"><div><span className="eyebrow">{review ? '2 / 2 · REVIEW' : '1 / 2 · CONFIGURE'}</span><h2 id="evaluation-dialog-title" tabIndex={-1}>Create comparison</h2></div><button className="editor-close" type="button" disabled={busy} aria-label="Close comparison" onClick={onClose}><X size={18} /></button></header>
      <div className="evaluation-dialog-body">
        <p>Compare answers on the same tasks. Saving uses no model tokens; starting the saved comparison is a separate action.</p>
        {!datasets.length && <p role="status">Create a test set, add criteria and activate it below before creating a comparison.</p>}
        {review ? <Preview data={review.data} /> : <fieldset disabled={busy} className="evaluation-fields" onChange={() => { setRequestId(crypto.randomUUID()); preview.reset(); save.reset(); }}>
          <label className="editor-field"><span>Comparison name</span><input autoFocus required maxLength={240} value={name} onChange={e => setName(e.target.value)} /></label>
          <label className="editor-field"><span>Comparison dataset</span><select required value={datasetId} onChange={e => { setDatasetId(e.target.value); if (!preset) { setAModel(''); setBModel(''); } }}><option value="">Choose active test set</option>{datasets.map(d => <option key={d.id} value={d.id}>{d.name} · v{d.version} · {d.case_count} cases</option>)}</select></label>
          {skillPreset ? <><p>Skill-only comparison · Agent #{skillPreset.agentId} · {skillPreset.modelRef}. Both sides keep the current prompt, model and other Skills.</p><PromptDiff before={skillPreset.before} after={skillPreset.revision.content} /></> : promptPreset ? <><p>Prompt-only comparison · Agent #{promptPreset.agentId} · {promptPreset.modelRef}. Both sides keep the current execution target and Skills.</p><PromptDiff before={promptPreset.revision.source_prompt} after={promptPreset.revision.system_prompt} /></> : <div className="evaluation-ab-grid">{[{ label:'A · Baseline',id:aId,agent:aAgent,model:aModel,setAgent:setAAgent,setModel:setAModel },{ label:'B · Candidate',id:bId,agent:bAgent,model:bModel,setAgent:setBAgent,setModel:setBModel }].map(v => <article key={v.label}>
            <h3>{v.label}</h3><label className="editor-field"><span>{v.label} Agent</span><select value={v.agent} onChange={e => { v.setAgent(e.target.value); v.setModel(''); }}><option value="">{dataset?.agent_id ? 'Dataset default Agent' : 'Choose Agent'}</option>{agents.map(a => <option key={a.id} value={a.id}>{a.label || a.name}</option>)}</select></label>
            <TargetChoice key={v.id} label={v.label} agentId={v.id} model={v.model} onChange={v.setModel} />
          </article>)}</div>}
          <div className="policy-field-grid"><label className="editor-field"><span>Repetitions</span><input required type="number" min={1} max={10} value={repetitions} onChange={e => setRepetitions(Number(e.target.value))} /></label>
            <label className="editor-field"><span>Execution order</span><select value={order} onChange={e => setOrder(e.target.value as typeof order)}><option value="alternating">Alternate A→B / B→A</option><option value="baseline_first">Always A→B</option></select></label></div>
          <p>{valid ? `${repetitions*2*dataset!.case_count} planned provider requests.` : 'Choose a test set, Agents and supported execution targets.'} Two different models are optional: compare Agent configurations or repeat the same configuration. Runtime models come from the selected Agent profile.</p>
        </fieldset>}
        {(preview.error || save.error) && <ErrorState error={(preview.error || save.error) as Error} />}
      </div>
      <footer className="evaluation-dialog-footer">{review && <button type="button" className="button button-secondary" disabled={busy} onClick={() => { setReview(null); preview.reset(); save.reset(); }}>Back to configuration</button>}
        <button type="submit" className="button button-primary" disabled={busy || (!review && !valid)}>{save.isPending ? 'Saving comparison…' : preview.isPending ? 'Checking configuration…' : review ? 'Save comparison' : 'Check comparison'}</button>
      </footer>
    </form>
  </dialog>;
}
