// Real Docker fixtures only; no live Argus run, model or credential access.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 256000, stdio: ['ignore', 'pipe', 'pipe'] });
const owner = `workspace-cert-${randomUUID().slice(0, 8)}`;
const controller = `${owner}-controller`;
const fastapi = process.argv.includes('--fastapi');
const database = process.argv.includes('--database') || fastapi ? `${owner}-database` : null;
let fixtureDirectory;
try {
  const context = JSON.parse(docker(['context', 'inspect']))[0].Endpoints.docker.Host;
  if (!context.startsWith('unix:///')) throw new Error('A local Docker Unix socket is required.');
  const socket = context.slice('unix://'.length);
  const base = docker(['image', 'inspect', process.env.ARGUS_WORKSPACE_CERT_BASE_IMAGE || 'argus-stack-base:20260928', '--format', '{{.Id}}']).trim();
  const candidate = fileURLToPath(new URL('../project-environments', import.meta.url));
  if (fastapi) {
    const option = name => process.argv.find(a => a.startsWith(name + '='))?.slice(name.length + 1);
    const container = option('--source-container');
    const directory = option('--source-directory');
    if (!container || !directory?.startsWith('/workspace/')) throw new Error('FastAPI check requires --source-container and an exact /workspace/ --source-directory.');
    // Read only tracked, selected project files. Never copy .git, .env, auth,
    // untracked outputs/dependencies, or private workspace/runtime directories.
    const extraction = `
const fs = require('node:fs'); const cp = require('node:child_process');
const root = fs.realpathSync(process.argv[1]);
if (!root.startsWith('/workspace/') || root.split('/').some(p => p.startsWith('.'))) throw new Error('Fixture checkout must stay inside /workspace');
const names = cp.execFileSync('git', ['ls-files','-z','--','pyproject.toml','uv.lock','bun.lock','package.json','biome.json','backend','frontend','packages','scripts/generate-client.sh'], {cwd:root, encoding:'utf8'}).split('\\0').filter(Boolean);
let size = 0;
const source = names.filter(p => p.split('/').every(part => part && !part.startsWith('.') && !['node_modules','secrets','__pycache__','graphify-out'].includes(part)) && !/\\.(pem|key|p12|pfx)$/i.test(p)).sort().map(path => {
  const file = root + '/' + path; const st = fs.lstatSync(file);
  if (!st.isFile() || fs.realpathSync(file) !== file || st.size > 16*1024**2 || (size += st.size) > 64*1024**2) throw new Error('Unsupported fixture source');
  return {path, content:fs.readFileSync(file).toString('base64')};
});
process.stdout.write(JSON.stringify({baseCommitSha:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),source}));`;
    const archive = execFileSync('docker', ['exec', container, 'node', '-e', extraction, directory], {encoding:'utf8', maxBuffer:90*1024**2});
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'argus-fastapi-cert-'));
    writeFileSync(join(fixtureDirectory, 'source.json'), archive, {mode:0o600});
    const summary = JSON.parse(archive);
    console.log(JSON.stringify({fixture:'fastapi', baseCommitSha:summary.baseCommitSha, files:summary.source.length, source:'tracked checkout copy; no credentials or live mutation'}));
  }
  if (database) {
    docker(['network', 'create', '--internal', '--label', `io.argus.workspace-cert=${owner}`, `${owner}-db`]);
    docker(['run', '-d', '--name', database, '--label', `io.argus.workspace-cert=${owner}`,
      '--label', 'io.argus.workspace-database=run-scoped-v1', '--network', `${owner}-db`, '--memory', '256m', '--pids-limit', '64',
      '--tmpfs', '/var/lib/postgresql:rw,size=128m',
      '--mount', `type=bind,src=${candidate}/workspace_db.pg_hba.conf,dst=/etc/argus/workspace-db.pg_hba.conf,readonly`,
      '--mount', `type=bind,src=${candidate}/workspace_db_entrypoint.sh,dst=/etc/argus/workspace-db-entrypoint.sh,readonly`,
      '--entrypoint', '/bin/sh', 'postgres:18-alpine', '/etc/argus/workspace-db-entrypoint.sh']);
    const deadline = Date.now() + 30000;
    for (;;) {
      try { docker(['exec', database, 'pg_isready', '-U', 'postgres']); break; }
      catch { if (Date.now() >= deadline) throw new Error('Disposable PostgreSQL startup timed out.'); await new Promise(r => setTimeout(r, 500)); }
    }
  }
  const output = docker(['run', '--name', controller, '--label', `io.argus.workspace-cert=${owner}`, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
    '--tmpfs', '/tmp:mode=0700,size=128m', '--mount', `type=bind,src=${candidate},dst=/candidate,readonly`,
    ...(fixtureDirectory ? ['--mount', `type=bind,src=${fixtureDirectory},dst=/fixture,readonly`] : []),
    '--mount', `type=bind,src=${socket},dst=/var/run/docker.sock`, '--workdir', '/candidate',
    '-e', `ARGUS_STACK_INSTANCE=${owner}`, '-e', 'ARGUS_WORKSPACE_SESSIONS_ENABLED=true', '-e', `ARGUS_STACK_BASE_IMAGE=${base}`,
    ...(database ? ['-e', `ARGUS_WORKSPACE_DATABASE_CONTAINER=${database}`] : []),
    '--entrypoint', 'python3', process.env.ARGUS_WORKSPACE_CERT_CONTROLLER_IMAGE || 'argus-stack-controller:20260928', '-B', fastapi ? 'certify_workspace_fastapi.py' : 'certify_workspace_session.py']);
  process.stdout.write(output);
} catch (error) {
  // Only fixture data is supplied to this process.
  if (fastapi && error.stdout) process.stderr.write(String(error.stdout).slice(-24000) + '\n');
  process.stderr.write(String(error.stderr ?? error.message).slice(-16000) + '\n');
  process.exitCode = 1;
} finally {
  // Exact test-owned controller only; Python scopes worker cleanup by owner.
  try { docker(['rm', '-f', controller]); } catch { /* no global cleanup */ }
  if (database) {
    try { docker(['rm', '-f', database]); } catch { /* own disposable DB only */ }
    try { docker(['network', 'rm', `${owner}-db`]); } catch { /* own fixture network only */ }
  }
  if (fixtureDirectory) rmSync(fixtureDirectory, {recursive:true}); // exact mkdtemp fixture copy only
}
