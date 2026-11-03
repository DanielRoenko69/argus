// Disposable PostgreSQL only. No credentials, live model calls or production data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { planModelRetirement,retireModels } from '../dist/llm/modelRetirement.js';
import { deleteLlmModel } from '../dist/llm/modelRegistry.js';

const connection=process.env.MODEL_RETIREMENT_CERT_DATABASE_URL;
if (!connection || !['127.0.0.1','localhost','[::1]'].includes(new URL(connection).hostname)
  || !new URL(connection).pathname.endsWith('_cert')) throw new Error('Explicit loopback *_cert database required.');
const pool=new pg.Pool({ connectionString:connection,max:3,connectionTimeoutMillis:5000 });
const scope={ environment:'test' },checks=[];
const check=async (name,run) => { await run();checks.push(name); };
const plan=async (names=['old-a','old-b']) => {
  const client=await pool.connect();
  try { return await planModelRetirement(client,names,scope); } finally { client.release(); }
};
try {
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'Fresh disposable DB required');
  for (const file of ['220_canonical_audit_events.sql','221_scope_canonical_audit_idempotency.sql']) {
    await pool.query(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
  }
  await pool.query(`CREATE TABLE mcp_models(id int PRIMARY KEY,model_name text,display_name text,
    provider_id int,upstream_model_name text,enabled boolean,updated_at timestamptz DEFAULT now());
    CREATE TABLE mcp_agent_runtime_profiles(id int PRIMARY KEY,runtime_type text,enabled boolean,model text);
    CREATE TABLE mcp_agents(id int PRIMARY KEY,name text,model text,runtime_profile_id int,enabled boolean DEFAULT true);
    CREATE TABLE historical_fixture(id int,model text,answer text);
    INSERT INTO mcp_models(id,model_name) VALUES (1,'old-a'),(2,'old-b');
    INSERT INTO mcp_agent_runtime_profiles VALUES (1,'codex',true,'current'),(2,'claude-code',true,'current'),
      (3,'hermes',true,'current'),(4,'argus',true,'api'),(5,'codex',false,'current'),
      (6,'codex',true,' '),(7,'future-runtime',true,'current');
    INSERT INTO mcp_agents VALUES (1,'coder','old-a',1,true),(2,'reviewer','old-b',2,true),(3,'dev','old-a',3,true);
    INSERT INTO historical_fixture VALUES (1,'old-a','Keep the historical answer');`);
  await check('external profile references do not block; dry-run changes no rows',async () => {
    assert.equal((await plan()).removable,true);
    assert.equal((await pool.query('SELECT count(*)::int n FROM mcp_models')).rows[0].n,2);
  });
  await check('native, disabled, incomplete, unknown and missing profiles all block (even disabled Agents)',async () => {
    for (const runtime of [null,4,5,6,7,99]) {
      await pool.query("INSERT INTO mcp_agents VALUES (4,'blocked','old-a',$1,false)",[runtime]);
      const p=await plan();assert.equal(p.removable,false);assert.deepEqual(p.blocking_agent_ids,[4]);
      await assert.rejects(() => deleteLlmModel(pool,1),/API-Modell/);
      await pool.query('DELETE FROM mcp_agents WHERE id=4');
    }
  });
  await check('reviewed hash rejects configuration drift atomically',async () => {
    const before=await plan();
    await pool.query("UPDATE mcp_agent_runtime_profiles SET model='new-current' WHERE id=1");
    await assert.rejects(() => retireModels(pool,before.aliases,before.sha256,scope),/changed/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM mcp_models')).rows[0].n,2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM mcp_canonical_audit_events')).rows[0].n,0);
  });
  await check('audit insertion failure rolls back the entire model batch',async () => {
    const p=await plan();
    await pool.query("ALTER TABLE mcp_canonical_audit_outbox ADD CONSTRAINT fixture_reject CHECK (topic<>'audit.canonical.v1')");
    await assert.rejects(() => retireModels(pool,p.aliases,p.sha256,scope));
    assert.equal((await pool.query('SELECT count(*)::int n FROM mcp_models')).rows[0].n,2);
    assert.equal((await pool.query('SELECT count(*)::int n FROM mcp_canonical_audit_events')).rows[0].n,0);
    await pool.query('ALTER TABLE mcp_canonical_audit_outbox DROP CONSTRAINT fixture_reject');
  });
  await check('atomic retirement preserves profiles, Agents and history and records an honest operator identity',async () => {
    const preserved=async () => Promise.all(['mcp_agents','mcp_agent_runtime_profiles','historical_fixture']
      .map(async table => (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
    const before=await preserved(),p=await plan();
    const result=await retireModels(pool,p.aliases,p.sha256,scope);
    assert.equal(result.replayed,false);assert.equal(result.event.actor.type,'system');
    assert.equal(result.event.actor.authMethod,'database-operator');
    assert.equal((await pool.query('SELECT count(*)::int n FROM mcp_models')).rows[0].n,0);
    assert.deepEqual(await preserved(),before);
    const replay=await retireModels(pool,p.aliases,p.sha256,scope);
    assert.equal(replay.replayed,true);assert.equal(replay.event.eventId,result.event.eventId);
    assert.equal((await pool.query('SELECT count(*)::int n FROM mcp_canonical_audit_events')).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM mcp_canonical_audit_outbox')).rows[0].n,1);
  });
  console.log(JSON.stringify({ status:'passed',checks },null,2));
} finally { await pool.end(); }
