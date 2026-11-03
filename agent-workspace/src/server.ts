/**
 * agent-workspace HTTP sidecar
 *
 * Exposes /exec, /read, /write, /edit, /ls endpoints used by the Argus Dev Agent.
 * All non-health endpoints require X-Workspace-Secret header matching the
 * WORKSPACE_SECRET env var.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { timingSafeEqual } from 'node:crypto';
import { execRouter } from './routes/exec.js';
import { filesRouter } from './routes/files.js';
import { codexRouter } from './routes/codex.js';
import { codexEvaluationRouter } from './routes/codexEvaluation.js';
import { claudeRouter } from './routes/claude.js';
import { runtimeAuthRouter } from './routes/runtimeAuth.js';
import { codeIndexRouter } from './routes/codeIndex.js';
import { technicalExperimentRouter } from './routes/technicalExperiment.js';
import { qaTestsRouter } from './routes/qaTests.js';
import { stackTestsRouter } from './routes/stackTests.js';
import { codeGenerationRouter } from './routes/codeGeneration.js';
import { trackWorkspaceWrites } from './routes/codeGenerationBarrier.js';
import { gitRemoteRouter } from './routes/gitRemote.js';

const PORT   = parseInt(process.env['PORT']             ?? '3001', 10);
const SECRET = process.env['WORKSPACE_SECRET']          ?? '';

// Codex and Claude turns may legitimately use the full 30-minute runtime
// budget. Node's five-minute requestTimeout otherwise closes the authenticated
// Core -> workspace bridge while the SDK is still working, which the runtime
// correctly reports as request_disconnected. Keep the HTTP envelope slightly
// wider than the bounded runtime; the per-run AbortController remains the
// authoritative execution deadline.
const RUNTIME_HTTP_TIMEOUT_MS = 1_830_000;

if (!SECRET || SECRET.length < 16) {
  console.error(JSON.stringify({
    level: 'fatal',
    msg: 'WORKSPACE_SECRET must be set (>= 16 chars)',
  }));
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '256kb' }));

// ── Logging ────────────────────────────────────────────────────────
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    }));
  });
  next();
});

// ── Healthcheck (no auth) ──────────────────────────────────────────
app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ── Auth middleware ────────────────────────────────────────────────
function requireSecret(req: Request, res: Response, next: NextFunction): void {
  const provided = req.header('x-workspace-secret') ?? '';
  const expected = SECRET;
  if (provided.length !== expected.length) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (!timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

app.use(trackWorkspaceWrites);
app.use('/code-generation', requireSecret, codeGenerationRouter);
app.use('/exec', requireSecret, execRouter);
app.use('/git', requireSecret, gitRemoteRouter);
app.use('/codex', requireSecret, codexRouter);
app.use('/codex-evaluation', requireSecret, codexEvaluationRouter);
app.use('/claude', requireSecret, claudeRouter);
app.use('/runtime-auth', requireSecret, runtimeAuthRouter);
app.use('/code-index', requireSecret, codeIndexRouter);
app.use('/technical-experiments', requireSecret, technicalExperimentRouter);
app.use('/qa-tests', requireSecret, qaTestsRouter);
app.use('/stack-tests', requireSecret, stackTestsRouter);
app.use(requireSecret, filesRouter);  // /read, /write, /edit, /ls defined inside the router

// ── Global error handler ───────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : 'internal error';
  console.error(JSON.stringify({ level: 'error', err: msg }));
  if (!res.headersSent) res.status(500).json({ error: msg });
});

const server = app.listen(PORT, () => {
  console.log(JSON.stringify({
    level: 'info',
    msg: `agent-workspace API listening on :${PORT}`,
  }));
});

server.requestTimeout = RUNTIME_HTTP_TIMEOUT_MS;
