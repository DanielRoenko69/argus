import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Braces, Clock3, MessageSquare, UserRound, Wrench, X } from 'lucide-react';
import { getAgentSessions } from '../api';
import { EmptyState, ErrorState, LoadingState, timeAgo } from './Ui';
import type { AgentMessage, ManagedAgent } from '../types';

function messageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map(part => part.text ?? `[${part.type}]`).join('\n');
  return '';
}

function prettyJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

export function AgentSessionsPanel({ agent, onClose }: { agent: ManagedAgent; onClose: () => void }) {
  const query = useQuery({ queryKey: ['agent-sessions', agent.id], queryFn: () => getAgentSessions(agent.id), staleTime: 5_000 });

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.classList.remove('has-dialog'); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return <div className="editor-layer" role="presentation" onMouseDown={onClose}>
    <section className="agent-session-panel" role="dialog" aria-modal="true" aria-labelledby="agent-sessions-title" onMouseDown={event => event.stopPropagation()}>
      <header className="editor-header">
        <div><span className="eyebrow">EXECUTION HISTORY</span><h2 id="agent-sessions-title">Sessions · {agent.label}</h2><p>Conversation branches and tool calls retained for operational review.</p></div>
        <button className="editor-close" type="button" aria-label="Close session history" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="agent-session-body">
        {query.isLoading ? <LoadingState label="Loading agent sessions…" /> : query.error ? <ErrorState error={query.error} /> : !query.data?.length ? <EmptyState title="No sessions yet" description="Runs and conversations for this agent will appear here." /> : query.data.map(session => {
          const visible = session.messages.filter(message => message.role === 'user' || message.role === 'assistant');
          const toolCount = session.messages.reduce((total, message) => total + (message.tool_calls?.length ?? 0), 0);
          const firstUser = visible.find(message => message.role === 'user');
          return <details className="agent-session-card" key={session.id}>
            <summary>
              <span className="agent-session-icon"><MessageSquare size={16} /></span>
              <span className="agent-session-copy"><b>{messageText(firstUser ?? { role: 'user', content: '' }).slice(0, 90) || 'Untitled conversation'}</b><code>{session.id}</code></span>
              <span className="agent-session-meta"><small><MessageSquare size={11} />{session.message_count}</small><small><Wrench size={11} />{toolCount}</small><small><Clock3 size={11} />{timeAgo(session.last_active)}</small></span>
            </summary>
            <div className="agent-session-thread">
              {visible.map((message, index) => <article className={`agent-message is-${message.role}`} key={`${session.id}-${index}`}>
                <span>{message.role === 'user' ? <UserRound size={14} /> : <Bot size={14} />}</span>
                <div><small>{message.role === 'user' ? 'USER' : 'AGENT'}</small>{messageText(message) && <pre>{messageText(message).slice(0, 4000)}</pre>}{message.tool_calls?.map(call => <div className="agent-tool-call" key={call.id}><b><Braces size={12} />{call.function.name}</b><pre>{prettyJson(call.function.arguments).slice(0, 4000)}</pre></div>)}</div>
              </article>)}
            </div>
          </details>;
        })}
      </div>
    </section>
  </div>;
}
