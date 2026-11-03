// Disposable vendor-policy proof: public reads, negative CONNECT checks and
// real uv/Bun installation. No application source, credentials, or model calls.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
const id = `egress-cert-${randomBytes(6).toString('hex')}`;
const image = process.env.ARGUS_STACK_CERT_EGRESS_IMAGE || 'argus-stack-egress:20260929-vendor-domains';
const docker = (args, input) => execFileSync('docker', args, { encoding: 'utf8', input,
  timeout: 180000, maxBuffer: 512000, stdio: ['pipe', 'pipe', 'pipe'] });
const containers = [], networks = [];
let stage='create fixture';
const publicNet = `${id}-public`, privateNet = `${id}-private`, proxy = `${id}-proxy`, worker = `${id}-worker`;
try {
  docker(['network', 'create', '--label', `io.argus.stack-egress-cert=${id}`, publicNet]); networks.push(publicNet);
  docker(['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
    '--opt', 'com.docker.network.bridge.gateway_mode_ipv6=isolated', '--label', `io.argus.stack-egress-cert=${id}`, privateNet]); networks.push(privateNet);
  containers.push(proxy);
  docker(['run', '-d', '--name', proxy, '--label', `io.argus.stack-egress-cert=${id}`, '--network', publicNet,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '32', image]);
  docker(['network', 'connect', '--alias', 'stack-egress', privateNet, proxy]);
  stage='public reads and negative checks';
  process.stdout.write(docker(['exec', '-i', proxy, 'python3', '-'], readFileSync(new URL('../project-environments/certify_stack_egress.py', import.meta.url))));
  const base = docker(['image', 'inspect', 'argus-stack-base:20260928', '--format', '{{.Id}}']).trim();
  containers.push(worker);
  docker(['run', '-d', '--name', worker, '--label', `io.argus.stack-egress-cert=${id}`, '--network', privateNet,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '1g', '--cpus', '1', '--pids-limit', '64',
    base, 'sleep', '180']);
  stage='isolated uv and Bun installation';
  const proof = docker(['exec', '-i', '-e', 'HTTPS_PROXY=http://stack-egress:3128', '-e', 'https_proxy=http://stack-egress:3128', worker, 'bash', '-s'], `
set -euo pipefail
curl -LsSf --max-time 90 https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=/usr/local/bin sh
curl -LsSf --max-time 90 https://bun.sh/install | env BUN_INSTALL=/usr/local bash
/usr/local/bin/uv --version
/usr/local/bin/bun --version
`);
  // Installer progress stays private; emit only verified version-shaped output.
  const uv = proof.match(/^uv [0-9][^\r\n]{0,120}$/m)?.[0], bun = proof.match(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/m)?.[0];
  if (!uv || !bun) throw Error('version output missing');
  console.log(JSON.stringify({passed:true,uv,bun,installation:'disposable isolated fixture',applicationRuns:0,modelCalls:0}));
} catch (error) {
  // All inputs are synthetic, but never echo a signed download redirect URL.
  const diagnostic=String(error.stderr??'').split('\n').filter(l=>/^(AssertionError|[A-Za-z.]*Error|curl:)/.test(l)).at(-1)?.replace(/https?:\/\/\S+/g,'[public URL]').slice(0,250);
  console.error(JSON.stringify({passed:false,stage,code:error.code??null,status:error.status??null,diagnostic}));
  process.exitCode=1;
} finally {
  for (const name of containers.reverse()) { try { docker(['rm', '-f', name]); } catch {} }
  for (const name of networks.reverse()) { try { docker(['network', 'rm', name]); } catch {} }
}
