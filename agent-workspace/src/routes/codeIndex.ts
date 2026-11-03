import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { buildChildEnv } from './exec.js';

export const codeIndexRouter = Router();

const WORKSPACE_ROOT = '/workspace';
const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const EXACT_WORKSPACE = /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\u0000]+$/;

interface WorkspaceBody {
  workspace_root?: unknown;
  branch_hint?: unknown;
}

interface SourceBody extends WorkspaceBody {
  path?: unknown;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function boundedOutput(chunks: Buffer[], total: number): string {
  return Buffer.concat(chunks, Math.min(total, MAX_PROCESS_OUTPUT_BYTES)).toString('utf8');
}

async function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> {
  const child = spawn(command, args, { cwd, env: buildChildEnv({ HOME: '/home/node' }), shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    if (stdoutBytes < MAX_PROCESS_OUTPUT_BYTES) stdout.push(chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - stdoutBytes));
    stdoutBytes += chunk.length;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBytes < MAX_PROCESS_OUTPUT_BYTES) stderr.push(chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - stderrBytes));
    stderrBytes += chunk.length;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const exitCode = await new Promise<number>(resolve => {
    child.once('close', code => resolve(code ?? -1));
    child.once('error', () => resolve(-1));
  });
  clearTimeout(timer);
  return {
    stdout: boundedOutput(stdout, stdoutBytes).trim(),
    stderr: timedOut ? 'process timed out' : boundedOutput(stderr, stderrBytes).trim(),
    exitCode,
  };
}

async function exactWorkspace(value: unknown): Promise<string | null> {
  if (typeof value !== 'string' || !EXACT_WORKSPACE.test(value)) return null;
  try {
    const real = await fs.realpath(value);
    const relative = path.relative(WORKSPACE_ROOT, real);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) return null;
    const stat = await fs.stat(real);
    return stat.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function branchHint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 255 || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

/**
 * Graphify owns generated index evidence, not the coding agent. Keep its
 * checkout-local output out of git status without changing the repository's
 * tracked .gitignore policy. Tracked files remain visible to delivery checks.
 */
export async function ensureGraphifyOutputExcluded(root: string): Promise<void> {
  const gitDirectory = await run('git', ['rev-parse', '--git-dir'], root, 15_000);
  if (gitDirectory.exitCode !== 0 || !gitDirectory.stdout) {
    throw new Error(`unable to resolve workspace Git directory: ${gitDirectory.stderr || 'git directory unavailable'}`);
  }
  const resolvedGitDirectory = await fs.realpath(path.resolve(root, gitDirectory.stdout));
  const relativeGitDirectory = path.relative(root, resolvedGitDirectory);
  if (relativeGitDirectory.startsWith('..') || path.isAbsolute(relativeGitDirectory)) {
    throw new Error('workspace Git directory escapes the exact checkout');
  }
  const infoDirectory = path.join(resolvedGitDirectory, 'info');
  const excludePath = path.join(infoDirectory, 'exclude');
  await fs.mkdir(infoDirectory, { recursive: true });
  let existing = '';
  try {
    existing = await fs.readFile(excludePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!existing.split(/\r?\n/u).includes('/graphify-out/')) {
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await fs.appendFile(excludePath, `${separator}/graphify-out/\n`, 'utf8');
  }
}

async function repositoryMetadata(root: string, hint: string | null): Promise<{
  commit_sha: string;
  branch_name: string;
  repository_key: string | null;
}> {
  const commit = await run('git', ['rev-parse', 'HEAD'], root, 15_000);
  if (commit.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit.stdout)) {
    throw new Error(`workspace is not an exact Git checkout: ${commit.stderr || 'HEAD unavailable'}`);
  }
  const branch = await run('git', ['branch', '--show-current'], root, 15_000);
  if (branch.exitCode !== 0) throw new Error(`unable to resolve Git branch: ${branch.stderr}`);
  const remote = await run('git', ['config', '--get', 'remote.origin.url'], root, 15_000);
  return {
    commit_sha: commit.stdout,
    branch_name: branch.stdout || hint || `detached-${commit.stdout.slice(0, 12)}`,
    repository_key: remote.exitCode === 0 ? repositoryKeyFromRemote(remote.stdout) : null,
  };
}

function repositoryKeyFromRemote(remote: string): string | null {
  const value = remote.trim();
  if (!value || value.length > 4_096) return null;
  let repositoryPath: string;
  try {
    if (/^[^/@\s]+@[^:/\s]+:.+/.test(value)) {
      repositoryPath = value.slice(value.indexOf(':') + 1);
    } else {
      repositoryPath = new URL(value).pathname;
    }
  } catch {
    return null;
  }
  const segments = repositoryPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments[0]?.toLowerCase() === 'scm') segments.shift();
  if (segments.length < 2) return null;
  const selected = segments.slice(-2).map((segment, index) => {
    const withoutGit = index === 1 ? segment.replace(/\.git$/i, '') : segment;
    try { return decodeURIComponent(withoutGit); } catch { return withoutGit; }
  });
  const key = selected.join('/');
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(key) ? key : null;
}

