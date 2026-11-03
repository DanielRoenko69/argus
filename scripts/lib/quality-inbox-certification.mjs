import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getQualityItem, getQualityReviewHistory, listQualityQueue, saveQualityReview } from '../../dist/evaluation/reviewQueue.js';
import { submitHumanFeedback } from '../../dist/observability/feedbackStore.js';

/** Run only from the existing disposable evaluation *_cert harness. No inference. */
export async function certifyQualityInbox({ pool,context,check,base }) {
  const ctx=(extra={}) => ({ ...context,requestId:randomUUID(),...extra });
  const createTrace=async (status='failed',metadata={}) => {
    const id=randomUUID();
    await pool.query(`INSERT INTO mcp_observability_traces(id,root_trace_id,name,kind,status,started_at,user_id,input_preview,output_preview,metadata)
      VALUES($1,$1,'Quality Inbox synthetic CI failure','agent',$2,now(),$3,'{"password":"fixture-private"}','"not ready"',$4)`,[id,status,context.user.id,metadata]);return id;
  };
  const traceId=await createTrace(),foreign=await createTrace('failed',{ tenantKey:'foreign',workspaceKey:'foreign' });
  const body=async (id=traceId) => {
    const item=await getQualityItem(pool,id,context);
    return { source_sha256:item.source_sha256,previous_review_id:item.review?.id ?? null,status:'reviewed',verdict:'confirmed_issue',note:'CI failure requires a regression case.' };
  };
  const reject=(fn,code) => assert.rejects(fn,e => e.code===code);
  await check('quality queue is scoped, bounded and never exposes source payloads',async () => {
    const queue=await listQualityQueue(pool,context);
    assert.ok(queue.items.some(i => i.trace_id===traceId));assert.ok(!queue.items.some(i => i.trace_id===foreign));
    assert.ok(!JSON.stringify(queue).includes('fixture-private'));assert.equal(queue.candidate_limit,500);
    await reject(() => getQualityItem(pool,foreign,context),'EVALUATION_REFERENCE_NOT_FOUND');
    const healthy=await createTrace('completed');
    assert.ok(!(await listQualityQueue(pool,context)).items.some(i => i.trace_id===healthy));
    await submitHumanFeedback(pool,{ traceId:healthy,userId:context.user.id,label:'quality',sentiment:'negative',comment:'Synthetic review' });
    assert.equal((await listQualityQueue(pool,context)).items.find(i => i.trace_id===healthy).signals.human_feedback,1);
  });
  await check('review writes are audited and idempotent; history is immutable and raw outcomes unchanged',async () => {
    const c=ctx(),b=await body(),review=await saveQualityReview(pool,traceId,b,c);
    assert.equal((await saveQualityReview(pool,traceId,b,c)).id,review.id);
    await reject(() => saveQualityReview(pool,traceId,{ ...b,note:'Changed binding' },c),'EVALUATION_IDEMPOTENCY_CONFLICT');
    const event=(await pool.query("SELECT event_id,resource_type,payload_summary FROM mcp_canonical_audit_events WHERE producer_name='evaluation.review.saved' AND resource_id=$1",[String(review.id)])).rows;
    assert.equal(event.length,1);assert.equal(event[0].resource_type,'quality_review');assert.ok(!JSON.stringify(event).includes(b.note));
    assert.equal((await pool.query('SELECT id FROM mcp_canonical_audit_outbox WHERE event_id=$1',[event[0].event_id])).rows.length,1);
    await reject(() => pool.query("UPDATE mcp_quality_reviews SET note='rewrite' WHERE id=$1",[review.id]),'23514');
    await reject(() => pool.query('DELETE FROM mcp_quality_reviews WHERE id=$1',[review.id]),'23514');
    assert.equal((await pool.query('SELECT status FROM mcp_observability_traces WHERE id=$1',[traceId])).rows[0].status,'failed');
  });
  await check('parallel reviewers serialize, stale evidence rejects and new evidence reopens triage',async () => {
    const b={ ...await body(),status:'resolved' };
    const results=await Promise.allSettled([1,2].map(() => saveQualityReview(pool,traceId,b,ctx())));
    assert.equal(results.filter(r => r.status==='fulfilled').length,1);
    assert.equal(results.filter(r => r.status==='rejected' && r.reason.code==='QUALITY_REVIEW_STALE').length,1);
    const old=await body();
    await submitHumanFeedback(pool,{ traceId,userId:context.user.id,label:'quality',sentiment:'negative',comment:'New evidence' });
    const item=await getQualityItem(pool,traceId,context);assert.equal(item.status,'open');assert.equal(item.review_stale,true);
    await reject(() => saveQualityReview(pool,traceId,old,ctx()),'QUALITY_REVIEW_STALE');
    assert.equal((await getQualityReviewHistory(pool,traceId,context)).history.length,2);
  });
  await check('audit failure rolls back a review; changed access blocks idempotent replay',async () => {
    const id=await createTrace(),b=await body(id);
    await assert.rejects(() => saveQualityReview(pool,id,b,ctx({ user:{ ...context.user,auth_method:'x'.repeat(500) } })));
    assert.equal((await getQualityReviewHistory(pool,id,context)).history.length,0);
    const c=ctx();await saveQualityReview(pool,id,b,c);
    await pool.query('UPDATE mcp_observability_traces SET metadata=$2 WHERE id=$1',[id,{ tenantKey:'hidden',workspaceKey:'hidden' }]);
    await reject(() => saveQualityReview(pool,id,b,c),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  await check('quality HTTP rejects non-admin, cross-origin, invalid and unbound decisions',async () => {
    const url=base+'/api/admin/evaluations/review-queue/'+traceId;
    assert.equal((await fetch(url,{ headers:{ 'X-Fixture-Role':'viewer' } })).status,403);
    assert.equal((await fetch(base+'/api/admin/evaluations/review-queue',{ headers:{ 'X-Fixture-Role':'viewer' } })).status,403);
    const post=(b,headers={}) => fetch(url,{ method:'POST',headers:{ 'Content-Type':'application/json',...headers },body:JSON.stringify(b) });
    assert.equal((await post(await body())).status,400);
    assert.equal((await post(await body(),{ Origin:'https://foreign.invalid','Idempotency-Key':randomUUID() })).status,403);
    assert.equal((await post({ ...await body(),reviewer_user_id:999 },{ 'Idempotency-Key':randomUUID() })).status,400);
    assert.equal((await fetch(url)).headers.get('cache-control'),'private, no-store');
  });
  return { traceId };
}

export async function certifyQualityEvaluationSignals({ pool,context,check }) {
  await check('completed failing evaluations appear separately from runtime failures',async () => {
    const candidates=(await pool.query(`SELECT r.trace_id FROM mcp_evaluation_results r JOIN mcp_observability_traces t ON t.id=r.trace_id
      WHERE r.status='failed' AND t.status='completed' ORDER BY r.id DESC LIMIT 1`)).rows;
    assert.ok(candidates.length,'Existing fake-provider comparison must contain a judged failure');
    const item=await getQualityItem(pool,candidates[0].trace_id,context);
    assert.equal(item.signals.failed_run,false);assert.ok(item.signals.evaluation_failures>0);assert.ok(item.evaluation_experiment_id);
  });
}
