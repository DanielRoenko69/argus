import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import {
  ARGUS_HERMES_DOCKER_RUNNER_POLICY,
  ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT,
  DockerRunnerdPolicyError,
  resolveDockerHermesRunnerdPolicy,
} from './dockerRunnerdPolicy.js';
import {
  DockerCliManagedRunnerProvisioner,
  splitManagedHermesLogs,
  type DockerCommandResult,
  type DockerCommandRunner,
} from './dockerCliManagedRunner.js';

const RUN_ID = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const GRANT = 'eg_v1.opaque-payload.opaque-signature';

function request(): ManagedHermesRunStartRequest {
  return {
    apiVersion: 'argus-runtime-v1alpha1',
    requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd',
    mode: 'managed',
    run: {
      id: RUN_ID,
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
      messageId: 'message-42',
      sessionId: `managed:${RUN_ID}`,
      coreAgent: { id: 42, name: 'coder' },
      input: { text: 'private managed prompt' },
      instructions: 'private managed instructions',
    },
    runtimeMcpLease: {
      kind: 'argus.runtime-mcp-lease/v1alpha1',
      leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      endpoint: 'http://argus-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      executionGrant: GRANT,
      expiresAt: '2026-08-31T22:15:00.000Z',
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
      bundleIds: [3],
      serverName: 'argus_core',
    },
    limits: { deadlineAt: '2026-08-31T22:15:00.000Z', maxToolCalls: 20, maxOutputBytes: 65_536 },
  };
}

