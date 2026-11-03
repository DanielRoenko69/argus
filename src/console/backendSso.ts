import type { SessionUser } from '../auth/userAuth.js';
import type { Config } from '../config/env.js';

export type BackendSsoMode = 'shared_oidc' | 'external_org_sso';
export type BackendSsoState = 'ready' | 'sso_required' | 'premium_required';

export interface BackendSsoPortalConfig {
  mode: BackendSsoMode;
  application: string;
  label: string;
  launchUrl: string;
  providerName: string;
  presentationRole: string;
}

export interface BackendSsoDescriptor {
  mode: BackendSsoMode;
  application: string;
  label: string;
  providerName: string;
  presentationRole: string;
  state: BackendSsoState;
  premium: true;
  launchPath: string | null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function parseBackendSsoPortal(value: unknown): BackendSsoPortalConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const mode = record['mode'];
  if (mode !== 'shared_oidc' && mode !== 'external_org_sso') return null;
  const application = boundedString(record['application'], 80);
  const label = boundedString(record['label'], 120);
  const launchUrl = boundedString(record['launch_url'], 2_048);
  const providerName = boundedString(record['provider_name'], 120);
  const presentationRole = boundedString(record['presentation_role'], 240);
  if (!application || !label || !launchUrl || !providerName || !presentationRole) return null;
  let parsed: URL;
  try {
    parsed = new URL(launchUrl);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) return null;
  return { mode, application, label, launchUrl: parsed.toString(), providerName, presentationRole };
}

export function describeBackendSso(
  config: Pick<Config, 'backendSsoEnabled' | 'oidcSsoEnabled' | 'entraSsoEnabled'>,
  user: Pick<SessionUser, 'auth_method'>,
  backendId: number,
  value: unknown,
): BackendSsoDescriptor | null {
  const portal = parseBackendSsoPortal(value);
  if (!portal) return null;
  const state: BackendSsoState = !config.backendSsoEnabled
    ? 'premium_required'
    : user.auth_method !== 'oidc' || (!config.oidcSsoEnabled && !config.entraSsoEnabled)
      ? 'sso_required'
      : 'ready';
  return {
    mode: portal.mode,
    application: portal.application,
    label: portal.label,
    providerName: portal.providerName,
    presentationRole: portal.presentationRole,
    state,
    premium: true,
    launchPath: state === 'ready' ? `/api/ui/mcp-fabric/connections/${backendId}/sso-launch` : null,
  };
}

export function validatedBackendSsoLaunchUrl(
  portal: BackendSsoPortalConfig,
  allowedOrigins: readonly string[],
): string {
  const parsed = new URL(portal.launchUrl);
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new Error(`Backend SSO origin is not allowlisted: ${parsed.origin}`);
  }
  return parsed.toString();
}
