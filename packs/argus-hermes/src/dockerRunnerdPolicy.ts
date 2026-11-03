import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import type { HermesRunnerdRun } from './runnerdContract.js';

/**
 * Static operator policy for the future Docker-backed `runnerd` launcher.
 *
 * This module deliberately contains no Docker client, shell invocation, OCI
 * pull, or container-engine credential. It only turns an operator-owned,
 * immutable policy into a narrow topology that a separately reviewed launcher
 * may eventually consume. Neither Argus Core nor the Pack launch request can
 * select an image, command, mount, network, port, or engine socket.
 */
export const ARGUS_HERMES_DOCKER_RUNNER_POLICY = 'argus.hermes.docker-runner-policy/v1alpha1';
export const ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT = 'argus.mcp-auth-proxy/v1alpha1';

const HERMES_ONESHOT_COMMAND = Object.freeze(['managed-oneshot']) as readonly ['managed-oneshot'];
const MCP_PROXY_COMMAND = Object.freeze(['node', 'dist/mcpAuthProxy.js']) as readonly ['node', 'dist/mcpAuthProxy.js'];
const NO_HOST_MOUNTS = Object.freeze([]) as readonly [];
const NO_ENGINE_SOCKETS = Object.freeze([]) as readonly [];
const NO_PUBLISHED_PORTS = Object.freeze([]) as readonly [];

const HERMES_MCP_PROXY_HOST = 'argus-mcp-proxy';
const HERMES_MCP_PROXY_PORT = 3002;
const HERMES_MCP_PROXY_PATH = '/mcp';
const PROXY_GRANT_FILE = '/run/argus-mcp/grant';

