export interface WorkspaceCommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export type WorkspaceCommandRunner = (
  cwd: string,
  command: string,
  timeoutSec?: number,
) => Promise<WorkspaceCommandResult>;

export type ProjectRunner = 'node' | 'python' | 'go' | 'rust' | 'maven' | 'gradle' | 'dotnet' | 'docs';
export type ProjectRunKind = ProjectRunner | 'polyglot';
export type ProjectPhase = 'setup' | 'test' | 'build';

export interface ProjectCommand {
  phase: ProjectPhase;
  label: string;
  command: string;
  timeoutSec?: number;
}

export interface ProjectProfile {
  id: string;
  runner: ProjectRunner;
  root: string;
  tool: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'uv';
  markers: string[];
  commands: ProjectCommand[];
}

export interface ProjectProfileResult {
  id: string;
  runner: ProjectRunner;
  root: string;
  passed: boolean;
}

export interface ProjectTestResult {
  passed: boolean;
  output: string;
  runner: ProjectRunKind;
  profiles: ProjectProfileResult[];
}

export interface ProjectProgressEvent {
  profileId: string;
  runner: ProjectRunner;
  root: string;
  phase: ProjectPhase;
  label: string;
  status: 'started' | 'completed' | 'failed';
  command: string;
  exitCode?: number;
  output?: string;
}

export interface ProjectTestOptions {
  changedPaths?: string[];
  /** Best-effort lifecycle callback used to expose long setup/test/build phases. */
  onProgress?: (event: ProjectProgressEvent) => void | Promise<void>;
}

const MAX_PROJECT_PROFILES = 8;
const COMMAND_TIMEOUT_SEC = 300;
const EXCLUDED_PATH_SEGMENTS = new Set([
  '.git', '.venv', 'bin', 'dist', 'example', 'examples', 'fixtures', 'node_modules',
  'obj', 'target', 'testdata', 'vendor',
]);

export const PROJECT_MARKER_DISCOVERY_COMMAND = [
  "find . -maxdepth 4 -type f \\",
  "  \\( -name package.json -o -name package-lock.json -o -name pnpm-lock.yaml -o -name yarn.lock \\",
  "  -o -name bun.lock -o -name bun.lockb \\",
  "  -o -name pyproject.toml -o -name requirements.txt -o -name uv.lock \\",
  "  -o -name alembic.ini \\",
  "  -o -name go.mod -o -name Cargo.toml -o -name Cargo.lock \\",
  "  -o -name pom.xml -o -name mvnw -o -name build.gradle -o -name build.gradle.kts -o -name gradlew \\",
  "  -o -name '*.sln' -o -name '*.csproj' \\) -print -o -type d -name src -print | sort",
].join('\n');

function normalizeMarkerPath(value: string): string | null {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '..' || EXCLUDED_PATH_SEGMENTS.has(segment.toLowerCase()))) {
    return null;
  }
  return normalized;
}

export function changedPathsFromGitStatus(statusOutput: string): string[] {
  const paths: string[] = [];
  for (const line of statusOutput.split(/\r?\n/)) {
    if (line.length < 4) continue;
    let path = line.slice(3).trim();
    if (path.includes(' -> ')) path = path.slice(path.lastIndexOf(' -> ') + 4);
    if (path.startsWith('"') && path.endsWith('"')) {
      try { path = JSON.parse(path) as string; } catch { /* keep Git's quoted representation */ }
    }
    const normalized = normalizeMarkerPath(path);
    if (normalized) paths.push(normalized);
  }
  return [...new Set(paths)];
}

const DOCUMENTATION_EXTENSIONS = new Set(['.adoc', '.md', '.mdx', '.rst']);

function isDocumentationPath(path: string): boolean {
  const file = markerName(path).toLowerCase();
  const extension = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '';
  return DOCUMENTATION_EXTENSIONS.has(extension)
    || (path.toLowerCase().startsWith('docs/') && extension === '.txt');
}

