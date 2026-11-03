import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  BrainCircuit,
  Building2,
  Check,
  CheckCircle2,
  CircleOff,
  Cpu,
  KeyRound,
  Landmark,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import {
  deleteAgentRuntimeProfile,
  deleteLlmCredentialProfile,
  deleteLlmModel,
  deleteLlmProvider,
  getAgentRuntimeProfiles,
  getLlmCatalog,
  saveLlmCredentialProfile,
  saveLlmModel,
  saveLlmProvider,
  saveAgentRuntimeProfile,
  testLlmProvider,
  updateAgentRuntimeCodeContextPolicy,
} from '../api';
import { EmptyState, ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { RuntimeConnectDialog } from '../components/RuntimeConnectDialog';
import type {
  LlmCredentialProfileMutation,
  LlmCredentialProfileRecord,
  LlmModelMutation,
  LlmModelRecord,
  LlmProviderMutation,
  LlmProviderRecord,
  LlmProviderTestResult,
  LlmProviderType,
  AgentRuntimeProfile,
  AgentRuntimeCodeContextPolicyMutation,
  AgentRuntimeProfileMutation,
} from '../types';

const PROVIDER_DEFAULTS: Record<LlmProviderType, { baseUrl: string; authType: LlmProviderMutation['authType'] }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', authType: 'bearer' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', authType: 'api-key' },
  'openai-compatible': { baseUrl: 'http://host.docker.internal:11434/v1', authType: 'bearer' },
};

function RuntimeCodeContextEditor({ profile, saving, onSave }: {
  profile: AgentRuntimeProfile;
  saving: boolean;
  onSave: (input: AgentRuntimeCodeContextPolicyMutation) => void;
}) {
  const externalRuntime = profile.runtime_type === 'codex' || profile.runtime_type === 'claude-code' || profile.runtime_type === 'hermes';
  const [mode, setMode] = useState<AgentRuntimeCodeContextPolicyMutation['mode']>(profile.code_context_mode);
  const [maxResults, setMaxResults] = useState(profile.code_context_max_results);
  const [maxBytes, setMaxBytes] = useState(profile.code_context_max_bytes);
  const changed = mode !== profile.code_context_mode
    || maxResults !== profile.code_context_max_results
    || maxBytes !== profile.code_context_max_bytes;
  return <div className="llm-runtime-code-policy">
    <header><span><ShieldCheck size={13} /><b>Repository context</b></span><em>{mode === 'bounded_source' ? 'explicit sharing' : 'metadata only'}</em></header>
    <label><span>Source policy</span><select aria-label={`Code context policy for ${profile.label}`} value={mode} disabled={!externalRuntime || saving} onChange={event => setMode(event.target.value as AgentRuntimeCodeContextPolicyMutation['mode'])}><option value="metadata_only">Metadata only</option><option value="bounded_source">Bounded source excerpts</option></select></label>
    {externalRuntime && mode === 'bounded_source' && <div>
      <label><span>Max references</span><input aria-label={`Max code references for ${profile.label}`} type="number" min={1} max={8} value={maxResults} disabled={saving} onChange={event => setMaxResults(Number(event.target.value))} /></label>
      <label><span>Max context bytes</span><input aria-label={`Max code context bytes for ${profile.label}`} type="number" min={1024} max={24000} step={1024} value={maxBytes} disabled={saving} onChange={event => setMaxBytes(Number(event.target.value))} /></label>
    </div>}
    <p>{externalRuntime ? 'Changing this policy is audited. Retrieved code is commit-bound, size-limited and treated as untrusted input.' : 'The in-process Argus runtime does not use the external source-sharing boundary.'}</p>
    {externalRuntime && <button type="button" disabled={!changed || saving || maxResults < 1 || maxResults > 8 || maxBytes < 1024 || maxBytes > 24000} onClick={() => onSave({ mode, maxResults, maxBytes })}>{saving ? 'Saving…' : 'Save code policy'}</button>}
  </div>;
}