const PINNED_IMAGE = /^(?:[a-z0-9][a-z0-9.-]*(?::[1-9][0-9]{0,4})\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*@sha256:[a-f0-9]{64}$/;
const CANONICAL_HERMES_IMAGE = /^nousresearch\/hermes-agent@sha256:[a-f0-9]{64}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PRIVATE_RUN_NETWORK = /^argus-managed-[a-z0-9][a-z0-9_.-]{1,62}$/;
const CORE_EGRESS_NETWORK = /^argus-core-egress-[a-z0-9][a-z0-9_.-]{1,62}$/;
const PROVIDER_EGRESS_NETWORK = /^argus-provider-egress-[a-z0-9][a-z0-9_.-]{1,62}$/;
const DOCKER_VOLUME = /^[a-z0-9][a-z0-9_.-]{1,127}$/;
const INFERENCE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
const TOOLSETS = ['mcp', 'filesystem', 'terminal', 'browser'] as const;

export type DockerManagedRunnerPlatform = typeof PLATFORMS[number];
export type HermesManagedToolset = typeof TOOLSETS[number];

/**
 * Immutable upstream attestation selected by the runnerd operator, normally
 * derived from a reviewed release lock. A policy never gets to choose the
 * Hermes image: it must match this platform-specific canonical digest.
 *
 * `allowedToolsets` is deliberately platform-specific. It expresses the
 * subset that an independently tested image contract has proven enforceable;
 * it is not a request-time capability switch. The current policy still does
 * not make a runner ready until a real privileged launcher is installed.
 */
export interface CanonicalHermesRuntimeAttestation {
  platform: DockerManagedRunnerPlatform;
  hermesImage: string;
  allowedToolsets: readonly HermesManagedToolset[];
}

/**
 * The proxy image is independently attested: a digest alone is insufficient
 * because a random image could occupy the sidecar role but not implement the
 * restrictive Argus MCP auth proxy contract.
 */
export interface CanonicalMcpAuthProxyAttestation {
  platform: DockerManagedRunnerPlatform;
  mcpProxyImage: string;
  mcpAuthProxyContract: typeof ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT;
  /** Digest of the reviewed proxy contract/smoke-test artifact. */
  mcpAuthProxyContractDigest: string;
}

export interface DockerRunnerdCanonicalImagesAttestation {
  hermes: CanonicalHermesRuntimeAttestation;
  mcpProxy: CanonicalMcpAuthProxyAttestation;
}

export interface DockerResourceLimits {
  /** Container CPU ceiling in millicores. */
  cpuMillicores: number;
  /** Memory ceiling in MiB. */
  memoryMiB: number;
  /** Process ceiling for the isolated container. */
  pids: number;
}

/**
 * Operator-only input. It is intentionally an exact, small schema: there is
 * no field for mounts, volumes, host networking, published ports, commands,
 * arbitrary environment variables, or Docker/Kubernetes credentials.
 */
export interface DockerHermesRunnerdPolicyInput {
  apiVersion: typeof ARGUS_HERMES_DOCKER_RUNNER_POLICY;
  /** The machine platform for this runnerd instance. */
  platform: DockerManagedRunnerPlatform;
  /** Must be an allowed subset of the canonical image's toolset contract. */
  toolsets: readonly HermesManagedToolset[];
  /** Per-run network: Hermes and the proxy may join only this network. */
  privateNetwork: string;
  /** Operator-pinned network on which only the proxy can reach Argus Core. */
  coreEgressNetwork: string;
  /** Operator-pinned outbound network used only for the selected LLM provider. */
  providerEgressNetwork: string;
  /** Protected Hermes-only OAuth/API profile. Never a host path. */
  hermesAuthVolume: string;
  /** Explicit cost/auth boundary; no provider fallback is permitted. */
  provider: string;
  model: string;
  resources: {
    hermes: DockerResourceLimits;
    mcpProxy: DockerResourceLimits;
  };
}

export interface DockerContainerSecurityContract {
  readonly runAsNonRoot: true;
  readonly readOnlyRootFilesystem: true;
  readonly noNewPrivileges: true;
  readonly capDrop: readonly ['ALL'];
  /** No host path can be presented through this policy. */
  readonly hostMounts: readonly [];
  /** No Docker/containerd/CRI socket can be presented through this policy. */
  readonly engineSockets: readonly [];
}

export interface DockerManagedRunnerTopology {
  readonly apiVersion: typeof ARGUS_HERMES_DOCKER_RUNNER_POLICY;
  readonly networks: {
    /** Hermes and proxy only; never the host or a default bridge. */
    readonly run: {
      readonly name: string;
      readonly visibility: 'private';
      readonly hostNetwork: false;
      readonly publishedPorts: readonly [];
    };
    /** The only Core egress path; attached exclusively to the proxy. */
    readonly coreEgress: {
      readonly name: string;
      readonly visibility: 'operator-pinned-core-egress';
      readonly hostNetwork: false;
      readonly publishedPorts: readonly [];
    };
    readonly providerEgress: {
      readonly name: string;
      readonly visibility: 'operator-pinned-provider-egress';
      readonly hostNetwork: false;
      readonly publishedPorts: readonly [];
    };
  };
  readonly hermes: {
    readonly name: 'hermes';
    readonly platform: DockerManagedRunnerPlatform;
    readonly image: string;
    readonly command: readonly ['managed-oneshot'];
    /** Fixed at provisioning time from the operator attestation, never Core. */
    readonly toolsets: readonly HermesManagedToolset[];
    readonly resources: DockerResourceLimits;
    readonly security: DockerContainerSecurityContract;
    /** Hermes reaches Core only through the run proxy; provider egress is separate. */
    readonly attachedNetworks: readonly ['run', 'provider-egress'];
    /** Fresh per-run tmpfs state; never a host or shared Docker volume. */
    readonly hermesHome: { readonly kind: 'tmpfs'; readonly path: '/opt/data' };
    readonly authentication: {
      readonly source: 'operator-volume';
      readonly volume: string;
      readonly mountPath: '/run/argus-hermes-auth';
      readonly readOnly: true;
      readonly copiedFiles: readonly ['.env', 'auth.json'];
      readonly maxConcurrentRuns: 1;
    };
    readonly inference: { readonly provider: string; readonly model: string };
    /** Hermes sees only the local proxy, never Core or the bearer grant. */
    readonly mcpEndpoint: `http://${typeof HERMES_MCP_PROXY_HOST}:${typeof HERMES_MCP_PROXY_PORT}${typeof HERMES_MCP_PROXY_PATH}`;
  };
  readonly mcpProxy: {
    readonly name: typeof HERMES_MCP_PROXY_HOST;
    readonly image: string;
    readonly command: readonly ['node', 'dist/mcpAuthProxy.js'];
    readonly mcpAuthProxyContract: typeof ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT;
    readonly mcpAuthProxyContractDigest: string;
    readonly resources: DockerResourceLimits;
    readonly security: DockerContainerSecurityContract;
    /** The proxy is the sole container on the Core egress network. */
    readonly attachedNetworks: readonly ['run', 'core-egress'];
    /** Core origin comes only from runnerd's separately pinned configuration. */
    readonly coreOriginSource: 'runnerd-config-pinned';
    readonly grant: {
      readonly delivery: 'tmpfs-file';
      readonly path: typeof PROXY_GRANT_FILE;
      readonly mode: 0o600;
      readonly visibleTo: 'mcp-proxy-only';
    };
    readonly listen: {
      readonly host: typeof HERMES_MCP_PROXY_HOST;
      readonly port: typeof HERMES_MCP_PROXY_PORT;
      readonly path: typeof HERMES_MCP_PROXY_PATH;
    };
  };
}

export interface DockerRunnerdPolicyAvailable {
  /** A policy is eligible for a future launcher, not proof one is running. */
  state: 'eligible';
  policy: DockerManagedRunnerTopology;
}

export interface DockerRunnerdPolicyUnavailable {
  state: 'unavailable';
  code:
    | 'DOCKER_RUNNER_POLICY_NOT_CONFIGURED'
    | 'DOCKER_RUNNER_CANONICAL_IMAGE_UNAVAILABLE'
    | 'DOCKER_RUNNER_POLICY_INVALID';
  /** Intentionally static; it must never reflect raw operator configuration. */
  detail: string;
}

export type DockerRunnerdPolicyResolution = DockerRunnerdPolicyAvailable | DockerRunnerdPolicyUnavailable;

export class DockerRunnerdPolicyError extends Error {
  constructor() {
    super('Docker managed runner policy is invalid.');
  }
}

/**
 * Future privileged launcher interface. An implementation receives the Core
 * grant only inside `launch`; it must write it exclusively to the proxy's
 * 0600 tmpfs grant file, then discard it. The serializable topology contains
 * no prompt, instruction, Core endpoint, execution grant, or host control.
 */
export interface DockerManagedRunnerProvisioner {
  availability(): DockerRunnerdPolicyResolution;
  launch(request: ManagedHermesRunStartRequest, topology: DockerManagedRunnerTopology): Promise<HermesRunnerdRun>;
  status(runId: string): Promise<HermesRunnerdRun>;
  cancel(runId: string, reason?: string): Promise<HermesRunnerdRun>;
}

/**
 * Secure default until a separately deployed and reviewed Docker launcher is
 * installed. It cannot accidentally fall back to the local Docker daemon.
 */
export class UnprovisionedDockerManagedRunnerProvisioner implements DockerManagedRunnerProvisioner {
  availability(): DockerRunnerdPolicyUnavailable {
    return {
      state: 'unavailable',
      code: 'DOCKER_RUNNER_POLICY_NOT_CONFIGURED',
      detail: 'No isolated Docker managed runner provisioner is installed.',
    };
  }

  async launch(_request: ManagedHermesRunStartRequest, _topology: DockerManagedRunnerTopology): Promise<HermesRunnerdRun> {
    throw new DockerRunnerdPolicyError();
  }

  async status(_runId: string): Promise<HermesRunnerdRun> {
    throw new DockerRunnerdPolicyError();
  }

  async cancel(_runId: string, _reason?: string): Promise<HermesRunnerdRun> {
    throw new DockerRunnerdPolicyError();
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DockerRunnerdPolicyError();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new DockerRunnerdPolicyError();
}

function pinnedImage(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !PINNED_IMAGE.test(value)) {
    throw new DockerRunnerdPolicyError();
  }
  return value;
}

function privateNetwork(value: unknown): string {
  if (typeof value !== 'string' || !PRIVATE_RUN_NETWORK.test(value)
    || ['bridge', 'host', 'none', 'default'].includes(value)) {
    throw new DockerRunnerdPolicyError();
  }
  return value;
}

function coreEgressNetwork(value: unknown): string {
  if (typeof value !== 'string' || !CORE_EGRESS_NETWORK.test(value)
    || ['bridge', 'host', 'none', 'default'].includes(value)) {
    throw new DockerRunnerdPolicyError();
  }
  return value;
}

function providerEgressNetwork(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_EGRESS_NETWORK.test(value)
    || ['bridge', 'host', 'none', 'default'].includes(value)) {
    throw new DockerRunnerdPolicyError();
  }
  return value;
}

