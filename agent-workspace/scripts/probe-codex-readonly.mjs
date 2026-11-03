/** Provider-free probe inside the target Agent Workspace image.
 * Uses only a fresh fixture directory and a loopback canary server. No secrets,
 * model calls, existing workspaces or runtime configuration are read or changed.
 * Run: docker exec -i <workspace-container> node --input-type=module < this-file
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { assertCodexSandboxHelper, codexSandboxPath } from '/app/dist/routes/codexSandbox.js';

const root = await mkdtemp('/workspace/argus-readonly-probe-');
const server = createServer(socket => { socket.on('error', () => {}); socket.end('fixture'); });
const execute = (binary, args, env) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderrBytes = 0;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderrBytes }); });
});
try {
  await assertCodexSandboxHelper();
  await mkdir(`${root}/home`);
  await writeFile(`${root}/canary.txt`, 'unchanged');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const script = `import json, socket, pathlib
p = pathlib.Path(${JSON.stringify(`${root}/canary.txt`)})
result = {'read': p.read_text() == 'unchanged'}
try:
 p.write_text('changed'); result['write'] = True
except OSError:
 result['write'] = False
try:
 s = socket.create_connection(('127.0.0.1', ${server.address().port}), timeout=2); s.close(); result['network'] = True
except OSError:
 result['network'] = False
print(json.dumps(result))
`;
  // Deliberately do not inherit authentication or workspace service secrets.
  const env = { PATH: codexSandboxPath(process.env.PATH), HOME: `${root}/home`, LANG: 'C.UTF-8' };
  const control = await execute('python3', ['-c', script], env);
  assert.equal(control.status, 0);
  assert.deepEqual(JSON.parse(control.stdout), { read: true, write: true, network: true });
  await writeFile(`${root}/canary.txt`, 'unchanged');
  const sandbox = await execute('/app/node_modules/.bin/codex',
    ['sandbox', '-c', 'sandbox_mode="read-only"', '--', 'python3', '-c', script], env);
  assert.equal(sandbox.status, 0, 'sandbox must execute the read probe, not merely crash');
  assert.deepEqual(JSON.parse(sandbox.stdout), { read: true, write: false, network: false });
  assert.equal(await readFile(`${root}/canary.txt`, 'utf8'), 'unchanged');
  console.log(JSON.stringify({ passed: true, providerCalls: 0, control: JSON.parse(control.stdout),
    sandbox: JSON.parse(sandbox.stdout), boundary: 'target CLI read-only sandbox, not a live workflow certification' }));
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true }); // Only this mkdtemp-owned fixture.
}
