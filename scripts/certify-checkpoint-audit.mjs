// Real PostgreSQL regression, isolated in a transaction-local temporary table.
// Does not insert, alter or delete public audit rows or change the migration ledger.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
const sql=readFileSync(process.argv[2]??0,'utf8');
if(!process.env.POSTGRES_CONNECTION_URL)throw Error('POSTGRES_CONNECTION_URL is required');
const pool=new pg.Pool({connectionString:process.env.POSTGRES_CONNECTION_URL,max:1});
const client=await pool.connect();
try{
 await client.query('BEGIN');
 await client.query('CREATE TEMP TABLE mcp_admin_audit_log (id BIGINT PRIMARY KEY, action VARCHAR(32) NOT NULL, after_state JSONB) ON COMMIT DROP');
 const oid=(await client.query("SELECT 'pg_temp.mcp_admin_audit_log'::regclass::oid AS oid")).rows[0].oid;
 assert.equal((await client.query("SELECT 'mcp_admin_audit_log'::regclass::oid AS oid")).rows[0].oid,oid);
 await client.query('INSERT INTO mcp_admin_audit_log VALUES (1,$1,$2)', ['created',JSON.stringify({preserved:true})]);
 const action='workflow_checkpoint_retry_requested';
 await client.query('SAVEPOINT old_limit');
 await assert.rejects(client.query('INSERT INTO mcp_admin_audit_log VALUES (2,$1,NULL)',[action]),{code:'22001'});
 await client.query('ROLLBACK TO SAVEPOINT old_limit');
 await client.query(sql);
 await client.query(sql); // The widening itself is idempotent.
 await client.query('INSERT INTO mcp_admin_audit_log VALUES (2,$1,NULL)',[action]);
 assert.deepEqual((await client.query('SELECT id::int,action,after_state FROM mcp_admin_audit_log ORDER BY id')).rows,
  [{id:1,action:'created',after_state:{preserved:true}},{id:2,action,after_state:null}]);
 assert.equal((await client.query("SELECT atttypmod-4 AS length,attnotnull FROM pg_attribute WHERE attrelid=$1 AND attname='action'",[oid])).rows[0].length,128);
 assert.equal((await client.query("SELECT attnotnull FROM pg_attribute WHERE attrelid=$1 AND attname='action'",[oid])).rows[0].attnotnull,true);
 console.log(JSON.stringify({passed:true,oldLimitReproduced:true,fullActionRetained:true,existingRowsPreserved:true,publicAuditUntouched:true}));
}finally{await client.query('ROLLBACK');client.release();await pool.end();}
