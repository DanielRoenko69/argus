import { parseFileScope } from './developmentContract.js';

// Keep the trusted Showcase repository CI guard in sync (contract-tested in Core).
export const PROTECTED_DEVELOPMENT_PATH = '(^|/)(\\.[^/]+|AGENTS\\.md|CLAUDE\\.md|GEMINI\\.md|Jenkinsfile[^/]*|Dockerfile[^/]*|docker-compose[^/]*|compose[^/]*\\.ya?ml|Makefile|setup\\.(py|cfg)|pyproject\\.toml|pytest\\.ini|tox\\.ini|conftest\\.py|requirements[^/]*|constraints[^/]*|package[^/]*\\.json|[^/]*lock[^/]*|pom\\.xml|build\\.gradle[^/]*|Cargo\\.toml|go\\.mod|[^/]*\\.(pem|key|p12|pfx))($|/)';
const protectedPath = new RegExp(PROTECTED_DEVELOPMENT_PATH, 'i');
export const REPOSITORY_SCOPE_INSTRUCTION = 'The selected repository is the boundary. Choose the necessary implementation and regression-test files yourself unless an exact file list narrows the scope. Do not edit hidden files/directories, agent policies, credentials, CI/Docker/build/dependency configuration or test-runner configuration (including conftest.py). Those require a separately reviewed configuration change. Do not delete or weaken existing tests, or change product behavior solely to make tests pass. Report blockers instead. Do not commit, push, approve or merge.';

/** Inspect both sides of renames; reject quoted/ambiguous names instead of decoding shell escapes. */
export function repositoryScopeViolations(status: string, allowedFiles: string): string[] {
  const allowed = parseFileScope(allowedFiles);
  const violations = new Set<string>();
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    if (line.length < 4 || !/^[ MADRCU?!]{2} /.test(line)) { violations.add('unverifiable Git status'); continue; }
    for (const path of line.slice(3).split(' -> ')) {
      if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')
        || protectedPath.test(path) || (allowed.length > 0 && !allowed.includes(path))
        || ((line.slice(0, 2).includes('D') || (line.slice(0, 2).includes('R') && path === line.slice(3).split(' -> ')[0]))
          && /(^|\/)(tests?|__tests__)(\/|$)/i.test(path))) violations.add(path);
    }
  }
  return [...violations];
}
