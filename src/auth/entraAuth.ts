/**
 * Backward-compatible Entra exports.
 *
 * Interactive SSO is implemented by the provider-neutral OIDC core. Existing
 * imports and Entra configuration remain valid while generic providers use the
 * same verified Authorization Code + PKCE + nonce flow.
 */
export {
  buildAuthorizationUrl,
  handleCallback,
  resolveOidcRole as resolveEntraRole,
  resolveOidcRoleMapping as resolveEntraRoleMapping,
  oidcUsername,
  clearOidcJwksCache,
} from './oidcAuth.js';
export type {
  OidcIdToken as EntraIdToken,
  OidcUser as EntraUser,
} from './oidcAuth.js';
