/** Operator-owned policy. Repository files and agents can describe needs, never install authority. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const environmentHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
export const ENVIRONMENT_ROOT = '/opt/argus-environments';
export const LANGUAGES = ['python', 'node', 'java', 'dotnet', 'go', 'rust'] as const;
export type Language = typeof LANGUAGES[number];
export type Wheel = { file: string; name: string; version: string; sha256: string };
export type EnvironmentProfile = {
  id: string; adapter: 'python-wheels-v1'; manifestSha256: string; pythonVersion: string;
  wheels: Wheel[]; imports: string[];
};
export type EnvironmentPlan = {
  version: 1; status: 'ready' | 'blocked'; languages: Language[]; manifestSha256: string;
  profileId: string | null; profileSha256: string | null; runtime: string;
  reasons: string[]; planSha256: string;
};
const digest = /^[a-f0-9]{64}$/;
const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const distribution = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const version = /^[0-9][a-zA-Z0-9.!+_-]{0,63}$/;
function object(v: unknown, keys: string[]): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === keys.sort().join(','));
}
export function parseCatalog(value: unknown): EnvironmentProfile[] {
  if (!object(value, ['version', 'profiles']) || value.version !== 1 || !Array.isArray(value.profiles)
    || value.profiles.length > 64) throw new Error('environment_catalog_invalid');
  const profiles = value.profiles as EnvironmentProfile[];
  for (const p of profiles) {
    if (!object(p, ['id', 'adapter', 'manifestSha256', 'pythonVersion', 'wheels', 'imports'])
      || typeof p.id !== 'string' || !identifier.test(p.id) || p.adapter !== 'python-wheels-v1' || typeof p.manifestSha256 !== 'string' || !digest.test(p.manifestSha256)
      || typeof p.pythonVersion !== 'string' || !/^3\.\d{1,2}$/.test(p.pythonVersion) || !Array.isArray(p.wheels) || !p.wheels.length || p.wheels.length > 128
      || !Array.isArray(p.imports) || !p.imports.length || p.imports.length > 32
      || p.imports.some(i => typeof i !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(i) || i.length > 128)
      || p.wheels.some(w => !object(w, ['file', 'name', 'version', 'sha256']) || typeof w.name !== 'string' || !distribution.test(w.name)
        || typeof w.version !== 'string' || !version.test(w.version)
        || typeof w.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,220}\.whl$/.test(w.file)
        || typeof w.sha256 !== 'string' || !digest.test(w.sha256))
      || new Set(p.wheels.map(w => w.name)).size !== p.wheels.length
      || new Set(p.wheels.map(w => w.file)).size !== p.wheels.length
      || !p.wheels.some(w => w.name === 'pytest') || !p.wheels.some(w => w.name === 'packaging')) {
      throw new Error('environment_catalog_invalid');
    }
  }
  if (new Set(profiles.map(p => p.id)).size !== profiles.length
    || new Set(profiles.map(p => p.manifestSha256)).size !== profiles.length) throw new Error('environment_catalog_ambiguous');
  return profiles;
}

/** No symlink, writable parent or agent-owned catalog/artifact is install authority. */
export async function assertReadOnlyMount(file: string) {
  // Root ownership alone is insufficient on legacy workspaces with an operator pip helper.
  // Require a kernel-enforced read-only mount as well, not a claimed permission bit.
  const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').map(l => l.split(' '))
    .filter(p => p.length > 6 && (file === p[4] || file.startsWith(p[4] === '/' ? '/' : `${p[4]}/`)))
    .sort((a, b) => b[4]!.length - a[4]!.length);
  if (!mounts[0]?.[5]?.split(',').includes('ro')) throw new Error('environment_policy_mount_not_readonly');
}
export async function readOperatorFile(file: string, limit: number): Promise<Buffer> {
  if (!file.startsWith(`${ENVIRONMENT_ROOT}/`) || path.normalize(file) !== file || await realpath(file) !== file) {
    throw new Error('environment_policy_untrusted');
  }
  await assertReadOnlyMount(file);
  let current = file;
  while (current !== '/') {
    const stat = await lstat(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink()
      || (current === file ? !stat.isFile() || stat.nlink !== 1 || stat.size > limit : !stat.isDirectory())) {
      throw new Error('environment_policy_untrusted');
    }
    current = path.dirname(current);
  }
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.nlink !== 1 || stat.size > limit) throw new Error('environment_policy_untrusted');
    const data = await fd.readFile();
    if (data.length > limit) throw new Error('environment_artifact_limit');
    return data;
  } finally { await fd.close(); }
}
export async function assertEnvironmentTools() {
  await assertReadOnlyMount('/opt/argus-environment-tools');
  const tools = await lstat('/opt/argus-environment-tools');
  if (!tools.isDirectory() || tools.uid !== 0 || (tools.mode & 0o022)
    || await realpath('/opt/argus-environment-tools') !== '/opt/argus-environment-tools') throw new Error('environment_policy_untrusted');
}
export async function readCatalog() {
  await assertEnvironmentTools();
  return parseCatalog(JSON.parse((await readOperatorFile(`${ENVIRONMENT_ROOT}/catalog.json`, 128_000)).toString('utf8')));
}

