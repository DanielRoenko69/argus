/** Disposable PostgreSQL + real Pack HTTP/LangGraph. Fake workers/stack only. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';
const name=`argus-stack-recovery-cert-${randomUUID().slice(0,8)}`,secret=randomUUID(),thread=randomUUID(),root='/workspace/RECOVERY-CERT';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const plan={version:1,summary:'frozen setup',setup:'install-once',start:'start-local',test:'frozen-tests',python:'/bin/python3'};
const source='c'.repeat(64),baseSha='a'.repeat(40);
const token=(messageId)=>'eg_v1.'+Buffer.from(JSON.stringify({v:1,iss:'argus.core',aud:'argus.dev',agent:'coding-orchestrator',jti:randomUUID(),
  principalKind:'user',principalId:'3',bundleIds:[7],coreAgentIds:[2],messageId,rootTraceId:thread,workspaceRoot:root,
  iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,testEnvironmentPolicy:'general-stack-v1'})).toString('base64url')+'.fixture';
let child,pool,saver,created=false,active=false,reconciled=true,sourceChanged=false,projectCalls=0,modelCalls=0,proofHash='f'.repeat(64),log='';
const pending=[],commands=[];
const until=async(fn,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timeout '+label);};
const mock=http.createServer(async(req,res)=>{
  const parts=[];for await(const p of req)parts.push(p);const b=parts.length?JSON.parse(Buffer.concat(parts)):{};
  const reply=(x,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(x));};
  if(req.url.startsWith('/api/internal/telemetry/'))return reply({ok:true});
  if(req.url==='/api/internal/dev-git/7/reference')return reply({kind:'gitea',base_url:'http://fixture.invalid',token:null,
    project_key:'',user_slug:'fixture',repo_slug:'repo',target_branch:'main',reference:{version:1,bundleId:7,backendId:1,binding:'b'.repeat(64)}});
  if(req.url.endsWith('/status'))return reply({runs:active?[{cwd:root}]:[]});
  if(req.url==='/exec'){
    commands.push(b.cmd);let stdout='';
    if(b.cmd==='git rev-parse HEAD')stdout=baseSha;
    else if(b.cmd==='git remote get-url origin')stdout='http://fixture.invalid/fixture/repo.git';
    else if(b.cmd.startsWith('git status'))stdout=' M src/main.py\n';
    else if(b.cmd.includes('git hash-object'))stdout=sourceChanged?'changed':'stable';
    else if(b.cmd.startsWith('git ls-files')||b.cmd.startsWith('git diff')||b.cmd.startsWith('if test -e ')||b.cmd.startsWith("for path in 'src/main.py'; do if test -e "))stdout='';
    else return reply({error:'unexpected command'},400);
    return reply({stdout,stderr:'',exit_code:0});
  }
  if(req.url==='/stack-tests/recovery-preview')return reply(reconciled?{version:1,requestSha256:'d'.repeat(64),sourceSha256:source,
    planSha256:hash(plan),preparedImage:'sha256:'+'e'.repeat(64),containerId:'1'.repeat(64),recoverySha256:proofHash,testsStarted:false}:{error:'not reconciled'},reconciled?200:409);
  if(req.url==='/api/agents/2/stack-tests'){
    if(b.action==='inspect')return reply({sourceSha256:source,files:1,excludedFiles:0,python:true});
    assert.equal(b.action,'project');assert.deepEqual(b.stackPlan,plan);projectCalls++;pending.push(res);return;
  }
  if(req.url.includes('/chat')||req.url.endsWith('/run'))modelCalls++;
  return reply({error:'unexpected route',path:req.url},404);
});
try{
  execFileSync('docker',['run','--rm','-d','--name',name,'-p','127.0.0.1::5432','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=recovery_cert','postgres:16-alpine'],{stdio:'pipe'});created=true;
  const dbPort=execFileSync('docker',['port',name,'5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1),db=`postgresql://postgres@127.0.0.1:${dbPort}/recovery_cert`;
  pool=new pg.Pool({connectionString:db});await until(()=>pool.query('SELECT 1').then(()=>true).catch(()=>false),'db');
  mock.listen(0,'127.0.0.1');await once(mock,'listening');const mockUrl=`http://127.0.0.1:${mock.address().port}`;
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const url=`http://127.0.0.1:${port}`;
  const launch=()=>{const p=spawn('node',['dist/server.js'],{env:{PATH:process.env.PATH,NODE_ENV:'test',PORT:String(port),POSTGRES_CONNECTION_URL:db,
    ARGUS_URL:mockUrl,AGENT_WORKSPACE_URL:mockUrl,WORKSPACE_SECRET:secret,REVIEWER_AGENT_ID:'2'},stdio:['ignore','pipe','pipe']});
    p.stdout.on('data',x=>log=(log+x).slice(-6000));p.stderr.on('data',x=>log=(log+x).slice(-6000));return p;};
  child=launch();await until(()=>fetch(url+'/healthz').then(r=>r.ok).catch(()=>false),'server');
  process.env.POSTGRES_CONNECTION_URL=db;const {codingWorkflow,codingCheckpointer}=await import('../dist/workflows/coding.js');saver=codingCheckpointer;
  const error='Continuation interrupted by server restart; worker reconciliation required. No automatic replay.';
  await pool.query("INSERT INTO argus_langgraph_threads(thread_id,graph_id,status,error,metadata) VALUES($1,'coding_workflow','failed',$2,$3)",[thread,error,
    {source:'a2a',execution_principal:'user:3',execution_grant_id:randomUUID(),execution_bundle_ids:[7]}]);
  const cfg={configurable:{thread_id:thread}};
  await codingWorkflow.updateState(cfg,{ticket_id:'RECOVERY-CERT',description:'Frozen issue',plan:'SAVED PLAN',context:'SAVED KNOWLEDGE',qa_test_plan:'SAVED QA',code:'SAVED CODE',
    workspace_dir:root,argus_workspace_root:root,base_commit_sha:baseSha,repository_scope_policy:'development-v1',repository:'fixture/repo',argus_execution_grant:token(randomUUID()),
    argus_bundle_id:7,argus_bundle_ids:[7],qa_acceptance_policy_version:1,qa_environment_policy_version:2,
    stack_plan:plan,stack_repair_count:2,stack_repair_policy_version:1,stack_repair_pending:true,stack_repair_started_at:1,
    qa_history:[{phase:'stack_plan',plan,sourceSha256:source}],
    bitbucket_creds:{kind:'gitea',base_url:'http://fixture.invalid',user_slug:'fixture',project_key:'',repo_slug:'repo',target_branch:'main',token:null,
      reference:{version:1,bundleId:7,backendId:1,binding:'b'.repeat(64)}}},'stack_environment');
  const request=async(path,body)=>{const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-workspace-secret':secret},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};
  const path=`/threads/${thread}/checkpoint-retry`;
  const preview=(await request(path)).body;assert.equal(preview.available,true,JSON.stringify(preview));assert.equal(preview.node,'tests');
  reconciled=false;assert.equal((await request(path)).body.available,false);reconciled=true;
  active=true;assert.equal((await request(path)).body.available,false);active=false;
  const messageId=randomUUID(),body={checkpointId:preview.checkpointId,workspaceDigest:preview.workspaceDigest,messageId,grant:token(messageId)};
  proofHash='0'.repeat(64);assert.equal((await request(path,body)).status,409);proofHash='f'.repeat(64);
  sourceChanged=true;assert.equal((await request(path,body)).status,409);sourceChanged=false;
  const results=await Promise.all([request(path,body),request(path,body)]);assert.deepEqual(results.map(x=>x.status).sort(),[202,409]);
  try { await until(()=>projectCalls===1,'tests dispatch'); }
  catch(e){const s=(await request(`/threads/${thread}/state`)).body;console.error(JSON.stringify({status:s.status,error:s.error,next:s.next,log:s.values?.log,commands}));throw e;}
  const state=await codingWorkflow.getState(cfg);
  assert.equal(state.values.plan,'SAVED PLAN');assert.equal(state.values.context,'SAVED KNOWLEDGE');assert.equal(state.values.code,'SAVED CODE');
  assert.equal(state.values.qa_test_plan,'SAVED QA');assert.equal(state.values.stack_repair_count,2);assert.equal(state.values.stack_repair_started_at,1);
  assert.equal(state.values.stack_snapshot_recovery_count,1);assert.equal(state.values.stack_snapshot_recovery_pending,true);
  assert.equal(state.values.human_approved,false);assert.equal(state.values.branch_pushed,false);assert.equal(modelCalls,0);
  assert.ok(commands.every(c=>!/clone|reset|checkout|push|commit|clean/.test(c)));
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;for(const p of pending)p.destroy();
  child=launch();await until(()=>fetch(url+'/healthz').then(r=>r.ok).catch(()=>false),'restart');
  assert.equal((await request(`/threads/${thread}/state`)).body.status,'failed');
  assert.equal((await request(path)).body.available,false);assert.equal(projectCalls,1);assert.equal(modelCalls,0);
  console.log('PASS: HTTP/Postgres/LangGraph recovery enters tests exactly once; frozen code/plan/QA and budgets retained; unreconciled/active/drift/duplicate/restart blocked; no model or provider writes.');
}catch(e){console.error(log);throw e;}finally{
  for(const p of pending)p.destroy();if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGKILL');await exit;}
  mock.closeAllConnections();await new Promise(r=>mock.close(r));if(saver)await saver.end();if(pool)await pool.end();
  if(created)execFileSync('docker',['stop',name],{stdio:'pipe'});
}
