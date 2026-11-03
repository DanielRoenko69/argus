// Run only in a disposable Workspace image, without real volumes/credentials.
// Uses the compiled production runner, no models or Argus/Gitea/Jenkins calls.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { runExperiment } from '/app/dist/routes/technicalExperiment.js';

assert.equal(process.env.ARGUS_DISPOSABLE_EXPERIMENT_CERT, 'true');
const id = randomUUID();
const root = `/workspace/experiment-cert-${id}`;
const store = `/runtime/experiment-cert-${id}`;
const privateRoot = `/tmp/experiment-private-${id}`;
const server = createServer(socket => { socket.on('error', () => {}); socket.end('canary'); });
try {
  await mkdir(root); await mkdir(privateRoot);
  await writeFile(`${privateRoot}/credential.txt`, 'synthetic-secret-never-print');
  await writeFile(`${root}/fixture.py`, 'ANSWER = 42\n');
  await writeFile(`${root}/banner.jpg`, Buffer.alloc(5065965, 7));
  await writeFile(`${root}/.env`, 'SYNTHETIC_PRIVATE=hidden\n');
  await symlink(`${privateRoot}/credential.txt`, `${root}/outside-link`);
  const git = args => execFileSync('git', args, {cwd:root,encoding:'utf8'}).trim();
  git(['init','-q']);git(['add','.']);git(['-c','user.email=fixture@invalid','-c','user.name=Fixture','commit','-qm','fixture']);
  let head = git(['rev-parse','HEAD']);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  await new Promise((resolve,reject) => {const socket=connect(server.address().port,'127.0.0.1',()=>{socket.destroy();resolve();});socket.on('error',reject);});
  const request = script => ({threadId:randomUUID(),workspaceRoot:root,baseCommitSha:head,basisSha256:'a'.repeat(64),
    requestSha256:createHash('sha256').update(script).digest('hex'),script});
  const script = `import json, pathlib, socket, subprocess, os, sys, resource
import fixture
r = {'answer': fixture.ANSWER, 'env_clean': 'WORKSPACE_SECRET' not in os.environ, 'banner_bytes': len(pathlib.Path('/repo/banner.jpg').read_bytes())}
for name, target in [('host_secret', ${JSON.stringify(`${privateRoot}/credential.txt`)}), ('host_workspace', ${JSON.stringify(root)}), ('git', '/repo/.git'), ('hidden', '/repo/.env'), ('link', '/repo/outside-link'), ('runtime_home', '/home/node/.codex'), ('parent_proc', '/proc/1/root${privateRoot}/credential.txt')]:
 r[name] = pathlib.Path(target).exists()
try:
 pathlib.Path('/repo/fixture.py').write_text('changed'); r['repo_write'] = True
except OSError: r['repo_write'] = False
pathlib.Path('/tmp/cache.txt').write_text('ok'); r['scratch_write'] = True
try:
 s=socket.create_connection(('127.0.0.1', ${server.address().port}), timeout=1); s.close(); r['network'] = True
except OSError: r['network'] = False
try:
 subprocess.run(['/usr/bin/true'], check=True); r['subprocess'] = True
except OSError: r['subprocess'] = False
r['memory_hard_limit'] = resource.getrlimit(resource.RLIMIT_AS)[1]
print(json.dumps(r))
`;
  const input=request(script);
  const result=await runExperiment(input,undefined,store);
  assert.equal(result.status,'completed',result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{answer:42,env_clean:true,banner_bytes:5065965,host_secret:false,host_workspace:false,git:false,
    hidden:false,link:false,runtime_home:false,parent_proc:false,repo_write:false,scratch_write:true,network:false,subprocess:false,memory_hard_limit:536870912});
  assert.equal(result.excludedFiles,2);
  if (process.env.ARGUS_EXPERIMENT_CERT_SCIENTIFIC === 'true') {
    const science = await runExperiment(request(`import json, numpy as np, scipy, gymnasium
from scipy.integrate import solve_ivp
r=solve_ivp(lambda t,y: -y, (0,1), [1.0], rtol=1e-8, atol=1e-10)
assert abs(r.y[0,-1]-np.exp(-1)) < 1e-7
print(json.dumps({'numpy':np.__version__,'scipy':scipy.__version__,'gymnasium':gymnasium.__version__,'fixture_passed':True}))
`), undefined, store);
    assert.equal(science.status, 'completed', science.stderr);
    assert.equal(JSON.parse(science.stdout).fixture_passed, true);
    console.log(JSON.stringify({ scientificDependencyProbe: JSON.parse(science.stdout), claim: 'synthetic ODE fixture only, not GEM acceptance' }));
  }
  assert.equal(await readFile(`${root}/fixture.py`,'utf8'),'ANSWER = 42\n');
  assert.equal(git(['status','--porcelain']), '');
  assert.deepEqual(await runExperiment(input,undefined,store),result,'replay must return the same terminal receipt without executing');
  await assert.rejects(runExperiment({...input,script:'print(1)'},undefined,store),/identity_changed/);
  const partial=request('print(2)');await mkdir(`${store}/${partial.threadId}`);
  await writeFile(`${store}/${partial.threadId}/intent.json`,JSON.stringify({...partial,scriptSha256:createHash('sha256').update(partial.script).digest('hex')}));
  await assert.rejects(runExperiment(partial,undefined,store),/interrupted_no_replay/);
  const flood=await runExperiment(request('print("x" * 100000)'),undefined,store);
  assert.equal(flood.status,'output_limit');
  assert.ok(Buffer.byteLength(flood.stdout)+Buffer.byteLength(flood.stderr)<=32768);
  const memory=await runExperiment(request('a = bytearray(1024 * 1024 * 1024)'),undefined,store);
  assert.equal(memory.status,'failed');assert.match(memory.stderr,/MemoryError/);
  const cancel = new AbortController();
  const cancelled=runExperiment(request('import time; time.sleep(35)'),cancel.signal,store);
  setTimeout(()=>cancel.abort(),500);
  assert.equal((await cancelled).status,'canceled');
  const timeout=await runExperiment(request('import time; time.sleep(35)'),undefined,store);
  assert.equal(timeout.status,'timeout');
  await writeFile(`${root}/oversized.jpg`, Buffer.alloc(16 * 1048576 + 1, 9));
  git(['add','oversized.jpg']); git(['-c','user.email=fixture@invalid','-c','user.name=Fixture','commit','-qm','oversized fixture']);
  head = git(['rev-parse','HEAD']);
  const oversized = request('raise RuntimeError("must never execute")');
  const rejected = await runExperiment(oversized, undefined, store);
  assert.equal(rejected.status, 'preparation_failed'); assert.equal(rejected.executionStarted, false);
  assert.equal(rejected.reason, 'snapshot_file_size_limit'); assert.equal(rejected.filePath, 'oversized.jpg');
  await assert.rejects(access(`${store}/${oversized.threadId}`), { code: 'ENOENT' });
  assert.equal(git(['status','--porcelain']), '');
  // Old uncertain intents are still refused even when the current tree fails preflight.
  await assert.rejects(runExperiment(partial,undefined,store),/interrupted_no_replay/);
  console.log(JSON.stringify({passed:true,providerCalls:0,checks:['actual Python calculation','read-only committed snapshot','no hidden/symlink/.git/runtime-home/host-proc reads','no network','ephemeral scratch','no subprocesses','memory/output/time bounds','cancel','immutable replay','interrupted refusal','workspace unchanged']}));
} finally {
  await new Promise(resolve=>server.close(resolve));
  for (const dir of [root,store,privateRoot]) await rm(dir,{recursive:true,force:true}); // exact fixture-owned paths only
}
