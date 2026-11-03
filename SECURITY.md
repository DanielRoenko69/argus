# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's
"Report a vulnerability" form (Security → Advisories) in this repository.
If you cannot use that form, e-mail <hello.argus@proton.me> with
"SECURITY" in the subject. Do **not** open public issues, discussions or
pull requests for security problems.

Include, where possible:

- affected component, file or endpoint and the commit you tested;
- preconditions (configuration, role, enabled features);
- a minimal reproduction against a local test installation;
- the impact you observed.

Please do not test against systems you do not own or operate, and do not
access data that is not yours.

We aim to acknowledge reports within 5 business days and coordinate a fix and
disclosure timeline with you. Argus is an early, pre-1.0 project maintained by
a small team; response times are best-effort.

## Supported versions

Only the latest `main` branch receives security fixes. There are no supported
release branches yet.

## Security model (summary)

- **Deny by default** when a grant, bundle, catalog trust or scope is missing.
- **Identity:** session cookies are `HttpOnly` and `SameSite=Lax`; state-changing
  session routes additionally check `Origin`/`Referer`. Interactive SSO uses
  OIDC Authorization Code + PKCE with nonce, signed state and a one-time
  browser-binding cookie. OAuth2 bearer tokens must match the configured issuer
  and audience and map to an enabled Argus user.
- **Authorization:** role/permission checks, tenant/workspace scope and Bundle
  allowlists are evaluated server-side for every tool call; MCP sessions are
  bound to their creating credential and its current policy.
- **Secrets:** credentials are stored with AES-256-GCM field encryption
  (`DB_ENCRYPTION_KEY`, required in production) and are never returned to the
  Console. Credential-like backend default headers are encrypted and masked.
- **Egress:** outbound backend/provider URLs are checked against private,
  loopback, link-local and IPv4-embedding IPv6 ranges, including DNS
  resolution.
- **Untrusted content:** model output, tool results, repository content and
  external documents are treated as data, never as instructions.
- **Audit:** canonical audit events are hash-chained per scope with signed
  checkpoints; evidence exports are recorded before they are delivered and
  require fresh MFA.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the threat model.

## Known limitations

These are tracked and not yet resolved:

- The SSRF guard validates DNS resolution before a request but does not pin
  the validated address for the actual connection (DNS rebinding window).
- OAuth2 bearer callers are scoped to the `default` tenant/workspace; workspace
  memberships are not yet evaluated for them.
- Backend default headers stored before header encryption was introduced stay
  in plaintext until the connection is saved again.
- Legacy compliance PDF/CSV exports record their audit entry best-effort
  rather than fail-closed.
- Solution Pack task history stores the submitted A2A message verbatim. Undeclared
  input fields are rejected, but their values are not redacted from the stored
  history, so never put credentials into run input.
- The Argus Dev CI failure recovery pushes its reviewed fix through the Core Git
  broker but cannot request a provider CI rerun through the broker yet; the run
  then fails closed instead of using stored provider credentials.
- The Core Git broker is disabled by default (`ARGUS_DEV_GIT_BROKER_ENABLED=false`);
  Argus Dev coding runs need it enabled to clone and deliver.

## Demo and test credentials

The demo and test Compose files (`compose.*-demo.yml`, `compose.e2e.yml`,
`compose.ha.e2e.yml`, `compose.mfa-demo.yml`), the local Keycloak realms under
`e2e/keycloak/` and the configuration under `demo/` contain **fixed, publicly
known credentials** (passwords, client secrets, service tokens, TOTP seeds) for
disposable local stacks. They are not secrets. Never expose these stacks to a
network you do not control, and never reuse those values. The Docker installer
generates fresh random secrets for real installations.

## Deployment hardening checklist

- Set strong, unique values for `SESSION_SECRET`, `DB_ENCRYPTION_KEY` and every
  `*_SECRET` variable; run with `NODE_ENV=production`.
- Terminate TLS in front of Argus and expose only the Console/API port.
- Configure an OIDC provider with MFA for administrators; restrict local
  accounts to break-glass use.
- If `OAUTH2_ENABLED=true`, set `OAUTH2_ISSUER` and `OAUTH2_AUDIENCE`.
- Keep `.env`, `secrets/` and runtime credential volumes out of version
  control and backups that leave your trust boundary.
