import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleAlert,
  Network,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Workflow,
  LoaderCircle,
} from 'lucide-react';
import { getConsoleUser, getOverview } from '../api';
import { EmptyState, ErrorState, HealthBadge, PageHeader, StatusBadge, timeAgo } from '../components/Ui';

function HomeOverviewLoading() {
  return (
    <section className="panel home-overview-loading" aria-busy="true" aria-live="polite">
      <LoaderCircle className="spin" size={18} />
      <div>
        <b>Loading live workspace</b>
        <span>Recent runs and connected-system health are being checked in the background.</span>
      </div>
    </section>
  );
}

export function HomePage() {
  const session = useQuery({
    queryKey: ['console-session'],
    queryFn: getConsoleUser,
    staleTime: 5 * 60_000,
  });
  const query = useQuery({
    queryKey: ['overview'],
    queryFn: getOverview,
    refetchInterval: 15_000,
  });

  const data = query.data;
  const user = data?.user ?? session.data;
  const greetingName = user?.displayName || user?.username || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHeader
        eyebrow="COMMAND CENTER"
        title={`${greeting}, ${greetingName}.`}
        description="Everything that needs attention across agents, workflows and your MCP fabric."
        actions={(
          <>
            <Link className="button button-secondary" to="/build/workflows"><Workflow size={16} />Browse workflows</Link>
            <Link className="button button-primary" to="/workflows"><Plus size={16} />New run</Link>
          </>
        )}
      />

      <div className="command-snapshot" aria-label="Workspace status">
        <span className="live-signal"><i />Live workspace</span>
        {data ? <>
          <span>Updated {timeAgo(data.generatedAt)}</span>
          <span>{data.health.total} connected systems</span>
          <span>{data.stats.connectedTools} tools available</span>
        </> : <span>Loading operational status…</span>}
      </div>

      {data ? <>
      {data.attention.length > 0 ? (
        <section className="attention-panel" aria-labelledby="attention-title">
          <div className="attention-heading">
            <span className="attention-icon"><CircleAlert size={20} /></span>
            <div><span className="eyebrow">NEEDS ATTENTION</span><h2 id="attention-title">{data.attention.length} items to review</h2></div>
            <a href="/governance">View all <ArrowRight size={14} /></a>
          </div>
          <div className="attention-list">
            {data.attention.slice(0, 3).map(item => (
              <a className={`attention-row severity-${item.severity}`} href={item.href} key={item.id}>
                <i />
                <div><b>{item.title}</b><span>{item.detail}</span></div>
                <ArrowRight size={16} />
              </a>
            ))}
          </div>
        </section>
      ) : (
        <section className="calm-banner">
          <CheckCircle2 size={19} />
          <div><b>Everything is under control</b><span>No failed runs or pending workflow reviews.</span></div>
        </section>
      )}

      <section className="metric-grid" aria-label="Operational summary">
        <a className="metric-card metric-link" href="/runs">
          <span className="metric-icon violet"><Play size={17} /></span>
          <div><span>Active runs</span><strong>{data.stats.activeRuns}</strong><small>agents and workflows</small></div>
          <ArrowRight size={14} className="metric-arrow" />
        </a>
        <a className="metric-card metric-link" href="/observe">
          <span className="metric-icon teal"><Sparkles size={17} /></span>
          <div><span>Success rate · 24h</span><strong>{data.stats.successRate24h == null ? '—' : `${data.stats.successRate24h}%`}</strong><small>{data.stats.completed24h} completed · {data.stats.failed24h} failed</small></div>
          <ArrowRight size={14} className="metric-arrow" />
        </a>
        <a className="metric-card metric-link" href="/governance">
          <span className="metric-icon amber"><ShieldCheck size={17} /></span>
          <div><span>In review</span><strong>{data.stats.workflowsInReview}</strong><small>workflow decisions</small></div>
          <ArrowRight size={14} className="metric-arrow" />
        </a>
        <a className="metric-card metric-link" href="/mcp-fabric">
          <span className="metric-icon blue"><Network size={17} /></span>
          <div><span>MCP tool registry</span><strong>{data.stats.connectedTools}</strong><small>{data.health.healthy} of {data.health.total} systems healthy</small></div>
          <ArrowRight size={14} className="metric-arrow" />
        </a>
      </section>

      <div className="home-grid">
        <section className="panel runs-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">EXECUTION</span><h2>Active and recent runs</h2></div>
            <a href="/runs">All runs <ArrowRight size={14} /></a>
          </div>
          {data.runs.length > 0 ? (
            <div className="run-list">
              {data.runs.slice(0, 6).map(run => (
                <a className="run-row" href={run.href || '/runs'} key={`${run.kind}-${run.id}`}>
                  <span className={`run-glyph run-${run.status}`}>{run.kind === 'agent' ? <Bot size={17} /> : <Workflow size={17} />}</span>
                  <div className="run-main"><b>{run.title}</b><span>{run.subtitle}</span></div>
                  <StatusBadge status={run.status} />
                  <time>{timeAgo(run.updatedAt)}</time>
                  <ArrowRight size={15} className="row-arrow" />
                </a>
              ))}
            </div>
          ) : <EmptyState title="No runs yet" description="Start a workflow or open an agent chat to create the first activity." />}
        </section>

        <aside className="home-side">
          <section className="panel health-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">MCP FABRIC</span><h2>Platform health</h2></div>
              <HealthBadge state={data.health.state} />
            </div>
            <div className="health-figure">
              <div className="health-ring" style={{ '--health': `${data.health.total ? Math.round((data.health.healthy / data.health.total) * 100) : 100}%` } as CSSProperties}>
                <span><strong>{data.health.healthy}</strong><small>of {data.health.total}</small></span>
              </div>
              <div className="health-copy">
                <b>{data.health.degraded === 0 ? 'All connected systems are healthy' : `${data.health.degraded} systems need attention`}</b>
                <span>{data.stats.connectedTools} tools available to eligible agents.</span>
                <a href="/mcp-fabric">Open MCP Fabric <ArrowRight size={13} /></a>
              </div>
            </div>
          </section>

          <section className="panel quick-panel">
            <div className="panel-heading"><div><span className="eyebrow">QUICK START</span><h2>Build with Argus</h2></div></div>
            <a href="/build/agents"><Bot size={17} /><span><b>Configure an agent</b><small>{data.stats.agents} agents available</small></span><ArrowRight size={14} /></a>
            <a href="/build/workflows"><Workflow size={17} /><span><b>Open workflow builder</b><small>Design an agentic workflow</small></span><ArrowRight size={14} /></a>
            <a href="/mcp-fabric"><Network size={17} /><span><b>Connect an MCP server</b><small>Expand the tool fabric</small></span><ArrowRight size={14} /></a>
            <a href="/observe"><Activity size={17} /><span><b>Inspect live activity</b><small>Follow active sessions</small></span><ArrowRight size={14} /></a>
          </section>
        </aside>
      </div>
      </> : query.isLoading ? <HomeOverviewLoading /> : query.error ? <ErrorState error={query.error} /> : <HomeOverviewLoading />}
    </>
  );
}
