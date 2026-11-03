import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadHermesRunnerdConfig } from './runnerdConfig.js';

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ARGUS_HERMES_RUNNERD_TOKEN: 'runnerd-test-token',
    ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://argus-core:3000',
    ...overrides,
  };
}

test('loads the runnerd service token, pinned Core origin and durable state directory', () => {
  const config = loadHermesRunnerdConfig(environment({
    ARGUS_HERMES_RUNNERD_PORT: '2050',
    ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'https://argus-core.internal:8443/',
    ARGUS_HERMES_RUNNERD_STATE_DIRECTORY: '/state/argus-hermes-runnerd',
  }));
  assert.equal(config.port, 2050);
  assert.equal(config.serviceToken, 'runnerd-test-token');
  assert.equal(config.coreRuntimeMcpOrigin, 'https://argus-core.internal:8443');
  assert.equal(config.stateDirectory, '/state/argus-hermes-runnerd');

  const defaults = loadHermesRunnerdConfig(environment());
  assert.equal(defaults.port, 2042);
  assert.equal(defaults.stateDirectory, '/var/lib/argus-hermes-runnerd');
});

test('rejects malformed service identity, Core origin and state directory without exposing a token', () => {
  const cases: Array<[string, NodeJS.ProcessEnv]> = [
    ['missing service token', { ARGUS_HERMES_RUNNERD_TOKEN: '', ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://argus-core:3000' }],
    ['newline service token', { ARGUS_HERMES_RUNNERD_TOKEN: 'token\nnext', ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://argus-core:3000' }],
    ['credential-bearing Core origin', { ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://user:password@argus-core:3000' }],
    ['Core origin path', { ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://argus-core:3000/mcp' }],
    ['invalid runnerd port', { ARGUS_HERMES_RUNNERD_PORT: '0' }],
    ['blank state directory', { ARGUS_HERMES_RUNNERD_STATE_DIRECTORY: '  ' }],
    ['relative state directory', { ARGUS_HERMES_RUNNERD_STATE_DIRECTORY: 'runnerd-state' }],
    ['newline state directory', { ARGUS_HERMES_RUNNERD_STATE_DIRECTORY: '/state\nother' }],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(
      () => loadHermesRunnerdConfig(environment(overrides)),
      error => error instanceof Error && !error.message.includes('token\nnext') && !error.message.includes('password'),
      label,
    );
  }
});

test('reads a bounded service token from an operator-mounted secret file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'argus-hermes-runnerd-config-'));
  try {
    const filename = join(directory, 'runnerd-token');
    await writeFile(filename, 'runnerd-token-from-file\n', 'utf8');
    const config = loadHermesRunnerdConfig(environment({
      ARGUS_HERMES_RUNNERD_TOKEN: undefined,
      ARGUS_HERMES_RUNNERD_TOKEN_FILE: filename,
    }));
    assert.equal(config.serviceToken, 'runnerd-token-from-file');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
