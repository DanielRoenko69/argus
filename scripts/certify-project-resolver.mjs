// Disposable integration environment. Never attach live runtime/credential volumes.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
const id = `argus-env-cert-${randomBytes(4).toString('hex')}`;
const temporary = await mkdtemp(path.join(tmpdir(), `${id}-`));
const secret = path.join(temporary, 'secret');
await writeFile(secret, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o644 });
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const containers = [], networks = [];
try {
  for (const kind of ['control', 'download', 'public']) {
    const net = `${id}-${kind}`;
    docker(['network', 'create', ...(kind === 'public' ? [] : ['--internal']), net]); networks.push(net);
  }
  const hardened = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64'];
  const proxy = `${id}-proxy`;
  docker(['run', '-d', '--name', proxy, ...hardened, '--memory', '96m', '--network', `${id}-public`, 'argus-environment-egress:20260928']); containers.push(proxy);
  docker(['network', 'connect', '--alias', 'environment-egress', `${id}-download`, proxy]);
  const broker = `${id}-broker`;
  docker(['run', '-d', '--name', broker, ...hardened, '--memory', '768m', '--network', `${id}-download`,
    '--tmpfs', '/cache:uid=1000,gid=1000,mode=0700,size=512m,noexec,nosuid,nodev',
    '--tmpfs', '/tmp:uid=1000,gid=1000,mode=0700,size=384m,noexec,nosuid,nodev',
    '-v', `${secret}:/run/secrets/environment_resolver:ro`, 'argus-environment-resolver:20260928']); containers.push(broker);
  docker(['network', 'connect', '--alias', 'environment-resolver', `${id}-control`, broker]);
  // Kernel/network regression: even a non-pip process cannot reach public Internet directly.
  docker(['exec', broker, 'python3', '-c', 'import socket; s=socket.socket(); s.settimeout(2); result=s.connect_ex(("1.1.1.1",443)); assert result != 0']);
  const worker = `${id}-worker`; containers.push(worker);
  const result = docker(['run', '--name', worker, ...hardened, '--security-opt', 'seccomp=unconfined', '--memory', '1536m',
    '--network', `${id}-control`, '--tmpfs', '/workspace:uid=1000,gid=1000,mode=0700,size=64m',
    '--tmpfs', '/runtime:exec,uid=1000,gid=1000,mode=0700,size=512m',
    '-v', `${secret}:/run/secrets/environment_resolver:ro`, 'argus-project-resolver-cert:20260928']);
  process.stdout.write(result);
} finally {
  for (const container of containers.reverse()) {
    try { docker(['rm', '-f', container]); } catch { /* already stopped; disposable exact name only */ }
  }
  for (const network of networks.reverse()) {
    try { docker(['network', 'rm', network]); } catch { /* report original certification error */ }
  }
  await rm(temporary, { recursive: true, force: true });
}
