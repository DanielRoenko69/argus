import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { createAgentSkillRevision,getAgentSkillState,type SkillRevision } from '../api';
import type { AgentSummary } from '../types';
import { ErrorState,LoadingState } from './Ui';
import { PromptDiff } from './AgentPromptWorkbench';

export type SkillComparisonPreset={ agentId:number;modelRef:string;revision:SkillRevision;before:string };
function SkillEditor({ agentId,onCompare }:{ agentId:number;onCompare:(preset:SkillComparisonPreset)=>void }) {
  const client=useQueryClient();
  const source=useQuery({ queryKey:['agent-skills',agentId],queryFn:()=>getAgentSkillState(agentId),retry:false });
  const [skillId,setSkillId]=useState('');
  const [edit,setEdit]=useState<{ skillId:number;title:string;content:string;before:string;head:string }|null>(null);
  const [key,setKey]=useState(()=>crypto.randomUUID());
  const save=useMutation({ mutationFn:createAgentSkillRevision,onSuccess:async()=>{ setEdit(null);await client.invalidateQueries({ queryKey:['agent-skills',agentId] }); } });
  const change=(patch:Partial<NonNullable<typeof edit>>)=>{ setEdit(v=>v ? { ...v,...patch } : v);setKey(crypto.randomUUID());save.reset(); };
  if (source.isLoading) return <LoadingState label="Loading pinned Skills and version history…" />;
  if (source.error) return <ErrorState error={source.error} />;
  if (!source.data) return null;
  const data=source.data,skill=data.skills.find(s=>s.id===Number(skillId));
  return <>
    <p>Execution: {data.model_ref ?? 'unavailable'}. Library imports do not change these Agent pins.</p>
    {!data.skills.length ? <p>No attached Skills. Add one in <a href="/build/agents">Agent configuration</a> first.</p> : <label className="editor-field"><span>Attached Skill</span><select value={skillId} disabled={!!edit || save.isPending} onChange={e=>setSkillId(e.target.value)}>
      <option value="">Choose Skill</option>{data.skills.map(s=><option key={s.id} value={s.id}>{s.name} · pinned #{s.active.id}</option>)}
    </select></label>}
    <button className="button button-secondary" disabled={save.isPending} onClick={()=>void source.refetch()}>Refresh Skill state</button>
    {skill && <>
      <p>Active pin: <strong>#{skill.active.id}</strong> · {skill.name}</p>
      {!skill.active.editable && <p role="status">This Skill needs sensitive-content or size review before a deployable comparison is possible.</p>}
      <button className="button button-secondary" disabled={!skill.active.editable || !!edit || save.isPending} onClick={()=>{ setEdit({ skillId:skill.id,title:'Skill improvement',content:skill.active.content,before:skill.active.content,head:data.source_head_sha256 });setKey(crypto.randomUUID());save.reset(); }}>New Skill draft</button>
      {edit && <fieldset className="evaluation-release-review" disabled={save.isPending}>
        <legend>Draft only · no Agent or shared Library change</legend>
        {edit.head!==data.source_head_sha256 && <p role="alert">The Agent or Skill pins changed. Cancel and start from the current version.</p>}
        <label className="editor-field"><span>Skill draft title</span><input maxLength={120} value={edit.title} onChange={e=>change({ title:e.target.value })} /></label>
        <label className="editor-field"><span>Candidate Skill instructions</span><textarea rows={8} maxLength={32768} value={edit.content} onChange={e=>change({ content:e.target.value })} /></label>
        <PromptDiff before={edit.before} after={edit.content} />
        <p>No secrets or personal data. Saving creates an immutable version and makes no model call.</p>
        <div className="evaluation-export-actions"><button className="button button-primary" disabled={!edit.title.trim() || !edit.content.trim() || edit.content===edit.before || edit.head!==data.source_head_sha256} onClick={()=>save.mutate({ id:agentId,requestId:key,input:{ skill_id:edit.skillId,title:edit.title.trim(),content:edit.content,source_head_sha256:edit.head } })}>{save.isPending ? 'Saving draft…' : 'Save Skill draft'}</button>
          <button className="button button-secondary" onClick={()=>{ setEdit(null);save.reset(); }}>Cancel Skill editing</button></div>
      </fieldset>}
      <ol className="evaluation-release-history">{skill.revisions.map(r=>{
        const stale=r.origin==='draft' && r.source_head_sha256!==data.source_head_sha256;
        const same=r.content_sha256===skill.active.content_sha256;
        return <li key={r.id}><strong>#{r.id} · {r.title}</strong><small>{r.origin} · {new Date(r.created_at).toLocaleString()}{r.id===skill.active.id ? ' · active pin' : ''}</small>
          {stale && <small>Source changed or already applied. Save a new draft from the current Agent.</small>}
          <details><summary>Inspect Skill revision #{r.id}</summary><PromptDiff before={skill.active.content} after={r.content} /></details>
          <button className="button button-secondary" disabled={stale || same || !r.editable || !skill.active.editable || !data.model_ref || save.isPending || !!edit} onClick={()=>onCompare({ agentId,modelRef:data.model_ref!,revision:r,before:skill.active.content })}>Compare Skill #{r.id}</button>
        </li>;
      })}</ol><small>Latest 25 accessible versions per Skill. Earlier evidence and pins remain preserved.</small>
    </>}
    {save.error && <ErrorState error={save.error} />}
    {save.isSuccess && <p role="status">Skill draft saved. Active Agents and the Library were not changed.</p>}
  </>;
}
export function AgentSkillWorkbench({ agents,onCompare }:{ agents:AgentSummary[];onCompare:(preset:SkillComparisonPreset)=>void }) {
  const [id,setId]=useState('');
  return <section id="skill-versions" className="evaluation-export-controls prompt-revision-workbench" aria-label="Skill drafts">
    <h3>Improve a pinned Skill</h3><p>Draft or imported version → same-Agent comparison → reviewed release. One Skill changes for one Agent; all other Agents keep their pins.</p>
    <label className="editor-field"><span>Agent for Skill draft</span><select value={id} onChange={e=>setId(e.target.value)}><option value="">Choose Agent</option>{agents.map(a=><option key={a.id} value={a.id}>{a.label || a.name}</option>)}</select></label>
    {id && <SkillEditor key={id} agentId={Number(id)} onCompare={onCompare} />}
  </section>;
}
