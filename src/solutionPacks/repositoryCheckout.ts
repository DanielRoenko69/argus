import type pg from 'pg';

/** Metadata only: never load or decrypt repository credentials for preflight. */
export async function repositoryCheckoutBlocker(pool: pg.Pool, bundleIds: number[], repository?: string): Promise<string | null> {
  const result = await pool.query<{
    backend_id: number; backend_name: string; base_url: string; config: Record<string, unknown>;
  }>(`SELECT DISTINCT b.id AS backend_id, b.name AS backend_name, b.base_url, b.config
        FROM mcp_backend_bundles bb JOIN mcp_backends b ON b.id = bb.backend_id
       WHERE bb.bundle_id = ANY($1::int[]) AND b.enabled = true`, [bundleIds]);
  const targets = new Map<string, string>();
  for (const row of result.rows) {
    const c = row.config ?? {};
    const explicit = String(c['kind'] ?? '').toLowerCase();
    const kind = ['gitea', 'github', 'bitbucket'].includes(explicit) ? explicit
      : ['gitea', 'bitbucket', 'github'].find(value => row.backend_name.toLowerCase().includes(value));
    if (!kind) continue;
    const owner = kind === 'bitbucket' && c['user_slug']
      ? `~${String(c['user_slug'])}` : String(c['project_key'] ?? c['owner'] ?? c['user_slug'] ?? '').trim();
    const repo = String(c['repo_slug'] ?? c['repo'] ?? '').trim();
    if (!owner || !repo || !row.base_url) continue;
    const name = `${owner}/${repo}`;
    // Keep host/path/provider in identity: equal names on different servers are ambiguous.
    targets.set(`${kind}:${row.base_url.replace(/\/+$/, '')}:${name}`, name);
  }
  if (targets.size > 1) return 'Selected bundles contain multiple Git checkout targets. Select bundles for exactly one repository before starting.';
  if (targets.size === 0) return 'Selected bundles contain no concrete Git checkout target.';
  if (repository?.trim() && ![...targets.values()].includes(repository.trim().replace(/\.git$/, ''))) {
    return 'The repository input does not match the selected Git checkout bundle. Correct the repository or select its bundle.';
  }
  return null;
}
