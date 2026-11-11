import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const { Pool } = pg;
const root = resolve(import.meta.dirname, '..');
const attestationPath = resolve(root, 'secrets', 'argus-hermes-docker-attestation.json');
const composeBaseArgs = [
  'compose', '--env-file', '.env', '--env-file', '.env.hermes-managed.local',
  '-f', 'docker-compose.yml', '-f', 'deploy/compose/packs/compose.external-pack.yml',
  '-f', 'deploy/compose/packs/compose.hermes-attached.yml', '-f', 'deploy/compose/packs/compose.hermes-local.yml',
];
const composeManagedArgs = [...composeBaseArgs, '-f', 'deploy/compose/packs/compose.hermes-managed.yml'];

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function command(executable, args, { inherit = false, optional = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: inherit ? undefined : 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    if (optional) return '';
    throw new Error(`Rollback certification command failed: ${executable} ${args.slice(0, 3).join(' ')}`);
  }
  return inherit ? '' : String(result.stdout ?? '').trim();
}

function immutableHermesImage(value, label) {
  if (typeof value !== 'string' || !/^nousresearch\/hermes-agent@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be an immutable official Hermes image digest`);
  }
  return value;
}

function databaseUrl() {
  const user = process.env.POSTGRES_USER?.trim() || 'aiops';
  const password = process.env.POSTGRES_PASSWORD?.trim();
  const database = process.env.POSTGRES_DB?.trim() || 'aiops';
  const port = process.env.POSTGRES_PORT?.trim() || '5432';
  if (!password) throw new Error('POSTGRES_PASSWORD is required');
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
}

async function atomicWrite(contents) {
  const temporary = `${attestationPath}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, attestationPath);
}

function assertNoManagedRunResources() {
  const containers = command('docker', ['ps', '--all', '--quiet', '--filter', 'label=argus.hermes.run'], { optional: true });
  const networks = command('docker', ['network', 'ls', '--quiet', '--filter', 'label=argus.hermes.run'], { optional: true });
  if (containers || networks) throw new Error('Rollback requires zero active or orphaned Managed Hermes run resources');
}

function recreateRuntime(managed) {
  const args = managed ? composeManagedArgs : composeBaseArgs;
  const services = managed ? ['argus-hermes-runnerd', 'argus-hermes'] : ['argus-hermes'];
  command('docker', [...args, 'up', '-d', '--force-recreate', ...services], { inherit: true });
}

function certifyLive() {
  // Invoke Node directly so the gate behaves identically on Windows and
  // POSIX; spawning npm.cmd from Node is shell-dependent on Windows.
  command(process.execPath, ['scripts/certify-hermes-managed-runtime.mjs'], { inherit: true });
}

async function certifyAttachedFallback() {
  const pool = new Pool({ connectionString: databaseUrl(), max: 1 });
  const sessionId = randomUUID();
  const baseUrl = process.env.ARGUS_BASE_URL?.trim() || 'http://127.0.0.1:3000';
  try {
    const admin = await pool.query(`SELECT id FROM mcp_users WHERE enabled=true AND role='platform_admin' ORDER BY id LIMIT 1`);
    if (!admin.rows[0]) throw new Error('No enabled platform administrator exists for rollback certification');
    await pool.query(
      `INSERT INTO mcp_sessions (id,user_id,expires_at,ip_address,user_agent)
       VALUES ($1,$2,now()+interval '10 minutes','127.0.0.1','managed-hermes-rollback-certifier')`,
      [sessionId, admin.rows[0].id],
    );
    const deadline = Date.now() + 90_000;
    const url = `${baseUrl}/api/admin/solution-packs/argus.hermes/runtime-adapters/hermes-http/status`;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { headers: { cookie: `argus_session=${sessionId}` } });
        if (response.ok) {
          const body = await response.json();
          const attached = body?.status?.modes?.find(mode => mode.mode === 'attached');
          const managed = body?.status?.modes?.find(mode => mode.mode === 'managed');
          if (attached?.state === 'ready' && managed?.state !== 'ready') {
            process.stdout.write(`${JSON.stringify({
              event: 'attached-fallback-certified',
              attachedState: attached.state,
              managedState: managed?.state ?? 'unavailable',
            })}\n`);
            return;
          }
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error('Attached fallback did not become ready with Managed Hermes disabled');
  } finally {
    await pool.query('DELETE FROM mcp_sessions WHERE id=$1', [sessionId]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

async function main() {
  const originalText = await readFile(attestationPath, 'utf8');
  const original = JSON.parse(originalText);
  const candidateImage = immutableHermesImage(original?.hermes?.hermesImage, 'current attestation image');
  const rollbackOption = option('--rollback-image');
  const rollbackImage = rollbackOption === undefined ? undefined : immutableHermesImage(rollbackOption, 'rollback image');
  if (rollbackImage === candidateImage) throw new Error('Rollback image must differ from the current candidate image');
  if (rollbackImage) command('docker', ['image', 'inspect', rollbackImage]);
  assertNoManagedRunResources();

  let restored = false;
  try {
    if (rollbackImage) {
      const rollbackAttestation = {
        ...original,
        hermes: { ...original.hermes, hermesImage: rollbackImage },
      };
      await atomicWrite(`${JSON.stringify(rollbackAttestation, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({ event: 'rollback-image-selected', image: rollbackImage })}\n`);
      recreateRuntime(true);
      certifyLive();
      process.stdout.write(`${JSON.stringify({ event: 'rollback-image-certified', image: rollbackImage })}\n`);
    } else {
      // The first eligible Managed release has no earlier compatible managed
      // image. Its real rollback is the supported Attached-only topology:
      // managed provisioning disappears while the existing Hermes service
      // remains available and externally attested.
      recreateRuntime(false);
      await certifyAttachedFallback();
    }
    assertNoManagedRunResources();
  } finally {
    if (rollbackImage) await atomicWrite(originalText);
    recreateRuntime(true);
    restored = true;
    process.stdout.write(`${JSON.stringify({ event: 'candidate-restored', image: candidateImage })}\n`);
  }

  if (!restored) throw new Error('Candidate attestation was not restored');
  certifyLive();
  assertNoManagedRunResources();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    rollbackMode: rollbackImage ? 'previous-managed-image' : 'attached-only',
    ...(rollbackImage ? { rollbackImage } : {}),
    restoredCandidateImage: candidateImage,
    rollbackGate: rollbackImage ? 'read-only-run-completed' : 'attached-ready-managed-unavailable',
    restoredCandidateReadOnlyRun: 'completed',
    orphanContainers: 0,
    orphanNetworks: 0,
  })}\n`);
}

await main();
