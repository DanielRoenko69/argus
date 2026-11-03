import { spawn, spawnSync } from 'node:child_process';
import type { ManagedHermesRunStartRequest, ManagedHermesRunUsage } from './managedRunContract.js';
import {
  DockerRunnerdPolicyError,
  type DockerManagedRunnerProvisioner,
  type DockerManagedRunnerTopology,
  type DockerRunnerdPolicyResolution,
} from './dockerRunnerdPolicy.js';
import type { HermesRunnerdRun } from './runnerdContract.js';
import type {
  HermesRunnerdLauncher,
  HermesRunnerdLauncherAvailability,
} from './runnerdLauncher.js';

const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;
const DOCKER_TIMEOUT_MS = 60_000;
const HERMES_USAGE_LOG_PREFIX = '__ARGUS_HERMES_USAGE_V1__';
const SAFE_DOCKER_BINARY = /^(?:docker|\/[^\r\n\u0000]{1,1023}\/docker)$/;

const PROXY_HEALTH_SCRIPT = [
  "const deadline=Date.now()+10000;",
  "for(;;){try{const r=await fetch('http://127.0.0.1:3002/healthz');if(r.ok)process.exit(0)}catch{}",
  "if(Date.now()>=deadline)process.exit(1);await new Promise(r=>setTimeout(r,100));}",
].join('');
const PROXY_EVIDENCE_SCRIPT = [
  "const r=await fetch('http://127.0.0.1:3002/healthz');if(!r.ok)process.exit(1);",
  "const j=await r.json();for(const k of ['toolCallAttempts','toolCalls','toolCallFailures','advertisedTools']){if(!Number.isInteger(j[k])||j[k]<0||j[k]>1000000)process.exit(1)}",
  "process.stdout.write(JSON.stringify({mcp_call_attempts:j.toolCallAttempts,mcp_calls:j.toolCalls,mcp_call_failures:j.toolCallFailures,mcp_tools_advertised:j.advertisedTools}));",
].join('');

// This exact list is attested against the pinned Hermes release. Managed V1
// delegates capabilities exclusively through Core's runtime MCP lease, so no
// native Hermes toolset may remain enabled. A Hermes release update must
// review this list before its image digest can be promoted.
const HERMES_NATIVE_TOOLSETS = [
  'web', 'browser', 'terminal', 'file', 'code_execution', 'vision', 'video',
  'image_gen', 'video_gen', 'x_search', 'tts', 'skills', 'todo', 'memory',
  'context_engine', 'session_search', 'clarify', 'delegation', 'cronjob',
  'homeassistant', 'spotify', 'yuanbao', 'computer_use',
].join(' ');

