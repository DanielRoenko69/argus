import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const AUDIT_RETENTION_VERIFIER_FILENAME = 'argus-audit-retention-verifier.mjs';

export async function loadAuditRetentionVerifierSource(): Promise<Buffer> {
  const candidates = [
    resolve(process.cwd(), 'assets', AUDIT_RETENTION_VERIFIER_FILENAME),
    resolve(process.cwd(), 'src', 'assets', AUDIT_RETENTION_VERIFIER_FILENAME),
  ];
  for (const candidate of candidates) {
    try {
      const source = await readFile(candidate);
      if (source.byteLength > 0 && source.byteLength <= 512 * 1024) return source;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }
  throw new Error('audit retention verifier asset is unavailable');
}
