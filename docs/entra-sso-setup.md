# Microsoft Entra ID single sign-on

Argus Core includes a Microsoft Entra ID preset for interactive browser
sign-in. It uses the same OIDC flow as generic providers. For the
security model (PKCE `S256`, nonce, signed state, browser binding, MFA
step-up), see [oidc-sso-setup.md](oidc-sso-setup.md).

- `ENTRA_SSO_ENABLED` turns the preset on or off without code changes. Leave it
  `false` until the app registration and groups are ready.
- `ENTRA_SSO_ENABLED` and `OIDC_SSO_ENABLED` are mutually exclusive.
- Local password login stays available unless you enable SSO-only mode.

## What the preset sets for you

| Setting | Value |
|---|---|
| Authorization endpoint | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/authorize` |
| Token endpoint | `https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token` |
| Issuer | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| JWKS | `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys` |
| Scopes | `openid profile email` |
| Subject / e-mail / name / groups claims | `oid` / `preferred_username` / `name` / `groups` |
| Argus username | `entra:<oid>` |

A normal login sends `prompt=select_account`. The `OIDC_SCOPES` and
`OIDC_*_CLAIM` overrides do not apply to the Entra preset.

## 1. Create the app registration

1. In the Entra admin center open **App registrations → New registration**.
2. **Name:** for example `Argus`. **Supported account types:** single tenant.
3. **Redirect URI:** platform **Web**,
   `https://argus.example.com/auth/entra/callback`. For local evaluation also
   add `http://localhost:3000/auth/entra/callback`.
4. Note **Application (client) ID** → `ENTRA_CLIENT_ID` and **Directory (tenant)
   ID** → `ENTRA_TENANT_ID` from the overview page.
5. Under **Certificates & secrets** create a client secret and store its value
   as `ENTRA_CLIENT_SECRET`. It is shown only once; track its expiry.

Argus serves both `/auth/entra/callback` and `/auth/oidc/callback`. Whichever
you register must match `ENTRA_REDIRECT_URI` exactly.

### Permissions

The delegated `openid`, `profile` and `email` permissions are sufficient.
Argus reads groups from the ID token and does not call Microsoft Graph, so no
Graph group permission is needed for sign-in.

### Groups claim

1. **Token configuration → Add groups claim**.
2. Select **Security groups**, or **Groups assigned to the application** to
   keep tokens small. Emit them as **Group ID** in the ID token.

If a user belongs to more groups than fit in a token, Entra omits the `groups`
claim and sends an overage reference. Argus does not resolve overage, so that
user receives the default role. Assigning only the relevant groups to the
application avoids this.

## 2. Create groups and map roles

Create one security group per role you need and note each group's **Object ID**:

| Example group | Argus role |
|---|---|
| `argus-platform-admins` | `platform_admin` |
| `argus-operations-admins` | `operations_admin` |
| `argus-developers` | `developer` |
| `argus-agent-operators` | `agent_operator` |
| *(no group)* | `ENTRA_DEFAULT_ROLE` (default `viewer`) |

Roles from highest to lowest are `platform_admin`, `operations_admin`,
`developer`, `agent_operator`, `viewer` and `chat_user`. Each includes the
rights of the roles below it. If a user matches several groups, the highest role
wins. Fine-grained tool access is governed separately; see
[user-policy-rbac.md](user-policy-rbac.md).

## 3. Configure Argus

Keep the preset disabled while you prepare the values:

```env
ENTRA_SSO_ENABLED=false
ENTRA_TENANT_ID=<tenant-id>
ENTRA_CLIENT_ID=<client-id>
ENTRA_CLIENT_SECRET=<client-secret>
ENTRA_REDIRECT_URI=https://argus.example.com/auth/entra/callback

# <group-object-id>:<role>, comma-separated on a single line
ENTRA_GROUP_MAP=<group-object-id-1>:platform_admin,<group-object-id-2>:developer
ENTRA_DEFAULT_ROLE=viewer

ENTRA_EMERGENCY_LOCAL_ADMIN=true
# ENTRA_DISABLE_LOCAL_LOGIN=false

# MFA step-up (shared with generic OIDC)
OIDC_MFA_AMR_VALUES=mfa,otp,hwk,webauthn,fido
# OIDC_MFA_ACR_VALUES=<value observed in your tenant's ID tokens>
OIDC_MFA_MAX_AGE_SECONDS=600
```

Notes:

- `ENTRA_REDIRECT_URI` defaults to `http://localhost:<PORT>/auth/entra/callback`.
- Argus does not validate `ENTRA_TENANT_ID` at startup. An empty value produces
  broken Microsoft URLs at login time.
- Write `ENTRA_GROUP_MAP` on one line. `.env` files do not support line
  continuation.
- Optional links shown under **Settings → Sign-in & MFA**:
  `ENTRA_ACCOUNT_MANAGEMENT_URL` (default: the Microsoft My Sign-Ins security
  info page) and `ENTRA_ADMIN_CONSOLE_URL` (default: the Conditional Access
  policies blade). Neither is forwarded by the bundled `docker-compose.yml`;
  add them to the `mcp-server` environment if you change them.

## 4. Enable and test

1. Restart Argus with `ENTRA_SSO_ENABLED=false` and confirm local login works.
2. Create the emergency admin (see step 6).
3. Set `ENTRA_SSO_ENABLED=true` and restart, for example
   `docker compose up -d mcp-server`.