codeIndexRouter.post('/metadata', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as WorkspaceBody;
  const root = await exactWorkspace(body.workspace_root);
  if (!root) {
    res.status(400).json({ error: 'workspace_root must be one existing direct child of /workspace' });
    return;
  }
  try {
    res.json(await repositoryMetadata(root, branchHint(body.branch_hint)));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Git metadata failed' });
  }
});

codeIndexRouter.post('/graphify', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as WorkspaceBody;
  const root = await exactWorkspace(body.workspace_root);
  if (!root) {
    res.status(400).json({ error: 'workspace_root must be one existing direct child of /workspace' });
    return;
  }
  try {
    const metadata = await repositoryMetadata(root, branchHint(body.branch_hint));
    await ensureGraphifyOutputExcluded(root);
    const update = await run('graphify', ['update', '.'], root, 300_000);
    if (update.exitCode !== 0) {
      res.status(422).json({ error: 'Graphify update failed', details: update.stderr.slice(0, 2_000) });
      return;
    }
    const graphPath = path.join(root, 'graphify-out', 'graph.json');
    const stat = await fs.stat(graphPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_GRAPH_BYTES) {
      res.status(413).json({ error: `Graphify graph must contain 1-${MAX_GRAPH_BYTES} bytes` });
      return;
    }
    const graphText = await fs.readFile(graphPath, 'utf8');
    const graph = JSON.parse(graphText) as unknown;
    const version = await run('graphify', ['--version'], root, 15_000);
    res.json({
      ...metadata,
      parser_version: version.exitCode === 0 ? version.stdout.replace(/^graphify\s+/i, '') : null,
      graph,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Graphify export failed' });
  }
});

codeIndexRouter.post('/source', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as SourceBody;
  const root = await exactWorkspace(body.workspace_root);
  if (!root || typeof body.path !== 'string' || body.path.length > 4_096 || !SAFE_RELATIVE_PATH.test(body.path)) {
    res.status(400).json({ error: 'workspace_root or repository-relative path is invalid' });
    return;
  }
  try {
    const requested = path.resolve(root, body.path);
    const real = await fs.realpath(requested);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      res.status(403).json({ error: 'source path escapes the exact workspace' });
      return;
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) {
      res.status(400).json({ error: 'source path is not a regular file' });
      return;
    }
    if (stat.size > MAX_SOURCE_BYTES) {
      res.status(413).json({ error: `source file exceeds ${MAX_SOURCE_BYTES} bytes` });
      return;
    }
    const content = await fs.readFile(real);
    res.json({ content: content.toString('base64'), encoding: 'base64', size_bytes: content.byteLength });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    res.status(code === 'ENOENT' ? 404 : 500).json({ error: code === 'ENOENT' ? 'source file not found' : 'source read failed' });
  }
});
