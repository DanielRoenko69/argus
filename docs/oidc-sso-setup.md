# Generic OIDC single sign-on

Argus Core can use any standards-compliant OpenID Connect provider for
interactive browser sign-in, for example Keycloak, Authentik or Okta. Microsoft
Entra ID has its own preset; see [entra-sso-setup.md](entra-sso-setup.md).

- `OIDC_SSO_ENABLED` and `ENTRA_SSO_ENABLED` are mutually exclusive. Argus
  refuses to start if both are `true`.
- Optional API bearer tokens (`OAUTH2_*`) are a separate path; see
  [API bearer tokens](#optional-api-bearer-tokens).
- Argus never stores a second factor. Enrollment, recovery and Conditional
  Access stay in your identity provider (IdP).

## How sign-in works

1. The SSO button on `/login` (labelled with `OIDC_PROVIDER_NAME`) calls
   `/auth/oidc/login`. Argus redirects to the IdP using the Authorization Code
   flow with PKCE (`S256`) and a fresh `nonce`.
2. The `state` parameter is HMAC-signed with a key derived from
   `SESSION_SECRET` and expires after 10 minutes. The PKCE verifier is derived
   from the same secret, so a callback can land on any replica.
3. Argus also sets a one-time browser-binding cookie (`argus_oidc_binding`,
   `HttpOnly`, `SameSite=Lax`, `Path=/auth`). Its hash is embedded in the signed
   state and checked **before** the authorization code is exchanged. The
   callback must therefore arrive in the same browser that started the login.
4. When `REDIS_ENABLED=true`, each state value is consumed atomically and a
   replayed callback is rejected. Without Redis, replay protection relies on the
   IdP accepting each authorization code only once.
5. The ID token's signature, issuer, audience (`OIDC_CLIENT_ID`) and nonce are
   verified against `OIDC_JWKS_URI`. Argus reads claims from the ID token only;
   it does not call a userinfo endpoint.
6. Argus creates a session cookie (`argus_session`, `HttpOnly`,
   `SameSite=Lax`, `Secure` when `NODE_ENV=production`) and redirects to the
   requested page. Post-login redirects (`returnTo`) are limited to same-origin
   relative paths; anything else falls back to the role's landing page.

## 1. Register a client at the IdP

Create a confidential OpenID Connect client with:

- **Grant type:** Authorization Code, with PKCE `S256` allowed or required.
- **Redirect URI:** `https://argus.example.com/auth/oidc/callback`, matching
  `OIDC_REDIRECT_URI` exactly (scheme, host, port, path, trailing slash).
- **Scopes:** `openid profile email` (the default `OIDC_SCOPES`). Add whatever
  scope or mapper your IdP needs to emit groups.
- **ID-token claims:** a stable subject (`sub`), `email`, `name`, a group claim
  (default `groups`), `auth_time`, and `amr` and/or `acr` for MFA step-up.

Group values must appear in the **ID token** exactly as you will write them in
`OIDC_GROUP_MAP`. Some IdPs emit full paths (for example `/argus-admins`)
unless configured otherwise.

## 2. Configure Argus

```env
OIDC_SSO_ENABLED=true
OIDC_PROVIDER_NAME=Keycloak
OIDC_AUTHORIZATION_URL=https://identity.example.com/realms/argus/protocol/openid-connect/auth
OIDC_TOKEN_URL=https://identity.example.com/realms/argus/protocol/openid-connect/token
OIDC_ISSUER=https://identity.example.com/realms/argus
OIDC_JWKS_URI=https://identity.example.com/realms/argus/protocol/openid-connect/certs
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<client-secret>
OIDC_REDIRECT_URI=https://argus.example.com/auth/oidc/callback
OIDC_GROUP_MAP=argus-admins:platform_admin,argus-developers:developer
OIDC_DEFAULT_ROLE=viewer
OIDC_MFA_AMR_VALUES=mfa,otp,hwk,webauthn,fido
# OIDC_MFA_ACR_VALUES=urn:example:loa:2
OIDC_MFA_MAX_AGE_SECONDS=600
```

Authorization URL, token URL, issuer, JWKS URI, client ID and redirect URI are
required; Argus fails at startup if any is missing. `OIDC_CLIENT_SECRET` is sent
to the token endpoint when set.

| Variable | Default | Purpose |
|---|---|---|
| `OIDC_PROVIDER_NAME` | `Single Sign-On` | Label on the login button and in messages |
| `OIDC_SCOPES` | `openid profile email` | Requested scopes |
| `OIDC_SUBJECT_CLAIM` | `sub` | Stable user identifier |
| `OIDC_EMAIL_CLAIM` | `email` | Falls back to `email`, then `preferred_username` |
| `OIDC_DISPLAY_NAME_CLAIM` | `name` | Falls back to the e-mail local part |
| `OIDC_GROUPS_CLAIM` | `groups` | String or array of group values |
| `OIDC_GROUP_MAP` | empty | `group:role` pairs, comma-separated |
| `OIDC_DEFAULT_ROLE` | `viewer` | Role when no group matches |
| `OIDC_ACCOUNT_MANAGEMENT_URL` | empty | Optional self-service MFA link |
| `OIDC_ADMIN_CONSOLE_URL` | empty | Optional IdP policy link for platform admins |
| `OIDC_DISABLE_LOCAL_LOGIN` | `false` | SSO-only mode |
| `OIDC_EMERGENCY_LOCAL_ADMIN` | `true` | Keep the local emergency admin path in SSO-only mode |

The two management URLs are plain links shown under **Settings → Sign-in &
MFA**. They grant Argus no rights at the IdP.

> **Docker Compose note:** the bundled `docker-compose.yml` forwards a fixed
> list of variables to the `mcp-server` container. At the time of writing it
> does not forward `OIDC_DISABLE_LOCAL_LOGIN`, `OIDC_EMERGENCY_LOCAL_ADMIN`,
> `OIDC_ACCOUNT_MANAGEMENT_URL`, `OIDC_ADMIN_CONSOLE_URL` or `OAUTH2_*`. If you
> use them, add them to that service's `environment` block or an override file.

## 3. Identity and role mapping

- **Username:** `oidc:<first 12 hex chars of sha256(OIDC_ISSUER)>:<subject>`.
  Changing the issuer or subject claim creates a different Argus account.
- **Auto-provisioning:** a successful first login creates an Argus user with no
  local password.
- **Role resolution:** every group value that maps to a valid role is
  collected and the highest role wins. Unknown role names are ignored. With no
  match, `OIDC_DEFAULT_ROLE` applies. Group names containing `:` cannot be
  mapped because the first `:` separates group and role.
- **Roles** (highest first): `platform_admin`, `operations_admin`, `developer`,
  `agent_operator`, `viewer`, `chat_user`.
- **Resync:** role, display name and the group snapshot are recomputed on every
  SSO login. Manual role edits for SSO users are replaced at their next login.
- **Disabled accounts:** a user disabled in Argus cannot sign in, and their
  existing sessions stop working immediately.

Per-user and per-group tool policies build on the same group values; see
[user-policy-rbac.md](user-policy-rbac.md).

## 4. MFA step-up

Sensitive operations, such as evidence and report exports, compliance exports
and evaluation releases, require fresh MFA in addition to the role permission.
A user with fresh MFA but without the permission still receives `403`.

- MFA counts only if the signed ID token contains an integer `auth_time` no
  older than `OIDC_MFA_MAX_AGE_SECONDS` (60–3600, default 600, 60 s clock skew
  tolerated) **and** an `amr` value from `OIDC_MFA_AMR_VALUES` or an `acr` value
  from `OIDC_MFA_ACR_VALUES`. Each list holds at most 32 values.
- Local password sessions, client headers and a plain SSO login without those
  claims never count as MFA. `pwd` is deliberately not a default `amr` value.
- When MFA is missing or stale, API calls return `428` with
  `code: "MFA_STEP_UP_REQUIRED"` and a `stepUpUrl`; browser pages redirect to
  `/auth/oidc/step-up`.
- Step-up sends `prompt=login` and `max_age=0` (plus `acr_values` when
  `OIDC_MFA_ACR_VALUES` is set). It is available only to an active SSO session.
  The callback is accepted only for that same session and identity; switching
  accounts at the IdP is rejected.

Test your allowlist against real ID tokens from your IdP. If the values do not
match, protected actions stay blocked by design.

### Moving existing users to SSO

1. Enforce MFA for the relevant group at the IdP.
2. The user signs in locally and opens **Settings → Sign-in & MFA**.
3. **Link SSO & verify MFA** runs the IdP login. Linking requires fresh MFA;
   Argus keeps the user ID, workspaces, Bundle assignments and resources, and
   invalidates the local password.
4. Platform admins check the **SSO linked** and **MFA observed** badges under
   **Settings → Users & roles**. Both reflect signed logins, not manual toggles.

Link an account **before** that person uses the normal SSO button. Otherwise
the first SSO login auto-provisions a separate account and linking fails with
`SSO_IDENTITY_CONFLICT`.

### SSO-only mode

When all regular users are migrated, set `OIDC_DISABLE_LOCAL_LOGIN=true`. With
`OIDC_EMERGENCY_LOCAL_ADMIN=true` (default), existing local `platform_admin`
accounts can still sign in with a password; all other local logins are
refused. Keep at least one unlinked emergency admin, store its credentials
safely and test it regularly. Its sessions never satisfy MFA step-up.

## Optional: API bearer tokens

`OAUTH2_ENABLED=true` lets API and MCP clients present IdP-issued JWTs instead
of API keys. It does not affect browser sign-in.

- `OAUTH2_ISSUER` and `OAUTH2_AUDIENCE` are required; Argus refuses to start
  without them. Set `OAUTH2_JWKS_URI` explicitly; the fallback appends
  `/discovery/v2.0/keys` to the issuer, which suits only Microsoft-style URLs.
- Tokens must carry `sub` and `exp`. The subject (from `OIDC_SUBJECT_CLAIM`,
  falling back to `sub`) is turned into a username with the interactive scheme
  above, using `OAUTH2_ISSUER`. Set it to the same value as `OIDC_ISSUER` so
  both paths resolve to one account.
- The token must map to an existing, enabled Argus user. Unmapped subjects get
  `403`. Role and Bundle scope come from that user, never from token claims.

## Production checklist

- Serve Argus over HTTPS and set `NODE_ENV=production` so cookies are `Secure`.
- Use the same `SESSION_SECRET` on all replicas. Rotating it invalidates
  in-flight logins.
- Enable Redis for one-time state consumption, especially with several
  replicas.
- Serve `/auth/*` at the root of the Argus origin. A path-prefixing proxy breaks
  the `Path=/auth` binding cookie.
- Verify issuer, audience, group mapping, and step-up with real tokens.

## Troubleshooting

Check the server log (for example `docker compose logs mcp-server`) for
`OIDC callback failed` or `OIDC token exchange failed`.

| Symptom | Likely cause |
|---|---|
| Startup error about both providers | `ENTRA_SSO_ENABLED` and `OIDC_SSO_ENABLED` both `true` |
| Startup error listing missing settings | A required `OIDC_*` value is empty |
| IdP reports an invalid redirect URI | `OIDC_REDIRECT_URI` differs from the registration |
| "not bound to this browser" in logs | Callback opened in another browser or profile, cookies blocked, flow older than 10 minutes, `Secure` cookie on plain HTTP, or a proxy path prefix |
| "already consumed" in logs | Callback replayed or reloaded; start a new login |
| Issuer, audience or nonce error | `OIDC_ISSUER` or `OIDC_CLIENT_ID` does not match the token |
| Token exchange failed | Wrong client secret, or PKCE not allowed for the client |
| Everyone gets the default role | Groups missing from the ID token, or values differ from `OIDC_GROUP_MAP` |
| `MFA_STEP_UP_REQUIRED` persists | `auth_time` missing or stale, or `amr`/`acr` not in the allowlist |
| Step-up returns `SSO_SESSION_REQUIRED` | The current session is a local password session |
| "account is disabled" | The Argus user is disabled |

See also [INSTALLATION.md](INSTALLATION.md), [THREAT_MODEL.md](THREAT_MODEL.md)
and [SECURITY.md](../SECURITY.md).
