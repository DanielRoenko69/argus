import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const MAX_SECRET_BYTES = 8 * 1024;
const DEFAULT_RUNNERD_PORT = 2042;
const DEFAULT_RUNNERD_STATE_DIRECTORY = '/var/lib/argus-hermes-runnerd';

/**
 * Separate configuration for the privileged runnerd process.
 *
 * It intentionally has no container image, command, mount, network or
 * upstream Hermes URL setting. Those are future operator-owned launcher
 * policy, not Pack-controlled configuration.
 */
export interface HermesRunnerdConfig {
  port: number;
  serviceToken: string;
  /** Pinned Core origin used for independent launch-envelope validation. */
  coreRuntimeMcpOrigin: string;
  /** Durable redacted runnerd registry; never contains a managed request. */
  stateDirectory: string;
}

function readSecretFile(filename: string): string {
  const raw = readFileSync(filename, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_BYTES) {
    throw new Error('runnerd service token exceeds the allowed size');
  }
  const value = raw.trim();
  if (!value || /[\r\n\u0000]/.test(value)) throw new Error('runnerd service token is malformed');
  return value;
}

function readServiceToken(env: NodeJS.ProcessEnv): string {
  const filename = env['ARGUS_HERMES_RUNNERD_TOKEN_FILE']?.trim();
  if (filename) return readSecretFile(filename);
  const value = env['ARGUS_HERMES_RUNNERD_TOKEN']?.trim();
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES || /[\r\n\u0000]/.test(value)) {
    throw new Error('ARGUS_HERMES_RUNNERD_TOKEN or ARGUS_HERMES_RUNNERD_TOKEN_FILE is required');
  }
  return value;
}

function readPort(value: string | undefined): number {
  const port = Number.parseInt(value ?? String(DEFAULT_RUNNERD_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('ARGUS_HERMES_RUNNERD_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function normalizeHttpOrigin(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be a valid HTTP(S) origin`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error(`${label} must be a credential-free HTTP(S) origin`);
  }
  return parsed.origin;
}

function stateDirectory(value: string | undefined): string {
  const directory = (value ?? DEFAULT_RUNNERD_STATE_DIRECTORY).trim();
  if (!directory || !isAbsolute(directory) || directory.length > 1_024 || /[\r\n\u0000]/.test(directory)) {
    throw new Error('ARGUS_HERMES_RUNNERD_STATE_DIRECTORY is malformed');
  }
  return directory;
}

export function loadHermesRunnerdConfig(env: NodeJS.ProcessEnv = process.env): HermesRunnerdConfig {
  return {
    port: readPort(env['ARGUS_HERMES_RUNNERD_PORT']),
    serviceToken: readServiceToken(env),
    coreRuntimeMcpOrigin: normalizeHttpOrigin(env['ARGUS_CORE_RUNTIME_MCP_ORIGIN'], 'ARGUS_CORE_RUNTIME_MCP_ORIGIN'),
    stateDirectory: stateDirectory(env['ARGUS_HERMES_RUNNERD_STATE_DIRECTORY']),
  };
}
