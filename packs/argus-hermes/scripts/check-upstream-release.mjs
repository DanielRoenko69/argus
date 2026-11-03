import { readFile } from 'node:fs/promises';
import process from 'node:process';

const lockPath = new URL('../upstream/hermes-release-lock.json', import.meta.url);
const lock = JSON.parse(await readFile(lockPath, 'utf8'));

function fail(message) {
  process.stderr.write(`[argus.hermes] ${message}\n`);
  process.exitCode = 1;
}

function validate(channelName, channel) {
  if (!channel || typeof channel !== 'object') return fail(`channel '${channelName}' is missing`);
  if (typeof channel.releaseRef !== 'string' || !/^v[0-9A-Za-z._-]+$/.test(channel.releaseRef)) {
    return fail(`channel '${channelName}' must pin an upstream Git tag in releaseRef`);
  }
  if (channel.managedImageDigest !== null && (typeof channel.managedImageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(channel.managedImageDigest))) {
    return fail(`channel '${channelName}' managedImageDigest must be null or an immutable sha256 digest`);
  }
  if (channel.managedRuntimeEligible === true && !channel.managedImageDigest) {
    return fail(`channel '${channelName}' cannot enable a managed runtime without an immutable image digest`);
  }
}

if (lock.schemaVersion !== 'argus.hermes.upstream/v1alpha1') fail('unsupported upstream lock schema');
if (lock.upstream?.repository !== 'NousResearch/hermes-agent') fail('unexpected upstream repository');
if (lock.upstream?.containerImage !== 'nousresearch/hermes-agent') fail('unexpected upstream container image');
validate('stable', lock.channels?.stable);
validate('candidate', lock.channels?.candidate);
if (lock.channels?.stable?.managedRuntimeEligible === true) {
  const rollback = lock.rollbackCertification;
  if (!rollback || rollback.stableReleaseRef !== lock.channels.stable.releaseRef
    || !['attached-only', 'previous-managed-image'].includes(rollback.strategy)
    || !/^\d{4}-\d{2}-\d{2}$/.test(rollback.certifiedAt ?? '')
    || rollback.restoredCandidateRun !== 'completed'
    || rollback.orphanContainers !== 0 || rollback.orphanNetworks !== 0) {
    fail('managed stable channel requires a successful rollback-and-restore certification');
  }
  if (rollback.strategy === 'attached-only'
    && (rollback.fallbackAttachedState !== 'ready' || rollback.fallbackManagedState !== 'unavailable')) {
    fail('attached-only rollback must keep Attached ready and Managed unavailable');
  }
}
const attached = lock.attachedCapabilityHandshake;
if (!attached || typeof attached !== 'object') fail('attachedCapabilityHandshake is missing');
if (attached?.releaseRef !== lock.channels?.stable?.releaseRef) {
  fail('attachedCapabilityHandshake must match the stable releaseRef');
}
if (attached?.health?.platform !== 'hermes-agent' || attached?.health?.version !== '0.18.2') {
  fail('attachedCapabilityHandshake health contract must pin hermes-agent package version 0.18.2');
}
if (attached?.capabilities?.object !== 'hermes.api_server.capabilities'
  || attached?.capabilities?.platform !== 'hermes-agent'
  || attached?.capabilities?.runtime?.mode !== 'server_agent'
  || attached?.capabilities?.runtime?.tool_execution !== 'server'
  || attached?.capabilities?.runtime?.split_runtime !== false) {
  fail('attachedCapabilityHandshake runtime contract is invalid');
}
if (attached?.governance !== 'external_attested' || attached?.runtimeMcpLease !== 'unsupported') {
  fail('attachedCapabilityHandshake must remain external_attested without runtime MCP leases');
}
if (process.exitCode) process.exit(process.exitCode);

if (process.argv.includes('--offline')) {
  process.stdout.write(`[argus.hermes] lock valid: stable=${lock.channels.stable.releaseRef}, candidate=${lock.channels.candidate.releaseRef}\n`);
  process.exit(0);
}

const response = await fetch(`https://api.github.com/repos/${lock.upstream.repository}/releases/latest`, {
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': 'argus-hermes-upstream-watch',
  },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) fail(`upstream release check returned HTTP ${response.status}`);
const latest = await response.json();
const tag = typeof latest.tag_name === 'string' ? latest.tag_name : '';
if (!tag) fail('upstream release response has no tag_name');

const known = new Set([lock.channels.stable.releaseRef, lock.channels.candidate.releaseRef]);
if (known.has(tag)) {
  process.stdout.write(`[argus.hermes] upstream release is already tracked: ${tag}\n`);
} else {
  // This is intentionally informational: the workflow should notify maintainers
  // but never auto-pull or auto-deploy an upstream agent release.
  process.stdout.write(`::notice title=Hermes update available::Upstream released ${tag}; validate it in the candidate channel before promotion.\n`);
}
