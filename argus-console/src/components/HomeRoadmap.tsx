import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Layers3,
  Link2,
  LoaderCircle,
  Plus,
  ServerCog,
  Sparkles,
  X,
} from 'lucide-react';
import {
  createOnboardingAgent,
  createOnboardingModel,
  createOnboardingProvider,
  getOnboardingCatalog,
  installOnboardingStarterAgent,
  testOnboardingProvider,
} from '../api';
import type {
  LlmModelMutation,
  LlmProviderMutation,
  LlmProviderType,
  OnboardingBundle,
  OnboardingModel,
  OnboardingProvider,
  OnboardingStarterAgent,
} from '../types';

const PROVIDER_DEFAULTS: Record<LlmProviderType, { baseUrl: string; authType: LlmProviderMutation['authType'] }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', authType: 'bearer' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', authType: 'api-key' },
  'openai-compatible': { baseUrl: '', authType: 'bearer' },
};

type WizardStep = 1 | 2 | 3 | 4;
type SourceChoice = 'existing' | 'new' | 'discover';
type AgentChoice = 'starter' | 'custom';

function ProviderForm({ busy, error, onSubmit }: { busy: boolean; error: string | null; onSubmit: (input: LlmProviderMutation) => void }) {
  const [providerType, setProviderType] = useState<LlmProviderType>('openai');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULTS.openai.baseUrl);
  const [apiKey, setApiKey] = useState('');
  useEffect(() => setBaseUrl(PROVIDER_DEFAULTS[providerType].baseUrl), [providerType]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ name, label, providerType, baseUrl, authType: PROVIDER_DEFAULTS[providerType].authType, secretName: null, apiKey: apiKey || null, credentialProfileId: null, enabled: true });
  };
  return <form className="home-roadmap-form" onSubmit={submit}>
    <div className="home-roadmap-form-grid">
      <label><span>Provider type</span><select value={providerType} onChange={event => setProviderType(event.target.value as LlmProviderType)}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="openai-compatible">OpenAI-compatible / local</option></select></label>
      <label><span>Technical name</span><input required value={name} onChange={event => setName(event.target.value)} placeholder="my-provider" /></label>
      <label><span>Display name</span><input required value={label} onChange={event => setLabel(event.target.value)} placeholder="My AI Provider" /></label>
      <label><span>Base URL</span><input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder={providerType === 'openai-compatible' ? 'https://your-provider.example/v1' : undefined} /></label>
      <label><span>API key <small>(optional)</small></span><input type="password" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="Stored encrypted" /></label>
    </div>
    <p className="home-roadmap-form-note"><CircleAlert size={13} />The key is sent only to Argus Core and is never shown in the roadmap.</p>
    {error && <div className="home-roadmap-error" role="alert">{error}</div>}
    <button className="button button-primary home-roadmap-form-submit" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={14} />Saving…</> : <><Plus size={14} />Save provider and continue</>}</button>
  </form>;
}

function ModelForm({ busy, error, provider, initialUpstreamModel = '', onSubmit }: { busy: boolean; error: string | null; provider: OnboardingProvider; initialUpstreamModel?: string; onSubmit: (input: LlmModelMutation) => void }) {
  const [modelName, setModelName] = useState(initialUpstreamModel);
  const [displayName, setDisplayName] = useState(initialUpstreamModel);
  const [upstreamModelName, setUpstreamModelName] = useState(initialUpstreamModel);
  useEffect(() => {
    setModelName(initialUpstreamModel);
    setDisplayName(initialUpstreamModel);
    setUpstreamModelName(initialUpstreamModel);
  }, [initialUpstreamModel]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({ modelName, displayName: displayName || modelName, providerId: provider.id, upstreamModelName: upstreamModelName || modelName, enabled: true, supportsVision: false, supportsTools: true, supportsReasoning: false, maxInputTokens: null, maxOutputTokens: null, inputCostPer1k: null, outputCostPer1k: null });
  };
  return <form className="home-roadmap-form" onSubmit={submit}>
    <div className="home-roadmap-form-heading"><BrainCircuit size={15} /><span>New model for <b>{provider.label}</b></span></div>
    <div className="home-roadmap-form-grid">
      <label><span>Model alias</span><input required value={modelName} onChange={event => setModelName(event.target.value)} placeholder="my-model" /></label>
      <label><span>Display name</span><input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="My Model" /></label>
      <label><span>Upstream model name</span><input value={upstreamModelName} onChange={event => setUpstreamModelName(event.target.value)} placeholder="gpt-4o-mini" /></label>
    </div>
    {error && <div className="home-roadmap-error" role="alert">{error}</div>}
    <button className="button button-primary home-roadmap-form-submit" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={14} />Saving…</> : <><Plus size={14} />Save model and continue</>}</button>
  </form>;
}

