import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';

export const CODEX_SANDBOX_HELPER_DIR = '/opt/argus-codex-sandbox';

/** Only Codex gets this PATH. Experiments keep their absolute /usr/bin/bwrap. */
export function codexSandboxPath(runtimePath: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const base = runtimePath || '/usr/local/bin:/usr/bin:/bin';
  return platform === 'linux' ? `${CODEX_SANDBOX_HELPER_DIR}:${base}` : base;
}

/** Fail before inference if the image lost its pinned, root-owned helper. */
export async function assertCodexSandboxHelper(): Promise<void> {
  if (process.platform !== 'linux') return;
  const binary = `${CODEX_SANDBOX_HELPER_DIR}/bwrap`;
  try {
    const [directory, file] = await Promise.all([lstat(CODEX_SANDBOX_HELPER_DIR), lstat(binary)]);
    if (!directory.isDirectory() || !file.isFile() || directory.uid !== 0 || file.uid !== 0
      || (directory.mode & 0o022) !== 0 || (file.mode & 0o022) !== 0) throw new Error('Untrusted helper');
    await access(binary, constants.X_OK);
  } catch {
    throw new Error('The version-matched Codex sandbox helper is missing or unsafe. Rebuild the Agent Workspace image; no unsandboxed fallback is allowed.');
  }
}
