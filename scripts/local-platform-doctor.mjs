#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatNodeGuidance, supportsChatNode } from './check-chat-node.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = new Set(process.argv.slice(2));
const full = options.has('--full') || options.has('--managed-hermes');
const managedHermes = options.has('--managed-hermes');
const failures = [];
const warnings = [];

function line(symbol, label, detail) {
  process.stdout.write(`${symbol} ${label}${detail ? ` — ${detail}` : ''}\n`);
}

function pass(label, detail = '') { line('OK', label, detail); }
function warn(label, detail) { warnings.push(label); line('WARN', label, detail); }
function fail(label, detail) { failures.push(label); line('FAIL', label, detail); }

function run(command, args, cwd = root) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readEnv(file) {
  if (!existsSync(file)) return {};
  const result = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function localPath(value) {
  if (isAbsolute(value)) return value;
  if (win32.isAbsolute(value)) return process.platform === 'win32' ? value : null;
  return resolve(root, value);
}

function normalizeDockerPlatform(value) {
  const [operatingSystem, architecture] = String(value || '').trim().toLowerCase().split('/');
  const normalizedArchitecture = architecture === 'x86_64'
    ? 'amd64'
    : architecture === 'aarch64'
      ? 'arm64'
      : architecture;
  return operatingSystem && normalizedArchitecture
    ? `${operatingSystem}/${normalizedArchitecture}`
    : String(value || '').trim().toLowerCase();
}

function checkSecretFile(environment, key, required) {
  const raw = environment[key];
  if (!raw) {
    if (required) fail(key, 'missing from the local environment file');
    return;
  }
  const candidate = localPath(raw);
  if (!candidate) {
    fail(key, 'contains a Windows absolute path; regenerate it on macOS');
    return;
  }
  if (!existsSync(candidate)) fail(key, 'the referenced local file does not exist');
  else pass(key, 'local secret source exists (contents not inspected)');
}

function checkCompose(files, envFiles, label) {
  const args = ['compose'];
  for (const file of envFiles) args.push('--env-file', file);
  for (const file of files) args.push('-f', file);
  args.push('config', '--quiet');
  const result = run('docker', args);
  if (result.status === 0) pass(label, 'Compose configuration resolves');
  else fail(label, String(result.stderr || result.stdout || 'docker compose config failed').trim().split(/\r?\n/u).at(-1));
}

process.stdout.write(`Argus local platform doctor (${process.platform}/${process.arch})\n`);
process.stdout.write(`Scope: ${managedHermes ? 'full + managed Hermes' : full ? 'full external Pack stack' : 'Core'}\n\n`);

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) pass('Node.js', process.version);
else fail('Node.js', `v20 or newer is required; found ${process.version}`);
if (supportsChatNode(process.versions.node)) pass('Chat toolchain Node.js', process.version);
else fail('Chat toolchain Node.js', chatNodeGuidance);

const dockerVersion = run('docker', ['--version']);
if (dockerVersion.status === 0) pass('Docker CLI', dockerVersion.stdout.trim());
else fail('Docker CLI', 'install Docker Desktop and make docker available on PATH');

const composeVersion = run('docker', ['compose', 'version', '--short']);
if (composeVersion.status === 0) pass('Docker Compose', `v${composeVersion.stdout.trim()}`);
else fail('Docker Compose', 'the Docker Compose v2 plugin is required');

let enginePlatform = '';
if (dockerVersion.status === 0) {
  const engine = run('docker', ['info', '--format', '{{.OSType}}/{{.Architecture}}|{{.MemTotal}}']);
  if (engine.status !== 0) {
    fail('Docker engine', 'start Docker Desktop and wait until its engine is ready');
  } else {
    const [reportedPlatform, memoryRaw] = engine.stdout.trim().split('|');
    const platform = normalizeDockerPlatform(reportedPlatform);
    enginePlatform = platform;
    const memoryGiB = Number(memoryRaw) / 1024 ** 3;
    if (platform === 'linux/amd64' || platform === 'linux/arm64') pass('Docker engine', platform);
    else fail('Docker engine', `${platform || 'unknown'} is unsupported; use Linux containers`);
    if (Number.isFinite(memoryGiB) && memoryGiB >= 12) pass('Docker memory', `${memoryGiB.toFixed(1)} GiB available`);
    else warn('Docker memory', `${Number.isFinite(memoryGiB) ? memoryGiB.toFixed(1) : '?'} GiB; 12+ GiB is recommended for the full stack`);
  }
}

