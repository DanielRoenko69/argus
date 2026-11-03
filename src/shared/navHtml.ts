import type { SessionUser } from '../auth/userAuth.js';

export type NavPage =
  | 'overview' | 'servers' | 'tools' | 'bundles' | 'marketplace'
  | 'activity' | 'logs'    | 'metrics'
  | 'workflows'| 'workflow-builder' | 'settings'
  | 'agents' | 'agent-overview' | 'agent-list' | 'rag-indexes' | 'skills'
  | 'api-keys'
  | 'platform-settings'
  | 'user-policies'
  | 'group-policies'
  | 'activity-live'
  | 'platform-config'
  | 'design-showcase'
  | 'connections'
  | 'public-widgets'
  | 'external';

export interface SidebarBadges {
  servers?: number;
  tools?: number;
  bundles?: number;
  // AI Agents
  agents?: number;
  rags?: number;
  skills?: number;
}

// ── SVG Icons (16×16) ────────────────────────────────────────

const ICONS: Record<string, string> = {
  overview:    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="9" y="1" width="6" height="6" rx="1.5" fill="currentColor" opacity=".5"/><rect x="1" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity=".5"/><rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity=".5"/></svg>`,
  servers:     `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="4" rx="1.5" stroke="currentColor" stroke-width="1.4"/><rect x="1" y="10" width="14" height="4" rx="1.5" stroke="currentColor" stroke-width="1.4"/><circle cx="12.5" cy="4" r="1" fill="currentColor"/><circle cx="12.5" cy="12" r="1" fill="currentColor"/></svg>`,
  tools:       `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10.5 2a3.5 3.5 0 0 1 .7 5.7L5.7 13.2a1.8 1.8 0 0 1-2.5-2.5l5.5-5.5A3.5 3.5 0 0 1 10.5 2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  routes:      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4h7M14 4l-3-2.5M14 4l-3 2.5M14 12H7M2 12l3-2.5M2 12l3 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  bundles:     `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l6 3v6l-6 3-6-3v-6l6-3Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 1.5v13M2 4.5l6 3 6-3" stroke="currentColor" stroke-width="1.3"/></svg>`,
  marketplace: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 2h12l-1.5 5H3.5L2 2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="5.5" cy="13" r="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="13" r="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 7v4h8V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  activity:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8h2.5l2-5 3 10 2-6 1.5 3H15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  logs:      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="1.5" width="12" height="13" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5 5.5h6M5 8.5h6M5 11.5h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  metrics:   `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 13l4-5 3 3 3-7 3 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  workflows: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/><circle cx="13" cy="3.5" r="2" stroke="currentColor" stroke-width="1.3"/><circle cx="13" cy="12.5" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M5 7.2l3.5-2.5M5 8.8l3.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  docs:      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="1" width="11" height="14" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 5h5M5.5 8h5M5.5 11h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  settings:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  agents:    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="12.5" cy="9.5" r="1.5" fill="currentColor" opacity=".7"/></svg>`,
  rag:       `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5 7h6M5 9.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="12" cy="3" r="2" fill="currentColor" opacity=".6"/></svg>`,
  skills:    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5L10 6h4.5l-3.6 2.6 1.4 4.4L8 10.5l-4.3 2.5 1.4-4.4L1.5 6H6L8 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  chat:      `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 2h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5l-3 3V3a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  canvas:    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="4" width="5" height="4" rx="1.5" stroke="currentColor" stroke-width="1.3"/><rect x="10" y="4" width="5" height="4" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M6 6h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><rect x="5" y="10" width="6" height="4" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 8v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  agent_builder: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.3"/><path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12 2l1.5 1.5L12 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  logout:    `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M11 11l3-3-3-3M15 8H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  plus:      `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  arrow:     `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  shield:    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l6 2.5v4c0 3.5-2.5 6.5-6 7.5-3.5-1-6-4-6-7.5V4l6-2.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M5.5 8l2 2 3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  graph:     `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="3.5" r="2" stroke="currentColor" stroke-width="1.3"/><circle cx="13" cy="3.5" r="2" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="13" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.7l3 7M11.5 4.7l-3 7M5 3.5h6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
};

// ── Nav sections ─────────────────────────────────────────────

interface NavItem {
  page: NavPage;
  href: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
  badgeKey?: keyof SidebarBadges;
  external?: boolean;
}

interface NavSubGroup {
  label: string;
  icon: string;
  id: string;
  items: NavItem[];
}

interface NavSection {
  label: string;
  items: NavItem[];
  subGroups?: NavSubGroup[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Control Plane',
    items: [
      { page: 'overview',          href: '/home',                         label: 'Overview',    icon: 'overview' },
      { page: 'bundles',           href: '/mcp-fabric',                   label: 'Bundles',     icon: 'bundles',     adminOnly: true, badgeKey: 'bundles' },
      { page: 'servers',           href: '/mcp-fabric',                   label: 'Backends',    icon: 'servers',     adminOnly: true, badgeKey: 'servers' },
      { page: 'tools',             href: '/mcp-fabric',                   label: 'Tools',       icon: 'tools',                        badgeKey: 'tools' },
      { page: 'skills',            href: '/build/skills',                 label: 'Skills',      icon: 'skills',  badgeKey: 'skills' },
      { page: 'marketplace',       href: '/build/workflows',              label: 'Catalog',     icon: 'marketplace', adminOnly: true },
      { page: 'api-keys',          href: '/settings/api-keys',             label: 'API Keys',    icon: 'keys',        adminOnly: true },
    ],
  },
  {
    label: 'AI Agents',
    items: [
      { page: 'agent-overview', href: '/build/agents', label: 'Overview', icon: 'overview' },
      { page: 'agents',         href: '/agents',           label: 'Chat',    icon: 'chat'    },
      { page: 'agent-list',     href: '/build/agents/manage',      label: 'Agents',  icon: 'agents',  badgeKey: 'agents' },
      { page: 'activity-live',  href: '/observe/activity', label: 'Live Activity', icon: 'activity' },
      { page: 'rag-indexes',    href: '/build/knowledge',          label: 'Knowledge',        icon: 'rag',      badgeKey: 'rags' },
      { page: 'workflow-builder', href: '/build/workflows/studio', label: 'Workflow Builder', icon: 'workflows' },
      { page: 'external',       href: 'https://smith.langchain.com/studio?baseUrl=http://localhost:2025', label: 'LangGraph', icon: 'canvas', external: true },
    ],
  },
  {
    label: 'Monitoring',
    items: [
      { page: 'activity', href: '/observe/audit',  label: 'Activity', icon: 'activity' },
      { page: 'logs',     href: '/observe/logs',   label: 'Logs',     icon: 'logs' },
      { page: 'metrics',  href: '/observe',        label: 'Metrics',  icon: 'metrics' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { page: 'platform-config',   href: '/settings/platform',               label: 'Platform Config',    icon: 'settings', adminOnly: true },
      { page: 'user-policies',     href: '/governance/policies',             label: 'User Policies',      icon: 'shield',   adminOnly: true },
      { page: 'group-policies',    href: '/governance/policies',             label: 'Group Policies',     icon: 'shield',   adminOnly: true },
      { page: 'public-widgets',    href: '/build/public-widgets',            label: 'Public Widgets',     icon: 'chat',     adminOnly: true },
      { page: 'connections',       href: '/connections',                      label: 'My Connections',     icon: 'shield' },
      { page: 'external',          href: '/api-docs',                         label: 'API Explorer', icon: 'docs' },
      { page: 'external',          href: 'http://localhost:5678/',            label: 'n8n',       icon: 'workflows', external: true },
      { page: 'external',          href: 'http://localhost:3100/',            label: 'Langfuse',  icon: 'activity',  external: true },
    ],
  },
];

function renderNavItem(item: NavItem, activePage: NavPage, badges: SidebarBadges, user?: SessionUser): string {
  // adminOnly: visible for platform and operations admins (plus legacy 'admin').
  if (item.adminOnly && user?.role !== 'admin' && user?.role !== 'platform_admin' && user?.role !== 'operations_admin') return '';
  const isActive = item.page === activePage;
  // Always render badge span (even empty); JS fills it; CSS hides :empty spans
  const badge = item.badgeKey
    ? `<span class="nav-badge" data-badge="${item.badgeKey}">${badges[item.badgeKey] ?? ''}</span>`
    : '';
  const externalAttrs = item.external ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a href="${item.href}"${externalAttrs} class="nav-item${isActive ? ' active' : ''}" data-page="${item.page}">
      <span class="nav-icon">${ICONS[item.icon] ?? ''}</span>
      <span class="nav-label">${item.label}${item.external ? ' <svg width="10" height="10" viewBox="0 0 16 16" fill="none" style="opacity:.5;flex-shrink:0"><path d="M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3M9 2h5v5M8.5 7.5L14 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</span>
      ${badge}
    </a>`;
}

