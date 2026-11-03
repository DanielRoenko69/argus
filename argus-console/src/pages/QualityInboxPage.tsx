import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getConsoleUser, getQualityQueue, getQualityReview, saveQualityReview } from '../api';
import { isPlatformAdminRole } from '../access';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/Ui';
import { TraceToEvaluationButton } from '../components/TraceToEvaluationButton';
import { ObserveWorkspaceTabs } from '../features/observe/ObserveWorkspaceTabs';
import type { QualityItem, QualityReview } from '../types';

const states={ open:'Open',reviewed:'Reviewed',resolved:'Resolved' };
const verdicts={ needs_review:'Needs review',confirmed_issue:'Confirmed issue',acceptable:'Acceptable / false alarm' };
function signals(item:QualityItem) {
  return [item.signals.failed_run && 'Failed run',item.signals.human_feedback>0 && `${item.signals.human_feedback} human feedback`,
    item.signals.evaluation_failures>0 && `${item.signals.evaluation_failures} failed checks`,
    item.signals.evaluation_errors>0 && `${item.signals.evaluation_errors} execution errors`].filter(Boolean).join(' · ');
}
function ReviewForm({ item,onSaved }:{ item:QualityItem; onSaved:()=>void }) {
  const [status,setStatus]=useState<QualityReview['status']>('reviewed');
  const [verdict,setVerdict]=useState<QualityReview['verdict']>('needs_review');
  const [note,setNote]=useState('');
  const [identity,setIdentity]=useState<{ json:string; key:string }|null>(null);
  const mutation=useMutation({ mutationFn:saveQualityReview,onSuccess:onSaved });
  return <form className="quality-review-form" onSubmit={event => {
    event.preventDefault();
    const input={ source_sha256:item.source_sha256,previous_review_id:item.review?.id ?? null,status,verdict,note:note.trim() };
    const json=JSON.stringify(input),key=identity?.json===json ? identity.key : crypto.randomUUID();
    setIdentity({ json,key });mutation.mutate({ traceId:item.trace_id,input,requestId:key });
  }}>
    <h3>Human review</h3>
    <p>Annotates this evidence only. Resolving an item does not repair the run or change its evaluation score.</p>
    <label className="editor-field"><span>Verdict</span><select aria-label="Verdict" disabled={mutation.isPending} value={verdict} onChange={e => setVerdict(e.target.value as QualityReview['verdict'])}>{Object.entries(verdicts).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label className="editor-field"><span>Review status</span><select aria-label="Review status" disabled={mutation.isPending} value={status} onChange={e => setStatus(e.target.value as QualityReview['status'])}>{Object.entries(states).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label className="editor-field"><span>Reason / next action</span><textarea aria-label="Reason / next action" required maxLength={2000} rows={4} disabled={mutation.isPending} value={note} onChange={e => setNote(e.target.value)} placeholder="Explain your judgement and the verified fix or next step. Do not include secrets." /></label>
    {mutation.error && <ErrorState error={mutation.error} />}
    <button className="button button-primary" disabled={mutation.isPending || !note.trim() || (status!=='open' && verdict==='needs_review')}>{mutation.isPending ? 'Saving…' : 'Save review'}</button>
  </form>;
}
export function QualityInboxPage() {
  const [params,setParams]=useSearchParams(),client=useQueryClient();
  const [search,setSearch]=useState(''),[saved,setSaved]=useState(false);
  const session=useQuery({ queryKey:['console-session'],queryFn:getConsoleUser,staleTime:5*60_000 });
  const admin=isPlatformAdminRole(session.data?.role),selected=params.get('trace');
  const filter=params.get('status') ?? 'open';
  const queue=useQuery({ queryKey:['quality-queue'],queryFn:getQualityQueue,enabled:admin,refetchOnWindowFocus:false });
  const detail=useQuery({ queryKey:['quality-review',selected],queryFn:() => getQualityReview(selected!),enabled:admin && !!selected,refetchOnWindowFocus:false,retry:false });
  const update=(key:string,value:string) => { const next=new URLSearchParams(params);next.set(key,value);setParams(next);setSaved(false); };
  const refresh=async () => { await Promise.all([client.invalidateQueries({ queryKey:['quality-queue'] }),client.invalidateQueries({ queryKey:['quality-review'] })]); };
  const items=queue.data?.items ?? [];
  const visible=items.filter(i => (filter==='all' || i.status===filter) && `${i.name} ${i.agent ?? ''} ${i.model ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <PageHeader eyebrow="OBSERVE · HUMAN QUALITY LOOP" title="Quality Inbox" description="Review failed runs, human feedback and evaluation failures. Turn evidence into regression tests." actions={<button className="button button-secondary" disabled={!admin || queue.isFetching || detail.isFetching} onClick={() => void refresh()}>Refresh evidence</button>} />
    <ObserveWorkspaceTabs active="evidence" section="quality" isAdmin={admin} />
    {session.isLoading && <LoadingState />}{session.error && <ErrorState error={session.error} />}
    {!session.isLoading && !session.error && !admin && <p className="connection-notice">Platform admin access is required for the Quality Inbox.</p>}
    {admin && <>
      <div className="quality-inbox-summary">{Object.entries(states).map(([key,label]) => <button className={`button ${filter===key ? 'button-primary' : 'button-secondary'}`} key={key} onClick={() => update('status',key)} aria-pressed={filter===key}>{label} · {items.filter(i => i.status===key).length}</button>)}<button className="button button-secondary" aria-pressed={filter==='all'} onClick={() => update('status','all')}>All</button></div>
      <p className="connection-notice">Last 30 days · at most 500 recent candidate traces. Counts refer to the returned, authorized items, not a platform-wide quality score. No automatic model calls.{queue.data?.possibly_truncated && <strong> Limit reached: older items may be omitted.</strong>}</p>
      {queue.isLoading && <LoadingState label="Loading review signals…" />}{queue.error && <ErrorState error={queue.error} />}
      {saved && <p role="status">Review saved and audited.</p>}
      <div className="quality-inbox-layout">
        <section className="panel quality-inbox-list" aria-label="Review queue">
          <label className="editor-field"><span>Filter returned items</span><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Agent, model or trace name" /></label>
          {!queue.isLoading && !queue.error && !visible.length && <EmptyState title="No matching review items" description="No items match this filter in the bounded observation window. This is not a certification of model quality." />}
          {visible.map(item => <button className={`quality-inbox-item${selected===item.trace_id ? ' is-active' : ''}`} key={item.trace_id} aria-pressed={selected===item.trace_id} onClick={() => update('trace',item.trace_id)}>
            <span><strong>{item.name}</strong><small>{states[item.status]}{item.review_stale ? ' · changed evidence' : ''}</small></span>
            <p>{signals(item)}</p><small>{item.agent || 'No Agent recorded'} · {item.model || 'Model not recorded'}</small>
          </button>)}
        </section>
        <section className="panel quality-inbox-detail" aria-label="Selected evidence">
          {!selected && <EmptyState title="Select an item" description="Inspect its trace, record a human decision or create a reviewed test case." />}
          {detail.isLoading && selected && <LoadingState label="Loading evidence and review history…" />}{detail.error && <ErrorState error={detail.error} />}
          {detail.data && <>
            <h2>{detail.data.item.name}</h2><p>{signals(detail.data.item)}</p>
            <p>Run: {detail.data.item.run_status} · Review: {states[detail.data.item.status]}</p>
            {detail.data.item.review_stale && <p className="connection-notice">Evidence changed since the last review. This item is open again; the previous decision remains in history.</p>}
            <div className="quality-inbox-summary"><a className="button button-secondary" href={`/observe/logs?trace=${detail.data.item.trace_id}`}>Open trace and feedback</a><TraceToEvaluationButton traceId={detail.data.item.trace_id} /></div>
            {detail.data.item.evaluation_experiment_id && <a href={`/build/evaluations?experiment=${detail.data.item.evaluation_experiment_id}`}>Open evaluation checks</a>}
            <ReviewForm key={`${selected}:${detail.data.item.source_sha256}:${detail.data.item.review?.id}`} item={detail.data.item} onSaved={() => { setSaved(true);void refresh(); }} />
            <h3>Review history</h3>
            {!detail.data.history.length && <p>No human triage decision yet.</p>}
            <ol className="quality-review-history">{detail.data.history.map(review => <li key={review.id}><strong>{states[review.status]} · {verdicts[review.verdict]}</strong><p>{review.note}</p><small>User #{review.reviewer_user_id} · {new Date(review.created_at).toLocaleString()} · Revision #{review.id}</small></li>)}</ol>
            {detail.data.history_truncated && <p>Showing the latest 20 revisions. Earlier revisions are retained in the database.</p>}
          </>}
        </section>
      </div>
    </>}
  </>;
}
