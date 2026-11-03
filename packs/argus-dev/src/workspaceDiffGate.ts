export interface WorkspaceDiffGateFailure {
  passed: false;
  output: string;
}

/** Preserve individual paths for files created below a wholly new directory. */
export const WORKSPACE_GIT_STATUS_COMMAND = 'git status --porcelain --untracked-files=all';

function changedPaths(statusOutput: string): Set<string> {
  return new Set(statusOutput.split(/\r?\n/).flatMap(line => {
    if (line.length < 4) return [];
    const raw = line.slice(3).trim();
    if (!raw) return [];
    const path = raw.includes(' -> ') ? raw.split(' -> ').at(-1)! : raw;
    return [path.replace(/^"|"$/g, '')];
  }));
}

/** Extract deterministic repository-relative file targets named by a ticket. */
export function extractTicketFileTargets(description: string): string[] {
  const matches = description.matchAll(
    /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),.:;])/g,
  );
  const targets = [...matches].flatMap(match => {
    const path = match[1]!;
    if (path.startsWith('/')) return [];

    // A named path is not necessarily a requested change. Scope negation to
    // the current sentence/line so clauses such as "do not create ... or
    // src/index.js" cannot turn a forbidden file into a required diff target.
    const beforePath = description.slice(0, match.index ?? 0);
    const clause = beforePath.split(/[.!?\n]/).at(-1)?.toLowerCase() ?? '';
    if (/\b(?:do not|don't|must not|never|without)\b/.test(clause)) return [];

    return [path];
  });
  return [...new Set(targets)].slice(0, 32);
}

/**
 * Fail before invoking the test agent when the Coder did not change anything.
 * Callers use `git status --porcelain --untracked-files=all` so a wholly new
 * directory expands to individual paths instead of collapsing to `?? docs/`.
 * This also accepts newly created tests that are not staged yet.
 */
export function evaluateWorkspaceDiffStatus(
  statusOutput: string,
  requiredPaths: readonly string[] = [],
): WorkspaceDiffGateFailure | null {
  if (statusOutput.trim().length > 0) {
    const changed = changedPaths(statusOutput);
    const missing = requiredPaths.filter(path => !changed.has(path));
    if (missing.length === 0) return null;
    return {
      passed: false,
      output:
        `REQUIRED_FILES_UNCHANGED: The ticket explicitly requires changes to: ${missing.join(', ')}. ` +
        'Implement those files and their tests before running the test suite.',
    };
  }

  return {
    passed: false,
    output:
      'NO_WORKSPACE_DIFF: The Coder completed without changing any files. ' +
      'Retry the implementation and use workspace_write before running tests.',
  };
}
