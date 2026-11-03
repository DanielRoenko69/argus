// Only synthetic fixtures. No application checkout, real credential or model.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const id = `cert-${randomBytes(6).toString('hex')}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 256000, stdio: ['ignore', 'pipe', 'pipe'] });
const proxy = `${id}-egress`, controller = `${id}-controller`, network = `${id}-public`;
const names = [];
try {
  docker(['network', 'create', '--label', `io.argus.stack-cert=${id}`, network]);
  names.push(proxy);
  docker(['run', '-d', '--name', proxy, '--label', `io.argus.stack-cert=${id}`, '--network', network,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '32', 'argus-stack-egress:20260929-vendor-domains']);
  const base = docker(['image', 'inspect', 'argus-stack-base:20260928', '--format', '{{.Id}}']).trim();
  names.push(controller);
  const socket = JSON.parse(docker(['context', 'inspect']))[0].Endpoints.docker.Host.replace(/^unix:\/\//, '');
  if (!socket.startsWith('/')) throw new Error('A local Docker Unix socket is required for this disposable certification');
  const output = docker(['run', '--name', controller, '--label', `io.argus.stack-cert=${id}`, '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '768m', '--pids-limit', '64',
    '--tmpfs', '/tmp:mode=0700,size=128m', '-v', `${socket}:/var/run/docker.sock`,
    '-e', `ARGUS_STACK_BASE_IMAGE=${base}`, '-e', `ARGUS_STACK_EGRESS_CONTAINER=${proxy}`, '-e', `ARGUS_STACK_INSTANCE=${id}`,
    ...(process.argv.includes('--extended') ? ['-e', 'ARGUS_STACK_CERT_EXTENDED=true'] : []),
    ...(process.argv.includes('--lifecycle-only') ? ['-e', 'ARGUS_STACK_CERT_LIFECYCLE=true'] : []),
    ...(process.argv.includes('--output-only') ? ['-e', 'ARGUS_STACK_CERT_OUTPUT=true'] : []),
    ...(process.argv.includes('--snapshot-only') ? ['-e', 'ARGUS_STACK_CERT_SNAPSHOT=true'] : []),
    ...(process.argv.includes('--snapshot-http-only') ? ['-e', 'ARGUS_STACK_CERT_SNAPSHOT_HTTP=true'] : []),
    process.env.ARGUS_STACK_CERT_CONTROLLER_IMAGE || 'argus-stack-controller:20260928', 'python3', 'certify_stack.py']);
  process.stdout.write(output);
} catch (error) {
  // This certificate receives synthetic data and no credentials.
  process.stderr.write(String(error.stderr ?? error.message).slice(-16000) + '\n');
  process.exitCode = 1;
} finally {
  for (const name of names.reverse()) { try { docker(['rm', '-f', name]); } catch {} }
  try { docker(['network', 'rm', network]); } catch {}
}