function ProviderEditor({ provider, profiles, saving, error, onClose, onSave }: {
  provider: LlmProviderRecord | null;
  profiles: LlmCredentialProfileRecord[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: LlmProviderMutation) => void;
}) {
  const [name, setName] = useState(provider?.name ?? '');
  const [label, setLabel] = useState(provider?.label ?? '');
  const [providerType, setProviderType] = useState<LlmProviderType>(provider?.providerType ?? 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? PROVIDER_DEFAULTS['openai-compatible'].baseUrl);
  const [authType, setAuthType] = useState<LlmProviderMutation['authType']>(provider?.authType ?? 'bearer');
  const [secretName, setSecretName] = useState(provider?.secretName ?? '');
  const [apiKey, setApiKey] = useState('');
  const [credentialProfileId, setCredentialProfileId] = useState(provider?.credentialProfileId?.toString() ?? '');
  const [clearInline, setClearInline] = useState(false);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);

  const changeType = (next: LlmProviderType) => {
    setProviderType(next);
    if (credentialProfileId && !profiles.some(profile => profile.id === Number(credentialProfileId) && profile.providerType === next)) {
      setCredentialProfileId('');
    }
    if (!provider) {
      setBaseUrl(PROVIDER_DEFAULTS[next].baseUrl);
      setAuthType(PROVIDER_DEFAULTS[next].authType);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      name: name.trim(),
      label: label.trim(),
      providerType,
      baseUrl: baseUrl.trim(),
      authType,
      secretName: authType === 'none' ? null : secretName.trim() || null,
      ...(authType === 'none' || clearInline ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      credentialProfileId: authType === 'none' || !credentialProfileId ? null : Number(credentialProfileId),
      enabled,
    });
  };

  return <div className="llm-editor-layer" role="presentation">
    <form className="llm-editor" aria-labelledby="provider-editor-title" onSubmit={submit}>
      <header><span className="llm-editor-icon"><ServerCog size={20} /></span><div><span className="eyebrow">AI CONNECTION</span><h2 id="provider-editor-title">{provider ? `Edit ${provider.label}` : 'Add provider'}</h2><p>Connect Argus directly or through any OpenAI-compatible runtime.</p></div><button type="button" aria-label="Close provider editor" onClick={onClose}><X size={18} /></button></header>
      <div className="llm-editor-body">
        <section><div className="llm-section-title"><Link2 size={15} /><span><small>ENDPOINT</small><b>Provider identity</b></span></div><div className="policy-field-grid">
          <label className="editor-field"><span>Display name <em>required</em></span><input required maxLength={160} value={label} onChange={event => setLabel(event.target.value)} placeholder="Local model runtime" /></label>
          <label className="editor-field"><span>Technical name <em>required</em></span><input required maxLength={96} pattern="[a-z0-9][a-z0-9_-]*" value={name} onChange={event => setName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))} placeholder="local-model-runtime" /></label>
          <label className="editor-field"><span>Protocol</span><select value={providerType} onChange={event => changeType(event.target.value as LlmProviderType)}><option value="openai">OpenAI native</option><option value="anthropic">Anthropic native</option><option value="openai-compatible">OpenAI compatible</option></select></label>
          <label className="editor-field"><span>Base URL <em>required</em></span><input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></label>
        </div></section>
        <section><div className="llm-section-title"><KeyRound size={15} /><span><small>CREDENTIAL</small><b>Server-side authentication</b></span></div><div className="policy-field-grid">
          <label className="editor-field"><span>Authentication</span><select value={authType} onChange={event => setAuthType(event.target.value as LlmProviderMutation['authType'])}><option value="bearer">Bearer token</option><option value="api-key">API key header</option><option value="none">No authentication</option></select></label>
          {authType !== 'none' && <label className="editor-field"><span>Credential profile</span><select value={credentialProfileId} onChange={event => setCredentialProfileId(event.target.value)}><option value="">Provider-local fallback</option>{profiles.filter(profile => profile.providerType === providerType).map(profile => { const available = profile.enabled && !profile.expired && profile.credentialConfigured; return <option value={profile.id} disabled={!available} key={profile.id}>{profile.label}{available ? '' : ' (unavailable)'}</option>; })}</select><small>Reusable across providers and agents; takes priority over the fields below.</small></label>}
          {authType !== 'none' && <label className="editor-field"><span>Environment / Vault secret</span><input value={secretName} onChange={event => setSecretName(event.target.value)} placeholder="OPENAI_API_KEY" /><small>Preferred: Argus resolves this reference at runtime.</small></label>}
          {authType !== 'none' && <label className="editor-field"><span>Inline API key {provider?.inlineCredentialConfigured && <i>configured</i>}</span><input type="password" autoComplete="new-password" value={apiKey} disabled={clearInline} onChange={event => setApiKey(event.target.value)} placeholder={provider?.inlineCredentialConfigured ? 'Leave blank to keep existing' : 'Optional encrypted fallback'} /></label>}
        </div>
          {provider?.inlineCredentialConfigured && authType !== 'none' && <label className="llm-clear-key"><input type="checkbox" checked={clearInline} onChange={event => setClearInline(event.target.checked)} /><span className="connection-check">{clearInline && <Check size={12} />}</span><span>Remove the stored inline credential</span></label>}
          <label className="config-master-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span className="connection-check">{enabled && <CheckCircle2 size={12} />}</span><span><b>{enabled ? 'Provider enabled' : 'Provider disabled'}</b><small>Disabled providers stop all assigned model calls immediately.</small></span></label>
        </section>
        <div className="config-info-note"><ShieldCheck size={15} /><span>Credentials remain server-side and are never included in catalog responses or agent configuration.</span></div>
      </div>
      {error && <div className="editor-error" role="alert"><AlertTriangle size={15} />{error}</div>}
      <footer><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !name || !label || !baseUrl}>{saving ? 'Saving…' : provider ? 'Save provider' : 'Add provider'}</button></footer>
    </form>
  </div>;
}

