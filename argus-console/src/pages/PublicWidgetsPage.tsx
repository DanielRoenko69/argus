import { useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  Braces,
  Check,
  Clipboard,
  ExternalLink,
  Eye,
  Globe2,
  MessageSquare,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  Trash2,
  Terminal,
  X,
  Zap,
} from 'lucide-react';
import { isPlatformAdminRole } from '../access';
import {
  deletePublicWidget,
  disablePublicWidgetDemo,
  getOverview,
  getPublicWidgets,
  provisionPublicWidgetDemo,
  savePublicWidget,
} from '../api';
import { ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { AgentWorkspaceTabs } from '../features/agents/AgentWorkspaceTabs';
import type { PublicWidgetMutation, PublicWidgetRecord, PublicWidgetRuntimeState } from '../types';

interface WidgetDraft {
  slug: string;
  agentId: number;
  allowedOrigins: string;
  greeting: string;
  accent: string;
  title: string;
  inputPlaceholder: string;
  launcherIconUrl: string;
  launcherIconAlt: string;
  launcherPosition: 'left' | 'right';
  rateLimitPerIp: number;
  dailyTokenCap: number;
  enabled: boolean;
}

const runtimeLabels: Record<PublicWidgetRuntimeState, string> = {
  active: 'Publicly reachable',
  master_disabled: 'Master switch off',
  widget_disabled: 'Widget disabled',
  agent_unavailable: 'Agent unavailable',
  origins_missing: 'Origin policy missing',
};

function draftFor(widget: PublicWidgetRecord | null, fallbackAgentId: number): WidgetDraft {
  return widget ? {
    slug: widget.slug,
    agentId: widget.agentId,
    allowedOrigins: widget.allowedOrigins.join('\n'),
    greeting: widget.greeting ?? '',
    accent: widget.accent ?? '#111318',
    title: widget.title ?? 'Chat',
    inputPlaceholder: widget.inputPlaceholder ?? 'Write a message...',
    launcherIconUrl: widget.launcherIconUrl ?? '',
    launcherIconAlt: widget.launcherIconAlt ?? '',
    launcherPosition: widget.launcherPosition,
    rateLimitPerIp: widget.rateLimitPerIp,
    dailyTokenCap: widget.dailyTokenCap,
    enabled: widget.enabled,
  } : {
    slug: '',
    agentId: fallbackAgentId,
    allowedOrigins: '',
    greeting: 'Hello! How can I help?',
    accent: '#111318',
    title: 'Chat',
    inputPlaceholder: 'Write a message...',
    launcherIconUrl: '',
    launcherIconAlt: '',
    launcherPosition: 'right',
    rateLimitPerIp: 20,
    dailyTokenCap: 50_000,
    enabled: true,
  };
}

function parseOrigins(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map(origin => origin.trim()).filter(Boolean))];
}

function widgetMutation(draft: WidgetDraft, create: boolean): PublicWidgetMutation {
  return {
    ...(create ? { slug: draft.slug.trim() } : {}),
    agentId: draft.agentId,
    allowedOrigins: parseOrigins(draft.allowedOrigins),
    greeting: draft.greeting.trim() || null,
    accent: draft.accent.trim() || null,
    title: draft.title.trim() || null,
    inputPlaceholder: draft.inputPlaceholder.trim() || null,
    launcherIconUrl: draft.launcherIconUrl.trim() || null,
    launcherIconAlt: draft.launcherIconAlt.trim() || null,
    launcherPosition: draft.launcherPosition,
    rateLimitPerIp: Number(draft.rateLimitPerIp),
    dailyTokenCap: Number(draft.dailyTokenCap),
    enabled: draft.enabled,
  };
}

function escapeEmbedAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function embedSnippet(widget: PublicWidgetRecord): string {
  const origin = window.location.origin;
  const attributes: Array<[string, string | null]> = [
    ['data-accent', widget.accent],
    ['data-title', widget.title],
    ['data-greeting', widget.greeting],
    ['data-placeholder', widget.inputPlaceholder],
    ['data-icon-url', widget.launcherIconUrl],
    ['data-icon-alt', widget.launcherIconAlt],
    ['data-position', widget.launcherPosition],
  ];
  const branding = attributes.flatMap(([name, value]) => value
    ? [`\n        ${name}="${escapeEmbedAttribute(value)}"`]
    : []).join('');
  return `<script src="${origin}${widget.scriptPath}"
        data-slug="${widget.slug}"
        data-argus-origin="${origin}"${branding}>
</script>`;
}

