/**
 * POST /exec — run a shell command inside the workspace container.
 *
 * Body: { cmd, cwd?, timeoutSec?, env? }
 * Caps: stdout/stderr 256 KB each, hard kill at timeoutSec (default 60, max 300)
 */

import { Router, type Request, type Response } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export const execRouter = Router();

const MAX_CMD_LEN     = 8192;
const MAX_OUT_BYTES   = 256 * 1024;
const DEFAULT_TIMEOUT = 60;
const MAX_TIMEOUT     = 300;
const FORBIDDEN_ENV_PREFIXES = ['LD_', 'NODE_OPTIONS'];
const FORBIDDEN_ENV_KEYS     = new Set(['PATH', 'NODE_PATH']);
const AUDIT_COMMAND_LIMIT    = 200;
const PROCESS_CLOSE_GRACE_MS = 1_000;
const NPM_CI_SETUP_COMMANDS = new Set([
  'if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci; fi',
  'if [ -f package-lock.json ] && [ ! -d node_modules ]; then npm ci --ignore-scripts --no-audit --no-fund; fi',
]);

/**
 * Keep execution evidence useful without persisting credentials embedded in
 * Git extraheaders, curl headers or authenticated repository URLs.
 */
export function redactCommandForAudit(command: string): string {
  return command
    .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/((?:https?|git):\/\/[^\s:/@]+:)[^\s/@]+@/giu, '$1[REDACTED]@')
    .slice(0, AUDIT_COMMAND_LIMIT);
}

type KillableChildProcess = Pick<ChildProcess, 'kill' | 'pid'>;
type ObservableChildProcess = Pick<ChildProcess, 'kill' | 'once' | 'pid'>;
type KillProcess = (pid: number, signal: NodeJS.Signals) => boolean;

/**
 * Commands run through `sh -c`, so package managers and test runners are
 * descendants of the spawned shell. On POSIX, kill the detached process
 * group rather than leaving npm/mocha children alive after the shell exits.
 */
export function terminateProcessTree(
  proc: KillableChildProcess,
  platform: NodeJS.Platform = process.platform,
  killProcess: KillProcess = process.kill,
): void {
  if (platform !== 'win32' && proc.pid !== undefined) {
    try {
      killProcess(-proc.pid, 'SIGKILL');
      return;
    } catch {
      // The process may have exited between the timeout and the group signal.
    }
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    // A concurrent process exit already achieved the desired result.
  }
}

/**
 * Bound the request lifecycle even when a descendant inherited stdout/stderr
 * and prevents Node's `close` event from firing after the shell was killed.
 */
export function waitForChildProcess(
  proc: ObservableChildProcess,
  timeoutMs: number,
  closeGraceMs = PROCESS_CLOSE_GRACE_MS,
  terminate: (child: KillableChildProcess) => void = terminateProcessTree,
): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let closeGraceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      resolve({ exitCode, timedOut });
    };

    proc.once('close', code => finish(code ?? -1));
    proc.once('error', () => finish(-1));

    const killTimer = setTimeout(() => {
      timedOut = true;
      terminate(proc);
      closeGraceTimer = setTimeout(() => finish(-1), closeGraceMs);
    }, timeoutMs);
  });
}

/**
 * `npm ci` is correct for current lockfiles, but historical benchmark and
 * customer repositories can contain an otherwise installable lockfile that
 * predates npm's strict lock/package consistency checks. Keep the strict path
 * first and fall back only inside the isolated deterministic test profile.
 */
export function normalizeIsolatedTestCommand(command: string): string {
  const documentationPaths = parseDeterministicDocsValidationCommand(command);
  if (documentationPaths) {
    const quotedPaths = documentationPaths.map(value => `'${value}'`).join(' ');
    return [
      'set -eu',
      `for path in ${quotedPaths}; do`,
      '  if [ -e "$path" ]; then',
      '    test -f "$path"',
      '    test -s "$path"',
      "    if grep -nE '^(<<<<<<<|=======|>>>>>>>)' -- \"$path\"; then exit 1; fi",
      '  fi',
      'done',
      `git diff --check HEAD -- ${quotedPaths}`,
    ].join('\n');
  }
  if (!NPM_CI_SETUP_COMMANDS.has(command)) return command;
  return 'if [ -f package-lock.json ] && [ ! -d node_modules ]; then '
    + 'npm ci --ignore-scripts --no-audit --no-fund || '
    + 'npm install --package-lock=false --legacy-peer-deps --ignore-scripts --no-audit --no-fund; fi';
}

