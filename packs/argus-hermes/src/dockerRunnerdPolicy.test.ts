import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARGUS_HERMES_DOCKER_RUNNER_POLICY,
  ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT,
  DockerRunnerdPolicyError,
  UnprovisionedDockerManagedRunnerProvisioner,
  resolveDockerHermesRunnerdPolicy,
  validateDockerHermesRunnerdPolicy,
} from './dockerRunnerdPolicy.js';

const HERMES_DIGEST = `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`;
const PROXY_DIGEST = `registry.argus.internal:5443/argus/mcp-proxy@sha256:${'b'.repeat(64)}`;
const PROXY_CONTRACT_DIGEST = `sha256:${'c'.repeat(64)}`;

const CANONICAL_HERMES = {
  platform: 'linux/amd64' as const,
  hermesImage: HERMES_DIGEST,
  allowedToolsets: ['mcp'] as const,
};

const CANONICAL_PROXY = {
  platform: 'linux/amd64' as const,
  mcpProxyImage: PROXY_DIGEST,
  mcpAuthProxyContract: ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT,
  mcpAuthProxyContractDigest: PROXY_CONTRACT_DIGEST,
} as const;

const CANONICAL_IMAGES = {
  hermes: CANONICAL_HERMES,
  mcpProxy: CANONICAL_PROXY,
};

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: ARGUS_HERMES_DOCKER_RUNNER_POLICY,
    platform: 'linux/amd64',
    toolsets: ['mcp'],
    privateNetwork: 'argus-managed-hermes-runs',
    coreEgressNetwork: 'argus-core-egress-hermes',
    providerEgressNetwork: 'argus-provider-egress-hermes',
    hermesAuthVolume: 'argus-hermes-managed-auth',
    provider: 'openai-codex',
    model: 'gpt-5.6-terra',
    resources: {
      hermes: { cpuMillicores: 1_000, memoryMiB: 2_048, pids: 512 },
      mcpProxy: { cpuMillicores: 100, memoryMiB: 128, pids: 64 },
    },
    ...overrides,
  };
}

test('builds a closed, pinned two-container topology with only the proxy able to receive the grant', () => {
  const topology = validateDockerHermesRunnerdPolicy(policy(), CANONICAL_IMAGES);

  assert.deepEqual(topology.networks.run, {
    name: 'argus-managed-hermes-runs', visibility: 'private', hostNetwork: false, publishedPorts: [],
  });
  assert.deepEqual(topology.networks.coreEgress, {
    name: 'argus-core-egress-hermes', visibility: 'operator-pinned-core-egress', hostNetwork: false, publishedPorts: [],
  });
  assert.deepEqual(topology.networks.providerEgress, {
    name: 'argus-provider-egress-hermes', visibility: 'operator-pinned-provider-egress', hostNetwork: false, publishedPorts: [],
  });
  assert.equal(topology.hermes.image, HERMES_DIGEST);
  assert.equal(topology.hermes.platform, 'linux/amd64');
  assert.deepEqual(topology.hermes.toolsets, ['mcp']);
  assert.deepEqual(topology.hermes.command, ['managed-oneshot']);
  assert.deepEqual(topology.hermes.security.hostMounts, []);
  assert.deepEqual(topology.hermes.security.engineSockets, []);
  assert.equal(topology.hermes.security.readOnlyRootFilesystem, true);
  assert.deepEqual(topology.hermes.attachedNetworks, ['run', 'provider-egress']);
  assert.equal(topology.hermes.mcpEndpoint, 'http://argus-mcp-proxy:3002/mcp');
  assert.deepEqual(topology.hermes.hermesHome, { kind: 'tmpfs', path: '/opt/data' });
  assert.deepEqual(topology.hermes.authentication, {
    source: 'operator-volume',
    volume: 'argus-hermes-managed-auth',
    mountPath: '/run/argus-hermes-auth',
    readOnly: true,
    copiedFiles: ['.env', 'auth.json'],
    maxConcurrentRuns: 1,
  });
  assert.deepEqual(topology.hermes.inference, { provider: 'openai-codex', model: 'gpt-5.6-terra' });

  assert.equal(topology.mcpProxy.image, PROXY_DIGEST);
  assert.deepEqual(topology.mcpProxy.command, ['node', 'dist/mcpAuthProxy.js']);
  assert.equal(topology.mcpProxy.mcpAuthProxyContract, ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT);
  assert.equal(topology.mcpProxy.mcpAuthProxyContractDigest, PROXY_CONTRACT_DIGEST);
  assert.deepEqual(topology.mcpProxy.attachedNetworks, ['run', 'core-egress']);
  assert.deepEqual(topology.mcpProxy.grant, {
    delivery: 'tmpfs-file',
    path: '/run/argus-mcp/grant',
    mode: 0o600,
    visibleTo: 'mcp-proxy-only',
  });
  const serializablePlan = JSON.stringify(topology);
  assert.doesNotMatch(serializablePlan, /executionGrant|prompt|instruction|docker\.sock/i);
});

