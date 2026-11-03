import { Router } from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CODEX_EVALUATION_VERSION = 'argus.codex-reference.v1';
export const CODEX_EVALUATION_CLI = 'codex-cli 0.146.0';
export const CODEX_EVALUATION_MODELS = ['gpt-5.6-terra'];
// Pinned adapter: offline isolation + live subscription smoke verified.
// Authentication and the exact CLI version are still checked on every start.
export const CODEX_EVALUATION_RELEASED = true;
const efforts = new Set(['minimal','low','medium','high','xhigh']);
const binary = process.env['ARGUS_CODEX_BINARY'] || '/app/node_modules/.bin/codex';
const exec = promisify(execFile);
const upstream = 'https://chatgpt.com/backend-api/codex/responses';
const limit = 2 * 1024 * 1024;
type Json = Record<string, any>;
export type EvaluationInput = { model:string; reasoningEffort:string; instructions:string; input:string };
export type EvaluationAnswer = { output:string; model:string|null; input_tokens:number|null; output_tokens:number|null };
const tokenCount = (n:unknown) => typeof n==='number' && Number.isSafeInteger(n) && n>=0 && n<=2147483647 ? n : null;

function environment(home?:string):NodeJS.ProcessEnv {
  return { PATH:process.env['PATH'],LANG:'C.UTF-8',TERM:'dumb',
    HOME:home || process.env['HOME'] || '/home/node',
    CODEX_HOME:process.env['CODEX_HOME'] || '/home/node/.codex' };
}

export function validateEvaluationInput(value:unknown):EvaluationInput {
  const v=value as Json;
  if (!v || typeof v!=='object' || Array.isArray(v)
    || Object.keys(v).some(k=>!['model','reasoningEffort','instructions','input'].includes(k))
    || !CODEX_EVALUATION_MODELS.includes(v.model) || !efforts.has(v.reasoningEffort)
    || typeof v.instructions!=='string' || typeof v.input!=='string' || !v.input.length
    || Buffer.byteLength(JSON.stringify(v))>200_000) throw new Error('evaluation_input_invalid');
  return v as EvaluationInput;
}