// ── Child-process env allowlist ───────────────────────────────────
// SECURITY (audit 2026-06-12, finding #4): we MUST NOT spread the full
// process.env into LLM-issued commands. The sidecar process carries secrets
// (WORKSPACE_SECRET — its own auth secret, BITBUCKET_TOKEN, TEST_POSTGRES_*)
// that a benign-looking `env` / `printenv WORKSPACE_SECRET` / `echo $BITBUCKET_TOKEN`
// would otherwise exfiltrate straight into the model context. Instead we pass
// an explicit allowlist of build-relevant vars. Git auth does NOT need
// BITBUCKET_TOKEN here: the coding workflow injects the token per-command via
// `git -c http.extraheader="Authorization: Bearer …"` (langgraph coding.ts),
// never via the child env. Anything a build legitimately needs that isn't
// allowlisted must be passed explicitly through the request `env` field.
const ENV_ALLOW_KEYS = new Set([
  'HOME', 'PATH', 'PWD', 'SHELL', 'USER', 'LOGNAME', 'HOSTNAME', 'TERM',
  'LANG', 'LANGUAGE', 'TMPDIR', 'TZ',
  'NODE_VERSION', 'NODE_ENV',
  'GOPATH', 'GOCACHE', 'GOMODCACHE',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
]);
// Safe, non-secret tooling prefixes (locale, package-manager + language caches/config).
// Deliberately NOT 'NODE_' (would re-admit NODE_OPTIONS/NODE_PATH) or 'GO'
// (too broad — would match GOOGLE_*). Specific Go cache keys are in the key set.
const ENV_ALLOW_PREFIXES = [
  'LC_', 'PYTHON', 'PIP_', 'UV_', 'PNPM_', 'CARGO_',
  'NPM_CONFIG_', 'npm_config_',
];

/**
 * Build the env passed to a spawned `sh -c` command. Pure + exported for test.
 * Allowlist over process.env (never the secret-bearing full env) plus the
 * already-sanitized caller-supplied `extraEnv`. NODE_OPTIONS / NODE_PATH /
 * PATH from the caller are rejected upstream by sanitizeEnv; the `NODE_`
 * prefix here only re-admits non-overridable parent vars like NODE_VERSION.
 */
export function buildChildEnv(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALLOW_KEYS.has(k) || ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return { ...out, ...extraEnv };
}

/**
 * Blocklist of dangerous shell patterns that should never be allowed in the workspace.
 * This is NOT a whitelist (too restrictive for dev tasks) — it's a targeted blocklist
 * for catastrophic or exfiltration-enabling commands.
 */
const BLOCKED_CMD_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-z]*r[a-z]*\s+\/(?:\s|$)/i,    reason: 'rm -r on root filesystem' },
  { pattern: /\|\s*(?:ba)?sh\b/i,                        reason: 'pipe to shell (RCE chaining)' },
  { pattern: /\|\s*python3?\b/i,                         reason: 'pipe to python (RCE chaining)' },
  { pattern: /\bsudo\b/i,                                reason: 'privilege escalation via sudo' },
  { pattern: />\s*\/dev\/tcp\//i,                        reason: 'TCP redirect (data exfiltration)' },
  { pattern: /\/etc\/(?:passwd|shadow|sudoers)/i,        reason: 'access to sensitive system files' },
  { pattern: /\bdd\s+.*\bof=\/dev\b/i,                  reason: 'dd to block device' },
  { pattern: /\bcurl\b.*\|\s*(?:ba)?sh\b/i,             reason: 'curl-pipe-shell (RCE)' },
  { pattern: /\bwget\b.*\|\s*(?:ba)?sh\b/i,             reason: 'wget-pipe-shell (RCE)' },
  { pattern: /\bchmod\s+[0-7]*7\s+\/(?:etc|usr|bin)\b/i, reason: 'chmod on critical system dirs' },
];

function checkBlockedPatterns(cmd: string): string | null {
  for (const { pattern, reason } of BLOCKED_CMD_PATTERNS) {
    if (pattern.test(cmd)) return reason;
  }
  return null;
}

interface ExecBody {
  cmd?: unknown;
  cwd?: unknown;
  timeoutSec?: unknown;
  env?: unknown;
  environmentProfile?: unknown;
}

