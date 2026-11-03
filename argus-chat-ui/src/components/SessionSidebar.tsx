import { useMemo, useState } from 'react';
import { useSessions, useDeleteSession } from '../data-provider/hooks.js';
import { useChatStore } from '../store/chat.js';
import { Icon } from './Icon.js';
import { AgentPicker } from './AgentPicker.js';

interface Props {
  onNewChat: () => void;
  open?: boolean;
  onClose?: () => void;
}

function sessionTitle(messages: Array<{ role: string; content: string | null }>, fallback: string): string {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.content?.trim());
  const title = firstUserMessage?.content?.replace(/\s+/g, ' ').trim();
  if (!title) return fallback;
  return title.length > 42 ? `${title.slice(0, 42)}…` : title;
}

function isToday(iso: string): boolean {
  const date = new Date(iso);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export function SessionSidebar({ onNewChat, open = true, onClose }: Props) {
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const setSession = useChatStore((state) => state.setSession);
  const streaming = useChatStore((state) => state.streaming);
  const { data: sessions } = useSessions(activeAgentId);
  const deleteSession = useDeleteSession(activeAgentId ?? 0);
  const [deletingSessionId, setDeletingSessionId] = useState<string>();
  const [deleteError, setDeleteError] = useState<string>();
  const [query, setQuery] = useState('');

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!sessions || !needle) return sessions;
    return sessions.filter((session) => {
      const title = sessionTitle(session.messages, '').toLowerCase();
      const ticket = session.pr_context?.ticket_id?.toLowerCase() ?? '';
      return title.includes(needle) || ticket.includes(needle) || session.id.toLowerCase().includes(needle);
    });
  }, [query, sessions]);

  function formatDate(iso: string) {
    const d = new Date(iso);
    const now = new Date();
    const diffHours = (now.getTime() - d.getTime()) / (1000 * 60 * 60);
    if (diffHours < 24 && isToday(iso)) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async function handleDelete(e: React.MouseEvent, sid: string) {
    e.stopPropagation();
    e.preventDefault();
    if (streaming || deletingSessionId) return;
    setDeleteError(undefined);
    setDeletingSessionId(sid);
    try {
      await deleteSession.mutateAsync(sid);
      if (activeSessionId === sid) setSession(undefined);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete chat.');
    } finally {
      setDeletingSessionId(undefined);
    }
  }

  function selectSession(sid: string) {
    if (streaming) return;
    setSession(sid);
    onClose?.();
  }

  const today = filteredSessions?.filter((session) => isToday(session.last_active)) ?? [];
  const earlier = filteredSessions?.filter((session) => !isToday(session.last_active)) ?? [];

  return (
    <aside className={`session-sidebar${open ? ' is-open' : ''}`} aria-label="Chat history">
      <div className="session-sidebar-header">
        <div>
          <span className="session-sidebar-title">Chats</span>
          <span className="session-sidebar-subtitle">Conversation history</span>
        </div>
        <div className="session-sidebar-header-actions">
          <button className="session-new-btn icon-button" onClick={onNewChat} disabled={!activeAgentId} title="New chat" aria-label="New chat">
            <Icon name="plus" size={17} />
          </button>
          <button className="session-sidebar-close icon-button" onClick={onClose} title="Close chat history" aria-label="Close chat history">
            <Icon name="x" size={17} />
          </button>
        </div>
      </div>
      <div className="session-agent-picker">
        <AgentPicker />
      </div>
      {activeAgentId && (
        <label className="session-search">
          <Icon name="search" size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats…" aria-label="Search chats" />
        </label>
      )}
      {deleteError && <div className="session-error" role="alert">{deleteError}</div>}

      <div className="session-list">
        {!activeAgentId && <div className="session-no-agent">Select an agent to start.</div>}
        {activeAgentId && sessions === undefined && <div className="session-empty">Loading chats…</div>}
        {activeAgentId && sessions && sessions.length === 0 && <div className="session-empty">No chats yet.</div>}
        {activeAgentId && sessions && sessions.length > 0 && filteredSessions?.length === 0 && <div className="session-empty">No matching chats.</div>}
        {today.length > 0 && <div className="session-group-label">Today</div>}
        {today.map((session, index) => (
          <SessionItem key={session.id} session={session} index={index} total={today.length} active={activeSessionId === session.id} deleting={deletingSessionId !== undefined} streaming={streaming} onSelect={selectSession} onDelete={handleDelete} formatDate={formatDate} />
        ))}
        {earlier.length > 0 && <div className="session-group-label">Earlier</div>}
        {earlier.map((session, index) => (
          <SessionItem key={session.id} session={session} index={index} total={earlier.length} active={activeSessionId === session.id} deleting={deletingSessionId !== undefined} streaming={streaming} onSelect={selectSession} onDelete={handleDelete} formatDate={formatDate} />
        ))}
      </div>
    </aside>
  );
}

function SessionItem({ session, index, total, active, deleting, streaming, onSelect, onDelete, formatDate }: {
  session: { id: string; messages: Array<{ role: string; content: string | null }>; last_active: string; pr_context?: { ticket_id?: string } | null };
  index: number;
  total: number;
  active: boolean;
  deleting: boolean;
  streaming: boolean;
  onSelect: (sid: string) => void;
  onDelete: (event: React.MouseEvent, sid: string) => void;
  formatDate: (iso: string) => string;
}) {
  return (
    <div className={`session-item${active ? ' active' : ''}`}>
      <button
        type="button"
        className="session-select-button"
        onClick={() => onSelect(session.id)}
        title={`Session ${session.id.slice(0, 8)}`}
        aria-current={active ? 'page' : undefined}
      >
        <span className="session-item-copy">
          <span className="session-item-label">{sessionTitle(session.messages, `Chat ${total - index}`)}</span>
          {session.pr_context?.ticket_id && <span className="session-item-context">{session.pr_context.ticket_id}</span>}
          <span className="session-item-date">{formatDate(session.last_active)}</span>
        </span>
      </button>
      <button
        type="button"
        className="session-delete-btn"
        onClick={(event) => onDelete(event, session.id)}
        disabled={streaming || deleting}
        title="Delete session"
        aria-label="Delete session"
      >
        <Icon name="trash" size={15} />
      </button>
    </div>
  );
}
