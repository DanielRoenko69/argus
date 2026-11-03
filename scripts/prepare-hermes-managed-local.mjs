import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hermesRepository = resolve(repositoryRoot, '..', 'argus.hermes');
const registryContainer = 'argus-hermes-managed-registry';
const registryOrigin = 'localhost:5001';
const hermesTag = 'nousresearch/hermes-agent:v2026.7.7.2';
const coreEgressNetwork = 'argus-core-egress-hermes';
const providerEgressNetwork = 'argus-provider-egress-hermes';
const defaultManagedAuthVolume = 'argus-hermes-managed-auth';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: options.inherit ? undefined : 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    if (options.optional) return undefined;
    fail(`Docker preparation failed during ${args.slice(0, 2).join(' ')}.`);
  }
  return options.inherit ? '' : String(result.stdout ?? '').trim();
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredIdentifier(value, label, pattern) {
  if (!value || !pattern.test(value)) fail(`${label} is required and malformed.`);
  return value;
}

function ensureRegistry() {
  const state = docker(['inspect', '--format', '{{.State.Running}}', registryContainer], { optional: true });
  if (state === 'true') return;
  if (state === 'false') {
    docker(['start', registryContainer]);
    return;
  }
  docker([
    'run', '--detach', '--name', registryContainer, '--restart', 'unless-stopped',
    '--publish', '127.0.0.1:5001:5000', 'registry:2',
  ]);
}

function ensureNetwork(name) {
  if (docker(['network', 'inspect', name], { optional: true }) !== undefined) return;
  docker(['network', 'create', name]);
}

function prepareManagedAuthVolume(sourceVolume, managedVolume) {
  docker(['volume', 'create', '--label', 'argus.hermes.auth=managed', managedVolume]);
  docker([
    'run', '--rm',
    '--mount', `type=volume,src=${sourceVolume},dst=/source,readonly`,
    '--mount', `type=volume,src=${managedVolume},dst=/managed`,
    '--entrypoint', '/bin/sh', hermesTag, '-ec',
    [
      'set -eu; umask 077',
      '[ -f /source/auth.json ]',
      'cp /source/auth.json /managed/auth.json',
      'if [ -f /source/.env ]; then cp /source/.env /managed/.env; fi',
      'chown -R 1000:1000 /managed',
      'chmod 0600 /managed/auth.json',
      'if [ -f /managed/.env ]; then chmod 0600 /managed/.env; fi',
    ].join('; '),
  ]);
}

function repositoryDigest(tag, requiredPrefix) {
  const raw = docker(['image', 'inspect', tag, '--format', '{{json .RepoDigests}}']);
  const values = JSON.parse(raw);
  const digest = Array.isArray(values) ? values.find(value => String(value).startsWith(requiredPrefix)) : undefined;
  if (typeof digest !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(digest)) {
    fail(`Immutable digest for ${requiredPrefix} was not produced.`);
  }
  return digest;
}