function renderNavSubGroup(sub: NavSubGroup, activePage: NavPage, badges: SidebarBadges, user?: SessionUser): string {
  const items = sub.items.map(i => renderNavItem(i, activePage, badges, user)).filter(Boolean).join('');
  if (!items) return '';
  const hasActive = sub.items.some(i => i.page === activePage);
  return `<div class="nav-sub-group${hasActive ? ' open' : ''}" data-sub-id="${sub.id}">
      <button class="nav-sub-toggle" type="button">
        <span class="nav-icon">${ICONS[sub.icon] ?? ''}</span>
        <span class="nav-label">${sub.label}</span>
        <svg class="nav-sub-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 3.5l2.5 3 2.5-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="nav-sub-items">${items}</div>
    </div>`;
}

function renderNavSection(section: NavSection, activePage: NavPage, badges: SidebarBadges, user?: SessionUser): string {
  const items = section.items
    .map(i => renderNavItem(i, activePage, badges, user))
    .filter(Boolean)
    .join('');
  const subGroupsHtml = (section.subGroups ?? [])
    .map(sg => renderNavSubGroup(sg, activePage, badges, user))
    .join('');
  if (!items && !subGroupsHtml) return '';
  const sectionId = section.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // Mark the section containing the active page as 'open' so it is never
  // restored-to-collapsed on load (you navigated into it → it should show).
  const hasActive = section.items.some(i => i.page === activePage)
    || (section.subGroups ?? []).some(sg => sg.items.some(i => i.page === activePage));
  return `<div class="nav-section${hasActive ? ' open' : ''}" data-section-id="${sectionId}">
      <button class="nav-section-label" type="button">
        <span>${section.label}</span>
        <svg class="nav-section-chevron" width="9" height="9" viewBox="0 0 10 10" fill="none"><path d="M2.5 3.5l2.5 3 2.5-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="nav-group">${items}${subGroupsHtml}</div>
    </div>`;
}

