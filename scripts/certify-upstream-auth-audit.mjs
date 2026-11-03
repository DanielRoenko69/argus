// Disposable PostgreSQL only: production audit writer + migration 267.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import { insertAuditRow, verifyAuditChain } from '../dist/audit/immutableAudit.js';
import { persistPlatformConfig, loadAllPlatformConfigs, setUpstreamTokenExchangeConfig, getUpstreamTokenExchangeConfig } from '../dist/lib/platformConfig.js';

const name = `argus-oauth-audit-cert-${randomBytes(5).toString('hex')}`;
const docker = args => execFileSync('docker', args, { encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:30_000 });
const migration = file => readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8');
const entry = eventType => ({eventType,apiKeyPrefix:'fixture',model:'',userId:3,errorType:'backend:110:identity:user-oauth'});
let pool, created = false;
try {
  docker(['run','--detach','--rm','--name',name,'--label','io.argus.oauth-audit-cert=true','--memory','192m',
    '-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432','postgres:16-alpine']);
  created = true;
  const port = JSON.parse(docker(['inspect',name]))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  pool = new pg.Pool({host:'127.0.0.1',port:Number(port),user:'postgres',database:'postgres',connectionTimeoutMillis:1000});
  const deadline = Date.now()+60_000;
  for (;;) {
    try { await pool.query('SELECT 1'); break; }
    catch { if(Date.now()>deadline)throw Error('Disposable database unavailable'); await new Promise(r=>setTimeout(r,250)); }
  }
  for (const file of ['058_immutable_audit_log.sql','095_audit_log_immutable_trigger.sql','109_audit_hash_chain.sql']) {
    await pool.query(await migration(file));
  }
  const oldSql = await migration('116_public_widgets.sql');
  await pool.query(oldSql.slice(oldSql.indexOf('ALTER TABLE mcp_immutable_audit_log')));
  const oldTypes = [...oldSql.slice(oldSql.indexOf('CHECK (event_type')).matchAll(/'([a-z_]+)'/g)].map(m=>m[1]);
  for(const type of oldTypes)await insertAuditRow(pool,entry(type));
  const before = (await pool.query('SELECT * FROM mcp_immutable_audit_log ORDER BY id')).rows;
  await assert.rejects(insertAuditRow(pool,entry('upstream_auth_selected')), {code:'23514'});
  const sql = await migration('267_upstream_auth_selected_audit.sql');
  for(let i=0;i<2;i++) {
    await pool.query('BEGIN'); await pool.query(sql); await pool.query('COMMIT');
  }
  assert.deepEqual((await pool.query('SELECT * FROM mcp_immutable_audit_log ORDER BY id')).rows,before);
  const types = [...sql.matchAll(/'([a-z_]+)'/g)].map(m=>m[1]);
  assert.deepEqual(types,[...oldTypes,'upstream_auth_selected']);
  for(const type of types)await insertAuditRow(pool,entry(type));
  await assert.rejects(insertAuditRow(pool,entry('unknown_event')), {code:'23514'});
  await assert.rejects(pool.query("UPDATE mcp_immutable_audit_log SET model='changed' WHERE id=1"), /append-only/);
  await assert.rejects(pool.query('DELETE FROM mcp_immutable_audit_log WHERE id=1'), /append-only/);
  await assert.rejects(pool.query('TRUNCATE mcp_immutable_audit_log'), /append-only/);
  const chain = await verifyAuditChain(pool); assert.equal(chain.ok,true);
  await pool.query(`CREATE TABLE mcp_platform_settings (
    category TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY(category,key))`);
  for (const enabled of [true, false]) {
    await persistPlatformConfig(pool,'upstream_token_exchange',{enabled});
    setUpstreamTokenExchangeConfig({enabled:!enabled});
    await loadAllPlatformConfigs(pool);
    assert.equal(getUpstreamTokenExchangeConfig().enabled,enabled);
  }
  console.log(JSON.stringify({status:'passed',checks:['pre_upgrade_denial','migration_267','repeat_safe',
    'old_rows_unchanged','all_event_types','unknown_denied','append_only','hash_chain','jsonb_config_reload'],chainRows:chain.checked,
    scope:'disposable database only; no live tokens or providers'}));
} catch { process.stderr.write('Upstream audit certification failed; no provider call was made.\n'); process.exitCode=1; }
finally { await pool?.end(); if(created)docker(['rm','--force',name]); }