async function main() {
  const sourceAuthVolume = requiredIdentifier(
    option('--auth-volume'),
    '--auth-volume',
    /^[a-z0-9][a-z0-9_.-]{1,127}$/,
  );
  const managedAuthVolume = requiredIdentifier(
    option('--managed-auth-volume') ?? defaultManagedAuthVolume,
    '--managed-auth-volume',
    /^[a-z0-9][a-z0-9_.-]{1,127}$/,
  );
  if (sourceAuthVolume === managedAuthVolume) fail('Managed auth volume must be separate from the Attached Hermes profile.');
  const bundleId = requiredIdentifier(option('--bundle-id'), '--bundle-id', /^[1-9][0-9]{0,9}$/);
  const provider = requiredIdentifier(option('--provider') ?? 'openai-codex', '--provider', /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/);
  const model = requiredIdentifier(option('--model') ?? 'gpt-5.6-terra', '--model', /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/);

  if (!existsSync(hermesRepository)) fail('The sibling argus.hermes repository is required.');
  docker(['volume', 'inspect', sourceAuthVolume]);
  prepareManagedAuthVolume(sourceAuthVolume, managedAuthVolume);
  ensureRegistry();
  ensureNetwork(coreEgressNetwork);
  ensureNetwork(providerEgressNetwork);

  docker(['build', '--tag', 'argus-hermes:local', '.'], { cwd: hermesRepository, inherit: true });
  docker(['build', '--target', 'runnerd', '--tag', 'argus-hermes-runnerd:local', '.'], { cwd: hermesRepository, inherit: true });

  const proxyTag = `${registryOrigin}/argus-hermes-proxy:managed`;
  const runnerdTag = `${registryOrigin}/argus-hermes-runnerd:managed`;
  docker(['tag', 'argus-hermes:local', proxyTag]);
  docker(['push', proxyTag], { inherit: true });
  docker(['tag', 'argus-hermes-runnerd:local', runnerdTag]);
  docker(['push', runnerdTag], { inherit: true });

  const proxyDigest = repositoryDigest(proxyTag, `${registryOrigin}/argus-hermes-proxy@sha256:`);
  const runnerdDigest = repositoryDigest(runnerdTag, `${registryOrigin}/argus-hermes-runnerd@sha256:`);
  const hermesDigest = repositoryDigest(hermesTag, 'nousresearch/hermes-agent@sha256:');
  const imagePlatform = docker(['image', 'inspect', hermesTag, '--format', '{{.Os}}/{{.Architecture}}']);
  if (!['linux/amd64', 'linux/arm64'].includes(imagePlatform)) fail('Hermes image platform is unsupported.');

  const proxyContractSource = await readFile(resolve(hermesRepository, 'src', 'mcpAuthProxy.ts'));
  const proxyContractDigest = `sha256:${createHash('sha256').update(proxyContractSource).digest('hex')}`;
  const secretsDirectory = resolve(repositoryRoot, 'secrets');
  await mkdir(secretsDirectory, { recursive: true });
  const policyFile = resolve(secretsDirectory, 'argus-hermes-docker-policy.json');
  const attestationFile = resolve(secretsDirectory, 'argus-hermes-docker-attestation.json');
  const tokenFile = resolve(secretsDirectory, 'argus-hermes-runnerd-token');

  const policy = {
    apiVersion: 'argus.hermes.docker-runner-policy/v1alpha1',
    platform: imagePlatform,
    toolsets: ['mcp'],
    privateNetwork: 'argus-managed-hermes-runs',
    coreEgressNetwork,
    providerEgressNetwork,
    hermesAuthVolume: managedAuthVolume,
    provider,
    model,
    resources: {
      hermes: { cpuMillicores: 2_000, memoryMiB: 4_096, pids: 512 },
      mcpProxy: { cpuMillicores: 250, memoryMiB: 256, pids: 64 },
    },
  };
  const attestation = {
    hermes: { platform: imagePlatform, hermesImage: hermesDigest, allowedToolsets: ['mcp'] },
    mcpProxy: {
      platform: imagePlatform,
      mcpProxyImage: proxyDigest,
      mcpAuthProxyContract: 'argus.mcp-auth-proxy/v1alpha1',
      mcpAuthProxyContractDigest: proxyContractDigest,
    },
  };
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await writeFile(attestationFile, `${JSON.stringify(attestation, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (!existsSync(tokenFile)) {
    await writeFile(tokenFile, `${randomBytes(32).toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  const env = [
    '# Generated by scripts/prepare-hermes-managed-local.mjs. No secret values are stored here.',
    `ARGUS_HERMES_RUNNERD_IMAGE=${runnerdDigest}`,
    'ARGUS_HERMES_RUNNERD_TOKEN_SOURCE_FILE=./secrets/argus-hermes-runnerd-token',
    'ARGUS_HERMES_DOCKER_POLICY_SOURCE_FILE=./secrets/argus-hermes-docker-policy.json',
    'ARGUS_HERMES_DOCKER_ATTESTATION_SOURCE_FILE=./secrets/argus-hermes-docker-attestation.json',
    `ARGUS_MANAGED_RUNTIME_READ_ONLY_BUNDLE_IDS=${bundleId}`,
    '',
  ].join('\n');
  await writeFile(resolve(repositoryRoot, '.env.hermes-managed.local'), env, { encoding: 'utf8', mode: 0o600 });

  process.stdout.write('Managed Hermes local artifacts are ready.\n');
  process.stdout.write(`Hermes: ${hermesDigest}\n`);
  process.stdout.write(`Proxy: ${proxyDigest}\n`);
  process.stdout.write('No LiteLLM or provider API key was configured.\n');
}

await main();