/**
 * Return a normalized, bounded documentation-only change set. Unknown files
 * deliberately return null so callers retain the conservative full-suite
 * behaviour for source, configuration, CI, container and mixed changes.
 */
export function documentationOnlyChangedPaths(changedPaths: string[] = []): string[] | null {
  const normalized = [...new Set(changedPaths
    .map(normalizeMarkerPath)
    .filter((path): path is string => Boolean(path)))];
  if (normalized.length === 0 || !normalized.every(isDocumentationPath)) return null;
  return normalized;
}

function markerRoot(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash < 0 ? '.' : path.slice(0, lastSlash);
}

function markerName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function profileId(runner: ProjectRunner, root: string): string {
  return `${runner}:${root}`;
}

function command(phase: ProjectPhase, label: string, value: string, timeoutSec = COMMAND_TIMEOUT_SEC): ProjectCommand {
  return { phase, label, command: value, timeoutSec };
}

type NodePackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface InheritedPackageManager<TManager extends string> {
  manager: TManager;
  lockRoot: string;
}

function ancestorRoots(root: string): string[] {
  if (root === '.') return ['.'];
  const segments = root.split('/');
  const ancestors = [root];
  while (segments.length > 1) {
    segments.pop();
    ancestors.push(segments.join('/'));
  }
  ancestors.push('.');
  return ancestors;
}

function inheritedNodePackageManager(
  root: string,
  roots: Map<string, Set<string>>,
): InheritedPackageManager<NodePackageManager> {
  for (const candidate of ancestorRoots(root)) {
    const markers = roots.get(candidate);
    if (markers?.has('pnpm-lock.yaml')) return { manager: 'pnpm', lockRoot: candidate };
    if (markers?.has('yarn.lock')) return { manager: 'yarn', lockRoot: candidate };
    if (markers?.has('bun.lock') || markers?.has('bun.lockb')) return { manager: 'bun', lockRoot: candidate };
    if (markers?.has('package-lock.json')) return { manager: 'npm', lockRoot: candidate };
  }
  return { manager: 'npm', lockRoot: root };
}

function inheritedUvLock(root: string, roots: Map<string, Set<string>>): string | null {
  return ancestorRoots(root).find(candidate => roots.get(candidate)?.has('uv.lock')) ?? null;
}

function evidenceMarkers(markers: Set<string>, lockRoot: string, root: string, lockName: string): string[] {
  return [...markers, ...(lockRoot !== root ? [`${lockName}@${lockRoot}`] : [])].sort();
}

function nodeProfile(
  root: string,
  markers: Set<string>,
  packageManager: InheritedPackageManager<NodePackageManager>,
): ProjectProfile {
  if (packageManager.manager === 'pnpm') {
    return {
      id: profileId('node', root), runner: 'node', root, tool: 'corepack', packageManager: 'pnpm',
      markers: evidenceMarkers(markers, packageManager.lockRoot, root, 'pnpm-lock.yaml'),
      commands: [
        command('setup', 'pnpm dependency setup', 'if [ ! -d node_modules ]; then corepack pnpm install --frozen-lockfile; fi'),
        command('test', 'pnpm test', 'corepack pnpm test'),
        command('build', 'pnpm build', 'corepack pnpm run --if-present build'),
      ],
    };
  }
  if (packageManager.manager === 'yarn') {
    return {
      id: profileId('node', root), runner: 'node', root, tool: 'corepack', packageManager: 'yarn',
      markers: evidenceMarkers(markers, packageManager.lockRoot, root, 'yarn.lock'),
      commands: [
        command('setup', 'yarn dependency setup', 'if [ ! -d node_modules ]; then corepack yarn install --immutable; fi'),
        command('test', 'yarn test', 'corepack yarn test'),
        command(
          'build',
          'yarn build',
          `if node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; then corepack yarn build; fi`,
        ),
      ],
    };
  }
  if (packageManager.manager === 'bun') {
    return {
      id: profileId('node', root), runner: 'node', root, tool: 'bun', packageManager: 'bun',
      markers: evidenceMarkers(markers, packageManager.lockRoot, root, 'bun.lock'),
      commands: [
        command('setup', 'Bun dependency setup', 'if [ ! -d node_modules ]; then bun install --frozen-lockfile; fi'),
        command('test', 'Bun test', 'bun run test'),
        command(
          'build',
          'Bun build',
          `if node -e "process.exit(require('./package.json').scripts?.build ? 0 : 1)"; then bun run build; fi`,
        ),
      ],
    };
  }
  return {
    id: profileId('node', root), runner: 'node', root, tool: 'npm', packageManager: 'npm',
    markers: evidenceMarkers(markers, packageManager.lockRoot, root, 'package-lock.json'),
    commands: [
      command('setup', 'npm dependency setup', 'if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci; fi'),
      // Workspace package manifests commonly omit their own test script while
      // the repository root owns the complete suite. Treat that as an absent
      // component phase, not a deterministic test failure.
      command('test', 'npm test', 'npm run test --if-present'),
      command('build', 'npm build', 'npm run build --if-present'),
    ],
  };
}