const DETERMINISTIC_PROJECT_TEST_COMMANDS: ReadonlyArray<RegExp> = [
  /^find \. -maxdepth 4 -type f [\s\S]+ -print \| sort$/,
  /^command -v (?:npm|corepack|bun|uv|python3|go|cargo|sh|mvn|gradle|dotnet) >\/dev\/null 2>&1$/,
  /^if \[ ! -d node_modules \]; then corepack pnpm install --frozen-lockfile; fi$/,
  /^corepack pnpm (?:test|run --if-present build)$/,
  /^if \[ ! -d node_modules \]; then corepack yarn install --immutable; fi$/,
  /^corepack yarn test$/,
  /^if node -e "process\.exit\(require\('\.\/package\.json'\)\.scripts\?\.build \? 0 : 1\)"; then corepack yarn build; fi$/,
  /^if \[ ! -d node_modules \]; then bun install --frozen-lockfile; fi$/,
  /^bun run (?:test|build)$/,
  /^if node -e "process\.exit\(require\('\.\/package\.json'\)\.scripts\?\.build \? 0 : 1\)"; then bun run build; fi$/,
  /^if \[ -f package-lock\.json \] && \[ ! -d node_modules \]; then npm ci; fi$/,
  /^if \[ -f package-lock\.json \] && \[ ! -d node_modules \]; then npm ci --ignore-scripts --no-audit --no-fund; fi$/,
  /^npm (?:test|run test --if-present|run build --if-present)$/,
  /^uv sync --frozen$/,
  /^uv run (?:alembic upgrade head|python -m pytest)$/,
  /^python3 -m pytest$/,
  /^go (?:test|vet) \.\/\.\.\.$/,
  /^cargo (?:test|check)(?: --locked)?$/,
  /^(?:sh \.\/mvnw|mvn) -B test$/,
  /^(?:sh \.\/gradlew|gradle) test --no-daemon$/,
  /^dotnet test --nologo$/,
];

function parseDeterministicDocsValidationCommand(command: string): string[] | null {
  const match = /^argus-docs-validate (.+)$/u.exec(command);
  if (!match) return null;
  const rawArguments = match[1] ?? '';
  const quotedPaths = rawArguments.match(/'[^'\r\n]+'/gu);
  if (!quotedPaths || quotedPaths.join(' ') !== rawArguments) return null;

  const paths = quotedPaths.map(quoted => quoted.slice(1, -1));
  if (paths.length === 0) return null;
  return paths.every(documentationPath => {
    if (!/^[A-Za-z0-9_.@+ /-]+$/u.test(documentationPath) || documentationPath.startsWith('/')) return false;
    const segments = documentationPath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
    const lowerPath = documentationPath.toLowerCase();
    return /\.(?:adoc|md|mdx|rst)$/u.test(lowerPath)
      || (lowerPath.startsWith('docs/') && lowerPath.endsWith('.txt'));
  }) ? paths : null;
}

function isTicketScopedPytestCommand(command: string): boolean {
  const match = /^(?:uv run python|python3) -m pytest (.+)$/.exec(command);
  if (!match) return false;
  const rawArguments = match[1] ?? '';
  const quotedPaths = rawArguments.match(/'[^'\r\n]+'/g);
  if (!quotedPaths || quotedPaths.join(' ') !== rawArguments) return false;

  return quotedPaths.every(quoted => {
    const testPath = quoted.slice(1, -1);
    if (!/^[A-Za-z0-9_.@+ /-]+$/.test(testPath) || testPath.startsWith('/')) return false;
    const segments = testPath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
    const fileName = segments.at(-1)?.toLowerCase() ?? '';
    return fileName.endsWith('.py')
      && (fileName.startsWith('test_') || fileName.endsWith('_test.py'));
  });
}

function isTicketScopedNodeIntegrationCommand(command: string): boolean {
  const match = /^npm exec --offline -- mocha --reporter-option maxDiffSize=0 -- (.+)$/u.exec(command);
  if (!match) return false;
  const rawArguments = match[1] ?? '';
  const quotedPaths = rawArguments.match(/'[^'\r\n]+'/gu);
  if (!quotedPaths || quotedPaths.join(' ') !== rawArguments) return false;

  return quotedPaths.every(quoted => {
    const testPath = quoted.slice(1, -1);
    if (!/^[A-Za-z0-9_.@+ /-]+$/u.test(testPath) || !testPath.startsWith('integration/')) return false;
    const segments = testPath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
    const fileName = segments.at(-1)?.toLowerCase() ?? '';
    return /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(fileName);
  });
}

