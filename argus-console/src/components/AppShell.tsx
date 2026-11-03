import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Boxes,
  ChevronRight,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Sun,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { isPlatformAdminRole } from '../access';
import { getConsoleNavigationCapabilities, getConsoleUser, getOverview } from '../api';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import './workspaceSidebar.css';
import { QuickCreateDialog } from './QuickCreateDialog';
import { GlobalSearchDialog } from '../features/global-search/GlobalSearchDialog';

interface AppShellProps {
  children: ReactNode;
}

interface PageContext { section: string; sectionHref?: string; page: string }

function getPageContext(pathname: string): PageContext {
  if (pathname.startsWith('/solutions/argus.dev')) return { section: 'Solutions', sectionHref: '/home', page: 'Argus Dev' };
  if (pathname.startsWith('/solutions/argus.aiops')) return { section: 'Solutions', sectionHref: '/home', page: 'Argus AIOps' };
  if (pathname.startsWith('/solutions/argus.hermes')) return { section: 'Solutions', sectionHref: '/home', page: 'Argus Hermes' };
  if (pathname.startsWith('/build/agents/channels') || pathname.startsWith('/build/public-widgets') || pathname.startsWith('/settings/public-channels')) return { section: 'Agent Studio', sectionHref: '/build/agents', page: 'Public channels' };
  if (pathname.startsWith('/build/agents/manage')) return { section: 'Agent Studio', sectionHref: '/build/agents', page: 'Blueprints' };
  if (pathname.startsWith('/build/agents')) return { section: 'Build', sectionHref: '/build/agents', page: 'Agent Studio' };
  if (pathname.startsWith('/build/knowledge')) return { section: 'Knowledge Hub', sectionHref: '/build/knowledge', page: 'Sources & snapshots' };
  if (pathname.startsWith('/build/evaluations')) return { section: 'Agent Studio', sectionHref: '/build/agents', page: 'Evaluations' };
  if (pathname.startsWith('/build/skills')) return { section: 'Knowledge Hub', sectionHref: '/build/knowledge', page: 'Skills' };
  if (pathname.startsWith('/build/workflows/studio')) return { section: 'Workflows', sectionHref: '/build/workflows', page: 'Workflow Studio' };
  if (pathname.startsWith('/build/workflows')) return { section: 'Build', sectionHref: '/build/agents', page: 'Workflows' };
  if (pathname.startsWith('/mcp-fabric/capabilities')) return { section: 'MCP Fabric', sectionHref: '/mcp-fabric', page: 'Capabilities' };
  if (pathname.startsWith('/mcp-fabric/bundles/')) return { section: 'MCP Fabric', sectionHref: '/mcp-fabric', page: 'Bundle' };
  if (pathname.startsWith('/mcp-fabric')) return { section: 'Operate', sectionHref: '/runs', page: 'MCP Fabric' };
  if (pathname.startsWith('/runs/')) return { section: 'Runs & Approvals', sectionHref: '/runs', page: 'Run detail' };
  if (pathname.startsWith('/runs')) return { section: 'Operate', sectionHref: '/runs', page: 'Runs & Approvals' };
  if (pathname.startsWith('/governance/policies')) return { section: 'Governance', sectionHref: '/governance', page: 'Access policies' };
  if (pathname.startsWith('/governance/runtime-controls') || pathname.startsWith('/settings/models/runtime-controls')) return { section: 'Settings', sectionHref: '/settings', page: 'Execution policies' };
  if (pathname.startsWith('/governance/compliance') || pathname.startsWith('/solutions/compliance')) return { section: 'Solutions', sectionHref: '/home', page: 'Compliance' };
  if (pathname.startsWith('/governance')) return { section: 'Runs & Approvals', sectionHref: '/runs', page: 'Approvals' };
  if (pathname.startsWith('/observe/activity')) return { section: 'Observe', sectionHref: '/observe', page: 'Live sessions' };
  if (pathname.startsWith('/observe/health')) return { section: 'Observe', sectionHref: '/observe', page: 'Service health' };
  if (pathname.startsWith('/observe/slos')) return { section: 'Observe', sectionHref: '/observe', page: 'SLOs' };
  if (pathname.startsWith('/observe/dependencies')) return { section: 'Observe', sectionHref: '/observe', page: 'Dependency map' };
  if (pathname.startsWith('/observe/alerts')) return { section: 'Observe', sectionHref: '/observe', page: 'Alerts' };
  if (pathname.startsWith('/observe/audit')) return { section: 'Observe', sectionHref: '/observe', page: 'Audit & reports' };
  if (pathname.startsWith('/observe/logs')) return { section: 'Observe', sectionHref: '/observe', page: 'Logs & traces' };
  if (pathname.startsWith('/observe/quality')) return { section: 'Observe', sectionHref: '/observe', page: 'Quality Inbox' };
  if (pathname.startsWith('/observe')) return { section: 'Operate', sectionHref: '/runs', page: 'Observe' };
  if (pathname.startsWith('/connections')) return { section: 'Settings', sectionHref: '/settings', page: 'Identity & access' };
  if (pathname.startsWith('/settings/api-keys')) return { section: 'Settings', sectionHref: '/settings', page: 'API keys' };
  if (pathname.startsWith('/settings/models')) return { section: 'Settings', sectionHref: '/settings', page: 'AI providers & models' };
  if (pathname.startsWith('/settings/users')) return { section: 'Settings', sectionHref: '/settings', page: 'Users & roles' };
  if (pathname.startsWith('/settings/readiness')) return { section: 'Settings', sectionHref: '/settings', page: 'Platform readiness' };
  if (pathname.startsWith('/settings/platform')) return { section: 'Settings', sectionHref: '/settings', page: 'Platform configuration' };
  if (pathname.startsWith('/settings')) return { section: 'Workspace', sectionHref: '/home', page: 'Settings' };
  return { section: 'Workspace', sectionHref: '/home', page: 'Home' };
}

