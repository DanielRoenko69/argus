import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { completeRuntimeResult } from './runtimeResult.js';

describe('complete runtime outcomes', () => {
  it('preserves machine-readable JSON beyond the event preview limit', () => {
    const data = JSON.stringify({ summary: 'x'.repeat(40_000), status: 'ready', blockers: [] });
    assert.equal(JSON.parse(completeRuntimeResult(data)).summary.length, 40_000);
    assert.throws(() => completeRuntimeResult('ü'.repeat(140_000)), /exceeds/);
  });
});
import {
  isDeterministicProjectTestCommand,
  normalizeIsolatedTestCommand,
  redactCommandForAudit,
  terminateProcessTree,
  waitForChildProcess,
} from './exec.js';

describe('isolated project test environment', () => {
  it('accepts commands emitted by the deterministic project runner', () => {
    assert.equal(isDeterministicProjectTestCommand('uv sync --frozen'), true);
    assert.equal(isDeterministicProjectTestCommand('uv run alembic upgrade head'), true);
    assert.equal(isDeterministicProjectTestCommand('uv run python -m pytest'), true);
    assert.equal(isDeterministicProjectTestCommand("uv run python -m pytest 'tests/test_options.py'"), true);
    assert.equal(isDeterministicProjectTestCommand("python3 -m pytest 'tests/test_api.py' 'pkg/widget_test.py'"), true);
    assert.equal(isDeterministicProjectTestCommand('bun run test'), true);
    assert.equal(isDeterministicProjectTestCommand('npm run test --if-present'), true);
    assert.equal(isDeterministicProjectTestCommand(
      "npm exec --offline -- mocha --reporter-option maxDiffSize=0 -- 'integration/injector/e2e/injector.spec.ts'",
    ), true);
    assert.equal(isDeterministicProjectTestCommand('go test ./...'), true);
    assert.equal(isDeterministicProjectTestCommand(
      "argus-docs-validate 'README.md' 'docs/hermes managed.md' 'docs/notes.txt'",
    ), true);
    assert.equal(isDeterministicProjectTestCommand(
      "go test -race ./cmd/bisync -run '^TestBisyncRCConcurrent$' -remote local -count=1",
    ), true);
    assert.equal(isDeterministicProjectTestCommand(
      'if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci --ignore-scripts --no-audit --no-fund; fi',
    ), true);
  });

  it('rejects arbitrary shell and command-chaining attempts', () => {
    assert.equal(isDeterministicProjectTestCommand('env'), false);
    assert.equal(isDeterministicProjectTestCommand('uv run python -m pytest; env'), false);
    assert.equal(isDeterministicProjectTestCommand('uv run sh -c "echo $DATABASE_URL"'), false);
    assert.equal(isDeterministicProjectTestCommand('npm test\nenv'), false);
    assert.equal(isDeterministicProjectTestCommand('npm run test --if-present; env'), false);
    assert.equal(isDeterministicProjectTestCommand(
      "npm exec --offline -- mocha --reporter-option maxDiffSize=0 -- '../integration/injector.spec.ts'",
    ), false);
    assert.equal(isDeterministicProjectTestCommand(
      "npm exec --offline -- mocha --reporter-option maxDiffSize=0 -- 'packages/core/injector.spec.ts'",
    ), false);
    assert.equal(isDeterministicProjectTestCommand("uv run python -m pytest '../tests/test_escape.py'"), false);
    assert.equal(isDeterministicProjectTestCommand("uv run python -m pytest 'src/click/core.py'"), false);
    assert.equal(isDeterministicProjectTestCommand("uv run python -m pytest 'tests/test_ok.py'; env"), false);
    assert.equal(isDeterministicProjectTestCommand('go test ./cmd/bisync -exec sh'), false);
    assert.equal(isDeterministicProjectTestCommand('go test ./cmd/bisync; env'), false);
    assert.equal(isDeterministicProjectTestCommand('go test ../private'), false);
    assert.equal(isDeterministicProjectTestCommand('go test ./cmd/bisync -remote production'), false);
    assert.equal(isDeterministicProjectTestCommand("argus-docs-validate '../README.md'"), false);
    assert.equal(isDeterministicProjectTestCommand("argus-docs-validate 'docs/guide.md' 'src/index.ts'"), false);
    assert.equal(isDeterministicProjectTestCommand("argus-docs-validate 'docs/guide.md'; env"), false);
  });
  it('permits only the fixed local src import path for Python tests', () => {
    assert.equal(isDeterministicProjectTestCommand('PYTHONPATH=src python3 -m pytest'), true);
    assert.equal(isDeterministicProjectTestCommand("PYTHONPATH=src python3 -m pytest 'tests/test_batch.py'"), true);
    for (const command of ["PYTHONPATH=/tmp python3 -m pytest", "PYTHONPATH=src python3 -m pytest; env",
      "PYTHONPATH=src python3 -m pytest '../tests/test_escape.py'", 'PYTHONPATH=src python3 -m pytest --override-ini=x']) {
      assert.equal(isDeterministicProjectTestCommand(command), false);
    }
  });
});

