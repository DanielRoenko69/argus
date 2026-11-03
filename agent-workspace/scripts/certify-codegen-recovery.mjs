// Disposable /workspace only; no real checkouts, credentials or provider calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { sourceNow, previewCodegenRecovery, recoverCodegenImport, runCodeGeneration } from '/app/dist/routes/codeGeneration.js';
import { codegenHash as hash, codegenBytesHash as bytesHash } from '/app/dist/routes/codeGenerationContract.js';
import { trackWorkspaceWrites } from '/app/dist/routes/codeGenerationBarrier.js';
import { cancelCodegen } from '/app/dist/routes/codeGenerationCancellation.js';
const store = '/tmp/codegen-recovery-cert';
async function fixture() {
  const threadId = randomUUID(), workspaceRoot = '/workspace/RECOVERY-' + threadId;
  await mkdir(workspaceRoot, { recursive: true });
  for (const [p, content] of Object.entries({ 'client.ts': 'old\n', 'source.ts': 'original\n', '.python-version': '3.14\n' }))
    await writeFile(workspaceRoot + '/' + p, content);
  const git = (...args) => execFileSync('git', ['-c','core.hooksPath=/dev/null',...args], {cwd:workspaceRoot,encoding:'utf8',stdio:'pipe'}).trim();
  git('init'); git('add','.'); git('-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','fixture');
  const r = { action:'generate', baseCommitSha:git('rev-parse','HEAD'),basisSha256:'b'.repeat(64),sourceSha256:'',
    plan:{version:1,summary:'fixture',setup:'true',start:'',generate:'fixture-generator',outputPaths:['client.ts']},
    executionMode:'workspace-session-v1',threadId,workspaceRoot,allowedPaths:[] };
  r.sourceSha256 = sourceNow(r);
  const file={path:'client.ts',beforeSha256:bytesHash(Buffer.from('old\n')),sha256:bytesHash(Buffer.from('new\n')),content:Buffer.from('new\n').toString('base64')};
  const job=store+'/'+threadId+'/'+hash(r);await mkdir(job,{recursive:true});
  await writeFile(job+'/intent.json',JSON.stringify({requestSha256:hash(r),sourceSha256:r.sourceSha256}));
  await writeFile(job+'/application-intent.json',JSON.stringify({requestSha256:hash(r),files:[file],originals:[{path:'client.ts',content:Buffer.from('old\n').toString('base64')}]}));
  const calls=[];
  const post=async(action,body)=>{assert.equal(action,'generate-result','never dispatch generation');calls.push(action);return {
    requestSha256:hash(['codegen-v1',body]),sourceSha256:r.sourceSha256,basisSha256:r.basisSha256,planSha256:hash(r.plan),
    executionMode:r.executionMode,baseImage:'sha256:'+'d'.repeat(64),status:'completed',exitCode:0,phase:'generate',outputs:[file]};};
  return {r,job,post,calls,file};
}
const f=await fixture();
const preview=await previewCodegenRecovery(f.r,store,f.post);
assert.equal(await readFile(f.r.workspaceRoot+'/client.ts','utf8'),'old\n');
await assert.rejects(recoverCodegenImport(f.r,'0'.repeat(64),store,f.post),/binding_changed/);
const both=await Promise.allSettled([recoverCodegenImport(f.r,preview.recoveryDigest,store,f.post),recoverCodegenImport(f.r,preview.recoveryDigest,store,f.post)]);
assert.equal(both.filter(x=>x.status==='fulfilled').length,1);
const receipt=both.find(x=>x.status==='fulfilled').value;
assert.equal(receipt.applied,true);assert.equal(receipt.resultSourceSha256,sourceNow(f.r));
assert.equal(await readFile(f.r.workspaceRoot+'/client.ts','utf8'),'new\n');
await assert.rejects(recoverCodegenImport(f.r,preview.recoveryDigest,store,f.post),/consumed/);
assert.deepEqual(await runCodeGeneration(f.r,store,()=>{throw Error('must not replay');}),receipt);
for(const mode of ['source-drift','partial-import','unknown-result','wrong-broker-output','canceled','reserved','active-writer','changed-plan']) {
  const t=await fixture();let post=t.post;let response;
  if(mode==='source-drift')await writeFile(t.r.workspaceRoot+'/.python-version','3.15\n');
  if(mode==='partial-import')await writeFile(t.r.workspaceRoot+'/client.ts','new\n');
  if(mode==='unknown-result')post=async()=>{throw Error('missing result');};
  if(mode==='wrong-broker-output')post=async(...args)=>({...await t.post(...args),status:'failed',exitCode:1});
  if(mode==='canceled')await cancelCodegen(t.r.threadId,store);
  if(mode==='reserved')await writeFile(t.job+'/recovery-intent.json','{}');
  if(mode==='active-writer'){response=new EventEmitter();trackWorkspaceWrites({method:'POST',path:'/codex/run'},response,()=>{});}
  if(mode==='changed-plan')t.r.plan.generate='other-generator';
  try{await assert.rejects(previewCodegenRecovery(t.r,store,post),undefined,mode);}finally{response?.emit('finish');}
}
console.log(JSON.stringify({passed:true,cases:10,scope:'disposable workspace, recorded synthetic controller result',noGeneratorOrModelReplay:true}));