// No request value is interpolated into this script. Prompt and credentials
// enter through private tmpfs files, while provider/model are validated,
// operator-owned environment values.
const HERMES_BOOTSTRAP = `
set -eu
umask 077
for file in .env auth.json; do
  if [ -f "/run/argus-hermes-auth/$file" ]; then
    cp "/run/argus-hermes-auth/$file" "/opt/data/$file"
  fi
done
[ -f /opt/data/auth.json ] || { echo AUTH_PROFILE_UNAVAILABLE >&2; exit 78; }
i=0
while [ ! -f /run/argus-input/prompt ]; do
  i=$((i + 1)); [ "$i" -lt 600 ] || exit 79; sleep 0.1
done
i=0
until printf 'n\ny\n' | /opt/hermes/.venv/bin/hermes mcp add argus_core \
  --url http://argus-mcp-proxy:3002/mcp --connect-timeout 5 \
  >/run/argus-output/mcp-setup.log 2>&1 \
  && /opt/hermes/.venv/bin/hermes tools list --platform cli \
  >/run/argus-output/mcp-tool-status.log 2>&1 \
  && grep -Eq 'argus_core.*all tools enabled' /run/argus-output/mcp-tool-status.log; do
  i=$((i + 1)); [ "$i" -lt 60 ] || exit 80; sleep 0.5
done
/opt/hermes/.venv/bin/hermes tools disable ${HERMES_NATIVE_TOOLSETS} --platform cli \
  >/run/argus-output/tool-policy.log 2>&1 || exit 81
/opt/hermes/.venv/bin/hermes tools list --platform cli \
  >/run/argus-output/tool-status.log 2>&1 || exit 82
grep -Eq 'argus_core.*all tools enabled' /run/argus-output/tool-status.log || exit 83
set +e
/opt/hermes/.venv/bin/hermes --oneshot "$(cat /run/argus-input/prompt)" \
  --provider "$ARGUS_HERMES_PROVIDER" --model "$ARGUS_HERMES_MODEL" \
  --ignore-rules --usage-file /run/argus-output/usage.json \
  >/run/argus-output/result.raw
code=$?
if [ "$code" -eq 0 ] && ! grep -q '[^[:space:]]' /run/argus-output/result.raw; then
  printf '%s\n' 'Managed Hermes completed successfully. Inspect the governed workspace diff for the exact changes.' \
    >/run/argus-output/result.raw
fi
head -c "$ARGUS_MAX_OUTPUT_BYTES" /run/argus-output/result.raw >/run/argus-output/result.txt || true
rm -f /run/argus-output/result.raw /run/argus-input/prompt
if [ -s /run/argus-output/usage.json ]; then
  /opt/hermes/.venv/bin/python -c 'import base64,json; u=json.load(open("/run/argus-output/usage.json", encoding="utf-8")); m={"input_tokens":"inputTokens","output_tokens":"outputTokens","total_tokens":"totalTokens","cache_read_tokens":"cacheReadInputTokens","cache_write_tokens":"cacheWriteInputTokens","reasoning_tokens":"reasoningTokens","api_calls":"apiCalls"}; d={b:u[a] for a,b in m.items() if isinstance(u.get(a),int) and not isinstance(u.get(a),bool) and u[a]>=0}; d["inputTokens"]=d.get("inputTokens",0); d["outputTokens"]=d.get("outputTokens",0); d["totalTokens"]=d.get("totalTokens",d["inputTokens"]+d["outputTokens"]); c=u.get("estimated_cost_usd"); d.update({"estimatedCostUsd":c} if isinstance(c,(int,float)) and not isinstance(c,bool) and c>=0 else {}); print("__ARGUS_HERMES_USAGE_V1__"+base64.b64encode(json.dumps(d,separators=(",",":")).encode()).decode())' || true
fi
head -c 32768 /run/argus-output/result.txt
exit "$code"
`.trim();

export interface DockerCommandResult {
  stdout: string;
}

export interface DockerCommandRunner {
  run(args: readonly string[], options?: { stdin?: string; timeoutMs?: number }): Promise<DockerCommandResult>;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Split runner accounting from bounded model output before either leaves runnerd. */
export function splitManagedHermesLogs(logs: string): { output: string; usage?: ManagedHermesRunUsage } {
  const newline = logs.indexOf('\n');
  const firstLine = newline < 0 ? logs : logs.slice(0, newline);
  if (!firstLine.startsWith(HERMES_USAGE_LOG_PREFIX)) return { output: logs };
  const output = newline < 0 ? '' : logs.slice(newline + 1);
  const encoded = firstLine.slice(HERMES_USAGE_LOG_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return { output };
  try {
    const raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;
    const inputTokens = nonNegativeInteger(raw['inputTokens']);
    const outputTokens = nonNegativeInteger(raw['outputTokens']);
    const totalTokens = nonNegativeInteger(raw['totalTokens']);
    if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return { output };
    const usage: ManagedHermesRunUsage = { inputTokens, outputTokens, totalTokens };
    for (const key of ['cacheReadInputTokens', 'cacheWriteInputTokens', 'reasoningTokens', 'apiCalls'] as const) {
      const value = nonNegativeInteger(raw[key]);
      if (value !== undefined) usage[key] = value;
    }
    const estimatedCostUsd = raw['estimatedCostUsd'];
    if (typeof estimatedCostUsd === 'number' && Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0) {
      usage.estimatedCostUsd = estimatedCostUsd;
    }
    return { output, usage };
  } catch {
    return { output };
  }
}

export class DockerCliCommandError extends Error {
  constructor() {
    // Deliberately omit argv/stdin/stderr: all three can describe the private
    // topology and stdin can contain the execution grant or user prompt.
    super('Docker managed runner operation failed.');
  }
}

export class DockerCliCommandRunner implements DockerCommandRunner {
  constructor(private readonly binary = 'docker') {
    if (!SAFE_DOCKER_BINARY.test(binary)) throw new DockerCliCommandError();
  }

  run(args: readonly string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<DockerCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new DockerCliCommandError());
      };
      const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.byteLength;
        if (bytes > MAX_DOCKER_OUTPUT_BYTES) {
          fail();
          return;
        }
        target.push(value);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', fail);
      const timer = setTimeout(fail, options.timeoutMs ?? DOCKER_TIMEOUT_MS);
      timer.unref?.();
      child.once('close', code => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new DockerCliCommandError());
          return;
        }
        resolve({ stdout: Buffer.concat(stdout).toString('utf8').trim() });
      });
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }
}

