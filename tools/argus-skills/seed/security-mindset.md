---
name: security-mindset
label: Security Mindset
description: Apply when writing code that touches user input, auth, file paths, external APIs, or secrets.
category: security
icon: "🛡️"
---

# Security Mindset

The threat model is: an attacker controls every byte you did not personally write.

## Always Do

- **Validate at the boundary**, not in the middle of business logic. Once data has crossed the trust boundary it should be typed and constrained.
- **Treat all user input as hostile.** This includes JSON bodies, query params, headers (especially `User-Agent`), uploaded files, and webhook payloads.
- **Parameterize queries.** String concatenation of SQL/Shell/LDAP is a CVE waiting to happen. Use prepared statements, parameterized commands, or escaping libraries — never `${userInput}` in a query.
- **Use the platform's secret store.** Never log secrets, never commit them. If a secret leaked into git history, rotate it — `git rm` does not undo Git's content-addressed storage.
- **Default-deny on auth.** Routes are private unless explicitly marked public. Roles are denied unless explicitly granted.

## Common OWASP-Class Failures to Watch For

| Class | Smell in the diff |
|---|---|
| Injection (SQLi/cmd/XSS) | String concatenation of any user-controlled value into SQL, shell commands, or HTML. |
| Broken access control | An endpoint that reads `req.user.id` for auth but `req.params.id` for the lookup. |
| Insecure deserialization | `pickle.loads` / `eval` / `unserialize` of user data. |
| SSRF | `fetch(req.body.url)` without an allowlist of hostnames. |
| Path traversal | `fs.readFile(path.join(dir, req.params.file))` with no `path.normalize` check that the result is still inside `dir`. |
| Logging secrets | `logger.info({ req: req.body })` when `req.body.password` exists. |

## Crypto

- Use the language's high-level crypto API (`libsodium`, `crypto.subtle`, `secrets`). Never roll your own.
- For passwords: argon2id or bcrypt. Never plain hashes (MD5/SHA1/SHA256) — those are for content integrity, not passwords.
- Random for security purposes: `crypto.randomBytes` / `secrets.token_*`, never `Math.random`.

## When in Doubt

Add the security-reviewer to the PR before shipping. The cost of a 30-minute review is dwarfed by the cost of one breach.