function CredentialEditor({ profile, saving, error, onClose, onSave }: {
  profile: LlmCredentialProfileRecord | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: LlmCredentialProfileMutation) => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [label, setLabel] = useState(profile?.label ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [providerType, setProviderType] = useState<LlmProviderType>(profile?.providerType ?? 'openai');
  const [department, setDepartment] = useState(profile?.department ?? '');
  const [costCenter, setCostCenter] = useState(profile?.costCenter ?? '');
  const [secretName, setSecretName] = useState(profile?.secretName ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearInline, setClearInline] = useState(false);
  const [monthlyBudget, setMonthlyBudget] = useState(profile?.monthlyBudgetUsd?.toString() ?? '');
  const [budgetMode, setBudgetMode] = useState<LlmCredentialProfileMutation['budgetMode']>(profile?.budgetMode ?? 'alert');
  const [expiresAt, setExpiresAt] = useState(profile?.expiresAt?.slice(0, 16) ?? '');
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      name: name.trim(),
      label: label.trim(),
      description: description.trim(),
      providerType,
      secretName: secretName.trim() || null,
      ...(clearInline ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      department: department.trim() || null,
      costCenter: costCenter.trim() || null,
      monthlyBudgetUsd: numberOrNull(monthlyBudget),
      budgetMode,
      enabled,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    });
  };

  return <div className="llm-editor-layer" role="presentation"><form className="llm-editor" aria-labelledby="credential-editor-title" onSubmit={submit}>
    <header><span className="llm-editor-icon"><KeyRound size={20} /></span><div><span className="eyebrow">CREDENTIAL CONTROL</span><h2 id="credential-editor-title">{profile ? `Edit ${profile.label}` : 'Add credential profile'}</h2><p>One server-side secret, reusable assignments and an explicit cost boundary.</p></div><button type="button" aria-label="Close credential editor" onClick={onClose}><X size={18} /></button></header>
    <div className="llm-editor-body">
      <section><div className="llm-section-title"><Building2 size={15} /><span><small>OWNERSHIP</small><b>Identity and cost attribution</b></span></div><div className="policy-field-grid">
        <label className="editor-field"><span>Display name <em>required</em></span><input required maxLength={160} value={label} onChange={event => setLabel(event.target.value)} placeholder="Platform Engineering" /></label>
        <label className="editor-field"><span>Technical name <em>required</em></span><input required maxLength={96} pattern="[a-z0-9][a-z0-9_-]*" value={name} onChange={event => setName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))} placeholder="platform-openai" /></label>
        <label className="editor-field"><span>Provider protocol</span><select value={providerType} onChange={event => setProviderType(event.target.value as LlmProviderType)}><option value="openai">OpenAI native</option><option value="anthropic">Anthropic native</option><option value="openai-compatible">OpenAI compatible</option></select></label>
        <label className="editor-field"><span>Department</span><input maxLength={160} value={department} onChange={event => setDepartment(event.target.value)} placeholder="Platform Engineering" /></label>
        <label className="editor-field"><span>Cost center</span><input maxLength={96} value={costCenter} onChange={event => setCostCenter(event.target.value)} placeholder="CC-PLATFORM-01" /></label>
      </div><label className="editor-field"><span>Description</span><textarea rows={3} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Shared runtime credential for platform agents." /></label></section>
      <section><div className="llm-section-title"><KeyRound size={15} /><span><small>SECRET</small><b>Vault reference or encrypted key</b></span></div><div className="policy-field-grid">
        <label className="editor-field"><span>Environment / Vault secret</span><input value={secretName} onChange={event => setSecretName(event.target.value)} placeholder="OPENAI_PLATFORM_API_KEY" /><small>Preferred for centralized rotation.</small></label>
        <label className="editor-field"><span>Inline API key {profile?.inlineCredentialConfigured && <i>configured</i>}</span><input type="password" autoComplete="new-password" value={apiKey} disabled={clearInline} onChange={event => setApiKey(event.target.value)} placeholder={profile?.inlineCredentialConfigured ? 'Leave blank to keep existing' : 'Optional encrypted secret'} /></label>
      </div>{profile?.inlineCredentialConfigured && <label className="llm-clear-key"><input type="checkbox" checked={clearInline} onChange={event => setClearInline(event.target.checked)} /><span className="connection-check">{clearInline && <Check size={12} />}</span><span>Remove the stored inline credential</span></label>}</section>
      <section><div className="llm-section-title"><Landmark size={15} /><span><small>COST POLICY</small><b>Monthly estimated spend boundary</b></span></div><div className="policy-field-grid">
        <label className="editor-field"><span>Monthly budget in USD</span><input type="number" min="0.01" step="0.01" value={monthlyBudget} onChange={event => setMonthlyBudget(event.target.value)} placeholder="250.00" /></label>
        <label className="editor-field"><span>When threshold is reached</span><select value={budgetMode} onChange={event => setBudgetMode(event.target.value as LlmCredentialProfileMutation['budgetMode'])}><option value="observe">Observe only</option><option value="alert">Alert, keep running</option><option value="block">Block new model calls</option></select></label>
        <label className="editor-field"><span>Expires at</span><input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label>
      </div><label className="config-master-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span className="connection-check">{enabled && <CheckCircle2 size={12} />}</span><span><b>{enabled ? 'Credential profile enabled' : 'Credential profile disabled'}</b><small>Disabling immediately stops every assigned Agent and Provider from using it.</small></span></label></section>
      <div className="config-info-note"><ShieldCheck size={15} /><span>The secret is never returned. Agent and provider assignments reference only this profile ID.</span></div>
    </div>
    {error && <div className="editor-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    <footer><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !name || !label}>{saving ? 'Saving…' : profile ? 'Save credential profile' : 'Add credential profile'}</button></footer>
  </form></div>;
}

function numberOrNull(value: string): number | null {
  return value.trim() ? Number(value) : null;
}

function ModelEditor({ model, providers, seed, saving, error, onClose, onSave }: {
  model: LlmModelRecord | null;
  providers: LlmProviderRecord[];
  seed: { providerId: number; upstream: string } | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: LlmModelMutation) => void;
}) {
  const initialUpstream = model?.upstreamModelName ?? seed?.upstream ?? '';
  const [providerId, setProviderId] = useState(model?.providerId ?? seed?.providerId ?? providers[0]?.id ?? 0);
  const [modelName, setModelName] = useState(model?.modelName ?? initialUpstream);
  const [displayName, setDisplayName] = useState(model?.displayName ?? initialUpstream);
  const [upstreamModelName, setUpstreamModelName] = useState(initialUpstream);
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [supportsVision, setSupportsVision] = useState(model?.supportsVision ?? false);
  const [supportsTools, setSupportsTools] = useState(model?.supportsTools ?? true);
  const [supportsReasoning, setSupportsReasoning] = useState(model?.supportsReasoning ?? false);
  const [maxInputTokens, setMaxInputTokens] = useState(model?.maxInputTokens?.toString() ?? '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(model?.maxOutputTokens?.toString() ?? '');
  const [inputCost, setInputCost] = useState(model?.inputCostPer1k?.toString() ?? '');
  const [outputCost, setOutputCost] = useState(model?.outputCostPer1k?.toString() ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ modelName: modelName.trim(), displayName: displayName.trim(), providerId, upstreamModelName: upstreamModelName.trim(), enabled, supportsVision, supportsTools, supportsReasoning, maxInputTokens: numberOrNull(maxInputTokens), maxOutputTokens: numberOrNull(maxOutputTokens), inputCostPer1k: numberOrNull(inputCost), outputCostPer1k: numberOrNull(outputCost) });
  };
  return <div className="llm-editor-layer" role="presentation"><form className="llm-editor" aria-labelledby="model-editor-title" onSubmit={submit}>
    <header><span className="llm-editor-icon"><BrainCircuit size={20} /></span><div><span className="eyebrow">MODEL CATALOG</span><h2 id="model-editor-title">{model ? `Edit ${model.modelName}` : 'Register model'}</h2><p>A stable Argus alias maps agents to an upstream provider model.</p></div><button type="button" aria-label="Close model editor" onClick={onClose}><X size={18} /></button></header>
    <div className="llm-editor-body">
      <section><div className="llm-section-title"><Cpu size={15} /><span><small>ROUTING</small><b>Alias and upstream mapping</b></span></div><div className="policy-field-grid">
        <label className="editor-field"><span>Argus model alias <em>required</em></span><input required maxLength={128} value={modelName} onChange={event => setModelName(event.target.value)} placeholder="gpt-5.1" /><small>Agents reference this stable name.</small></label>
        <label className="editor-field"><span>Display name <em>required</em></span><input required maxLength={160} value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="GPT 5.1" /></label>
        <label className="editor-field"><span>Provider</span><select required value={providerId} onChange={event => setProviderId(Number(event.target.value))}>{providers.map(item => <option value={item.id} key={item.id}>{item.label}{item.enabled ? '' : ' (disabled)'}</option>)}</select></label>
        <label className="editor-field"><span>Upstream model name <em>required</em></span><input required maxLength={160} value={upstreamModelName} onChange={event => setUpstreamModelName(event.target.value)} placeholder="openai/gpt-5.1" /></label>
      </div></section>
      <section><div className="llm-section-title"><Sparkles size={15} /><span><small>CAPABILITIES</small><b>Runtime hints</b></span></div><div className="llm-capability-grid">{[
        ['Enabled', enabled, setEnabled], ['Tool calling', supportsTools, setSupportsTools], ['Vision', supportsVision, setSupportsVision], ['Reasoning', supportsReasoning, setSupportsReasoning],
      ].map(([label, checked, setter]) => <label className={checked ? 'is-selected' : ''} key={String(label)}><input type="checkbox" checked={checked as boolean} onChange={event => (setter as (value: boolean) => void)(event.target.checked)} /><span className="connection-check">{checked && <Check size={12} />}</span><b>{label as string}</b></label>)}</div></section>
      <section><div className="llm-section-title"><Zap size={15} /><span><small>LIMITS & COST</small><b>Optional metadata</b></span></div><div className="policy-field-grid">
        <label className="editor-field"><span>Max input tokens</span><input type="number" min={1} value={maxInputTokens} onChange={event => setMaxInputTokens(event.target.value)} placeholder="128000" /></label><label className="editor-field"><span>Max output tokens</span><input type="number" min={1} value={maxOutputTokens} onChange={event => setMaxOutputTokens(event.target.value)} placeholder="16384" /></label><label className="editor-field"><span>Input USD / 1K tokens</span><input type="number" min={0} step="0.00000001" value={inputCost} onChange={event => setInputCost(event.target.value)} /></label><label className="editor-field"><span>Output USD / 1K tokens</span><input type="number" min={0} step="0.00000001" value={outputCost} onChange={event => setOutputCost(event.target.value)} /></label>
      </div></section>
    </div>
    {error && <div className="editor-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    <footer><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !providerId || !modelName.trim() || !displayName.trim() || !upstreamModelName.trim()}>{saving ? 'Saving…' : model ? 'Save model' : 'Register model'}</button></footer>
  </form></div>;
}

