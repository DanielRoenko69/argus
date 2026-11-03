import { useState, useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useChatStore } from '../store/chat.js';
import { useAgents, useCreateSession, useSession, useSetActiveLeaf, useMe } from '../data-provider/hooks.js';
import { streamChat } from '../data-provider/sse.js';
import type { SseEvent } from '../data-provider/sse.js';
import { ep } from '../data-provider/endpoints.js';
import type { Session } from '../data-provider/types.js';
import type { UiMessage, Step } from './types.js';
import { resolveActivePath, variantInfo } from './messageTree.js';
import { WorkspaceSidebar } from '../../../argus-console/src/components/WorkspaceSidebar.js';
import { AgentContextBar } from './AgentContextBar.js';
import { SessionSidebar } from './SessionSidebar.js';
import { MessageList } from './MessageList.js';
import { Composer, type ComposerAttachment } from './Composer.js';
import { ParamPanel } from './ParamPanel.js';
import { ShareModal } from './ShareModal.js';
import { formatTok, formatEur } from './format.js';
import { Icon } from './Icon.js';
import './chat.css';
import '../../../argus-console/src/components/workspaceSidebar.css';

/** Map a persisted Session → UiMessage[] for display, resolving the active branch. */
function hydrateMessages(session: Session): UiMessage[] {
  const path = resolveActivePath(session.messages, session.active_leaf_id);
  const result: UiMessage[] = [];
  for (const m of path) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      result.push({ role: 'user', content: m.content ?? '', id: m.id, variant: m.id ? variantInfo(session.messages, m.id) : undefined });
    } else if (m.role === 'assistant') {
      result.push({
        role: 'assistant',
        content: m.content ?? '',
        steps: [],
        id: m.id,
        variant: m.id ? variantInfo(session.messages, m.id) : undefined,
        citations: m.citations,
      });
    } else if (m.role === 'tool') {
      // Fold tool messages into the prior assistant's steps
      const last = result[result.length - 1];
      if (last?.role === 'assistant') {
        const toolName = m.name ?? m.tool_call_id ?? 'tool';
        const step: Step = { kind: 'result', id: m.tool_call_id, name: toolName, payload: m.content ?? '', status: 'done' };
        last.steps = [...(last.steps ?? []), step];
      }
    }
  }
  // Mark the last assistant message
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'assistant') {
      result[i] = { ...result[i], isLastAssistant: true };
      break;
    }
  }
  return result;
}

