import { useQuery } from '@tanstack/react-query';
import { Bot, CircleDollarSign, Radio, Sparkles, SquareTerminal, TriangleAlert } from 'lucide-react';
import { getLiveActivity, getOverview } from '../api';
import { isPlatformAdminRole } from '../access';
import { ErrorState, formatDuration, LoadingState, PageHeader } from '../components/Ui';
import { ObserveWorkspaceTabs } from '../features/observe/ObserveWorkspaceTabs';

export function LiveActivityPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview });
  const isAdmin = isPlatformAdminRole(overview.data?.user.role);
  const live = useQuery({ queryKey: ['live-activity'], queryFn: getLiveActivity, enabled: isAdmin, refetchInterval: 2_000 });

  if (overview.isLoading) return <LoadingState label="Checking live activity access…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  if (!isAdmin) return <div className="state-panel state-error" role="alert"><TriangleAlert size={22} /><div><b>Administrator access required</b><span>Live sessions may contain cross-user execution details.</span></div></div>;
  if (live.isLoading) return <LoadingState label="Connecting to live agent activity…" />;
  if (live.error) return <ErrorState error={live.error} />;
  if (!live.data) return null;

  const { counts, sessions } = live.data;
  return (
    <>
      <PageHeader eyebrow="OBSERVE · LIVE" title="Live sessions" description="Follow active agents, iterations and tool calls with a two-second platform pulse." actions={<span className="live-indicator is-live"><i />Live · 2s</span>} />
      <ObserveWorkspaceTabs active="activity" isAdmin={isAdmin} />
      <section className="live-count-grid" aria-label="Live session counts">
        <article><span>Total</span><strong>{counts.total}</strong><small>tracked sessions</small></article>
        <article><span>Thinking</span><strong>{counts.thinking}</strong><small>planning a response</small></article>
        <article><span>Tools</span><strong>{counts.tool}</strong><small>capability in flight</small></article>
        <article><span>Streaming</span><strong>{counts.streaming}</strong><small>returning output</small></article>
        <article><span>Done</span><strong>{counts.done}</strong><small>recently finished</small></article>
        <article className={counts.error > 0 ? 'has-error' : ''}><span>Errors</span><strong>{counts.error}</strong><small>needs attention</small></article>
      </section>

      <div className="live-session-list">
        {sessions.length > 0 ? sessions.map(session => (
          <article className="panel live-session-card" key={session.sessionId}>
            <div className="live-session-head">
              <span className="live-agent-icon"><Bot size={18} /></span>
              <div><h2>{session.agentName}</h2><p>{session.agentMode} · session {session.sessionId.slice(0, 8)}</p></div>
              <span className={`session-status session-${session.status}`}><i />{session.status}</span>
            </div>
            {session.lastMessage && <blockquote>{session.lastMessage}</blockquote>}
            {session.errorMessage && <div className="session-error-message"><TriangleAlert size={14} />{session.errorMessage}</div>}
            <div className="live-session-metrics">
              <span><Sparkles size={14} /><b>Iteration {session.iteration}</b><small>{session.inputTokens + session.outputTokens} tokens</small></span>
              <span><SquareTerminal size={14} /><b>{session.toolCallCount} tool calls</b><small>{formatDuration(Date.now() - session.startedAt)} elapsed</small></span>
              <span><CircleDollarSign size={14} /><b>${session.estimatedCostUsd.toFixed(4)}</b><small>estimated cost</small></span>
              <span><Radio size={14} /><b>{Math.max(0, Math.floor((Date.now() - session.lastActivityAt) / 1000))}s idle</b><small>last activity</small></span>
            </div>
            {session.toolCalls.length > 0 && <div className="live-tool-list">
              {session.toolCalls.map(tool => <div className={tool.isError ? 'is-error' : ''} key={tool.id}><code>{tool.name}</code><span>{tool.finishedAt ? formatDuration(tool.finishedAt - tool.startedAt) : 'running…'}</span>{tool.previewTrunc && <small>{tool.previewTrunc}</small>}</div>)}
            </div>}
          </article>
        )) : <div className="panel observe-empty-state"><span className="empty-pulse"><i /></span><h2>No active sessions</h2><p>Argus is listening. New agent executions will appear here automatically.</p></div>}
      </div>
    </>
  );
}