async function boundedBody(stream:AsyncIterable<Uint8Array>):Promise<string> {
  const chunks:Buffer[]=[];let size=0;
  for await (const chunk of stream) {
    size+=chunk.length;
    if (size>limit) throw new Error('evaluation_transport_limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Inspect the entire bounded stream BEFORE delivering any event to the CLI.
 * A function/tool item cannot reach the harness or trigger a follow-up turn. */
export function inspectEvaluationStream(text:string):EvaluationAnswer {
  let completed:Json|undefined;
  const doneItems=new Map<number,Json>();
  for (const frame of text.replace(/\r\n/g,'\n').split('\n\n')) {
    const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if (!data || data==='[DONE]') continue;
    const e=JSON.parse(data) as Json;
    if (completed) throw new Error('evaluation_event_after_completion');
    if (typeof e.type!=='string' || !/^response\.(created|in_progress|completed|output_item\.(added|done)|content_part\.(added|done)|output_text\.(delta|done)|reasoning_summary_(part|text)\.(added|delta|done)|reasoning_text\.(delta|done))$/.test(e.type)) {
      throw new Error(typeof e.type==='string' && /^[a-z_.]{1,90}$/.test(e.type) ? 'evaluation_unsupported_event_'+e.type.replaceAll('.','_') : 'evaluation_unsupported_event');
    }
    const inspectItem=(item:Json) => {
      if (!item || !['message','reasoning'].includes(item.type)) throw new Error('evaluation_tool_blocked');
      if (item.type==='message' && (item.role!=='assistant' || (item.content ?? []).some((c:Json)=>c.type!=='output_text'))) throw new Error('evaluation_output_invalid');
    };
    if (e.item) inspectItem(e.item);
    if (e.type==='response.output_item.done') {
      if (!e.item || !Number.isSafeInteger(e.output_index) || e.output_index<0 || e.output_index>512
        || doneItems.has(e.output_index)) throw new Error('evaluation_item_invalid');
      // Some subscription streams send the completed items here and only
      // completion metadata/usage in response.completed (no repeated output).
      if (e.item.status!==undefined && e.item.status!=='completed') throw new Error('evaluation_item_incomplete');
      doneItems.set(e.output_index,{ ...e.item,status:'completed' });
    }
    if (e.part && !['output_text','summary_text','reasoning_text'].includes(e.part.type)) throw new Error('evaluation_output_invalid');
    if (e.response) for (const item of e.response.output ?? []) inspectItem(item);
    if (e.type==='response.completed') {
      if (completed || e.response?.status!=='completed') throw new Error('evaluation_completion_status_invalid');
      completed=e.response;
    }
  }
  const outputItems=completed?.output?.length ? completed.output : [...doneItems.entries()].sort(([a],[b])=>a-b).map(([,v])=>v);
  const messages=outputItems.filter((v:Json)=>v.type==='message');
  if (!completed || messages.length!==1 || messages[0].status!=='completed') throw new Error('evaluation_incomplete_message');
  // A completed message may only be an intermediate update. Never score a
  // commentary item as the final answer or let the CLI continue the agent loop.
  if (messages[0].phase!=null && messages[0].phase!=='final_answer') throw new Error('evaluation_nonfinal_message');
  const output=messages[0].content.map((c:Json)=>c.text).join('');
  if (messages[0].content.some((c:Json)=>typeof c.text!=='string') || Buffer.byteLength(output)>262144) throw new Error('evaluation_output_invalid');
  return { output,model:typeof completed.model==='string' ? completed.model : null,
    input_tokens:tokenCount(completed.usage?.input_tokens),output_tokens:tokenCount(completed.usage?.output_tokens) };
}

/** Fixed destination in production; fixture transport is dependency injection,
 * never an HTTP/config argument. No auth/header/body is logged or persisted. */
export async function createEvaluationGate(input:EvaluationInput,signal:AbortSignal,
  transport:typeof fetch=fetch,fixture=false) {
  const nonce=randomUUID();let consumed=false,attempts=0,metadataReads=0,answer:EvaluationAnswer|undefined,failed=false,providerStatus:number|null=null,failure='evaluation_failed';
  const rejected:Array<{ method:string;route:string;after_dispatch:boolean }>=[];
  const server=createServer(async (req,res)=>{
    try {
      if (signal.aborted) throw new Error('evaluation_cancelled');
      // ChatGPT-authenticated CLI refreshes /models before inference. This is
      // strictly local metadata, never a second upstream/authenticated request.
      // An empty remote catalog leaves the pinned CLI's bundled model metadata
      // in control; it does not advertise fabricated model availability.
      if (req.method==='GET' && (req.url===`/${nonce}/models` || req.url===`/${nonce}/models?client_version=0.146.0`)) {
        metadataReads++;
        res.writeHead(200,{ 'content-type':'application/json','cache-control':'no-store' });res.end('{"models":[]}');return;
      }
      if (failed) throw new Error('evaluation_gate_closed');
      if (req.method!=='POST') throw new Error('evaluation_method_blocked');
      if (req.url!==`/${nonce}/responses`) throw new Error('evaluation_route_blocked');
      if (consumed) throw new Error('evaluation_replay_blocked');
      consumed=true; // Claim synchronously, before body read/transport. Includes failed requests.
      const body=JSON.parse(await boundedBody(req));
      if (body.model!==input.model || (body.tools!==undefined && (!Array.isArray(body.tools) || body.tools.length)) || body.previous_response_id) throw new Error('evaluation_request_invalid');
      const auth=req.headers.authorization;
      if (!auth || !/^Bearer \S+$/.test(auth)) throw new Error('evaluation_auth_missing');
      // Never forward CLI-discovered context. Only the exact frozen Core input.
      const request={ model:input.model,instructions:input.instructions,
        input:[{ role:'user',content:[{ type:'input_text',text:input.input }] }],
        reasoning:{ effort:input.reasoningEffort },tools:[],tool_choice:'none',parallel_tool_calls:false,store:false,stream:true };
      const headers:Record<string,string>={ authorization:auth,'content-type':'application/json',accept:'text/event-stream' };
      const account=req.headers['chatgpt-account-id'];
      if (typeof account==='string') headers['chatgpt-account-id']=account;
      for (const key of ['originator','user-agent','openai-beta']) {
        const value=req.headers[key];if (typeof value==='string' && value.length<=256) headers[key]=value;
      }
      attempts++;
      const response=await transport(fixture ? 'http://127.0.0.1/fixture/responses' : upstream,
        { method:'POST',headers,body:JSON.stringify(request),signal,redirect:'error' });
      providerStatus=response.status;
      if (!response.ok || !response.body) throw new Error('evaluation_provider_failed');
      const stream=await boundedBody(response.body as unknown as AsyncIterable<Uint8Array>);
      answer=inspectEvaluationStream(stream);
      if (answer.model && answer.model!==input.model) throw new Error('evaluation_model_mismatch');
      if (signal.aborted) throw new Error('evaluation_cancelled');
      res.writeHead(200,{ 'content-type':'text/event-stream' });res.end(stream);
    } catch(error) {
      if (rejected.length<8) rejected.push({ method:['GET','POST','HEAD','OPTIONS'].includes(req.method ?? '') ? req.method! : 'other',
        route:req.url?.split('?')[0]===`/${nonce}/models` ? 'models' : req.url===`/${nonce}/responses` ? 'responses' : 'other',after_dispatch:consumed });
      // The CLI can issue a follow-up after a rejected response. Preserve the
      // first cause instead of masking parser/provider errors with "replay".
      if (!failed && error instanceof Error && /^evaluation_[a-z0-9_]+$/.test(error.message)) failure=error.message;
      failed=true;
      res.writeHead(502,{ 'content-type':'application/json' });
      res.end('{"error":{"message":"Isolated evaluation stopped; no automatic retry."}}');
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as { port:number }).port;
  return { baseUrl:`http://127.0.0.1:${port}/${nonce}`,
    result:()=>{ if (failed || attempts!==1 || !answer) throw new Error(`${failure}_http_${providerStatus ?? 'none'}`);return { ...answer,requests:attempts }; },
    counts:()=>({ requests:attempts,metadata_reads:metadataReads,consumed,provider_status:providerStatus,rejected_requests:rejected }),
    close:async()=>{ server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); } };
}

export function evaluationCliArgs(input:EvaluationInput,baseUrl:string,cwd:string,instructions:string,fixture=false) {
  const settings:Json={ model_provider:'argus_evaluation',model:input.model,model_reasoning_effort:input.reasoningEffort,
    'model_providers.argus_evaluation.name':'Argus isolated Codex evaluation',
    'model_providers.argus_evaluation.base_url':baseUrl,'model_providers.argus_evaluation.wire_api':'responses',
    'model_providers.argus_evaluation.requires_openai_auth':!fixture,
    'model_providers.argus_evaluation.request_max_retries':0,'model_providers.argus_evaluation.stream_max_retries':0,
    'model_providers.argus_evaluation.supports_websockets':false,
    approval_policy:'never',web_search:'disabled',project_doc_max_bytes:0,model_instructions_file:instructions,
    'memories.generate_memories':false,'memories.use_memories':false,'skills.include_instructions':false,
    'tools.view_image':false,'tools.update_plan.enabled':false,'tools.experimental_request_user_input.enabled':false };
  if (fixture) settings['model_providers.argus_evaluation.env_key']='ARGUS_FAKE_API_KEY';
  for (const flag of ['shell_tool','unified_exec','multi_agent','multi_agent_v2','memories','apps','plugins','hooks','browser_use',
    'browser_use_external','browser_use_full_cdp_access','computer_use','in_app_browser','image_generation','skill_search',
    'skill_mcp_dependency_install','workspace_dependencies','goals','shell_snapshot','enable_request_compression','code_mode',
    'code_mode_host','tool_suggest','remote_plugin','view_image']) settings[`features.${flag}`]=false;
  const args=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check','--sandbox','read-only',
    '--json','--color','never','--cd',cwd];
  for (const [k,v] of Object.entries(settings)) args.push('-c',`${k}=${JSON.stringify(v)}`);
  return [...args,'-'];
}

export async function codexEvaluationPrerequisites() {
  let authenticated=false;
  try {
    if (process.env['ARGUS_CODEX_ENABLED']!=='true') throw new Error('disabled');
    const version=await exec(binary,['--version'],{ env:environment(),timeout:10000,maxBuffer:4096 });
    const auth=await exec(binary,['login','status'],{ env:environment(),timeout:10000,maxBuffer:32768 });
    authenticated=version.stdout.trim()===CODEX_EVALUATION_CLI && /logged in using chatgpt/i.test(auth.stdout+'\n'+auth.stderr);
  } catch { /* Readiness is safe metadata, never CLI errors/auth output. */ }
  return authenticated;
}

export async function codexEvaluationStatus(prerequisites=codexEvaluationPrerequisites) {
  const ready=CODEX_EVALUATION_RELEASED && await prerequisites();
  return { ready,reason:!CODEX_EVALUATION_RELEASED ? 'live_validation_pending' : ready ? null : 'runtime_unavailable',
    executor_version:CODEX_EVALUATION_VERSION,cli_version:CODEX_EVALUATION_CLI,models:CODEX_EVALUATION_MODELS };
}

export async function runCodexEvaluation(input:EvaluationInput,signal:AbortSignal) {
  signal.throwIfAborted();
  const root=await mkdtemp(join(tmpdir(),'argus-evaluation-'));
  const home=join(root,'home'),cwd=join(root,'workspace'),instructions=join(root,'instructions.md');
  let gate:Awaited<ReturnType<typeof createEvaluationGate>>|undefined;
  try {
    await mkdir(home);await mkdir(cwd);await writeFile(instructions,input.instructions,{ mode:0o600 });
    gate=await createEvaluationGate(input,signal);
    const args=evaluationCliArgs(input,gate.baseUrl,cwd,instructions);
    const child=spawn(binary,args,{ env:environment(home),cwd,stdio:['pipe','ignore','ignore'],detached:process.platform!=='win32' });
    const stop=()=>{ try { if (process.platform!=='win32' && child.pid) process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL'); } catch { /* Already exited. */ } };
    signal.addEventListener('abort',stop,{ once:true });
    if (signal.aborted) stop();
    // Errors are fixed safe codes at the HTTP boundary; never return CLI stderr.
    child.stdin.on('error',()=>{});child.stdin.end(input.input);
    const exitCode=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);})
      .finally(()=>signal.removeEventListener('abort',stop));
    signal.throwIfAborted();
    if (exitCode!==0) { gate.result();throw new Error('evaluation_cli_failed'); }
    return gate.result();
  } finally {
    await gate?.close();
    // Only this invocation's mkdtemp directory, never CODEX_HOME or a repository.
    await rm(root,{ recursive:true,force:true });
  }
}

export const codexEvaluationRouter=Router();
let active=false;
const consumedRuns=new Set<string>();
codexEvaluationRouter.get('/status',async (_req,res)=>{ res.json(await codexEvaluationStatus()); });
codexEvaluationRouter.post('/run',async (req,res)=>{
  let input:EvaluationInput;
  const id=req.header('x-evaluation-attempt-id') ?? '';
  try { input=validateEvaluationInput(req.body);if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('id'); }
  catch { res.status(400).json({ code:'EVALUATION_INPUT_INVALID' });return; }
  if (active || consumedRuns.has(id) || consumedRuns.size>=10000) { res.status(409).json({ code:'EVALUATION_BUSY_OR_REPLAY' });return; }
  active=true;
  const controller=new AbortController();
  const abort=()=>{ if (!res.writableEnded) controller.abort(); };
  const timer=setTimeout(()=>controller.abort(),180000);timer.unref();res.on('close',abort);
  try {
    if (!(await codexEvaluationStatus()).ready) { res.status(409).json({ code:'EVALUATION_CODEX_UNAVAILABLE' });return; }
    consumedRuns.add(id);
    const result=await runCodexEvaluation(input,controller.signal);
    res.json({ ...result,executor_version:CODEX_EVALUATION_VERSION });
  } catch { if (!res.destroyed) res.status(502).json({ code:'EVALUATION_CODEX_STOPPED',message:'Isolated evaluation failed; no automatic retry. Usage may be unknown.' }); }
  finally { clearTimeout(timer);res.off('close',abort);active=false; }
});
