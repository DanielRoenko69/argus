import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IdentitySecurityStatus } from '../types';
import { IdentitySecurityPage } from './IdentitySecurityPage';

const api = vi.hoisted(() => ({
  getIdentitySecurityStatus: vi.fn(),
  beginIdentitySecurityLink: vi.fn(),
}));
vi.mock('../api', () => api);

const base: IdentitySecurityStatus = {
  provider: {
    enabled: true,
    name: 'Company SSO',
    type: 'generic_oidc',
    ssoOnly: false,
    localLoginEnabled: true,
    emergencyLocalAdmin: false,
    mfaMaxAgeSeconds: 600,
    accountManagementUrl: 'https://identity.example.test/account/security',
    adminConsoleUrl: 'https://identity.example.test/admin/policy',
  },
  session: {
    authMethod: 'local',
    ssoLinked: false,
    mfaVerifiedAt: null,
    mfaMethod: null,
    mfaFresh: false,
  },
  actions: { canLink: true, canStepUp: false, canManageMfa: false, canManageOrganizationPolicy: true },
  complianceReports: { roleAuthorized: true, freshMfaRequired: true, ready: false },
};

function renderPage(value: IdentitySecurityStatus) {
  api.getIdentitySecurityStatus.mockResolvedValue(value);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><IdentitySecurityPage /></QueryClientProvider></MemoryRouter>);
}

describe('IdentitySecurityPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('guides an existing local account through verified SSO linking', async () => {
    renderPage(base);
    expect(await screen.findByRole('heading', { name: 'Local Argus account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Link SSO & verify MFA/ })).toBeEnabled();
    expect(screen.queryByText('Platform Admin required')).not.toBeInTheDocument();
    expect(screen.getByText('Action required')).toBeInTheDocument();
  });

  it('shows a linked session as export-ready only with fresh MFA', async () => {
    renderPage({
      ...base,
      session: {
        authMethod: 'oidc', ssoLinked: true, mfaVerifiedAt: '2026-09-14T10:00:00.000Z',
        mfaMethod: 'amr:webauthn', mfaFresh: true,
      },
      actions: { canLink: false, canStepUp: true, canManageMfa: true, canManageOrganizationPolicy: true },
      complianceReports: { roleAuthorized: true, freshMfaRequired: true, ready: true },
    });
    expect(await screen.findByRole('heading', { name: 'Company SSO' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Verify MFA again/ })).toHaveAttribute('href', expect.stringContaining('/auth/oidc/step-up'));
    expect(screen.getByRole('link', { name: /Manage MFA at Company SSO/ })).toHaveAttribute('href', 'https://identity.example.test/account/security');
    expect(screen.getByRole('link', { name: /Open identity-provider policy/ })).toHaveAttribute('href', 'https://identity.example.test/admin/policy');
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });
});
