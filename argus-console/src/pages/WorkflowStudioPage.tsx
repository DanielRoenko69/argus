import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

type ConsoleTheme = 'dark' | 'light';

interface BuilderMessage {
  type: 'argus:builder:ready' | 'argus:builder:navigate' | 'argus:builder:replay' | 'argus:builder:exit' | 'argus:builder:open-console';
  workflowId?: unknown;
  traceId?: unknown;
  path?: unknown;
}

const TRACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CONSOLE_PATHS = ['/mcp-fabric', '/settings/models'];

function safeConsolePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin
    || !SAFE_CONSOLE_PATHS.some(prefix => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))) return null;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function builderSearch(search: string): string {
  const source = new URLSearchParams(search);
  const replay = source.get('replay')?.trim() ?? '';
  if (TRACE_ID_PATTERN.test(replay)) return `?replay=${encodeURIComponent(replay)}`;
  const execution = Number(source.get('execution'));
  return Number.isSafeInteger(execution) && execution > 0 ? `?execution=${execution}` : '';
}

function builderSource(workflowId?: string, search = ''): string {
  if (!workflowId) return '/workflows/builder';
  const parsed = Number(workflowId);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? `/workflows/builder/${parsed}${builderSearch(search)}`
    : '/workflows/builder';
}

export function WorkflowStudioPage() {
  const { workflowId } = useParams<{ workflowId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pathRef = useRef(location.pathname);
  const childSourceRef = useRef<string | null>(null);
  const src = builderSource(workflowId, location.search);

  pathRef.current = `${location.pathname}${location.search}`;

  const readTheme = useCallback((): ConsoleTheme => (
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  ), []);

  const sendTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: 'argus:studio:theme', theme: readTheme() },
      window.location.origin,
    );
  }, [readTheme]);

  useEffect(() => {
    if (childSourceRef.current === src) {
      childSourceRef.current = null;
      return;
    }
    setLoading(true);
  }, [src]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.origin !== window.location.origin || event.source !== frameWindow) return;
      if (!event.data || typeof event.data !== 'object') return;
      const message = event.data as Partial<BuilderMessage>;

      if (message.type === 'argus:builder:ready') {
        sendTheme();
        return;
      }
      if (message.type === 'argus:builder:exit') {
        pathRef.current = '/build/workflows';
        navigate('/build/workflows');
        return;
      }
      if (message.type === 'argus:builder:open-console') {
        const target = safeConsolePath(message.path);
        if (target) navigate(target);
        return;
      }
      if (message.type === 'argus:builder:replay') {
        const id = Number(message.workflowId);
        const traceId = typeof message.traceId === 'string' ? message.traceId.trim() : '';
        if (!Number.isSafeInteger(id) || id <= 0 || !TRACE_ID_PATTERN.test(traceId)) return;
        const nextPath = `/build/workflows/studio/${id}?replay=${encodeURIComponent(traceId)}`;
        if (pathRef.current === nextPath) return;
        childSourceRef.current = builderSource(String(id), `?replay=${encodeURIComponent(traceId)}`);
        pathRef.current = nextPath;
        setLoading(false);
        navigate(nextPath);
        return;
      }
      if (message.type !== 'argus:builder:navigate') return;

      const id = Number(message.workflowId);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const nextPath = `/build/workflows/studio/${id}`;
      if (pathRef.current === nextPath) return;
      childSourceRef.current = builderSource(String(id));
      pathRef.current = nextPath;
      setLoading(false);
      navigate(nextPath);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate, sendTheme]);

  useEffect(() => {
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [sendTheme]);

  return (
    <section className="workflow-studio" aria-label="Visual workflow studio">
      {loading && <div className="workflow-studio-loading" role="status">Loading visual workflow studio…</div>}
      <iframe
        ref={frameRef}
        className="workflow-studio-frame"
        src={src}
        title="Argus visual workflow studio"
        onLoad={() => { setLoading(false); sendTheme(); }}
      />
    </section>
  );
}
