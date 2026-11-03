import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { confirmPromptChange,getPromptReleases,previewPromptChange,type PromptReleasePreview } from '../api';
import { ErrorState,LoadingState } from './Ui';
import { PromptDiff } from './AgentPromptWorkbench';

export function PromptReleasePanel({ id,passed }:{ id:number;passed:boolean }) {
  const client=useQueryClient();
  const [review,setReview]=useState<{ id:number;rollback:boolean;preview:PromptReleasePreview }|null>(null);
  const [reason,setReason]=useState(''),[ack,setAck]=useState(false),[key,setKey]=useState(()=>crypto.randomUUID());
  const history=useQuery({ queryKey:['prompt-releases',id],queryFn:()=>getPromptReleases(id),retry:false });
  const preview=useMutation({ mutationFn:({ target,rollback }:{ target:number;rollback:boolean })=>previewPromptChange(target,rollback),onSuccess:(data,v)=>{ setReview({ id:v.target,rollback:v.rollback,preview:data });setReason('');setAck(false);setKey(crypto.randomUUID()); } });
  const confirm=useMutation({ mutationFn:confirmPromptChange,onSuccess:async()=>{ setReview(null);await Promise.all([
    client.invalidateQueries({ queryKey:['prompt-releases',id] }),client.invalidateQueries({ queryKey:['agent-prompt'] }),client.invalidateQueries({ queryKey:['agents'] }),
  ]); } });
  const busy=preview.isPending || confirm.isPending;
  const start=(target:number,rollback=false)=>{ setReview(null);confirm.reset();preview.mutate({ target,rollback }); };
  return <section className="evaluation-export-controls prompt-release-panel" aria-label="Controlled prompt release">
    <div className="panel-heading"><h4>Controlled prompt release</h4><button className="button button-secondary" disabled={!passed || busy} onClick={()=>start(id)}>Review prompt release</button></div>
    <p>Only the tested system prompt is adopted. No automatic activation or independent reviewer approval. Existing running turns and historical evidence stay unchanged.</p>
    {!passed && <p>Complete all rounds with a passing gate first.</p>}
    {preview.isPending && <LoadingState label="Checking prompt evidence and current Agent…" />}
    {preview.error && <ErrorState error={preview.error} />}
    {review && <fieldset className="evaluation-release-review" disabled={busy}>
      <legend>{review.rollback ? 'Review prompt rollback' : 'Review prompt release'} · Agent #{review.preview.agent_id}</legend>
      <PromptDiff before={review.preview.before_prompt} after={review.preview.after_prompt} /><p>{review.preview.limitation}</p>
      <label className="editor-field"><span>Prompt decision reason (at least 8 characters)</span><textarea value={reason} maxLength={2000} onChange={e=>{ setReason(e.target.value);setKey(crypto.randomUUID());confirm.reset(); }} /></label>
      <label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} /> I reviewed this prompt change and authorize it for new runs.</label>
      <div className="evaluation-export-actions"><button className="button button-primary" disabled={!ack || reason.trim().length<8} onClick={()=>confirm.mutate({ id:review.id,rollback:review.rollback,requestId:key,input:{ preview_sha256:review.preview.preview_sha256,reason:reason.trim(),confirm:true } })}>{confirm.isPending ? 'Saving decision…' : review.rollback ? 'Confirm prompt rollback with MFA' : 'Confirm prompt release with MFA'}</button>
        <button className="button button-secondary" onClick={()=>{ setReview(null);confirm.reset(); }}>Cancel prompt review</button></div>
    </fieldset>}
    {confirm.error && <ErrorState error={confirm.error} />}
    {(confirm.error as { code?:string }|null)?.code==='MFA_STEP_UP_REQUIRED' && <a className="button button-secondary" href={`/auth/oidc/step-up?returnTo=${encodeURIComponent(`/build/evaluations?comparison=${id}`)}`}>Confirm MFA and return to comparison</a>}
    {confirm.isSuccess && <p role="status">Prompt decision saved and audited. No model was called.</p>}
    {history.isLoading && <LoadingState label="Loading prompt decisions…" />}
    {history.error && <ErrorState error={history.error} />}
    {history.data && !history.data.releases.length && <p>No prompt releases for this comparison.</p>}
    <ol className="evaluation-release-history">{history.data?.releases.map(r=><li key={r.id}>
      <strong>#{r.id} · {r.action==='applied' ? `Prompt #${r.revision_id} released` : `Prompt rollback of #${r.source_release_id}`}</strong>
      <small>{new Date(r.created_at).toLocaleString()} · User #{r.actor_user_id}</small><p>{r.reason}</p>
      {r.action==='applied' && !history.data.releases.some(other=>other.source_release_id===r.id) && <button className="button button-secondary" disabled={busy} onClick={()=>start(r.id,true)}>Review prompt rollback #{r.id}</button>}
    </li>)}</ol>
  </section>;
}
