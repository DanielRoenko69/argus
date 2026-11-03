import { describe, it, expect, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { signExecutionGrant, type ExecutionGrantClaims } from '../../solutionPacks/executionGrant.js';
import { canonicalAuditDigest, redactCanonicalAuditPayload } from '../../audit/canonicalAuditRedaction.js';

const audit=jest.fn<any>();
const feedback=jest.fn<any>().mockResolvedValue(undefined);
jest.mock('../../audit/canonicalAuditStore.js',()=>({executeCanonicalAuditedMutation:(...args:unknown[])=>audit(...args)}));
jest.mock('../../observability/feedbackStore.js',()=>({submitHumanFeedback:(...args:unknown[])=>feedback(...args)}));
import { createDevGitApprovalRouter } from '../devGitApproval.js';
const secret='git-approval-fixture-secret-at-least-32';
const id=randomUUID(); const checkpoint=randomUUID();
function fixture(options:{userId?:number;revoked?:boolean;denied?:boolean;auditFails?:boolean;replayed?:boolean;stage?:string;
  recoveryRecorded?:boolean;corruptRecovery?:boolean}={}) {
  const claims:ExecutionGrantClaims={v:1,jti:randomUUID(),iss:'argus.core',aud:'argus.dev',agent:'coding-orchestrator',sub:'user:3',principalKind:'user',principalId:'3',
    bundleIds:[50],coreAgentIds:[2],coreAgents:[{id:2,name:'coder'}],messageId:'original',rootTraceId:id,workspaceRoot:'/workspace/DEMO',policy:'mcp-bundle-v1',
    iat:Math.floor(Date.now()/1000)-7200,exp:Math.floor(Date.now()/1000)-3600};
  const context={broker:true,threadId:id,checkpointId:checkpoint,stage:options.stage??'human_approval',executionGrant:signExecutionGrant(secret,claims),
    principal:'user:3',grantId:claims.jti,ticketId:'DEMO',branch:'feature/DEMO',commitSha:'a'.repeat(40),retryCount:2};
  const fetchFn=jest.fn<any>().mockImplementation(async(_url:string,init:RequestInit)=>new Response(JSON.stringify(init.method==='GET'?context:{run_id:'new'})));
  const recoveryDigest=createHash('sha256').update(JSON.stringify([checkpoint,true,'reviewed','reviewed'])).digest('hex');
  const recoveryAfter={decisionSha256:recoveryDigest,gate:'code_approval',approved:true};
  const recoveryAfterDigest=canonicalAuditDigest(redactCanonicalAuditPayload(recoveryAfter));
  const query=jest.fn<any>().mockImplementation(async(sql:string)=>({rows:sql.includes('SELECT status')?[{status:options.revoked?'revoked':'active'}]
    :sql.includes('SELECT approved,rationale,decision_feedback')&&options.recoveryRecorded
      ?[{approved:true,rationale:'reviewed',decision_feedback:'reviewed',row_hash:options.corruptRecovery?'bad':recoveryDigest,approver_user_id:3}]
    :sql.includes('FROM mcp_canonical_audit_events')&&options.recoveryRecorded
      ?[{actor_id:'3',resource_revision:checkpoint,payload_summary:{after:redactCanonicalAuditPayload(recoveryAfter)},after_digest:recoveryAfterDigest}]
    :sql.includes('mcp_users')?[{id:3,allowed_bundles:options.denied?[]:[50]}]:[]}));
  const issuer={assertRepositoryCheckout:jest.fn<any>().mockResolvedValue(undefined),checkBundleCapabilities:jest.fn<any>().mockResolvedValue({ok:true}),
    issueWithClaims:jest.fn<any>().mockResolvedValue({token:'fresh-private-grant',claims:{}})};
  audit.mockReset();audit.mockImplementation(async(_p:unknown,_producer:unknown,_scope:unknown,mutate:any)=>{
    if(options.auditFails)throw Error('audit failed');if(!options.replayed)await mutate({query});return{replayed:options.replayed??false};
  });
  const router=createDevGitApprovalRouter({query} as never,issuer as never,secret,fetchFn as never);
  const call=async(body:unknown={approved:true})=>{
    const handler=router.stack[0]!.route!.stack.at(-1)!.handle;
    let status=200;let data:any;
    const res={status:(s:number)=>{status=s;return res;},json:(d:unknown)=>{data=d;}};
    await handler({params:{id},body,header:()=>undefined,user:{id:options.userId??3,username:'Alex',role:'platform_admin',allowed_bundles:[50]}} as never,res as never,()=>{});
    return{status,data};
  };
  const recover=async(method:'get'|'post',body:unknown={checkpointId:checkpoint})=>{
    const route=router.stack.find(layer=>{
      const candidate=layer.route as {path?:string;methods?:Record<string,boolean>}|undefined;
      return candidate?.path==='/threads/:id/approval-recovery'&&candidate.methods?.[method];
    });
    const handler=route!.route!.stack.at(-1)!.handle;
    let status=200;let data:any;
    const res={status:(s:number)=>{status=s;return res;},json:(d:unknown)=>{data=d;}};
    await handler({params:{id},body,header:()=>undefined,user:{id:options.userId??3,username:'Alex',role:'platform_admin',allowed_bundles:[50]}} as never,res as never,()=>{});
    return{status,data};
  };
  return{call,recover,issuer,fetchFn,router,query};
}
describe('Git approval renewal',()=>{
  it('renews expired provenance for the same actor/scope and never returns a bearer to the browser',async()=>{
    const f=fixture();const r=await f.call();expect(r.status).toBe(200);expect(r.data).toEqual({ok:true});
    expect(f.issuer.issueWithClaims).toHaveBeenCalledWith(expect.objectContaining({principalId:'3',requestedBundleIds:[50],workspaceRoot:'/workspace/DEMO',rootTraceId:id}));
    expect(feedback).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({traceId:id,userId:3,label:'code_approval',score:1}));
    const sent=JSON.parse(String((f.fetchFn.mock.calls[1]![1] as RequestInit).body));expect(sent.gitApproval.grant).toBe('fresh-private-grant');expect(sent.gitApproval.checkpointId).toBe(checkpoint);
  });
  it('rejects wrong owner, revoked grants, current Bundle denial and unrelated stages before dispatch',async()=>{
    for(const opts of [{userId:4},{revoked:true},{denied:true},{stage:'requirements_input'}]){
      const f=fixture(opts);expect((await f.call()).status).toBeGreaterThanOrEqual(400);expect(f.fetchFn).toHaveBeenCalledTimes(1);expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
    }
  });
  it('cannot bypass an unavailable audit or blindly replay a recorded decision',async()=>{
    for(const opts of [{auditFails:true},{replayed:true}]){const f=fixture(opts);expect((await f.call()).status).toBe(409);expect(f.fetchFn).toHaveBeenCalledTimes(1);}
  });
  it('rejects browser-supplied grants, Bundles and approval checkpoint overrides',async()=>{
    for(const extra of [{grant:'forged'},{bundleIds:[51]},{checkpointId:randomUUID()}]){const f=fixture();expect((await f.call({approved:true,...extra})).status).toBe(409);expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();}
  });
  it('keeps human authentication, same-origin and named approval permission on the route',()=>{
    const f=fixture();const stack=f.router.stack[0]!.route!.stack;expect(stack[1]?.handle.name).toBe('requireAuth');expect(stack[2]?.handle.name).toBe('requireSameOrigin');expect(stack.length).toBe(5);
  });
  it('recovers only the exact audited decision at the unchanged checkpoint without a second vote',async()=>{
    const f=fixture({recoveryRecorded:true});
    expect((await f.recover('get')).data).toEqual({available:true,checkpointId:checkpoint,stage:'human_approval',approved:true});
    const r=await f.recover('post');
    expect(r).toEqual({status:200,data:{ok:true,recovered:true}});
    expect(audit).not.toHaveBeenCalled();
    const sent=JSON.parse(String((f.fetchFn.mock.calls.at(-1)![1] as RequestInit).body));
    expect(sent.command.resume).toEqual({approved:true,feedback:'reviewed'});
    expect(sent.gitApproval).toMatchObject({checkpointId:checkpoint,stage:'human_approval'});
  });
  it('injects one local, thread-bound failure only after audit and then recovers the recorded decision',async()=>{
    const keys=['ARGUS_ENVIRONMENT','ARGUS_PUBLIC_URL','ARGUS_DEV_GIT_APPROVAL_TEST_FAIL_ONCE'] as const;
    const previous=keys.map(key=>process.env[key]);
    try {
      process.env['ARGUS_ENVIRONMENT']='local';
      process.env['ARGUS_PUBLIC_URL']='http://localhost:3000';
      process.env['ARGUS_DEV_GIT_APPROVAL_TEST_FAIL_ONCE']=`${id}:human_approval`;
      const f=fixture({recoveryRecorded:true});
      const interrupted=await f.call({approved:true,feedback:'reviewed'});
      expect(interrupted).toEqual({status:503,data:expect.objectContaining({code:'git_approval_demo_dispatch_interrupted'})});
      expect(audit).toHaveBeenCalledTimes(1);
      expect(f.fetchFn).toHaveBeenCalledTimes(1); // context read, no Pack resume
      expect((await f.recover('get')).data).toMatchObject({available:true,checkpointId:checkpoint});
      expect(await f.recover('post')).toEqual({status:200,data:{ok:true,recovered:true}});
      expect(audit).toHaveBeenCalledTimes(1);
      const sent=JSON.parse(String((f.fetchFn.mock.calls.at(-1)![1] as RequestInit).body));
      expect(sent.command.resume).toEqual({approved:true,feedback:'reviewed'});
    } finally {
      keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});
    }
  });
  it('cannot inject a failure for another thread, stage or a non-local origin',async()=>{
    const keys=['ARGUS_ENVIRONMENT','ARGUS_PUBLIC_URL','ARGUS_DEV_GIT_APPROVAL_TEST_FAIL_ONCE'] as const;
    const previous=keys.map(key=>process.env[key]);
    try {
      for(const [environment,origin,target] of [
        ['production','http://localhost:3000',`${id}:human_approval`],
        ['local','https://argus.example.test',`${id}:human_approval`],
        ['local','http://localhost:3000',`${randomUUID()}:human_approval`],
        ['local','http://localhost:3000',`${id}:human_approval_pr`],
      ]) {
        process.env['ARGUS_ENVIRONMENT']=environment!;
        process.env['ARGUS_PUBLIC_URL']=origin!;
        process.env['ARGUS_DEV_GIT_APPROVAL_TEST_FAIL_ONCE']=target!;
        const f=fixture();
        expect((await f.call()).status).toBe(200);
        expect(f.fetchFn).toHaveBeenCalledTimes(2);
      }
    } finally {
      keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});
    }
  });
  it('refuses absent or mismatched evidence, changed checkpoint, and browser-supplied decisions',async()=>{
    for(const opts of [{},{recoveryRecorded:true,corruptRecovery:true},{recoveryRecorded:true,revoked:true}]){
      const f=fixture(opts);const r=await f.recover('post');
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(f.fetchFn.mock.calls.every(call=>(call[1] as RequestInit).method==='GET')).toBe(true);
    }
    const f=fixture({recoveryRecorded:true});
    expect((await f.recover('post',{checkpointId:randomUUID()})).status).toBe(409);
    expect((await f.recover('post',{checkpointId:checkpoint,approved:false})).status).toBe(409);
  });
});
