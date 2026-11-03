import {
  describeBackendSso,
  parseBackendSsoPortal,
  validatedBackendSsoLaunchUrl,
} from '../backendSso.js';

const portal = {
  mode: 'shared_oidc',
  application: 'Gitea',
  label: 'Open repository with SSO',
  launch_url: 'http://localhost:3005/user/oauth2/argus-mfa-demo',
  provider_name: 'Argus MFA Demo',
  presentation_role: 'Source code and CI',
};

describe('backend workforce SSO', () => {
  it('publishes only an Argus-owned launch path for entitled OIDC sessions', () => {
    expect(describeBackendSso(
      { backendSsoEnabled: true, oidcSsoEnabled: true, entraSsoEnabled: false },
      { auth_method: 'oidc' },
      42,
      portal,
    )).toMatchObject({ state: 'ready', premium: true, launchPath: '/api/ui/mcp-fabric/connections/42/sso-launch' });
  });

  it('keeps the community path operational while marking SSO as premium', () => {
    expect(describeBackendSso(
      { backendSsoEnabled: false, oidcSsoEnabled: false, entraSsoEnabled: false },
      { auth_method: 'local' },
      42,
      portal,
    )).toMatchObject({ state: 'premium_required', launchPath: null });
  });

  it('requires an actual provider-backed session even when the feature is enabled', () => {
    expect(describeBackendSso(
      { backendSsoEnabled: true, oidcSsoEnabled: true, entraSsoEnabled: false },
      { auth_method: 'local' },
      42,
      portal,
    )).toMatchObject({ state: 'sso_required', launchPath: null });
  });

  it('rejects malformed portal metadata and non-allowlisted redirects', () => {
    expect(parseBackendSsoPortal({ ...portal, launch_url: 'javascript:alert(1)' })).toBeNull();
    const parsed = parseBackendSsoPortal(portal);
    expect(parsed).not.toBeNull();
    expect(() => validatedBackendSsoLaunchUrl(parsed!, ['http://localhost:3006']))
      .toThrow('not allowlisted');
  });
});
