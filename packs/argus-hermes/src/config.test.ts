import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, requireManagedRuntimeMcpOrigin } from './config.js';

test('normalizes the trusted Core runtime MCP origin and requires it for a future managed runner', () => {
  const config = loadConfig({
    PORT: '2040',
    ARGUS_HERMES_PUBLIC_URL: 'http://localhost:2040',
    ARGUS_PACK_DISCOVERY_TOKEN: 'test-pack-token',
    ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://mcp-server:3000/',
  } as NodeJS.ProcessEnv);

  assert.equal(requireManagedRuntimeMcpOrigin(config), 'http://mcp-server:3000');
  assert.throws(
    () => requireManagedRuntimeMcpOrigin({}),
    /ARGUS_CORE_RUNTIME_MCP_ORIGIN is required/,
  );
  assert.throws(
    () => loadConfig({
      PORT: '2040',
      ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://mcp-server:3000/mcp/runtime',
    } as NodeJS.ProcessEnv),
    /ARGUS_CORE_RUNTIME_MCP_ORIGIN must be an origin/,
  );
});

test('requires an authenticated internal broker paired with a pinned Core origin', () => {
  const config = loadConfig({
    PORT: '2040',
    ARGUS_HERMES_PUBLIC_URL: 'http://localhost:2040',
    ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://mcp-server:3000/',
    ARGUS_HERMES_RUNNERD_URL: 'http://argus-hermes-runnerd:2050/',
    ARGUS_HERMES_RUNNERD_TOKEN: 'local-runnerd-token',
    ARGUS_HERMES_MANAGED_STATE_DIRECTORY: '/state/argus-hermes',
    ARGUS_HERMES_RUNNERD_POLL_MS: '750',
  } as NodeJS.ProcessEnv);

  assert.equal(config.managedRunnerBrokerUrl, 'http://argus-hermes-runnerd:2050');
  assert.equal(config.managedRunnerBrokerToken, 'local-runnerd-token');
  assert.equal(config.managedRunStateDirectory, '/state/argus-hermes');
  assert.equal(config.managedRunnerPollMs, 750);

  assert.throws(
    () => loadConfig({ PORT: '2040', ARGUS_HERMES_RUNNERD_URL: 'http://runnerd:2050' } as NodeJS.ProcessEnv),
    /ARGUS_HERMES_RUNNERD_URL and its token together/,
  );
  assert.throws(
    () => loadConfig({
      PORT: '2040',
      ARGUS_HERMES_RUNNERD_URL: 'http://runnerd:2050',
      ARGUS_HERMES_RUNNERD_TOKEN: 'local-runnerd-token',
    } as NodeJS.ProcessEnv),
    /ARGUS_CORE_RUNTIME_MCP_ORIGIN is required/,
  );
  assert.throws(
    () => loadConfig({
      PORT: '2040',
      ARGUS_CORE_RUNTIME_MCP_ORIGIN: 'http://mcp-server:3000',
      ARGUS_HERMES_RUNNERD_URL: 'http://runnerd:2050/path',
      ARGUS_HERMES_RUNNERD_TOKEN: 'local-runnerd-token',
    } as NodeJS.ProcessEnv),
    /ARGUS_HERMES_RUNNERD_URL must be an origin/,
  );
});