export interface DockerManagedRunnerPreflightOptions {
  dockerBinary?: string;
}

/**
 * Startup-only capability proof. It checks the daemon plus every immutable
 * image/operator resource before runnerd may advertise `ready`.
 */
export function dockerManagedRunnerPreflight(
  topology: DockerManagedRunnerTopology,
  options: DockerManagedRunnerPreflightOptions = {},
): boolean {
  const binary = options.dockerBinary ?? 'docker';
  if (!SAFE_DOCKER_BINARY.test(binary)) return false;
  const checks: string[][] = [
    ['version', '--format', '{{.Server.Version}}'],
    ['image', 'inspect', topology.hermes.image],
    ['image', 'inspect', topology.mcpProxy.image],
    ['network', 'inspect', topology.networks.coreEgress.name],
    ['network', 'inspect', topology.networks.providerEgress.name],
    ['volume', 'inspect', topology.hermes.authentication.volume],
  ];
  return checks.every(args => {
    const result = spawnSync(binary, args, {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    });
    return result.status === 0 && !result.error;
  });
}

function compactRunId(runId: string): string {
  return runId.replaceAll('-', '').toLowerCase();
}

function identifiers(runId: string, networkPrefix: string) {
  const compact = compactRunId(runId);
  return {
    hermes: `argus-hermes-run-${compact}`,
    proxy: `argus-mcp-proxy-${compact}`,
    network: `${networkPrefix.slice(0, 28)}-${compact}`,
    native: `docker-${compact}`,
  };
}

function resourceArgs(resources: { cpuMillicores: number; memoryMiB: number; pids: number }): string[] {
  return [
    '--cpus', String(resources.cpuMillicores / 1_000),
    '--memory', `${resources.memoryMiB}m`,
    '--pids-limit', String(resources.pids),
  ];
}

function securityArgs(): string[] {
  return [
    '--user', '1000:1000',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
  ];
}

interface DockerState {
  Status?: string;
  ExitCode?: number;
}

function parseState(value: string): DockerState {
  try {
    const parsed = JSON.parse(value) as DockerState;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.Status !== 'string') throw new Error();
    return parsed;
  } catch {
    throw new DockerCliCommandError();
  }
}

function prompt(request: ManagedHermesRunStartRequest): string {
  return [
    request.run.instructions?.trim(),
    request.run.input.text.trim(),
    'Use only the Argus MCP tools exposed for this run. Do not use native shell, filesystem, browser, network, or external write capabilities.',
    'Always finish with a non-empty, concise response that summarizes the governed work completed. For code changes, list each changed path as a bullet.',
  ].filter(Boolean).join('\n\n');
}

export interface DockerCliManagedRunnerProvisionerOptions {
  coreRuntimeMcpOrigin: string;
  docker?: DockerCommandRunner;
}

/**
 * Narrow Docker implementation for the separately privileged runnerd. It has
 * no generic run/exec API: every image, mount, network, command and limit is
 * derived from the already validated operator topology.
 */