function dockerVolume(value: unknown): string {
  if (typeof value !== 'string' || !DOCKER_VOLUME.test(value)) throw new DockerRunnerdPolicyError();
  return value;
}

function inferenceIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !INFERENCE_IDENTIFIER.test(value)) throw new DockerRunnerdPolicyError();
  return value;
}

function platform(value: unknown): DockerManagedRunnerPlatform {
  if (typeof value !== 'string' || !PLATFORMS.includes(value as DockerManagedRunnerPlatform)) {
    throw new DockerRunnerdPolicyError();
  }
  return value as DockerManagedRunnerPlatform;
}

function toolsets(value: unknown): HermesManagedToolset[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TOOLSETS.length) {
    throw new DockerRunnerdPolicyError();
  }
  if (value.some(item => typeof item !== 'string' || !TOOLSETS.includes(item as HermesManagedToolset))) {
    throw new DockerRunnerdPolicyError();
  }
  const normalized = value as HermesManagedToolset[];
  if (new Set(normalized).size !== normalized.length) throw new DockerRunnerdPolicyError();
  return [...normalized];
}

function canonicalHermesRuntimeAttestation(value: unknown): CanonicalHermesRuntimeAttestation {
  const input = object(value);
  exactKeys(input, ['platform', 'hermesImage', 'allowedToolsets']);
  const hermesImage = pinnedImage(input.hermesImage);
  if (!CANONICAL_HERMES_IMAGE.test(hermesImage)) throw new DockerRunnerdPolicyError();
  const allowedToolsets = toolsets(input.allowedToolsets);
  if (!allowedToolsets.includes('mcp')) throw new DockerRunnerdPolicyError();
  return {
    platform: platform(input.platform),
    hermesImage,
    allowedToolsets,
  };
}