const markers: Record<string, Language> = {
  'requirements.txt': 'python', 'pyproject.toml': 'python', 'setup.py': 'python', 'setup.cfg': 'python',
  'uv.lock': 'python', 'poetry.lock': 'python', 'Pipfile': 'python', 'Pipfile.lock': 'python',
  'package.json': 'node', 'package-lock.json': 'node', 'pnpm-lock.yaml': 'node', 'yarn.lock': 'node', 'bun.lock': 'node', 'bun.lockb': 'node',
  'pom.xml': 'java', 'build.gradle': 'java', 'build.gradle.kts': 'java', 'gradle.lockfile': 'java',
  'global.json': 'dotnet', 'packages.lock.json': 'dotnet', 'go.mod': 'go', 'go.sum': 'go', 'Cargo.toml': 'rust', 'Cargo.lock': 'rust',
};
export function manifestLanguage(name: string): Language | undefined {
  const base = path.posix.basename(name);
  return markers[base] ?? (/\.(?:csproj|fsproj|vbproj)$/.test(base) ? 'dotnet'
    : /^requirements(?:[-.][A-Za-z0-9_-]+)?\.txt$/.test(base) ? 'python' : undefined);
}
export function projectIdentity(manifest: Array<[string, string]>) {
  const selected = manifest.filter(([name]) => manifestLanguage(name)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (selected.length > 128) throw new Error('environment_manifest_limit');
  return { manifestSha256: environmentHash(selected),
    languages: [...new Set(selected.map(([name]) => manifestLanguage(name)!))].sort() as Language[] };
}
export function planEnvironment(manifest: Array<[string, string]>, runtime: string, profiles: EnvironmentProfile[], catalogAvailable = true): EnvironmentPlan {
  const identity = projectIdentity(manifest);
  const p = profiles.find(p => p.manifestSha256 === identity.manifestSha256);
  const reasons: string[] = [];
  if (!catalogAvailable) reasons.push('environment_catalog_unavailable');
  if (!identity.languages.length) reasons.push('environment_project_unknown');
  if (identity.languages.length !== 1 || identity.languages[0] !== 'python') reasons.push('environment_adapter_not_available');
  if (!p) reasons.push('environment_profile_required');
  if (p && !runtime.startsWith(`cpython-${p.pythonVersion}.`)) reasons.push('environment_runtime_mismatch');
  const plan = { version: 1 as const, status: reasons.length ? 'blocked' as const : 'ready' as const,
    ...identity, profileId: p?.id ?? null, profileSha256: p ? environmentHash(p) : null, runtime, reasons };
  return { ...plan, planSha256: environmentHash([plan.version, plan.status, plan.languages, plan.manifestSha256,
    plan.profileId, plan.profileSha256, plan.runtime, plan.reasons]) };
}
