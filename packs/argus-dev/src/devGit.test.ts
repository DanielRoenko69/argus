import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGitReference, devGitOperation, assertGitDeliveryApproval } from './devGit.js';
import { validateGitApproval } from './gitApproval.js';
import type { GitCreds, WorkflowState } from './state.js';

const creds: GitCreds={kind:'gitea',base_url:'http://gitea:3000',project_key:'alex',user_slug:'',repo_slug:'demo',target_branch:'main',token:null,
  reference:{version:1,bundleId:50,backendId:5,binding:'a'.repeat(64)}};
const state=()=>({workflow_blockers:[],human_approved:true,tests_passed:true,review_passed:true,pr_approved:true,branch_pushed:true,
  delivery_status:'ci_passed',branch_name:'feature/DEMO',commit_sha:'b'.repeat(40),
  ci_run:{status:'success',branch:'feature/DEMO',commit_sha:'b'.repeat(40)},argus_execution_grant:'opaque-grant'} as unknown as typeof WorkflowState.State);

test('reference fetch stores only allow-listed metadata and never accepts a legacy token', async t=>{
  process.env['WORKSPACE_SECRET']='trusted-workspace-secret';
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({...creds,unexpected:'do-not-persist'})));
  assert.deepEqual(await fetchGitReference(50,'grant','trace'),creds);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({...creds,token:'provider-secret'})));
  await assert.rejects(fetchGitReference(50,'grant','trace'),/metadata-only/);
});
test('only an explicit no-repository result is a null candidate; auth errors stop selection',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({code:'git_backend_missing'}),{status:404}));
  assert.equal(await fetchGitReference(50,'grant','trace'),null);
  t.mock.method(globalThis,'fetch',async()=>new Response('missing route',{status:404}));
  await assert.rejects(fetchGitReference(50,'grant','trace'),/not installed/);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({code:'connection_required',error:'secret provider body'}),{status:409}));
  await assert.rejects(fetchGitReference(50,'grant','trace'),e=>e instanceof Error&&e.message.includes('connection_required')&&!e.message.includes('secret provider'));
});
test('push uses the reference and trusted Core boundary, never provider headers or mutable URLs',async t=>{
  let request:Record<string,unknown>={};
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
    assert.ok(String(url).endsWith('/api/internal/dev-git/operate'));request=JSON.parse(String(init.body));
    assert.equal(init.redirect,'error');assert.equal((init.headers as Record<string,string>).authorization,'Bearer opaque-grant');
    return new Response(JSON.stringify({ok:true,commitSha:'b'.repeat(40),authentication:{mode:'user-oauth',userId:3,backendId:5}}));
  });
  await devGitOperation(state(),'trace',creds,'push','feature/DEMO',{commitSha:'b'.repeat(40)});
  assert.deepEqual(request.reference,creds.reference);assert.equal(request.codeApproved,true);assert.equal(request.url,undefined);assert.equal(request.token,undefined);
});
test('follow-up forwards only the pinned predecessor and PR identity through Core', async t=>{
  const requests: Array<Record<string,unknown>> = [];
  t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
    const body = JSON.parse(String(init.body)) as Record<string,unknown>;
    requests.push(body);
    return new Response(JSON.stringify({ok:true,commitSha:body.commitSha,prUrl:'http://gitea:3000/alex/demo/pulls/2'}));
  });
  await devGitOperation(state(),'trace',creds,'inspect-pr','feature/DEMO',
    {commitSha:'a'.repeat(40),pullRequestNumber:2});
  await devGitOperation(state(),'trace',creds,'push','feature/DEMO',
    {commitSha:'b'.repeat(40),expectedRemoteSha:'a'.repeat(40)});
  assert.equal(requests[0]?.operation,'inspect-pr');
  assert.equal(requests[0]?.pullRequestNumber,2);
  assert.equal(requests[0]?.codeApproved,undefined);
  assert.equal(requests[1]?.expectedRemoteSha,'a'.repeat(40));
  assert.equal(requests[1]?.codeApproved,true);
  assert.ok(requests.every(body => body.reference && !body.token && !body.authorization));
});
test('all human and CI gates remain effective; legacy credentials cannot reach transport',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('must not call');});
  for(const key of ['human_approved','tests_passed','review_passed','pr_approved','branch_pushed'])assert.throws(()=>assertGitDeliveryApproval({...state(),[key]:false},true));
  assert.throws(()=>assertGitDeliveryApproval({...state(),ci_run:{...state().ci_run!,commit_sha:'c'.repeat(40)}},true));
  await assert.rejects(devGitOperation(state(),'trace',{...creds,reference:undefined,token:'legacy-secret'},'push','feature/DEMO',{commitSha:'b'.repeat(40)}),/legacy/);
  assert.equal(fetch.mock.callCount(),0);
});
test('unknown HTTP outcomes do not automatically retry',async t=>{
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('connection lost');});
  await assert.rejects(devGitOperation(state(),'trace',creds,'push','feature/DEMO',{commitSha:'b'.repeat(40)}));assert.equal(fetch.mock.callCount(),1);
});

const grant=(change:Record<string,unknown>={})=>'eg_v1.'+Buffer.from(JSON.stringify({v:1,iss:'argus.core',aud:'argus.dev',agent:'coding-orchestrator',
  jti:'new',principalKind:'user',principalId:'3',bundleIds:[50],coreAgentIds:[2],messageId:'renewal',rootTraceId:'thread',workspaceRoot:'/workspace/DEMO',
  iat:Math.floor(Date.now()/1000)-1,exp:Math.floor(Date.now()/1000)+600,...change})).toString('base64url')+'.opaque';
const context={threadId:'thread',checkpointId:'checkpoint',stage:'human_approval',principal:'user:3',bundleIds:[50],workspaceRoot:'/workspace/DEMO'};
test('approval renewal remains bound to the original human, checkpoint, workspace and exact Bundles',()=>{
  const payload={grant:grant(),messageId:'renewal',checkpointId:'checkpoint',stage:'human_approval'};
  assert.equal(validateGitApproval(payload,context).claims.principalId,'3');
  for(const change of [{principalId:'4'},{bundleIds:[50,51]},{workspaceRoot:'/workspace/OTHER'},{rootTraceId:'other'},
    {exp:Math.floor(Date.now()/1000)-1}])assert.throws(()=>validateGitApproval({...payload,grant:grant(change)},context));
  assert.throws(()=>validateGitApproval({...payload,checkpointId:'different'},context));
  assert.throws(()=>validateGitApproval(payload,{...context,stage:'coder'}));
  assert.throws(()=>validateGitApproval(null,context));
});
