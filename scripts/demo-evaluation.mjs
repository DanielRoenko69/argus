#!/usr/bin/env node
// Windows/macOS/Linux: owns exactly one ephemeral PostgreSQL container. Never uses .env / production DB URLs.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
const options=new Set(process.argv.slice(2));
if([...options].some(o => !['--check','--skip-build','--all-gates','--codex-only'].includes(o))) throw new Error('Options: --check, --all-gates, --skip-build, --codex-only (token-free runtime DB gate)');
const owner=randomUUID(),name='argus-eval-demo-'+owner.slice(0,8),password=randomUUID(),image='pgvector/pgvector:pg16';
let ownedId,active,stopping=false;
const stop=() => { stopping=true; if(active?.connected) active.send('stop'); else active?.kill('SIGTERM'); };
process.on('SIGINT',stop);process.on('SIGTERM',stop);
async function run(executable,args,{ capture=false,env=process.env,ipc=false,cleanup=false }={}) {
  if(stopping && !cleanup) throw new Error('Demo stopped');
  return new Promise((done,reject) => {
    const child=spawn(executable,args,{ cwd:root,env,windowsHide:true,stdio:['ignore',capture?'pipe':'inherit',capture?'pipe':'inherit',...(ipc?['ipc']:[])] });
    active=child;let output='',errors='';
    child.stdout?.on('data',d => { output+=d; });child.stderr?.on('data',d => { errors+=d; });
    child.once('error',reject);child.once('exit',code => { if(active===child)active=null;code===0 ? done(output.trim()) : reject(new Error(`${executable} failed (${code}): ${errors.slice(0,1000)}`)); });
  });
}
const npmCli=process.env.npm_execpath || resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
try {
  if(!existsSync('node_modules') || !existsSync('argus-console/node_modules')) throw new Error('Install dependencies first: npm ci && npm --prefix argus-console ci');
  await run('docker',['info','--format','{{.ServerVersion}}'],{ capture:true });
  if(!options.has('--skip-build')) {
    if(!existsSync(npmCli)) throw new Error('Start through npm run demo:evaluation so npm can be located.');
    await run(process.execPath,[npmCli,'run','build','--silent']);
    await run(process.execPath,[npmCli,'--prefix','argus-console','run','build','--silent']);
  }
  // Image VOLUME is anonymous; --rm also removes it. No host bind mount, named volume or production port.
  ownedId=await run('docker',['run','--rm','-d','--name',name,'--label',`argus.evaluation-demo.owner=${owner}`,
    '--memory','768m','--cpus','1','-p','127.0.0.1::5432','-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=evaluation_cert',image],{ capture:true });
  if(!/^[a-f0-9]{64}$/.test(ownedId)) throw new Error('Unexpected container identity');
  const binding=await run('docker',['port',ownedId,'5432/tcp'],{ capture:true });
  const port=/^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];if(!port)throw new Error('Expected loopback-only port');
  const connection=`postgresql://postgres:${password}@127.0.0.1:${port}/evaluation_cert`;
  const pool=new pg.Pool({ connectionString:connection,max:1,connectionTimeoutMillis:1000 });
  try {
    let ready=false;
    for(let i=0;i<40 && !stopping;i++) { try { await pool.query('SELECT 1');ready=true;break; } catch { await new Promise(r => setTimeout(r,500)); } }
    if(!ready)throw new Error('Disposable PostgreSQL did not become ready');
  } finally { await pool.end(); }
  await run('docker',['cp',resolve('db/init.sql'),`${ownedId}:/tmp/argus-init.sql`],{ capture:true });
  await run('docker',['exec',ownedId,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','evaluation_cert','-f','/tmp/argus-init.sql'],{ capture:true });
  const env={ ...process.env,LOG_LEVEL:'warn',NODE_ENV:'test',ARGUS_ENVIRONMENT:'test',EVALUATION_CERTIFICATION_DATABASE_URL:connection,
    MIGRATION_CERTIFICATION_DATABASE_URL:connection,MIGRATION_CERTIFICATION_REQUIRED:'1' };
  await run(process.execPath,['scripts/certify-migrations.mjs'],{ env });
  if(options.has('--codex-only')) {
    await run(process.execPath,['scripts/certify-evaluation-codex.mjs'],{ env });
  } else {
  if(options.has('--all-gates')) for(const gate of ['foundation','execution','recovery','comparisons']) await run(process.execPath,[`scripts/certify-evaluation-${gate}.mjs`],{ env });
  await run(process.execPath,['scripts/evaluation-certification.mjs'],{ env });
  console.log(`\nOwned disposable container: ${name}\nSynthetic local demo. No real model calls or live SSO.\n`);
  await run(process.execPath,['scripts/certify-evaluation-authoring.mjs',options.has('--check')?'--browser':'--serve-demo'],{ env,ipc:true });
  }
} catch(error) {
  console.error(stopping ? 'Stopping demo.' : error.message.replaceAll(password,'[redacted]'));
  if(!stopping)process.exitCode=1;
} finally {
  if(ownedId && /^[a-f0-9]{64}$/.test(ownedId)) {
    // Verify exact ownership before any destructive container action.
    const label=await run('docker',['inspect','--format','{{index .Config.Labels "argus.evaluation-demo.owner"}}',ownedId],{ capture:true,cleanup:true }).catch(() => null);
    if(label===owner) { await run('docker',['stop','--time','5',ownedId],{ capture:true,cleanup:true });console.log('Removed this disposable demo database/container. Export files remain in test-results/.'); }
    else console.error(`Ownership could not be verified; no container removed. Inspect ${name} manually.`);
  }
}
