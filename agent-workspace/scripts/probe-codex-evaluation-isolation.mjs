// Run ONLY in a disposable container with --network none, no host credentials
// and no mounted workspace. A loopback Responses fixture replaces OpenAI.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn,execFileSync } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.ARGUS_ISOLATED_CODEX_PROBE!=='1') throw new Error('Disposable isolated probe only.');
const root=await mkdtemp(join(tmpdir(),'argus-codex-eval-probe-'));
const scenario=process.env.ARGUS_CODEX_PROBE_SCENARIO ?? 'answer';
if (!['answer','provider-error','unexpected-tool'].includes(scenario)) throw new Error('Unknown fixture scenario');
const home=join(root,'home'),cwd=join(root,'workspace'),codexHome=join(root,'codex');
for (const p of [home,cwd,codexHome]) await mkdir(p);
const instructions=join(root,'instructions.md');
await writeFile(instructions,'You are a deterministic fixture. Answer only the supplied question. No tools.');
const canary='ARGUS_EVALUATION_PRIVATE_CANARY';
await writeFile(join(root,'private.txt'),canary);
const binary='/app/node_modules/.bin/codex';
const env={ HOME:home,CODEX_HOME:codexHome,PATH:process.env.PATH,LANG:'C.UTF-8',ARGUS_FAKE_API_KEY:'fixture-not-a-real-key' };
const version=execFileSync(binary,['--version'],{ env,encoding:'utf8',timeout:10000 }).trim();
const requests=[],unexpected=[];
const server=createServer(async (req,res) => {
  if (req.url!=='/v1/responses' || req.method!=='POST') {
    unexpected.push({ method:req.method,path:req.url });res.writeHead(404);res.end();return;
  }
  const chunks=[];
  for await (const chunk of req) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (scenario==='provider-error' || requests.length>2) {
    res.writeHead(503,{ 'content-type':'application/json' });res.end(JSON.stringify({ error:{ message:'fixture failure' } }));return;
  }
  res.writeHead(200,{ 'content-type':'text/event-stream' });
  const inject=scenario==='unexpected-tool' && requests.length===1;
  const message=inject ? { type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'exec_command',
    arguments:JSON.stringify({ cmd:`cat ${join(root,'private.txt')}` }),status:'completed' }
    : { type:'message',id:'msg_fixture',role:'assistant',status:'completed',
      content:[{ type:'output_text',text:'fixture answer',annotations:[] }] };
  for (const event of [
    { type:'response.created',response:{ id:'resp_fixture',status:'in_progress',output:[] } },
    { type:'response.output_item.added',output_index:0,item:{ ...message,status:'in_progress',content:[] } },
    ...(!inject ? [{ type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'fixture answer' }] : []),
    { type:'response.output_item.done',output_index:0,item:message },
    { type:'response.completed',response:{ id:'resp_fixture',status:'completed',output:[message],
      usage:{ input_tokens:5,output_tokens:2,total_tokens:7 } } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const settings={
  // Use the configured local runtime's model identifier, but route exclusively
  // to the loopback fixture. This never authenticates to or calls that model.
  model_provider:'argus_fixture',model:'gpt-5.6-terra',
  'model_providers.argus_fixture.name':'Isolated loopback fixture',
  'model_providers.argus_fixture.base_url':`http://127.0.0.1:${port}/v1`,
  'model_providers.argus_fixture.wire_api':'responses',
  'model_providers.argus_fixture.env_key':'ARGUS_FAKE_API_KEY',
  'model_providers.argus_fixture.request_max_retries':0,
  'model_providers.argus_fixture.stream_max_retries':0,
  approval_policy:'never',web_search:'disabled',project_doc_max_bytes:0,
  model_instructions_file:instructions,
  'memories.generate_memories':false,'memories.use_memories':false,
  'skills.include_instructions':false,
  'tools.view_image':false,
  'tools.update_plan.enabled':false,
  'tools.experimental_request_user_input.enabled':false,
  'features.view_image':false,
};
for (const flag of ['shell_tool','unified_exec','multi_agent','multi_agent_v2','memories','apps','plugins',
  'hooks','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','in_app_browser',
  'image_generation','skill_search','skill_mcp_dependency_install','workspace_dependencies','goals',
  'shell_snapshot','enable_request_compression','code_mode','code_mode_host','tool_suggest','remote_plugin']) {
  settings[`features.${flag}`]=false;
}
const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check',
  '--sandbox','read-only','--json','--color','never','--cd',cwd];
for (const [key,value] of Object.entries(settings)) args.push('-c',`${key}=${JSON.stringify(value)}`);
args.push('-');
let exitCode,output='';
try {
  const child=spawn(binary,args,{ env,cwd,stdio:['pipe','pipe','pipe'] });
  child.stdin.end('Return the exact string: fixture answer');
  child.stdout.on('data',b => { if (output.length<32000) output+=b.toString(); });
  // Never print arbitrary CLI stderr; only a bounded byte count for debugging.
  let stderrBytes=0;child.stderr.on('data',b => { stderrBytes+=b.length; });
  const timer=setTimeout(() => child.kill('SIGKILL'),45000);
  try { exitCode=await new Promise((resolve,reject) => { child.on('close',resolve);child.on('error',reject); }); }
  finally { clearTimeout(timer); }
  const tools=[...new Set(requests.flatMap(r => (r.tools ?? []).map(t => t.name ?? t.function?.name ?? t.type)))];
  const report={ version,requested_model:settings.model,scenario,fixture_only:true,request_count:requests.length,unexpected_requests:unexpected,
    exposed_tools:tools,exit_code:exitCode,stderr_bytes:stderrBytes,
    returned_fixture:output.includes('fixture answer'),
    canary_exfiltrated:JSON.stringify(requests).includes(canary),
    isolation_candidate:requests.length===1 && unexpected.length===0 && tools.length===0 && exitCode===0 };
  const passed=requests.length===1 && unexpected.length===0 && tools.length===0 && !report.canary_exfiltrated
    && (scenario==='answer' ? report.returned_fixture && exitCode===0 : !report.returned_fixture && exitCode!==0);
  report.check_passed=passed;
  console.log(JSON.stringify(report,null,2));
  // Discovery, not production certification. A non-empty tool catalog is a blocker.
  assert.equal(passed,true,'Pinned Codex does not yet meet the single-request, tool-free evaluation contract.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root,{ recursive:true,force:true }); // Only the mkdtemp directory owned by this fixture.
}
