import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getEvaluationDataset } from '../api';
import type { EvaluationAssertion, EvaluationComparisonDetail, EvaluationExperimentDetail, EvaluationResult } from '../types';
import { ErrorState, LoadingState } from './Ui';

type RecordDetail=EvaluationComparisonDetail['records'][number];
const pretty=(value:unknown):string => value==null ? 'Not supplied' : typeof value==='string' ? value : JSON.stringify(value,null,2);
const metric=(value:unknown,suffix='') => value==null || !Number.isFinite(Number(value)) ? 'Unknown' : `${Number(value)}${suffix}`;
export function currentEvaluationResult(record:EvaluationExperimentDetail|undefined,caseId:number):EvaluationResult|undefined {
  const results=record?.results.filter(r => r.case_id===caseId) ?? [];
  const newest=Math.max(0,...results.map(r => r.attempt ?? 1),...(record?.attempts?.filter(a => a.case_id===caseId).map(a => a.attempt) ?? []));
  return results.find(r => (r.attempt ?? 1)===newest);
}
function criterion(a:EvaluationAssertion) {
  if (a.type==='json_object') return `JSON object${a.required.length ? ` with fields: ${a.required.join(', ')}` : ''}`;
  if (a.type==='json_field_equals') return `JSON field ${a.path.join('.')} equals ${JSON.stringify(a.value)}`;
  return `${{ text_equals:'Exactly equals',text_includes:'Contains',text_excludes:'Does not contain' }[a.type]} ${JSON.stringify(a.value)}`;
}
function Answer({ label,record,caseId,rules }:{ label:string; record:RecordDetail|undefined; caseId:number; rules:EvaluationAssertion[] }) {
  const result=currentEvaluationResult(record,caseId);
  const execution=record?.experiment.configuration_snapshot?.execution as Record<string,unknown>|undefined;
  const judgement=result?.evidence?.judgement as { assertions?:Array<{ index:number; passed:boolean; reason:string }> }|undefined;
  const trace=result?.trace_id ?? record?.attempts?.find(a => a.case_id===caseId && a.attempt===result?.attempt)?.trace_id;
  return <article className="evaluation-answer" aria-label={label}>
    <div className="panel-heading"><h4>{label}</h4><span className={`evaluation-status is-${result?.status ?? 'queued'}`}>{result?.status ?? 'No recorded answer'}</span></div>
    <p className="evaluation-muted">{String(execution?.effective_model ?? record?.experiment.model_ref ?? 'Unavailable')}{record && ` · Experiment #${record.experiment.id}`}</p>
    {result ? <>
      <div className="evaluation-answer-metrics"><span>Score <b>{metric(result.scores.overall==null ? null : Math.round(result.scores.overall*100),'%')}</b></span><span>Duration <b>{metric(result.latency_ms,' ms')}</b></span><span>Tokens in / out <b>{metric(result.input_tokens)} / {metric(result.output_tokens)}</b></span><span>Estimated cost <b>{result.cost_usd==null ? 'Unknown' : `$${Number(result.cost_usd).toFixed(6)}`}</b></span></div>
      {result.error_message && <p className="editor-error">{result.error_message}</p>}
      <h5>Answer · Attempt {result.attempt}</h5><pre>{pretty(result.output_redacted)}</pre>
      <h5>Criteria</h5><ul className="evaluation-check-list">{rules.map((rule,i) => {
        const check=judgement?.assertions?.find(a => a.index===i);
        return <li key={i}><strong>{!check ? 'Not evaluated' : check.passed ? 'Passed' : 'Failed'}</strong><span>{criterion(rule)}</span>{check && !check.passed && <small>{check.reason.replaceAll('_',' ')}</small>}</li>;
      })}</ul>
      {!rules.length && <p>Criteria unavailable; inspect the stored experiment evidence.</p>}
      {trace && <a href={`/observe/logs?trace=${encodeURIComponent(trace)}`}>Open correlated trace logs</a>}
    </> : <p role="status">{record?.experiment.status==='running' ? 'Waiting for this case. Progress updates automatically.' : 'No result for the latest attempt. Pending, interrupted or unstarted work is not a passing answer.'}</p>}
  </article>;
}

export function EvaluationAnswerComparison({ detail }:{ detail:EvaluationComparisonDetail }) {
  const dataset=useQuery({ queryKey:['evaluation-dataset',detail.comparison.dataset_id],queryFn:() => getEvaluationDataset(detail.comparison.dataset_id),staleTime:30000 });
  const [round,setRound]=useState(1),[chosen,setChosen]=useState('');
  const a=detail.records.find(r => r.round===round && r.variant==='baseline'),b=detail.records.find(r => r.round===round && r.variant==='candidate');
  const cases=dataset.data?.cases ?? [];
  const selected=cases.find(c => c.id===Number(chosen)) ?? cases[0];
  return <section className="evaluation-answer-comparison" aria-label="Answers side by side">
    <div className="panel-heading"><div><span className="eyebrow">CASE EVIDENCE</span><h3>Answers side by side</h3></div></div>
    {dataset.isLoading && <LoadingState label="Loading frozen cases…" />}
    {dataset.error && <ErrorState error={dataset.error} />}
    {selected && <>
      <div className="policy-field-grid"><label className="editor-field"><span>Comparison round</span><select value={round} onChange={e => setRound(Number(e.target.value))}>{Array.from({ length:detail.comparison.repetitions },(_,i) => <option key={i} value={i+1}>Round {i+1}</option>)}</select></label>
        <label className="editor-field"><span>Compared case</span><select value={selected.id} onChange={e => setChosen(e.target.value)}>{cases.map(c => <option key={c.id} value={c.id}>{c.case_key}</option>)}</select></label></div>
      <details className="evaluation-case-reference" open><summary>Task and reference context</summary><h5>Task</h5><pre>{pretty(selected.input_redacted)}</pre>
        {selected.context_redacted!=null && <><h5>Reference context</h5><pre>{pretty(selected.context_redacted)}</pre></>}
        {selected.expected_output!=null && <><h5>Reviewer reference (not sent to the model)</h5><pre>{pretty(selected.expected_output)}</pre></>}
      </details>
      <div className="evaluation-ab-grid"><Answer label="A · Baseline answer" record={a} caseId={selected.id} rules={selected.rules?.assertions ?? []} /><Answer label="B · Candidate answer" record={b} caseId={selected.id} rules={selected.rules?.assertions ?? []} /></div>
      <p className="evaluation-muted">Latest attempt per case. Individual answer costs are catalog estimates; the series totals above include earlier attempts and unknown costs. A small test set does not establish general model superiority.</p>
    </>}
  </section>;
}
