/**
 * File operations on /workspace — read, write, edit, ls.
 * All paths must resolve under /workspace.
 */

import { Router, type Request, type Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

export const filesRouter = Router();

const MAX_READ_BYTES  = 1024 * 1024;  // 1 MB
const MAX_WRITE_BYTES = 256 * 1024;   // body limit already 256kb in server.ts

function validateWorkspacePath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return null;
  const resolved = path.resolve(p);
  if (resolved !== '/workspace' && !resolved.startsWith('/workspace/')) return null;
  return resolved;
}

interface ReadBody  { path?: unknown; encoding?: unknown; scope_root?: unknown }
interface WriteBody { path?: unknown; content?: unknown; encoding?: unknown; scope_root?: unknown }
interface EditBody {
  path?: unknown;
  old_text?: unknown;
  new_text?: unknown;
  replace_all?: unknown;
  scope_root?: unknown;
}

export function applyExactTextEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): { content: string; replacements: number } {
  if (!oldText) throw new Error('old_text must be a non-empty string');
  const matches = content.split(oldText).length - 1;
  if (matches === 0) throw new Error('old_text was not found; re-read the file before editing');
  if (!replaceAll && matches !== 1) {
    throw new Error(`old_text matched ${matches} locations; provide a unique block or set replace_all=true`);
  }
  return {
    content: replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText),
    replacements: replaceAll ? matches : 1,
  };
}

function validateScopeRoot(value: unknown): string | null {
  if (value === undefined) return '/workspace';
  if (typeof value !== 'string') return null;
  const resolved = path.resolve(value);
  if (!/^\/workspace\/[^/]+$/.test(resolved)) return null;
  return resolved;
}

function insideScope(target: string, scopeRoot: string): boolean {
  return target === scopeRoot || target.startsWith(`${scopeRoot}/`);
}

async function assertRealPathInScope(target: string, scopeRoot: string, allowMissingLeaf = false): Promise<boolean> {
  try {
    const rootReal = await fs.realpath(scopeRoot);
    let candidate = target;
    if (allowMissingLeaf) {
      try {
        candidate = await fs.realpath(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        candidate = path.join(await fs.realpath(path.dirname(target)), path.basename(target));
      }
    } else {
      candidate = await fs.realpath(target);
    }
    return insideScope(candidate, rootReal);
  } catch {
    return false;
  }
}

async function assertWritePathInScope(target: string, scopeRoot: string): Promise<boolean> {
  try {
    const rootReal = await fs.realpath(scopeRoot);
    let candidate = target;

    // Validate the nearest existing ancestor before mkdir follows any symlink.
    // The target itself is checked first so an existing symlink cannot be
    // replaced through a scoped write either.
    for (;;) {
      try {
        const candidateReal = await fs.realpath(candidate);
        return insideScope(candidateReal, rootReal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        const parent = path.dirname(candidate);
        if (parent === candidate) return false;
        candidate = parent;
      }
    }
  } catch {
    return false;
  }
}

// ── POST /read ────────────────────────────────────────────────────
filesRouter.post('/read', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ReadBody;
  const target = validateWorkspacePath(body.path);
  const scopeRoot = validateScopeRoot(body.scope_root);
  if (!target || !scopeRoot || !insideScope(target, scopeRoot)) {
    res.status(400).json({ error: 'path must be inside the requested workspace scope' });
    return;
  }
  const encoding: 'utf-8' | 'base64' = body.encoding === 'base64' ? 'base64' : 'utf-8';

  try {
    if (!await assertRealPathInScope(target, scopeRoot)) {
      res.status(403).json({ error: 'path escapes the requested workspace scope' });
      return;
    }
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      res.status(400).json({ error: 'path is not a regular file' });
      return;
    }
    if (stat.size > MAX_READ_BYTES) {
      res.status(413).json({ error: `file exceeds ${MAX_READ_BYTES} bytes` });
      return;
    }
    const content = await fs.readFile(target, { encoding });
    res.json({ content, size_bytes: stat.size, encoding });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : 'read failed' });
  }
});

