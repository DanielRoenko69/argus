import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const verifyOnly = process.argv.includes('--verify-only');
const skipAiopsBootstrap = process.argv.includes('--skip-aiops-bootstrap');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function composeArguments() {
  const args = ['compose', '--project-name', 'argus-core', '--project-directory', root, '--env-file', '.env'];
  if (existsSync(resolve(root, '.env.worm-demo.local'))) args.push('--env-file', '.env.worm-demo.local');
  args.push('-f', 'docker-compose.yml');
  for (const file of [
    'deploy/compose/packs/compose.external-pack.yml',
    'deploy/compose/packs/compose.hermes-attached.yml',
    'deploy/compose/packs/compose.hermes-local.yml',
    'deploy/compose/demo/compose.aiops-demo.yml',
    'deploy/compose/demo/compose.backend-sso-demo.yml',
  ]) {
    if (existsSync(resolve(root, file))) args.push('-f', file);
  }
  if (existsSync(resolve(root, '.env.worm-demo.local'))) {
    args.push('-f', 'deploy/compose/options/compose.audit-evidence.yml', '-f', 'deploy/compose/demo/compose.worm-demo.yml');
  }
  args.push('-f', 'deploy/compose/demo/compose.mfa-demo.yml', '--profile', 'aiops-demo', '--profile', 'backend-sso-demo');
  return args;
}

async function waitForArgus(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://localhost:3000/health');
      if (response.ok) return;
    } catch { /* Core is still starting. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  }
  throw new Error('Argus did not become healthy within 120 seconds');
}

if (!existsSync(resolve(root, '.env'))) {
  throw new Error('Missing .env; complete the normal Argus Docker installation first');
}

if (!verifyOnly) {
  if (!skipAiopsBootstrap) {
    if (process.platform === 'win32') {
      run('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', 'scripts/bootstrap-aiops-demo.ps1',
        '-SkipKnowledgeSeed',
      ]);
    } else {
      run('sh', ['scripts/bootstrap-aiops-demo.sh', '--skip-knowledge-seed']);
    }
  }

  run(process.execPath, ['scripts/backend-sso-demo.mjs', 'up']);
  const compose = composeArguments();
  run('docker', [...compose, 'exec', '-T', 'mcp-server', 'node', 'dist/scripts/seedLocalDevDemo.js']);
  run('docker', [...compose, 'exec', '-T', 'mcp-server', 'node', 'dist/scripts/seedBackendSsoDemo.js']);
}

await waitForArgus();
run(process.execPath, ['e2e/mfa-demo-browser.mjs']);
run(process.execPath, ['e2e/sso-it-golden-path-browser.mjs']);
