import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvaluationGate, inspectEvaluationStream, validateEvaluationInput, codexEvaluationStatus } from './codexEvaluation.js';

const input={ model:'gpt-5.6-terra',reasoningEffort:'xhigh',instructions:'frozen system',input:'frozen case' };
const message={ type:'message',role:'assistant',status:'completed',content:[{ type:'output_text',text:'PASS' }] };
const stream=(output:unknown[],usage?:unknown)=>`data: ${JSON.stringify({ type:'response.completed',response:{ status:'completed',model:input.model,output,usage } })}\n\n`;
const request=(extra={})=>({ method:'POST',headers:{ authorization:'Bearer fake-test-only','content-type':'application/json' },body:JSON.stringify({ model:input.model,tools:[],input:'CLI CONTEXT MUST NOT PASS',...extra }) });

test('input accepts only pinned targets and fixed contract; no URLs/session/credentials',()=>{
  assert.deepEqual(validateEvaluationInput(input),input);
  for (const bad of [{ ...input,model:'unknown' },{ ...input,baseUrl:'http://evil' },{ ...input,threadId:'old' },{ ...input,reasoningEffort:'bogus' }]) assert.throws(()=>validateEvaluationInput(bad));
});
test('strict output rejects tools, refusals, truncation and missing completion',()=>{
  assert.equal(inspectEvaluationStream(stream([message])).output,'PASS');
  assert.equal(inspectEvaluationStream(stream([message])).input_tokens,null);
  for (const bad of [stream([{ type:'function_call',name:'exec_command' }]),stream([{ ...message,role:'user' }]),
    stream([{ ...message,content:[{ type:'refusal' }] }]),stream([message,message]),'data: {"type":"response.incomplete"}\n\n']) assert.throws(()=>inspectEvaluationStream(bad));
});
test('intermediate commentary is never a final evaluated answer',()=>{
  assert.equal(inspectEvaluationStream(stream([{ ...message,phase:'final_answer' }])).output,'PASS');
  for (const phase of ['commentary','unknown']) assert.throws(()=>inspectEvaluationStream(stream([{ ...message,phase }])),/evaluation_nonfinal_message/);
});
test('released adapter still requires exact CLI and ChatGPT prerequisites',async()=>{
  assert.equal((await codexEvaluationStatus(async()=>false)).ready,false);
  assert.equal((await codexEvaluationStatus(async()=>false)).reason,'runtime_unavailable');
  assert.equal((await codexEvaluationStatus(async()=>true)).ready,true);
  assert.equal((await codexEvaluationStatus(async()=>true)).reason,null);
});
test('assembles completed streamed items when terminal metadata does not repeat output',()=>{
  const item=`data: ${JSON.stringify({ type:'response.output_item.done',output_index:0,item:message })}\n\n`;
  assert.equal(inspectEvaluationStream(item+stream([],{ input_tokens:4,output_tokens:1 })).output,'PASS');
  assert.throws(()=>inspectEvaluationStream(item));
  assert.throws(()=>inspectEvaluationStream(item+item+stream([])));
  assert.throws(()=>inspectEvaluationStream(stream([])));
  assert.throws(()=>inspectEvaluationStream(item+stream([])+item));
});
test('gate freezes context, strips CLI context, forwards once, and rejects concurrent/retry requests',async()=>{
  const sent:any[]=[];
  const gate=await createEvaluationGate(input,new AbortController().signal,(async (_url,init)=>{
    sent.push(JSON.parse(String(init?.body)));return new Response(stream([message],{ input_tokens:8,output_tokens:1 }));
  }) as typeof fetch,true);
  try {
    const results=await Promise.all([fetch(gate.baseUrl+'/responses',request()),fetch(gate.baseUrl+'/responses',request())]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,502]);assert.equal(sent.length,1);
    assert.equal(sent[0].instructions,input.instructions);assert.equal(sent[0].input[0].content[0].text,input.input);
    assert.equal(JSON.stringify(sent).includes('CLI CONTEXT'),false);assert.deepEqual(sent[0].tools,[]);
    assert.throws(()=>gate.result()); // Any unexpected extra request invalidates the run.
  } finally { await gate.close(); }
});
test('pinned CLI model metadata is local-only and never consumes an inference',async()=>{
  let calls=0;
  const gate=await createEvaluationGate(input,new AbortController().signal,(async()=>{
    calls++;return new Response(stream([message]));
  }) as typeof fetch,true);
  try {
    for (const suffix of ['/models','/models?client_version=0.146.0']) {
      const r=await fetch(gate.baseUrl+suffix);assert.equal(r.status,200);assert.deepEqual(await r.json(),{ models:[] });
    }
    assert.equal(calls,0);assert.equal(gate.counts().metadata_reads,2);
    assert.equal((await fetch(gate.baseUrl+'/responses',request())).status,200);
    assert.equal(gate.result().output,'PASS');assert.equal(calls,1);
    assert.equal((await fetch(gate.baseUrl+'/responses',request())).status,502);
    assert.equal(calls,1);assert.throws(()=>gate.result(),/evaluation_replay_blocked/);
  } finally { await gate.close(); }
});
test('unknown methods/routes/query values fail closed before any model dispatch',async()=>{
  for (const [method,suffix] of [['HEAD','/models'],['POST','/models'],['GET','/responses'],['GET','/models?client_version=other'],['GET','/models?url=http://elsewhere']]) {
    let calls=0;
    const gate=await createEvaluationGate(input,new AbortController().signal,(async()=>{
      calls++;return new Response(stream([message]));
    }) as typeof fetch,true);
    try {
      assert.equal((await fetch(gate.baseUrl+suffix,{ method })).status,502);
      assert.equal((await fetch(gate.baseUrl+'/responses',request())).status,502);
      assert.equal(calls,0);assert.throws(()=>gate.result());
    } finally { await gate.close(); }
  }
});
test('tool-bearing requests never dispatch; tool-bearing responses never reach CLI',async()=>{
  for (const tools of [[{ name:'exec_command' }],[]]) {
    let calls=0;
    const gate=await createEvaluationGate(input,new AbortController().signal,(async ()=>{calls++;return new Response(stream([{ type:'function_call',name:'exec_command' }]));}) as typeof fetch,true);
    try {
      const response=await fetch(gate.baseUrl+'/responses',request({ tools }));
      assert.equal(response.status,502);assert.equal((await response.text()).includes('exec_command'),false);
      assert.equal(calls,tools.length ? 0 : 1);assert.throws(()=>gate.result());
    } finally { await gate.close(); }
  }
});
test('no redirect/retry and no raw provider secrets in errors',async()=>{
  let calls=0;
  const gate=await createEvaluationGate(input,new AbortController().signal,(async (_url,init)=>{
    calls++;assert.equal(init?.redirect,'error');return new Response('SECRET_PROVIDER_ERROR',{ status:503 });
  }) as typeof fetch,true);
  try {
    assert.equal((await fetch(gate.baseUrl+'/responses',request())).status,502);
    const retry=await fetch(gate.baseUrl+'/responses',request());assert.equal((await retry.text()).includes('SECRET'),false);assert.equal(calls,1);
    assert.throws(()=>gate.result(),/evaluation_provider_failed_http_503/);
  } finally { await gate.close(); }
});
test('first parser failure survives a blocked CLI follow-up',async()=>{
  let calls=0;
  const gate=await createEvaluationGate(input,new AbortController().signal,(async()=>{
    calls++;return new Response(stream([{ ...message,phase:'commentary' }]));
  }) as typeof fetch,true);
  try {
    assert.equal((await fetch(gate.baseUrl+'/responses',request())).status,502);
    assert.equal((await fetch(gate.baseUrl+'/responses',request())).status,502);
    assert.equal(calls,1);assert.throws(()=>gate.result(),/evaluation_nonfinal_message_http_200/);
  } finally { await gate.close(); }
});
test('cancelled dispatch never contacts provider and missing usage is unknown',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const gate=await createEvaluationGate(input,controller.signal,(async()=>{calls++;throw new Error('unexpected');}) as typeof fetch,true);
  try { assert.equal((await fetch(gate.baseUrl+'/responses',request())).status,502);assert.equal(calls,0); }
  finally { await gate.close(); }
  assert.equal(inspectEvaluationStream(stream([message],{ input_tokens:-1 })).input_tokens,null);
});