function isDeterministicGoTestCommand(command: string): boolean {
  if (/[;&|><`\r\n]/u.test(command) || command.includes('$(')) return false;
  const rawTokens = command.match(/'[^']*'|"[^"]*"|\S+/gu);
  if (!rawTokens || rawTokens.length < 3) return false;
  const tokens = rawTokens.map(token => {
    const quoted = (token.startsWith("'") && token.endsWith("'"))
      || (token.startsWith('"') && token.endsWith('"'));
    return quoted ? token.slice(1, -1) : token;
  });
  if (tokens[0] !== 'go' || tokens[1] !== 'test') return false;

  let packageCount = 0;
  for (let index = 2; index < tokens.length; index++) {
    const token = tokens[index] ?? '';
    if (/^\.\/(?:\.\.\.|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/u.test(token)
      && !token.split('/').includes('..')) {
      packageCount += 1;
      continue;
    }
    if (/^-(?:race|short|v|failfast)$/u.test(token)) continue;
    if (/^-count=[1-9][0-9]*$/u.test(token)) continue;
    if (/^-timeout=[1-9][0-9]*(?:s|m)$/u.test(token)) continue;
    if (/^-run=[A-Za-z0-9_.*^$|()[\]{}+?\\-]+$/u.test(token)) continue;
    if (token === '-run') {
      const pattern = tokens[++index] ?? '';
      if (!/^[A-Za-z0-9_.*^$|()[\]{}+?\\-]+$/u.test(pattern)) return false;
      continue;
    }
    // rclone's focused suites require the built-in local test remote. Keep
    // the accepted value exact so this cannot become a generic flag tunnel.
    if (token === '-remote' && tokens[index + 1] === 'local') {
      index += 1;
      continue;
    }
    return false;
  }
  return packageCount > 0;
}

/** Restrict the isolated test environment to static project-runner commands. */
export function isDeterministicProjectTestCommand(command: string): boolean {
  // Only the fixed workspace-relative source path, never arbitrary environment assignments.
  if (command.startsWith('PYTHONPATH=src python3 -m pytest')) {
    const pytestCommand = command.slice('PYTHONPATH=src '.length);
    return pytestCommand === 'python3 -m pytest' || isTicketScopedPytestCommand(pytestCommand);
  }
  return DETERMINISTIC_PROJECT_TEST_COMMANDS.some(pattern => pattern.test(command))
    || parseDeterministicDocsValidationCommand(command) !== null
    || isTicketScopedNodeIntegrationCommand(command)
    || isTicketScopedPytestCommand(command)
    || isDeterministicGoTestCommand(command);
}

function isInsideWorkspace(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === '/workspace' || resolved.startsWith('/workspace/');
}

function sanitizeEnv(envInput: Record<string, unknown>): Record<string, string> | { error: string } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(envInput)) {
    if (FORBIDDEN_ENV_KEYS.has(k) || FORBIDDEN_ENV_PREFIXES.some(p => k.startsWith(p))) {
      return { error: `env var "${k}" is not allowed` };
    }
    if (typeof v !== 'string') {
      return { error: `env var "${k}" must be a string` };
    }
    out[k] = v;
  }
  return out;
}

function clampOutput(buf: Buffer[], total: number): { text: string; truncated: boolean } {
  const joined = Buffer.concat(buf, total);
  if (total <= MAX_OUT_BYTES) {
    return { text: joined.toString('utf-8'), truncated: false };
  }
  return {
    text: joined.subarray(0, MAX_OUT_BYTES).toString('utf-8') + '\n...[truncated]',
    truncated: true,
  };
}

execRouter.post('/', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ExecBody;

  // ── Validate cmd ──────────────────────────────────────────────
  if (typeof body.cmd !== 'string' || body.cmd.length === 0) {
    res.status(400).json({ error: 'cmd is required (non-empty string)' });
    return;
  }
  if (body.cmd.length > MAX_CMD_LEN) {
    res.status(400).json({ error: `cmd exceeds ${MAX_CMD_LEN} chars` });
    return;
  }
  const cmd: string = body.cmd;
  // Older Argus.Dev pack images predate the explicit `isolated-test` request
  // flag. The rewrite remains safe across that compatibility boundary because
  // it matches only the two static npm setup commands owned by the project
  // runner; arbitrary caller commands are returned byte-for-byte.
  let executionCommand = normalizeIsolatedTestCommand(cmd);

  const blockedReason = checkBlockedPatterns(cmd);
  if (blockedReason) {
    res.status(403).json({ error: `Command blocked: ${blockedReason}` });
    return;
  }

  // ── Validate cwd ──────────────────────────────────────────────
  let cwd = '/workspace';
  if (body.cwd !== undefined) {
    if (typeof body.cwd !== 'string') {
      res.status(400).json({ error: 'cwd must be a string' });
      return;
    }
    if (!isInsideWorkspace(body.cwd)) {
      res.status(400).json({ error: 'cwd must be inside /workspace' });
      return;
    }
    cwd = path.resolve(body.cwd);
  }

  // ── Validate timeoutSec ───────────────────────────────────────
  let timeoutSec = DEFAULT_TIMEOUT;
  if (body.timeoutSec !== undefined) {
    if (typeof body.timeoutSec !== 'number' || !Number.isFinite(body.timeoutSec)) {
      res.status(400).json({ error: 'timeoutSec must be a finite number' });
      return;
    }
    timeoutSec = Math.max(1, Math.min(MAX_TIMEOUT, Math.floor(body.timeoutSec)));
  }

  // ── Validate env ──────────────────────────────────────────────
  let extraEnv: Record<string, string> = {};
  if (body.env !== undefined) {
    if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env)) {
      res.status(400).json({ error: 'env must be an object' });
      return;
    }
    const sanitized = sanitizeEnv(body.env as Record<string, unknown>);
    if ('error' in sanitized) {
      res.status(400).json({ error: sanitized.error });
      return;
    }
    extraEnv = sanitized;
  }

  let profileEnv: Record<string, string> = {};
  if (body.environmentProfile !== undefined) {
    if (body.environmentProfile !== 'isolated-test') {
      res.status(400).json({ error: 'unknown environment profile' });
      return;
    }
    if (!isDeterministicProjectTestCommand(cmd)) {
      res.status(403).json({ error: 'isolated-test is restricted to deterministic project test commands' });
      return;
    }
    const databaseUrl = process.env['DATABASE_URL'] ?? '';
    let parsedDatabaseUrl: URL;
    try {
      parsedDatabaseUrl = new URL(databaseUrl);
    } catch {
      res.status(503).json({ error: 'isolated test database is not configured' });
      return;
    }
    if (parsedDatabaseUrl.password) {
      res.status(503).json({ error: 'isolated test database URL must not contain credentials' });
      return;
    }
    profileEnv = {
      DATABASE_URL: databaseUrl,
      FASTAPI_ENV: process.env['FASTAPI_ENV'] ?? 'development',
      // Historical, otherwise valid lockfiles frequently predate npm 7's
      // strict peer-dependency resolver. The deterministic test sandbox cares
      // about installing the pinned dependency graph and then running tests;
      // it must not turn an ERESOLVE compatibility warning into a code retry.
      NPM_CONFIG_LEGACY_PEER_DEPS: process.env['AGENT_WORKSPACE_NPM_LEGACY_PEER_DEPS'] ?? 'true',
    };
  }

  // ── Execute ───────────────────────────────────────────────────
  const start = Date.now();
  const proc = spawn('sh', ['-c', executionCommand], {
    cwd,
    // POSIX-only: creates a process group that can be terminated as a unit.
    detached: process.platform !== 'win32',
    // Server-owned profile values win over caller-provided values.
    env: buildChildEnv({ ...extraEnv, ...profileEnv }),
  });

  const stdoutBufs: Buffer[] = [];
  const stderrBufs: Buffer[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;
  let truncated = false;
  let timedOut  = false;

  proc.stdout.on('data', (chunk: Buffer) => {
    if (stdoutLen < MAX_OUT_BYTES) {
      stdoutBufs.push(chunk);
      stdoutLen += chunk.length;
    } else {
      truncated = true;
    }
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    if (stderrLen < MAX_OUT_BYTES) {
      stderrBufs.push(chunk);
      stderrLen += chunk.length;
    } else {
      truncated = true;
    }
  });

  const processResult = await waitForChildProcess(proc, timeoutSec * 1000);
  const exitCode = processResult.exitCode;
  timedOut = processResult.timedOut;

  const stdout = clampOutput(stdoutBufs, stdoutLen);
  const stderr = clampOutput(stderrBufs, stderrLen);
  const durationMs = Date.now() - start;

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    audit: 'exec',
    cmd_prefix: redactCommandForAudit(executionCommand),
    exit_code: exitCode,
    duration_ms: durationMs,
    timed_out: timedOut,
  }));

  res.json({
    stdout: stdout.text,
    stderr: stderr.text,
    exit_code: exitCode,
    duration_ms: durationMs,
    timed_out: timedOut,
    truncated: truncated || stdout.truncated || stderr.truncated,
  });
});
