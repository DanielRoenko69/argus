/**
 * Short-lived, UI-driven authentication sessions for subscription runtimes.
 *
 * The CLI process owns all OAuth/device flow state. This router exposes only
 * an allowlisted verification URL, a one-time display code where applicable,
 * and lifecycle state. Raw CLI output and resulting credentials never cross
 * the workspace boundary.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';

export const runtimeAuthRouter = Router();

export type RuntimeAuthProvider = 'codex' | 'claude-code';
export type RuntimeAuthState =
  | 'starting'
  | 'waiting_for_user'
  | 'code_submitted'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'expired';

export interface RuntimeAuthSession {
  id: string;
  provider: RuntimeAuthProvider;
  state: RuntimeAuthState;
  verificationUri: string | null;
  userCode: string | null;
  requiresCodeSubmission: boolean;
  message: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  error?: string;
}

type InternalRuntimeAuthSession = RuntimeAuthSession & {
  child: ChildProcessWithoutNullStreams;
  rawOutput: string;
  timeout: NodeJS.Timeout;
  cancelRequested: boolean;
};

const CODEX_BINARY = process.env['ARGUS_CODEX_BINARY'] || '/app/node_modules/.bin/codex';
const CLAUDE_BINARY = process.env['ARGUS_CLAUDE_BINARY'] || '/usr/local/bin/claude';
const CODEX_HOME = process.env['CODEX_HOME'] || '/home/node/.codex';
const CLAUDE_HOME = process.env['CLAUDE_HOME'] || '/home/node/.claude';
const SESSION_LIFETIME_MS = 16 * 60_000;
const TERMINAL_RETENTION_MS = 15 * 60_000;
const MAX_CAPTURE_CHARS = 128_000;
const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const sessions = new Map<string, InternalRuntimeAuthSession>();

function nowIso(): string {
  return new Date().toISOString();
}

function terminal(state: RuntimeAuthState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'expired';
}

function publicSession(session: InternalRuntimeAuthSession): RuntimeAuthSession {
  const { child: _child, rawOutput: _rawOutput, timeout: _timeout, cancelRequested: _cancelRequested, ...safe } = session;
  return safe;
}

function pruneSessions(): void {
  const cutoff = Date.now() - TERMINAL_RETENTION_MS;
  for (const [id, session] of sessions) {
    if (terminal(session.state) && Date.parse(session.updatedAt) < cutoff) sessions.delete(id);
  }
}

function authEnvironment(provider: RuntimeAuthProvider): Record<string, string> {
  const home = process.env['HOME'] || '/home/node';
  const common = {
    HOME: home,
    PATH: process.env['PATH'] || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: process.env['LANG'] || 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
  if (provider === 'codex') return { ...common, CODEX_HOME };
  return {
    ...common,
    CLAUDE_HOME,
    DISABLE_AUTOUPDATER: '1',
    // The workspace container has no browser. Claude still prints the secure
    // fallback URL and waits for the code returned by that browser flow.
    BROWSER: '/bin/false',
  };
}

function safeVerificationUri(provider: RuntimeAuthProvider, candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') return null;
    if (provider === 'codex') {
      return parsed.hostname === 'auth.openai.com' && parsed.pathname === '/codex/device'
        ? parsed.toString()
        : null;
    }
    return (parsed.hostname === 'claude.com' || parsed.hostname === 'platform.claude.com')
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function parseRuntimeAuthOutput(
  provider: RuntimeAuthProvider,
  output: string,
): Pick<RuntimeAuthSession, 'verificationUri' | 'userCode'> {
  const clean = output.replace(ANSI_PATTERN, '');
  const candidates = clean.match(/https:\/\/[^\s<>"']+/g) ?? [];
  const verificationUri = candidates
    .map(candidate => candidate.replace(/[),.;]+$/, ''))
    .map(candidate => safeVerificationUri(provider, candidate))
    .find((candidate): candidate is string => Boolean(candidate)) ?? null;
  const userCode = provider === 'codex'
    ? clean.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/)?.[0] ?? null
    : null;
  return { verificationUri, userCode };
}

export function normalizeRuntimeAuthCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  if (code.length < 4 || code.length > 4096 || /[\u0000-\u001F\u007F]/.test(code)) return null;
  return code;
}

function updateFromOutput(session: InternalRuntimeAuthSession, chunk: Buffer | string): void {
  session.rawOutput = `${session.rawOutput}${chunk.toString()}`.slice(-MAX_CAPTURE_CHARS);
  const parsed = parseRuntimeAuthOutput(session.provider, session.rawOutput);
  if (parsed.verificationUri) session.verificationUri = parsed.verificationUri;
  if (parsed.userCode) session.userCode = parsed.userCode;
  if (session.verificationUri || session.userCode) {
    session.state = 'waiting_for_user';
    session.message = session.provider === 'codex'
      ? 'Open the sign-in page and enter the one-time code.'
      : 'Open the sign-in page, complete authentication and paste the returned code here.';
  }
  session.updatedAt = nowIso();
}

function finishSession(session: InternalRuntimeAuthSession, code: number | null): void {
  clearTimeout(session.timeout);
  if (session.cancelRequested || terminal(session.state)) return;
  session.updatedAt = nowIso();
  if (code === 0) {
    session.state = 'completed';
    session.message = 'Runtime authentication completed.';
    return;
  }
  session.state = 'failed';
  session.message = 'Runtime authentication failed.';
  session.error = 'The runtime CLI did not accept the authentication flow. Start a new session and try again.';
}

function stopChild(session: InternalRuntimeAuthSession): void {
  if (session.child.exitCode !== null || session.child.killed) return;
  session.child.kill('SIGTERM');
  const forceStop = setTimeout(() => {
    if (session.child.exitCode === null) session.child.kill('SIGKILL');
  }, 2_000);
  forceStop.unref();
}

function startSession(provider: RuntimeAuthProvider, sso: boolean): { session: RuntimeAuthSession; created: boolean } {
  pruneSessions();
  const active = [...sessions.values()].find(item => item.provider === provider && !terminal(item.state));
  if (active) return { session: publicSession(active), created: false };

  const enabled = provider === 'codex'
    ? process.env['ARGUS_CODEX_ENABLED'] === 'true'
    : process.env['ARGUS_CLAUDE_ENABLED'] === 'true';
  if (!enabled) throw Object.assign(new Error(`${provider} runtime is disabled`), { statusCode: 409 });

  const binary = provider === 'codex' ? CODEX_BINARY : CLAUDE_BINARY;
  const args = provider === 'codex'
    ? ['login', '--device-auth']
    : ['auth', 'login', sso ? '--sso' : '--claudeai'];
  const child = spawn(binary, args, {
    cwd: '/workspace',
    env: authEnvironment(provider),
    stdio: 'pipe',
  });
  const startedAt = nowIso();
  const id = randomUUID();
  const session: InternalRuntimeAuthSession = {
    id,
    provider,
    state: 'starting',
    verificationUri: null,
    userCode: null,
    requiresCodeSubmission: provider === 'claude-code',
    message: 'Starting secure runtime authentication…',
    startedAt,
    updatedAt: startedAt,
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
    child,
    rawOutput: '',
    cancelRequested: false,
    timeout: setTimeout(() => undefined, SESSION_LIFETIME_MS),
  };
  clearTimeout(session.timeout);
  session.timeout = setTimeout(() => {
    if (terminal(session.state)) return;
    session.state = 'expired';
    session.message = 'The authentication session expired.';
    session.error = 'Start a new sign-in session.';
    session.updatedAt = nowIso();
    stopChild(session);
  }, SESSION_LIFETIME_MS);
  session.timeout.unref();
  sessions.set(id, session);

  child.stdout.on('data', chunk => updateFromOutput(session, chunk));
  child.stderr.on('data', chunk => updateFromOutput(session, chunk));
  child.once('error', () => {
    if (terminal(session.state)) return;
    clearTimeout(session.timeout);
    session.state = 'failed';
    session.message = 'Runtime authentication could not start.';
    session.error = 'The configured runtime CLI is unavailable.';
    session.updatedAt = nowIso();
  });
  child.once('close', code => finishSession(session, code));
  return { session: publicSession(session), created: true };
}

function providerFrom(value: unknown): RuntimeAuthProvider | null {
  return value === 'codex' || value === 'claude-code' ? value : null;
}

function loadSession(provider: RuntimeAuthProvider, id: string): InternalRuntimeAuthSession | null {
  if (!SESSION_ID_PATTERN.test(id)) return null;
  const session = sessions.get(id);
  return session?.provider === provider ? session : null;
}

runtimeAuthRouter.post('/:provider/sessions', (req: Request, res: Response) => {
  const provider = providerFrom(req.params['provider']);
  if (!provider) { res.status(404).json({ error: 'Unsupported runtime provider' }); return; }
  try {
    const result = startSession(provider, req.body?.sso === true);
    res.status(result.created ? 201 : 200).json(result.session);
  } catch (error) {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode) || 500;
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Runtime authentication could not start' });
  }
});

runtimeAuthRouter.get('/:provider/sessions/:sessionId', (req: Request, res: Response) => {
  const provider = providerFrom(req.params['provider']);
  const session = provider ? loadSession(provider, String(req.params['sessionId'] ?? '')) : null;
  if (!session) { res.status(404).json({ error: 'Runtime authentication session not found' }); return; }
  res.json(publicSession(session));
});

runtimeAuthRouter.post('/:provider/sessions/:sessionId/code', (req: Request, res: Response) => {
  const provider = providerFrom(req.params['provider']);
  const session = provider ? loadSession(provider, String(req.params['sessionId'] ?? '')) : null;
  if (!session) { res.status(404).json({ error: 'Runtime authentication session not found' }); return; }
  if (provider !== 'claude-code' || terminal(session.state)) {
    res.status(409).json({ error: 'This authentication session does not accept a code' });
    return;
  }
  const code = normalizeRuntimeAuthCode(req.body?.code);
  if (!code) { res.status(400).json({ error: 'Authentication code is invalid' }); return; }
  if (!session.child.stdin.writable) {
    res.status(409).json({ error: 'The runtime CLI is no longer waiting for an authentication code' });
    return;
  }
  try {
    session.child.stdin.write(`${code}\n`);
  } catch {
    res.status(409).json({ error: 'The runtime CLI did not accept the authentication code' });
    return;
  }
  session.state = 'code_submitted';
  session.message = 'Authentication code submitted. Waiting for Claude Code…';
  session.updatedAt = nowIso();
  res.status(202).json(publicSession(session));
});

runtimeAuthRouter.delete('/:provider/sessions/:sessionId', (req: Request, res: Response) => {
  const provider = providerFrom(req.params['provider']);
  const session = provider ? loadSession(provider, String(req.params['sessionId'] ?? '')) : null;
  if (!session) { res.status(404).json({ error: 'Runtime authentication session not found' }); return; }
  if (!terminal(session.state)) {
    session.cancelRequested = true;
    session.state = 'canceled';
    session.message = 'Runtime authentication canceled.';
    session.updatedAt = nowIso();
    clearTimeout(session.timeout);
    stopChild(session);
  }
  res.json(publicSession(session));
});