function RuntimeProfileEditor({ profile, saving, error, onClose, onSave }: {
  profile: AgentRuntimeProfile | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: AgentRuntimeProfileMutation) => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [label, setLabel] = useState(profile?.label ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [runtimeType, setRuntimeType] = useState<AgentRuntimeProfileMutation['runtimeType']>(
    profile?.runtime_type === 'hermes' ? 'argus' : profile?.runtime_type ?? 'argus',
  );
  const [model, setModel] = useState(profile?.model ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<NonNullable<AgentRuntimeProfileMutation['reasoningEffort']>>(
    (profile?.reasoning_effort as NonNullable<AgentRuntimeProfileMutation['reasoningEffort']>) ?? 'high',
  );
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(profile?.max_concurrent_runs ?? 1);
  const [allowedTaskTypes, setAllowedTaskTypes] = useState((profile?.allowed_task_types ?? []).join(', '));
  const [codeContextMode, setCodeContextMode] = useState<AgentRuntimeProfileMutation['codeContextMode']>(profile?.code_context_mode ?? 'metadata_only');
  const [codeContextMaxResults, setCodeContextMaxResults] = useState(profile?.code_context_max_results ?? 4);
  const [codeContextMaxBytes, setCodeContextMaxBytes] = useState(profile?.code_context_max_bytes ?? 12_000);
  const external = runtimeType !== 'argus';

  const changeRuntimeType = (next: AgentRuntimeProfileMutation['runtimeType']) => {
    setRuntimeType(next);
    if (next === 'argus') setCodeContextMode('metadata_only');
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      name: name.trim(), label: label.trim(), description: description.trim(), runtimeType,
      model: model.trim() || null,
      reasoningEffort: runtimeType === 'codex' ? reasoningEffort : null,
      enabled, maxConcurrentRuns,
      allowedTaskTypes: allowedTaskTypes.split(',').map(value => value.trim()).filter(Boolean),
      codeContextMode: external ? codeContextMode : 'metadata_only',
      codeContextMaxResults, codeContextMaxBytes,
    });
  };

  return <div className="llm-editor-layer" role="presentation"><form className="llm-editor" aria-labelledby="runtime-editor-title" onSubmit={submit}>
    <header><span className="llm-editor-icon"><ServerCog size={20} /></span><div><span className="eyebrow">EXECUTION RUNTIME</span><h2 id="runtime-editor-title">{profile ? `Edit ${profile.label}` : 'Add runtime profile'}</h2><p>Define a reusable execution engine. Authentication remains in its protected runtime volume.</p></div><button type="button" aria-label="Close runtime profile editor" onClick={onClose}><X size={18} /></button></header>
    <div className="llm-editor-body">
      <section><div className="llm-section-title"><ServerCog size={15} /><span><small>IDENTITY</small><b>Runtime profile</b></span></div><div className="policy-field-grid">
        <label className="editor-field"><span>Display name <em>required</em></span><input required maxLength={160} value={label} onChange={event => setLabel(event.target.value)} placeholder="My Codex runtime" /></label>
        <label className="editor-field"><span>Technical name <em>required</em></span><input required maxLength={96} pattern="[a-z0-9][a-z0-9_-]*" value={name} onChange={event => setName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))} placeholder="my-codex-runtime" /></label>
        <label className="editor-field"><span>Execution engine</span><select value={runtimeType} onChange={event => changeRuntimeType(event.target.value as AgentRuntimeProfileMutation['runtimeType'])}><option value="argus">Argus API model</option><option value="codex">Codex subscription</option><option value="claude-code">Claude Code subscription</option></select></label>
        <label className="editor-field"><span>Model</span><input maxLength={160} value={model} onChange={event => setModel(event.target.value)} placeholder={runtimeType === 'argus' ? 'Inherit Agent model' : runtimeType === 'codex' ? 'gpt-5.6-terra' : 'claude-sonnet-4-5'} /><small>{runtimeType === 'argus' ? 'Leave blank to use the model selected on the Agent.' : 'Leave blank to use the subscription runtime default.'}</small></label>
        {runtimeType === 'codex' && <label className="editor-field"><span>Reasoning effort</span><select value={reasoningEffort} onChange={event => setReasoningEffort(event.target.value as NonNullable<AgentRuntimeProfileMutation['reasoningEffort']>)}><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option></select></label>}
        <label className="editor-field"><span>Concurrent runs</span><input type="number" min={1} max={32} value={maxConcurrentRuns} onChange={event => setMaxConcurrentRuns(Number(event.target.value))} /></label>
      </div><label className="editor-field"><span>Description</span><textarea rows={3} maxLength={4000} value={description} onChange={event => setDescription(event.target.value)} /></label></section>
      <section><div className="llm-section-title"><ShieldCheck size={15} /><span><small>POLICY</small><b>Task and repository scope</b></span></div><div className="policy-field-grid">
        <label className="editor-field"><span>Allowed task types</span><input value={allowedTaskTypes} onChange={event => setAllowedTaskTypes(event.target.value)} placeholder="implement_ticket, review, run_tests" /><small>Comma-separated. Empty means no task-type restriction.</small></label>
        {external && <label className="editor-field"><span>Repository context</span><select value={codeContextMode} onChange={event => setCodeContextMode(event.target.value as AgentRuntimeProfileMutation['codeContextMode'])}><option value="metadata_only">Metadata only</option><option value="bounded_source">Bounded source excerpts</option></select></label>}
        {external && codeContextMode === 'bounded_source' && <><label className="editor-field"><span>Max references</span><input type="number" min={1} max={8} value={codeContextMaxResults} onChange={event => setCodeContextMaxResults(Number(event.target.value))} /></label><label className="editor-field"><span>Max context bytes</span><input type="number" min={1024} max={24000} step={1024} value={codeContextMaxBytes} onChange={event => setCodeContextMaxBytes(Number(event.target.value))} /></label></>}
      </div><label className="config-master-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span className="connection-check">{enabled && <CheckCircle2 size={12} />}</span><span><b>{enabled ? 'Runtime enabled' : 'Runtime disabled'}</b><small>Disabled profiles cannot be assigned or executed.</small></span></label></section>
      <div className="config-info-note"><ShieldCheck size={15} /><span>{runtimeType === 'argus' ? 'API credentials come from the selected catalog provider.' : `Authentication is resolved by ${runtimeType === 'codex' ? 'codex-auth' : 'claude-auth'} and is never stored in this profile.`}</span></div>
    </div>
    {error && <div className="editor-error" role="alert"><AlertTriangle size={15} />{error}</div>}
    <footer><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !name.trim() || !label.trim() || maxConcurrentRuns < 1 || maxConcurrentRuns > 32}>{saving ? 'Saving…' : profile ? 'Save runtime profile' : 'Add runtime profile'}</button></footer>
  </form></div>;
}

