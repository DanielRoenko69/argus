/** Credential-free repository inputs; the separately confined broker only downloads wheels. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bytesHash, environmentHash, parseCatalog, projectIdentity, type EnvironmentPlan, type EnvironmentProfile } from './catalog.js';

export type EnvironmentRequirement = { requirement: string; reason: string };
export type ResolverInput = { version: 1; runtime: string; namespace: string; manifests: Record<string, string>; supplements: EnvironmentRequirement[] };
export const dynamicEnvironments = () => process.env['ARGUS_PROJECT_ENVIRONMENTS_MODE'] === 'python-public-wheels-v1';
const URL = 'http://environment-resolver:8092';
const digest = /^[a-f0-9]{64}$/;
export function parseRequirements(value: unknown): EnvironmentRequirement[] {
  if (!Array.isArray(value) || value.length > 12 || value.some(v => !v || typeof v !== 'object'
    || Object.keys(v).sort().join(',') !== 'reason,requirement'
    || typeof v.requirement !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.\[\],<>=!~; '"()-]{0,255}$/.test(v.requirement)
    || typeof v.reason !== 'string' || !v.reason.trim() || v.reason.length > 1000)
    || new Set(value.map(v => v.requirement)).size !== value.length) throw new Error('environment_supplement_invalid');
  return value;
}
async function headers() {
  const secret = (await readFile('/run/secrets/environment_resolver', 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('environment_resolver_unavailable');
  return { 'content-type': 'application/json', 'x-environment-secret': secret };
}
function reason(value: unknown) { return typeof value === 'string' && /^environment_[a-z_]{1,80}$/.test(value) ? value : 'environment_resolver_unavailable'; }
async function post(action: 'plan' | 'resolve', input: ResolverInput, signal?: AbortSignal) {
  const response = await fetch(`${URL}/${action}`, { method: 'POST', headers: await headers(), body: JSON.stringify(input),
    signal: AbortSignal.any([AbortSignal.timeout(action === 'plan' ? 5000 : 200000), ...(signal ? [signal] : [])]) });
  const text = await response.text();
  if (text.length > 128000) throw new Error('environment_resolver_invalid');
  const result = JSON.parse(text);
  if (!response.ok) throw new Error(reason(result?.error));
  return result;
}
export async function planResolvedEnvironment(manifest: Array<[string, string]>, input: ResolverInput): Promise<EnvironmentPlan> {
  const identity = projectIdentity(manifest);
  let policy: string | null = null;
  const reasons: string[] = [];
  if (identity.languages.join(',') !== 'python') reasons.push('environment_adapter_not_available');
  if (!reasons.length) {
    try {
      const result = await post('plan', input);
      if (result.status !== 'ready' || !digest.test(result.policySha256) || result.runtime !== input.runtime) throw new Error('environment_resolver_invalid');
      policy = result.policySha256;
    } catch (error) { reasons.push(reason((error as Error).message)); }
  }
  const p = { version: 1 as const, status: reasons.length ? 'blocked' as const : 'ready' as const, ...identity,
    profileId: 'python-public-wheels-v1', profileSha256: policy ? environmentHash([policy, identity.manifestSha256, input.supplements]) : null,
    runtime: input.runtime, reasons };
  return { ...p, planSha256: environmentHash([p.version, p.status, p.languages, p.manifestSha256, p.profileId, p.profileSha256, p.runtime, p.reasons]) };
}
export type Resolution = { requestSha256: string; requirementsSha256: string; lockSha256: string; policySha256: string };
export async function resolveEnvironment(plan: EnvironmentPlan, input: ResolverInput, wheelhouse: string, signal?: AbortSignal): Promise<{ profile: EnvironmentProfile; resolution: Resolution }> {
  signal = AbortSignal.any([AbortSignal.timeout(220000), ...(signal ? [signal] : [])]);
  const result = await post('resolve', input, signal);
  if (result.status !== 'ready') throw new Error(reason(result.reason));
  if (result.requestSha256 !== environmentHash(input) || !digest.test(result.policySha256)
    || !digest.test(result.lockSha256) || !digest.test(result.requirementsSha256)
    || environmentHash([result.policySha256, plan.manifestSha256, input.supplements]) !== plan.profileSha256) throw new Error('environment_plan_changed');
  const profile = parseCatalog({ version: 1, profiles: [{ id: 'python-public-wheels-v1', adapter: 'python-wheels-v1',
    manifestSha256: plan.manifestSha256, pythonVersion: plan.runtime.split('-')[1]!.split('.').slice(0, 2).join('.'),
    wheels: result.wheels, imports: ['pytest', 'packaging'] }] })[0]!;
  let bytes = 0;
  for (const wheel of profile.wheels) {
    const response = await fetch(`${URL}/wheels/${input.namespace}/${result.requestSha256}/${wheel.file}`, {
      headers: await headers(), signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.body) throw new Error('environment_artifact_unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length; bytes += chunk.length;
      if (size > 128 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error('environment_artifact_limit');
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (bytesHash(content) !== wheel.sha256) throw new Error('environment_artifact_hash_mismatch');
    await writeFile(path.join(wheelhouse, wheel.file), content, { flag: 'wx', mode: 0o400 });
  }
  const { requestSha256, requirementsSha256, lockSha256, policySha256 } = result;
  return { profile, resolution: { requestSha256, requirementsSha256, lockSha256, policySha256 } };
}