function pythonProfile(root: string, markers: Set<string>, uvLockRoot: string | null): ProjectProfile {
  const usesUv = uvLockRoot !== null;
  return {
    id: profileId('python', root), runner: 'python', root, tool: usesUv ? 'uv' : 'python3',
    ...(usesUv ? { packageManager: 'uv' as const } : {}),
    markers: usesUv ? evidenceMarkers(markers, uvLockRoot, root, 'uv.lock') : [...markers].sort(),
    commands: usesUv
      ? [
          command('setup', 'uv dependency setup', 'uv sync --frozen'),
          ...(markers.has('alembic.ini')
            ? [command('setup', 'Alembic migration', 'uv run alembic upgrade head')]
            : []),
          command('test', 'pytest', 'uv run python -m pytest'),
        ]
      : [command('test', 'pytest', `${markers.has('src') ? 'PYTHONPATH=src ' : ''}python3 -m pytest`)],
  };
}

function goProfile(root: string, markers: Set<string>): ProjectProfile {
  return {
    id: profileId('go', root), runner: 'go', root, tool: 'go', markers: [...markers].sort(),
    commands: [
      command('test', 'go test', 'go test ./...'),
      command('build', 'go vet', 'go vet ./...'),
    ],
  };
}

function rustProfile(root: string, markers: Set<string>): ProjectProfile {
  const locked = markers.has('Cargo.lock') ? ' --locked' : '';
  return {
    id: profileId('rust', root), runner: 'rust', root, tool: 'cargo', markers: [...markers].sort(),
    commands: [
      command('test', 'cargo test', `cargo test${locked}`),
      command('build', 'cargo check', `cargo check${locked}`),
    ],
  };
}

function mavenProfile(root: string, markers: Set<string>): ProjectProfile {
  const wrapper = markers.has('mvnw');
  return {
    id: profileId('maven', root), runner: 'maven', root, tool: wrapper ? 'sh' : 'mvn', markers: [...markers].sort(),
    commands: [command('test', 'Maven test', wrapper ? 'sh ./mvnw -B test' : 'mvn -B test')],
  };
}

function gradleProfile(root: string, markers: Set<string>): ProjectProfile {
  const wrapper = markers.has('gradlew');
  return {
    id: profileId('gradle', root), runner: 'gradle', root, tool: wrapper ? 'sh' : 'gradle', markers: [...markers].sort(),
    commands: [command('test', 'Gradle test', wrapper ? 'sh ./gradlew test --no-daemon' : 'gradle test --no-daemon')],
  };
}

function dotnetProfile(root: string, markers: Set<string>): ProjectProfile {
  return {
    id: profileId('dotnet', root), runner: 'dotnet', root, tool: 'dotnet', markers: [...markers].sort(),
    commands: [command('test', '.NET test', 'dotnet test --nologo')],
  };
}