// ── Shell ────────────────────────────────────────────────────

export interface PageShellOptions {
  activePage: NavPage;
  title: string;
  content: string;
  user?: SessionUser;
  badges?: SidebarBadges;
  styles?: string;
  scripts?: string;
}

export function renderPageShell(opts: PageShellOptions): string {
  const { activePage, title, content, user, badges = {}, styles = '', scripts = '' } = opts;

  const navSections = NAV_SECTIONS
    .map(s => renderNavSection(s, activePage, badges, user))
    .join('<div class="nav-divider"></div>');

  const userHtml = user
    ? `<div class="sidebar-user">
        <div class="sidebar-user-avatar">${esc((user.display_name || user.username).charAt(0))}</div>
        <div class="sidebar-user-info">
          <span class="sidebar-user-name">${esc(user.display_name || user.username)}</span>
          <span class="sidebar-user-role">${esc(user.role)}</span>
        </div>
        <form method="POST" action="/auth/logout" style="display:inline">
          <button type="submit" class="sidebar-logout" title="Abmelden">${ICONS.logout}</button>
        </form>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>${SHELL_CSS}${styles}</style>
  <script>try{if(localStorage.getItem('nav-rail-collapsed')==='1')document.documentElement.classList.add('nav-rail');document.documentElement.dataset.theme=localStorage.getItem('argus-theme')||'dark';}catch(e){}</script>
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-header">
        <a href="/status" class="sidebar-logo">
          <img src="/assets/logo.png" alt="Argus" class="sidebar-logo-img" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
          <span class="sidebar-logo-fallback">Argus</span>
        </a>
        <div class="sidebar-header-right">
          <span class="sidebar-live" title="Server online"></span>
          <button type="button" class="sidebar-collapse-btn" aria-label="Seitenleiste ein-/ausklappen" aria-pressed="false" title="Seitenleiste ein-/ausklappen">
            <svg class="sidebar-collapse-icon" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M9.5 3.5L5 8l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 3.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="sidebar-nav">
        ${navSections}
        <div class="nav-spacer"></div>
      </div>
      <button class="sidebar-theme" id="shell-theme-toggle" type="button" aria-label="Darstellung wechseln">
        <span class="sidebar-theme-sun">☼</span><span class="sidebar-theme-moon">◐</span>
        <span class="sidebar-theme-label">Light theme</span>
      </button>
      ${userHtml}
    </nav>
    <main class="main-content">
      ${content}
    </main>
  </div>
  <div class="rail-tip" role="tooltip" aria-hidden="true"></div>
  ${scripts}
<script>
  // ── Nav badges: fetch counts and keep sidebar in sync ──────
  (function() {
    fetch('/api/nav/badges', { credentials: 'same-origin' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d) return;
        document.querySelectorAll('.nav-badge[data-badge]').forEach(function(el) {
          var key = el.getAttribute('data-badge');
          if (d[key] != null) el.textContent = d[key];
        });
      })
      .catch(function() {});
  })();

  // ── setNavActive: let pages update the sidebar active item ──
  window.setNavActive = function(page) {
    document.querySelectorAll('.nav-item').forEach(function(el) {
      var isActive = el.getAttribute('data-page') === page;
      el.classList.toggle('active', isActive);
    });
    // Auto-expand sub-group if active item is inside it
    document.querySelectorAll('.nav-sub-group').forEach(function(sg) {
      var hasActive = sg.querySelector('.nav-item.active');
      if (hasActive) sg.classList.add('open');
    });
  };

  // ── Global dark/light theme ────────────────────────────────
  (function() {
    var button = document.getElementById('shell-theme-toggle');
    var label = button && button.querySelector('.sidebar-theme-label');
    function apply(theme) {
      document.documentElement.dataset.theme = theme;
      if (label) label.textContent = theme === 'light' ? 'Dark theme' : 'Light theme';
      try { localStorage.setItem('argus-theme', theme); } catch (e) {}
    }
    apply(document.documentElement.dataset.theme || 'dark');
    if (button) button.addEventListener('click', function() {
      apply(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });
  })();

  // ── Nav sub-group toggles ──
  document.querySelectorAll('.nav-sub-toggle').forEach(function(btn) {
    var group = btn.parentElement;
    var id = group && group.dataset.subId;
    // Restore from localStorage (unless active item forces open)
    if (id && !group.classList.contains('open')) {
      var stored = localStorage.getItem('nav-sub-' + id);
      if (stored === 'open') group.classList.add('open');
    }
    btn.addEventListener('click', function() {
      var isOpen = group.classList.toggle('open');
      if (id) localStorage.setItem('nav-sub-' + id, isOpen ? 'open' : 'closed');
    });
  });

  // ── Top-level section collapse toggles (default open; persisted) ──
  document.querySelectorAll('.nav-section-label').forEach(function(btn) {
    var section = btn.parentElement;
    var id = section && section.dataset.sectionId;
    // Restore collapsed state — unless this section holds the active page (server marks it .open).
    if (id && !section.classList.contains('open')) {
      if (localStorage.getItem('nav-section-' + id) === 'collapsed') section.classList.add('collapsed');
    }
    btn.addEventListener('click', function() {
      var collapsed = section.classList.toggle('collapsed');
      if (id) localStorage.setItem('nav-section-' + id, collapsed ? 'collapsed' : 'open');
    });
  });

  // ── Full sidebar rail collapse (icon-only). State on <html> (set FOUC-free in <head>), persisted. ──
  (function() {
    var root = document.documentElement;
    var btn = document.querySelector('.sidebar-collapse-btn');
    var tip = document.querySelector('.rail-tip');

    function syncState(collapsed) {
      if (btn) btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      if (!collapsed && tip) tip.classList.remove('show');
    }
    syncState(root.classList.contains('nav-rail'));

    // Rail mode hides the .nav-label visually (it stays in the a11y tree as the accessible name).
    // Surface it as a flyout on hover AND keyboard focus so sighted/keyboard users can read it.
    function showTip(el) {
      if (!tip || !root.classList.contains('nav-rail')) return;
      var lbl = el.querySelector('.nav-label');
      if (!lbl) return;
      var r = el.getBoundingClientRect();
      tip.textContent = lbl.textContent.trim();
      tip.style.top = (r.top + r.height / 2) + 'px';
      tip.style.left = (r.right + 8) + 'px';
      tip.classList.add('show');
    }
    function hideTip() { if (tip) tip.classList.remove('show'); }
    document.querySelectorAll('.sidebar .nav-item').forEach(function(el) {
      el.addEventListener('mouseenter', function() { showTip(el); });
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('focus', function() { showTip(el); });
      el.addEventListener('blur', hideTip);
    });

    if (btn) btn.addEventListener('click', function() {
      var collapsed = root.classList.toggle('nav-rail');
      try { localStorage.setItem('nav-rail-collapsed', collapsed ? '1' : '0'); } catch (e) {}
      syncState(collapsed);
    });
  })();
</script>
</body>
</html>`;
}

