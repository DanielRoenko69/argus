import { renderLoginHtml } from '../loginPage.js';

describe('generic OIDC login page', () => {
  it('renders a provider-neutral OIDC action without a Microsoft mark', () => {
    const html = renderLoginHtml({
      entraSsoEnabled: true,
      ssoProvider: 'generic_oidc',
      ssoProviderName: 'Keycloak',
      localAuthEnabled: true,
    });
    expect(html).toContain('href="/auth/oidc/login"');
    expect(html).toContain('Mit Keycloak anmelden');
    expect(html).not.toContain('fill="#f25022"');
  });

  it('escapes a configured provider display name', () => {
    const html = renderLoginHtml({
      entraSsoEnabled: true,
      ssoProvider: 'generic_oidc',
      ssoProviderName: '<unsafe>',
    });
    expect(html).toContain('Mit &lt;unsafe&gt; anmelden');
    expect(html).not.toContain('Mit <unsafe> anmelden');
  });
});
