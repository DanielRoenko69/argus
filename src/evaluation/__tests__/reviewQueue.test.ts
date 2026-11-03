import type pg from 'pg';
import { getTelemetryTrace, listTelemetryTraces } from '../../observability/telemetryStore.js';
import { listChatVisibleAgents } from '../../agents/agentStore.js';
import { getQualityItem, listQualityQueue, qualityReviewSchema } from '../reviewQueue.js';
import type { EvaluationContext } from '../context.js';

jest.mock('../../observability/telemetryStore.js',() => ({ getTelemetryTrace:jest.fn(),listTelemetryTraces:jest.fn() }));
jest.mock('../../agents/agentStore.js',() => ({ listChatVisibleAgents:jest.fn() }));
const id='11111111-1111-4111-8111-111111111111';
const context:EvaluationContext={ user:{ id:7,username:'reviewer',display_name:'Reviewer',role:'platform_admin',allowed_bundles:[4],entra_groups:[] },tenantKey:'default',workspaceKey:'default',environment:'test',requestId:'quality-unit-test' };
const trace={ id,status:'failed',name:'CI failure',agent_name:'Reviewer',model:'model',input_preview:{ password:'private-fixture' },output_preview:'Wrong',error_message:'Failure' };
const telemetry=jest.mocked(getTelemetryTrace),list=jest.mocked(listTelemetryTraces);
const query=jest.fn();
const pool={ query } as unknown as pg.Pool;
beforeEach(() => {
  jest.resetAllMocks();query.mockResolvedValue({ rows:[] });
  telemetry.mockResolvedValue({ trace,spans:[] } as never);list.mockResolvedValue([trace] as never);
  jest.mocked(listChatVisibleAgents).mockResolvedValue([{ id:3 }] as never);
});
describe('Quality Inbox projection',() => {
  it('returns bounded redacted metadata, never raw input, output or errors',async () => {
    const result=await listQualityQueue(pool,context);
    expect(result.items[0]).toMatchObject({ status:'open',signals:{ failed_run:true },review:null });
    expect(JSON.stringify(result)).not.toMatch(/private-fixture|Wrong|input_preview|error_message/);
    expect(list).toHaveBeenCalledWith(pool,expect.objectContaining({ allowedBundleIds:[4],tenantKey:'default',workspaceKey:'default',limit:500,hours:720,qualityCandidates:true }));
    expect(result.possibly_truncated).toBe(false);
  });
  it('reopens changed evidence but retains the previous human decision',async () => {
    const original=await getQualityItem(pool,id,context);
    query.mockImplementation(async (sql:string) => ({ rows:sql.includes('FROM mcp_quality_reviews') ? [{ id:'8',trace_id:id,source_sha256:original.source_sha256,status:'resolved',verdict:'confirmed_issue',note:'Fixed',reviewer_user_id:7 }] : [] }));
    expect((await getQualityItem(pool,id,context)).status).toBe('resolved');
    telemetry.mockResolvedValue({ trace:{ ...trace,output_preview:'New evidence' },spans:[] } as never);
    expect(await getQualityItem(pool,id,context)).toMatchObject({ status:'open',review_stale:true,review:{ id:8,status:'resolved' } });
  });
  it('denies missing or foreign telemetry before reading reviews',async () => {
    telemetry.mockResolvedValue(null);
    await expect(getQualityItem(pool,id,context)).rejects.toMatchObject({ status:404 });
    expect(query).not.toHaveBeenCalled();
  });
  it('aggregates signals without treating a failed assertion as a failed run',async () => {
    list.mockResolvedValue([{ ...trace,status:'completed' }] as never);
    query.mockImplementation(async (sql:string) => ({ rows:sql.includes('FROM mcp_evaluation_results') ? [{ trace_id:id,failures:1,errors:0,digest:'failed-result',experiment_id:'12' }] : [] }));
    expect((await listQualityQueue(pool,context)).items[0]).toMatchObject({ signals:{ failed_run:false,evaluation_failures:1 },evaluation_experiment_id:12 });
    expect(query.mock.calls.find(([sql]) => sql.includes('FROM mcp_evaluation_results'))?.[1]).toEqual([[id],'default','default',[3],[4]]);
  });
  it('reports the scan limit and omits candidates without authorized signals',async () => {
    list.mockResolvedValue(Array.from({ length:500 },() => ({ ...trace,status:'completed' })) as never);
    expect(await listQualityQueue(pool,context)).toMatchObject({ items:[],possibly_truncated:true });
  });
  it('does not resolve global Agents for another workspace',async () => {
    await listQualityQueue(pool,{ ...context,workspaceKey:'elsewhere' });
    expect(listChatVisibleAgents).not.toHaveBeenCalled();
  });
});
describe('Quality review contracts',() => {
  const input={ source_sha256:'a'.repeat(64),previous_review_id:null,status:'reviewed',verdict:'confirmed_issue',note:'Human reviewed' };
  it('requires independent reason, current source and explicit verdict',() => {
    expect(qualityReviewSchema.safeParse(input).success).toBe(true);
    for (const invalid of [{ ...input,note:' ' },{ ...input,verdict:'needs_review' },{ ...input,user_id:99 },{ ...input,source_sha256:'old' },{ ...input,status:'fixed' }]) expect(qualityReviewSchema.safeParse(invalid).success).toBe(false);
    expect(qualityReviewSchema.safeParse({ ...input,status:'open',verdict:'needs_review' }).success).toBe(true);
  });
});