/** Convert a bounded marker listing into deterministic project execution profiles. */
export function discoverProjectProfiles(markerOutput: string): ProjectProfile[] {
  const roots = new Map<string, Set<string>>();
  for (const rawPath of markerOutput.split(/\r?\n/)) {
    const path = normalizeMarkerPath(rawPath);
    if (!path) continue;
    const root = markerRoot(path);
    const markers = roots.get(root) ?? new Set<string>();
    markers.add(markerName(path));
    roots.set(root, markers);
  }

  const profiles: ProjectProfile[] = [];
  const orderedRoots = [...roots.entries()].sort(([left], [right]) => {
    if (left === '.') return -1;
    if (right === '.') return 1;
    return left.localeCompare(right);
  });
  for (const [root, markers] of orderedRoots) {
    if (markers.has('package.json')) profiles.push(nodeProfile(root, markers, inheritedNodePackageManager(root, roots)));
    if (markers.has('pyproject.toml') || markers.has('requirements.txt')) {
      profiles.push(pythonProfile(root, markers, inheritedUvLock(root, roots)));
    }
    if (markers.has('go.mod')) profiles.push(goProfile(root, markers));
    if (markers.has('Cargo.toml')) profiles.push(rustProfile(root, markers));
    if (markers.has('pom.xml')) profiles.push(mavenProfile(root, markers));
    else if (markers.has('build.gradle') || markers.has('build.gradle.kts')) profiles.push(gradleProfile(root, markers));
    if ([...markers].some(marker => marker.endsWith('.sln') || marker.endsWith('.csproj'))) {
      profiles.push(dotnetProfile(root, markers));
    }
    if (profiles.length >= MAX_PROJECT_PROFILES) break;
  }
  return profiles.slice(0, MAX_PROJECT_PROFILES);
}

function pathWithinRoot(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`);
}

function pathMatchesRunner(path: string, runner: ProjectRunner): boolean {
  const file = markerName(path).toLowerCase();
  const extension = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '';
  switch (runner) {
    case 'node':
      return ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'].includes(extension)
        || ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].includes(file);
    case 'python':
      return extension === '.py' || ['pyproject.toml', 'requirements.txt', 'uv.lock', 'alembic.ini'].includes(file);
    case 'go': return extension === '.go' || file === 'go.mod' || file === 'go.sum';
    case 'rust': return extension === '.rs' || file === 'cargo.toml' || file === 'cargo.lock';
    case 'maven': return ['.java', '.kt', '.kts'].includes(extension) || file === 'pom.xml';
    case 'gradle': return ['.java', '.kt', '.kts', '.gradle'].includes(extension) || file === 'gradlew';
    case 'dotnet': return ['.cs', '.fs', '.vb', '.sln', '.csproj', '.fsproj', '.vbproj'].includes(extension);
    case 'docs': return isDocumentationPath(path);
  }
}

function rootDepth(root: string): number {
  return root === '.' ? 0 : root.split('/').length;
}

/**
 * Prefer the most specific affected component per ecosystem. Files that do
 * not map to an ecosystem (for example Docker or CI configuration) keep the
 * conservative all-profile behaviour.
 */
export function selectProjectProfilesForChanges(
  profiles: ProjectProfile[],
  changedPaths: string[] = [],
): ProjectProfile[] {
  const normalizedPaths = [...new Set(changedPaths.map(normalizeMarkerPath).filter((path): path is string => Boolean(path)))];
  if (normalizedPaths.length === 0) return profiles;
  const ecosystemPaths = normalizedPaths.filter(path => profiles.some(profile => pathMatchesRunner(path, profile.runner)));
  if (ecosystemPaths.length !== normalizedPaths.length || ecosystemPaths.length === 0) return profiles;

  const affected = profiles.filter(profile => ecosystemPaths.some(path =>
    pathWithinRoot(path, profile.root) && pathMatchesRunner(path, profile.runner)));
  return affected.filter(profile => {
    const relevantPaths = ecosystemPaths.filter(path =>
      pathWithinRoot(path, profile.root) && pathMatchesRunner(path, profile.runner));
    return relevantPaths.some(path => !affected.some(candidate =>
      candidate !== profile
      && candidate.runner === profile.runner
      && rootDepth(candidate.root) > rootDepth(profile.root)
      && pathWithinRoot(path, candidate.root)));
  });
}

function formatStep(profile: ProjectProfile, step: ProjectCommand, result: WorkspaceCommandResult): string {
  return [
    `## ${profile.id} · ${step.label} (exit ${result.exit_code})`,
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter(Boolean).join('\n');
}