const envFile = resolve(root, '.env');
const environment = readEnv(envFile);
if (!existsSync(envFile)) {
  fail('.env', 'run sh ./setup.sh on macOS; do not copy workstation secrets through Git');
} else {
  pass('.env', 'present');
  for (const key of ['SESSION_SECRET', 'DB_ENCRYPTION_KEY', 'POSTGRES_PASSWORD', 'MCP_API_KEYS', 'WORKSPACE_SECRET']) {
    const value = environment[key];
    if (!value || /^(?:CHANGE_ME|your-secret)/iu.test(value)) fail(key, 'missing or still uses its placeholder value');
    else pass(key, 'configured (value hidden)');
  }
  for (const key of ['ARGUS_CODEX_ENABLED', 'ARGUS_CLAUDE_ENABLED']) {
    if (environment[key] === 'true') pass(key, 'guided runtime sign-in is available');
    else warn(key, 'guided runtime sign-in is disabled on this workstation');
  }
}

if (existsSync(envFile) && composeVersion.status === 0) {
  checkCompose(['docker-compose.yml'], ['.env'], 'Core stack');
}

if (full) {
  for (const sibling of ['argus-dev', 'argus-aiops', 'argus-hermes']) {
    const directory = resolve(root, 'packs', sibling);
    if (existsSync(resolve(directory, 'Dockerfile')) && existsSync(resolve(directory, 'package.json'))) {
      pass(`Solution Pack ${sibling}`, directory);
    } else {
      fail(`Solution Pack ${sibling}`, `missing at ${directory}`);
    }
  }
  checkSecretFile(environment, 'ARGUS_HERMES_DISCOVERY_TOKEN_FILE', true);
  checkSecretFile(environment, 'ARGUS_HERMES_API_KEY_SOURCE_FILE', true);
  if (existsSync(envFile) && composeVersion.status === 0) {
    checkCompose(
      ['docker-compose.yml', 'deploy/compose/packs/compose.external-pack.yml', 'deploy/compose/packs/compose.hermes-attached.yml', 'deploy/compose/packs/compose.hermes-local.yml'],
      ['.env'],
      'External Pack stack',
    );
  }
  for (const image of ['argus-dev:local', 'argus-aiops:local', 'argus-hermes:local']) {
    if (!enginePlatform) {
      warn(image, 'Docker engine unavailable; image architecture was not inspected');
      continue;
    }
    const inspected = run('docker', ['image', 'inspect', image, '--format', '{{.Os}}/{{.Architecture}}']);
    if (inspected.status !== 0) warn(image, 'local image is not built yet');
    else {
      const imagePlatform = normalizeDockerPlatform(inspected.stdout);
      if (!enginePlatform || imagePlatform === enginePlatform) pass(image, imagePlatform);
      else warn(image, `${imagePlatform} does not match ${enginePlatform}; rebuild it on this workstation`);
    }
  }
}

if (managedHermes) {
  const managedEnvFile = resolve(root, '.env.hermes-managed.local');
  const managedEnvironment = { ...environment, ...readEnv(managedEnvFile) };
  if (!existsSync(managedEnvFile)) fail('.env.hermes-managed.local', 'regenerate managed Hermes artifacts on this workstation');
  else pass('.env.hermes-managed.local', 'present');
  for (const key of [
    'ARGUS_HERMES_RUNNERD_TOKEN_SOURCE_FILE',
    'ARGUS_HERMES_DOCKER_POLICY_SOURCE_FILE',
    'ARGUS_HERMES_DOCKER_ATTESTATION_SOURCE_FILE',
  ]) checkSecretFile(managedEnvironment, key, true);

  const policyPath = localPath(managedEnvironment.ARGUS_HERMES_DOCKER_POLICY_SOURCE_FILE || '');
  if (policyPath && existsSync(policyPath)) {
    try {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
      const attestedPlatform = normalizeDockerPlatform(policy.platform);
      if (!enginePlatform) warn('Managed Hermes platform attestation', `${attestedPlatform}; Docker engine unavailable for comparison`);
      else if (attestedPlatform === enginePlatform) pass('Managed Hermes platform attestation', attestedPlatform);
      else fail('Managed Hermes platform attestation', `${attestedPlatform} was prepared elsewhere; rerun setup:hermes-managed:local for ${enginePlatform}`);
    } catch {
      fail('Managed Hermes platform attestation', 'policy JSON is unreadable');
    }
  }
  if (existsSync(envFile) && existsSync(managedEnvFile) && composeVersion.status === 0) {
    checkCompose(
      ['docker-compose.yml', 'deploy/compose/packs/compose.external-pack.yml', 'deploy/compose/packs/compose.hermes-attached.yml', 'deploy/compose/packs/compose.hermes-local.yml', 'deploy/compose/packs/compose.hermes-managed.yml'],
      ['.env', '.env.hermes-managed.local'],
      'Managed Hermes stack',
    );
  }
}

process.stdout.write(`\nSummary: ${failures.length} blocker(s), ${warnings.length} warning(s).\n`);
if (failures.length > 0) process.exitCode = 1;
