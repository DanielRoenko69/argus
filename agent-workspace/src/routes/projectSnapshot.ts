/** Read-only project inputs for workspace-session tests, NOT write authority.
 * Keep the controller's project_snapshot.py predicate in sync (shared fixtures).
 * Git selects tracked/non-ignored files; runtime homes are never traversed.
 */
const excluded = new Set(['.git', '.hg', '.svn', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.codex', '.claude',
  '.docker', '.terraform', '.venv', 'venv', 'node_modules', '__pycache__', 'graphify-out', 'secrets', '.secrets',
  'credentials', '.credentials', '.netrc', '_netrc', '.git-credentials', 'auth.json', 'credentials.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'kubeconfig']);
export function projectSnapshotPathAllowed(file: string, mode = '100644'): boolean {
  if (!['100644', '100755'].includes(mode) || !file || file.length > 400 || /[\\\x00-\x1f\x7f]/.test(file)) return false;
  const parts = file.toLowerCase().split('/');
  return parts.every(p => p && p !== '.' && p !== '..' && !excluded.has(p)
    && (!/^\.env(?:\.|$)/.test(p) || /^\.env\.(?:example|sample|template)$/.test(p))
    && !/\.(?:pem|key|p12|pfx|jks|keystore)$/.test(p))
    && !/(?:^|\/)\.config\/(?:gcloud|gh|hub|aws|azure)(?:\/|$)/.test(parts.join('/'));
}

/** Reject recognizable credential material, never redact/change source bytes. */
export function assertProjectSnapshotContent(file: string, content: Buffer): void {
  const text = content.toString('utf8');
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})/.test(text))
    throw Error('project_snapshot_sensitive_content');
  if (/(?:^|\/)(?:\.npmrc|\.pypirc|pip\.conf|\.yarnrc\.yml|\.gitmodules)$/i.test(file)) {
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*[#;]/.test(line)) continue;
      const match = /(?:_authToken|_auth|password|passwd|token|npmAuthToken|npmAuthIdent)\s*[:=]\s*(.*)/i.exec(line);
      if (match && match[1]!.trim() && !/^['"]?\$\{[A-Z_][A-Z0-9_]*\}['"]?$/.test(match[1]!.trim()))
        throw Error('project_snapshot_sensitive_content');
      if (/https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(line)) throw Error('project_snapshot_sensitive_content');
    }
  }
}
