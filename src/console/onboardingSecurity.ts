import { assertSsrfSafeResolved } from '../backends/customBackends.js';
import { hasRole } from '../auth/roles.js';

export class OnboardingPolicyError extends Error {
  constructor(message: string, public readonly status: 400 | 403) {
    super(message);
    this.name = 'OnboardingPolicyError';
  }
}

/** Platform-owned providers are shared onboarding infrastructure. */
export function isSharedOnboardingProvider(
  createdBy: number | null | undefined,
  createdByRole: string | null | undefined,
): boolean {
  return createdBy == null || hasRole(createdByRole, 'platform_admin');
}

/** Normal users may use shared providers and their own personal providers. */
export function canUseOnboardingProvider(
  userId: number,
  userRole: string | null | undefined,
  createdBy: number | null | undefined,
  createdByRole: string | null | undefined,
): boolean {
  return hasRole(userRole, 'platform_admin')
    || isSharedOnboardingProvider(createdBy, createdByRole)
    || createdBy === userId;
}

function parseBundleIds(value: unknown): number[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new OnboardingPolicyError('bundleIds must be an array', 400);
  }
  const ids = [...new Set(value.map(Number))];
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new OnboardingPolicyError('bundleIds contains an invalid bundle ID', 400);
  }
  return ids.slice(0, 64);
}

/**
 * Resolve a user-provided onboarding bundle selection against the caller's
 * server-side scope. An empty selection means "all bundles I may use" for a
 * scoped user, never "all bundles in the system".
 */
export function scopeOnboardingBundleIds(
  allowedBundleIds: number[] | null | undefined,
  requestedValue: unknown,
): number[] | null {
  const requested = parseBundleIds(requestedValue);
  if (allowedBundleIds == null) return requested;

  const allowed = [...new Set(allowedBundleIds.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (allowed.length === 0) {
    throw new OnboardingPolicyError('No MCP bundles are assigned to your account', 403);
  }

  const unauthorized = requested.filter(id => !allowed.includes(id));
  if (unauthorized.length > 0) {
    throw new OnboardingPolicyError('One or more selected MCP bundles are outside your access scope', 403);
  }
  return requested.length > 0 ? requested : allowed;
}

/**
 * Normal users may create personal provider records, but server-managed
 * environment/Vault credentials are reserved for the admin provider UI.
 */
export function assertOnboardingProviderCredentials(
  isPlatformAdmin: boolean,
  secretName: string | null,
  credentialProfileId: number | null,
): void {
  if (isPlatformAdmin) return;
  if (secretName || credentialProfileId != null) {
    throw new OnboardingPolicyError(
      'Environment/Vault secrets and credential profiles can only be used by platform administrators',
      403,
    );
  }
}

/**
 * Resolve DNS before a normal user's provider endpoint is used. This blocks
 * literal and DNS-based loopback/private/metadata targets, including rebinding
 * attempts that a synchronous URL check would miss.
 */
export async function assertOnboardingProviderUrlSafe(url: string): Promise<void> {
  await assertSsrfSafeResolved(url, undefined, { failClosedOnDnsError: true });
}
