import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  resolveDockerHermesRunnerdPolicy,
  type DockerRunnerdCanonicalImagesAttestation,
} from './dockerRunnerdPolicy.js';
import {
  DockerCliManagedRunnerProvisioner,
  DockerManagedHermesRunnerdLauncher,
  dockerManagedRunnerPreflight,
} from './dockerCliManagedRunner.js';
import type { HermesRunnerdConfig } from './runnerdConfig.js';
import type { HermesRunnerdLauncher } from './runnerdLauncher.js';

const MAX_POLICY_BYTES = 64 * 1024;

function optionalAbsolutePath(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!isAbsolute(normalized) || normalized.length > 1_024 || /[\r\n\u0000]/.test(normalized)) {
    throw new Error(`${label} is malformed`);
  }
  return normalized;
}

function jsonFile(filename: string): unknown {
  const raw = readFileSync(filename, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BYTES) throw new Error('runnerd Docker policy file is too large');
  return JSON.parse(raw) as unknown;
}

/**
 * Docker execution is opt-in through two read-only operator files. Absence or
 * malformed configuration never guesses a local Docker policy and never
 * downgrades to Attached Hermes.
 */
export function createConfiguredDockerRunnerdLauncher(
  config: HermesRunnerdConfig,
  env: NodeJS.ProcessEnv = process.env,
): HermesRunnerdLauncher | undefined {
  const policyFile = optionalAbsolutePath(env['ARGUS_HERMES_DOCKER_POLICY_FILE'], 'ARGUS_HERMES_DOCKER_POLICY_FILE');
  const attestationFile = optionalAbsolutePath(
    env['ARGUS_HERMES_DOCKER_ATTESTATION_FILE'],
    'ARGUS_HERMES_DOCKER_ATTESTATION_FILE',
  );
  if (!policyFile && !attestationFile) return undefined;
  if (!policyFile || !attestationFile) throw new Error('both Docker runnerd policy files are required');

  const policy = jsonFile(policyFile);
  const attestation = jsonFile(attestationFile) as DockerRunnerdCanonicalImagesAttestation;
  const resolution = resolveDockerHermesRunnerdPolicy(policy, attestation);
  const provisioner = new DockerCliManagedRunnerProvisioner(resolution, {
    coreRuntimeMcpOrigin: config.coreRuntimeMcpOrigin,
  });
  const preflightPassed = resolution.state === 'eligible' && dockerManagedRunnerPreflight(resolution.policy);
  return new DockerManagedHermesRunnerdLauncher(resolution, provisioner, preflightPassed);
}
