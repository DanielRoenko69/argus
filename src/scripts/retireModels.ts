import dotenv from 'dotenv';
import pg from 'pg';
import { planModelRetirement, retireModels, retirementNames } from '../llm/modelRetirement.js';

// Opt-in operator command. Never run from startup, a migration or a demo seed.
dotenv.config({ quiet:true });
const args=process.argv.slice(2),names:string[]=[];
let reviewed:string|undefined;
for (let i=0;i<args.length;i++) {
  if (args[i]==='--model' && args[i+1]) names.push(args[++i]!);
  else if (args[i]==='--apply' && args[i+1] && !reviewed) reviewed=args[++i];
  else throw new Error('Usage: --model <exact-alias> [--model <alias>] [--apply <reviewed-sha256>]');
}
retirementNames(names);
const connectionString=process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'];
if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required.');
const pool=new pg.Pool({ connectionString,max:1 });
const scope={ environment:process.env['ARGUS_ENVIRONMENT'] ?? process.env['NODE_ENV'] ?? 'development' };
try {
  if (reviewed) {
    const applied=await retireModels(pool,names,reviewed,scope);
    console.log(JSON.stringify({ status:applied.replayed ? 'already_applied' : 'applied',
      event_id:applied.event.eventId,reviewed_sha256:reviewed,
      removed:applied.result?.models.map(m => ({ id:m.id,model:m.model_name })) ?? [] },null,2));
  } else {
    const client=await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      console.log(JSON.stringify(await planModelRetirement(client,names,scope),null,2));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
} catch {
  // Raw DB errors may contain connection information. Fail closed without dumping them.
  console.error('Model retirement was not confirmed. Check dependencies, audit health and the reviewed hash. After an uncertain connection failure, retry only with the same reviewed hash.');
  process.exitCode=1;
} finally { await pool.end(); }