function CustomPresetForm({ busy, error, model, onSubmit }: { busy: boolean; error: string | null; model: OnboardingModel; onSubmit: (input: { name: string; label: string; description: string; model: string; system_prompt: string }) => void }) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit({ name, label, description, model: model.modelName, system_prompt: systemPrompt }); };
  return <form className="home-roadmap-form" onSubmit={submit}>
    <div className="home-roadmap-form-heading"><Bot size={15} /><span>Custom preset with <b>{model.displayName}</b></span></div>
    <p className="home-roadmap-form-help">Your preset is saved directly as a chat agent and can be opened immediately afterwards.</p>
    <div className="home-roadmap-form-grid">
      <label><span>Technical name</span><input required value={name} onChange={event => setName(event.target.value)} placeholder="my-agent" /></label>
      <label><span>Display name</span><input required value={label} onChange={event => setLabel(event.target.value)} placeholder="My Agent" /></label>
      <label className="is-wide"><span>Description</span><input value={description} onChange={event => setDescription(event.target.value)} placeholder="What should this agent help with?" /></label>
      <label className="is-wide"><span>System prompt <small>(optional)</small></span><textarea rows={4} value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} placeholder="You are a helpful Argus agent…" /></label>
    </div>
    {error && <div className="home-roadmap-error" role="alert">{error}</div>}
    <button className="button button-primary home-roadmap-form-submit" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={14} />Saving…</> : <><Plus size={14} />Save custom preset</>}</button>
  </form>;
}

