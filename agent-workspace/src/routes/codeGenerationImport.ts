import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { codegenBytesHash, codegenPath, parseCodegenFiles, type CodegenFile } from './codeGenerationContract.js';
import { assertCodegenImportIdle } from './codeGenerationBarrier.js';

/** Synchronous, stopped-worker import. Never extract a tar or follow a symlink.
 * Partial failure remains behind a durable application intent and cannot retry.
 * Callers retain original bytes outside the checkout for operator recovery. */
export function importCodegenFiles(root: string, files: CodegenFile[], expectedSource: (stagedPaths?: readonly string[]) => void): void {
  assertCodegenImportIdle();
  if (!files.length || files.length > 64) throw Error('codegen_outputs_invalid');
  parseCodegenFiles(files, { version: 1, summary: '', setup: '', start: '', generate: '', outputPaths: files.map(f => f.path) });
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw Error('codegen_unsafe_checkout');
  expectedSource();
  const staged: Array<{ target: string; temp: string; before: string | null; sha256: string; ino: number; dev: number }> = [];
  const read = (target: string) => {
    try {
      const st = lstatSync(target);
      if (!st.isFile() || st.nlink !== 1 || realpathSync(target) !== target) throw Error('codegen_unsafe_target');
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const current = fstatSync(fd); if (current.ino !== st.ino || current.dev !== st.dev || current.nlink !== 1) throw Error('codegen_source_changed'); return codegenBytesHash(readFileSync(fd)); }
      finally { closeSync(fd); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  };
  try {
    for (const file of files) {
      if (!codegenPath(file.path)) throw Error('codegen_scope_invalid');
      let parent = root;
      for (const part of file.path.split('/').slice(0, -1)) {
        parent = path.join(parent, part);
        try { mkdirSync(parent, { mode: 0o755 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) throw Error('codegen_unsafe_target');
      }
      const target = path.join(root, file.path);
      if (read(target) !== file.beforeSha256) throw Error('codegen_source_changed');
      const temp = path.join(parent, '.argus-codegen-' + randomUUID());
      const mode = file.beforeSha256 === null ? 0o644 : lstatSync(target).mode & 0o777;
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      const identity = fstatSync(fd);
      staged.push({ target, temp, before: file.beforeSha256, sha256: file.sha256, ino: identity.ino, dev: identity.dev });
      try { writeFileSync(fd, Buffer.from(file.content, 'base64')); fsyncSync(fd); } finally { closeSync(fd); }
    }
    // Only files created by this invocation are absent from the original source.
    // Never ignore a filename prefix globally: other hidden inputs remain bound.
    expectedSource(staged.map(file => file.temp));
    for (const file of staged) {
      const identity = lstatSync(file.temp);
      if (identity.ino !== file.ino || identity.dev !== file.dev || read(file.temp) !== file.sha256)
        throw Error('codegen_staged_file_changed');
    }
    for (const file of staged) {
      if (read(file.target) !== file.before || realpathSync(path.dirname(file.target)) !== path.dirname(file.target)) throw Error('codegen_source_changed');
      renameSync(file.temp, file.target);
      const dir = openSync(path.dirname(file.target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  } finally {
    for (const file of staged) { try { unlinkSync(file.temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  }
}
