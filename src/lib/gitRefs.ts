/**
 * Strict Git branch-name allowlist shared by Core input boundaries.
 *
 * Branch values supplied to Argus.Dev workflows end up in Git commands inside
 * the agent workspace. The Argus Dev Pack (packs/argus-dev) additionally
 * shell-quotes every ref at its execution sink.
 */

export const GIT_REF_INPUT_FIELDS: ReadonlySet<string> = new Set(['source_branch', 'branch_name']);

const GIT_REF_MAX_LENGTH = 200;
const GIT_REF_CHARSET = /^[A-Za-z0-9._/-]+$/;

export function isSafeGitRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > GIT_REF_MAX_LENGTH) return false;
  if (!GIT_REF_CHARSET.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false;
  if (value.endsWith('.') || value.endsWith('.lock')) return false;
  if (value.includes('..') || value.includes('//')) return false;
  return value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Returns the first input field holding an invalid branch name, if any. */
export function findInvalidGitRefField(input: Record<string, unknown>): string | null {
  for (const field of GIT_REF_INPUT_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (!isSafeGitRef(typeof value === 'string' ? value.trim() : value)) return field;
  }
  return null;
}
