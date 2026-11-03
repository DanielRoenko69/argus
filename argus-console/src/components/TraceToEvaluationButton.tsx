import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { addEvaluationCaseFromTrace, createEvaluationDataset, getEvaluationDatasets, getConsoleUser, previewEvaluationTrace } from '../api';
import { isPlatformAdminRole } from '../access';
import { ErrorState, LoadingState } from './Ui';
import { EvaluationCaseEditor } from './EvaluationCaseEditor';
import { EvaluationCurationDialog } from './EvaluationCurationDialog';

const pretty=(v:unknown) => v==null ? '' : typeof v==='string' ? v : JSON.stringify(v,null,2);
function TraceCaseDialog({ traceId,spanId,onClose }:{ traceId:string; spanId:string|null; onClose:()=>void }) {
  const client=useQueryClient();
  const [datasetId,setDatasetId]=useState(''),[created,setCreated]=useState<{ datasetId:number; caseId:number }|null>(null);
  const [draftName,setDraftName]=useState('Trace regression checks');
  const [identity,setIdentity]=useState<{ json:string; key:string }|null>(null);
  const preview=useQuery({ queryKey:['evaluation-trace-preview',traceId,spanId],queryFn:() => previewEvaluationTrace({ trace_id:traceId,span_id:spanId }),
    staleTime:Infinity,gcTime:0,retry:false,refetchOnWindowFocus:false,refetchOnReconnect:false });
  const datasets=useQuery({ queryKey:['evaluation-datasets'],queryFn:getEvaluationDatasets });
  const draft=useMutation({ mutationFn:createEvaluationDataset,onSuccess:async r => { setDatasetId(String(r.dataset.id)); await client.invalidateQueries({ queryKey:['evaluation-datasets'] }); } });
  const save=useMutation({ mutationFn:addEvaluationCaseFromTrace,onSuccess:async (r,v) => {
    setCreated({ datasetId:v.datasetId,caseId:r.case.id });
    await Promise.all([client.invalidateQueries({ queryKey:['evaluation-datasets'] }),client.invalidateQueries({ queryKey:['evaluation-dataset',v.datasetId] })]);
  } });
  const drafts=datasets.data?.datasets.filter(d => d.status==='draft' && d.contract_version===1) ?? [];
  const busy=save.isPending || draft.isPending;
  return <EvaluationCurationDialog title="Add trace as test case" busy={busy} onClose={onClose}>
    {created ? <section role="status"><h3>Test case saved as draft</h3><p>Case #{created.caseId}. No evaluation was started. Review the test set and activate it when ready.</p><a className="button button-primary" href={`/build/evaluations?dataset=${created.datasetId}`}>Open test set</a></section> : <>
      {preview.isLoading && <LoadingState label="Preparing redacted trace preview…" />}{preview.error && <ErrorState error={preview.error} />}
      {preview.data && <>
        <p className="connection-notice">{preview.data.warning}</p>
        <p>Source: <code>{traceId}</code>{spanId && <> · Span <code>{spanId}</code></>} · {preview.data.status}</p>
        <details className="evaluation-observed-answer"><summary>Observed answer — reference only, not ground truth</summary><pre>{pretty(preview.data.observed_output) || 'No output preview recorded.'}</pre></details>
        <p>Only the selected trace/span input is prefilled. Supply a self-contained task, independent expected behavior and any necessary reference context. Recorded tool calls will not be replayed.</p>
        {datasets.isLoading && <LoadingState label="Loading draft test sets…" />}{datasets.error && <ErrorState error={datasets.error} />}
        <label className="editor-field"><span>Destination draft test set</span><select value={datasetId} disabled={busy} onChange={e => { setDatasetId(e.target.value); save.reset(); }}><option value="">Choose a draft</option>{drafts.map(d => <option key={d.id} value={d.id}>{d.name} · v{d.version}</option>)}</select></label>
        <details><summary>Create a new empty draft</summary><label className="editor-field"><span>New draft name</span><input maxLength={240} value={draftName} disabled={busy} onChange={e => setDraftName(e.target.value)} /></label>
          <button className="button button-secondary" disabled={busy || !draftName.trim()} onClick={() => draft.mutate({ dataset_key:`trace-regression-${crypto.randomUUID()}`,version:1,name:draftName.trim(),description:'Human-curated cases from redacted trace previews.' })}>Create empty draft</button>
        </details>
        {draft.error && <ErrorState error={draft.error} />}{save.error && <ErrorState error={save.error} />}
        {drafts.some(d => String(d.id)===datasetId) && <EvaluationCaseEditor key={`${datasetId}:${preview.data.preview_sha256}`} datasetId={Number(datasetId)} saving={busy} requireReview submitLabel="Save reviewed test case"
          initial={{ caseKey:`trace-${(spanId || traceId).slice(0,8)}`,task:pretty(preview.data.input) }} onSave={(id,input) => {
            // Advanced JSON may change task/rules, never source identity or review metadata.
            const body={ source:preview.data.source,reviewed_preview_sha256:preview.data.preview_sha256,reviewed:true,
              case:{ case_key:input.case_key,input:input.input,context:input.context,expected_output:input.expected_output,rules:input.rules } };
            const json=JSON.stringify({ id,body }),requestId=identity?.json===json ? identity.key : crypto.randomUUID();
            setIdentity({ json,key:requestId }); save.mutate({ datasetId:id,input:body,requestId });
          }} />}
      </>}
    </>}
  </EvaluationCurationDialog>;
}

export function TraceToEvaluationButton({ traceId,spanId=null }:{ traceId:string; spanId?:string|null }) {
  const [open,setOpen]=useState(false);
  // Reuse the shell's lightweight session; never trigger the operational health dashboard just for a button.
  const session=useQuery({ queryKey:['console-session'],queryFn:getConsoleUser,staleTime:5*60_000 });
  if (!isPlatformAdminRole(session.data?.role)) return null;
  return <><button className="button button-secondary" type="button" onClick={() => setOpen(true)}><FlaskConical size={14} />{spanId ? 'Add span as test case' : 'Add as test case'}</button>
    {open && <TraceCaseDialog key={`${traceId}:${spanId}`} traceId={traceId} spanId={spanId} onClose={() => setOpen(false)} />}</>;
}