function canonicalMcpAuthProxyAttestation(value: unknown): CanonicalMcpAuthProxyAttestation {
  const input = object(value);
  exactKeys(input, ['platform', 'mcpProxyImage', 'mcpAuthProxyContract', 'mcpAuthProxyContractDigest']);
  if (input.mcpAuthProxyContract !== ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT) {
    throw new DockerRunnerdPolicyError();
  }
  if (typeof input.mcpAuthProxyContractDigest !== 'string' || !SHA256_DIGEST.test(input.mcpAuthProxyContractDigest)) {
    throw new DockerRunnerdPolicyError();
  }
  return {
    platform: platform(input.platform),
    mcpProxyImage: pinnedImage(input.mcpProxyImage),
    mcpAuthProxyContract: ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT,
    mcpAuthProxyContractDigest: input.mcpAuthProxyContractDigest,
  };
}

function canonicalDockerRunnerImagesAttestation(value: unknown): DockerRunnerdCanonicalImagesAttestation {
  const input = object(value);
  exactKeys(input, ['hermes', 'mcpProxy']);
  const hermes = canonicalHermesRuntimeAttestation(input.hermes);
  const mcpProxy = canonicalMcpAuthProxyAttestation(input.mcpProxy);
  if (hermes.platform !== mcpProxy.platform) throw new DockerRunnerdPolicyError();
  return { hermes, mcpProxy };
}

function boundedPositiveInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new DockerRunnerdPolicyError();
  }
  return Number(value);
}

function resourceLimits(value: unknown, kind: 'hermes' | 'mcpProxy'): DockerResourceLimits {
  const input = object(value);
  exactKeys(input, ['cpuMillicores', 'memoryMiB', 'pids']);
  const bounds = kind === 'hermes'
    ? { cpu: [250, 8_000], memory: [512, 32_768], pids: [64, 4_096] }
    : { cpu: [50, 1_000], memory: [64, 2_048], pids: [16, 512] };
  return {
    cpuMillicores: boundedPositiveInteger(input.cpuMillicores, bounds.cpu[0], bounds.cpu[1]),
    memoryMiB: boundedPositiveInteger(input.memoryMiB, bounds.memory[0], bounds.memory[1]),
    pids: boundedPositiveInteger(input.pids, bounds.pids[0], bounds.pids[1]),
  };
}

function securityContract(): DockerContainerSecurityContract {
  return {
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
    noNewPrivileges: true,
    capDrop: Object.freeze(['ALL']) as readonly ['ALL'],
    hostMounts: NO_HOST_MOUNTS,
    engineSockets: NO_ENGINE_SOCKETS,
  };
}

/**
 * Parses only operator-owned static configuration. The result is a closed
 * topology: no field supplied by a workflow or Pack request can widen it.
 */