export class DockerCliManagedRunnerProvisioner implements DockerManagedRunnerProvisioner {
  private readonly docker: DockerCommandRunner;
  private launchLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly resolution: DockerRunnerdPolicyResolution,
    private readonly options: DockerCliManagedRunnerProvisionerOptions,
  ) {
    this.docker = options.docker ?? new DockerCliCommandRunner();
  }

  availability(): DockerRunnerdPolicyResolution {
    return this.resolution;
  }

  launch(request: ManagedHermesRunStartRequest, topology: DockerManagedRunnerTopology): Promise<HermesRunnerdRun> {
    return this.serializedLaunch(async () => {
      const ids = identifiers(request.run.id, topology.networks.run.name);
      let stage: 'auth-profile' | 'cleanup' | 'network' | 'proxy' | 'hermes' = 'auth-profile';
      await this.ensureAuthProfileUnused(topology);
      stage = 'cleanup';
      await this.cleanup(ids);
      try {
        stage = 'network';
        await this.docker.run(['network', 'create', '--internal', '--label', `argus.hermes.run=${request.run.id}`, ids.network]);
        stage = 'proxy';
        await this.createProxy(request, topology, ids);
        stage = 'hermes';
        await this.createHermes(request, topology, ids);
        return {
          id: request.run.id,
          nativeRunId: ids.native,
          state: 'running',
          evidence: { runtime: 'hermes', isolation: 'docker', tool_boundary: 'runtime_mcp' },
        };
      } catch {
        // Stage-only diagnostics are safe for operator logs: they deliberately
        // exclude argv, stderr, the private prompt and the execution grant.
        process.stderr.write(`Managed Hermes launch failed at ${stage} stage\n`);
        await this.cleanup(ids);
        throw new DockerRunnerdPolicyError();
      }
    });
  }

  async status(runId: string): Promise<HermesRunnerdRun> {
    const ids = identifiers(runId, this.topology().networks.run.name);
    let state: DockerState;
    try {
      state = parseState((await this.docker.run(['inspect', '--format', '{{json .State}}', ids.hermes])).stdout);
    } catch {
      return { id: runId, state: 'failed', errorCode: 'HERMES_CONTAINER_UNAVAILABLE' };
    }
    // A paused container is still a live attempt. Treat it as running so the
    // Core-owned deadline remains authoritative and local resilience tests can
    // deterministically hold execution without turning pause into a fake
    // native crash.
    if (['created', 'running', 'restarting', 'paused'].includes(state.Status ?? '')) {
      try {
        const deadline = Number((await this.docker.run([
          'inspect', '--format', '{{index .Config.Labels "argus.hermes.deadline"}}', ids.hermes,
        ])).stdout);
        if (!Number.isFinite(deadline) || deadline <= Date.now()) {
          await this.cleanup(ids);
          return {
            id: runId,
            nativeRunId: ids.native,
            state: 'failed',
            errorCode: 'HERMES_DEADLINE_EXCEEDED',
          };
        }
      } catch {
        await this.cleanup(ids);
        return {
          id: runId,
          nativeRunId: ids.native,
          state: 'failed',
          errorCode: 'HERMES_DEADLINE_UNAVAILABLE',
        };
      }
      return {
        id: runId,
        nativeRunId: ids.native,
        state: 'running',
        evidence: { runtime: 'hermes', isolation: 'docker', tool_boundary: 'runtime_mcp' },
      };
    }
    const completed = state.Status === 'exited' && state.ExitCode === 0;
    let output: string | undefined;
    let usage: ManagedHermesRunUsage | undefined;
    if (completed) {
      try {
        const terminal = splitManagedHermesLogs((await this.docker.run(['logs', ids.hermes])).stdout);
        output = terminal.output.slice(0, 32 * 1024);
        usage = terminal.usage;
      } catch {
        const proxyEvidence = await this.proxyEvidence(ids);
        await this.cleanup(ids);
        return {
          id: runId,
          nativeRunId: ids.native,
          state: 'failed',
          evidence: proxyEvidence,
          errorCode: 'HERMES_OUTPUT_UNAVAILABLE',
        };
      }
    }
    const proxyEvidence = await this.proxyEvidence(ids);
    await this.cleanup(ids);
    if (completed) {
      return {
        id: runId,
        nativeRunId: ids.native,
        state: 'completed',
        evidence: { runtime: 'hermes', isolation: 'docker', tool_boundary: 'runtime_mcp', ...proxyEvidence },
        output,
        ...(usage === undefined ? {} : { usage }),
      };
    }
    return {
      id: runId,
      nativeRunId: ids.native,
      state: 'failed',
      evidence: proxyEvidence,
      errorCode: 'HERMES_EXIT_NONZERO',
    };
  }

  async cancel(runId: string): Promise<HermesRunnerdRun> {
    // A stop may arrive while the matching launch is still creating its
    // network/sidecars. Queue cleanup behind that launch so no late create can
    // resurrect resources after Runnerd has reported `cancelled`.
    return this.serializedLaunch(async () => {
      const ids = identifiers(runId, this.topology().networks.run.name);
      await this.cleanup(ids);
      return { id: runId, nativeRunId: ids.native, state: 'cancelled' };
    });
  }

  private topology(): DockerManagedRunnerTopology {
    if (this.resolution.state !== 'eligible') throw new DockerRunnerdPolicyError();
    return this.resolution.policy;
  }

  private serializedLaunch<T>(action: () => Promise<T>): Promise<T> {
    const run = this.launchLock.then(action, action);
    this.launchLock = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureAuthProfileUnused(topology: DockerManagedRunnerTopology): Promise<void> {
    const result = await this.docker.run([
      'ps', '--quiet', '--filter', `label=argus.hermes.auth-volume=${topology.hermes.authentication.volume}`,
    ]);
    if (result.stdout) throw new DockerRunnerdPolicyError();
  }

  private async createProxy(
    request: ManagedHermesRunStartRequest,
    topology: DockerManagedRunnerTopology,
    ids: ReturnType<typeof identifiers>,
  ): Promise<void> {
    await this.docker.run([
      'create', '--name', ids.proxy,
      '--network', ids.network, '--network-alias', topology.mcpProxy.listen.host,
      '--label', `argus.hermes.run=${request.run.id}`,
      ...securityArgs(), ...resourceArgs(topology.mcpProxy.resources),
      '--tmpfs', '/run/argus-mcp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700',
      '--env', `ARGUS_MCP_PROXY_CORE_ORIGIN=${this.options.coreRuntimeMcpOrigin}`,
      '--env', `ARGUS_MCP_PROXY_LEASE_ID=${request.runtimeMcpLease.leaseId}`,
      '--env', `ARGUS_MCP_PROXY_ROOT_TRACE_ID=${request.run.rootTraceId}`,
      '--env', `ARGUS_MCP_PROXY_GRANT_FILE=${topology.mcpProxy.grant.path}`,
      '--env', `ARGUS_MCP_PROXY_PORT=${topology.mcpProxy.listen.port}`,
      '--entrypoint', 'node', topology.mcpProxy.image, 'dist/mcpAuthProxy.js',
    ]);
    await this.docker.run(['network', 'connect', topology.networks.coreEgress.name, ids.proxy]);
    await this.docker.run(['start', ids.proxy]);
    await this.docker.run([
      'exec', '-i', '--user', '1000:1000', ids.proxy,
      '/bin/sh', '-ec', `umask 077; cat > ${topology.mcpProxy.grant.path}.tmp; mv ${topology.mcpProxy.grant.path}.tmp ${topology.mcpProxy.grant.path}`,
    ], { stdin: request.runtimeMcpLease.executionGrant });
    await this.docker.run(['exec', ids.proxy, 'node', '--input-type=module', '-e', PROXY_HEALTH_SCRIPT], { timeoutMs: 15_000 });
  }

  private async createHermes(
    request: ManagedHermesRunStartRequest,
    topology: DockerManagedRunnerTopology,
    ids: ReturnType<typeof identifiers>,
  ): Promise<void> {
    await this.docker.run([
      'create', '--name', ids.hermes,
      '--network', topology.networks.providerEgress.name,
      '--label', `argus.hermes.run=${request.run.id}`,
      '--label', `argus.hermes.auth-volume=${topology.hermes.authentication.volume}`,
      '--label', `argus.hermes.deadline=${Date.parse(request.limits.deadlineAt)}`,
      ...securityArgs(), ...resourceArgs(topology.hermes.resources),
      '--tmpfs', '/opt/data:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700',
      '--tmpfs', '/run/argus-input:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700',
      '--tmpfs', '/run/argus-output:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=0700',
      '--mount', `type=volume,src=${topology.hermes.authentication.volume},dst=${topology.hermes.authentication.mountPath},readonly`,
      '--env', 'HERMES_HOME=/opt/data',
      '--env', 'HERMES_WRITE_SAFE_ROOT=/opt/data',
      '--env', 'HERMES_DISABLE_LAZY_INSTALLS=1',
      '--env', `ARGUS_HERMES_PROVIDER=${topology.hermes.inference.provider}`,
      '--env', `ARGUS_HERMES_MODEL=${topology.hermes.inference.model}`,
      '--env', `ARGUS_MAX_OUTPUT_BYTES=${request.limits.maxOutputBytes}`,
      '--entrypoint', '/bin/sh', topology.hermes.image, '-ec', HERMES_BOOTSTRAP,
    ]);
    await this.docker.run(['network', 'connect', ids.network, ids.hermes]);
    await this.docker.run(['start', ids.hermes]);
    await this.docker.run([
      'exec', '-i', '--user', '1000:1000', ids.hermes,
      '/bin/sh', '-ec', 'umask 077; cat > /run/argus-input/prompt',
    ], { stdin: prompt(request) });
  }

  private async proxyEvidence(ids: ReturnType<typeof identifiers>): Promise<{
    mcp_call_attempts: number;
    mcp_calls: number;
    mcp_call_failures: number;
    mcp_tools_advertised: number;
  }> {
    const empty = { mcp_call_attempts: 0, mcp_calls: 0, mcp_call_failures: 0, mcp_tools_advertised: 0 };
    try {
      const output = await this.docker.run([
        'exec', ids.proxy, 'node', '--input-type=module', '-e', PROXY_EVIDENCE_SCRIPT,
      ], { timeoutMs: 15_000 });
      const parsed = JSON.parse(output.stdout) as Record<string, unknown>;
      if (Object.keys(empty).some(key => (
        !Number.isInteger(parsed[key]) || Number(parsed[key]) < 0 || Number(parsed[key]) > 1_000_000
      ))) {
        return empty;
      }
      return Object.fromEntries(Object.keys(empty).map(key => [key, Number(parsed[key])])) as typeof empty;
    } catch {
      return empty;
    }
  }

  private async cleanup(ids: ReturnType<typeof identifiers>): Promise<void> {
    for (const name of [ids.hermes, ids.proxy]) {
      try {
        await this.docker.run(['rm', '--force', '--volumes', name], { timeoutMs: 15_000 });
      } catch {
        // Cleanup is idempotent; missing objects are expected on retry/recovery.
      }
    }
    try {
      await this.docker.run(['network', 'rm', ids.network], { timeoutMs: 15_000 });
    } catch {
      // See above. A later status/cancel/restart recovery repeats cleanup.
    }
  }
}

export class DockerManagedHermesRunnerdLauncher implements HermesRunnerdLauncher {
  constructor(
    private readonly resolution: DockerRunnerdPolicyResolution,
    private readonly provisioner: DockerManagedRunnerProvisioner,
    private readonly preflightPassed: boolean,
  ) {}

  availability(): HermesRunnerdLauncherAvailability {
    if (this.resolution.state !== 'eligible' || !this.preflightPassed
      || this.provisioner.availability().state !== 'eligible') {
      return { state: 'unavailable', detail: 'The isolated Docker managed runner did not pass startup preflight.' };
    }
    return { state: 'ready', detail: 'The isolated Docker managed runner passed startup preflight.' };
  }

  launch(request: ManagedHermesRunStartRequest): Promise<HermesRunnerdRun> {
    if (this.resolution.state !== 'eligible' || this.availability().state !== 'ready') {
      throw new DockerRunnerdPolicyError();
    }
    return this.provisioner.launch(request, this.resolution.policy);
  }

  status(runId: string): Promise<HermesRunnerdRun> {
    return this.provisioner.status(runId);
  }

  cancel(runId: string, reason?: string): Promise<HermesRunnerdRun> {
    return this.provisioner.cancel(runId, reason);
  }
}