export function PublicWidgetsPage() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, staleTime: 15_000 });
  const catalog = useQuery({ queryKey: ['public-widgets'], queryFn: getPublicWidgets });
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<{ id: number | null; draft: WidgetDraft } | null>(null);
  const [snippetWidget, setSnippetWidget] = useState<PublicWidgetRecord | null>(null);
  const [previewWidget, setPreviewWidget] = useState<PublicWidgetRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PublicWidgetRecord | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: PublicWidgetMutation }) => savePublicWidget(input, id ?? undefined),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['public-widgets'] });
      setEditor(null);
      setNotice(variables.id == null ? 'Public widget created.' : 'Public widget updated.');
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deletePublicWidget(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['public-widgets'] });
      setDeleteTarget(null);
      setDeleteConfirmation('');
      setNotice('Public widget deleted.');
    },
  });
  const toggle = useMutation({
    mutationFn: (widget: PublicWidgetRecord) => savePublicWidget({ enabled: !widget.enabled }, widget.id),
    onSuccess: async widget => {
      await queryClient.invalidateQueries({ queryKey: ['public-widgets'] });
      setNotice(widget.enabled ? 'Public widget enabled.' : 'Public widget disabled.');
    },
  });
  const prepareDemo = useMutation({
    mutationFn: () => provisionPublicWidgetDemo(window.location.origin, [
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    ]),
    onSuccess: async result => {
      await queryClient.invalidateQueries({ queryKey: ['public-widgets'] });
      setNotice(result.demo.reachable
        ? 'Public demo is ready.'
        : 'Public demo prepared. Enable the local public runtime to make it reachable.');
    },
  });
  const stopDemo = useMutation({
    mutationFn: disablePublicWidgetDemo,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['public-widgets'] });
      setPreviewWidget(null);
      setNotice('Public demo disabled. The agent is internal and inactive again.');
    },
  });

  const visibleWidgets = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (catalog.data?.widgets ?? []).filter(widget => !needle || [
      widget.slug,
      widget.agent?.label,
      widget.agent?.name,
      widget.greeting,
      ...widget.allowedOrigins,
    ].filter(Boolean).join(' ').toLowerCase().includes(needle));
  }, [catalog.data?.widgets, search]);

  if (overview.isLoading || catalog.isLoading) return <LoadingState label="Loading public channels…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  if (!isPlatformAdminRole(overview.data?.user.role)) return <ErrorState error={new Error('Platform administrator access required.')} />;
  if (catalog.error) return <ErrorState error={catalog.error} />;
  if (!catalog.data) return null;

  const activeCount = catalog.data.widgets.filter(widget => widget.runtimeState === 'active').length;
  const originCount = new Set(catalog.data.widgets.flatMap(widget => widget.allowedOrigins)).size;
  const dailyBudget = catalog.data.widgets.reduce((total, widget) => total + widget.dailyTokenCap, 0);
  const demo = catalog.data.demo;
  const demoWidget = demo.widgetId == null
    ? null
    : catalog.data.widgets.find(widget => widget.id === demo.widgetId) ?? null;
  const runtimeCommand = '.\\scripts\\public-widget-runtime.ps1 enable';
  const demoWebsiteUrl = 'http://localhost:4173';
  const openCreate = () => setEditor({ id: null, draft: draftFor(null, catalog.data!.agents[0]?.id ?? 0) });
  const openEdit = (widget: PublicWidgetRecord) => setEditor({ id: widget.id, draft: draftFor(widget, widget.agentId) });
  const updateDraft = <K extends keyof WidgetDraft>(key: K, value: WidgetDraft[K]) => setEditor(current => current
    ? { ...current, draft: { ...current.draft, [key]: value } }
    : current);

  return (
    <>
      <PageHeader
        eyebrow="AGENT STUDIO · CHANNELS"
        title="Public channels"
        description="Publish governed AI chat experiences without exposing internal agent or credential boundaries."
        actions={<button className="button button-primary" type="button" disabled={catalog.data.agents.length === 0} onClick={openCreate}><Plus size={15} />Create widget</button>}
      />

      <AgentWorkspaceTabs active="channels" />

      <section className={`public-widget-onboarding${demo.reachable ? ' is-ready' : ''}`} aria-label="Public widget prototype setup">
        <header>
          <span><Rocket size={19} /></span>
          <div><span className="eyebrow">LOCAL PROTOTYPE</span><h2>Launch a governed website assistant</h2><p>Prepare an isolated demo Agent, bind it to this exact local origin and preview the real anonymous chat before publishing anything externally.</p></div>
          <em>{demo.reachable ? 'Demo ready' : demo.configured ? 'Setup incomplete' : 'Not configured'}</em>
        </header>
        <div className="public-widget-onboarding-steps">
          <article className={demo.configured ? 'is-complete' : ''}><i>{demo.configured ? <Check size={13} /> : '1'}</i><div><b>Demo resources</b><span>Dedicated Agent and local widget</span></div></article>
          <article className={catalog.data.masterEnabled ? 'is-complete' : ''}><i>{catalog.data.masterEnabled ? <Check size={13} /> : '2'}</i><div><b>Public runtime</b><span>Explicit operator-controlled switch</span></div></article>
          <article className={demo.agentReady ? 'is-complete' : ''}><i>{demo.agentReady ? <Check size={13} /> : '3'}</i><div><b>Isolated Agent</b><span>No tools, private RAG or shared memory</span></div></article>
          <article className={demo.reachable ? 'is-complete' : ''}><i>{demo.reachable ? <Check size={13} /> : '4'}</i><div><b>Website preview</b><span>Origin-bound anonymous chat</span></div></article>
        </div>
        {!catalog.data.masterEnabled && (
          <div className="public-widget-runtime-command">
            <Terminal size={15} />
            <div><b>Enable only this local environment</b><code>{runtimeCommand}</code></div>
            <button type="button" onClick={async () => { await navigator.clipboard?.writeText(runtimeCommand); setNotice('Local enable command copied.'); }}><Clipboard size={13} />Copy</button>
          </div>
        )}
        {(prepareDemo.error || stopDemo.error) && <p className="public-widget-form-error" role="alert">{(prepareDemo.error || stopDemo.error) instanceof Error ? (prepareDemo.error || stopDemo.error)?.message : 'Prototype setup failed.'}</p>}
        <footer>
          <button className="button button-secondary" type="button" disabled={catalog.isFetching} onClick={() => catalog.refetch()}><RefreshCw size={14} />Refresh state</button>
          {(!demo.configured || !demo.agentReady || !demo.widgetEnabled) && <button className="button button-primary" type="button" disabled={prepareDemo.isPending} onClick={() => prepareDemo.mutate()}><Rocket size={14} />{prepareDemo.isPending ? 'Preparing…' : demo.configured ? 'Enable demo resources' : 'Prepare local demo'}</button>}
          {demo.reachable && <a className="button button-primary" href={demoWebsiteUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open demo website</a>}
          {demo.reachable && demoWidget && <button className="button button-secondary" type="button" onClick={() => setPreviewWidget(demoWidget)}><Eye size={14} />Preview widget</button>}
          {demo.configured && (demo.agentReady || demo.widgetEnabled) && <button className="button button-secondary" type="button" disabled={stopDemo.isPending} onClick={() => stopDemo.mutate()}><Power size={14} />{stopDemo.isPending ? 'Disabling…' : 'Disable demo'}</button>}
        </footer>
      </section>

      {!catalog.data.masterEnabled && (
        <section className="public-widget-master is-disabled" role="status">
          <span><Power size={18} /></span>
          <div><b>Public runtime is globally paused</b><p>Configurations are editable, but no anonymous widget is reachable until <code>PUBLIC_WIDGET_ENABLED=true</code>.</p></div>
          <em>Fail closed</em>
        </section>
      )}
      {catalog.data.agents.length === 0 && (
        <section className="public-widget-master is-warning" role="status">
          <span><AlertTriangle size={18} /></span>
          <div><b>No eligible public agent</b><p>Enable an agent and explicitly set its visibility to public before creating a widget.</p></div>
          <a href="/build/agents/manage">Open Agent Studio</a>
        </section>
      )}
      {notice && <div className="console-notice is-success" role="status"><Check size={14} />{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={13} /></button></div>}

      <section className="public-widget-metrics" aria-label="Public widget summary">
        <article><span className="metric-icon violet"><MessageSquare size={17} /></span><div><small>Configured</small><strong>{catalog.data.widgets.length}</strong><em>public channels</em></div></article>
        <article><span className="metric-icon teal"><Zap size={17} /></span><div><small>Reachable</small><strong>{activeCount}</strong><em>{catalog.data.masterEnabled ? 'effective runtime' : 'master switch off'}</em></div></article>
        <article><span className="metric-icon blue"><Globe2 size={17} /></span><div><small>Trusted origins</small><strong>{originCount}</strong><em>exact-match policies</em></div></article>
        <article><span className="metric-icon amber"><ShieldCheck size={17} /></span><div><small>Daily ceiling</small><strong>{Intl.NumberFormat('en', { notation: 'compact' }).format(dailyBudget)}</strong><em>tokens across widgets</em></div></article>
      </section>

      <div className="public-widget-toolbar">
        <label className="search-field"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Widget, agent or origin" /></label>
        <span><ShieldCheck size={13} />Exact origins · public agents · hard token caps</span>
      </div>

      {visibleWidgets.length > 0 ? (
        <div className="public-widget-grid">
          {visibleWidgets.map(widget => (
            <article className={`public-widget-card state-${widget.runtimeState}`} key={widget.id}>
              <header>
                <span className="public-widget-glyph" style={{ '--widget-accent': widget.accent ?? '#111318' } as CSSProperties}><MessageSquare size={17} /></span>
                <div><small>/{widget.slug}</small><h2>{widget.greeting || widget.slug}</h2></div>
                <span className={`public-widget-state state-${widget.runtimeState}`}><i />{runtimeLabels[widget.runtimeState]}</span>
              </header>
              <div className="public-widget-agent"><Bot size={14} /><span><b>{widget.agent?.label || `Agent #${widget.agentId}`}</b><small>{widget.agent?.name || 'Agent assignment unavailable'}</small></span></div>
              <section className="public-widget-origins">
                <span>Allowed origins</span>
                <div>{widget.allowedOrigins.length > 0 ? widget.allowedOrigins.map(origin => <code key={origin}>{origin}</code>) : <em>No origin configured</em>}</div>
              </section>
              <dl>
                <div><dt>Rate / IP</dt><dd>{widget.rateLimitPerIp}/min</dd></div>
                <div><dt>Daily cap</dt><dd>{Intl.NumberFormat().format(widget.dailyTokenCap)}</dd></div>
                <div><dt>Created</dt><dd>{timeAgo(widget.createdAt)}</dd></div>
              </dl>
              <footer>
                <button type="button" onClick={() => setSnippetWidget(widget)}><Braces size={13} />Embed</button>
                {widget.runtimeState === 'active' && <button type="button" onClick={() => setPreviewWidget(widget)}><Eye size={13} />Preview</button>}
                <button type="button" onClick={() => openEdit(widget)}><Pencil size={13} />Edit</button>
                <button type="button" disabled={toggle.isPending} onClick={() => toggle.mutate(widget)}><Power size={13} />{widget.enabled ? 'Disable' : 'Enable'}</button>
                <button className="is-danger" type="button" onClick={() => { setDeleteTarget(widget); setDeleteConfirmation(''); }}><Trash2 size={13} />Delete</button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel public-widget-empty">
          <MessageSquare size={24} />
          <h2>{catalog.data.widgets.length === 0 ? 'No public widgets yet' : 'No widgets match this filter'}</h2>
          <p>{catalog.data.widgets.length === 0 ? 'Create a tightly scoped public channel for an explicitly public agent.' : 'Try another widget, agent or origin.'}</p>
          {catalog.data.widgets.length === 0 && catalog.data.agents.length > 0 && <button className="button button-primary" type="button" onClick={openCreate}><Plus size={14} />Create first widget</button>}
        </section>
      )}

      {editor && (
        <div className="public-widget-layer" role="presentation" onMouseDown={() => setEditor(null)}>
          <section className="public-widget-editor" role="dialog" aria-modal="true" aria-label={editor.id == null ? 'Create public widget' : `Edit ${editor.draft.slug}`} onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">PUBLIC CHANNEL</span><h2>{editor.id == null ? 'Create widget' : `Edit /${editor.draft.slug}`}</h2></div><button type="button" aria-label="Close widget editor" onClick={() => setEditor(null)}><X size={17} /></button></header>
            <form onSubmit={event => { event.preventDefault(); save.mutate({ id: editor.id, input: widgetMutation(editor.draft, editor.id == null) }); }}>
              <div className="public-widget-form-grid">
                <label><span>Slug</span><input aria-label="Widget slug" value={editor.draft.slug} readOnly={editor.id != null} required pattern="[a-z0-9_-]+" maxLength={128} onChange={event => updateDraft('slug', event.target.value)} /><small>Stable public identifier; lowercase characters, digits, _ and -.</small></label>
                <label><span>Public agent</span><select aria-label="Public agent" value={editor.draft.agentId || ''} required onChange={event => updateDraft('agentId', Number(event.target.value))}>{catalog.data.agents.map(agent => <option value={agent.id} key={agent.id}>{agent.label} · {agent.name}</option>)}</select><small>Only enabled agents with explicit public visibility are eligible.</small></label>
                <label className="is-wide"><span>Allowed origins</span><textarea aria-label="Allowed origins" value={editor.draft.allowedOrigins} required={editor.draft.enabled} rows={4} placeholder={'https://www.example.com\nhttps://support.example.com'} onChange={event => updateDraft('allowedOrigins', event.target.value)} /><small>One exact HTTP(S) origin per line. Paths, credentials and wildcards are rejected.</small></label>
                <label><span>Widget title</span><input aria-label="Widget title" value={editor.draft.title} maxLength={80} placeholder="Support assistant" onChange={event => updateDraft('title', event.target.value)} /></label>
                <label><span>Input placeholder</span><input aria-label="Widget input placeholder" value={editor.draft.inputPlaceholder} maxLength={160} placeholder="Write a message..." onChange={event => updateDraft('inputPlaceholder', event.target.value)} /></label>
                <label className="is-wide"><span>Welcome message</span><input aria-label="Widget greeting" value={editor.draft.greeting} maxLength={500} placeholder="Hello! How can I help?" onChange={event => updateDraft('greeting', event.target.value)} /><small>Displayed as the first assistant message; it can also be overridden per embed with data-greeting.</small></label>
                <label className="is-wide"><span>Launcher image URL</span><input aria-label="Launcher image URL" value={editor.draft.launcherIconUrl} maxLength={2048} placeholder="https://www.example.com/brand/assistant.png or /brand/assistant.png" onChange={event => updateDraft('launcherIconUrl', event.target.value)} /><small>Absolute HTTP(S) image or a root-relative path on the embedding website.</small></label>
                <label><span>Launcher image alt text</span><input aria-label="Launcher image alt text" value={editor.draft.launcherIconAlt} maxLength={120} placeholder="Open support assistant" onChange={event => updateDraft('launcherIconAlt', event.target.value)} /></label>
                <label><span>Launcher position</span><select aria-label="Launcher position" value={editor.draft.launcherPosition} onChange={event => updateDraft('launcherPosition', event.target.value as 'left' | 'right')}><option value="right">Bottom right</option><option value="left">Bottom left</option></select></label>
                <label><span>Brand accent</span><div className="public-widget-color"><input type="color" aria-label="Accent picker" value={/^#[0-9a-fA-F]{6}$/.test(editor.draft.accent) ? editor.draft.accent : '#111318'} onChange={event => updateDraft('accent', event.target.value)} /><input aria-label="Accent color" value={editor.draft.accent} pattern="#[0-9a-fA-F]{6}" maxLength={7} onChange={event => updateDraft('accent', event.target.value)} /></div><small>Dark is the default; the embed may override this with data-accent.</small></label>
                <section className="public-widget-brand-preview is-wide" aria-label="Widget branding preview" style={{ '--widget-preview-accent': /^#[0-9a-fA-F]{6}$/.test(editor.draft.accent) ? editor.draft.accent : '#111318' } as CSSProperties}>
                  <span className="public-widget-brand-launcher">{/^https?:\/\//i.test(editor.draft.launcherIconUrl) ? <img src={editor.draft.launcherIconUrl} alt="" /> : <MessageSquare size={18} />}</span>
                  <div><small>BRANDING PREVIEW</small><b>{editor.draft.title || 'Chat'}</b><p>{editor.draft.greeting || 'Hello! How can I help?'}</p><em>{editor.draft.inputPlaceholder || 'Write a message...'}</em></div>
                </section>
                <label><span>Requests per IP / minute</span><input aria-label="Rate limit per IP" type="number" min={1} max={catalog.data.limits.maxRateLimitPerIp} value={editor.draft.rateLimitPerIp} onChange={event => updateDraft('rateLimitPerIp', Number(event.target.value))} /></label>
                <label><span>Daily token cap</span><input aria-label="Daily token cap" type="number" min={catalog.data.limits.minDailyTokenCap} max={catalog.data.limits.maxDailyTokenCap} value={editor.draft.dailyTokenCap} onChange={event => updateDraft('dailyTokenCap', Number(event.target.value))} /></label>
                <label className="public-widget-enable"><input aria-label="Widget enabled" type="checkbox" checked={editor.draft.enabled} onChange={event => updateDraft('enabled', event.target.checked)} /><span><b>Widget enabled</b><small>The global master switch and agent gate still apply.</small></span></label>
              </div>
              {save.error && <p className="public-widget-form-error" role="alert">{save.error instanceof Error ? save.error.message : 'Widget could not be saved.'}</p>}
              <footer><button className="button button-secondary" type="button" onClick={() => setEditor(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={save.isPending || editor.draft.agentId <= 0}>{save.isPending ? 'Saving…' : editor.id == null ? 'Create widget' : 'Save changes'}</button></footer>
            </form>
          </section>
        </div>
      )}

      {snippetWidget && (
        <div className="public-widget-layer" role="presentation" onMouseDown={() => setSnippetWidget(null)}>
          <section className="public-widget-snippet" role="dialog" aria-modal="true" aria-label={`Embed ${snippetWidget.slug}`} onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">EMBED</span><h2>Publish /{snippetWidget.slug}</h2></div><button type="button" aria-label="Close embed code" onClick={() => setSnippetWidget(null)}><X size={17} /></button></header>
            <div className="public-widget-security-note"><ShieldCheck size={15} /><p><b>Host policy remains server-enforced</b><span>The script can render only on configured origins; tokens remain inside the sandboxed iframe.</span></p></div>
            <div className="public-widget-security-note"><Braces size={15} /><p><b>Branding stays in the embed contract</b><span>Customize data-accent, data-title and data-position. Add data-icon-url, data-icon-alt, data-greeting or data-placeholder when the website needs its own presentation.</span></p></div>
            <pre>{embedSnippet(snippetWidget)}</pre>
            <footer><button className="button button-secondary" type="button" onClick={() => { setPreviewWidget(snippetWidget); setSnippetWidget(null); }}><Eye size={14} />Preview</button><a className="button button-secondary" href={snippetWidget.publicPath} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open tab</a><button className="button button-primary" type="button" onClick={async () => { await navigator.clipboard?.writeText(embedSnippet(snippetWidget)); setNotice('Embed snippet copied.'); }}><Clipboard size={14} />Copy snippet</button></footer>
          </section>
        </div>
      )}

      {previewWidget && (
        <div className="public-widget-layer" role="presentation" onMouseDown={() => setPreviewWidget(null)}>
          <section className="public-widget-preview" role="dialog" aria-modal="true" aria-label={`Preview ${previewWidget.slug}`} onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">WEBSITE PREVIEW</span><h2>/{previewWidget.slug}</h2><p>Rendered through the same sandboxed iframe used by an external website.</p></div><button type="button" aria-label="Close widget preview" onClick={() => setPreviewWidget(null)}><X size={17} /></button></header>
            <div><iframe title={`Public widget ${previewWidget.slug}`} src={previewWidget.publicPath} sandbox="allow-forms allow-scripts allow-same-origin" /></div>
            <footer><span><ShieldCheck size={13} />Origin: {window.location.origin}</span><a className="button button-secondary" href={previewWidget.publicPath} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open standalone</a></footer>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="public-widget-layer" role="presentation" onMouseDown={() => setDeleteTarget(null)}>
          <section className="public-widget-delete" role="alertdialog" aria-modal="true" aria-label={`Delete ${deleteTarget.slug}`} onMouseDown={event => event.stopPropagation()}>
            <span><Trash2 size={19} /></span><div><h2>Delete /{deleteTarget.slug}?</h2><p>The public URL stops resolving immediately. Existing website snippets remain installed but inactive.</p></div>
            <label><span>Type <b>{deleteTarget.slug}</b> to confirm</span><input aria-label="Confirm widget slug" autoFocus value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} /></label>
            {remove.error && <p className="public-widget-form-error" role="alert">{remove.error instanceof Error ? remove.error.message : 'Widget could not be deleted.'}</p>}
            <footer><button className="button button-secondary" type="button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="button button-danger" type="button" disabled={deleteConfirmation !== deleteTarget.slug || remove.isPending} onClick={() => remove.mutate(deleteTarget.id)}>{remove.isPending ? 'Deleting…' : 'Delete widget'}</button></footer>
          </section>
        </div>
      )}
    </>
  );
}
