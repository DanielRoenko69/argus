import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { confirmSkillChange,getSkillReleases,previewSkillChange,type SkillReleasePreview } from '../api';
import { ErrorState,LoadingState } from './Ui';
import { PromptDiff } from './AgentPromptWorkbench';

export function SkillReleasePanel({ id,passed }:{ id:number;passed:boolean }) {
  const client=useQueryClient();
  const [review,setReview]=useState<{ id:number;rollback:boolean;preview:SkillReleasePreview }|null>(null);
  const [reason,setReason]=useState(''),[ack,setAck]=useState(false),[key,setKey]=useState(()=>crypto.randomUUID());
  const history=useQuery({ queryKey:['skill-releases',id],queryFn:()=>getSkillReleases(id),retry:false });
  const preview=useMutation({ mutationFn:({ target,rollback }:{ target:number;rollback:boolean })=>previewSkillChange(target,rollback),onSuccess:(data,v)=>{ setReview({ id:v.target,rollback:v.rollback,preview:data });setReason('');setAck(false);setKey(crypto.randomUUID()); } });
  const confirm=useMutation({ mutationFn:confirmSkillChange,onSuccess:async()=>{ setReview(null);await Promise.all([
    client.invalidateQueries({ queryKey:['skill-releases',id] }),client.invalidateQueries({ queryKey:['agent-skills'] }),client.invalidateQueries({ queryKey:['agents'] }),client.invalidateQueries({ queryKey:['agent-studio'] }),
  ]); } });
  const busy=preview.isPending || confirm.isPending;
  const start=(target:number,rollback=false)=>{ setReview(null);confirm.reset();preview.mutate({ target,rollback }); };
  return <section className="evaluation-export-controls prompt-release-panel" aria-label="Controlled Skill release">
    <div className="panel-heading"><h4>Controlled Skill release</h4><button className="button button-secondary" disabled={!passed || busy} onClick={()=>start(id)}>Review Skill release</button></div>
    <p>Only this Agent adopts the tested Skill pin. Shared Library content and other Agents stay unchanged. No automatic activation or independent reviewer approval.</p>
    {!passed && <p>Complete all rounds with a passing gate first.</p>}
    {preview.isPending && <LoadingState label="Checking Skill evidence and current pins…" />}
    {preview.error && <ErrorState error={preview.error} />}
    {review && <fieldset className="evaluation-release-review" disabled={busy}>
      <legend>{review.rollback ? 'Review Skill rollback' : 'Review Skill release'} · Agent #{review.preview.agent_id} · Skill #{review.preview.skill_id}</legend>
      <p>Version #{review.preview.previous_revision_id} → #{review.preview.revision_id}</p>
      <PromptDiff before={review.preview.before_content} after={review.preview.after_content} /><p>{review.preview.limitation}</p>
      <label className="editor-field"><span>Skill decision reason (at least 8 characters)</span><textarea value={reason} maxLength={2000} onChange={e=>{ setReason(e.target.value);setKey(crypto.randomUUID());confirm.reset(); }} /></label>
      <label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)} /> I reviewed this Skill change and authorize it for new turns of this Agent only.</label>
      <div className="evaluation-export-actions"><button className="button button-primary" disabled={!ack || reason.trim().length<8} onClick={()=>confirm.mutate({ id:review.id,rollback:review.rollback,requestId:key,input:{ preview_sha256:review.preview.preview_sha256,reason:reason.trim(),confirm:true } })}>{confirm.isPending ? 'Saving decision…' : review.rollback ? 'Confirm Skill rollback with MFA' : 'Confirm Skill release with MFA'}</button>
        <button className="button button-secondary" onClick={()=>{ setReview(null);confirm.reset(); }}>Cancel Skill review</button></div>
    </fieldset>}
    {confirm.error && <ErrorState error={confirm.error} />}
    {(confirm.error as { code?:string }|null)?.code==='MFA_STEP_UP_REQUIRED' && <a className="button button-secondary" href={`/auth/oidc/step-up?returnTo=${encodeURIComponent(`/build/evaluations?comparison=${id}`)}`}>Confirm MFA and return to comparison</a>}
    {confirm.isSuccess && <p role="status">Skill decision saved and audited. No model was called.</p>}
    {history.isLoading && <LoadingState label="Loading Skill decisions…" />}
    {history.error && <ErrorState error={history.error} />}
    {history.data && !history.data.releases.length && <p>No Skill releases for this comparison.</p>}
    <ol className="evaluation-release-history">{history.data?.releases.map(r=><li key={r.id}>
      <strong>#{r.id} · {r.action==='applied' ? `Skill version #${r.revision_id} released` : `Skill rollback of #${r.source_release_id}`}</strong>
      <small>{new Date(r.created_at).toLocaleString()} · User #{r.actor_user_id}</small><p>{r.reason}</p>
      {r.action==='applied' && !history.data.releases.some(other=>other.source_release_id===r.id) && <button className="button button-secondary" disabled={busy} onClick={()=>start(r.id,true)}>Review Skill rollback #{r.id}</button>}
    </li>)}</ol>
  </section>;
}
