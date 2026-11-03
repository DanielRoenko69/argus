import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ConsoleNavigationCapabilityResponse } from '../types';
import { WorkspaceSidebar } from './WorkspaceSidebar';

const capabilities: ConsoleNavigationCapabilityResponse = {
  schemaVersion: 1,
  generatedAt: '2026-09-13T10:00:00.000Z',
  actor: { id: 1, role: 'platform_admin' },
  permissions: ['agents.read', 'knowledge.read', 'skills.read', 'workflows.read', 'integrations.read', 'runs.read_all', 'governance.read', 'observability.read', 'agents.run', 'aiops.service_profile.read', 'compliance.read', 'workspace.search'],
  modules: [
    { id: 'argus.core', installed: true, entitled: true, available: true, reason: 'available' },
    { id: 'argus.dev', installed: true, entitled: true, available: true, reason: 'available' },
    { id: 'argus.aiops', installed: true, entitled: true, available: true, reason: 'available' },
    { id: 'argus.hermes', installed: false, entitled: true, available: false, reason: 'not_installed' },
    { id: 'public-channels', installed: true, entitled: true, available: true, reason: 'available' },
    { id: 'compliance', installed: true, entitled: true, available: true, reason: 'available' },
  ],
  navigation: {
    canUseArgusDev: true, canBuildWorkflows: true, canManageAgents: true, canManageIntegrations: true,
    canManageKnowledge: true, canRunEvaluations: true, canReviewApprovals: true, canObservePlatform: true,
    canReadAuditEvidence: true, canManageRuntimePolicy: true, canUseCompliance: true,
    canManagePublicChannels: true, canSearchWorkspaceResources: true, canAdminPlatform: true,
  },
};

function renderSidebar(overrides: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}) {
  const props: ComponentProps<typeof WorkspaceSidebar> = {
    canAdmin: false,
    pathname: '/home',
    collapsed: false,
    mobileOpen: false,
    onToggleCollapsed: vi.fn(),
    onOpenMobile: vi.fn(),
    onCloseMobile: vi.fn(),
    ...overrides,
  };
  return { ...render(<WorkspaceSidebar {...props} />), props };
}

describe('WorkspaceSidebar', () => {
  it('keeps the standard navigation visible and hides admin-only entries for viewers', () => {
    renderSidebar();

    const home = screen.getByRole('link', { name: 'Argus home' });
    expect(home).toHaveAttribute('href', '/home');
    expect(home.querySelector('.brand-logo-full')).toHaveAttribute('src', '/console-assets/brand/argus-wordmark.png');
    expect(home.querySelector('.brand-logo-mark')).toHaveAttribute('src', '/console-assets/brand/argus-mark.png');
    expect(screen.getByRole('link', { name: 'Agent Studio' })).toHaveAttribute('href', '/build/agents');
    expect(screen.getByRole('link', { name: 'Knowledge Hub' })).toHaveAttribute('href', '/build/knowledge');
    expect(screen.getByRole('link', { name: 'MCP Fabric' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Runs & Approvals' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Observe' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Public widgets' })).not.toBeInTheDocument();
  });

  it('opens and closes the mobile navigation through the standard controls', () => {
    const { props, rerender } = renderSidebar();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(props.onOpenMobile).toHaveBeenCalledTimes(1);

    rerender(<WorkspaceSidebar {...props} mobileOpen />);
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(props.onCloseMobile).toHaveBeenCalledTimes(1);
  });

  it('delegates collapsing to the host shell', () => {
    const { props } = renderSidebar({ collapsed: true, canAdmin: true, pathname: '/build/agents' });

    expect(screen.getByRole('link', { name: 'Agent Studio' })).toHaveClass('is-active');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(props.onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it('uses host navigation for regular internal clicks while keeping browser link behavior intact', () => {
    const onNavigate = vi.fn();
    renderSidebar({ canAdmin: true, capabilities, onNavigate });

    fireEvent.click(screen.getByRole('link', { name: 'Argus AIOps' }));
    expect(onNavigate).toHaveBeenCalledWith('/solutions/argus.aiops');

    const newTabLink = screen.getByRole('link', { name: 'Argus Dev' });
    newTabLink.addEventListener('click', event => event.preventDefault());
    fireEvent.click(newTabLink, { ctrlKey: true });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('shows Argus Hermes only when its Solution Pack is installed', () => {
    renderSidebar({ canAdmin: true, capabilities });
    expect(screen.queryByRole('link', { name: 'Argus Hermes' })).not.toBeInTheDocument();
  });

  it('lists an installed Argus Hermes pack under Solutions and marks it active', () => {
    const withHermes: ConsoleNavigationCapabilityResponse = {
      ...capabilities,
      modules: capabilities.modules.map(module => module.id === 'argus.hermes'
        ? { ...module, installed: true, available: true, reason: 'available' }
        : module),
    };
    renderSidebar({ canAdmin: true, capabilities: withHermes, pathname: '/solutions/argus.hermes' });
    const hermes = screen.getByRole('link', { name: 'Argus Hermes' });
    expect(hermes).toHaveAttribute('href', '/solutions/argus.hermes');
    expect(hermes).toHaveClass('is-active');
  });

  it('hides Argus Hermes from principals without agents.run', () => {
    const viewer: ConsoleNavigationCapabilityResponse = {
      ...capabilities,
      permissions: capabilities.permissions.filter(permission => permission !== 'agents.run'),
      modules: capabilities.modules.map(module => module.id === 'argus.hermes'
        ? { ...module, installed: true, available: true, reason: 'available' }
        : module),
    };
    renderSidebar({ canAdmin: false, capabilities: viewer });
    expect(screen.queryByRole('link', { name: 'Argus Hermes' })).not.toBeInTheDocument();
  });

  it('does not flash module-dependent solutions before server capabilities arrive', () => {
    renderSidebar({ canAdmin: true });

    expect(screen.queryByRole('link', { name: 'Argus Dev' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Argus AIOps' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Compliance' })).not.toBeInTheDocument();
  });

  it.each([
    ['/build/evaluations', 'Agent Studio'],
    ['/build/knowledge', 'Knowledge Hub'],
    ['/build/skills', 'Knowledge Hub'],
    ['/build/agents/channels', 'Agent Studio'],
    ['/mcp-fabric/capabilities', 'MCP Fabric'],
    ['/governance', 'Runs & Approvals'],
  ])('keeps the parent navigation active for %s', (pathname, label) => {
    renderSidebar({ canAdmin: true, capabilities, pathname });
    expect(screen.getByRole('link', { name: label })).toHaveClass('is-active');
  });
});