// ── POST /write ───────────────────────────────────────────────────
filesRouter.post('/write', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as WriteBody;
  const target = validateWorkspacePath(body.path);
  const scopeRoot = validateScopeRoot(body.scope_root);
  if (!target || !scopeRoot || !insideScope(target, scopeRoot)) {
    res.status(400).json({ error: 'path must be inside the requested workspace scope' });
    return;
  }
  if (target === '/workspace') {
    res.status(400).json({ error: 'cannot write to /workspace itself (must be a file path)' });
    return;
  }
  if (typeof body.content !== 'string') {
    res.status(400).json({ error: 'content must be a string' });
    return;
  }
  const encoding: 'utf-8' | 'base64' = body.encoding === 'base64' ? 'base64' : 'utf-8';
  const buf = Buffer.from(body.content, encoding);
  if (buf.length > MAX_WRITE_BYTES) {
    res.status(413).json({ error: `content exceeds ${MAX_WRITE_BYTES} bytes` });
    return;
  }

  try {
    if (!await assertWritePathInScope(target, scopeRoot)) {
      res.status(403).json({ error: 'path escapes the requested workspace scope' });
      return;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (!await assertRealPathInScope(target, scopeRoot, true)) {
      res.status(403).json({ error: 'path escapes the requested workspace scope' });
      return;
    }
    const tmp = target + '.tmp.' + process.pid + '.' + Date.now();
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);
    res.json({ size_bytes: buf.length, path: target });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'write failed' });
  }
});

// ── POST /edit ────────────────────────────────────────────────────
filesRouter.post('/edit', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as EditBody;
  const target = validateWorkspacePath(body.path);
  const scopeRoot = validateScopeRoot(body.scope_root);
  if (!target || !scopeRoot || !insideScope(target, scopeRoot)) {
    res.status(400).json({ error: 'path must be inside the requested workspace scope' });
    return;
  }
  if (target === '/workspace' || typeof body.old_text !== 'string' || typeof body.new_text !== 'string') {
    res.status(400).json({ error: 'path, old_text and new_text are required strings' });
    return;
  }
  if (!body.old_text) {
    res.status(400).json({ error: 'old_text must be a non-empty string' });
    return;
  }
  if (Buffer.byteLength(body.old_text, 'utf8') + Buffer.byteLength(body.new_text, 'utf8') > MAX_WRITE_BYTES) {
    res.status(413).json({ error: `edit payload exceeds ${MAX_WRITE_BYTES} bytes` });
    return;
  }

  let tmp: string | null = null;
  try {
    if (!await assertRealPathInScope(target, scopeRoot)) {
      res.status(403).json({ error: 'path escapes the requested workspace scope' });
      return;
    }
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      res.status(400).json({ error: 'path is not a regular file' });
      return;
    }
    if (stat.size > MAX_READ_BYTES) {
      res.status(413).json({ error: `file exceeds ${MAX_READ_BYTES} bytes` });
      return;
    }
    const current = await fs.readFile(target, 'utf8');
    let edited: { content: string; replacements: number };
    try {
      edited = applyExactTextEdit(current, body.old_text, body.new_text, body.replace_all === true);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : 'edit precondition failed' });
      return;
    }
    const updated = Buffer.from(edited.content, 'utf8');
    if (updated.length > MAX_READ_BYTES) {
      res.status(413).json({ error: `edited file exceeds ${MAX_READ_BYTES} bytes` });
      return;
    }
    tmp = target + '.tmp.' + process.pid + '.' + Date.now();
    await fs.writeFile(tmp, updated);
    await fs.chmod(tmp, stat.mode & 0o777);
    await fs.rename(tmp, target);
    tmp = null;
    res.json({ size_bytes: updated.length, path: target, replacements: edited.replacements });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ error: 'file not found' });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : 'edit failed' });
  } finally {
    if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
});

// ── GET /ls ───────────────────────────────────────────────────────
filesRouter.get('/ls', async (req: Request, res: Response) => {
  const queryPath = typeof req.query['path'] === 'string' ? req.query['path'] : '/workspace';
  const target = validateWorkspacePath(queryPath);
  const scopeRoot = validateScopeRoot(req.query['scope_root']);
  if (!target || !scopeRoot || !insideScope(target, scopeRoot)) {
    res.status(400).json({ error: 'path must be inside the requested workspace scope' });
    return;
  }

  try {
    if (!await assertRealPathInScope(target, scopeRoot)) {
      res.status(403).json({ error: 'path escapes the requested workspace scope' });
      return;
    }
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries = await Promise.all(dirents.map(async (d) => {
      const full = path.join(target, d.name);
      let size_bytes = 0;
      let modified_iso = '';
      try {
        const st = await fs.stat(full);
        size_bytes = st.size;
        modified_iso = st.mtime.toISOString();
      } catch {
        // broken symlink etc. — leave defaults
      }
      const type = d.isFile()      ? 'file'
                 : d.isDirectory() ? 'dir'
                 : d.isSymbolicLink() ? 'symlink'
                 : 'other';
      return { name: d.name, type, size_bytes, modified_iso };
    }));
    res.json({ path: target, entries });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ error: 'directory not found' });
      return;
    }
    if (code === 'ENOTDIR') {
      res.status(400).json({ error: 'path is not a directory' });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : 'ls failed' });
  }
});