// ── Design System CSS ────────────────────────────────────────

/** CSS custom properties — importable by standalone pages (e.g. loginPage) that don't use renderPageShell */
export const CSS_VARS = `
  :root {
    --bg:           #080b12;
    --bg-sidebar:   #0b1019;
    --bg-card:      #0e1420;
    --bg-card-2:    #121a28;
    --bg-input:     #0b111c;
    --border:       #1d293b;
    --border-mid:   #2a384d;
    --text:         #e9eef8;
    --text-muted:   #8d98aa;
    --text-dim:     #566176;
    --green:        #48d7c8;
    --green-dim:    #238a7e;
    --blue:         #5fa8ff;
    --orange:       #f6c66c;
    --red:          #ff7383;
    --accent:       #8b7cff;
    --accent-light: #aa9fff;
    --accent-glow:  rgba(139,124,255,.1);
    --accent-glow2: rgba(139,124,255,.18);
    --sidebar-w:    212px;
  }
  :root[data-theme="light"] {
    --bg:           #f5f7fb;
    --bg-card:      #ffffff;
    --bg-card-2:    #f7f8fb;
    --bg-input:     #ffffff;
    --border:       #dde3ee;
    --border-mid:   #cbd3e1;
    --text:         #171a22;
    --text-muted:   #697386;
    --text-dim:     #99a3b3;
    --accent-glow:  rgba(139,124,255,.08);
    --accent-glow2: rgba(139,124,255,.14);
  }
`;

