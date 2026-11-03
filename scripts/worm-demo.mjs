import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const action = process.argv[2] ?? 'up';
if (!['up', 'stop'].includes(action)) throw new Error('Usage: node scripts/worm-demo.mjs <up|stop>');
if (!existsSync(resolve(root, '.env'))) throw new Error('Missing .env. Complete the normal Argus Docker installation first.');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

run(process.execPath, [resolve(root, 'scripts/setup-worm-demo.mjs')]);
run(process.execPath, [resolve(root, 'scripts/ensure-audit-signing-key.mjs')]);
const compose = [
  'compose', '--env-file', '.env', '--env-file', '.env.worm-demo.local',
  '-f', 'docker-compose.yml', '-f', 'compose.audit-evidence.yml', '-f', 'compose.worm-demo.yml',
];
if (action === 'stop') {
  run('docker', [...compose, 'stop', 'worm-gateway', 'worm-minio']);
  process.stdout.write('WORM demo services stopped; the locked MinIO volume was retained.\n');
  process.exit(0);
}

run('docker', [...compose, 'config', '--quiet']);
run('docker', [...compose, 'up', '-d', '--build', 'mcp-server', 'worm-gateway']);

const env = Object.fromEntries(readFileSync(resolve(root, '.env.worm-demo.local'), 'utf8').split(/\r?\n/)
  .map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('='))
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const port = env.WORM_GATEWAY_PORT ?? '8787';
const deadline = Date.now() + 120_000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (response.ok) { healthy = true; break; }
  } catch { /* Service is still starting. */ }
  await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
}
if (!healthy) throw new Error('WORM demo gateway did not become healthy within 120 seconds');
run(process.execPath, [resolve(root, 'scripts/certify-worm-demo.mjs')], { env: { ...process.env, WORM_GATEWAY_PORT: port } });
process.stdout.write(`WORM demo ready: Argus http://localhost:${process.env.PORT ?? '3000'} · MinIO console http://localhost:${env.WORM_MINIO_CONSOLE_PORT ?? '9901'}\n`);
