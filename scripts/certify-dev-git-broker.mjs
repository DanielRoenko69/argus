// Disposable PostgreSQL only. No local Argus DB, provider credentials or model calls.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { executeGitWriteOnce } from '../dist/workflows/devGitOperations.js';

const name=`argus-git-broker-cert-${randomBytes(5).toString('hex')}`;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30_000});
let pool;let created=false;
try {
  docker(['run','--detach','--rm','--name',name,'--label','io.argus.dev-git-cert=true','--memory','192m',
    '-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432','postgres:16-alpine']);created=true;
  const port=JSON.parse(docker(['inspect',name]))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  pool=new pg.Pool({host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres',max:8,connectionTimeoutMillis:1000});
  const deadline=Date.now()+60_000;
  for(;;){try{await pool.query('SELECT 1');break;}catch(error){
    if(Date.now()>deadline)throw Error(`Disposable database unavailable (${error.code??'connection_timeout'}); ${docker(['logs','--tail','8',name]).slice(-1000)}`);
    await new Promise(r=>setTimeout(r,250));
  }}
  for(const file of ['220_canonical_audit_events.sql','221_scope_canonical_audit_idempotency.sql','266_dev_git_operations.sql']) {
    await pool.query(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
  }
  const grant={rootTraceId:randomUUID(),principalKind:'user',principalId:'3',tenantKey:'fixture',workspaceKey:'fixture'};
  const input={reference:{version:1,backendId:5,bundleId:50,binding:'a'.repeat(64)},operation:'push',branch:'feature/CERT',commitSha:'b'.repeat(40),
    codeApproved:true,testsPassed:true,reviewPassed:true};
  const identity={backendId:5,mode:'user-oauth',userId:3};let calls=0;
  const perform=async()=>{calls++;const pending=await pool.query("SELECT status FROM argus_dev_git_operations WHERE root_trace_id=$1",[grant.rootTraceId]);
    assert.equal(pending.rows[0].status,'started');await new Promise(r=>setTimeout(r,100));return{ok:true,commitSha:input.commitSha};};
  await Promise.allSettled(Array.from({length:6},()=>executeGitWriteOnce(pool,grant,input,identity,perform)));
  assert.equal(calls,1);assert.equal((await executeGitWriteOnce(pool,grant,input,identity,perform)).ok,true);assert.equal(calls,1);
  await assert.rejects(executeGitWriteOnce(pool,grant,{...input,description:'changed request'},identity,perform),/different frozen request/);
  const events=await pool.query('SELECT sequence,previous_hash,event_hash FROM mcp_canonical_audit_events ORDER BY sequence');
  assert.equal(events.rows.length,2);assert.equal(events.rows[1].previous_hash,events.rows[0].event_hash);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM mcp_canonical_audit_outbox')).rows[0].n,2);

  const unknown={...grant,rootTraceId:randomUUID()};let unknownCalls=0;
  await assert.rejects(executeGitWriteOnce(pool,unknown,input,identity,async()=>{unknownCalls++;throw Error('lost response');}),/lost response/);
  await assert.rejects(executeGitWriteOnce(pool,unknown,input,identity,async()=>{unknownCalls++;return{ok:true};}),/no terminal receipt/);assert.equal(unknownCalls,1);

  await pool.query(`CREATE FUNCTION fail_git_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='dev_git.result' THEN RAISE EXCEPTION 'synthetic terminal audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER cert_audit_failure BEFORE INSERT ON mcp_canonical_audit_events FOR EACH ROW EXECUTE FUNCTION fail_git_audit();`);
  const auditFailure={...grant,rootTraceId:randomUUID()};let auditCalls=0;
  await assert.rejects(executeGitWriteOnce(pool,auditFailure,input,identity,async()=>{auditCalls++;return{ok:true};}),/synthetic terminal audit failure/);
  assert.equal((await pool.query('SELECT status FROM argus_dev_git_operations WHERE root_trace_id=$1',[auditFailure.rootTraceId])).rows[0].status,'started');
  await pool.query('DROP TRIGGER cert_audit_failure ON mcp_canonical_audit_events');
  await assert.rejects(executeGitWriteOnce(pool,auditFailure,input,identity,async()=>{auditCalls++;return{ok:true};}),/no terminal receipt/);assert.equal(auditCalls,1);
  process.stdout.write(JSON.stringify({status:'passed',checks:['migration_266','concurrent_single_dispatch','completed_receipt_replay',
    'changed_request_denied','hash_chain_and_outbox','unknown_no_replay','terminal_audit_atomic_rollback'],scope:'disposable PostgreSQL; synthetic provider; not live Gitea SSO'})+'\n');
} catch(error) { process.stderr.write(String(error.message).slice(0,500)+'\n');process.exitCode=1; }
finally { await pool?.end();if(created)docker(['rm','--force',name]); }
