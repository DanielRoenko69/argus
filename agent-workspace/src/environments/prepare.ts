import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { executeSandbox } from '../routes/technicalExperiment.js';
import { bytesHash, environmentHash, ENVIRONMENT_ROOT, readCatalog, readOperatorFile, assertEnvironmentTools, type EnvironmentPlan, type EnvironmentProfile } from './catalog.js';
import { resolveEnvironment, type Resolution, type ResolverInput } from './resolver.js';

const exec = promisify(execFile);
export type EnvironmentReceipt = {
  version: 1; plan: EnvironmentPlan; status: 'ready' | 'blocked'; reason: string | null;
  packages: Array<{ name: string; version: string; sha256: string }>;
  installationOutputSha256: string | null; preflightOutputSha256: string | null;
  resolution?: Resolution;
};
export async function pythonRuntime() {
  const { stdout } = await exec('/usr/bin/python3', ['-I', '-S', '-c',
    'import sys,platform; print("%s-%s-%s-%s" % (sys.implementation.name, platform.python_version(), sys.platform, platform.machine()))'],
  { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 2000, maxBuffer: 256 });
  const value = stdout.trim();
  if (!/^cpython-3\.\d+\.\d+-linux-[A-Za-z0-9_]+$/.test(value)) throw new Error('environment_runtime_unavailable');
  return value;
}
/** Only image-owned packaging code is probed, without project paths or inherited credentials.
 * Alpine's platform discovery invokes its trusted loader; never permit that subprocess inside QA. */
async function compatibleWheelTags(): Promise<string[]> {
  const { stdout } = await exec('/usr/bin/python3', ['-I', '-S', '-c',
    "import sys,json; sys.path.insert(0,'/opt/argus-environment-tools'); from packaging.tags import sys_tags; print(json.dumps([str(t) for t in sys_tags()]))"],
  { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 3000, maxBuffer: 128000 });
  const tags = JSON.parse(stdout);
  if (!Array.isArray(tags) || !tags.length || tags.length > 2048 || tags.some(t => typeof t !== 'string' || !/^[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_]+$/.test(t))) {
    throw new Error('environment_runtime_unavailable');
  }
  return tags;
}
/** Fixed wheel installation: no resolver, sdists, build hooks, dependency code, network or subprocesses.
 * The complete resolved dependency closure is part of the operator-approved profile. */
