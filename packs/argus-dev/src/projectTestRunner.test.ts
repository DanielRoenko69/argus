import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changedPathsFromGitStatus,
  documentationOnlyChangedPaths,
  discoverProjectProfiles,
  PROJECT_MARKER_DISCOVERY_COMMAND,
  runDetectedProjectTests,
  selectProjectProfilesForChanges,
  type WorkspaceCommandResult,
  type WorkspaceCommandRunner,
} from './projectTestRunner.js';

function result(stdout = '', exitCode = 0, stderr = ''): WorkspaceCommandResult {
  return { stdout, stderr, exit_code: exitCode };
}

test('Python src-layout tests prefer workspace sources for root and nested projects', async () => {
  for (const root of ['', 'backend/']) {
    const commands: Array<{ cwd: string; command: string }> = [];
    const responses = [result(`./${root}pyproject.toml\n./${root}src`), result(), result('1 passed')];
    const outcome = await runDetectedProjectTests('/workspace/SOURCE', async (cwd, command) => {
      commands.push({ cwd, command });
      return responses.shift() ?? result('', 1, 'unexpected command');
    }, { changedPaths: [`${root}src/module.py`, `${root}tests/test_module.py`] });
    assert.equal(outcome?.passed, true);
    assert.deepEqual(commands.at(-1), { cwd: `/workspace/SOURCE${root ? '/backend' : ''}`,
      command: "PYTHONPATH=src python3 -m pytest 'tests/test_module.py'" });
  }
});

test('runs npm tests and build deterministically', async () => {
  const commands: string[] = [];
  const responses = [
    result('./package-lock.json\n./package.json'), result('/usr/bin/npm'), result(),
    result('3 tests passed'), result('build passed'),
  ];
  const run: WorkspaceCommandRunner = async (_cwd, command) => {
    commands.push(command);
    return responses.shift() ?? result('', 1, 'unexpected command');
  };

  const outcome = await runDetectedProjectTests('/workspace/TICKET-1', run);

  assert.equal(outcome?.passed, true);
  assert.equal(outcome?.runner, 'node');
  assert.deepEqual(outcome?.profiles, [{ id: 'node:.', runner: 'node', root: '.', passed: true }]);
  assert.match(outcome?.output ?? '', /3 tests passed/);
  assert.equal(commands[0], PROJECT_MARKER_DISCOVERY_COMMAND);
  assert.deepEqual(commands.slice(1), [
    'command -v npm >/dev/null 2>&1',
    'if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci; fi',
    'npm run test --if-present',
    'npm run build --if-present',
  ]);
});

test('reports setup, test and build progress without changing command execution', async () => {
  const progress: Array<{ phase: string; status: string; label: string; exitCode?: number }> = [];
  const responses = [
    result('./package-lock.json\n./package.json'), result('/usr/bin/npm'), result('deps ready'),
    result('3 tests passed'), result('build passed'),
  ];
  const outcome = await runDetectedProjectTests(
    '/workspace/TICKET-PROGRESS',
    async () => responses.shift() ?? result('', 1, 'unexpected command'),
    {
      onProgress: event => {
        progress.push({
          phase: event.phase,
          status: event.status,
          label: event.label,
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        });
      },
    },
  );

  assert.equal(outcome?.passed, true);
  assert.deepEqual(progress, [
    { phase: 'setup', status: 'started', label: 'npm dependency setup' },
    { phase: 'setup', status: 'completed', label: 'npm dependency setup', exitCode: 0 },
    { phase: 'test', status: 'started', label: 'npm test' },
    { phase: 'test', status: 'completed', label: 'npm test', exitCode: 0 },
    { phase: 'build', status: 'started', label: 'npm build' },
    { phase: 'build', status: 'completed', label: 'npm build', exitCode: 0 },
  ]);
});

test('does not fail a nested npm workspace package that delegates tests to the repository root', async () => {
  const commands: Array<{ cwd: string; command: string }> = [];
  const responses = [
    result('./package-lock.json\n./package.json\n./packages/core/package.json'),
    result('/usr/bin/npm'), result(), result('1779 passing'), result('integration passed'), result('build passed'),
    result('/usr/bin/npm'), result(), result(), result(),
  ];
  const run: WorkspaceCommandRunner = async (cwd, command) => {
    commands.push({ cwd, command });
    return responses.shift() ?? result('', 1, 'unexpected command');
  };

  const outcome = await runDetectedProjectTests('/workspace/NEST', run, {
    changedPaths: ['packages/core/injector/instance-loader.ts', 'integration/injector/e2e/injector.spec.ts'],
  });

  assert.equal(outcome?.passed, true);
  assert.deepEqual(outcome?.profiles, [
    { id: 'node:.', runner: 'node', root: '.', passed: true },
    { id: 'node:packages/core', runner: 'node', root: 'packages/core', passed: true },
  ]);
  assert.deepEqual(commands.filter(item => item.command.includes('test --if-present')), [
    { cwd: '/workspace/NEST/packages/core', command: 'npm run test --if-present' },
  ]);
  assert.deepEqual(commands.filter(item => item.command.startsWith('npm exec --offline')), [{
    cwd: '/workspace/NEST',
    command: "npm exec --offline -- mocha --reporter-option maxDiffSize=0 -- 'integration/injector/e2e/injector.spec.ts'",
  }]);
});

