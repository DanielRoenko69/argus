import { readFileSync } from 'node:fs';

const MAX_SECRET_BYTES = 8 * 1024;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30_000;
const MIN_MANAGED_RUNNER_POLL_MS = 250;
const MAX_MANAGED_RUNNER_POLL_MS = 30_000;
const DEFAULT_MANAGED_RUN_STATE_DIRECTORY = '/var/lib/argus-hermes';

export interface ArgusHermesConfig {
  port: number;
  publicUrl: string;
  discoveryToken?: string;
  /**
   * Trusted Core origin used by a future isolated managed runner to construct
   * its only runtime MCP endpoint. It is optional while no managed runner is
   * available, but a provisioner must fail closed when it is absent.
   */
  coreRuntimeMcpOrigin?: string;
  /**
   * Narrow internal runner-broker origin. The Pack talks to this service but
   * never receives a Docker socket or any caller-selected container options.
   */
  managedRunnerBrokerUrl?: string;
  /** Service credential used only from the Pack to the internal broker. */
  managedRunnerBrokerToken?: string;
  /** Durable, redacted Pack lifecycle state; never contains a grant. */
  managedRunStateDirectory?: string;
  /** Bounded poll interval for Pack-owned normalized lifecycle reconciliation. */
  managedRunnerPollMs?: number;
  hermesBaseUrl?: string;
  hermesApiKey?: string;
  requestTimeoutMs: number;
}

function readSecretFile(filename: string, label: string): string {
  const raw = readFileSync(filename, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_SECRET_BYTES / 1024} KiB limit`);
  }
  const value = raw.trim();
  if (!value || /[\r\n]/.test(value)) throw new Error(`${label} is empty or malformed`);
  return value;
}

function readOptionalSecret(env: NodeJS.ProcessEnv, fileKey: string, inlineKey: string, label: string): string | undefined {
  const file = env[fileKey]?.trim();
  if (file) return readSecretFile(file, label);
  const inline = env[inlineKey]?.trim();
  if (!inline) return undefined;
  if (Buffer.byteLength(inline, 'utf8') > MAX_SECRET_BYTES || /[\r\n]/.test(inline)) {
    throw new Error(`${label} is malformed`);
  }
  return inline;
}

function readPort(value: string | undefined): number {
  const port = Number.parseInt(value ?? '2040', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535');
  return port;
}

function readTimeout(value: string | undefined): number {
  const timeout = Number.parseInt(value ?? '5000', 10);
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`HERMES_REQUEST_TIMEOUT_MS must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return timeout;
}

function readManagedRunnerPollMs(value: string | undefined): number {
  const pollMs = Number.parseInt(value ?? '1000', 10);
  if (!Number.isInteger(pollMs) || pollMs < MIN_MANAGED_RUNNER_POLL_MS || pollMs > MAX_MANAGED_RUNNER_POLL_MS) {
    throw new Error(
      `ARGUS_HERMES_RUNNERD_POLL_MS must be an integer from ${MIN_MANAGED_RUNNER_POLL_MS} to ${MAX_MANAGED_RUNNER_POLL_MS}`,
    );
  }
  return pollMs;
}

function readManagedRunStateDirectory(value: string | undefined): string {
  const directory = (value ?? DEFAULT_MANAGED_RUN_STATE_DIRECTORY).trim();
  if (!directory || directory.length > 1_024 || /[\r\n\u0000]/.test(directory)) {
    throw new Error('ARGUS_HERMES_MANAGED_STATE_DIRECTORY is malformed');
  }
  return directory;
}

function normalizeHttpOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${label} must use HTTP or HTTPS`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error(`${label} must be an origin without credentials, path, query or fragment`);
  }
  return parsed.origin;
}

/**
 * A managed Hermes runner must never accept an arbitrary caller-provided MCP
 * URL. Keeping this guard next to configuration makes the future provisioner
 * opt into a concrete Core origin before it can start a runner.
 */
export function requireManagedRuntimeMcpOrigin(config: Pick<ArgusHermesConfig, 'coreRuntimeMcpOrigin'>): string {
  if (!config.coreRuntimeMcpOrigin) {
    throw new Error('ARGUS_CORE_RUNTIME_MCP_ORIGIN is required before an Argus-managed Hermes runner can be enabled');
  }
  return config.coreRuntimeMcpOrigin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ArgusHermesConfig {
  const port = readPort(env['PORT']);
  const publicUrl = normalizeHttpOrigin(env['ARGUS_HERMES_PUBLIC_URL'] ?? `http://localhost:${port}`, 'ARGUS_HERMES_PUBLIC_URL');
  const hermesBase = env['HERMES_BASE_URL']?.trim();
  const coreRuntimeMcpOrigin = env['ARGUS_CORE_RUNTIME_MCP_ORIGIN']?.trim();
  const managedRunnerBroker = env['ARGUS_HERMES_RUNNERD_URL']?.trim();
  const managedRunnerBrokerToken = readOptionalSecret(
    env,
    'ARGUS_HERMES_RUNNERD_TOKEN_FILE',
    'ARGUS_HERMES_RUNNERD_TOKEN',
    'Argus Hermes runner broker token',
  );
  if (Boolean(managedRunnerBroker) !== Boolean(managedRunnerBrokerToken)) {
    throw new Error('Configure ARGUS_HERMES_RUNNERD_URL and its token together');
  }
  if (managedRunnerBroker && !coreRuntimeMcpOrigin) {
    throw new Error('ARGUS_CORE_RUNTIME_MCP_ORIGIN is required when ARGUS_HERMES_RUNNERD_URL is configured');
  }
  return {
    port,
    publicUrl,
    discoveryToken: readOptionalSecret(env, 'ARGUS_PACK_DISCOVERY_TOKEN_FILE', 'ARGUS_PACK_DISCOVERY_TOKEN', 'Argus Pack discovery token'),
    coreRuntimeMcpOrigin: coreRuntimeMcpOrigin
      ? normalizeHttpOrigin(coreRuntimeMcpOrigin, 'ARGUS_CORE_RUNTIME_MCP_ORIGIN')
      : undefined,
    managedRunnerBrokerUrl: managedRunnerBroker
      ? normalizeHttpOrigin(managedRunnerBroker, 'ARGUS_HERMES_RUNNERD_URL')
      : undefined,
    managedRunnerBrokerToken,
    managedRunStateDirectory: readManagedRunStateDirectory(env['ARGUS_HERMES_MANAGED_STATE_DIRECTORY']),
    managedRunnerPollMs: readManagedRunnerPollMs(env['ARGUS_HERMES_RUNNERD_POLL_MS']),
    hermesBaseUrl: hermesBase ? normalizeHttpOrigin(hermesBase, 'HERMES_BASE_URL') : undefined,
    hermesApiKey: readOptionalSecret(env, 'HERMES_API_KEY_FILE', 'HERMES_API_KEY', 'Hermes API key'),
    requestTimeoutMs: readTimeout(env['HERMES_REQUEST_TIMEOUT_MS']),
  };
}