const SHELL_CSS = `
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  ${CSS_VARS}

  html, body { height: 100%; }
  body { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; font-size: 13px; }
  html[data-theme="light"] .sidebar {
    --bg-sidebar: #0b1019;
    --bg-card: #0e1420;
    --bg-card-2: #121a28;
    --border: #1d293b;
    --border-mid: #2a384d;
    --text: #e9eef8;
    --text-muted: #8d98aa;
    --text-dim: #566176;
  }

  /* ── Layout ── */
  .layout { display: flex; height: 100vh; }

  /* ── Sidebar ── */
  .sidebar { width: var(--sidebar-w); min-width: var(--sidebar-w); background: var(--bg-sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }

  .sidebar-header { padding: 14px 12px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .sidebar-logo { display: flex; align-items: center; text-decoration: none; min-width: 0; }
  .sidebar-logo-img { height: 36px; width: auto; max-width: 172px; object-fit: contain; display: block; }
  .sidebar-logo-fallback { font-size: 13px; font-weight: 700; color: var(--text); letter-spacing: -0.01em; display: none; }
  .sidebar-live { width: 6px; height: 6px; border-radius: 50%; background: var(--green); flex-shrink: 0; animation: pulse-live 2.5s ease-in-out infinite; }
  @keyframes pulse-live { 0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(63,185,80,.5)} 60%{opacity:.8;box-shadow:0 0 0 4px rgba(63,185,80,0)} }
  .sidebar-header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .sidebar-collapse-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 3px; border-radius: 4px; display: flex; align-items: center; transition: color 0.12s, background 0.12s; }
  .sidebar-collapse-btn:hover { color: var(--text-muted); background: rgba(255,255,255,0.05); }
  .sidebar-collapse-icon { transition: transform 0.2s; }

  /* ── Sidebar rail (icon-only) collapse — toggled via html.nav-rail, persisted in localStorage ── */
  .sidebar { transition: width 0.18s ease, min-width 0.18s ease; }
  html.nav-rail .sidebar { width: 56px; min-width: 56px; }
  html.nav-rail .sidebar-collapse-icon { transform: rotate(180deg); }
  html.nav-rail .sidebar-logo, html.nav-rail .sidebar-live { display: none; }
  html.nav-rail .sidebar-header { justify-content: center; padding: 14px 8px 12px; }
  html.nav-rail .nav-badge, html.nav-rail .nav-section-label, html.nav-rail .nav-sub-chevron { display: none; }
  /* Keep the label in the a11y tree as the accessible name — just visually hidden — so screen readers still name each icon. */
  html.nav-rail .nav-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  html.nav-rail .nav-item, html.nav-rail .nav-sub-toggle { justify-content: center; gap: 0; padding: 7px 0; }
  html.nav-rail .nav-item.active { padding-left: 0; }                 /* keep the border-left active marker */
  html.nav-rail .nav-sub-toggle { display: none; }                   /* drop group headers in rail mode */
  html.nav-rail .nav-sub-items { display: flex !important; padding-left: 0; }      /* surface all leaf icons */
  html.nav-rail .nav-section .nav-group { display: flex !important; }             /* override per-section collapse while in rail */
  html.nav-rail .nav-icon { width: 16px; height: 16px; }
  html.nav-rail .sidebar-user { flex-direction: column; gap: 6px; padding: 8px 6px; }
  html.nav-rail .sidebar-user-info { display: none; }
  html.nav-rail .sidebar-nav { padding-top: 8px; }   /* restore breathing room lost with the hidden section labels */
  /* Rail flyout label — position:fixed escapes the sidebar overflow clip; shown on hover AND keyboard focus (JS, rail-only) */
  .rail-tip { position: fixed; z-index: 200; transform: translateY(-50%); background: var(--bg-card-2); color: var(--text); border: 1px solid var(--border-mid); border-radius: 5px; padding: 4px 9px; font-size: 12px; line-height: 1.3; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.1s; box-shadow: 0 4px 14px rgba(0,0,0,0.45); }
  .rail-tip.show { opacity: 1; }

  /* ── Nav ── */
  .sidebar-nav { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 0; scrollbar-width: none; }
  .sidebar-nav::-webkit-scrollbar { display: none; }
  .nav-spacer { flex: 1; }
  .nav-divider { height: 1px; background: var(--border); margin: 4px 6px; }
  .nav-section { margin-bottom: 4px; }
  .nav-section-label { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; background: none; border: none; cursor: pointer; font-family: inherit; font-size: 10px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; padding: 10px 8px 4px; text-align: left; transition: color 0.1s; }
  .nav-section-label:hover { color: var(--text-muted); }
  .nav-section-chevron { flex-shrink: 0; color: var(--text-dim); opacity: .8; transition: transform 0.2s; }
  .nav-section.collapsed .nav-section-chevron { transform: rotate(-90deg); }
  .nav-section.collapsed .nav-group { display: none; }
  .nav-group { display: flex; flex-direction: column; gap: 1px; }

  .nav-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px; color: var(--text-muted); text-decoration: none; font-size: 12.5px; transition: background 0.1s, color 0.1s; white-space: nowrap; position: relative; border-left: 2px solid transparent; }
  .nav-item:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .nav-item.active { color: var(--text); background: var(--accent-glow); border-left-color: var(--accent); padding-left: 6px; }
  .nav-item.active .nav-icon { color: var(--accent-light); }
  .nav-item.active .nav-label { font-weight: 500; }
  .nav-icon { display: flex; align-items: center; flex-shrink: 0; color: var(--text-dim); opacity: .7; transition: color 0.1s; width: 15px; height: 15px; }
  .nav-item.active .nav-icon { opacity: 1; }
  .nav-item:hover .nav-icon { color: var(--text-muted); opacity: .85; }
  .nav-label { flex: 1; }
  .nav-badge { font-size: 10px; background: var(--border-mid); color: var(--text-muted); padding: 1px 6px; border-radius: 8px; min-width: 18px; text-align: center; font-weight: 500; line-height: 1.4; }
  .nav-item.active .nav-badge { background: var(--accent-glow2); color: var(--accent-light); }
  .nav-badge:empty { display: none; }

  /* ── Nav group labels (subgroup headers within sections) ── */
  .nav-group-label { font-size: 10px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; padding: 8px 8px 4px; margin-top: 6px; user-select: none; }
  .nav-group-label:first-of-type { margin-top: 2px; }

  /* ── Nav sub-groups (collapsible) ── */
  .nav-sub-group { margin-top: 1px; }
  .nav-sub-toggle { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px; color: var(--text-muted); background: none; border: none; cursor: pointer; font-size: 12.5px; font-family: inherit; width: 100%; text-align: left; transition: background 0.1s, color 0.1s; white-space: nowrap; }
  .nav-sub-toggle:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .nav-sub-toggle .nav-icon { color: var(--text-dim); opacity: .7; }
  .nav-sub-toggle .nav-label { flex: 1; }
  .nav-sub-chevron { flex-shrink: 0; color: var(--text-dim); transition: transform 0.2s; }
  .nav-sub-group.open > .nav-sub-toggle .nav-sub-chevron { transform: rotate(180deg); }
  .nav-sub-group.open > .nav-sub-toggle { color: var(--text-muted); }
  .nav-sub-items { display: none; flex-direction: column; gap: 1px; padding-left: 10px; }
  .nav-sub-group.open > .nav-sub-items { display: flex; }
  .nav-sub-items .nav-item { font-size: 12px; }

  /* ── Sidebar user footer ── */
  .sidebar-user { padding: 8px 10px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 8px; background: var(--bg-sidebar); }
  .sidebar-theme { margin: 0 8px 8px; width: calc(100% - 16px); display: flex; align-items: center; justify-content: center; gap: 7px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--text-muted); font: inherit; font-size: 11px; cursor: pointer; }
  .sidebar-theme:hover { color: var(--text); border-color: var(--border-mid); background: rgba(255,255,255,.03); }
  .sidebar-theme-moon { display: none; }
  html[data-theme="light"] .sidebar-theme-sun { display: none; }
  html[data-theme="light"] .sidebar-theme-moon { display: inline; }
  html.nav-rail .sidebar-theme-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  html.nav-rail .sidebar-theme { width: 36px; margin-left: 10px; margin-right: 10px; padding-left: 0; padding-right: 0; }
  .sidebar-user-avatar { width: 24px; height: 24px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; flex-shrink: 0; text-transform: uppercase; }
  .sidebar-user-info { flex: 1; min-width: 0; }
  .sidebar-user-name { display: block; font-size: 12px; color: var(--text); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sidebar-user-role { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
  .sidebar-logout { background: none; border: 1px solid var(--border-mid); color: var(--text-muted); border-radius: 4px; padding: 3px 5px; cursor: pointer; display: flex; align-items: center; transition: color 0.12s, border-color 0.12s; flex-shrink: 0; }
  .sidebar-logout:hover { color: var(--red); border-color: rgba(248,81,73,.5); }

  /* ── Main content ── */
  .main-content { flex: 1; overflow-y: auto; padding: 24px 28px; min-width: 0; }

  /* ── Page header ── */
  .page-header { margin-bottom: 20px; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .page-header-left {}
  .page-title { font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 3px; letter-spacing: -0.02em; }
  .page-subtitle { font-size: 12px; color: var(--text-muted); }

  /* ── Stat cards ── */
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
  @media (max-width: 900px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }
  .stat-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; position: relative; overflow: hidden; transition: border-color 0.15s; }
  .stat-card:hover { border-color: var(--border-mid); }
  .stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; }
  .stat-card.accent-purple::before { background: linear-gradient(90deg, var(--accent), var(--accent-light)); }
  .stat-card.accent-green::before  { background: linear-gradient(90deg, #238636, #3fb950); }
  .stat-card.accent-blue::before   { background: linear-gradient(90deg, #1f6feb, #58a6ff); }
  .stat-card.accent-orange::before { background: linear-gradient(90deg, #9e6a03, var(--orange)); }
  .stat-card-label { font-size: 10.5px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 7px; font-weight: 600; }
  .stat-card-value { font-size: 28px; font-weight: 800; line-height: 1; letter-spacing: -0.03em; }
  .stat-card-sub { font-size: 11px; color: var(--text-dim); margin-top: 5px; }
  .stat-purple { color: var(--accent-light); }
  .stat-green  { color: var(--green); }
  .stat-blue   { color: var(--blue); }
  .stat-orange { color: var(--orange); }

  /* ── Info card row ── */
  .info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
  @media (max-width: 900px) { .info-grid { grid-template-columns: 1fr; } }

  /* ── Cards ── */
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .card-title { font-size: 12px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 6px; }
  .card-title-icon { color: var(--text-dim); display: flex; }
  .card-count { font-size: 10.5px; color: var(--text-muted); background: var(--border-mid); padding: 1px 7px; border-radius: 8px; }

  /* ── Backend / Agent grid cards ── */
  .backend-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 0.85rem; }
  .backend-card { background: var(--bg-card-2, var(--bg-card)); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
  .backend-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
  .backend-card-name { font-size: 0.9rem; font-weight: 600; color: var(--text); }
  .backend-card-meta { font-size: 0.78rem; color: var(--text-dim); margin-top: 0.2rem; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
  .backend-card-actions { display: flex; gap: 0.4rem; margin-top: 0.75rem; }

  /* ── Badges ── */
  .badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; padding: 2px 7px; border-radius: 4px; font-weight: 500; white-space: nowrap; }
  .badge-green  { background: rgba(63,185,80,.1);   color: var(--green); }
  .badge-red    { background: rgba(248,81,73,.1);   color: var(--red); }
  .badge-orange { background: rgba(232,147,42,.1);  color: var(--orange); }
  .badge-gray   { background: rgba(85,85,85,.15);   color: var(--text-muted); }
  .badge-blue   { background: rgba(88,166,255,.1);  color: var(--blue); }
  .badge-purple { background: var(--accent-glow2);  color: var(--accent-light); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; flex-shrink: 0; }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--text-muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; padding: 8px 12px; border-bottom: 1px solid var(--border); font-weight: 600; background: rgba(0,0,0,.15); }
  td { padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 12.5px; vertical-align: middle; color: var(--text); }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: rgba(255,255,255,0.02); }

  /* ── Buttons ── */
  .btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: 6px; font-size: 12px; font-family: inherit; cursor: pointer; border: 1px solid transparent; transition: all 0.12s; text-decoration: none; font-weight: 500; }
  .btn-primary  { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn-primary:hover  { background: #6d28d9; border-color: #6d28d9; }
  .btn-success  { background: var(--green-dim); color: #fff; border-color: var(--green-dim); }
  .btn-success:hover  { background: var(--green); border-color: var(--green); }
  .btn-secondary{ background: var(--bg-card-2); color: var(--text); border-color: var(--border-mid); }
  .btn-secondary:hover{ border-color: var(--text-muted); }
  .btn-danger   { background: transparent; color: var(--red); border-color: rgba(248,81,73,.3); }
  .btn-danger:hover   { background: rgba(248,81,73,.08); }
  .btn-ghost    { background: transparent; color: var(--text-muted); border-color: var(--border-mid); }
  .btn-ghost:hover    { background: rgba(255,255,255,.04); color: var(--text); }
  .btn-sm  { padding: 4px 10px; font-size: 11.5px; }
  .btn-icon{ padding: 5px; }

  /* ── Forms ── */
  input, select, textarea { background: var(--bg-input); color: var(--text); border: 1px solid var(--border-mid); border-radius: 6px; padding: 6px 10px; font-size: 12.5px; font-family: inherit; width: 100%; transition: border-color 0.12s; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
  label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px; }
  .form-group { margin-bottom: 12px; }

  /* ── Code / Mono ── */
  code, .mono { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', Monaco, monospace; }
  code { background: rgba(124,58,237,.1); color: var(--accent-light); padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.8em; }

  /* ── Misc ── */
  .empty-state { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); font-size: 0.85rem; }
  .divider { height: 1px; background: var(--border); margin: 1rem 0; }

  /* ── Toast ── */
  .toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: 0.65rem 1rem; border-radius: 8px; font-size: 0.82rem; z-index: 999; display: none; max-width: 380px; backdrop-filter: blur(8px); }
  .toast.success { background: rgba(13,68,41,.9); color: #3fb950; border: 1px solid #2ea043; display: block; }
  .toast.error   { background: rgba(73,12,17,.9); color: #f85149; border: 1px solid #f85149; display: block; }
  .toast.info    { background: rgba(26,39,68,.9); color: #79b8ff; border: 1px solid #388bfd; display: block; }

  /* ── Overlay / Dialog ── */
  .overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 200; align-items: center; justify-content: center; backdrop-filter: blur(2px); }
  .overlay.active { display: flex; }
  .overlay-card { background: var(--bg-card-2); border: 1px solid var(--border-mid); border-radius: 12px; padding: 1.5rem; width: min(560px, 90vw); max-height: 88vh; overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,.5); display: flex; flex-direction: column; }
  .overlay-card-wide { width: min(680px, 92vw); }
  .overlay-card-extra { width: min(1100px, 95vw); }
  .overlay-card h3 { font-size: 1rem; font-weight: 600; margin-bottom: 1.1rem; color: var(--text); }
  .overlay-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; }
  .overlay-card form { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; }
  .form-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border); position: sticky; bottom: -1.5rem; background: var(--bg-card-2); padding-bottom: 0; z-index: 1; }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-mid); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }

  /* ── Animations ── */
  @keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
  .fade-in { animation: fadeIn 0.2s ease-out; }
  @keyframes spin { to{transform:rotate(360deg)} }
  .spin { animation: spin 0.8s linear infinite; display: inline-block; }
`;

// ── Backward-compat stubs ────────────────────────────────────

/** @deprecated Use renderPageShell */
export function renderNav(_p: string, _u?: SessionUser): string { return ''; }
/** @deprecated Use renderPageShell */
export const navCss = '';
/** @deprecated Use renderPageShell */
export function renderLogo(): string { return ''; }
/** @deprecated Use renderPageShell */
export const logoCss = '';

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