export function ModelsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({ queryKey: ['llm-catalog'], queryFn: getLlmCatalog, staleTime: 10_000 });
  const runtimeQuery = useQuery({ queryKey: ['agent-runtime-profiles'], queryFn: getAgentRuntimeProfiles, staleTime: 10_000 });
  const [providerEditor, setProviderEditor] = useState<'new' | number | null>(null);
  const [credentialEditor, setCredentialEditor] = useState<'new' | number | null>(null);
  const [modelEditor, setModelEditor] = useState<'new' | number | null>(null);
  const [runtimeEditor, setRuntimeEditor] = useState<'new' | number | null>(null);
  const [modelSeed, setModelSeed] = useState<{ providerId: number; upstream: string } | null>(null);
  const [runtimeConnectProfile, setRuntimeConnectProfile] = useState<AgentRuntimeProfile | null>(null);
  const [tests, setTests] = useState<Record<number, LlmProviderTestResult>>({});
  const [notice, setNotice] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['llm-catalog'] });
  const providerSave = useMutation({ mutationFn: ({ input, id }: { input: LlmProviderMutation; id?: number }) => saveLlmProvider(input, id), onSuccess: async result => { setProviderEditor(null); setNotice(`Provider “${result.label}” saved.`); await refresh(); } });
  const providerDelete = useMutation({ mutationFn: deleteLlmProvider, onSuccess: async () => { setNotice('Provider deleted.'); await refresh(); } });
  const providerTest = useMutation({ mutationFn: testLlmProvider, onSuccess: async (result, id) => { setTests(current => ({ ...current, [id]: result })); await refresh(); } });
  const modelSave = useMutation({ mutationFn: ({ input, id }: { input: LlmModelMutation; id?: number }) => saveLlmModel(input, id), onSuccess: async result => { setModelEditor(null); setModelSeed(null); setNotice(`Model “${result.modelName}” saved.`); await refresh(); } });
  const modelDelete = useMutation({ mutationFn: deleteLlmModel, onSuccess: async () => { setNotice('Model deleted.'); await refresh(); } });
  const credentialSave = useMutation({ mutationFn: ({ input, id }: { input: LlmCredentialProfileMutation; id?: number }) => saveLlmCredentialProfile(input, id), onSuccess: async result => { setCredentialEditor(null); setNotice(`Credential profile “${result.label}” saved.`); await refresh(); } });
  const credentialDelete = useMutation({ mutationFn: deleteLlmCredentialProfile, onSuccess: async () => { setNotice('Credential profile deleted.'); await refresh(); } });
  const runtimePolicySave = useMutation({
    mutationFn: ({ id, input }: { id: number; input: AgentRuntimeCodeContextPolicyMutation }) => updateAgentRuntimeCodeContextPolicy(id, input),
    onSuccess: async result => {
      setNotice(`Code context policy for “${result.label}” saved.`);
      await queryClient.invalidateQueries({ queryKey: ['agent-runtime-profiles'] });
    },
  });
  const runtimeSave = useMutation({
    mutationFn: ({ input, id }: { input: AgentRuntimeProfileMutation; id?: number }) => saveAgentRuntimeProfile(input, id),
    onSuccess: async result => {
      setRuntimeEditor(null);
      setNotice(`Runtime profile “${result.label}” saved.`);
      await queryClient.invalidateQueries({ queryKey: ['agent-runtime-profiles'] });
    },
  });
  const runtimeDelete = useMutation({
    mutationFn: deleteAgentRuntimeProfile,
    onSuccess: async () => {
      setNotice('Runtime profile deleted.');
      await queryClient.invalidateQueries({ queryKey: ['agent-runtime-profiles'] });
    },
  });

  useEffect(() => {
    const create = new URLSearchParams(location.search).get('create');
    if (create !== 'provider' && create !== 'model' && create !== 'credential') return;
    if (create === 'provider') {
      providerSave.reset();
      setProviderEditor('new');
    } else if (create === 'model') {
      modelSave.reset();
      setModelSeed(null);
      setModelEditor('new');
    } else {
      credentialSave.reset();
      setCredentialEditor('new');
    }
    const params = new URLSearchParams(location.search);
    params.delete('create');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  if (catalogQuery.isLoading) return <LoadingState label="Loading AI providers and models…" />;
  if (catalogQuery.error) return <ErrorState error={catalogQuery.error} />;
  const catalog = catalogQuery.data!;
  const editedProvider = providerEditor === 'new' ? null : catalog.providers.find(item => item.id === providerEditor) ?? null;
  const editedCredential = credentialEditor === 'new' ? null : catalog.credentialProfiles.find(item => item.id === credentialEditor) ?? null;
  const editedModel = modelEditor === 'new' ? null : catalog.models.find(item => item.id === modelEditor) ?? null;
  const runtimeProfiles = (runtimeQuery.data ?? []).filter(profile => profile.runtime_type !== 'hermes');
  const editedRuntime = runtimeEditor === 'new' ? null : runtimeProfiles.find(item => item.id === runtimeEditor) ?? null;
  const openDiscovered = (providerId: number, upstream: string) => { setModelSeed({ providerId, upstream }); setModelEditor('new'); };

  return <><div className="llm-models-page">
    <a className="back-link" href="/settings"><ArrowLeft size={14} />Back to settings</a>
    <PageHeader eyebrow="AI RUNTIME" title="Models & execution runtimes" description="Connect model APIs and configure governed Argus, Codex or Claude Code execution profiles in one place." actions={<><button className="button button-secondary" type="button" onClick={() => setCredentialEditor('new')}><KeyRound size={15} />Add credential</button><button className="button button-primary" type="button" onClick={() => setProviderEditor('new')}><Plus size={15} />Add API provider</button></>} />
    {notice && <div className="connection-notice is-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}
    <section className="llm-runtime-banner"><span><BrainCircuit size={21} /></span><div><small>MODEL + EXECUTION CONTROL</small><b>Agent → runtime profile → model or protected subscription</b><p>Direct APIs use server-side provider credentials. Codex and Claude Code keep their browser login in isolated runtime volumes.</p></div><i>Provider neutral</i></section>
    <section className="llm-catalog-section llm-runtime-profiles-section"><header><div><span className="eyebrow">EXECUTION CONTROL</span><h2>Agent runtime profiles</h2><p>Choose how an Agent executes. Create API-backed, Codex or Claude Code profiles; solution-specific runtimes stay in their own modules.</p></div><div className="llm-section-actions"><a className="button button-secondary" href="/build/agents/manage"><Bot size={14} />Assign to Agents</a><button className="button button-primary" type="button" onClick={() => setRuntimeEditor('new')}><Plus size={14} />Add runtime profile</button></div></header>
      {runtimeQuery.isLoading && <LoadingState label="Loading execution runtimesâ€¦" />}
      {runtimeQuery.error && <div className="editor-error" role="alert"><AlertTriangle size={15} />Could not load Agent runtime profiles.</div>}
      {!runtimeQuery.isLoading && !runtimeQuery.error && <div className="llm-provider-grid">{runtimeProfiles.map((profile: AgentRuntimeProfile) => <article className={`llm-provider-card${profile.enabled ? '' : ' is-disabled'}`} key={profile.id}>
        <header><span className={`llm-provider-mark type-${profile.runtime_type === 'codex' ? 'anthropic' : 'openai-compatible'}`}>{profile.runtime_type === 'codex' ? <Zap size={19} /> : <ServerCog size={19} />}</span><div><h3>{profile.label}</h3><small>{profile.name} · {profile.runtime_type}</small></div><span className={`llm-provider-state ${profile.enabled ? 'state-healthy' : 'state-error'}`}><i />{profile.enabled ? 'configured' : 'disabled'}</span></header>
        <p className="llm-runtime-profile-description">{profile.description}</p>
        <div className="llm-provider-facts"><span><small>AUTH</small><b>{profile.auth_mode === 'chatgpt' ? 'ChatGPT subscription' : profile.auth_mode === 'none' ? 'Platform default' : profile.auth_mode}</b></span><span><small>MODEL</small><b>{profile.model || 'Deployment default'}</b></span><span><small>REASONING</small><b>{profile.reasoning_effort || 'Runtime default'}</b></span><span><small>ASSIGNED</small><b>{profile.assigned_agent_count} agents</b></span><span><small>CONCURRENCY</small><b>{profile.max_concurrent_runs} run{profile.max_concurrent_runs === 1 ? '' : 's'}</b></span><span><small>CODE ACCESS</small><b>{profile.code_context_mode === 'bounded_source' ? 'Bounded source' : 'Metadata only'}</b></span></div>
        <div className="llm-runtime-profile-note"><ShieldCheck size={13} /><span>{profile.runtime_type === 'codex'
          ? 'Browser sign-in stays in codex-auth; no token is stored in Argus.'
          : profile.runtime_type === 'claude-code'
            ? 'Browser sign-in stays in claude-auth; no token is stored in Argus.'
            : 'Uses the Agent model alias and its configured API provider.'}</span></div>
        <div className="llm-runtime-profile-actions">
          {(profile.runtime_type === 'codex' || profile.runtime_type === 'claude-code') && <button className="button button-secondary" type="button" disabled={!profile.enabled} onClick={() => setRuntimeConnectProfile(profile)}><KeyRound size={14} />Connect runtime</button>}
          {!profile.managed && <><button className="button button-secondary" type="button" onClick={() => setRuntimeEditor(profile.id)}><Pencil size={14} />Edit</button><button className="button button-secondary is-danger" type="button" disabled={profile.assigned_agent_count > 0 || runtimeDelete.isPending} title={profile.assigned_agent_count > 0 ? 'Remove Agent assignments first' : 'Delete runtime profile'} onClick={() => window.confirm(`Delete runtime profile “${profile.label}”?`) && runtimeDelete.mutate(profile.id)}><Trash2 size={14} />Delete</button></>}
          <small>{profile.managed ? 'Platform managed' : 'Custom profile'}</small>
        </div>
        <RuntimeCodeContextEditor profile={profile} saving={runtimePolicySave.isPending && runtimePolicySave.variables?.id === profile.id} onSave={input => runtimePolicySave.mutate({ id: profile.id, input })} />
      </article>)}{runtimeProfiles.length === 0 && <EmptyState title="No execution runtimes" description="Add a custom runtime profile or run the latest migrations to seed the platform defaults." />}</div>}
      {(runtimePolicySave.error || runtimeDelete.error) && <div className="editor-error" role="alert"><AlertTriangle size={15} />{(runtimePolicySave.error ?? runtimeDelete.error) instanceof Error ? (runtimePolicySave.error ?? runtimeDelete.error)!.message : 'Could not update runtime profiles.'}</div>}
    </section>

    <div className="llm-metrics"><div><span><ServerCog size={15} /></span><b>{catalog.summary.enabledProviders}</b><small>enabled API providers</small></div><div><span><Cpu size={15} /></span><b>{catalog.summary.enabledModels}</b><small>API model aliases</small></div><div><span><CheckCircle2 size={15} /></span><b>{catalog.summary.healthyProviders}</b><small>healthy API connections</small></div><div><span><KeyRound size={15} /></span><b>{catalog.summary.configuredCredentials}</b><small>provider credentials</small></div></div>

    <section className="llm-catalog-section"><header><div><span className="eyebrow">CREDENTIAL CONTROL</span><h2>Credential profiles</h2><p>Reusable provider secrets with department ownership, cost-center attribution and monthly budgets.</p></div><button className="button button-secondary" type="button" onClick={() => setCredentialEditor('new')}><Plus size={14} />Add credential profile</button></header>
      <div className="llm-credential-grid">{catalog.credentialProfiles.map(profile => {
        const assignmentCount = profile.assignedAgents + profile.assignedProviders;
        const budgetPercent = Math.max(0, Math.min(100, profile.budgetUsedPercent ?? 0));
        const unavailable = !profile.enabled || profile.expired || !profile.credentialConfigured;
        return <article className={`llm-credential-card${unavailable ? ' is-unavailable' : ''}`} key={profile.id}>
          <header><span><KeyRound size={17} /></span><div><h3>{profile.label}</h3><small>{profile.name} · {profile.providerType}</small></div><em className={unavailable ? 'is-error' : ''}>{profile.expired ? 'expired' : !profile.enabled ? 'disabled' : profile.credentialConfigured ? 'ready' : 'missing secret'}</em></header>
          <p>{profile.description || 'Reusable model credential with governed assignments.'}</p>
          <div className="llm-credential-ownership"><span><Building2 size={12} /><b>{profile.department || 'Shared platform'}</b><small>{profile.costCenter || 'No cost center'}</small></span><span><Bot size={12} /><b>{profile.assignedAgents} agents</b><small>{profile.assignedProviders} providers</small></span></div>
          <div className="llm-budget"><div><span><b>${profile.currentMonthSpendUsd.toFixed(2)}</b> this month</span><small>{profile.monthlyBudgetUsd == null ? 'No threshold' : `$${profile.monthlyBudgetUsd.toFixed(2)} · ${profile.budgetMode}`}</small></div><span><i style={{ width: `${profile.monthlyBudgetUsd == null ? 0 : budgetPercent}%` }} /></span></div>
          <footer><button type="button" onClick={() => setCredentialEditor(profile.id)}><Pencil size={13} />Edit</button><button className="is-danger" type="button" disabled={assignmentCount > 0 || credentialDelete.isPending} title={assignmentCount > 0 ? 'Remove Agent and Provider assignments first' : 'Delete credential profile'} onClick={() => window.confirm(`Delete credential profile “${profile.label}”?`) && credentialDelete.mutate(profile.id)}><Trash2 size={13} />Delete</button></footer>
        </article>;
      })}{catalog.credentialProfiles.length === 0 && <EmptyState title="No credential profiles" description="Add a reusable credential for a team, department, project or individual Agent." />}</div>
    </section>

    <section className="llm-catalog-section"><header><div><span className="eyebrow">CONNECTIONS</span><h2>AI providers</h2><p>Native OpenAI and Anthropic protocols plus compatible gateways and local runtimes.</p></div></header>
      <div className="llm-provider-grid">{catalog.providers.map(provider => {
        const result = tests[provider.id];
        const testing = providerTest.isPending && providerTest.variables === provider.id;
        return <article className={`llm-provider-card${provider.enabled ? '' : ' is-disabled'}`} key={provider.id}>
          <header><span className={`llm-provider-mark type-${provider.providerType}`}><ServerCog size={19} /></span><div><h3>{provider.label}</h3><small>{provider.name} · {provider.providerType}</small></div><span className={`llm-provider-state state-${provider.lastTestStatus ?? 'unknown'}`}><i />{provider.lastTestStatus ?? 'not tested'}</span></header>
          <div className="llm-provider-url"><Link2 size={13} /><code>{provider.baseUrl}</code></div>
          <div className="llm-provider-facts"><span><small>AUTH</small><b>{provider.authType === 'none' ? 'None' : provider.credentialConfigured ? provider.credentialProfileLabel || provider.secretName || 'Encrypted key' : 'Missing credential'}</b></span><span><small>MODELS</small><b>{provider.modelCount}</b></span><span><small>LAST CHECK</small><b>{provider.lastTestedAt ? timeAgo(provider.lastTestedAt) : 'Never'}</b></span></div>
          {(result || provider.lastTestError) && <div className={`llm-test-result ${(result?.ok ?? provider.lastTestStatus === 'healthy') ? 'is-success' : 'is-error'}`}><span>{(result?.ok ?? false) ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span><div><b>{result ? result.ok ? `Connected in ${result.latencyMs} ms` : 'Connection failed' : provider.lastTestError}</b>{result?.error && <small>{result.error}</small>}{result?.ok && <small>{result.models.length} upstream models discovered</small>}</div></div>}
          {result?.ok && result.models.length > 0 && <div className="llm-discovered"><small>DISCOVERED</small><div>{result.models.slice(0, 8).map(name => <button type="button" key={name} onClick={() => openDiscovered(provider.id, name)} title={`Register ${name}`}><Plus size={10} />{name}</button>)}{result.models.length > 8 && <span>+{result.models.length - 8}</span>}</div></div>}
          <footer><button type="button" onClick={() => providerTest.mutate(provider.id)} disabled={testing}><RefreshCw className={testing ? 'spin' : ''} size={13} />{testing ? 'Testing…' : 'Test'}</button><button type="button" onClick={() => setProviderEditor(provider.id)}><Pencil size={13} />Edit</button><button className="is-danger" type="button" disabled={provider.modelCount > 0 || providerDelete.isPending} title={provider.modelCount > 0 ? 'Remove assigned models first' : 'Delete provider'} onClick={() => window.confirm(`Delete provider “${provider.label}”?`) && providerDelete.mutate(provider.id)}><Trash2 size={13} />Delete</button></footer>
        </article>;
      })}{catalog.providers.length === 0 && <EmptyState title="No AI providers" description="Add a provider connection before registering models." />}</div>
    </section>

    <section className="llm-catalog-section"><header><div><span className="eyebrow">API CATALOG</span><h2>API model aliases</h2><p>Stable aliases for the Argus API runtime. Codex and Claude Code models belong to the execution profiles above.</p></div><button className="button button-secondary" type="button" disabled={catalog.providers.length === 0} onClick={() => { setModelSeed(null); setModelEditor('new'); }}><Plus size={14} />Register model</button></header>
      <p>Assignments count Agents that still need this API alias. Legacy references on enabled external profiles with a configured model do not block removal. Runtime profiles and historical runs stay unchanged.</p>
      <div className="llm-model-table"><div className="llm-model-row llm-model-head"><span>Model</span><span>Provider</span><span>Capabilities</span><span>Assignments</span><span>Status</span><span /></div>{catalog.models.map(model => <div className="llm-model-row" key={model.id}><div className="llm-model-primary"><span><Bot size={17} /></span><span><b>{model.displayName}</b><small>{model.modelName} → {model.upstreamModelName}</small></span></div><span><b>{model.providerLabel}</b><small>{model.providerType}</small></span><div className="llm-model-tags">{model.supportsTools && <i>tools</i>}{model.supportsVision && <i>vision</i>}{model.supportsReasoning && <i>reasoning</i>}</div><span><b>{model.assignedAgents}</b><small>agents</small></span><span className={`llm-model-status ${model.enabled && model.providerEnabled ? 'is-active' : 'is-disabled'}`}>{model.enabled && model.providerEnabled ? <CheckCircle2 size={13} /> : <CircleOff size={13} />}{model.enabled && model.providerEnabled ? 'routable' : 'disabled'}</span><div className="llm-model-actions"><button type="button" aria-label={`Edit ${model.modelName}`} onClick={() => setModelEditor(model.id)}><Pencil size={13} /></button><button className="is-danger" type="button" aria-label={`Delete ${model.modelName}`} disabled={model.assignedAgents > 0 || modelDelete.isPending} title={model.assignedAgents > 0 ? 'Model is assigned to agents' : 'Delete model'} onClick={() => window.confirm(`Delete model “${model.modelName}”?`) && modelDelete.mutate(model.id)}><Trash2 size={13} /></button></div></div>)}{catalog.models.length === 0 && <EmptyState title="No registered models" description="Test a provider to discover models or register an upstream name manually." />}</div>
    </section>
    {(providerSave.error || providerDelete.error || providerTest.error || modelDelete.error || credentialDelete.error) && <div className="editor-error llm-page-error" role="alert"><AlertTriangle size={15} />{(providerSave.error ?? providerDelete.error ?? providerTest.error ?? modelDelete.error ?? credentialDelete.error)?.message}</div>}
    {credentialEditor && <CredentialEditor key={credentialEditor} profile={editedCredential} saving={credentialSave.isPending} error={credentialSave.error?.message ?? null} onClose={() => setCredentialEditor(null)} onSave={input => credentialSave.mutate({ input, ...(editedCredential ? { id: editedCredential.id } : {}) })} />}
    {providerEditor && <ProviderEditor key={providerEditor} provider={editedProvider} profiles={catalog.credentialProfiles} saving={providerSave.isPending} error={providerSave.error?.message ?? null} onClose={() => setProviderEditor(null)} onSave={input => providerSave.mutate({ input, ...(editedProvider ? { id: editedProvider.id } : {}) })} />}
    {modelEditor && <ModelEditor key={`${modelEditor}-${modelSeed?.upstream ?? ''}`} model={editedModel} providers={catalog.providers} seed={modelSeed} saving={modelSave.isPending} error={modelSave.error?.message ?? null} onClose={() => { setModelEditor(null); setModelSeed(null); }} onSave={input => modelSave.mutate({ input, ...(editedModel ? { id: editedModel.id } : {}) })} />}
    {runtimeConnectProfile && <RuntimeConnectDialog profile={runtimeConnectProfile} onClose={() => setRuntimeConnectProfile(null)} />}
    {runtimeEditor && <RuntimeProfileEditor key={runtimeEditor} profile={editedRuntime} saving={runtimeSave.isPending} error={runtimeSave.error?.message ?? null} onClose={() => setRuntimeEditor(null)} onSave={input => runtimeSave.mutate({ input, ...(editedRuntime ? { id: editedRuntime.id } : {}) })} />}
  </div></>;
}
