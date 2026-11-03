// Disposable container only: --network none, no auth or workspace volumes.
import assert from 'node:assert/strict';
import { spawn,execFileSync } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvaluationGate,evaluationCliArgs,CODEX_EVALUATION_CLI } from '../dist/routes/codexEvaluation.js';
if (process.env.ARGUS_ISOLATED_CODEX_PROBE!=='1') throw new Error('Disposable fixture only');
const root=await mkdtemp(join(tmpdir(),'argus-eval-cert-'));
const binary='/app/node_modules/.bin/codex';
const input={ model:'gpt-5.6-terra',reasoningEffort:'xhigh',instructions:'Answer only the supplied question.',input:'Return exactly: fixture answer' };
try {
  for (const p of ['home','codex','workspace']) await mkdir(join(root,p));
  await writeFile(join(root,'instructions.md'),input.instructions);
  await writeFile(join(root,'private.txt'),'PRIVATE_CANARY');
  await writeFile(join(root,'workspace','AGENTS.md'),'EXTRA_INSTRUCTIONS_CANARY');
  const env={ HOME:join(root,'home'),CODEX_HOME:join(root,'codex'),PATH:process.env.PATH,LANG:'C.UTF-8',ARGUS_FAKE_API_KEY:'fake-not-real' };
  // Synthetic auth only, on a disposable --network none container. This tests
  // CLI behaviour with requires_openai_auth, without any real account/token.
  const chatgptFixture=process.env.ARGUS_ISOLATED_CODEX_AUTH_MODE==='chatgpt';
  if (chatgptFixture) {
    const b64=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
    const token=`${b64({ alg:'none',typ:'JWT' })}.${b64({ sub:'fixture-user',exp:Math.floor(Date.now()/1000)+3600,
      'https://api.openai.com/auth':{ chatgpt_account_id:'fixture-account',chatgpt_plan_type:'plus' } })}.fixture`;
    await writeFile(join(root,'codex','auth.json'),JSON.stringify({ auth_mode:'chatgpt',OPENAI_API_KEY:null,
      tokens:{ id_token:token,access_token:token,refresh_token:'fake-never-refresh',account_id:'fixture-account' },last_refresh:new Date().toISOString() }),{ mode:0o600 });
  }
  assert.equal(execFileSync(binary,['--version'],{ env,encoding:'utf8' }).trim(),CODEX_EVALUATION_CLI);
  for (const scenario of ['answer','streamed-answer','final-answer','commentary','unexpected-tool','provider-error']) {
    let requests=0;
    const controller=new AbortController();
    const gate=await createEvaluationGate(input,controller.signal,async (_url,init)=>{
      requests++;const body=JSON.parse(init.body);
      assert.deepEqual(body.tools,[]);assert.equal(body.instructions,input.instructions);
      assert.equal(body.input[0].content[0].text,input.input);assert.equal(JSON.stringify(body).includes('CANARY'),false);
      if (scenario==='provider-error') return new Response('fake',{ status:503 });
      const item=scenario==='unexpected-tool' ? { type:'function_call',id:'fc_1',call_id:'call_1',name:'exec_command',arguments:'{"cmd":"cat private.txt"}',status:'completed' }
        : { type:'message',id:'msg_1',role:'assistant',status:'completed',
          ...(scenario==='commentary' ? { phase:'commentary' } : scenario==='final-answer' ? { phase:'final_answer' } : {}),
          content:[{ type:'output_text',text:'fixture answer',annotations:[] }] };
      const events=[{ type:'response.created',response:{ id:'resp_1',status:'in_progress',output:[] } },
        { type:'response.output_item.added',output_index:0,item:{ ...item,status:'in_progress',content:[] } },
        ...(['answer','streamed-answer','final-answer','commentary'].includes(scenario) ? [{ type:'response.output_text.delta',output_index:0,item_id:'msg_1',content_index:0,delta:'fixture answer' }] : []),
        { type:'response.output_item.done',output_index:0,item },
        { type:'response.completed',response:{ id:'resp_1',status:'completed',model:input.model,output:scenario==='streamed-answer' ? [] : [item],usage:{ input_tokens:5,output_tokens:2,total_tokens:7 } } }];
      return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{ headers:{ 'content-type':'text/event-stream' } });
    },true);
    try {
      const child=spawn(binary,evaluationCliArgs(input,gate.baseUrl,join(root,'workspace'),join(root,'instructions.md'),!chatgptFixture),{ env,cwd:join(root,'workspace'),stdio:['pipe','pipe','pipe'],signal:controller.signal });
      let diagnostics='';child.stderr.on('data',b=>{ if (diagnostics.length<8000) diagnostics+=b; });
      child.stdout.on('data',b=>{ if (diagnostics.length<8000) diagnostics+=b; });
      child.stdin.on('error',()=>{});child.stdin.end(input.input);
      const timer=setTimeout(()=>controller.abort(),45000);
      const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);}).finally(()=>clearTimeout(timer));
      if (!requests || scenario==='answer' && code!==0) console.log(JSON.stringify({ fixture_only:true,diagnostics,gate:gate.counts() }));
      if (gate.counts().rejected_requests.length) console.log(JSON.stringify({ fixture_only:true,scenario,auth_mode:chatgptFixture ? 'synthetic-chatgpt' : 'synthetic-api-key',gate:gate.counts() }));
      assert.equal(requests,1);
      if (['answer','streamed-answer','final-answer'].includes(scenario)) { assert.equal(code,0);assert.equal(gate.result().output,'fixture answer'); }
      else {
        assert.notEqual(code,0);
        const expected=scenario==='commentary' ? /evaluation_nonfinal_message_http_200/
          : scenario==='unexpected-tool' ? /evaluation_tool_blocked_http_200/ : /evaluation_provider_failed_http_503/;
        assert.throws(()=>gate.result(),expected);
      }
      if (chatgptFixture) assert.ok(gate.counts().metadata_reads>0,'ChatGPT metadata path must be exercised');
      console.log(JSON.stringify({ scenario,requests,metadata_reads:gate.counts().metadata_reads,
        auth_mode:chatgptFixture ? 'synthetic-chatgpt' : 'synthetic-api-key',passed:true,fixture_only:true }));
    } finally { controller.abort();await gate.close(); }
  }
} finally { await rm(root,{ recursive:true,force:true }); }