function profileWorkingDirectory(workspaceDir: string, root: string): string {
  return root === '.' ? workspaceDir : `${workspaceDir}/${root}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function pathRelativeToProfile(path: string, root: string): string {
  return root === '.' ? path : path.slice(root.length + 1);
}

function isPythonTestPath(path: string): boolean {
  const file = markerName(path).toLowerCase();
  return file.endsWith('.py') && (file.startsWith('test_') || file.endsWith('_test.py'));
}

function isNodeIntegrationTestPath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const file = markerName(lowerPath);
  return lowerPath.startsWith('integration/')
    && /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(file);
}

/**
 * Keep the governed pre-push test stage ticket-scoped when the Coder changed
 * explicit Python test files. The external CI provider still owns the full
 * repository suite after the approved branch push.
 */
function scopeProfileTests(profile: ProjectProfile, changedPaths: string[]): ProjectProfile {
  if (profile.runner === 'node' && profile.packageManager === 'npm') {
    const integrationTests = [...new Set(changedPaths
      .map(normalizeMarkerPath)
      .filter((path): path is string => Boolean(path))
      .filter(path => pathWithinRoot(path, profile.root) && isNodeIntegrationTestPath(path))
      .map(path => pathRelativeToProfile(path, profile.root)))]
      .sort();
    if (integrationTests.length > 0) {
      const files = integrationTests.map(shellQuote).join(' ');
      const integrationCommand = command(
        'test',
        'ticket-scoped Node integration tests',
        `npm exec --offline -- mocha --reporter-option maxDiffSize=0 -- ${files}`,
      );
      return {
        ...profile,
        // A changed integration test is the governed, ticket-scoped test for
        // this profile. Running the repository-wide npm script first defeats
        // the scope boundary and can exhaust a small local Docker runtime.
        commands: profile.commands.map(step => step.phase === 'test'
          ? integrationCommand
          : step),
      };
    }
  }
  if (profile.runner !== 'python') return profile;
  const testFiles = [...new Set(changedPaths
    .map(normalizeMarkerPath)
    .filter((path): path is string => Boolean(path))
    .filter(path => pathWithinRoot(path, profile.root) && isPythonTestPath(path))
    .map(path => pathRelativeToProfile(path, profile.root)))]
    .sort();
  if (testFiles.length === 0) return profile;

  const files = testFiles.map(shellQuote).join(' ');
  const testCommand = profile.packageManager === 'uv'
    ? `uv run python -m pytest ${files}`
    : `${profile.markers.includes('src') ? 'PYTHONPATH=src ' : ''}python3 -m pytest ${files}`;
  return {
    ...profile,
    commands: profile.commands.map(step => step.phase === 'test'
      ? { ...step, label: 'ticket-scoped pytest', command: testCommand }
      : step),
  };
}

async function runProjectProfile(
  workspaceDir: string,
  profile: ProjectProfile,
  run: WorkspaceCommandRunner,
  onProgress?: ProjectTestOptions['onProgress'],
): Promise<{ passed: boolean; output: string }> {
  const cwd = profileWorkingDirectory(workspaceDir, profile.root);
  const header = [
    `# Project profile: ${profile.runner}`,
    `root: ${profile.root}`,
    `tool: ${profile.tool}`,
    ...(profile.packageManager ? [`package-manager: ${profile.packageManager}`] : []),
    `markers: ${profile.markers.join(', ')}`,
  ].join('\n');
  const available = await run(cwd, `command -v ${profile.tool} >/dev/null 2>&1`);
  if (available.exit_code !== 0) {
    return {
      passed: false,
      output: `${header}\n\nTOOLCHAIN_UNAVAILABLE: '${profile.tool}' is required for ${profile.id}.`,
    };
  }

  const outputs = [header];
  for (const step of profile.commands) {
    const progress = (status: ProjectProgressEvent['status'], result?: WorkspaceCommandResult): ProjectProgressEvent => ({
      profileId: profile.id,
      runner: profile.runner,
      root: profile.root,
      phase: step.phase,
      label: step.label,
      status,
      command: step.command,
      ...(result ? {
        exitCode: result.exit_code,
        output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4_000),
      } : {}),
    });
    try {
      await onProgress?.(progress('started'));
    } catch { /* progress reporting must never break deterministic checks */ }
    let result: WorkspaceCommandResult;
    try {
      result = await run(cwd, step.command, step.timeoutSec);
    } catch (error) {
      try {
        await onProgress?.({
          ...progress('failed'),
          output: error instanceof Error ? error.message : String(error),
        });
      } catch { /* best effort */ }
      throw error;
    }
    try {
      await onProgress?.(progress(result.exit_code === 0 ? 'completed' : 'failed', result));
    } catch { /* best effort */ }
    outputs.push(formatStep(profile, step, result));
    if (result.exit_code !== 0) return { passed: false, output: outputs.join('\n\n') };
  }
  return { passed: true, output: outputs.join('\n\n') };
}

