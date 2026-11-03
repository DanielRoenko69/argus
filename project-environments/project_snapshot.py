"""Read-only workspace-session inputs; mirror projectSnapshot.ts, not write scope."""
import re

EXCLUDED = {'.git', '.hg', '.svn', '.ssh', '.aws', '.azure', '.kube', '.gnupg', '.codex', '.claude',
    '.docker', '.terraform', '.venv', 'venv', 'node_modules', '__pycache__', 'graphify-out', 'secrets', '.secrets',
    'credentials', '.credentials', '.netrc', '_netrc', '.git-credentials', 'auth.json', 'credentials.json',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'kubeconfig'}


def project_path(name):
    if not isinstance(name, str) or not 0 < len(name) <= 400 or re.search(r'[\\\x00-\x1f\x7f]', name):
        return False
    parts = name.lower().split('/')
    return all(p and p not in {'.', '..'} and p not in EXCLUDED
        and (not re.match(r'\.env(?:\.|$)', p) or re.fullmatch(r'\.env\.(?:example|sample|template)', p))
        and not re.search(r'\.(?:pem|key|p12|pfx|jks|keystore)$', p) for p in parts) \
        and not re.search(r'(?:^|/)\.config/(?:gcloud|gh|hub|aws|azure)(?:/|$)', '/'.join(parts))


def check_project_content(name, content):
    text = content.decode('utf-8', errors='replace')
    if re.search(r'-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})', text):
        raise ValueError('project_snapshot_sensitive_content')
    if re.search(r'(?:^|/)(?:\.npmrc|\.pypirc|pip\.conf|\.yarnrc\.yml|\.gitmodules)$', name, re.I):
        for line in text.splitlines():
            if re.match(r'\s*[#;]', line):
                continue
            match = re.search(r'(?:_authToken|_auth|password|passwd|token|npmAuthToken|npmAuthIdent)\s*[:=]\s*(.*)', line, re.I)
            if match and match[1].strip() and not re.fullmatch(r'''['"]?\$\{[A-Z_][A-Z0-9_]*\}['"]?''', match[1].strip()):
                raise ValueError('project_snapshot_sensitive_content')
            if re.search(r'https?://[^/\s:@]+:[^/\s@]+@', line, re.I):
                raise ValueError('project_snapshot_sensitive_content')
