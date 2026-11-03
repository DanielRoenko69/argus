import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { createAgentPromptRevision,getAgentPromptState,type PromptRevision } from '../api';
import type { AgentSummary } from '../types';
import { ErrorState,LoadingState } from './Ui';

export type PromptComparisonPreset={ agentId:number;modelRef:string;revision:PromptRevision };
export function PromptDiff({ before,after }:{ before:string|null;after:string|null }) {
  return <div className="evaluation-release-diff prompt-revision-diff">
    <div><strong>Active / before</strong><pre>{before ?? '(No custom system prompt)'}</pre></div>
    <div><strong>Candidate / after</strong><pre>{after ?? '(No custom system prompt)'}</pre></div>
  </div>;
}
function PromptEditor({ agentId,onCompare }:{ agentId:number;onCompare:(preset:PromptComparisonPreset)=>void }) {
  const client=useQueryClient();
  const source=useQuery({ queryKey:['agent-prompt',agentId],queryFn:()=>getAgentPromptState(agentId),retry:false });
  const [edit,setEdit]=useState<{ title:string;prompt:string;source:string;before:string|null }|null>(null);
  const [key,setKey]=useState(()=>crypto.randomUUID());
  const save=useMutation({ mutationFn:createAgentPromptRevision,onSuccess:async()=>{ setEdit(null);await client.invalidateQueries({ queryKey:['agent-prompt',agentId] }); } });
  const change=(patch:Partial<NonNullable<typeof edit>>)=>{ setEdit(v=>v ? { ...v,...patch } : v);setKey(crypto.randomUUID());save.reset(); };
  if (source.isLoading) return <LoadingState label="Loading active prompt and draft history…" />;
  if (source.error) return <ErrorState error={source.error} />;
  if (!source.data) return null;
  const data=source.data;
  return <>
    <p>Active prompt: {data.active_revision_id ? `revision #${data.active_revision_id}` : 'unversioned / direct configuration'} · Current execution: {data.model_ref ?? 'unavailable'}</p>
    {!data.editable && <p role="status">The active prompt needs sensitive-content review before it can be used for a deployable draft. Edit it in Agent configuration first.</p>}
    <div className="evaluation-export-actions"><button className="button button-secondary" disabled={!data.editable || save.isPending || !!edit} onClick={()=>{ setEdit({ title:'Prompt improvement',prompt:data.system_prompt ?? '',source:data.source_head_sha256,before:data.system_prompt });setKey(crypto.randomUUID());save.reset(); }}>New prompt draft</button>
      <button className="button button-secondary" disabled={save.isPending} onClick={()=>void source.refetch()}>Refresh prompt state</button></div>
    {edit && <fieldset className="evaluation-release-review" disabled={save.isPending}>
      <legend>Draft only · active Agent remains unchanged</legend>
      {edit.source!==data.source_head_sha256 && <p role="alert">The Agent changed while editing. Cancel and create a draft from the current state.</p>}
      <label className="editor-field"><span>Draft title</span><input maxLength={120} value={edit.title} onChange={e=>change({ title:e.target.value })} /></label>
      <label className="editor-field"><span>Candidate system prompt</span><textarea rows={8} maxLength={32768} value={edit.prompt} onChange={e=>change({ prompt:e.target.value })} /></label>
      <PromptDiff before={edit.before} after={edit.prompt} />
      <p>Do not include secrets or personal data. Each save creates an immutable version; saving makes no model call.</p>
      <div className="evaluation-export-actions"><button className="button button-primary" disabled={!edit.title.trim() || !edit.prompt.trim() || edit.prompt===edit.before || edit.source!==data.source_head_sha256} onClick={()=>save.mutate({ id:agentId,requestId:key,input:{ title:edit.title.trim(),system_prompt:edit.prompt,source_head_sha256:edit.source } })}>{save.isPending ? 'Saving draft…' : 'Save prompt draft'}</button>
        <button className="button button-secondary" onClick={()=>{ setEdit(null);save.reset(); }}>Cancel draft editing</button></div>
    </fieldset>}
    {save.error && <ErrorState error={save.error} />}
    {save.isSuccess && <p role="status">Prompt draft saved. The active Agent was not changed.</p>}
    {!data.revisions.length && <p>No saved prompt drafts yet.</p>}
    <ol className="evaluation-release-history">{data.revisions.map(r=><li key={r.id}>
      <strong>#{r.id} · {r.title}</strong><small>{new Date(r.created_at).toLocaleString()} · User #{r.created_by_user_id}</small>
      {r.source_head_sha256!==data.source_head_sha256 && <small>Source changed or revision already applied · save a new draft from the current Agent.</small>}
      <details><summary>Inspect saved prompt change</summary><PromptDiff before={r.source_prompt} after={r.system_prompt} /></details>
      <button className="button button-secondary" disabled={!data.model_ref || r.source_head_sha256!==data.source_head_sha256 || save.isPending} onClick={()=>onCompare({ agentId,modelRef:data.model_ref!,revision:r })}>Compare prompt #{r.id}</button>
    </li>)}</ol><small>Latest 25 saved drafts. Existing comparisons retain their frozen prompt references.</small>
  </>;
}
export function AgentPromptWorkbench({ agents,onCompare }:{ agents:AgentSummary[];onCompare:(preset:PromptComparisonPreset)=>void }) {
  const [id,setId]=useState('');
  return <section className="evaluation-export-controls prompt-revision-workbench" aria-label="Prompt drafts">
    <h3>Improve a system prompt</h3><p>Draft → compare against the active prompt → review → release. Same Agent and execution target; Skills, tools and permissions stay unchanged.</p>
    <label className="editor-field"><span>Agent for prompt draft</span><select value={id} onChange={e=>setId(e.target.value)}><option value="">Choose Agent</option>{agents.map(a=><option key={a.id} value={a.id}>{a.label || a.name}</option>)}</select></label>
    {id && <PromptEditor key={id} agentId={Number(id)} onCompare={onCompare} />}
  </section>;
}
