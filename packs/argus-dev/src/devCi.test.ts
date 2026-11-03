import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeJenkinsBundle, type DevCiReference } from './devCi.js';
import type { GitCreds } from './state.js';
import type { JenkinsConfig, JenkinsIntent } from './jenkinsDispatch.js';
import type { WorkflowState } from './state.js';

const config: JenkinsConfig = { apiOrigin:'http://jenkins:8080', publicOrigin:'http://localhost:8081', username:'test', token:'provider-secret', targets:[] };
const creds: GitCreds = { kind:'gitea',base_url:'http://gitea:3000',project_key:'',user_slug:'alex',repo_slug:'demo',target_branch:'main',token:null,
  reference:{version:1,bundleId:50,backendId:5,binding:'a'.repeat(64)} };
const ref: DevCiReference = { version:1,bundleId:50,backendId:6,job:'demo-dev',apiOrigin:config.apiOrigin,repository:'alex/demo',branchPrefix:'feature/DEMO-',authMode:'service-account',credentialSource:'argus-dev-dispatcher',binding:'b'.repeat(64) };
const state = () => ({argus_execution_grant:'opaque-grant',human_approved:true,tests_passed:true,review_passed:true,jenkins_binding:ref});
const intent: JenkinsIntent = {key:'fixture',job:'demo-dev',repository:'alex/demo',branch:'feature/DEMO-1',base:'a'.repeat(40),commit:'b'.repeat(40)};

test('Jenkins Core binding client', async t => {
  const previous = process.env['WORKSPACE_SECRET']; process.env['WORKSPACE_SECRET']='fixture-workspace-secret';
  t.after(()=>{ if(previous===undefined)delete process.env['WORKSPACE_SECRET'];else process.env['WORKSPACE_SECRET']=previous; });
  await t.test('prepare is metadata-only and dispatch uses approved exact source, independent of JSONB key order', async () => {
    let requests=0;
    const fetcher: typeof fetch = async (url, init) => {
      requests++; assert.match(String(url), /\/api\/internal\/dev-git\/ci-authorization$/);
      assert.equal(init?.redirect,'error'); const body=JSON.parse(String(init?.body));
      assert.equal(body.phase,requests===1?'prepare':'dispatch');
      assert.ok(!JSON.stringify(init).includes(config.token));
      if(requests===2){assert.equal(body.commitSha,intent.commit);assert.equal(body.codeApproved,true);}
      return Response.json({ciReference:Object.fromEntries(Object.entries(ref).reverse())});
    };
    assert.deepEqual(await authorizeJenkinsBundle(state(),'trace',creds,config,'demo-dev',undefined,fetcher),ref);
    assert.deepEqual(await authorizeJenkinsBundle(state(),'trace',creds,config,'demo-dev',intent,fetcher),ref);
  });
  await t.test('legacy state, missing approvals and token-bearing credentials never call Core', async () => {
    let calls=0; const fetcher: typeof fetch=async()=>{calls++;return Response.json({ciReference:ref});};
    for(const patch of [{jenkins_binding:null},{human_approved:false},{tests_passed:false},{review_passed:false},{argus_execution_grant:''}]) {
      await assert.rejects(authorizeJenkinsBundle({...state(),...patch},'trace',creds,config,'demo-dev',intent,fetcher));
    }
    await assert.rejects(authorizeJenkinsBundle(state(),'trace',{...creds,token:'legacy'},config,'demo-dev',intent,fetcher));
    assert.equal(calls,0);
  });
  await t.test('review-only delivery sends an explicit mode and never reports passing tests', async () => {
    let phases: string[] = [];
    const imageState = { ...state(), tests_passed: false, delivery_mode: 'ticket-to-image-pull-request' };
    const fetcher: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      phases.push(body.phase);
      assert.equal(body.verificationMode, 'review-only-image');
      assert.equal(body.testsPassed, undefined);
      return Response.json({ ciReference: ref });
    };
    await authorizeJenkinsBundle(imageState, 'trace', creds, config, 'demo-dev', undefined, fetcher);
    await authorizeJenkinsBundle({ ...imageState, jenkins_binding: ref }, 'trace', creds, config, 'demo-dev', intent, fetcher);
    assert.deepEqual(phases, ['prepare', 'dispatch']);
  });
  await t.test('wrong returned scope or changed policy fails closed; errors never leak transport bodies', async () => {
    for(const patch of [{bundleId:51},{job:'other'},{repository:'other/repo'},{binding:'c'.repeat(64)},{authMode:'strict'}]) {
      await assert.rejects(authorizeJenkinsBundle(state(),'trace',creds,config,'demo-dev',intent,async()=>Response.json({ciReference:{...ref,...patch}})), /Invalid or changed/);
    }
    await assert.rejects(authorizeJenkinsBundle(state(),'trace',creds,config,'demo-dev',intent,async()=>Response.json({code:'ci_binding_missing',error:'private-secret'},{status:403})),error=>!String(error).includes('private-secret')&&String(error).includes('ci_binding_missing'));
    await assert.rejects(authorizeJenkinsBundle(state(),'trace',creds,config,'demo-dev',intent,async()=>{throw Error('provider-secret');}), /Core CI authorization unavailable/);
  });
});

test('real workspace setup rejects a missing CI binding before checkout or model work', async t => {
  const settings = { WORKSPACE_SECRET:'fixture-workspace-secret', ARGUS_JENKINS_API_ORIGIN:config.apiOrigin,
    ARGUS_JENKINS_PUBLIC_ORIGIN:config.publicOrigin, ARGUS_JENKINS_DISPATCH_USER:'fixture',
    ARGUS_JENKINS_DISPATCH_TOKEN:'fixture-secret', ARGUS_JENKINS_DISPATCH_TARGETS:JSON.stringify([
      {repository:'alex/demo',gitOrigin:creds.base_url,branchPrefix:ref.branchPrefix,job:ref.job}]) };
  const previous=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
  Object.assign(process.env,settings);
  t.after(()=>{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const {PostgresSaver}=await import('@langchain/langgraph-checkpoint-postgres');
  t.mock.method(PostgresSaver.prototype,'setup',async()=>{});
  const {setupWorkspaceNode}=await import('./workflows/coding.js');
  const calls:string[]=[];
  t.mock.method(globalThis,'fetch',async (url:unknown)=>{
    calls.push(String(url));
    if(String(url).endsWith('/50/reference'))return Response.json(creds);
    if(String(url).endsWith('/ci-authorization'))return Response.json({code:'ci_binding_missing'},{status:403});
    throw Error('Unexpected checkout/model/provider request');
  });
  await assert.rejects(setupWorkspaceNode({...state(),argus_workspace_root:'/workspace/DEMO',argus_bundle_ids:[50],
    repository:'alex/demo',allowed_files:'',ci_provider:'jenkins',ci_job:ref.job} as unknown as typeof WorkflowState.State,
    {configurable:{thread_id:'trace'}}),/ci_binding_missing/);
  assert.equal(calls.length,2);assert.ok(calls.every(url=>url.includes('/api/internal/dev-git/')));
});