describe('isolated dependency setup compatibility', () => {
  it('keeps npm ci as the preferred path and adds a bounded historical fallback', () => {
    const normalized = normalizeIsolatedTestCommand(
      'if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci; fi',
    );

    assert.match(normalized, /npm ci --ignore-scripts --no-audit --no-fund \|\| npm install/u);
    assert.match(normalized, /--package-lock=false --legacy-peer-deps/u);
  });

  it('does not rewrite ordinary deterministic test commands', () => {
    assert.equal(normalizeIsolatedTestCommand('npm test'), 'npm test');
  });

  it('does not rewrite a caller-supplied npm install variant', () => {
    const command = 'npm install --package-lock=false';
    assert.equal(normalizeIsolatedTestCommand(command), command);
  });

  it('rewrites the bounded docs validator to an internally owned safe shell check', () => {
    const normalized = normalizeIsolatedTestCommand(
      "argus-docs-validate 'README.md' 'docs/hermes-managed.md'",
    );

    assert.match(normalized, /^set -eu$/mu);
    assert.match(normalized, /test -s "\$path"/u);
    assert.match(normalized, /git diff --check HEAD -- 'README\.md' 'docs\/hermes-managed\.md'/u);
    assert.equal(normalized.includes('argus-docs-validate'), false);
  });
});

describe('execution audit redaction', () => {
  it('redacts Git and HTTP authorization headers while retaining useful command context', () => {
    const command = 'git -c http.extraheader="Authorization: Basic dXNlcjp0b2tlbg==" clone https://gitea/repo.git';
    const audit = redactCommandForAudit(command);
    assert.equal(audit.includes('dXNlcjp0b2tlbg=='), false);
    assert.match(audit, /Authorization: Basic \[REDACTED\]/u);
    assert.match(audit, /clone https:\/\/gitea\/repo\.git/u);
  });

  it('redacts bearer credentials and authenticated repository URLs', () => {
    const audit = redactCommandForAudit(
      "curl -H 'Authorization: Bearer local-test-token' https://user:repo-secret@example.test/path",
    );
    assert.equal(audit.includes('local-test-token'), false);
    assert.equal(audit.includes('repo-secret'), false);
    assert.match(audit, /Authorization: Bearer \[REDACTED\]/u);
    assert.match(audit, /https:\/\/user:\[REDACTED\]@example\.test\/path/u);
  });
});

describe('workspace process lifecycle', () => {
  it('kills the complete POSIX process group', () => {
    let directKillCalls = 0;
    const child = {
      pid: 73,
      kill: () => {
        directKillCalls += 1;
        return true;
      },
    } as unknown as ChildProcess;
    const signals: Array<[number, NodeJS.Signals]> = [];

    terminateProcessTree(child, 'linux', (pid, signal) => {
      signals.push([pid, signal]);
      return true;
    });

    assert.deepEqual(signals, [[-73, 'SIGKILL']]);
    assert.equal(directKillCalls, 0);
  });

  it('falls back to the direct child when group termination is unavailable', () => {
    let directSignal: NodeJS.Signals | number | undefined;
    const child = {
      pid: 91,
      kill: (signal?: NodeJS.Signals | number) => {
        directSignal = signal;
        return true;
      },
    } as unknown as ChildProcess;

    terminateProcessTree(child, 'linux', () => {
      throw new Error('process group already exited');
    });

    assert.equal(directSignal, 'SIGKILL');
  });

  it('returns after a bounded grace period when inherited pipes never close', async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    Object.defineProperty(child, 'pid', { value: 117 });
    let terminateCalls = 0;

    const result = await waitForChildProcess(child, 5, 5, () => {
      terminateCalls += 1;
    });

    assert.deepEqual(result, { exitCode: -1, timedOut: true });
    assert.equal(terminateCalls, 1);
  });
});