test('requires immutable OCI digests for both Hermes and proxy images', () => {
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy({ mcpProxyImage: 'registry.argus.internal/argus/mcp-proxy:latest' }), CANONICAL_IMAGES), DockerRunnerdPolicyError);
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy(), {
    ...CANONICAL_IMAGES,
    hermes: { ...CANONICAL_HERMES, hermesImage: 'nousresearch/hermes-agent:v2026.7.7.2' },
  }), DockerRunnerdPolicyError);
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy(), {
    ...CANONICAL_IMAGES,
    hermes: { ...CANONICAL_HERMES, hermesImage: `nousresearch/hermes-agent@sha256:${'A'.repeat(64)}` },
  }), DockerRunnerdPolicyError);
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy(), {
    ...CANONICAL_IMAGES,
    mcpProxy: { ...CANONICAL_PROXY, mcpProxyImage: 'registry.argus.internal/argus/mcp-proxy:latest' },
  }), DockerRunnerdPolicyError);
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy(), {
    ...CANONICAL_IMAGES,
    mcpProxy: { ...CANONICAL_PROXY, mcpAuthProxyContractDigest: `sha256:${'b'.repeat(63)}` },
  }), DockerRunnerdPolicyError);
});

test('binds the platform and toolsets to the canonical per-platform image attestation', () => {
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy({ platform: 'linux/arm64' }), CANONICAL_IMAGES), DockerRunnerdPolicyError);
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy({ toolsets: ['mcp', 'terminal'] }), CANONICAL_IMAGES), DockerRunnerdPolicyError);
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy(), {
    ...CANONICAL_IMAGES,
    hermes: { ...CANONICAL_HERMES, allowedToolsets: ['terminal'] },
  }), DockerRunnerdPolicyError);
  assert.throws(() => validateDockerHermesRunnerdPolicy(policy(), {
    ...CANONICAL_IMAGES,
    mcpProxy: { ...CANONICAL_PROXY, platform: 'linux/arm64' },
  }), DockerRunnerdPolicyError);
});

test('rejects host-control and networking escape hatches instead of silently ignoring them', () => {
  const dangerous = [
    policy({ privateNetwork: 'bridge' }),
    policy({ privateNetwork: 'host' }),
    policy({ privateNetwork: 'argus-managed-\nsecret' }),
    policy({ coreEgressNetwork: 'bridge' }),
    policy({ coreEgressNetwork: 'argus-managed-hermes-runs' }),
    policy({ providerEgressNetwork: 'host' }),
    policy({ providerEgressNetwork: 'argus-core-egress-hermes' }),
    policy({ hermesAuthVolume: '/host/hermes-auth' }),
    policy({ provider: 'openai-codex; env' }),
    policy({ model: 'gpt-5.6-terra\nnext' }),
    policy({ ports: ['0.0.0.0:3002:3002'] }),
    policy({ hostMounts: ['/var/run/docker.sock:/var/run/docker.sock'] }),
    policy({ dockerSocket: '/var/run/docker.sock' }),
    policy({ networkMode: 'host' }),
    policy({ command: ['sh', '-c', 'curl example.invalid'] }),
  ];
  for (const input of dangerous) {
    assert.throws(() => validateDockerHermesRunnerdPolicy(input, CANONICAL_IMAGES), DockerRunnerdPolicyError);
  }
});

test('requires bounded CPU, memory and PID limits for both sidecars', () => {
  const badResources = [
    { hermes: { cpuMillicores: 0, memoryMiB: 2_048, pids: 512 }, mcpProxy: { cpuMillicores: 100, memoryMiB: 128, pids: 64 } },
    { hermes: { cpuMillicores: 1_000, memoryMiB: 2_048, pids: 512 }, mcpProxy: { cpuMillicores: 100, memoryMiB: 128 } },
    { hermes: { cpuMillicores: 9_000, memoryMiB: 2_048, pids: 512 }, mcpProxy: { cpuMillicores: 100, memoryMiB: 128, pids: 64 } },
    { hermes: { cpuMillicores: 1_000, memoryMiB: 2_048, pids: 512 }, mcpProxy: { cpuMillicores: 100, memoryMiB: 4_096, pids: 64 } },
  ];
  for (const resources of badResources) {
    assert.throws(() => validateDockerHermesRunnerdPolicy(policy({ resources }), CANONICAL_IMAGES), DockerRunnerdPolicyError);
  }
});

test('stays explicitly unavailable when no policy or no privileged provisioner is installed', async () => {
  assert.deepEqual(resolveDockerHermesRunnerdPolicy(undefined), {
    state: 'unavailable',
    code: 'DOCKER_RUNNER_POLICY_NOT_CONFIGURED',
    detail: 'No isolated Docker managed runner policy is configured.',
  });
  assert.deepEqual(resolveDockerHermesRunnerdPolicy(policy()), {
    state: 'unavailable',
    code: 'DOCKER_RUNNER_CANONICAL_IMAGE_UNAVAILABLE',
    detail: 'No canonical Hermes image attestation is available.',
  });
  const invalid = resolveDockerHermesRunnerdPolicy(policy({ privateNetwork: 'http://argus-core:3000' }), CANONICAL_IMAGES);
  assert.deepEqual(invalid, {
    state: 'unavailable',
    code: 'DOCKER_RUNNER_POLICY_INVALID',
    detail: 'The isolated Docker managed runner policy is not eligible.',
  });

  const provisioner = new UnprovisionedDockerManagedRunnerProvisioner();
  assert.equal(provisioner.availability().state, 'unavailable');
  await assert.rejects(() => provisioner.status('950610b9-97b4-41cb-908f-46cc80bd22a2'), DockerRunnerdPolicyError);
});
