import {
  Activity,
  Bot,
  ChevronLeft,
  CircleGauge,
  ClipboardCheck,
  Code2,
  Database,
  GitBranch,
  Menu,
  Network,
  PanelLeftClose,
  Play,
  Radar,
  Settings,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { MouseEvent } from 'react';
import type { ConsoleModuleId, ConsoleNavigationCapabilityResponse } from '../types';

export type WorkspaceIconName =
  | 'activity'
  | 'bot'
  | 'chevron-left'
  | 'circle-gauge'
  | 'clipboard-check'
  | 'code'
  | 'database'
  | 'git-branch'
  | 'menu'
  | 'mcp-network'
  | 'panel-left-close'
  | 'play'
  | 'radar'
  | 'settings'
  | 'shield-check'
  | 'x';

export interface WorkspaceNavItem {
  label: string;
  href: string;
  icon: WorkspaceIconName;
  adminOnly?: boolean;
  module?: ConsoleModuleId;
  anyPermission?: string[];
}

export interface WorkspaceUser {
  displayName?: string;
  username?: string;
  role?: string;
}

export interface WorkspaceSidebarProps {
  user?: WorkspaceUser;
  canAdmin: boolean;
  capabilities?: ConsoleNavigationCapabilityResponse;
  approvalCount?: number;
  pathname?: string;
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapsed: () => void;
  onOpenMobile: () => void;
  onCloseMobile: () => void;
  /**
   * Console supplies this to preserve its React Query cache and page state
   * during normal internal navigation. Other hosts (such as the chat app)
   * can omit it and retain standard anchor navigation.
   */
  onNavigate?: (href: string) => void;
}

export const workspaceSections: Array<{ label?: string; items: WorkspaceNavItem[] }> = [
  { items: [{ label: 'Home', href: '/home', icon: 'circle-gauge' }] },
  {
    label: 'Solutions',
    items: [
      { label: 'Argus Dev', href: '/solutions/argus.dev', icon: 'code', module: 'argus.dev', anyPermission: ['agents.run'] },
      { label: 'Argus AIOps', href: '/solutions/argus.aiops', icon: 'radar', module: 'argus.aiops', anyPermission: ['aiops.service_profile.read'] },
      { label: 'Argus Hermes', href: '/solutions/argus.hermes', icon: 'bot', module: 'argus.hermes', anyPermission: ['agents.run'] },
      { label: 'Compliance', href: '/solutions/compliance', icon: 'clipboard-check', module: 'compliance', anyPermission: ['compliance.read'] },
    ],
  },
  {
    label: 'Build',
    items: [
      { label: 'Agent Studio', href: '/build/agents', icon: 'bot', anyPermission: ['agents.read'] },
      { label: 'Knowledge Hub', href: '/build/knowledge', icon: 'database', anyPermission: ['knowledge.read', 'skills.read'] },
      { label: 'Workflows', href: '/build/workflows', icon: 'git-branch', anyPermission: ['workflows.read'] },
    ],
  },
  {
    label: 'Operate',
    items: [
      { label: 'MCP Fabric', href: '/mcp-fabric', icon: 'mcp-network', anyPermission: ['integrations.read'] },
      { label: 'Runs & Approvals', href: '/runs', icon: 'play', anyPermission: ['runs.read_own', 'runs.read_all', 'governance.read', 'approvals.review'] },
      { label: 'Observe', href: '/observe', icon: 'activity', anyPermission: ['observability.read', 'audit.read'] },
    ],
  },
];

export const workspaceIcons: Record<WorkspaceIconName, LucideIcon> = {
  activity: Activity,
  bot: Bot,
  'chevron-left': ChevronLeft,
  'circle-gauge': CircleGauge,
  'clipboard-check': ClipboardCheck,
  code: Code2,
  database: Database,
  'git-branch': GitBranch,
  menu: Menu,
  'mcp-network': Network,
  'panel-left-close': PanelLeftClose,
  play: Play,
  radar: Radar,
  settings: Settings,
  'shield-check': ShieldCheck,
  x: X,
};

export function isWorkspaceNavItemVisible(
  item: WorkspaceNavItem,
  capabilities: ConsoleNavigationCapabilityResponse | undefined,
  canAdmin: boolean,
): boolean {
  if (!capabilities) return !item.module && (!item.adminOnly || canAdmin);
  if (item.adminOnly && !capabilities.navigation.canAdminPlatform) return false;
  if (item.module && !capabilities.modules.some(module => module.id === item.module && module.available)) return false;
  if (item.anyPermission?.length && !item.anyPermission.some(permission => capabilities.permissions.includes(permission))) return false;
  return true;
}

function isActive(pathname: string, item: WorkspaceNavItem): boolean {
  if (item.href === '/home') return pathname === item.href;
  if (item.href === '/build/agents') {
    return pathname.startsWith('/build/agents')
      || pathname.startsWith('/build/evaluations')
      || pathname.startsWith('/build/public-widgets')
      || pathname.startsWith('/settings/public-channels');
  }
  if (item.href === '/build/knowledge') return pathname.startsWith('/build/knowledge') || pathname.startsWith('/build/skills');
  if (item.href === '/runs') return pathname.startsWith('/runs') || pathname === '/governance';
  if (item.href === '/observe') return pathname === '/observe' || pathname.startsWith('/observe/');
  if (item.href === '/mcp-fabric') return pathname === '/mcp-fabric' || pathname.startsWith('/mcp-fabric/');
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function WorkspaceSidebar({
  user,
  canAdmin,
  capabilities,
  approvalCount = 0,
  pathname = typeof window === 'undefined' ? '/' : window.location.pathname,
  collapsed,
  mobileOpen,
  onToggleCollapsed,
  onOpenMobile,
  onCloseMobile,
  onNavigate,
}: WorkspaceSidebarProps) {
  const displayName = user?.displayName || user?.username || 'Argus user';
  const handleNavigation = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    onCloseMobile();

    // Preserve browser affordances such as opening a link in a new tab.
    if (!onNavigate || event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;

    event.preventDefault();
    onNavigate(href);
  };

  return (
    <>
      <button
        className="mobile-menu-button"
        type="button"
        aria-label="Open navigation"
        onClick={onOpenMobile}
      >
        <Menu size={20} />
      </button>

      {mobileOpen && (
        <button
          className="mobile-scrim"
          type="button"
          aria-label="Close navigation overlay"
          onClick={onCloseMobile}
        />
      )}

      <aside className={`app-sidebar${mobileOpen ? ' is-open' : ''}`} aria-label="Primary navigation">
        <div className="brand-row">
          <a className="brand" href="/home" aria-label="Argus home" onClick={event => handleNavigation(event, '/home')}>
            <img className="brand-logo brand-logo-full" src="/console-assets/brand/argus-wordmark.png" alt="" />
            <img className="brand-logo brand-logo-mark" src="/console-assets/brand/argus-mark.png" alt="" />
          </a>
          <button
            type="button"
            className="sidebar-close mobile-only"
            aria-label="Close navigation"
            onClick={onCloseMobile}
          >
            <X size={18} />
          </button>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          {workspaceSections.map((section, sectionIndex) => {
            const visibleItems = section.items.filter(item => isWorkspaceNavItemVisible(item, capabilities, canAdmin));
            if (visibleItems.length === 0) return null;
            return (
            <div className="nav-section" key={section.label ?? `root-${sectionIndex}`}>
              {section.label && <div className="nav-section-label">{section.label}</div>}
              {visibleItems.map(item => {
                const ItemIcon = workspaceIcons[item.icon];
                const active = isActive(pathname, item);
                return (
                  <a
                    className={`nav-link${active ? ' is-active' : ''}`}
                    href={item.href}
                    key={item.href}
                    title={item.label}
                    aria-current={active ? 'page' : undefined}
                    onClick={event => handleNavigation(event, item.href)}
                  >
                    <ItemIcon size={18} />
                    <span>{item.label}</span>
                    {item.href === '/runs' && approvalCount > 0 && <em title={`${approvalCount} pending approval${approvalCount === 1 ? '' : 's'}`}>{approvalCount}</em>}
                  </a>
                );
              })}
            </div>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <a
            className={`nav-link${isActive(pathname, { label: 'Settings', href: '/settings', icon: 'settings' }) ? ' is-active' : ''}`}
            href="/settings"
            onClick={event => handleNavigation(event, '/settings')}
          >
            <Settings size={18} />
            <span>Settings</span>
          </a>
          <button
            type="button"
            className="collapse-button"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={onToggleCollapsed}
          >
            <PanelLeftClose size={18} />
            <span>Collapse</span>
            <ChevronLeft size={14} className="collapse-chevron" />
          </button>
          <div className="user-card">
            <span className="user-avatar">{displayName.charAt(0).toUpperCase()}</span>
            <span className="user-copy">
              <b>{displayName}</b>
              <small>{user?.role?.replaceAll('_', ' ') || 'loading'}</small>
            </span>
            <form method="POST" action="/auth/logout">
              <button type="submit" className="logout-button" aria-label="Sign out">↗</button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}
