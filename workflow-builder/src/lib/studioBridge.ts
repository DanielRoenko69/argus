import { useEffect } from 'react';

type ConsoleTheme = 'dark' | 'light';

interface StudioThemeMessage {
  type: 'argus:studio:theme';
  theme: ConsoleTheme;
}

const SAFE_CONSOLE_PATHS = ['/mcp-fabric', '/settings/models'];

const TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function studioParent(): Window | null {
  try {
    return window.parent !== window ? window.parent : null;
  } catch {
    return null;
  }
}

function isStudioThemeMessage(value: unknown): value is StudioThemeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StudioThemeMessage>;
  return candidate.type === 'argus:studio:theme'
    && (candidate.theme === 'dark' || candidate.theme === 'light');
}

function applyConsoleTheme(theme: ConsoleTheme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
  try { localStorage.setItem('argus-theme', theme); } catch { /* storage is optional */ }
}

function postToStudio(message: Record<string, unknown>): void {
  const parent = studioParent();
  if (!parent) return;
  parent.postMessage(message, window.location.origin);
}

export function isEmbeddedStudio(): boolean {
  return studioParent() !== null;
}

/**
 * Return to the canonical Console route after an integration was configured.
 * The Builder route is an implementation detail of the iframe and must never
 * become the top-level browser location.
 */
export function consoleStudioReturnPath(pathname = window.location.pathname, search = window.location.search): string {
  const match = /^\/workflows\/builder(?:\/(\d+))?\/?$/.exec(pathname);
  if (!match) return `${pathname}${search}`;
  return `/build/workflows/studio${match[1] ? `/${match[1]}` : ''}${search}`;
}

/**
 * Leave the embedded Builder through its owning Console shell. Navigating the
 * iframe itself would render a second AppShell (sidebar + topbar) inside the
 * Workflow Studio. Only explicit same-origin control-plane destinations are
 * accepted by both sides of the bridge.
 */
export function navigateToConsolePath(path: string): void {
  let target: URL;
  try {
    target = new URL(path, window.location.origin);
  } catch {
    return;
  }
  if (target.origin !== window.location.origin
    || !SAFE_CONSOLE_PATHS.some(prefix => target.pathname === prefix || target.pathname.startsWith(`${prefix}/`))) return;
  const next = `${target.pathname}${target.search}${target.hash}`;
  const parent = studioParent();
  if (parent) {
    parent.postMessage({ type: 'argus:builder:open-console', path: next }, window.location.origin);
    return;
  }
  window.location.assign(next);
}

export function navigateToWorkflowReplay(workflowId: number, traceId: string): void {
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0 || !TRACE_ID_PATTERN.test(traceId)) return;
  const parent = studioParent();
  if (parent) {
    parent.postMessage({ type: 'argus:builder:replay', workflowId, traceId }, window.location.origin);
    return;
  }
  const next = `/workflows/builder/${workflowId}?replay=${encodeURIComponent(traceId)}`;
  window.history.pushState({}, '', next);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useStudioBridge(workflowId: number | null): void {
  useEffect(() => {
    const parent = studioParent();
    if (!parent) return undefined;

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== parent) return;
      if (isStudioThemeMessage(event.data)) applyConsoleTheme(event.data.theme);
    };

    window.addEventListener('message', onMessage);
    postToStudio({ type: 'argus:builder:ready', workflowId });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (workflowId == null) return;
    postToStudio({ type: 'argus:builder:navigate', workflowId });
  }, [workflowId]);
}