export function installationProbe(profile: EnvironmentProfile, tags: string[]): string {
  return `import sys, pathlib, zipfile, json, hashlib
sys.path.insert(0, '/environment-tools')
from installer import install
from installer.sources import WheelFile
from installer.destinations import SchemeDictionaryDestination
from packaging.utils import parse_wheel_filename
expected = json.loads(${JSON.stringify(JSON.stringify(profile.wheels))})
compatible = set(json.loads(${JSON.stringify(JSON.stringify(tags))}))
# Bound decompression before the installer sees approved but potentially malformed wheels.
total = 0
entries = 0
for package in expected:
 wheel = pathlib.Path('/wheelhouse') / package['file']
 if hashlib.sha256(wheel.read_bytes()).hexdigest() != package['sha256']: raise RuntimeError('environment_artifact_hash_mismatch')
 name, version, build, wheel_tags = parse_wheel_filename(package['file'])
 if name != package['name'] or str(version) != package['version'] or not compatible.intersection(str(t) for t in wheel_tags):
  raise RuntimeError('environment_wheel_incompatible')
 with zipfile.ZipFile(wheel) as archive:
  entries += len(archive.infolist())
  if entries > 50000: raise RuntimeError('environment_archive_limit')
  for info in archive.infolist():
   total += info.file_size
   p = pathlib.PurePosixPath(info.filename)
   if total > 536870912 or info.file_size > 67108864 or p.is_absolute() or '..' in p.parts or '\\\\' in info.filename or (info.external_attr >> 16) & 0o170000 == 0o120000:
    raise RuntimeError('environment_archive_unsafe')
destination = SchemeDictionaryDestination({'purelib': '/deps', 'platlib': '/deps', 'scripts': '/deps/bin', 'headers': '/deps/include', 'data': '/deps/data'},
 interpreter='/usr/bin/python3', script_kind='posix', bytecode_optimization_levels=())
for package in expected:
 with WheelFile.open(pathlib.Path('/wheelhouse') / package['file']) as source:
  source.validate_record(validate_contents=True)
  install(source, destination, additional_metadata={'INSTALLER': b'argus-project-environments-v1'})
print('ARGUS_ENVIRONMENT_INSTALLED')
`;
}
export function preflightProbe(profile: EnvironmentProfile): string {
  return `import importlib, importlib.metadata, sys, json, platform
# Query only the newly installed environment; system packages must not mask missing dependencies.
original_path = list(sys.path)
sys.path[:] = [p for p in sys.path if p not in ['/repo', '/repo/src']]
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name
expected = json.loads(${JSON.stringify(JSON.stringify(profile.wheels.map(w => ({ name: w.name, version: w.version }))))})
distributions = list(importlib.metadata.distributions(path=['/deps']))
installed = {canonicalize_name(d.metadata['Name']): d.version for d in distributions}
if len(installed) != len(expected): raise RuntimeError('environment_distribution_mismatch')
for package in expected:
 if installed.get(package['name']) != package['version']: raise RuntimeError('environment_distribution_mismatch')
for dist in distributions:
 if not SpecifierSet(dist.metadata.get('Requires-Python', '')).contains(platform.python_version(), prereleases=True):
  raise RuntimeError('environment_python_version_mismatch')
 for declaration in dist.requires or []:
  required = Requirement(declaration)
  if required.marker and not required.marker.evaluate({'extra': ''}): continue
  present = installed.get(canonicalize_name(required.name))
  if required.url or not present or not required.specifier.contains(present, prereleases=True):
   raise RuntimeError('environment_dependency_closure_incomplete')
sys.path[:] = original_path
for name in ${JSON.stringify(profile.imports)}:
 importlib.import_module(name)
print('ARGUS_ENVIRONMENT_READY')
`;
}
export async function prepareEnvironment(plan: EnvironmentPlan, job: string, signal?: AbortSignal, resolverInput?: ResolverInput): Promise<{ receipt: EnvironmentReceipt; deps: string | null }> {
  const receipt: EnvironmentReceipt = { version: 1, plan, status: 'blocked', reason: null, packages: [],
    installationOutputSha256: null, preflightOutputSha256: null };
  const block = (reason: string) => ({ receipt: { ...receipt, reason }, deps: null });
  if (plan.status !== 'ready') return block(plan.reasons[0] ?? 'environment_profile_required');
  if (signal?.aborted) return block('environment_preparation_canceled');
  await assertEnvironmentTools();
  if (await pythonRuntime() !== plan.runtime) throw new Error('environment_plan_changed');
  const preparation = path.join(job, 'environment-preparation');
  await mkdir(preparation, { mode: 0o700 });
  await mkdir(path.join(preparation, 'snapshot'), { mode: 0o700 }); // never execute/import the repository during installation
  await mkdir(path.join(preparation, 'wheels'), { mode: 0o700 });
  const deps = path.join(preparation, 'deps');
  await mkdir(deps, { mode: 0o700 });
  let profile: EnvironmentProfile;
  if (resolverInput && plan.profileId === 'python-public-wheels-v1') {
    try {
      const resolved = await resolveEnvironment(plan, resolverInput, path.join(preparation, 'wheels'), signal);
      profile = resolved.profile; receipt.resolution = resolved.resolution;
    } catch (error) {
      const reason = (error as Error).message;
      return block(signal?.aborted ? 'environment_preparation_canceled' : /^environment_[a-z_]+$/.test(reason) ? reason : 'environment_resolution_uncertain');
    }
  } else {
    const profiles = await readCatalog();
    const found = profiles.find(p => p.id === plan.profileId);
    if (!found || environmentHash(found) !== plan.profileSha256) throw new Error('environment_plan_changed');
    profile = found;
  }
  let bytes = 0;
  for (const w of resolverInput ? [] : profile.wheels) {
    if (signal?.aborted) return block('environment_preparation_canceled');
    const content = await readOperatorFile(`${ENVIRONMENT_ROOT}/wheels/${w.file}`, 128 * 1024 * 1024);
    bytes += content.length;
    if (bytes > 256 * 1024 * 1024) return block('environment_artifact_limit');
    if (bytesHash(content) !== w.sha256) return block('environment_artifact_hash_mismatch');
    await writeFile(path.join(preparation, 'wheels', w.file), content, { flag: 'wx', mode: 0o400 });
  }
  await writeFile(path.join(preparation, 'probe.py'), installationProbe(profile, await compatibleWheelTags()), { flag: 'wx', mode: 0o400 });
  const installation = await executeSandbox(preparation, deps, signal, true);
  await writeFile(path.join(job, 'environment-installation.json'), JSON.stringify(installation), { flag: 'wx', mode: 0o600 });
  receipt.installationOutputSha256 = environmentHash([installation.stdout, installation.stderr]);
  if (installation.status !== 'completed' || installation.exitCode !== 0) return block(`environment_install_${installation.status}`);
  receipt.packages = profile.wheels.map(({ name, version, sha256 }) => ({ name, version, sha256 }));
  const preflight = path.join(job, 'environment-preflight');
  await mkdir(preflight, { mode: 0o700 });
  await writeFile(path.join(preflight, 'probe.py'), preflightProbe(profile), { flag: 'wx', mode: 0o400 });
  // Keep the source read-only, just as in the subsequent independent tests.
  const result = await executeSandbox(preflight, deps, signal, false, path.join(job, 'snapshot'));
  await writeFile(path.join(job, 'environment-preflight.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  receipt.preflightOutputSha256 = environmentHash([result.stdout, result.stderr]);
  if (result.status !== 'completed' || result.exitCode !== 0 || !result.stdout.split('\n').includes('ARGUS_ENVIRONMENT_READY')) {
    return block(`environment_preflight_${result.status === 'completed' ? 'failed' : result.status}`);
  }
  return { receipt: { ...receipt, status: 'ready' }, deps };
}
