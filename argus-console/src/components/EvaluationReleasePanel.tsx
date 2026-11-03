import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { confirmExecutionChange,getExecutionReleases,previewExecutionChange,type ExecutionReleasePreview } from '../api';
import { ErrorState,LoadingState } from './Ui';

export function EvaluationReleasePanel({ id,passed }:{ id:number;passed:boolean }) {
  const client=useQueryClient();
  const [review,setReview]=useState<{ id:number;rollback:boolean;preview:ExecutionReleasePreview }|null>(null);
  const [reason,setReason]=useState(''),[ack,setAck]=useState(false),[key,setKey]=useState(() => crypto.randomUUID());
  const history=useQuery({ queryKey:['execution-releases',id],queryFn:()=>getExecutionReleases(id),retry:false });
  const preview=useMutation({ mutationFn:({ target,rollback }:{ target:number;rollback:boolean })=>previewExecutionChange(target,rollback),
    onSuccess:(data,variables)=>{ setReview({ id:variables.target,rollback:variables.rollback,preview:data });setReason('');setAck(false);setKey(crypto.randomUUID()); } });
  const confirm=useMutation({ mutationFn:confirmExecutionChange,onSuccess:async()=>{
    setReview(null);await Promise.all([client.invalidateQueries({ queryKey:['execution-releases',id] }),client.invalidateQueries({ queryKey:['agents'] })]);
  } });
  const busy=preview.isPending || confirm.isPending;
  const start=(target:number,rollback=false)=>{ setReview(null);confirm.reset();preview.mutate({ target,rollback }); };
  return <section className="evaluation-export-controls" aria-label="Controlled execution release">
    <div className="panel-heading"><h4>Controlled execution release</h4><button className="button button-secondary" disabled={!passed || busy} onClick={()=>start(id)}>Review execution release</button></div>
    <p>Explicitly adopt B’s model/runtime for Agent A after a passing comparison. Matching prompt, Skills, parameters and policies are required. Same-model repeatability tests have nothing to release.</p>
    <small>No automatic activation, model calls or four-eyes approval. Existing tools, Knowledge and permissions are not changed. New runs only.</small>
    {!passed && <p>Complete all rounds with a passing gate first.</p>}
    {preview.isPending && <LoadingState label="Checking evidence and current Agent configuration…" />}
    {preview.error && <ErrorState error={preview.error} />}
    {review && <fieldset className="evaluation-release-review" disabled={busy}>
      <legend>{review.rollback ? 'Review rollback' : 'Review release'} · Agent #{review.preview.agent_id}</legend>
      <div className="evaluation-release-diff">
        <div><strong>Current</strong><p>{review.preview.before_target ?? review.preview.before_settings.model}</p><small>Model alias: {review.preview.before_settings.model}</small><small>Runtime profile: {review.preview.before_settings.runtime_profile_id ?? 'Direct API'}{review.preview.before_reasoning ? ` · ${review.preview.before_reasoning}` : ''}</small></div>
        <div><strong>After confirmation</strong><p>{review.preview.after_target ?? review.preview.after_settings.model}</p><small>Model alias: {review.preview.after_settings.model}</small><small>Runtime profile: {review.preview.after_settings.runtime_profile_id ?? 'Direct API'}{review.preview.after_reasoning ? ` · ${review.preview.after_reasoning}` : ''}</small></div>
      </div>
      <p>{review.preview.limitation}</p>
      <label className="editor-field"><span>Decision reason (at least 8 characters)</span><textarea value={reason} maxLength={2000} onChange={e=>{ setReason(e.target.value);setKey(crypto.randomUUID());confirm.reset(); }} /></label>
      <label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} /> I reviewed the change and authorize it for new Agent runs.</label>
      <div className="evaluation-export-actions"><button className="button button-primary" disabled={!ack || reason.trim().length<8 || busy} onClick={()=>confirm.mutate({ id:review.id,rollback:review.rollback,requestId:key,input:{ preview_sha256:review.preview.preview_sha256,reason:reason.trim(),confirm:true } })}>{confirm.isPending ? 'Saving decision…' : review.rollback ? 'Confirm rollback with MFA' : 'Confirm release with MFA'}</button>
        <button className="button button-secondary" onClick={()=>{ setReview(null);confirm.reset(); }}>Cancel review</button></div>
    </fieldset>}
    {confirm.error && <ErrorState error={confirm.error} />}
    {(confirm.error as { code?:string }|null)?.code==='MFA_STEP_UP_REQUIRED' && <a className="button button-secondary" href={`/auth/oidc/step-up?returnTo=${encodeURIComponent(`/build/evaluations?comparison=${id}`)}`}>Confirm MFA and return to comparison</a>}
    {confirm.isSuccess && <p role="status">Decision saved and audited. The Agent’s execution choice was updated; no model was called.</p>}
    {history.isLoading && <LoadingState label="Loading release history…" />}
    {history.error && <ErrorState error={history.error} />}
    {history.data && !history.data.releases.length && <p>No execution releases for this comparison.</p>}
    {!!history.data?.releases.length && <ol className="evaluation-release-history">{history.data.releases.map(r=><li key={r.id}>
      <strong>#{r.id} · {r.action==='applied' ? 'Released' : `Rolled back #${r.source_release_id}`} · Agent #{r.agent_id}</strong>
      <small>{new Date(r.created_at).toLocaleString()} · User #{r.actor_user_id}</small><p>{r.reason}</p>
      <small>{r.before_settings.model} (profile {r.before_settings.runtime_profile_id ?? 'API'}) → {r.after_settings.model} (profile {r.after_settings.runtime_profile_id ?? 'API'})</small>
      {r.action==='applied' && !history.data.releases.some(other=>other.source_release_id===r.id) && <button className="button button-secondary" disabled={busy} onClick={()=>start(r.id,true)}>Review rollback #{r.id}</button>}
    </li>)}</ol>}
  </section>;
}
