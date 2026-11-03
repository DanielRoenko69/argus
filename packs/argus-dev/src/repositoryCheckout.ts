import type { GitCreds } from './state.js';

export function selectCheckoutTarget(candidates: GitCreds[], repository: string): GitCreds {
  const targets = new Map<string, GitCreds>();
  for (const creds of candidates) {
    const owner = creds.kind === 'bitbucket' && creds.user_slug ? `~${creds.user_slug}` : creds.project_key || creds.user_slug;
    targets.set(`${creds.kind}:${creds.base_url.replace(/\/+$/, '')}:${owner}/${creds.repo_slug}`, creds);
  }
  if (targets.size !== 1) throw new Error('Workspace provisioning requires exactly one Git checkout target. Review the selected bundles.');
  const target = [...targets.values()][0]!;
  const owner = target.kind === 'bitbucket' && target.user_slug ? `~${target.user_slug}` : target.project_key || target.user_slug;
  if (repository.trim() && repository.trim().replace(/\.git$/, '') !== `${owner}/${target.repo_slug}`) {
    throw new Error('Repository input does not match the selected Git checkout bundle.');
  }
  return target;
}
