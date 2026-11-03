import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  ArrowLeft,
  Bot,
  Boxes,
  BrainCircuit,
  CheckCircle2,
  Database,
  Eye,
  History,
  KeyRound,
  Layers3,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import { applyAgentTemplateUpgrade, deleteAgentStudioAgent, getAgentStudio, getAgentTemplateUpgradePreview, installAgentTemplate, previewAgentTemplate, resyncAgentIdentity, saveAgentStudioAgent } from '../api';
import { AgentEditor } from '../components/AgentEditor';
import { AgentPresetBuilder } from '../components/AgentPresetBuilder';
import { AgentSessionsPanel } from '../components/AgentSessionsPanel';
import { EmptyState, ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { AgentWorkspaceTabs } from '../features/agents/AgentWorkspaceTabs';
import type { AgentStudioSaveInput, AgentTemplate, AgentTemplateDraft, AgentTemplateDraftInput, AgentTemplatePreflight, AgentTemplateUpgradePreview, ManagedAgent } from '../types';

type AgentModeFilter = 'all' | ManagedAgent['agent_mode'];
type UpgradeTarget = string | { name: string; agentId: number };

function displayLifecycleValue(value: unknown): string {
  if (value == null) return 'Not set';
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return rendered.length > 180 ? `${rendered.slice(0, 177)}…` : rendered;
}

function newPresetDraft(): AgentTemplateDraftInput {
  return {
    name: 'custom_agent', label: 'Custom Agent', description: '', category: 'custom', agentMode: 'chat',
    config: {
      temperature: 0.3, maxTokens: 4096, maxIterations: 10, systemPrompt: '', agentRole: '',
      untrustedToolOutputEnforcement: true, humanOversightRequired: false,
      codegraphEnabled: false, visibility: 'internal', riskLevel: 'low',
    },
    compositeName: null, skillNames: [], recommendedCapabilities: [], requiredBy: [],
    requiredToolPatterns: [], minimumBundleCount: 0,
  };
}

function templateToDraft(template: AgentTemplate): AgentTemplateDraftInput {
  return {
    name: template.name, label: template.label, description: template.description,
    category: template.category, agentMode: template.agentMode, config: { ...template.config },
    compositeName: template.compositeName, skillNames: [...template.skillNames],
    recommendedCapabilities: [...template.recommendedCapabilities], requiredBy: [...template.requiredBy],
    requiredToolPatterns: [...template.requiredToolPatterns], minimumBundleCount: template.minimumBundleCount,
  };
}

export function AgentStudioPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<AgentModeFilter>('all');
  const [selected, setSelected] = useState<ManagedAgent | null | undefined>(undefined);
  const [sessionAgent, setSessionAgent] = useState<ManagedAgent | null>(null);
  const [notice, setNotice] = useState('');
  const [templateModels, setTemplateModels] = useState<Record<string, string>>({});
  const [templateRuntimeProfiles, setTemplateRuntimeProfiles] = useState<Record<string, string>>({});
  const [templateBundleIds, setTemplateBundleIds] = useState<Record<string, string>>({});
  const [templatePreflights, setTemplatePreflights] = useState<Record<string, AgentTemplatePreflight>>({});
  const [templateUpgrades, setTemplateUpgrades] = useState<Record<string, AgentTemplateUpgradePreview>>({});
  const [templateUpgradeAgents, setTemplateUpgradeAgents] = useState<Record<string, number>>({});
  const [presetBuilder, setPresetBuilder] = useState<{ initial: AgentTemplateDraftInput; draft: AgentTemplateDraft | null } | null>(null);
  const [requestedAgentId] = useState(() => {
    const value = Number(new URLSearchParams(window.location.search).get('agent'));
    return Number.isInteger(value) && value > 0 ? value : null;
  });
  const [requestApplied, setRequestApplied] = useState(false);
  const query = useQuery({ queryKey: ['agent-studio'], queryFn: getAgentStudio, staleTime: 10_000 });

  useEffect(() => {
    if (requestApplied || requestedAgentId == null || !query.data) return;
    const requested = query.data.agents.find(agent => agent.id === requestedAgentId);
    if (requested) setSelected(requested);
    setRequestApplied(true);
  }, [query.data, requestApplied, requestedAgentId]);

  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: AgentStudioSaveInput; id?: number }) => saveAgentStudioAgent(input, id),
    onSuccess: async (_saved, variables) => {
      setNotice(variables.id == null ? 'Agent created with all assignments.' : 'Agent configuration saved.');
      setSelected(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-studio'] }),
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        queryClient.invalidateQueries({ queryKey: ['overview'] }),
      ]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (agent: ManagedAgent) => deleteAgentStudioAgent(agent.id),
    onSuccess: async () => {
      setNotice('Agent deleted. Historical references were removed by the platform lifecycle rules.');
      setSelected(undefined);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['agent-studio'] }), queryClient.invalidateQueries({ queryKey: ['agents'] })]);
    },
  });
  const resyncMutation = useMutation({
    mutationFn: (agent: ManagedAgent) => resyncAgentIdentity(agent.id),
    onSuccess: async () => { setNotice('Agent identity synchronized with Entra.'); await queryClient.invalidateQueries({ queryKey: ['agent-studio'] }); },
  });
  const installMutation = useMutation({
    mutationFn: ({ name, model, runtimeProfileId, bundleIds }: { name: string; model: string; runtimeProfileId: number | null; bundleIds: number[] }) =>
      installAgentTemplate(name, { model, runtimeProfileId, bundleIds }),
    onSuccess: async agent => {
      setNotice(`${agent.label} installed with ${agent.model}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-studio'] }),
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        queryClient.invalidateQueries({ queryKey: ['overview'] }),
      ]);
    },
  });
  const previewMutation = useMutation({
    mutationFn: ({ name, model, runtimeProfileId, bundleIds }: { name: string; model: string; runtimeProfileId: number | null; bundleIds: number[] }) =>
      previewAgentTemplate(name, { model, runtimeProfileId, bundleIds }),
    onSuccess: preview => setTemplatePreflights(current => ({ ...current, [preview.templateName]: preview })),
  });
  const upgradePreviewMutation = useMutation({
    mutationFn: (target: UpgradeTarget) => typeof target === 'string'
      ? getAgentTemplateUpgradePreview(target)
      : getAgentTemplateUpgradePreview(target.name, target.agentId),
    onSuccess: preview => setTemplateUpgrades(current => ({ ...current, [preview.templateName]: preview })),
  });
  const upgradeMutation = useMutation({
    mutationFn: (target: UpgradeTarget) => typeof target === 'string'
      ? applyAgentTemplateUpgrade(target)
      : applyAgentTemplateUpgrade(target.name, target.agentId),
    onSuccess: async result => {
      setNotice(`${result.agent.label} upgraded to preset v${result.preview.targetVersion}.`);
      setTemplateUpgrades(current => {
        const next = { ...current };
        delete next[result.preview.templateName];
        return next;
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-studio'] }),
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        queryClient.invalidateQueries({ queryKey: ['overview'] }),
      ]);
    },
  });

  useEffect(() => {
    const create = new URLSearchParams(location.search).get('create');
    if (create !== 'agent' && create !== 'preset') return;
    if (create === 'preset') {
      setPresetBuilder({ initial: newPresetDraft(), draft: null });
    } else {
      saveMutation.reset();
      deleteMutation.reset();
      setSelected(null);
    }
    const params = new URLSearchParams(location.search);
    params.delete('create');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const clearTemplatePreflight = (name: string) => {
    setTemplatePreflights(current => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const agents = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (query.data?.agents ?? []).filter(agent => {
      if (mode !== 'all' && agent.agent_mode !== mode) return false;
      return !normalized || `${agent.label} ${agent.name} ${agent.description} ${agent.model} ${agent.agent_role ?? ''}`.toLowerCase().includes(normalized);
    });
  }, [mode, query.data?.agents, search]);

  if (query.isLoading) return <LoadingState label="Loading Agent Studio…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;

  const hasModels = query.data.models.length > 0;
  const hasAgents = query.data.agents.length > 0;
  const installedTemplateCount = query.data.templates.filter(template => template.installed).length;
  const defaultModel = query.data.models[0]?.model_name ?? '';
  const enabledCount = query.data.agents.filter(agent => agent.enabled).length;
  const workerCount = query.data.agents.filter(agent => agent.agent_mode !== 'chat').length;
  const directKeyCount = query.data.agents.filter(agent => agent.llm_api_key).length;
  const guardedCount = query.data.agents.filter(agent => agent.untrusted_tool_output_enforcement).length;
  const showAgentManagement = new URLSearchParams(location.search).get('view') === 'agents'
    || requestedAgentId != null
    || new URLSearchParams(location.search).get('create') === 'agent';

  return <>
    {showAgentManagement && <a className="back-link" href="/build/agents"><ArrowLeft size={14} />Back to agents</a>}
    <PageHeader eyebrow="AGENT STUDIO" title={showAgentManagement ? 'Manage agents' : 'Blueprints'} description={showAgentManagement ? 'Compose governed agents from models, MCP bundles, knowledge, reusable skills and runtime guardrails.' : 'Install and maintain reusable, provider-neutral Agent presets without mixing them with the installed Agent inventory.'} actions={<><button className="button button-secondary" type="button" onClick={() => setPresetBuilder({ initial: newPresetDraft(), draft: null })}><Layers3 size={15} />Author blueprint</button>{showAgentManagement && <><a className="button button-secondary" href="/agents"><Activity size={15} />Open chat</a><button className="button button-primary" type="button" disabled={!hasModels} title={hasModels ? undefined : 'Configure an AI model first'} onClick={() => { saveMutation.reset(); setSelected(null); }}><Plus size={15} />New agent</button></>}</>} />
    <AgentWorkspaceTabs active="blueprints" />

    {notice && <div className="connection-notice is-success" role="status"><ShieldCheck size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {(deleteMutation.error || resyncMutation.error || installMutation.error || previewMutation.error || upgradePreviewMutation.error || upgradeMutation.error) && <div className="connection-notice is-error" role="alert"><TriangleAlert size={16} /><span>{deleteMutation.error?.message || resyncMutation.error?.message || installMutation.error?.message || previewMutation.error?.message || upgradePreviewMutation.error?.message || upgradeMutation.error?.message}</span><button type="button" aria-label="Dismiss error" onClick={() => { deleteMutation.reset(); resyncMutation.reset(); installMutation.reset(); previewMutation.reset(); upgradePreviewMutation.reset(); upgradeMutation.reset(); }}><X size={14} /></button></div>}

    {!hasModels && <section className="agent-onboarding" aria-labelledby="agent-onboarding-title">
      <span className="agent-onboarding-icon"><BrainCircuit size={23} /></span>
      <div className="agent-onboarding-copy">
        <small>FRESH WORKSPACE · STEP 1 OF 3</small>
        <h2 id="agent-onboarding-title">Connect an AI model before building agents</h2>
        <p>Argus starts without assumed vendors, models or credentials. Add a provider-backed model or a direct endpoint, then choose it explicitly for every agent.</p>
        <div className="agent-onboarding-steps" aria-label="Agent setup steps">
          <span className="is-current"><b>1</b>Connect provider</span><ArrowRight size={13} />
          <span><b>2</b>Register model</span><ArrowRight size={13} />
          <span><b>3</b>Install or create</span>
        </div>
      </div>
      <a className="button button-primary" href="/settings/models">Configure AI models<ArrowRight size={14} /></a>
    </section>}

    {showAgentManagement && <><section className="metric-grid build-metrics" aria-label="Agent Studio summary">
      <article className="metric-card"><span className="metric-icon violet"><Bot size={17} /></span><div><span>Configured</span><strong>{query.data.agents.length}</strong><small>{enabledCount} enabled</small></div></article>
      <article className="metric-card"><span className="metric-icon blue"><BrainCircuit size={17} /></span><div><span>Worker roles</span><strong>{workerCount}</strong><small>worker and reviewer agents</small></div></article>
      <article className="metric-card"><span className="metric-icon teal"><ShieldCheck size={17} /></span><div><span>Output guarded</span><strong>{guardedCount}</strong><small>untrusted output enforcement</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><KeyRound size={17} /></span><div><span>Direct keys</span><strong>{directKeyCount}</strong><small>prefer shared provider config</small></div></article>
    </section>

    <div className="agent-studio-inventory">
      <span><Boxes size={14} />{query.data.bundles.length} bundles</span>
      <span><Database size={14} />{query.data.ragIndexes.length} knowledge indexes</span>
      <span><Sparkles size={14} />{query.data.skills.length} reusable skills</span>
      <span><BrainCircuit size={14} />{query.data.models.length} enabled models</span>
    </div></>}

    {query.data.drafts.length > 0 && <section className="agent-preset-drafts" aria-labelledby="agent-preset-drafts-title">
      <header><div><small>AUTHORING WORKSPACE</small><h2 id="agent-preset-drafts-title">Preset drafts</h2></div><span>{query.data.drafts.length} unpublished</span></header>
      <div>{query.data.drafts.map(draft => <article key={draft.name}><span><RefreshCw size={14} /></span><div><small>{draft.existingTemplate ? `UPDATE v${draft.baseVersion} → v${draft.targetVersion}` : `NEW v${draft.targetVersion}`}</small><b>{draft.definition.label}</b><p>{draft.definition.description || 'No description yet'}</p></div><button className="button button-secondary" type="button" onClick={() => setPresetBuilder({ initial: draft.definition, draft })}>Continue draft</button></article>)}</div>
    </section>}

    {query.data.templates.length > 0 && <section className="agent-template-panel" aria-labelledby="agent-template-title">
      <header>
        <div><small>OPTIONAL BLUEPRINTS</small><h2 id="agent-template-title">Starter agents</h2><p>Install a provider-neutral role with a model from your own catalog. Templates never add keys or silently choose a vendor.</p></div>
        <div className="agent-template-header-actions"><span><CheckCircle2 size={13} />{installedTemplateCount} of {query.data.templates.length} installed</span><button className="button button-secondary" type="button" onClick={() => setPresetBuilder({ initial: newPresetDraft(), draft: null })}><Plus size={13} />New preset</button></div>
      </header>
      <div className="agent-template-grid">{query.data.templates.map(template => {
        const selectedModel = templateModels[template.name] ?? defaultModel;
        const selectedRuntimeProfile = templateRuntimeProfiles[template.name] ?? '';
        const selectedBundleId = templateBundleIds[template.name] ?? '';
        const bundleSelectionReady = template.minimumBundleCount === 0 || Boolean(selectedBundleId);
        const compatibleBundles = query.data.bundles.filter(bundle => template.compatibleBundleIds.includes(bundle.id));
        const isInstalling = installMutation.isPending && installMutation.variables?.name === template.name;
        const isPreviewing = previewMutation.isPending && previewMutation.variables?.name === template.name;
        const preflight = templatePreflights[template.name];
        const readiness = preflight?.readiness;
        const installReady = Boolean(preflight?.selectionValid && readiness?.ready);
        const upgradePreview = templateUpgrades[template.name];
        const installedAgents = template.installedAgents ?? [];
        const fallbackInstalledAgent = template.installedAgentId == null ? [] : [{
          id: template.installedAgentId,
          name: template.name,
          label: template.label,
          model: 'Current model',
          installedVersion: template.installedVersion ?? 0,
        }];
        const upgradeAgents = installedAgents.length > 0 ? installedAgents : fallbackInstalledAgent;
        const selectedUpgradeAgentId = templateUpgradeAgents[template.name] ?? upgradeAgents[0]?.id ?? null;
        const selectedUpgradeAgent = upgradeAgents.find(agent => agent.id === selectedUpgradeAgentId) ?? upgradeAgents[0];
        const upgradeTarget: UpgradeTarget = installedAgents.length > 1 && selectedUpgradeAgentId != null
          ? { name: template.name, agentId: selectedUpgradeAgentId }
          : template.name;
        const isLoadingUpgrade = upgradePreviewMutation.isPending
          && (upgradePreviewMutation.variables === template.name
            || (typeof upgradePreviewMutation.variables !== 'string'
              && upgradePreviewMutation.variables.name === template.name
              && upgradePreviewMutation.variables.agentId === selectedUpgradeAgentId));
        const isUpgrading = upgradeMutation.isPending
          && (upgradeMutation.variables === template.name
            || (typeof upgradeMutation.variables !== 'string'
              && upgradeMutation.variables.name === template.name
              && upgradeMutation.variables.agentId === selectedUpgradeAgentId));
        const selectedInstalledVersion = selectedUpgradeAgent?.installedVersion ?? template.installedVersion;
        const selectedUpgradeAvailable = selectedInstalledVersion != null && template.version > selectedInstalledVersion;
        const existingDraft = query.data.drafts.find(draft => draft.name === template.name);
        return <article className={`agent-template-card${template.installed ? ' is-installed' : ''}`} key={template.id}>
          <div className="agent-template-heading"><span><Layers3 size={16} /></span><div><small>{template.category} · {template.agentMode}</small><h3>{template.label}</h3></div>{template.installed && <em className={selectedUpgradeAvailable ? 'has-update' : ''}>{selectedUpgradeAvailable ? <TriangleAlert size={11} /> : <CheckCircle2 size={11} />}{selectedInstalledVersion === 0 ? 'Legacy' : `v${selectedInstalledVersion}`}{selectedUpgradeAvailable ? ` → v${template.version}` : ' current'}</em>}</div>
          <p>{template.description}</p>
          <div className="agent-template-tags">{template.recommendedCapabilities.map(capability => <span key={capability}>{capability}</span>)}</div>
          {template.requiredToolPatterns.length > 0 && <div className="agent-template-requirements"><b><ShieldCheck size={11} />Required bundle capabilities</b>{template.requiredToolPatterns.map(pattern => <code key={pattern}>{pattern}</code>)}</div>}
          {template.requiredBy.length > 0 && <small className="agent-template-dependency">Used by {template.requiredBy.join(', ')}</small>}
          <button className="agent-template-edit" type="button" onClick={() => setPresetBuilder({ initial: existingDraft?.definition ?? templateToDraft(template), draft: existingDraft ?? null })}><Settings2 size={12} />{existingDraft ? 'Continue published update' : 'Create version draft'}</button>
          {preflight && <div className={`agent-template-preflight is-${readiness?.status ?? 'blocked'}`} aria-label={`Preflight for ${template.label}`}>
            <div><span>{readiness?.ready ? <CheckCircle2 size={13} /> : <TriangleAlert size={13} />}{readiness?.ready ? 'Ready to install' : 'Preflight blocked'}</span>{readiness && <em>{readiness.tools.length} effective tools</em>}</div>
            {readiness ? <><p>{readiness.runtime.detail}</p>{(readiness.blockers.length > 0 || readiness.warnings.length > 0) && <ul>{[...readiness.blockers, ...readiness.warnings].slice(0, 4).map(item => <li key={item}>{item}</li>)}</ul>}<small>{readiness.bundles.map(bundle => `${bundle.label} · ${bundle.state}`).join(' · ') || 'No MCP bundle required'}</small></> : <p>{preflight.errors.join(' · ')}</p>}
          </div>}
          {template.installed && <div className={`agent-template-lifecycle${selectedUpgradeAvailable ? ' has-update' : ''}`} aria-label={`Preset lifecycle for ${template.label}`}>
            {upgradeAgents.length > 1 && <label><span>Installed agent variant</span><select aria-label={`Installed agent for ${template.label}`} value={selectedUpgradeAgentId ?? ''} onChange={event => { const id = Number(event.target.value); setTemplateUpgradeAgents(current => ({ ...current, [template.name]: id })); setTemplateUpgrades(current => { const next = { ...current }; delete next[template.name]; return next; }); }}>
              {upgradeAgents.map(agent => <option value={agent.id} key={agent.id}>{agent.label} · {agent.model} · v{agent.installedVersion}</option>)}
            </select></label>}
            <div><span><RefreshCw size={13} />Preset lifecycle</span><em>v{selectedInstalledVersion ?? '?'} / v{template.version}</em></div>
            <p>{selectedUpgradeAvailable ? 'A newer governed preset baseline is available. Review local drift and conflicts before applying it.' : 'This Agent is on the current preset version.'}</p>
            {upgradePreview && upgradePreview.agentId === selectedUpgradeAgentId && <div className={`agent-template-upgrade-diff${upgradePreview.conflicts.length ? ' has-conflicts' : ''}`}>
              <div><b>{upgradePreview.proposedChanges.length} proposed</b><b>{upgradePreview.localChanges.length} local</b><b>{upgradePreview.conflicts.length} conflicts</b></div>
              {upgradePreview.proposedChanges.length > 0 ? <ul>{upgradePreview.proposedChanges.map(change => <li className={change.conflict ? 'is-conflict' : ''} key={change.field}><strong>{change.field}</strong><span>Current: {displayLifecycleValue(change.current)}</span><span>Target: {displayLifecycleValue(change.target)}</span></li>)}</ul> : <p>No value changes; applying the upgrade only adopts the current version baseline.</p>}
              {upgradePreview.conflicts.length > 0 && <small><TriangleAlert size={12} />Resolve conflicting local fields in Agent configuration before upgrading.</small>}
            </div>}
            <div className="agent-template-actions">
              <button className="button button-secondary" type="button" disabled={isLoadingUpgrade || isUpgrading} onClick={() => upgradePreviewMutation.mutate(upgradeTarget)}>{isLoadingUpgrade ? <><RefreshCw className="spin" size={13} />Comparing…</> : <><Eye size={13} />{upgradePreview?.agentId === selectedUpgradeAgentId ? 'Refresh diff' : 'Review lifecycle'}</>}</button>
              {selectedUpgradeAvailable && <button className="button button-primary" type="button" disabled={!upgradePreview || upgradePreview.agentId !== selectedUpgradeAgentId || !upgradePreview.safeToApply || isLoadingUpgrade || isUpgrading} title={upgradePreview && !upgradePreview.safeToApply ? 'Resolve detected conflicts before applying this preset version' : 'Review the upgrade diff first'} onClick={() => upgradeMutation.mutate(upgradeTarget)}>{isUpgrading ? <><RefreshCw className="spin" size={13} />Upgrading…</> : <><ShieldCheck size={13} />Apply v{template.version}</>}</button>}
            </div>
          </div>}
          {!template.installed && <footer>
            <label><span>Runtime model</span><select aria-label={`Model for ${template.label}`} value={selectedModel} disabled={template.installed || !hasModels || isInstalling || isPreviewing} onChange={event => { clearTemplatePreflight(template.name); setTemplateModels(current => ({ ...current, [template.name]: event.target.value })); }}>{hasModels ? query.data.models.map(model => <option value={model.model_name} key={model.model_name}>{model.model_name} · {model.provider}</option>) : <option value="">No model configured</option>}</select></label>
            <label><span>Execution runtime</span><select aria-label={`Runtime for ${template.label}`} value={selectedRuntimeProfile} disabled={template.installed || isInstalling || isPreviewing} onChange={event => { clearTemplatePreflight(template.name); setTemplateRuntimeProfiles(current => ({ ...current, [template.name]: event.target.value })); }}><option value="">Deployment default</option>{(query.data.runtimeProfiles ?? []).filter(profile => profile.enabled).map(profile => <option value={profile.id} key={profile.id}>{profile.label}{profile.model ? ` · ${profile.model}` : ''}{profile.runtime_type === 'hermes' ? ` · ${profile.execution_strategy ?? 'adapter'} / external attested` : ''}</option>)}</select></label>
            {template.minimumBundleCount > 0 && <label><span>MCP bundle</span><select aria-label={`Bundle for ${template.label}`} value={selectedBundleId} disabled={template.installed || isInstalling || isPreviewing || compatibleBundles.length === 0} onChange={event => { clearTemplatePreflight(template.name); setTemplateBundleIds(current => ({ ...current, [template.name]: event.target.value })); }}><option value="">{compatibleBundles.length ? 'Select compatible bundle' : 'No compatible bundle configured'}</option>{compatibleBundles.map(bundle => <option value={bundle.id} key={bundle.id}>{bundle.label} · {bundle.tool_count} tools</option>)}</select></label>}
            <div className="agent-template-actions">
              <button className="button button-secondary" type="button" disabled={template.installed || !selectedModel || !bundleSelectionReady || installMutation.isPending || previewMutation.isPending} onClick={() => previewMutation.mutate({ name: template.name, model: selectedModel, runtimeProfileId: selectedRuntimeProfile ? Number(selectedRuntimeProfile) : null, bundleIds: selectedBundleId ? [Number(selectedBundleId)] : [] })}>{isPreviewing ? <><RefreshCw className="spin" size={13} />Checking…</> : <><ShieldCheck size={13} />Run preflight</>}</button>
              <button className="button button-primary" type="button" disabled={template.installed || !installReady || installMutation.isPending || previewMutation.isPending} title={!template.installed && !installReady ? 'Run a successful preflight before installation' : undefined} onClick={() => installMutation.mutate({ name: template.name, model: selectedModel, runtimeProfileId: selectedRuntimeProfile ? Number(selectedRuntimeProfile) : null, bundleIds: selectedBundleId ? [Number(selectedBundleId)] : [] })}>{template.installed ? <><CheckCircle2 size={13} />Installed</> : isInstalling ? <><RefreshCw className="spin" size={13} />Installing…</> : <><Plus size={13} />Install preset</>}</button>
            </div>
          </footer>}
        </article>;
      })}</div>
    </section>}

    {showAgentManagement && hasAgents && <div className="build-toolbar">
      <div className="segmented-filter" aria-label="Filter agents by mode">{(['all', 'chat', 'worker', 'reviewer'] as const).map(value => <button className={mode === value ? 'is-active' : ''} type="button" key={value} onClick={() => setMode(value)}>{value === 'all' ? 'All agents' : value}</button>)}</div>
      <label className="search-field"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search agents, roles and models" /></label>
    </div>}

    {showAgentManagement && (agents.length ? <section className="agent-studio-grid" aria-label="Managed agents">{agents.map(agent => {
      const bundleCount = agent.bundle_ids?.length ?? 0;
      const runtimeProfile = query.data.runtimeProfiles?.find(profile => profile.id === agent.runtime_profile_id);
      const runtimeBoundary = runtimeProfile?.runtime_type === 'hermes'
        ? runtimeProfile.execution_strategy === 'managed' ? 'GOVERNED RUNTIME' : 'EXTERNAL ATTESTED'
        : runtimeProfile && runtimeProfile.runtime_type !== 'argus' ? 'EXTERNAL RUNTIME' : 'MODEL';
      const identityState = agent.entra_object_id ? 'synced' : agent.entra_sync_error ? 'error' : 'local';
      const readiness = agent.readiness;
      return <article className={`agent-studio-card${agent.enabled ? '' : ' is-disabled'}`} key={agent.id}>
        <header><span className="agent-avatar"><Bot size={20} /></span><div className="build-card-badges"><span className={`availability-badge${agent.enabled ? '' : ' is-disabled'}`}><i />{agent.enabled ? 'Enabled' : 'Disabled'}</span>{readiness && <span className={`agent-readiness-badge is-${readiness.status}`}>{readiness.status === 'ready' ? <CheckCircle2 size={11} /> : <TriangleAlert size={11} />}{readiness.status}</span>}{agent.supports_vision && <span className="capability-badge"><Eye size={11} />Vision</span>}</div></header>
        <div className="agent-studio-title"><small>{agent.name}</small><h2>{agent.label}</h2><p>{agent.description || 'No agent description provided yet.'}</p></div>
        <div className="agent-studio-runtime"><BrainCircuit size={14} /><span><small>{agent.agent_mode.toUpperCase()} · {runtimeBoundary}</small><code>{runtimeProfile?.runtime_type === 'hermes' ? runtimeProfile.model ?? 'hermes-upstream' : agent.model}</code></span></div>
        <div className="agent-studio-runtime"><Zap size={14} /><span><small>EXECUTION RUNTIME</small><code>{runtimeProfile ? [runtimeProfile.label, runtimeProfile.model, runtimeProfile.reasoning_effort].filter(Boolean).join(' · ') : 'Deployment default'}</code></span></div>
        <div className="agent-studio-facts"><span><Boxes size={12} /><b>{bundleCount}</b> bundles</span><span><Database size={12} /><b>{agent.rag_indexes.length}</b> RAG</span><span><Network size={12} /><b>{agent.code_indexes?.length ?? 0}</b> graphs</span><span><Sparkles size={12} /><b>{agent.skills.length}</b> skills</span></div>
        {readiness && <div className={`agent-readiness-line is-${readiness.status}`}><span>{readiness.ready ? `${readiness.tools.length} effective tools` : readiness.blockers[0] || 'Agent is not executable'}</span><small>{readiness.runtime.type} runtime · {readiness.warnings.length} warning{readiness.warnings.length === 1 ? '' : 's'}</small></div>}
        <div className={`agent-identity-line is-${identityState}`}><ShieldCheck size={13} /><span>{identityState === 'synced' ? `Entra identity · ${timeAgo(agent.entra_synced_at!)}` : identityState === 'error' ? 'Entra sync needs attention' : 'Local runtime identity'}</span>{identityState === 'error' && <button type="button" disabled={resyncMutation.isPending} onClick={() => resyncMutation.mutate(agent)}><RefreshCw size={11} />Retry</button>}</div>
        <footer><button type="button" onClick={() => setSessionAgent(agent)}><History size={13} />Sessions</button><button className="is-primary" type="button" onClick={() => { saveMutation.reset(); setSelected(agent); }}><Settings2 size={13} />Configure</button></footer>
      </article>;
    })}</section> : <section className="panel"><EmptyState title={hasAgents ? 'No matching agents' : 'No agents installed'} description={hasAgents ? 'Change the search or mode filter, or create a new governed agent.' : hasModels ? 'Install an optional starter above or create a governed agent from scratch.' : 'Configure a model first. Then install an optional starter or build your own agent.'} /></section>)}

    {hasModels && selected !== undefined && <AgentEditor key={selected?.id ?? 'new'} agent={selected} catalog={query.data} busy={saveMutation.isPending || deleteMutation.isPending} error={saveMutation.error?.message ?? deleteMutation.error?.message ?? null} onClose={() => { if (!saveMutation.isPending && !deleteMutation.isPending) setSelected(undefined); }} onSave={input => saveMutation.mutate({ input, id: selected?.id })} onDelete={agent => deleteMutation.mutate(agent)} />}
    {sessionAgent && <AgentSessionsPanel agent={sessionAgent} onClose={() => setSessionAgent(null)} />}
    {presetBuilder && <AgentPresetBuilder initial={presetBuilder.initial} draft={presetBuilder.draft} catalog={query.data} onClose={() => setPresetBuilder(null)} onChanged={async message => { setNotice(message); await queryClient.invalidateQueries({ queryKey: ['agent-studio'] }); }} />}
  </>;
}
