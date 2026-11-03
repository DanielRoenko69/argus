import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { Activity, BarChart3, Bot, Boxes, CheckCircle2, Clock3, FileText, Flame, Gauge, GitBranch, Library, Pencil, Plus, RefreshCw, Search, Sparkles, TrendingDown, TrendingUp, Upload, UsersRound, X } from 'lucide-react';
import { deleteSkill, getSkillAdoption, getSkills, saveSkill } from '../api';
import { SkillEditor } from '../components/SkillEditor';
import { EmptyState, ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { KnowledgeWorkspaceTabs } from '../features/knowledge/KnowledgeWorkspaceTabs';
import type { SkillAdoptionResponse, SkillMutation, SkillOption } from '../types';

type SkillFilter = 'all' | 'assigned' | 'imported';
type SkillView = 'library' | 'adoption';

function contentPreview(content: string): string {
  return content.replace(/^#+\s*/gm, '').replace(/[`*_>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
}

function AdoptionAnalytics({ data }: { data: SkillAdoptionResponse }) {
  const maxDaily = Math.max(1, ...data.timeSeries.map(item => item.uses));
  const maxSkill = Math.max(1, ...data.bySkill.map(item => item.uses));
  const maxHeat = Math.max(1, ...data.heatmap.map(item => item.uses));
  const heat = new Map(data.heatmap.map(item => [`${item.dayOfWeek}:${item.hour}`, item.uses]));
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return <div className="skill-adoption-layout">
    <section className="panel skill-adoption-trend">
      <div className="panel-heading"><div><span className="eyebrow">RUNTIME DEMAND</span><h2>Skill usage trend</h2></div><small>{data.kpis.totalUses} fetches · {data.windowDays} days</small></div>
      {data.kpis.totalUses > 0 ? <div className="skill-trend-chart" role="img" aria-label={`Skill usage over ${data.windowDays} days`}>
        {data.timeSeries.map(item => <span key={item.day} title={`${item.day}: ${item.uses} uses, ${item.errors} errors`}><i style={{ height: `${Math.max(item.uses ? 8 : 2, (item.uses / maxDaily) * 100)}%` }} /><small>{data.windowDays <= 14 || item.day.endsWith('-01') ? item.day.slice(5) : ''}</small></span>)}
      </div> : <EmptyState title="No runtime usage in this window" description="Assignments describe configured impact. Adoption appears after agents or MCP clients fetch a skill prompt." />}
    </section>

    <section className="panel skill-adoption-performance">
      <div className="panel-heading"><div><span className="eyebrow">DELIVERY HEALTH</span><h2>Runtime performance</h2></div><Gauge size={16} /></div>
      <dl>
        <div><dt>Median</dt><dd>{data.kpis.p50Ms} ms</dd></div>
        <div><dt>P95</dt><dd>{data.kpis.p95Ms} ms</dd></div>
        <div><dt>Error rate</dt><dd className={data.kpis.errorRate > 2 ? 'is-risk' : ''}>{data.kpis.errorRate}%</dd></div>
        <div><dt>Uses / consumer</dt><dd>{data.kpis.averageUsesPerConsumer}</dd></div>
      </dl>
      <p>Latency and failures measure prompt delivery through Argus, not downstream model execution.</p>
    </section>

    <section className="panel skill-adoption-ranking">
      <div className="panel-heading"><div><span className="eyebrow">ACTIVE SKILLS</span><h2>Usage by skill</h2></div><small>Top {data.bySkill.length}</small></div>
      {data.bySkill.length ? <div className="skill-ranking-table" role="table" aria-label="Skill runtime adoption">
        <div className="is-head" role="row"><span>Skill</span><span>Usage</span><span>Consumers</span><span>P95</span><span>Errors</span></div>
        {data.bySkill.map(skill => <div role="row" key={skill.skill}>
          <span><b>{skill.label}</b><small>{skill.skill}</small></span>
          <span className="skill-usage-bar"><i style={{ width: `${(skill.uses / maxSkill) * 100}%` }} /><b>{skill.uses}</b></span>
          <span>{skill.activeConsumers}</span><span>{skill.p95Ms} ms</span><span className={skill.errorRate > 2 ? 'is-risk' : ''}>{skill.errorRate}%</span>
        </div>)}
      </div> : <EmptyState title="No active skills" description="Runtime usage will be ranked here when skill prompts are fetched." />}
    </section>

    <section className="panel skill-adoption-trending">
      <div className="panel-heading"><div><span className="eyebrow">CHANGE SIGNALS</span><h2>Trending</h2></div><Flame size={16} /></div>
      {data.trending.length ? <div className="skill-signal-list">{data.trending.slice(0, 8).map(item => <div key={item.skill}>
        <span className={item.delta >= 0 ? 'is-up' : 'is-down'}>{item.delta >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}</span>
        <span><b>{item.label}</b><small>{item.recent} recent · {item.prior} prior</small></span><em>{item.delta > 0 ? '+' : ''}{item.delta}</em>
      </div>)}</div> : <EmptyState title="No trend signal yet" description="Argus compares two equal halves of the selected window." />}
    </section>

    <section className="panel skill-adoption-stale">
      <div className="panel-heading"><div><span className="eyebrow">MAINTENANCE QUEUE</span><h2>Stale skills</h2></div><small>{data.stale.length} candidates</small></div>
      {data.stale.length ? <div className="skill-signal-list">{data.stale.slice(0, 8).map(skill => <div key={skill.id}>
        <span className="skill-stale-icon">{skill.icon}</span><span><b>{skill.label}</b><small>{skill.name}</small></span><em>{skill.daysSinceLastUse == null ? 'Never used' : `${skill.daysSinceLastUse}d ago`}</em>
      </div>)}</div> : <div className="skill-healthy-empty"><CheckCircle2 size={18} /><span><b>No stale skills</b><small>Every skill was used inside the selected window.</small></span></div>}
    </section>

    <section className="panel skill-adoption-consumers">
      <div className="panel-heading"><div><span className="eyebrow">RUNTIME IDENTITIES</span><h2>Active consumers</h2></div><UsersRound size={16} /></div>
      {data.consumers.length ? <div className="skill-consumer-list">{data.consumers.slice(0, 8).map(consumer => <div key={consumer.id}><code>{consumer.id}</code><span><b>{consumer.skillFetches}</b> fetches</span><span><b>{consumer.distinctSkills}</b> skills</span></div>)}</div> : <EmptyState title="No active runtime identities" description="Consumer IDs are pseudonymous and never expose stored API-key prefixes." />}
      {data.consumers.length > 0 && <p className="skill-consumer-note">Stable pseudonymous runtime identities; these counts do not necessarily represent individual people.</p>}
    </section>

    <section className="panel skill-adoption-heatmap">
      <div className="panel-heading"><div><span className="eyebrow">OPERATING PATTERN</span><h2>Usage heatmap</h2></div><small>UTC · hour of day</small></div>
      <div className="skill-heatmap" role="img" aria-label="Skill usage by weekday and UTC hour">
        <div className="skill-heat-head"><span /><div>{Array.from({ length: 24 }, (_, hour) => <small key={hour}>{hour % 3 === 0 ? hour : ''}</small>)}</div></div>
        {days.map((day, dow) => <div className="skill-heat-row" key={day}><b>{day}</b><div>{Array.from({ length: 24 }, (_, hour) => { const uses = heat.get(`${dow}:${hour}`) ?? 0; return <i key={hour} title={`${day} ${hour}:00 UTC · ${uses} uses`} style={{ '--skill-heat': uses / maxHeat } as CSSProperties} />; })}</div></div>)}
      </div>
    </section>
  </div>;
}

export function SkillsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['skills'], queryFn: getSkills, staleTime: 10_000 });
  const [view, setView] = useState<SkillView>('library');
  const [windowDays, setWindowDays] = useState(30);
  const adoption = useQuery({
    queryKey: ['skill-adoption', windowDays],
    queryFn: () => getSkillAdoption(windowDays),
    enabled: view === 'adoption',
    staleTime: 30_000,
  });
  const [filter, setFilter] = useState<SkillFilter>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<SkillOption | null | undefined>(undefined);
  const [notice, setNotice] = useState('');

  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: SkillMutation; id?: number }) => saveSkill(input, id),
    onSuccess: async (skill, variables) => {
      setEditing(undefined);
      setNotice(`Skill “${skill.label}” ${variables.id == null ? 'created' : 'saved as a new catalog version. Existing Agent pins stay unchanged'}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
        queryClient.invalidateQueries({ queryKey: ['agent-studio'] }),
      ]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (skill: SkillOption) => deleteSkill(skill.id),
    onSuccess: async (_result, skill) => {
      setEditing(undefined);
      setNotice(`Skill “${skill.label}” deleted.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['skills'] }),
        queryClient.invalidateQueries({ queryKey: ['agent-studio'] }),
      ]);
    },
  });

  useEffect(() => {
    if (new URLSearchParams(location.search).get('create') !== 'skill') return;
    saveMutation.reset();
    deleteMutation.reset();
    setEditing(null);
    const params = new URLSearchParams(location.search);
    params.delete('create');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const skills = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (query.data ?? []).filter(skill => {
      if (filter === 'assigned' && (skill.assigned_agents?.length ?? 0) === 0) return false;
      if (filter === 'imported' && !skill.source_url) return false;
      return !normalized || `${skill.name} ${skill.label} ${skill.description} ${skill.category ?? ''}`.toLowerCase().includes(normalized);
    });
  }, [filter, query.data, search]);

  if (query.isLoading) return <LoadingState label="Loading reusable skills…" />;
  if (query.error) return <ErrorState error={query.error} />;

  const allSkills = query.data ?? [];
  const assignedCount = allSkills.filter(skill => (skill.assigned_agents?.length ?? 0) > 0).length;
  const assignmentCount = allSkills.reduce((total, skill) => total + (skill.assigned_agents?.length ?? 0), 0);
  const importedCount = allSkills.filter(skill => Boolean(skill.source_url)).length;
  const categoryCount = new Set(allSkills.map(skill => skill.category).filter(Boolean)).size;

  return <>
    <PageHeader
      eyebrow="BUILD · AGENT CONTEXT"
      title="Skill Library"
      description="Create reusable prompt modules, understand their runtime impact and attach them to governed agents."
      actions={<><a className="button button-secondary" href="/build/agents/manage"><Bot size={15} />Agent Studio</a><button className="button button-primary" type="button" onClick={() => { saveMutation.reset(); deleteMutation.reset(); setEditing(null); }}><Plus size={15} />New skill</button></>}
    />
    <KnowledgeWorkspaceTabs active="skills" />
    <div className="connection-notice"><span>Agents use pinned Skill versions. Editing or importing here updates the Library for new assignments and catalog MCP consumers, not existing Agent pins.</span><a className="button button-secondary" href="/build/evaluations#skill-versions">Compare &amp; release Skill versions</a></div>

    {notice && <div className="connection-notice is-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}

    <section className="skill-library-banner"><span><Sparkles size={20} /></span><div><small>REUSABLE AGENT CONTEXT</small><b>One instruction module, many governed runtimes</b><p>Skills are stored as Markdown, injected into assigned agent prompts and can also be exposed as MCP prompts through access bundles.</p></div><em><GitBranch size={13} />Composable by design</em></section>

    <div className="skill-view-toolbar">
      <div className="segmented-filter" aria-label="Skill Library view"><button className={view === 'library' ? 'is-active' : ''} type="button" onClick={() => setView('library')}><Library size={13} />Library</button><button className={view === 'adoption' ? 'is-active' : ''} type="button" onClick={() => setView('adoption')}><BarChart3 size={13} />Adoption</button></div>
      {view === 'adoption' && <div className="skill-window-controls"><label><span>Window</span><select aria-label="Skill adoption window" value={windowDays} onChange={event => setWindowDays(Number(event.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label><button type="button" aria-label="Refresh skill adoption analytics" onClick={() => void adoption.refetch()}><RefreshCw className={adoption.isFetching ? 'spin' : ''} size={14} /></button></div>}
    </div>

    <section className="metric-grid build-metrics" aria-label={view === 'library' ? 'Skill library summary' : 'Skill adoption summary'}>
      {view === 'library' ? <>
      <article className="metric-card"><span className="metric-icon violet"><Sparkles size={17} /></span><div><span>Skills</span><strong>{allSkills.length}</strong><small>{categoryCount} categories</small></div></article>
      <article className="metric-card"><span className="metric-icon teal"><Bot size={17} /></span><div><span>Assigned skills</span><strong>{assignedCount}</strong><small>{assignmentCount} agent assignments</small></div></article>
      <article className="metric-card"><span className="metric-icon blue"><Upload size={17} /></span><div><span>Imported</span><strong>{importedCount}</strong><small>tracked external sources</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><Boxes size={17} /></span><div><span>Unassigned</span><strong>{allSkills.length - assignedCount}</strong><small>available for composition</small></div></article>
      </> : <>
        <article className="metric-card"><span className="metric-icon violet"><Activity size={17} /></span><div><span>Active skills</span><strong>{adoption.data?.kpis.activeSkills ?? '—'}</strong><small>{adoption.data ? `${adoption.data.kpis.adoptionRate}% of ${adoption.data.kpis.totalSkills}` : 'loading adoption'}</small></div></article>
        <article className="metric-card"><span className="metric-icon teal"><UsersRound size={17} /></span><div><span>30d consumers</span><strong>{adoption.data?.kpis.activeConsumers30d ?? '—'}</strong><small>{adoption.data ? `${adoption.data.kpis.activeConsumers7d} active in 7d` : 'pseudonymous runtimes'}</small></div></article>
        <article className="metric-card"><span className="metric-icon blue"><BarChart3 size={17} /></span><div><span>Skill fetches</span><strong>{adoption.data?.kpis.totalUses ?? '—'}</strong><small>{windowDays}-day window</small></div></article>
        <article className="metric-card"><span className="metric-icon amber"><Clock3 size={17} /></span><div><span>Delivery P95</span><strong>{adoption.data ? `${adoption.data.kpis.p95Ms} ms` : '—'}</strong><small>{adoption.data ? `${adoption.data.kpis.errorRate}% error rate` : 'prompt delivery'}</small></div></article>
      </>}
    </section>

    {view === 'library' && <><div className="build-toolbar">
      <div className="segmented-filter" aria-label="Filter reusable skills">{(['all', 'assigned', 'imported'] as const).map(value => <button className={filter === value ? 'is-active' : ''} type="button" key={value} onClick={() => setFilter(value)}>{value}</button>)}</div>
      <label className="search-field"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search skills, categories and names" /></label>
    </div>

    {skills.length > 0 ? <section className="skill-card-grid" aria-label="Reusable skills">{skills.map(skill => {
      const assignments = skill.assigned_agents ?? [];
      const preview = contentPreview(skill.content);
      return <article className="skill-card" key={skill.id}>
        <header><span className="skill-card-icon">{skill.icon || '✦'}</span><div>{skill.source_url && <span className="skill-origin-badge"><Upload size={10} />Imported</span>}{skill.category && <span className="skill-category-badge">{skill.category}</span>}</div></header>
        <div className="skill-card-title"><small>{skill.name}</small><h2>{skill.label}</h2><p>{skill.description || 'No usage guidance provided yet.'}</p></div>
        <div className="skill-content-preview"><FileText size={14} /><p>{preview || 'No prompt content.'}{skill.content.length > preview.length ? '…' : ''}</p></div>
        <div className="skill-card-impact"><span><Bot size={13} /><b>{assignments.length}</b> assigned {assignments.length === 1 ? 'agent' : 'agents'}</span><small>Updated {skill.updated_at ? timeAgo(skill.updated_at) : '—'}</small></div>
        {assignments.length > 0 && <div className="skill-agent-row">{assignments.slice(0, 3).map(agent => <span title={agent.name} key={agent.id}>{agent.label}</span>)}{assignments.length > 3 && <em>+{assignments.length - 3}</em>}</div>}
        <footer><a href="/build/agents/manage"><Bot size={13} />Assign in Agent Studio</a><button className="is-primary" type="button" onClick={() => { saveMutation.reset(); deleteMutation.reset(); setEditing(skill); }}><Pencil size={13} />Edit</button></footer>
      </article>;
    })}</section> : <section className="panel"><EmptyState title="No matching skills" description={allSkills.length === 0 ? 'Create the first reusable instruction module for your agents.' : 'Change the search phrase or library filter.'} /></section>}</>}

    {view === 'adoption' && (adoption.isLoading ? <LoadingState label="Loading skill adoption analytics…" /> : adoption.error ? <ErrorState error={adoption.error} /> : adoption.data ? <AdoptionAnalytics data={adoption.data} /> : null)}

    {editing !== undefined && <SkillEditor key={editing?.id ?? 'new'} skill={editing} busy={saveMutation.isPending || deleteMutation.isPending} error={saveMutation.error?.message ?? deleteMutation.error?.message ?? null} onClose={() => { if (!saveMutation.isPending && !deleteMutation.isPending) setEditing(undefined); }} onSave={input => saveMutation.mutate({ input, id: editing?.id })} onDelete={skill => deleteMutation.mutate(skill)} />}
  </>;
}
