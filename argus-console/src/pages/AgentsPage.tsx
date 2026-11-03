import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  Eye,
  MessageSquare,
  Plus,
  Search,
  Settings2,
  Sparkles,
} from 'lucide-react';
import { deleteAgentStudioAgent, getAgents, getAgentStudio, getConsoleUser, saveAgentStudioAgent } from '../api';
import { isPlatformAdminRole } from '../access';
import { AgentEditor } from '../components/AgentEditor';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/Ui';
import { AgentWorkspaceTabs } from '../features/agents/AgentWorkspaceTabs';
import type { AgentStudioSaveInput, ManagedAgent } from '../types';

type AgentFilter = 'all' | 'vision';

export function AgentsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [search, setSearch] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [configureAgentId, setConfigureAgentId] = useState<number | null>(() => {
    const value = Number(searchParams.get('agent'));
    return Number.isInteger(value) && value > 0 ? value : null;
  });
  const agentsQuery = useQuery({ queryKey: ['agents'], queryFn: getAgents, staleTime: 15_000 });
  const userQuery = useQuery({ queryKey: ['console-user'], queryFn: getConsoleUser, staleTime: 30_000 });
  const studioQuery = useQuery({
    queryKey: ['agent-studio'],
    queryFn: getAgentStudio,
    staleTime: 10_000,
    enabled: configureAgentId != null || creatingAgent,
  });

  useEffect(() => {
    const value = Number(searchParams.get('agent'));
    if (Number.isInteger(value) && value > 0) setConfigureAgentId(value);
  }, [searchParams]);

  const closeEditor = () => {
    setCreatingAgent(false);
    setConfigureAgentId(null);
    if (!searchParams.has('agent')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('agent');
    setSearchParams(next, { replace: true });
  };

  const saveMutation = useMutation({
    mutationFn: ({ input, agentId }: { input: AgentStudioSaveInput; agentId?: number }) =>
      saveAgentStudioAgent(input, agentId),
    onSuccess: async () => {
      closeEditor();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-studio'] }),
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
      ]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (agent: ManagedAgent) => deleteAgentStudioAgent(agent.id),
    onSuccess: async () => {
      closeEditor();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-studio'] }),
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
      ]);
    },
  });

  const agents = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (agentsQuery.data ?? []).filter(agent => {
      if (filter === 'vision' && !agent.supports_vision) return false;
      return !normalized
        || `${agent.label} ${agent.name} ${agent.description} ${agent.effective_model ?? agent.model} ${agent.runtime_label ?? ''}`.toLowerCase().includes(normalized);
    });
  }, [agentsQuery.data, filter, search]);

  if (agentsQuery.isLoading) return <LoadingState label="Loading eligible agents…" />;
  if (agentsQuery.error) return <ErrorState error={agentsQuery.error} />;

  const allAgents = agentsQuery.data ?? [];
  const modelCount = new Set(allAgents.map(agent => agent.effective_model ?? agent.model)).size;
  const visionCount = allAgents.filter(agent => agent.supports_vision).length;
  const canManage = isPlatformAdminRole(userQuery.data?.role);
  const configuredAgent = studioQuery.data?.agents.find(agent => agent.id === configureAgentId) ?? null;
  const editorOpen = creatingAgent || configureAgentId != null;
  const editorError = saveMutation.error?.message || deleteMutation.error?.message || null;

  return (
    <>
      <PageHeader
        eyebrow="BUILD"
        title="Agent Studio"
        description="Build, evaluate and publish governed agents with their effective models, knowledge, skills and channels."
        actions={(
          <>
            <a className="button button-secondary" href="/chat"><MessageSquare size={16} />Open agent chat</a>
            {canManage && <a className="button button-secondary" href="/build/agents/manage"><Settings2 size={16} />Open blueprints</a>}
            {canManage && <button className="button button-primary" type="button" onClick={() => { setConfigureAgentId(null); setCreatingAgent(true); }}><Plus size={16} />Create new agent</button>}
          </>
        )}
      />

      <AgentWorkspaceTabs active="installed" />

      <section className="metric-grid build-metrics" aria-label="Agent summary">
        <article className="metric-card">
          <span className="metric-icon violet"><Bot size={17} /></span>
          <div><span>Eligible agents</span><strong>{allAgents.length}</strong><small>visible under your policies</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon teal"><BrainCircuit size={17} /></span>
          <div><span>Active models</span><strong>{modelCount}</strong><small>direct provider assignments</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon blue"><Eye size={17} /></span>
          <div><span>Vision capable</span><strong>{visionCount}</strong><small>multimodal agents</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon amber"><Sparkles size={17} /></span>
          <div><span>Access mode</span><strong className="metric-word">Policy filtered</strong><small>role, user and group rules</small></div>
        </article>
      </section>

      <div className="build-toolbar">
        <div className="segmented-filter" aria-label="Filter agents">
          <button className={filter === 'all' ? 'is-active' : ''} type="button" onClick={() => setFilter('all')}>All agents</button>
          <button className={filter === 'vision' ? 'is-active' : ''} type="button" onClick={() => setFilter('vision')}>Vision capable</button>
        </div>
        <label className="search-field">
          <Search size={16} />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search agents and models" />
        </label>
      </div>

      {agents.length > 0 ? (
        <section className="build-card-grid agent-card-grid" aria-label="Agents">
          {agents.map(agent => (
            <article className="build-card agent-card" key={agent.id}>
              <div className="build-card-head">
                <span className="agent-avatar"><Bot size={20} /></span>
                <div className="build-card-badges">
                  {agent.supports_vision && <span className="capability-badge"><Eye size={11} />Vision</span>}
                  <span className="availability-badge"><i />Available</span>
                </div>
              </div>
              <div className="build-card-title">
                <small>{agent.name}</small>
                <h2>{agent.label}</h2>
                <p>{agent.description || 'No agent description provided yet.'}</p>
              </div>
              <div className="agent-model">
                <BrainCircuit size={14} />
                <span>
                  <small>{agent.runtime_label ? 'EXECUTION RUNTIME' : 'MODEL'}</small>
                  <code>{[
                    agent.runtime_label,
                    agent.effective_model ?? agent.model,
                    agent.reasoning_effort,
                  ].filter(Boolean).join(' · ')}</code>
                </span>
              </div>
              <div className="build-card-actions">
                <a href={`/chat/${agent.id}`}><MessageSquare size={14} />Start chat</a>
                {canManage && <button className="agent-configure-action" type="button" onClick={() => setConfigureAgentId(agent.id)}>Configure <ArrowRight size={13} /></button>}
              </div>
            </article>
          ))}
        </section>
      ) : (
        <section className="panel">
          <EmptyState title="No matching agents" description="Change the filter or ask an administrator to grant access to an agent." />
        </section>
      )}

      {editorOpen && studioQuery.isLoading && (
        <div className="editor-layer" role="presentation">
          <section className="bundle-editor agent-editor agent-editor-loading" role="dialog" aria-modal="true" aria-label="Loading agent configuration">
            <LoadingState label="Loading agent configuration…" />
          </section>
        </div>
      )}
      {editorOpen && studioQuery.error && (
        <div className="editor-layer" role="presentation" onMouseDown={closeEditor}>
          <section className="bundle-editor agent-editor agent-editor-loading" role="dialog" aria-modal="true" aria-label="Agent configuration unavailable" onMouseDown={event => event.stopPropagation()}>
            <ErrorState error={studioQuery.error} />
            <button className="button button-secondary" type="button" onClick={closeEditor}>Close</button>
          </section>
        </div>
      )}
      {editorOpen && studioQuery.data && (creatingAgent || configuredAgent) && (
        <AgentEditor
          key={configuredAgent?.id ?? 'new'}
          agent={configuredAgent}
          catalog={studioQuery.data}
          busy={saveMutation.isPending || deleteMutation.isPending}
          error={editorError}
          onClose={closeEditor}
          onSave={input => saveMutation.mutate({ input, agentId: configuredAgent?.id })}
          onDelete={agent => deleteMutation.mutate(agent)}
        />
      )}
    </>
  );
}