function readTheme(): 'dark' | 'light' {
  try {
    return localStorage.getItem('argus-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function platformShortcutLabel(platform = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K';
}

export function AppShell({ children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const workflowStudio = location.pathname.startsWith('/build/workflows/studio');
  const [theme, setTheme] = useState<'dark' | 'light'>(readTheme);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('argus-console-collapsed') === '1'; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  // The Overview joins live health checks and telemetry. Do not let that
  // operational work delay the role-aware shell or make navigation flicker.
  const session = useQuery({ queryKey: ['console-session'], queryFn: getConsoleUser, staleTime: 5 * 60_000 });
  const navigationCapabilities = useQuery({
    queryKey: ['console-navigation-capabilities'],
    queryFn: getConsoleNavigationCapabilities,
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Subscribe to an Overview fetched by the active page for the optional
  // approval badge, but never start that expensive request from the shell.
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, staleTime: 15_000, enabled: false });
  const canAdmin = navigationCapabilities.data?.navigation.canAdminPlatform ?? isPlatformAdminRole(session.data?.role);
  const approvalCount = overview.data?.stats.workflowsInReview ?? 0;
  const pageContext = getPageContext(location.pathname);
  const shortcutLabel = platformShortcutLabel();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('argus-theme', theme); } catch { /* storage is optional */ }
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem('argus-console-collapsed', collapsed ? '1' : '0'); } catch { /* storage is optional */ }
  }, [collapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen(value => !value);
      }
      if (event.key === 'Escape') setCommandOpen(false);
      if (event.key === 'Escape') setQuickCreateOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className={`app-shell workspace-shell${collapsed ? ' is-collapsed' : ''}${workflowStudio ? ' is-workflow-studio' : ''}`}>
      <WorkspaceSidebar
        user={session.data}
        canAdmin={canAdmin}
        capabilities={navigationCapabilities.data}
        approvalCount={approvalCount}
        pathname={location.pathname}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggleCollapsed={() => setCollapsed(value => !value)}
        onOpenMobile={() => setMobileOpen(true)}
        onCloseMobile={() => setMobileOpen(false)}
        onNavigate={navigate}
      />

      <div className="app-stage">
        <header className="topbar">
          <div className="topbar-main">
            <div className="topbar-context" aria-label={`${pageContext.section}, ${pageContext.page}`}>
              {pageContext.sectionHref
                ? <Link to={pageContext.sectionHref}>{pageContext.section}</Link>
                : <span>{pageContext.section}</span>}
              <ChevronRight size={13} />
              <b>{pageContext.page}</b>
            </div>
            <button className="command-search" type="button" aria-label="Open command palette" onClick={() => setCommandOpen(true)}>
              <Search size={17} />
              <span>Search workspace</span>
              <kbd>{shortcutLabel}</kbd>
            </button>
          </div>
          <div className="topbar-actions">
            <span className="environment-pill"><i />Local</span>
            <a className="topbar-icon" href="/chat" aria-label="Open agent chat"><MessageSquare size={18} /></a>
            <button
              className="topbar-icon"
              type="button"
              aria-label="Open quick create"
              aria-haspopup="dialog"
              aria-expanded={quickCreateOpen}
              onClick={() => setQuickCreateOpen(true)}
            >
              <Plus size={18} />
            </button>
            <button
              className="topbar-icon"
              type="button"
              aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
              onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <a className="topbar-icon desktop-only" href="/api-docs" aria-label="Open API explorer"><Boxes size={18} /></a>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>

      {commandOpen && (
        <GlobalSearchDialog
          capabilities={navigationCapabilities.data}
          canAdmin={canAdmin}
          onClose={() => setCommandOpen(false)}
        />
      )}

      {quickCreateOpen && <QuickCreateDialog canAdmin={canAdmin} onClose={() => setQuickCreateOpen(false)} />}
    </div>
  );
}