4. Open `/login` and use the Microsoft button. Use the same browser for the
   whole flow; the callback is rejected in any other browser or profile.
5. Confirm your role, then sign in with a test user for each mapped group.

## 5. MFA step-up with Conditional Access

1. Create a Conditional Access policy that requires MFA for the Argus
   application.
2. Inspect a real ID token from your tenant. It must contain an integer
   `auth_time` and an `amr` value listed in `OIDC_MFA_AMR_VALUES`, or an `acr`
   value listed in `OIDC_MFA_ACR_VALUES`. Argus evaluates only the `acr` and
   `amr` claims. If `auth_time` is missing, add it as an optional ID-token
   claim under **Token configuration**.
3. Trigger a protected action, such as a compliance or evidence export. Argus
   redirects to the step-up route (`/auth/oidc/step-up`; `/auth/entra/step-up`
   is an alias), which sends `prompt=login` and `max_age=0`. The returned
   identity must match the active session.
4. Confirm that the export is blocked without step-up and allowed for at most
   `OIDC_MFA_MAX_AGE_SECONDS` afterwards.

If your tenant emits different values, protected actions stay blocked until
the verified values are in the allowlist. Client headers are never accepted as
MFA evidence. Existing local users can link their account and verify MFA
under **Settings → Sign-in & MFA**, as described in
[oidc-sso-setup.md](oidc-sso-setup.md#moving-existing-users-to-sso).

## 6. Emergency access and SSO-only mode

With `ENTRA_EMERGENCY_LOCAL_ADMIN=true` (default) and SSO-only mode enabled,
existing local `platform_admin` accounts can still sign in with a password, for
example during an Entra outage. Other local logins are refused.

1. Under **Settings → Users & roles → Create user** create a local
   `platform_admin` with a strong password that is not linked to SSO.
2. Store the credentials in your password manager and test them regularly.
3. When SSO is stable, set `ENTRA_DISABLE_LOCAL_LOGIN=true` and keep
   `ENTRA_EMERGENCY_LOCAL_ADMIN=true`.

Local sessions never satisfy MFA step-up, so the emergency admin cannot run
MFA-protected exports.

## 7. Day-to-day operations

- **Onboarding:** add the person to the right group. The role applies at their
  next login.
- **Role change:** move the person between groups and have them sign in again.
  Role and group snapshot are recomputed at every SSO login, so manual role
  edits for SSO users in Argus are replaced at the next login.
- **Offboarding:** removing someone from all `argus-*` groups only drops them
  to the default role. To block access, disable the user in Argus (their
  sessions stop immediately) and remove or block them in Entra. Requiring
  user assignment on the enterprise application prevents unassigned users
  from signing in.
- **Group-based tool policies:** groups are stored as object IDs from the last
  login and can be bound to composites and rules; see
  [user-policy-rbac.md](user-policy-rbac.md).

## Optional: API bearer tokens

`OAUTH2_ENABLED=true` accepts Entra-issued JWTs for API and MCP calls. Set
`OAUTH2_ISSUER` to the exact `iss` of those tokens, `OAUTH2_AUDIENCE` to your
API's audience, and `OAUTH2_JWKS_URI` to
`https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`. The token's
`oid` must belong to an existing, enabled `entra:<oid>` user, usually created
by that person's first interactive login. Details are in
[oidc-sso-setup.md](oidc-sso-setup.md#optional-api-bearer-tokens).

## Troubleshooting

Start with `docker compose logs mcp-server` and look for `OIDC callback failed`.

| Symptom | Likely cause and fix |
|---|---|
| Entra error about the redirect URI | Registration and `ENTRA_REDIRECT_URI` differ (scheme, host, port, trailing slash) |
| Everyone gets the default role | Groups claim not configured, overage, or wrong object IDs in `ENTRA_GROUP_MAP` |
| Callback fails with "not bound to this browser" | Different browser or profile, blocked cookies, login older than 10 minutes, or `Secure` cookies on plain HTTP with `NODE_ENV=production` |
| Token exchange failed | Client secret wrong or expired |
| Issuer or audience error | Wrong `ENTRA_TENANT_ID` or `ENTRA_CLIENT_ID` |
| `MFA_STEP_UP_REQUIRED` persists | `auth_time` missing or stale, or `amr`/`acr` values not in the allowlist |
| "account is disabled" | The Argus user is disabled |

## Go-live checklist

- [ ] App registration, client secret (expiry tracked) and redirect URI in place
- [ ] Groups claim emitted as group IDs; overage avoided
- [ ] Groups created and object IDs in `ENTRA_GROUP_MAP`
- [ ] Emergency local `platform_admin` created and tested
- [ ] Microsoft login tested with a user from every mapped group
- [ ] Conditional Access enforces MFA for the Argus application
- [ ] Real step-up returns a fresh `auth_time` and an allowed `amr`/`acr`
- [ ] Protected export blocked without step-up, allowed afterwards
- [ ] HTTPS, `NODE_ENV=production` and Redis enabled in production

See also [INSTALLATION.md](INSTALLATION.md), [THREAT_MODEL.md](THREAT_MODEL.md)
and [SECURITY.md](../SECURITY.md).