export function ChatView() {
  // Do not subscribe the full chat shell to every Zustand update. In
  // particular, the parameter panel and usage meter can change independently
  // while a response is streaming; subscribing field-by-field leaves the
  // expensive message tree alone unless one of its actual inputs changes.
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const streaming = useChatStore((state) => state.streaming);
  const theme = useChatStore((state) => state.theme);
  const setAgent = useChatStore((state) => state.setAgent);
  const setSession = useChatStore((state) => state.setSession);
  const setStreaming = useChatStore((state) => state.setStreaming);
  const toggleTheme = useChatStore((state) => state.toggleTheme);
  const sessionUsage = useChatStore((s) => s.sessionUsage);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(false);
  const [workspaceSidebarCollapsed, setWorkspaceSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('argus-console-collapsed') === '1'; } catch { return false; }
  });
  // Keep the existing chat sidebar visible on desktop. On narrow screens the
  // history is an overlay and should open only after the user requests it.
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(() =>
    typeof window === 'undefined' || window.innerWidth > 760,
  );
  const abortRef = useRef<AbortController | null>(null);
  // The backend can stream many small deltas per second. Buffer them until
  // the next animation frame so React/Markdown does not re-parse the whole
  // last response for every network chunk.
  const pendingDeltaRef = useRef('');
  const pendingDeltaFrameRef = useRef<number | null>(null);
  // Session whose messages are locally authoritative (created/streamed here).
  // Hydration must not clobber it with the async (empty) server fetch.
  const localSessionRef = useRef<string | undefined>(undefined);

  const qc = useQueryClient();
  const createSession = useCreateSession(activeAgentId ?? 0);
  const setActiveLeaf = useSetActiveLeaf(activeAgentId ?? 0, activeSessionId ?? '');
  const { data: sessionData } = useSession(activeAgentId, activeSessionId);
  const { data: agents } = useAgents();
  const { data: me } = useMe();
  const aiTransparency = me?.aiTransparency ?? {
    enabled: true,
    notice: 'You are interacting with an AI agent. Responses may be inaccurate; verify important information and review tool actions before approval.',
  };
  const visionEnabled = !!agents?.find((a) => a.id === activeAgentId)?.supports_vision;
  const activeAgent = agents?.find((a) => a.id === activeAgentId);
  const promptSuggestions = activeAgent?.agent_mode === 'worker'
    ? ['Review the current task context', 'Inspect the affected resources']
    : activeAgent?.agent_mode === 'reviewer'
      ? ['Review the proposed change', 'Check for operational risks']
      : ['Investigate this issue', 'Summarize the current state'];

  const setLastMessageError = useCallback((message: string) => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const next = [...current];
      const last = { ...next[next.length - 1] };
      last.error = message;
      next[next.length - 1] = last;
      return next;
    });
  }, []);

  const cancelPendingDeltaFrame = useCallback(() => {
    const handle = pendingDeltaFrameRef.current;
    if (handle === null || typeof window === 'undefined') return;
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
    else window.clearTimeout(handle);
    pendingDeltaFrameRef.current = null;
  }, []);

  const flushPendingDelta = useCallback(() => {
    const delta = pendingDeltaRef.current;
    if (!delta) return;
    pendingDeltaRef.current = '';
    cancelPendingDeltaFrame();
    setMessages((current) => {
      if (current.length === 0) return current;
      const lastIndex = current.length - 1;
      const last = current[lastIndex];
      if (!last || last.role !== 'assistant') return current;
      const next = [...current];
      next[lastIndex] = { ...last, content: (last.content ?? '') + delta };
      return next;
    });
  }, [cancelPendingDeltaFrame]);

  const queueDelta = useCallback((text: string) => {
    pendingDeltaRef.current += text;
    if (pendingDeltaFrameRef.current !== null) return;
    const flush = () => {
      pendingDeltaFrameRef.current = null;
      flushPendingDelta();
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      pendingDeltaFrameRef.current = window.requestAnimationFrame(flush);
    } else if (typeof window !== 'undefined') {
      pendingDeltaFrameRef.current = window.setTimeout(flush, 0);
    }
  }, [flushPendingDelta]);

  useEffect(() => () => {
    cancelPendingDeltaFrame();
    pendingDeltaRef.current = '';
  }, [cancelPendingDeltaFrame]);
  // Share button: only when the feature is on, a session is open with ≥1 persisted turn.
  const canShare = !!me?.shareLinksEnabled && !!activeAgentId && !!activeSessionId
    && (sessionData?.messages?.length ?? 0) > 0;

  // Apply theme class on mount and when theme changes
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Read /chat/<id> only after the visibility-filtered agent list is known.
  // This prevents stale or unauthorized deep links from activating an agent
  // that the API will reject while leaving the picker in a misleading state.
  useEffect(() => {
    const match = /^\/chat\/(\d+)/.exec(window.location.pathname);
    if (!match || !agents) return;
    const requestedAgentId = Number(match[1]);
    if (agents.some((agent) => agent.id === requestedAgentId)) setAgent(requestedAgentId);
  }, [agents, setAgent]);

  // Hydrate messages when a DIFFERENT (not locally-owned) session is selected.
  // Skip the session we're actively driving (just created via send, or streaming
  // into) so the async useSession fetch can't clobber optimistic/streamed messages.
  useEffect(() => {
    if (activeSessionId && activeSessionId === localSessionRef.current) return;
    if (sessionData?.messages) {
      setMessages(hydrateMessages(sessionData));
    } else if (!activeSessionId) {
      setMessages([]);
    }
  }, [sessionData, activeSessionId]);

  /** Apply a single SSE event onto the last (assistant placeholder) message. */
  const applyEvent = useCallback((e: SseEvent) => {
    if (e.type === 'delta') {
      queueDelta(e.text);
      return;
    }
    // Tool/approval/error/done events must appear after every preceding text
    // delta, even if the next animation frame has not occurred yet.
    flushPendingDelta();
    if (e.type === 'done') return;
    // Accumulate usage into the session meter (side-effect, outside updater)
    if (e.type === 'usage') {
      useChatStore.getState().addUsage({
        prompt: e.prompt,
        completion: e.completion,
        total: e.total,
        cost: e.cost,
      });
    }
    setMessages((m) => {
      const next = [...m];
      if (next.length === 0) return next;
      const a = { ...next[next.length - 1] } as UiMessage;
      if (e.type === 'tool_call') {
        a.steps = [
          ...(a.steps ?? []),
          { kind: 'call', id: e.id, name: e.name, payload: e.args, status: 'running' },
        ];
      } else if (e.type === 'tool_result') {
        const steps = [...(a.steps ?? [])];
        const match = [...steps].reverse().findIndex((step) => step.kind === 'call'
          && step.name === e.name
          && step.status === 'running'
          && (!e.id || !step.id || step.id === e.id));
        const callIndex = match >= 0 ? steps.length - 1 - match : -1;
        if (callIndex >= 0) {
          steps[callIndex] = {
            ...steps[callIndex],
            status: e.isError || e.preview.startsWith('Error:') ? 'error' : 'done',
            durationMs: e.durationMs,
            traceId: e.traceId,
            spanId: e.spanId,
          };
        }
        a.steps = [...steps, {
          kind: 'result', id: e.id, name: e.name, payload: e.preview,
          status: e.isError || e.preview.startsWith('Error:') ? 'error' : 'done',
          durationMs: e.durationMs, traceId: e.traceId, spanId: e.spanId,
        }];
      } else if (e.type === 'error') {
        a.error = e.message;
      } else if (e.type === 'usage') {
        a.usage = { prompt: e.prompt, completion: e.completion, total: e.total, cost: e.cost };
      } else if (e.type === 'citations') {
        a.citations = e.citations;
      } else if (e.type === 'approval_requested') {
        a.approvalRequest = e.approval;
      }
      next[next.length - 1] = a;
      return next;
    });
  }, [flushPendingDelta, queueDelta]);

  const send = useCallback(async (text: string, attachments: ComposerAttachment[] = []) => {
    if (!activeAgentId || streaming) return;

    let sid = activeSessionId;
    if (!sid) {
      const s = await createSession.mutateAsync();
      sid = s.id;
      setSession(sid);
    }
    // Mark this session locally-owned BEFORE the useSession fetch resolves, so the
    // hydration effect won't overwrite the optimistic messages we push next.
    localSessionRef.current = sid;

    // Push user message + empty assistant placeholder
    setMessages((m) => [
      ...m,
      {
        role: 'user',
        content: text,
        images: attachments.filter((attachment): attachment is { name: string; dataUrl: string } => !!attachment.dataUrl),
      },
      { role: 'assistant', content: '', steps: [] },
    ]);

    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      const p = useChatStore.getState().params;
      const hasParams = p.temperature !== undefined || p.max_tokens !== undefined || p.top_p !== undefined;
      await streamChat(
        ep.chat(activeAgentId, sid),
        { message: text, attachments: attachments.length ? attachments : undefined, params: hasParams ? p : undefined },
        applyEvent,
        abortRef.current.signal,
      );
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setLastMessageError(String(err));
      }
    } finally {
      flushPendingDelta();
      setStreaming(false);
      // Re-hydrate from the now-persisted session so messages pick up their tree ids (enables ✎
      // edit + variant switchers), consistent with regenerate()/editMessage(). The localSessionRef
      // guard only protects DURING the stream; the post-stream session is fully persisted.
      localSessionRef.current = undefined;
      qc.invalidateQueries({ queryKey: ['session', activeAgentId, sid] });
    }
  }, [activeAgentId, activeSessionId, applyEvent, createSession, flushPendingDelta, qc, setSession, setStreaming, streaming]);

  const regenerate = useCallback(async () => {
    if (!activeAgentId || !activeSessionId || streaming) return;
    localSessionRef.current = activeSessionId;
    setMessages((m) => [...m, { role: 'assistant', content: '', steps: [] }]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      const p = useChatStore.getState().params;
      const hasParams = p.temperature !== undefined || p.max_tokens !== undefined || p.top_p !== undefined;
      await streamChat(ep.regenerate(activeAgentId, activeSessionId), { message: '', params: hasParams ? p : undefined }, applyEvent, abortRef.current.signal);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') applyEvent({ type: 'error', message: String(err) });
    } finally {
      flushPendingDelta();
      setStreaming(false);
      localSessionRef.current = undefined;        // allow the refetch to repaint with the new variant
      qc.invalidateQueries({ queryKey: ['session', activeAgentId, activeSessionId] });
    }
  }, [activeAgentId, activeSessionId, applyEvent, flushPendingDelta, qc, setStreaming, streaming]);

  const editMessage = useCallback(async (msgId: string, text: string) => {
    if (!activeAgentId || !activeSessionId || streaming || !text.trim()) return;
    localSessionRef.current = activeSessionId;
    // Optimistic rewind: drop the edited message + everything after it, then show the new turn.
    setMessages((m) => {
      const idx = m.findIndex((x) => x.id === msgId);
      const base = idx >= 0 ? m.slice(0, idx) : m;
      return [...base, { role: 'user', content: text }, { role: 'assistant', content: '', steps: [] }];
    });
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      const p = useChatStore.getState().params;
      const hasParams = p.temperature !== undefined || p.max_tokens !== undefined || p.top_p !== undefined;
      await streamChat(ep.editMessage(activeAgentId, activeSessionId, msgId), { message: text, params: hasParams ? p : undefined }, applyEvent, abortRef.current.signal);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') applyEvent({ type: 'error', message: String(err) });
    } finally {
      flushPendingDelta();
      setStreaming(false);
      localSessionRef.current = undefined;
      qc.invalidateQueries({ queryKey: ['session', activeAgentId, activeSessionId] });
    }
  }, [activeAgentId, activeSessionId, applyEvent, flushPendingDelta, qc, setStreaming, streaming]);

  const switchVariant = useCallback(async (leafId: string) => {
    if (streaming) return;
    await setActiveLeaf.mutateAsync(leafId);
    localSessionRef.current = undefined; // let the invalidated session refetch repaint the chosen branch
  }, [setActiveLeaf, streaming]);

  const stop = useCallback(() => {
    flushPendingDelta();
    abortRef.current?.abort();
    setStreaming(false);
  }, [flushPendingDelta, setStreaming]);

  const handleNewChat = useCallback(() => {
    if (streaming) stop();
    localSessionRef.current = undefined;
    setSession(undefined);
    setMessages([]);
    useChatStore.getState().resetUsage();
    useChatStore.getState().resetParams();
  }, [setSession, streaming, stop]);

  return (
    <div className={`chat-root workspace-shell${workspaceSidebarCollapsed ? ' is-collapsed' : ''}`}>
      <WorkspaceSidebar
        user={me ? {
          displayName: me.user.display_name,
          username: me.user.username,
          role: me.user.role,
        } : undefined}
        canAdmin={me?.user.role === 'platform_admin' || me?.user.role === 'admin'}
        pathname={window.location.pathname}
        collapsed={workspaceSidebarCollapsed}
        mobileOpen={workspaceSidebarOpen}
        onToggleCollapsed={() => {
          setWorkspaceSidebarCollapsed(value => {
            const next = !value;
            try { localStorage.setItem('argus-console-collapsed', next ? '1' : '0'); } catch { /* storage is optional */ }
            return next;
          });
        }}
        onOpenMobile={() => setWorkspaceSidebarOpen(true)}
        onCloseMobile={() => setWorkspaceSidebarOpen(false)}
      />
      <div className="chat-stage">
        <header className="chat-header">
        <button type="button" className="sessions-toggle" onClick={() => setSessionSidebarOpen(true)} aria-label="Open chat history" title="Open chat history">
          <Icon name="message" size={18} />
        </button>
        <span className="chat-header-title">Argus Chat</span>
        <div className="chat-header-actions">
          {sessionUsage.total > 0 && (
            <span className="session-usage" title="Session total">
              Σ {formatTok(sessionUsage.total)} tok
              {sessionUsage.cost > 0 ? ` · ${formatEur(sessionUsage.cost)}` : ''}
            </span>
          )}
          <ParamPanel />
          {canShare && <ShareModal agentId={activeAgentId!} sid={activeSessionId!} />}
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme" aria-label="Toggle light/dark theme">
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
        </header>

        <AgentContextBar />

        <div className="chat-body">
        <SessionSidebar onNewChat={handleNewChat} open={sessionSidebarOpen} onClose={() => setSessionSidebarOpen(false)} />
        {sessionSidebarOpen && <button type="button" className="session-sidebar-scrim" aria-label="Close chat history" onClick={() => setSessionSidebarOpen(false)} />}

        <main className="chat-main">
          <MessageList messages={messages} onRegenerate={regenerate} onRetry={regenerate} onSwitchVariant={switchVariant} onEditMessage={editMessage} />
          {aiTransparency.enabled && (
            <div className="ai-transparency-notice" role="note" aria-label="AI interaction notice">
              <span className="ai-transparency-badge" aria-hidden="true">AI</span>
              <span>{aiTransparency.notice}</span>
            </div>
          )}
          <Composer onSend={send} onStop={stop} visionEnabled={visionEnabled} suggestions={activeAgentId ? promptSuggestions : []} sessionKey={activeSessionId ?? 'new'} />
        </main>
        </div>
      </div>
    </div>
  );
}