test('does not build a component when its tests fail', async () => {
  const commands: string[] = [];
  const responses = [
    result('./package-lock.json\n./package.json'), result('/usr/bin/npm'), result(), result('', 1, 'test failed'),
  ];
  const run: WorkspaceCommandRunner = async (_cwd, command) => {
    commands.push(command);
    return responses.shift() ?? result('', 1, 'unexpected command');
  };

  const outcome = await runDetectedProjectTests('/workspace/TICKET-2', run);

  assert.equal(outcome?.passed, false);
  assert.match(outcome?.output ?? '', /test failed/);
  assert.equal(commands.includes('npm run build --if-present'), false);
});

test('runs every detected component in a polyglot repository', async () => {
  const commands: Array<{ cwd: string; command: string }> = [];
  const responses = [
    result('./package.json\n./backend/pyproject.toml\n./backend/uv.lock'),
    result('/usr/bin/npm'), result(), result('node passed'), result('node build passed'),
    result('/usr/local/bin/uv'), result('python deps ready'), result('python passed'),
  ];
  const run: WorkspaceCommandRunner = async (cwd, command) => {
    commands.push({ cwd, command });
    return responses.shift() ?? result('', 1, 'unexpected command');
  };

  const outcome = await runDetectedProjectTests('/workspace/POLYGLOT', run);

  assert.equal(outcome?.passed, true);
  assert.equal(outcome?.runner, 'polyglot');
  assert.deepEqual(outcome?.profiles.map(profile => profile.id), ['node:.', 'python:backend']);
  assert.match(outcome?.output ?? '', /node passed/);
  assert.match(outcome?.output ?? '', /python passed/);
  assert.deepEqual(commands.filter(item => item.command.startsWith('command -v')).map(item => item.cwd), [
    '/workspace/POLYGLOT',
    '/workspace/POLYGLOT/backend',
  ]);
});

test('selects pnpm and yarn from lockfiles without using npm', () => {
  const profiles = discoverProjectProfiles([
    './apps/pnpm/package.json',
    './apps/pnpm/pnpm-lock.yaml',
    './apps/yarn/package.json',
    './apps/yarn/yarn.lock',
  ].join('\n'));

  assert.deepEqual(profiles.map(profile => [profile.root, profile.packageManager, profile.tool]), [
    ['apps/pnpm', 'pnpm', 'corepack'],
    ['apps/yarn', 'yarn', 'corepack'],
  ]);
});

test('inherits Bun and uv workspace lockfiles for nested components', () => {
  const profiles = discoverProjectProfiles([
    './bun.lock',
    './package.json',
    './pyproject.toml',
    './uv.lock',
    './backend/pyproject.toml',
    './frontend/package.json',
  ].join('\n'));

  assert.deepEqual(profiles.map(profile => [profile.id, profile.packageManager, profile.tool]), [
    ['node:.', 'bun', 'bun'],
    ['python:.', 'uv', 'uv'],
    ['python:backend', 'uv', 'uv'],
    ['node:frontend', 'bun', 'bun'],
  ]);
  assert.match(profiles.find(profile => profile.id === 'node:frontend')?.markers.join(',') ?? '', /bun\.lock@\./);
  assert.match(profiles.find(profile => profile.id === 'python:backend')?.markers.join(',') ?? '', /uv\.lock@\./);
});

test('runs Alembic migrations before pytest when the project declares them', async () => {
  const commands: string[] = [];
  const responses = [
    result('./pyproject.toml\n./uv.lock\n./alembic.ini'),
    result('/usr/local/bin/uv'), result('synced'), result('migrated'), result('60 passed'),
  ];
  const run: WorkspaceCommandRunner = async (_cwd, command) => {
    commands.push(command);
    return responses.shift() ?? result('', 1, 'unexpected command');
  };

  const outcome = await runDetectedProjectTests('/workspace/PYTHON', run, { changedPaths: ['app/main.py'] });

  assert.equal(outcome?.passed, true);
  assert.deepEqual(commands.slice(1), [
    'command -v uv >/dev/null 2>&1',
    'uv sync --frozen',
    'uv run alembic upgrade head',
    'uv run python -m pytest',
  ]);
});

test('runs changed Python test files before the external CI owns the full suite', async () => {
  const commands: string[] = [];
  const responses = [
    result('./pyproject.toml\n./uv.lock'),
    result('/usr/local/bin/uv'), result('synced'), result('145 passed'),
  ];
  const run: WorkspaceCommandRunner = async (_cwd, command) => {
    commands.push(command);
    return responses.shift() ?? result('', 1, 'unexpected command');
  };

  const outcome = await runDetectedProjectTests('/workspace/CLICK-2971', run, {
    changedPaths: ['src/click/core.py', 'tests/test_options.py'],
  });

  assert.equal(outcome?.passed, true);
  assert.deepEqual(commands.slice(1), [
    'command -v uv >/dev/null 2>&1',
    'uv sync --frozen',
    "uv run python -m pytest 'tests/test_options.py'",
  ]);
  assert.match(outcome?.output ?? '', /ticket-scoped pytest/);
});