function SourceTabs({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string; disabled?: boolean }>; onChange: (value: string) => void }) {
  return <div className="home-roadmap-source-tabs" role="tablist">{options.map(option => <button className={value === option.value ? 'is-selected' : ''} disabled={option.disabled} key={option.value} role="tab" type="button" aria-selected={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function DialogStep({ children, number, title, description }: { children: ReactNode; number: number; title: string; description: string }) {
  return <div className="home-roadmap-dialog-step"><div className="home-roadmap-dialog-step-heading"><span>{number}</span><div><small>STEP {number}</small><h3>{title}</h3><p>{description}</p></div></div>{children}</div>;
}

function StarterSelector({ agents, bundles, selected, selectedModelName = (selected as (OnboardingStarterAgent & { selectedModelName?: string }) | null)?.selectedModelName ?? '', selectedBundleIds, onSelect, onToggleBundle }: { agents: OnboardingStarterAgent[]; bundles: OnboardingBundle[]; selected: OnboardingStarterAgent | null; selectedModelName?: string; selectedBundleIds: number[]; onSelect: (name: string) => void; onToggleBundle: (id: number) => void }) {
  const compatibleBundles = selected ? bundles.filter(bundle => selected.compatibleBundleIds.includes(bundle.id)) : [];
  const installedAgent = selected?.installedAgents.find(agent => agent.model === selectedModelName) ?? null;
  const installedWithOtherModel = selected?.installedAgents.some(agent => agent.model !== selectedModelName) ?? false;
  return <div className="home-roadmap-starter-picker">
    {agents.length === 0 ? <div className="home-roadmap-empty"><span>No chat starters available.</span></div> : <div className="home-roadmap-starter-grid">{agents.map(agent => <button type="button" className={`home-roadmap-starter-card${selected?.name === agent.name ? ' is-selected' : ''}`} key={agent.id} onClick={() => onSelect(agent.name)}><span className="home-roadmap-starter-icon"><Layers3 size={16} /></span><span><b>{agent.label}</b><small>{agent.category} · v{agent.version}</small></span>{agent.installed ? <CheckCircle2 className="home-roadmap-starter-installed" size={15} /> : <ChevronRight size={15} />}</button>)}</div>}
    {selected && <div className="home-roadmap-starter-detail"><div><b>{selected.label}</b><p>{selected.description}</p>{selected.recommendedCapabilities.length > 0 && <div className="home-roadmap-tags">{selected.recommendedCapabilities.map(capability => <span key={capability}>{capability}</span>)}</div>}</div>{installedAgent && <small className="home-roadmap-result is-success"><CheckCircle2 size={13} />Already installed — use the existing agent</small>}</div>}
    {selected && installedWithOtherModel && !installedAgent && selectedModelName && <small className="home-roadmap-result"><Layers3 size={13} />Installed with another model - a new agent will be created for {selectedModelName}</small>}
    {selected && !installedAgent && selected.minimumBundleCount > 0 && <div className="home-roadmap-bundle-picker"><b>Select MCP bundle</b><small>This starter requires at least {selected.minimumBundleCount} bundle{selected.minimumBundleCount === 1 ? '' : 's'} with compatible tools.</small>{compatibleBundles.length > 0 ? <div className="home-roadmap-bundle-list">{compatibleBundles.map(bundle => <label key={bundle.id}><input type="checkbox" checked={selectedBundleIds.includes(bundle.id)} onChange={() => onToggleBundle(bundle.id)} /><span><b>{bundle.label}</b><small>{bundle.description}</small></span></label>)}</div> : <p className="home-roadmap-muted">No compatible bundle is available. Configure a bundle in Agent Studio first.</p>}</div>}
  </div>;
}

export function HomeRoadmap() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [wizardOpen, setWizardOpen] = useState(false);
  const quickCreate = new URLSearchParams(location.search).get('quickCreate');
  const quickCreateRequested = quickCreate === 'agent' || quickCreate === 'model' || quickCreate === 'provider';
  // The catalog resolves templates, bundles and compatibility. It is valuable
  // inside setup, but expensive and unnecessary for the normal Home first paint.
  const shouldLoadCatalog = wizardOpen || quickCreateRequested;
  const query = useQuery({
    queryKey: ['onboarding-catalog'],
    queryFn: getOnboardingCatalog,
    staleTime: 10_000,
    enabled: shouldLoadCatalog,
  });
  const [step, setStep] = useState<WizardStep>(1);
  const [selectedProviderId, setSelectedProviderId] = useState<number | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [providerChoice, setProviderChoice] = useState<SourceChoice>('existing');
  const [modelChoice, setModelChoice] = useState<SourceChoice>('existing');
  const [agentChoice, setAgentChoice] = useState<AgentChoice>('starter');
  const [selectedStarterName, setSelectedStarterName] = useState('');
  const [selectedBundleIds, setSelectedBundleIds] = useState<number[]>([]);
  const [providerTest, setProviderTest] = useState<Record<number, { ok: boolean; message: string; models: string[] }>>({});
  const [selectedDiscoveredModel, setSelectedDiscoveredModel] = useState('');
  const catalog = query.data;
  const providers = useMemo(() => (catalog?.providers ?? []).filter(provider => provider.enabled), [catalog?.providers]);
  const models = useMemo(() => (catalog?.models ?? []).filter(model => model.enabled && model.providerEnabled), [catalog?.models]);
  const agents = catalog?.agents ?? [];
  const starterAgents = useMemo(() => (catalog?.starterAgents ?? []).filter(template => template.agentMode === 'chat'), [catalog?.starterAgents]);
  const bundles = catalog?.bundles ?? [];
  const selectedProvider = providers.find(provider => provider.id === selectedProviderId) ?? providers[0] ?? null;
  const providerModels = selectedProvider ? models.filter(model => model.providerId === selectedProvider.id) : [];
  const discoveredUpstreamModels = selectedProvider ? providerTest[selectedProvider.id]?.models ?? [] : [];
  const selectedModel = providerModels.find(model => model.id === selectedModelId) ?? providerModels[0] ?? null;
  const selectedStarterTemplate = starterAgents.find(starter => starter.name === selectedStarterName) ?? starterAgents[0] ?? null;
  const selectedStarter = useMemo(() => selectedStarterTemplate && selectedModel
    ? { ...selectedStarterTemplate, selectedModelName: selectedModel.modelName }
    : selectedStarterTemplate, [selectedModel, selectedStarterTemplate]);
  const starterInstalledAgent = selectedStarter?.installedAgents.find(agent => agent.model === selectedModel?.modelName) ?? null;
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? starterInstalledAgent ?? null;
  const providerReady = Boolean(selectedProvider);
  const modelReady = Boolean(selectedModel);
  const agentReady = Boolean(selectedAgent);
  const completedSteps = [providerReady, modelReady, agentReady, agentReady].filter(Boolean).length;

  useEffect(() => {
    if (!catalog) return;
    if (selectedProviderId == null && providers[0]) setSelectedProviderId(providers[0].id);
    if (selectedModelId == null && providerModels[0]) setSelectedModelId(providerModels[0].id);
    if (providers.length === 0) setProviderChoice('new');
    if (providerModels.length === 0 && selectedProvider) setModelChoice('new');
    if (starterAgents.length === 0) setAgentChoice('custom');
    else if (agentChoice !== 'custom') setAgentChoice('starter');
    if (!selectedStarterName && starterAgents[0]) setSelectedStarterName(starterAgents[0].name);
  }, [agentChoice, catalog, providerModels, providers, selectedModelId, selectedProvider, selectedProviderId, selectedStarterName, starterAgents]);

  useEffect(() => {
    if (!selectedStarter) return;
    setSelectedBundleIds(current => current.filter(id => selectedStarter.compatibleBundleIds.includes(id)));
  }, [selectedStarter]);

  useEffect(() => {
    if (selectedAgentId != null && selectedModel && selectedAgent && selectedAgent.model !== selectedModel.modelName) {
      setSelectedAgentId(null);
    }
  }, [selectedAgent, selectedAgentId, selectedModel]);

  useEffect(() => {
    if (!catalog || !quickCreate || !['agent', 'model', 'provider'].includes(quickCreate)) return;

    let startStep: WizardStep = 1;
    setSelectedDiscoveredModel('');
    if (quickCreate === 'provider') {
      setProviderChoice('new');
      setSelectedModelId(null);
    } else if (quickCreate === 'model') {
      setSelectedModelId(null);
      setModelChoice('new');
      if (selectedProvider) startStep = 2;
      else setProviderChoice('new');
    } else {
      setSelectedAgentId(null);
      setAgentChoice('custom');
      if (selectedProvider && selectedModel) startStep = 3;
      else if (selectedProvider) { startStep = 2; setModelChoice('new'); }
      else setProviderChoice('new');
    }
    setStep(startStep);
    setWizardOpen(true);

    const params = new URLSearchParams(location.search);
    params.delete('quickCreate');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
  }, [catalog, location.pathname, location.search, navigate, selectedModel, selectedProvider]);

  useEffect(() => {
    if (!wizardOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setWizardOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [wizardOpen]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['onboarding-catalog'] });
  const providerCreate = useMutation({ mutationFn: createOnboardingProvider, onSuccess: async provider => { setSelectedProviderId(provider.id); setSelectedModelId(null); setSelectedDiscoveredModel(''); setProviderChoice('existing'); await refresh(); setStep(2); } });
  const modelCreate = useMutation({ mutationFn: createOnboardingModel, onSuccess: async model => { setSelectedModelId(model.id); setModelChoice('existing'); await refresh(); setStep(3); } });
  const agentCreate = useMutation({ mutationFn: createOnboardingAgent, onSuccess: async agent => { setSelectedAgentId(agent.id); await refresh(); setStep(4); } });
  const starterInstall = useMutation({ mutationFn: ({ name, model, bundleIds }: { name: string; model: string; bundleIds: number[] }) => installOnboardingStarterAgent(name, { model, bundleIds }), onSuccess: async agent => { setSelectedAgentId(agent.id); await refresh(); setStep(4); } });
  const providerTestMutation = useMutation({
    mutationFn: testOnboardingProvider,
    onSuccess: (result, providerId) => { setProviderTest(current => ({ ...current, [providerId]: { ok: result.ok, models: result.models ?? [], message: result.ok ? `Connected in ${result.latencyMs} ms` : result.error || 'Connection failed' } })); void refresh(); },
    onError: (error, providerId) => setProviderTest(current => ({ ...current, [providerId]: { ok: false, models: [], message: error instanceof Error ? error.message : 'Connection failed' } })),
  });
  const openWizard = () => { setStep(1); setWizardOpen(true); };
  const closeWizard = () => { if (!providerCreate.isPending && !modelCreate.isPending && !agentCreate.isPending && !starterInstall.isPending) setWizardOpen(false); };
  const nextStep = () => {
    if (step === 1 && providerReady) setStep(2);
    if (step === 2 && modelReady) setStep(3);
    if (step === 3) {
      if (agentChoice === 'starter' && selectedStarter && selectedModel) {
        if (starterInstalledAgent) { setSelectedAgentId(starterInstalledAgent.id); setStep(4); }
        else if (selectedBundleIds.length >= selectedStarter.minimumBundleCount) starterInstall.mutate({ name: selectedStarter.name, model: selectedModel.modelName, bundleIds: selectedBundleIds });
      }
    }
  };
  const nextDisabled = (step === 1 && !providerReady) || (step === 2 && (modelChoice === 'discover' || !modelReady)) || (step === 3 && (agentChoice === 'starter' && (!selectedStarter || !selectedModel || (!starterInstalledAgent && selectedBundleIds.length < selectedStarter.minimumBundleCount))));

  if (query.isLoading) return <section className="home-roadmap panel" aria-label="Agent setup roadmap"><div className="home-roadmap-loading"><LoaderCircle className="spin" size={18} />Loading setup roadmap…</div></section>;
  if (!shouldLoadCatalog) return <section className="home-roadmap panel" aria-labelledby="home-roadmap-title">
    <header className="home-roadmap-heading"><div><span className="eyebrow">GETTING STARTED</span><h2 id="home-roadmap-title">Build your agent</h2><p>Open setup when you are ready to choose a provider, model and agent.</p></div><div className="home-roadmap-heading-actions"><span className="home-roadmap-progress"><strong>Ready</strong><small>on demand</small></span><button className="button button-primary" type="button" onClick={openWizard}><Sparkles size={14} />Open setup</button></div></header>
    <div className="home-roadmap-preview" aria-label="Setup progress"><div><span>1</span><b>Provider</b><small>Connect when needed</small></div><ArrowRight size={14} /><div><span>2</span><b>Model</b><small>Choose a model</small></div><ArrowRight size={14} /><div><span>3</span><b>Agent</b><small>Configure a role</small></div><ArrowRight size={14} /><div><span>4</span><b>Chat</b><small>Start a conversation</small></div></div>
    <footer className="home-roadmap-footer"><Link2 size={13} />The full setup catalog loads only after you open this guided flow.</footer>
  </section>;

  if (query.error || !catalog) return <section className="home-roadmap panel" aria-label="Agent setup roadmap"><div className="home-roadmap-error home-roadmap-error-block" role="alert"><CircleAlert size={16} />{query.error instanceof Error ? query.error.message : 'The setup roadmap could not be loaded'}</div></section>;

  return <section className="home-roadmap panel" aria-labelledby="home-roadmap-title">
    <header className="home-roadmap-heading"><div><span className="eyebrow">GETTING STARTED</span><h2 id="home-roadmap-title">Build your agent</h2><p>A guided flow: every selection is saved before you move to the next step.</p></div><div className="home-roadmap-heading-actions"><span className="home-roadmap-progress"><strong>{completedSteps}/4</strong><small>ready</small></span><button className="button button-primary" type="button" onClick={openWizard}><Sparkles size={14} />Open setup</button></div></header>
    <div className="home-roadmap-preview" aria-label="Setup progress"><div className={providerReady ? 'is-complete' : ''}><span>1</span><b>Provider</b><small>{selectedProvider?.label ?? 'Not selected yet'}</small></div><ArrowRight size={14} /><div className={modelReady ? 'is-complete' : ''}><span>2</span><b>Model</b><small>{selectedModel?.displayName ?? 'Not selected yet'}</small></div><ArrowRight size={14} /><div className={agentReady ? 'is-complete' : ''}><span>3</span><b>Agent</b><small>{selectedAgent?.label ?? 'Not selected yet'}</small></div><ArrowRight size={14} /><div className={agentReady ? 'is-complete' : ''}><span>4</span><b>Chat</b><small>{agentReady ? 'Ready' : 'Open at the end'}</small></div></div>
    <footer className="home-roadmap-footer"><Link2 size={13} />Provider, model, and agent are saved step by step. Choose starter agents or create a custom preset in the agent step.</footer>

    {wizardOpen && <div className="home-roadmap-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeWizard(); }}><section className="home-roadmap-dialog" role="dialog" aria-modal="true" aria-labelledby="home-roadmap-dialog-title" onMouseDown={event => event.stopPropagation()}>
      <header className="home-roadmap-dialog-header"><div><span className="eyebrow">AGENT SETUP · STEP {step}/4</span><h2 id="home-roadmap-dialog-title">Build your agent</h2></div><button className="home-roadmap-close" type="button" aria-label="Close setup" onClick={closeWizard}><X size={18} /></button></header>
      <div className="home-roadmap-wizard-progress">{[1, 2, 3, 4].map(number => <button type="button" key={number} className={step === number ? 'is-current' : number < step ? 'is-complete' : ''} onClick={() => { if (number < step) setStep(number as WizardStep); }} disabled={number >= step}><span>{number < step ? <Check size={13} /> : number}</span>{number === 1 ? 'Provider' : number === 2 ? 'Model' : number === 3 ? 'Agent' : 'Chat'}</button>)}</div>
      <div className="home-roadmap-dialog-body">
        {step === 1 && <DialogStep number={1} title="Connect an AI provider" description="Choose an existing connection or save a new one. It will be available for the model immediately afterwards."><SourceTabs value={providerChoice} onChange={value => setProviderChoice(value as SourceChoice)} options={[{ value: 'existing', label: 'Use existing', disabled: providers.length === 0 }, { value: 'new', label: 'Create new' }]} />{providerChoice === 'existing' && <div className="home-roadmap-choice"><label><span>Provider</span><select value={selectedProvider?.id ?? ''} onChange={event => { setSelectedProviderId(Number(event.target.value)); setSelectedModelId(null); setSelectedDiscoveredModel(''); }}><option value="" disabled>Select a provider</option>{providers.map(provider => <option value={provider.id} key={provider.id}>{provider.label} · {provider.providerType}</option>)}</select></label></div>}{providerChoice === 'new' && <ProviderForm busy={providerCreate.isPending} error={providerCreate.error?.message ?? null} onSubmit={input => providerCreate.mutate(input)} />}</DialogStep>}
        {step === 2 && <DialogStep number={2} title="Choose a model" description={`Assign a model to “${selectedProvider?.label ?? 'your connection'}”. New models are registered immediately with this exact provider.`}><SourceTabs value={modelChoice} onChange={value => { const choice = value as SourceChoice; setModelChoice(choice); if (choice === 'existing') setSelectedDiscoveredModel(''); if (choice === 'discover' && selectedProvider && !providerTestMutation.isPending) providerTestMutation.mutate(selectedProvider.id); }} options={[{ value: 'existing', label: 'Use existing', disabled: providerModels.length === 0 }, { value: 'new', label: 'Register new' }, { value: 'discover', label: 'Discover models', disabled: !selectedProvider?.canTest }]} />{modelChoice === 'discover' && selectedProvider && <div className="home-roadmap-discovered"><div className="home-roadmap-discovered-heading"><div><b>Discover upstream models</b><small>Available models from {selectedProvider.label}. Select one to register it in Argus.</small></div><span className="home-roadmap-meta">{providerTestMutation.isPending ? 'Discovering…' : 'Automatic provider test'}</span></div>{discoveredUpstreamModels.length > 0 ? <div className="home-roadmap-discovered-list">{discoveredUpstreamModels.map(modelName => <button type="button" key={modelName} className={selectedDiscoveredModel === modelName ? 'is-selected' : ''} onClick={() => { setSelectedDiscoveredModel(modelName); setModelChoice('new'); }}><Plus size={12} />{modelName}</button>)}</div> : <p className="home-roadmap-muted">{providerTestMutation.isPending ? 'Loading available upstream models…' : 'No upstream models discovered yet. Switch to another tab and back to retry.'}</p>}{providerTest[selectedProvider.id] && <small className={`home-roadmap-result ${providerTest[selectedProvider.id].ok ? 'is-success' : 'is-error'}`}>{providerTest[selectedProvider.id].message}</small>}</div>}{modelChoice === 'existing' && <div className="home-roadmap-choice"><label><span>Model for {selectedProvider?.label}</span><select value={selectedModel?.id ?? ''} onChange={event => setSelectedModelId(Number(event.target.value))}><option value="" disabled>Select a model</option>{providerModels.map(model => <option value={model.id} key={model.id}>{model.displayName} · {model.modelName}</option>)}</select></label>{providerModels.length === 0 && <p className="home-roadmap-muted">This provider has no registered model yet. Switch to “Register new” above.</p>}</div>}{modelChoice === 'new' && selectedProvider && <ModelForm key={selectedDiscoveredModel || 'manual'} busy={modelCreate.isPending} error={modelCreate.error?.message ?? null} provider={selectedProvider} initialUpstreamModel={selectedDiscoveredModel} onSubmit={input => modelCreate.mutate(input)} />}</DialogStep>}
        {step === 3 && <DialogStep number={3} title="Choose an agent or preset" description="Start with a chat starter or create your own preset for the model selected in step 2."><SourceTabs value={agentChoice} onChange={value => setAgentChoice(value as AgentChoice)} options={[{ value: 'starter', label: 'Starter agent', disabled: starterAgents.length === 0 }, { value: 'custom', label: 'Custom preset' }]} />{agentChoice === 'starter' && <StarterSelector agents={starterAgents} bundles={bundles} selected={selectedStarter} selectedModelName={selectedModel?.modelName ?? ''} selectedBundleIds={selectedBundleIds} onSelect={name => { setSelectedStarterName(name); setSelectedBundleIds([]); }} onToggleBundle={id => setSelectedBundleIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])} />}{agentChoice === 'custom' && selectedModel && <CustomPresetForm busy={agentCreate.isPending} error={agentCreate.error?.message ?? null} model={selectedModel} onSubmit={input => agentCreate.mutate(input)} />}{starterInstall.error && <div className="home-roadmap-error" role="alert">{starterInstall.error instanceof Error ? starterInstall.error.message : 'The starter agent could not be installed'}</div>}</DialogStep>}
        {step === 4 && <DialogStep number={4} title="Ready for chat" description="Everything is saved. Open the agent and start your first conversation."><div className="home-roadmap-summary"><div><span><ServerCog size={14} />Provider</span><b>{selectedProvider?.label ?? '—'}</b></div><div><span><BrainCircuit size={14} />Model</span><b>{selectedModel?.displayName ?? selectedAgent?.model ?? '—'}</b></div><div><span><Bot size={14} />Agent</span><b>{selectedAgent?.label ?? '—'}</b></div></div>{selectedAgent ? <div className="home-roadmap-finish"><div><b>{selectedAgent.label}</b><span>{selectedAgent.model} · ready for a conversation</span></div><a className="button button-primary" href={`/chat/${selectedAgent.id}`} onClick={() => setWizardOpen(false)}>Open agent chat <ArrowRight size={14} /></a></div> : <div className="home-roadmap-empty"><span>No agent selected.</span></div>}</DialogStep>}
      </div>
      <footer className="home-roadmap-dialog-footer"><button className="button button-secondary" type="button" onClick={() => step === 1 ? closeWizard() : setStep((step - 1) as WizardStep)}>{step === 1 ? 'Close' : <><ChevronLeft size={14} />Back</>}</button>{step < 4 && !(step === 1 && providerChoice === 'new') && !(step === 2 && modelChoice === 'new') && !(step === 3 && agentChoice === 'custom') && <button className="button button-primary" type="button" disabled={nextDisabled || starterInstall.isPending} onClick={nextStep}>{starterInstall.isPending ? <><LoaderCircle className="spin" size={14} />Installing…</> : step === 3 && agentChoice === 'starter' ? <><Plus size={14} />{starterInstalledAgent ? 'Use starter' : 'Install starter'}</> : <>Continue <ChevronRight size={14} /></>}</button>}{step === 4 && <button className="button button-primary" type="button" onClick={closeWizard}>Finish</button>}</footer>
    </section></div>}
  </section>;
}