export function validateDockerHermesRunnerdPolicy(
  value: unknown,
  canonicalAttestation: DockerRunnerdCanonicalImagesAttestation,
): DockerManagedRunnerTopology {
  const input = object(value);
  exactKeys(input, [
    'apiVersion', 'platform', 'toolsets', 'privateNetwork', 'coreEgressNetwork',
    'providerEgressNetwork', 'hermesAuthVolume', 'provider', 'model', 'resources',
  ]);
  if (input.apiVersion !== ARGUS_HERMES_DOCKER_RUNNER_POLICY) throw new DockerRunnerdPolicyError();

  const canonical = canonicalDockerRunnerImagesAttestation(canonicalAttestation);
  const selectedPlatform = platform(input.platform);
  const selectedToolsets = toolsets(input.toolsets);
  if (selectedPlatform !== canonical.hermes.platform
    || !selectedToolsets.includes('mcp')
    || selectedToolsets.some(toolset => !canonical.hermes.allowedToolsets.includes(toolset))) {
    throw new DockerRunnerdPolicyError();
  }

  const resources = object(input.resources);
  exactKeys(resources, ['hermes', 'mcpProxy']);
  const hermesResources = resourceLimits(resources.hermes, 'hermes');
  const proxyResources = resourceLimits(resources.mcpProxy, 'mcpProxy');
  const runNetwork = privateNetwork(input.privateNetwork);
  const pinnedCoreEgressNetwork = coreEgressNetwork(input.coreEgressNetwork);
  const pinnedProviderEgressNetwork = providerEgressNetwork(input.providerEgressNetwork);
  const authVolume = dockerVolume(input.hermesAuthVolume);
  const provider = inferenceIdentifier(input.provider);
  const model = inferenceIdentifier(input.model);
  if (new Set([runNetwork, pinnedCoreEgressNetwork, pinnedProviderEgressNetwork]).size !== 3) {
    throw new DockerRunnerdPolicyError();
  }

  return {
    apiVersion: ARGUS_HERMES_DOCKER_RUNNER_POLICY,
    networks: {
      run: {
        name: runNetwork,
        visibility: 'private',
        hostNetwork: false,
        publishedPorts: NO_PUBLISHED_PORTS,
      },
      coreEgress: {
        name: pinnedCoreEgressNetwork,
        visibility: 'operator-pinned-core-egress',
        hostNetwork: false,
        publishedPorts: NO_PUBLISHED_PORTS,
      },
      providerEgress: {
        name: pinnedProviderEgressNetwork,
        visibility: 'operator-pinned-provider-egress',
        hostNetwork: false,
        publishedPorts: NO_PUBLISHED_PORTS,
      },
    },
    hermes: {
      name: 'hermes',
      platform: selectedPlatform,
      image: canonical.hermes.hermesImage,
      command: HERMES_ONESHOT_COMMAND,
      toolsets: Object.freeze(selectedToolsets),
      resources: hermesResources,
      security: securityContract(),
      attachedNetworks: Object.freeze(['run', 'provider-egress']) as readonly ['run', 'provider-egress'],
      hermesHome: { kind: 'tmpfs', path: '/opt/data' },
      authentication: {
        source: 'operator-volume',
        volume: authVolume,
        mountPath: '/run/argus-hermes-auth',
        readOnly: true,
        copiedFiles: Object.freeze(['.env', 'auth.json']) as readonly ['.env', 'auth.json'],
        maxConcurrentRuns: 1,
      },
      inference: { provider, model },
      mcpEndpoint: `http://${HERMES_MCP_PROXY_HOST}:${HERMES_MCP_PROXY_PORT}${HERMES_MCP_PROXY_PATH}`,
    },
    mcpProxy: {
      name: HERMES_MCP_PROXY_HOST,
      image: canonical.mcpProxy.mcpProxyImage,
      command: MCP_PROXY_COMMAND,
      mcpAuthProxyContract: canonical.mcpProxy.mcpAuthProxyContract,
      mcpAuthProxyContractDigest: canonical.mcpProxy.mcpAuthProxyContractDigest,
      resources: proxyResources,
      security: securityContract(),
      attachedNetworks: Object.freeze(['run', 'core-egress']) as readonly ['run', 'core-egress'],
      coreOriginSource: 'runnerd-config-pinned',
      grant: {
        delivery: 'tmpfs-file',
        path: PROXY_GRANT_FILE,
        mode: 0o600,
        visibleTo: 'mcp-proxy-only',
      },
      listen: {
        host: HERMES_MCP_PROXY_HOST,
        port: HERMES_MCP_PROXY_PORT,
        path: HERMES_MCP_PROXY_PATH,
      },
    },
  };
}

/**
 * Missing or malformed policy is intentionally not a degraded mode. The
 * caller receives only a static unavailable reason and must keep runnerd
 * fail-closed instead of attempting a Docker fallback.
 */
export function resolveDockerHermesRunnerdPolicy(
  value: unknown,
  canonicalAttestation?: DockerRunnerdCanonicalImagesAttestation,
): DockerRunnerdPolicyResolution {
  if (value === undefined || value === null) {
    return {
      state: 'unavailable',
      code: 'DOCKER_RUNNER_POLICY_NOT_CONFIGURED',
      detail: 'No isolated Docker managed runner policy is configured.',
    };
  }
  if (!canonicalAttestation) {
    return {
      state: 'unavailable',
      code: 'DOCKER_RUNNER_CANONICAL_IMAGE_UNAVAILABLE',
      detail: 'No canonical Hermes image attestation is available.',
    };
  }
  try {
    return { state: 'eligible', policy: validateDockerHermesRunnerdPolicy(value, canonicalAttestation) };
  } catch {
    return {
      state: 'unavailable',
      code: 'DOCKER_RUNNER_POLICY_INVALID',
      detail: 'The isolated Docker managed runner policy is not eligible.',
    };
  }
}