function resolution() {
  return resolveDockerHermesRunnerdPolicy({
    apiVersion: ARGUS_HERMES_DOCKER_RUNNER_POLICY,
    platform: 'linux/amd64',
    toolsets: ['mcp'],
    privateNetwork: 'argus-managed-hermes-runs',
    coreEgressNetwork: 'argus-core-egress-hermes',
    providerEgressNetwork: 'argus-provider-egress-hermes',
    hermesAuthVolume: 'argus-hermes-managed-auth',
    provider: 'openai-codex',
    model: 'gpt-5.6-terra',
    resources: {
      hermes: { cpuMillicores: 1_000, memoryMiB: 2_048, pids: 512 },
      mcpProxy: { cpuMillicores: 100, memoryMiB: 128, pids: 64 },
    },
  }, {
    hermes: {
      platform: 'linux/amd64',
      hermesImage: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`,
      allowedToolsets: ['mcp'],
    },
    mcpProxy: {
      platform: 'linux/amd64',
      mcpProxyImage: `registry.argus.internal/argus/mcp-proxy@sha256:${'b'.repeat(64)}`,
      mcpAuthProxyContract: ARGUS_MCP_AUTH_PROXY_IMAGE_CONTRACT,
      mcpAuthProxyContractDigest: `sha256:${'c'.repeat(64)}`,
    },
  });
}

class FakeDocker implements DockerCommandRunner {
  readonly calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  inspectState = { Status: 'running', ExitCode: 0 };
  activeAuthProfile = false;
  deadline = Date.now() + 60_000;

  async run(args: readonly string[], options: { stdin?: string } = {}): Promise<DockerCommandResult> {
    this.calls.push({ args: [...args], ...(options.stdin === undefined ? {} : { stdin: options.stdin }) });
    if (args[0] === 'ps') return { stdout: this.activeAuthProfile ? 'existing-container' : '' };
    if (args[0] === 'inspect' && args.join(' ').includes('argus.hermes.deadline')) {
      return { stdout: String(this.deadline) };
    }
    if (args[0] === 'inspect') return { stdout: JSON.stringify(this.inspectState) };
    if (args[0] === 'exec' && args.join(' ').includes('mcp_calls')) {
      return { stdout: '{"mcp_call_attempts":2,"mcp_calls":2,"mcp_call_failures":0,"mcp_tools_advertised":2}' };
    }
    if (args[0] === 'logs') {
      const usage = Buffer.from(JSON.stringify({
        inputTokens: 120, outputTokens: 30, totalTokens: 150,
        cacheReadInputTokens: 40, reasoningTokens: 12, apiCalls: 3, estimatedCostUsd: 0.0042,
      })).toString('base64');
      return { stdout: `__ARGUS_HERMES_USAGE_V1__${usage}\n- src/parser.ts` };
    }
    return { stdout: '' };
  }
}

class BlockingDocker extends FakeDocker {
  private releaseNetwork!: () => void;
  private markNetworkStarted!: () => void;
  readonly networkCreateStarted = new Promise<void>(resolve => { this.markNetworkStarted = resolve; });
  private readonly networkRelease = new Promise<void>(resolve => { this.releaseNetwork = resolve; });

  override async run(args: readonly string[], options: { stdin?: string } = {}): Promise<DockerCommandResult> {
    if (args[0] === 'network' && args[1] === 'create') {
      this.markNetworkStarted();
      await this.networkRelease;
    }
    return super.run(args, options);
  }

  continueLaunch(): void {
    this.releaseNetwork();
  }
}

test('launches a fixed two-container topology without putting the grant or prompt in Docker metadata', async () => {
  const policy = resolution();
  assert.equal(policy.state, 'eligible');
  const docker = new FakeDocker();
  const provisioner = new DockerCliManagedRunnerProvisioner(policy, {
    coreRuntimeMcpOrigin: 'http://argus-core:3000',
    docker,
  });

  const launched = await provisioner.launch(request(), policy.policy);
  assert.equal(launched.state, 'running');
  assert.equal(launched.nativeRunId, 'docker-950610b997b441cb908f46cc80bd22a2');

  const serializedArgs = JSON.stringify(docker.calls.map(call => call.args));
  assert.doesNotMatch(serializedArgs, /opaque-payload|private managed prompt|private managed instructions/);
  assert.doesNotMatch(serializedArgs, /docker\.sock|--publish|-p\b|host-path/i);
  assert.match(serializedArgs, /--read-only/);
  assert.match(serializedArgs, /no-new-privileges/);
  assert.match(serializedArgs, /argus-core-egress-hermes/);
  assert.match(serializedArgs, /argus-provider-egress-hermes/);
  assert.match(serializedArgs, /ARGUS_MCP_PROXY_ROOT_TRACE_ID=ab5513cf-5a7b-4c64-a235-2998c836766b/);
  assert.match(serializedArgs, /printf 'n\\ny\\n'/);
  assert.match(serializedArgs, /argus_core\.\*all tools enabled/);
  assert.match(serializedArgs, /grant\.tmp; mv \/run\/argus-mcp\/grant\.tmp \/run\/argus-mcp\/grant/);
  assert.match(serializedArgs, /tools disable web browser terminal file code_execution/);
  assert.match(serializedArgs, /grep -q '\[\^\[:space:\]\]'/);
  assert.match(serializedArgs, /Managed Hermes completed successfully/);
  assert.doesNotMatch(serializedArgs, /--toolsets mcp/);

  const secretWrites = docker.calls.filter(call => call.stdin !== undefined);
  assert.equal(secretWrites.length, 2);
  assert.equal(secretWrites[0]?.stdin, GRANT);
  assert.match(secretWrites[1]?.stdin ?? '', /private managed instructions[\s\S]*private managed prompt/);
  assert.match(secretWrites[1]?.stdin ?? '', /Always finish with a non-empty, concise response/);
  assert.doesNotMatch(secretWrites[1]?.stdin ?? '', /eg_v1/);

  const running = await provisioner.status(RUN_ID);
  assert.equal(running.state, 'running');
  docker.inspectState = { Status: 'exited', ExitCode: 0 };
  const completed = await provisioner.status(RUN_ID);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.output, '- src/parser.ts');
  assert.deepEqual(completed.usage, {
    inputTokens: 120, outputTokens: 30, totalTokens: 150,
    cacheReadInputTokens: 40, reasoningTokens: 12, apiCalls: 3, estimatedCostUsd: 0.0042,
  });
  assert.deepEqual(completed.evidence, {
    runtime: 'hermes', isolation: 'docker', tool_boundary: 'runtime_mcp',
    mcp_call_attempts: 2, mcp_calls: 2, mcp_call_failures: 0, mcp_tools_advertised: 2,
  });
  assert.ok(docker.calls.some(call => call.args[0] === 'network' && call.args[1] === 'rm'));
});

test('strips malformed private accounting markers without exposing them as model output', () => {
  assert.deepEqual(splitManagedHermesLogs('__ARGUS_HERMES_USAGE_V1__not-base64\nanswer'), { output: 'answer' });
});

test('enforces one managed run per operator Hermes auth profile', async () => {
  const policy = resolution();
  assert.equal(policy.state, 'eligible');
  const docker = new FakeDocker();
  docker.activeAuthProfile = true;
  const provisioner = new DockerCliManagedRunnerProvisioner(policy, {
    coreRuntimeMcpOrigin: 'http://argus-core:3000',
    docker,
  });
  await assert.rejects(() => provisioner.launch(request(), policy.policy), DockerRunnerdPolicyError);
  assert.equal(docker.calls.some(call => call.args[0] === 'create'), false);
});

test('serializes cancellation behind an in-flight launch so cleanup is the final resource action', async () => {
  const policy = resolution();
  assert.equal(policy.state, 'eligible');
  const docker = new BlockingDocker();
  const provisioner = new DockerCliManagedRunnerProvisioner(policy, {
    coreRuntimeMcpOrigin: 'http://argus-core:3000',
    docker,
  });

  const launch = provisioner.launch(request(), policy.policy);
  await docker.networkCreateStarted;
  const cancellation = provisioner.cancel(RUN_ID);
  docker.continueLaunch();

  assert.equal((await launch).state, 'running');
  assert.equal((await cancellation).state, 'cancelled');
  const reversedCalls = [...docker.calls].reverse();
  const createFromEnd = reversedCalls.findIndex(call => call.args[0] === 'create');
  const cleanupFromEnd = reversedCalls.findIndex(call => call.args[0] === 'rm' && call.args.includes('--force'));
  const createIndex = createFromEnd < 0 ? -1 : docker.calls.length - 1 - createFromEnd;
  const cleanupIndex = cleanupFromEnd < 0 ? -1 : docker.calls.length - 1 - cleanupFromEnd;
  assert.ok(createIndex >= 0);
  assert.ok(cleanupIndex > createIndex);
});

test('hard-stops a running container when its Core-owned deadline expires', async () => {
  const policy = resolution();
  assert.equal(policy.state, 'eligible');
  const docker = new FakeDocker();
  docker.deadline = Date.now() - 1;
  const provisioner = new DockerCliManagedRunnerProvisioner(policy, {
    coreRuntimeMcpOrigin: 'http://argus-core:3000',
    docker,
  });
  const status = await provisioner.status(RUN_ID);
  assert.equal(status.state, 'failed');
  assert.equal(status.errorCode, 'HERMES_DEADLINE_EXCEEDED');
  assert.ok(docker.calls.some(call => call.args[0] === 'rm' && call.args.includes('--force')));
});

test('keeps a paused container non-terminal until the Core-owned deadline expires', async () => {
  const policy = resolution();
  assert.equal(policy.state, 'eligible');
  const docker = new FakeDocker();
  docker.inspectState = { Status: 'paused', ExitCode: 0 };
  const provisioner = new DockerCliManagedRunnerProvisioner(policy, {
    coreRuntimeMcpOrigin: 'http://argus-core:3000',
    docker,
  });

  await expectStatus(provisioner.status(RUN_ID), 'running');
  docker.deadline = Date.now() - 1;
  const expired = await provisioner.status(RUN_ID);
  assert.equal(expired.state, 'failed');
  assert.equal(expired.errorCode, 'HERMES_DEADLINE_EXCEEDED');
});

async function expectStatus(
  result: Promise<{ state: string }>,
  expected: string,
): Promise<void> {
  assert.equal((await result).state, expected);
}
