// Disposable PostgreSQL only. Real renewal transaction and canonical audit;
// no live user, workflow, model, Git provider or Jenkins call.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { renewDevGrant } from '../dist/api/devGrantRenewal.js';
import { signExecutionGrant, verifyExecutionGrant, assertExecutionGrantActive } from '../dist/solutionPacks/executionGrant.js';
import { appendCanonicalAuditEvent } from '../dist/audit/canonicalAuditStore.js';

const name = `argus-grant-renewal-cert-${randomUUID().slice(0,8)}`;
let pool, created = false;
try {
  execFileSync('docker', ['run','--rm','-d','--name',name,'-p','127.0.0.1::5432','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=grant_renewal_cert','postgres:16-alpine'], { stdio: 'pipe' }); created = true;
  const port = execFileSync('docker',['port',name,'5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1);
  pool = new pg.Pool({connectionString:`postgresql://postgres@127.0.0.1:${port}/grant_renewal_cert`});
  const deadline = Date.now()+30000;
  while (true) { try { await pool.query('SELECT 1'); break; } catch (e) { if(Date.now()>deadline) throw e; await new Promise(r=>setTimeout(r,100)); } }
  for (const file of ['220_canonical_audit_events.sql','221_scope_canonical_audit_idempotency.sql']) await pool.query(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  await pool.query(`
    CREATE TABLE argus_langgraph_threads(thread_id uuid PRIMARY KEY,graph_id text,status text,metadata jsonb);
    CREATE TABLE argus_langgraph_runs(run_id uuid PRIMARY KEY,thread_id uuid,status text,started_at timestamptz);
    CREATE TABLE argus_execution_grants(grant_id uuid PRIMARY KEY,status text,root_trace_id uuid,pack_id text,pack_agent_id text,
      principal_kind text,principal_id text,tenant_key text,workspace_key text,bundle_ids int[],core_agent_ids int[],tool_names text[],expires_at timestamptz);
    CREATE TABLE mcp_users(id int PRIMARY KEY,role text,allowed_bundles int[],entra_groups text[],enabled boolean);
    CREATE TABLE mcp_agents(id int PRIMARY KEY,name text,enabled boolean);
    CREATE TABLE mcp_service_bundles(id int PRIMARY KEY);
    CREATE TABLE mcp_user_agent_rules(user_id int,agent_id int,effect text,expires_at timestamptz);
    CREATE TABLE mcp_group_agent_rules(group_name text,agent_id int,effect text);
    INSERT INTO mcp_users VALUES(3,'developer','{50,3,4}','{}',true);
    INSERT INTO mcp_agents VALUES(2,'coder',true);
    INSERT INTO mcp_service_bundles VALUES(50),(3),(4);
  `);
  const now = Math.floor(Date.now()/1000), threadId=randomUUID(), runId=randomUUID(), jti=randomUUID();
  const secret='disposable-'+randomUUID();
  const c={v:1,jti,iss:'argus.core',aud:'argus.dev',agent:'coding-orchestrator',sub:'user:3',principalKind:'user',principalId:'3',
    tenantKey:'default',workspaceKey:'default',bundleIds:[50,3,4],coreAgentIds:[2],coreAgents:[{id:2,name:'coder'}],
    messageId:randomUUID(),rootTraceId:threadId,workspaceRoot:'/workspace/RENEWAL-CERT',executionSurface:'agent',policy:'mcp-bundle-v1',iat:now-7200,exp:now-3600};
  await pool.query(`INSERT INTO argus_langgraph_threads VALUES($1,'coding_workflow','running',$2)`,[threadId,{source:'a2a',execution_grant_id:jti,execution_principal:'user:3',execution_bundle_ids:c.bundleIds}]);
  await pool.query(`INSERT INTO argus_langgraph_runs VALUES($1,$2,'running',to_timestamp($3))`,[runId,threadId,c.iat]);
  await pool.query(`INSERT INTO argus_execution_grants VALUES($1,'active',$2,'argus.dev','coding-orchestrator','user','3','default','default','{50,3,4}','{2}',NULL,to_timestamp($3))`,[jti,threadId,c.exp]);
  const input={grant:signExecutionGrant(secret,c),threadId,runId};
  const auditCount=async()=>Number((await pool.query('SELECT count(*) n FROM mcp_canonical_audit_events')).rows[0].n);
  const tokens=await Promise.all([1,2,3].map(()=>renewDevGrant(pool,secret,input)));
  assert.equal(new Set(tokens).size,1); assert.equal(await auditCount(),1);
  const fresh=verifyExecutionGrant(secret,tokens[0]); assert.deepEqual(fresh,{...c,iat:fresh.iat,exp:fresh.exp});
  await assertExecutionGrantActive(pool,jti); assert.throws(()=>verifyExecutionGrant(secret,input.grant),/expired/);
  assert.equal(Number((await pool.query('SELECT count(*) n FROM mcp_canonical_audit_outbox')).rows[0].n),1);
  await pool.query('UPDATE argus_execution_grants SET expires_at=to_timestamp($2) WHERE grant_id=$1',[jti,c.exp]);
  await new Promise(resolve=>setTimeout(resolve,1100)); // distinct renewal event for rollback injection
  await assert.rejects(renewDevGrant(pool,secret,input,async (...args)=>{ await appendCanonicalAuditEvent(...args); throw Error('injected audit failure'); }));
  assert.equal((await pool.query('SELECT extract(epoch from expires_at)::bigint e FROM argus_execution_grants')).rows[0].e,String(c.exp));
  assert.equal(await auditCount(),1,'audit/outbox/renewal rollback together');
  await pool.query("UPDATE argus_execution_grants SET status='revoked'");
  await assert.rejects(renewDevGrant(pool,secret,input)); await assert.rejects(assertExecutionGrantActive(pool,jti));
  await pool.query("UPDATE argus_execution_grants SET status='active'");
  for(const status of ['failed','interrupted','canceled','canceling','queued','completed','waiting_external_ci']){
    await pool.query('UPDATE argus_langgraph_threads SET status=$1',[status]); await assert.rejects(renewDevGrant(pool,secret,input));
  }
  await pool.query("UPDATE argus_langgraph_threads SET status='running'; INSERT INTO mcp_user_agent_rules VALUES(3,2,'deny',NULL)");
  await assert.rejects(renewDevGrant(pool,secret,input)); assert.equal(await auditCount(),1);
  console.log('PASS: concurrent same-scope renewal is one atomic lease/audit/outbox; original bearer remains expired; revocation, stopped execution and agent denials block; injected audit failure rolls back the lease. Disposable PostgreSQL, no live services mutated.');
} finally { await pool?.end(); if(created) execFileSync('docker',['stop',name],{stdio:'pipe'}); }
