import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const id = `cert-${randomBytes(6).toString('hex')}`;
const directory = await mkdtemp(path.join(tmpdir(), id));
const secret = path.join(directory, 'secret');
await writeFile(secret, randomBytes(32).toString('hex'), { mode: 0o644, flag: 'wx' });
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 256000, stdio: ['ignore', 'pipe', 'pipe'] });
const proxy = `${id}-egress`, controller = `${id}-controller`, worker = `${id}-workspace`;
const publicNet = `${id}-public`, controlNet = `${id}-control`, names = [];
try {
  docker(['network', 'create', publicNet]); docker(['network', 'create', '--internal', controlNet]);
  names.push(proxy);
  docker(['run', '-d', '--name', proxy, '--network', publicNet, '--read-only', '--cap-drop', 'ALL', '--memory', '96m', 'argus-stack-egress:20260929-vendor-domains']);
  const base = docker(['image', 'inspect', 'argus-stack-base:20260928', '--format', '{{.Id}}']).trim();
  const socket = JSON.parse(docker(['context', 'inspect']))[0].Endpoints.docker.Host.replace(/^unix:\/\//, '');
  if (!socket.startsWith('/')) throw new Error('Local Unix Docker socket required');
  names.push(controller);
  docker(['run', '-d', '--name', controller, '--network', controlNet, '--network-alias', 'stack-runner', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--pids-limit', '64', '--tmpfs', '/receipts:mode=0700,size=128m',
    '-v', `${socket}:/var/run/docker.sock`, '-v', `${secret}:/run/secrets/stack_runner:ro`,
    '-e', `ARGUS_STACK_BASE_IMAGE=${base}`, '-e', `ARGUS_STACK_EGRESS_CONTAINER=${proxy}`, '-e', `ARGUS_STACK_INSTANCE=${id}`,
    'argus-stack-controller-codegen:20260929']);
  names.push(worker);
  process.stdout.write(docker(['run', '--name', worker, '--network', controlNet, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--pids-limit', '64',
    '--tmpfs', '/workspace:uid=1000,gid=1000,mode=0700,size=64m', '--tmpfs', '/runtime:uid=1000,gid=1000,mode=0700,size=64m',
    '-v', `${secret}:/run/secrets/stack_runner:ro`, 'argus-codegen-bridge-cert:20260929']));
} catch (error) {
  process.stderr.write(String(error.stderr ?? error.message).slice(-16000) + '\n'); process.exitCode = 1;
} finally {
  for (const name of names.reverse()) { try { docker(['rm', '-f', name]); } catch {} }
  // Only this synthetic fixture's exact, labelled retained images.
  const images = docker(['image', 'ls', '-q', '--filter', `label=io.argus.disposable-stack=${id}`]).trim().split(/\s+/).filter(Boolean);
  for (const image of images) { try { docker(['image', 'rm', image]); } catch {} }
  for (const network of [controlNet, publicNet]) { try { docker(['network', 'rm', network]); } catch {} }
  await rm(directory, { recursive: true, force: true });
}