test('selects the most specific ecosystem profile for changed files', () => {
  const profiles = discoverProjectProfiles([
    './bun.lock', './package.json', './pyproject.toml', './uv.lock',
    './backend/pyproject.toml', './frontend/package.json',
  ].join('\n'));

  assert.deepEqual(
    selectProjectProfilesForChanges(profiles, ['backend/app/api/routes/health.py']).map(profile => profile.id),
    ['python:backend'],
  );
  assert.deepEqual(
    selectProjectProfilesForChanges(profiles, ['frontend/src/routes/index.tsx']).map(profile => profile.id),
    ['node:frontend'],
  );
  assert.equal(selectProjectProfilesForChanges(profiles, ['compose.yml']).length, profiles.length);
});

test('parses modified, untracked and renamed Git status paths', () => {
  assert.deepEqual(changedPathsFromGitStatus([
    ' M backend/app/main.py',
    '?? backend/tests/test_health.py',
    'R  frontend/old.ts -> frontend/new.ts',
  ].join('\n')), [
    'backend/app/main.py',
    'backend/tests/test_health.py',
    'frontend/new.ts',
  ]);
});

test('classifies only bounded documentation changes without weakening mixed changes', () => {
  assert.deepEqual(documentationOnlyChangedPaths([
    'README.md',
    'docs/hermes-managed-dev-certification.md',
    'docs/notes.txt',
  ]), [
    'README.md',
    'docs/hermes-managed-dev-certification.md',
    'docs/notes.txt',
  ]);
  assert.equal(documentationOnlyChangedPaths(['docs/guide.md', 'src/index.ts']), null);
  assert.equal(documentationOnlyChangedPaths(['compose.yml']), null);
  assert.equal(documentationOnlyChangedPaths([]), null);
});

test('validates documentation-only changes without running repository test profiles', async () => {
  const commands: string[] = [];
  const run: WorkspaceCommandRunner = async (_cwd, command) => {
    commands.push(command);
    return result();
  };

  const outcome = await runDetectedProjectTests('/workspace/DOCS', run, {
    changedPaths: ['docs/hermes-managed-dev-certification.md'],
  });

  assert.equal(outcome?.passed, true);
  assert.equal(outcome?.runner, 'docs');
  assert.deepEqual(outcome?.profiles, [{ id: 'docs:changed-files', runner: 'docs', root: '.', passed: true }]);
  assert.equal(commands.length, 1);
  assert.doesNotMatch(commands[0] ?? '', /find \. -maxdepth|npm test|pytest|playwright/);
  assert.equal(commands[0], "argus-docs-validate 'docs/hermes-managed-dev-certification.md'");
});

test('discovers Go, Rust, Maven, Gradle and .NET profiles', () => {
  const profiles = discoverProjectProfiles([
    './services/go/go.mod',
    './services/rust/Cargo.toml',
    './services/rust/Cargo.lock',
    './services/java/pom.xml',
    './services/gradle/build.gradle.kts',
    './services/gradle/gradlew',
    './services/dotnet/Argus.sln',
  ].join('\n'));

  assert.deepEqual(profiles.map(profile => profile.id), [
    'dotnet:services/dotnet',
    'go:services/go',
    'gradle:services/gradle',
    'maven:services/java',
    'rust:services/rust',
  ]);
  assert.equal(profiles.find(profile => profile.runner === 'rust')?.commands[0]?.command, 'cargo test --locked');
  assert.equal(profiles.find(profile => profile.runner === 'gradle')?.commands[0]?.command, 'sh ./gradlew test --no-daemon');
});

test('fails explicitly when a known project toolchain is unavailable', async () => {
  const commands: string[] = [];
  const run: WorkspaceCommandRunner = async (_cwd, command) => {
    commands.push(command);
    if (commands.length === 1) return result('./go.mod');
    return result('', 127, 'go not found');
  };

  const outcome = await runDetectedProjectTests('/workspace/GO', run);

  assert.equal(outcome?.passed, false);
  assert.match(outcome?.output ?? '', /TOOLCHAIN_UNAVAILABLE: 'go'/);
  assert.deepEqual(commands, [PROJECT_MARKER_DISCOVERY_COMMAND, 'command -v go >/dev/null 2>&1']);
});

test('ignores vendored and fixture projects and bounds discovery', () => {
  const markerOutput = [
    './fixtures/broken/package.json',
    './vendor/example/go.mod',
    './node_modules/pkg/package.json',
    ...Array.from({ length: 12 }, (_, index) => `./service-${index}/go.mod`),
  ].join('\n');

  const profiles = discoverProjectProfiles(markerOutput);

  assert.equal(profiles.length, 8);
  assert.equal(profiles.some(profile => /fixtures|vendor|node_modules/.test(profile.root)), false);
});

test('returns null when no conventional project marker exists', async () => {
  const outcome = await runDetectedProjectTests('/workspace/TICKET-3', async () => result(''));
  assert.equal(outcome, null);
});
