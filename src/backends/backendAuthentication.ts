/** Core-owned credential selection. Callers must authorize the target/tool first.
 * Credentials returned here are for trusted transport only, never workflow state.
 */
import type { CustomBackendRow, CredOverride } from './customBackends.js';
import { getUpstreamTokenExchangeConfig } from '../lib/platformConfig.js';
import { getCurrentCallingUser } from '../lib/requestContext.js';
import { getSharedPool } from '../lib/sharedPool.js';
import { getValidToken } from '../lib/upstreamTokens.js';
import { writeImmutableAudit } from '../audit/immutableAudit.js';
import { getNativeTelemetryContext } from '../observability/telemetryStore.js';

export type BackendAuthMode = 'service-account' | 'permissive' | 'strict';
export type BackendAuthErrorCode = 'delegation_disabled' | 'oauth_not_configured'
  | 'user_identity_required' | 'credential_store_unavailable' | 'connection_required'
  | 'insufficient_oauth_scopes' | 'credential_backend_mismatch' | 'delegation_adapter_required';

export class BackendAuthenticationError extends Error {
  constructor(public readonly code: BackendAuthErrorCode, public readonly backendId: number) {
    super(`[upstream-auth:${code}] Backend #${backendId}: ${
      code === 'connection_required' || code === 'insufficient_oauth_scopes'
        ? 'Connect or reconnect your account in /connections, then retry.'
        : 'The configured authentication policy cannot be satisfied. Contact an administrator.'
    } No service-account fallback was used.`);
    this.name = 'BackendAuthenticationError';
  }
}

export interface BackendAuthEvidence {
  backendId: number;
  mode: 'user-oauth' | 'service-account';
  userId?: number;
}

export function auditBackendAuthentication(evidence: BackendAuthEvidence): void {
  const pool = getSharedPool();
  if (!pool) return;
  const context = getNativeTelemetryContext();
  const caller = getCurrentCallingUser();
  writeImmutableAudit(pool, {
    eventType: 'upstream_auth_selected', apiKeyPrefix: caller?.id ? `user__${caller.id}` : 'system',
    userId: caller?.id, model: '', riskLevel: 'low', requestId: context?.rootTraceId,
    errorType: `backend:${evidence.backendId}:identity:${evidence.mode}`,
  });
}

/** A tool may strengthen backend policy, never downgrade it. Legacy permissive
 * means user OAuth without automatic identity switching; service use is explicit.
 */
export function effectiveBackendAuthMode(backend: BackendAuthMode, tool?: BackendAuthMode | null): BackendAuthMode {
  if (backend === 'strict' || tool === 'strict') return 'strict';
  if (backend === 'permissive' || tool === 'permissive') return 'permissive';
  return 'service-account';
}

/** Transitional adapters must fail closed instead of exporting service secrets
 * from a backend whose admin selected delegated identity.
 */
export function assertServiceCredentialAdapter(backendId: number, mode: BackendAuthMode): void {
  if (mode !== 'service-account') throw new BackendAuthenticationError('delegation_adapter_required', backendId);
}

export async function resolveBackendAuthentication(
  backend: CustomBackendRow,
  toolMode?: BackendAuthMode | null,
  override?: CredOverride,
): Promise<{ authorization: string | null; evidence: BackendAuthEvidence }> {
  const mode = effectiveBackendAuthMode(backend.auth_mode, toolMode);
  const user = getCurrentCallingUser();
  const pool = getSharedPool();
  const deny = (code: BackendAuthErrorCode): never => {
    if (pool) void writeImmutableAudit(pool, {
      eventType: 'upstream_elicitation_required', apiKeyPrefix: user?.id ? `user__${user.id}` : 'system',
      userId: user?.id, model: '', errorType: `backend:${backend.id}:${code}`, riskLevel: 'medium',
      isError: true, requestId: getNativeTelemetryContext()?.rootTraceId,
    });
    throw new BackendAuthenticationError(code, backend.id);
  };
  if (override?.backendId !== undefined && override.backendId !== backend.id) deny('credential_backend_mismatch');
  if (mode === 'service-account') {
    return { authorization: null, evidence: { backendId: backend.id, mode: 'service-account' } };
  }
  // Policy precedes the feature switch and overrides: neither can disable strict auth.
  if (!getUpstreamTokenExchangeConfig().enabled) deny('delegation_disabled');
  if (!backend.oauth_token_url || !backend.oauth_client_id || !backend.oauth_client_secret) deny('oauth_not_configured');
  if (!user?.id || !Number.isSafeInteger(user.id) || user.id < 1) deny('user_identity_required');
  if (!pool) deny('credential_store_unavailable');
  let token;
  try {
    token = await getValidToken(pool!, user!.id!, backend.id, {
      id: backend.id, oauth_token_url: backend.oauth_token_url!,
      oauth_client_id: backend.oauth_client_id!, oauth_client_secret_enc: backend.oauth_client_secret!,
    });
  } catch { deny('credential_store_unavailable'); }
  if (!token || token.user_id !== user!.id || token.backend_id !== backend.id) deny('connection_required');
  if ((backend.oauth_scopes ?? []).some(scope => !token!.scopes_granted.includes(scope))) deny('insufficient_oauth_scopes');
  return {
    authorization: `Bearer ${token!.access_token}`,
    evidence: { backendId: backend.id, mode: 'user-oauth', userId: user!.id },
  };
}

/** Delegation replaces credentials, not just one spelling of Authorization. */
export function removeServiceCredentialHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (/authorization|cookie|password|passphrase|session|jwt|token|secret|credential|api[-_]?key|private[-_]?key|access[-_]?key/i.test(name)) delete headers[name];
  }
}
