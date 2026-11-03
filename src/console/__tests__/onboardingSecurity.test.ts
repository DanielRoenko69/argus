import { describe, expect, it } from '@jest/globals';
import {
  assertOnboardingProviderCredentials,
  assertOnboardingProviderUrlSafe,
  canUseOnboardingProvider,
  OnboardingPolicyError,
  isSharedOnboardingProvider,
  scopeOnboardingBundleIds,
} from '../onboardingSecurity.js';

describe('onboarding security policy', () => {
  it('scopes an empty selection to the caller bundles', () => {
    expect(scopeOnboardingBundleIds([3, 7], [])).toEqual([3, 7]);
    expect(scopeOnboardingBundleIds(null, [])).toEqual([]);
  });

  it('rejects bundles outside the caller scope', () => {
    expect(() => scopeOnboardingBundleIds([3], [7])).toThrow(OnboardingPolicyError);
    expect(() => scopeOnboardingBundleIds([3], [7])).toThrow(/outside your access scope/i);
    expect(() => scopeOnboardingBundleIds([], [])).toThrow(/No MCP bundles/i);
  });

  it('rejects server-managed credentials for normal users', () => {
    expect(() => assertOnboardingProviderCredentials(false, 'OPENAI_API_KEY', null))
      .toThrow(/platform administrators/i);
    expect(() => assertOnboardingProviderCredentials(false, null, 4))
      .toThrow(/platform administrators/i);
    expect(() => assertOnboardingProviderCredentials(false, null, null)).not.toThrow();
    expect(() => assertOnboardingProviderCredentials(true, 'OPENAI_API_KEY', 4)).not.toThrow();
  });

  it('shares platform-owned providers but isolates personal providers', () => {
    expect(isSharedOnboardingProvider(null, null)).toBe(true);
    expect(isSharedOnboardingProvider(99, 'platform_admin')).toBe(true);
    expect(isSharedOnboardingProvider(99, 'developer')).toBe(false);
    expect(canUseOnboardingProvider(7, 'developer', null, null)).toBe(true);
    expect(canUseOnboardingProvider(7, 'developer', 7, 'developer')).toBe(true);
    expect(canUseOnboardingProvider(7, 'developer', 8, 'developer')).toBe(false);
    expect(canUseOnboardingProvider(7, 'platform_admin', 8, 'developer')).toBe(true);
  });

  it('rejects literal private provider endpoints', async () => {
    await expect(assertOnboardingProviderUrlSafe('http://127.0.0.1:4000/v1'))
      .rejects.toThrow(/interne\/private/i);
  });
});