/**
 * Discover and run all conventional project components without asking an LLM
 * to invent shell commands. A known project with a missing toolchain fails
 * explicitly; null is reserved for repositories without a known marker.
 */
export async function runDetectedProjectTests(
  workspaceDir: string,
  run: WorkspaceCommandRunner,
  options: ProjectTestOptions = {},
): Promise<ProjectTestResult | null> {
  const documentationPaths = documentationOnlyChangedPaths(options.changedPaths);
  if (documentationPaths) {
    const quotedPaths = documentationPaths.map(shellQuote).join(' ');
    const validation = await run(workspaceDir, `argus-docs-validate ${quotedPaths}`);
    const passed = validation.exit_code === 0;
    return {
      passed,
      output: [
        `# Documentation-only validation (${documentationPaths.length} changed file${documentationPaths.length === 1 ? '' : 's'})`,
        passed
          ? 'Changed documentation files are non-empty, regular files without conflict markers or Git whitespace errors.'
          : 'DOCUMENTATION_VALIDATION_FAILED',
        validation.stdout.trim(),
        validation.stderr.trim(),
      ].filter(Boolean).join('\n\n'),
      runner: 'docs',
      profiles: [{ id: 'docs:changed-files', runner: 'docs', root: '.', passed }],
    };
  }

  const detected = await run(workspaceDir, PROJECT_MARKER_DISCOVERY_COMMAND);
  if (detected.exit_code !== 0) {
    throw new Error(`project profile discovery failed: ${detected.stderr || detected.stdout || `exit ${detected.exit_code}`}`);
  }
  const discoveredProfiles = discoverProjectProfiles(detected.stdout);
  const profiles = selectProjectProfilesForChanges(discoveredProfiles, options.changedPaths)
    .map(profile => scopeProfileTests(profile, options.changedPaths ?? []));
  if (profiles.length === 0) return null;

  const outputs: string[] = [];
  const profileResults: ProjectProfileResult[] = [];
  for (const profile of profiles) {
    const result = await runProjectProfile(workspaceDir, profile, run, options.onProgress);
    outputs.push(result.output);
    profileResults.push({ id: profile.id, runner: profile.runner, root: profile.root, passed: result.passed });
  }
  return {
    passed: profileResults.every(profile => profile.passed),
    output: outputs.join('\n\n---\n\n'),
    runner: profiles.length === 1 ? profiles[0]!.runner : 'polyglot',
    profiles: profileResults,
  };
}
