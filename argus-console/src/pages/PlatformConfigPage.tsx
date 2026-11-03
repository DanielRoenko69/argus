import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  CloudCog,
  DatabaseZap,
  KeyRound,
  Network,
  RadioTower,
  Save,
  SearchCheck,
  ShieldCheck,
  TestTube2,
  X,
} from 'lucide-react';
import {
  getPlatformConfig,
  saveHydeConfig,
  saveK8sImpersonationConfig,
  saveOtelConfig,
  saveUpstreamTokenExchangeConfig,
  saveVaultConfig,
  testVaultConfig,
} from '../api';
import { ErrorState, LoadingState, PageHeader } from '../components/Ui';
import type {
  HydeConfig,
  K8sImpersonationConfig,
  OtelConfig,
  SafeVaultConfig,
  UpstreamTokenExchangeConfig,
  VaultConfigMutation,
} from '../types';

type ConfigTab = 'vault' | 'otel' | 'hyde' | 'k8s' | 'upstream';

const TABS: Array<{ id: ConfigTab; label: string; hint: string; icon: typeof KeyRound }> = [
  { id: 'vault', label: 'Secret provider', hint: 'Vault and mappings', icon: KeyRound },
  { id: 'otel', label: 'OpenTelemetry', hint: 'Tracing export', icon: RadioTower },
  { id: 'hyde', label: 'RAG HyDE', hint: 'Retrieval generation', icon: SearchCheck },
  { id: 'k8s', label: 'Kubernetes identity', hint: 'User impersonation', icon: CloudCog },
  { id: 'upstream', label: 'Token exchange', hint: 'Delegated upstream access', icon: Network },
];

function parseMap(value: string, label: string): Record<string, string> {
  if (!value.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object.`);
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([key, entry]) => !key.trim() || typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`${label} must contain non-empty string keys and values.`);
  }
  return Object.fromEntries(entries.map(([key, entry]) => [key.trim(), (entry as string).trim()]));
}

function mapText(value?: Record<string, string>): string {
  return value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '';
}

function ConfigPanel({ eyebrow, title, description, icon, children }: {
  eyebrow: string;
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return <section className="platform-config-panel">
    <header><span className="platform-config-panel-icon">{icon}</span><span><small>{eyebrow}</small><h2>{title}</h2><p>{description}</p></span></header>
    {children}
  </section>;
}

function SaveFeedback({ error }: { error: string | null }) {
  return error ? <div className="editor-error" role="alert"><AlertTriangle size={15} />{error}</div> : null;
}

function VaultPanel({ config, onSaved }: { config: SafeVaultConfig; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState(config.type);
  const [azureUri, setAzureUri] = useState(config.azureKvUri ?? '');
  const [azureAuth, setAzureAuth] = useState(config.azureAuth ?? 'workload-identity');
  const [azureTenantId, setAzureTenantId] = useState(config.azureTenantId ?? '');
  const [azureClientId, setAzureClientId] = useState(config.azureClientId ?? '');
  const [azureClientSecret, setAzureClientSecret] = useState('');
  const [hashicorpUrl, setHashicorpUrl] = useState(config.hashicorpUrl ?? '');
  const [hashicorpMount, setHashicorpMount] = useState(config.hashicorpMount ?? 'secret');
  const [hashicorpToken, setHashicorpToken] = useState('');
  const [hashicorpNamespace, setHashicorpNamespace] = useState(config.hashicorpNamespace ?? '');
  const [mappings, setMappings] = useState(mapText(config.mappings));
  const [validation, setValidation] = useState<string | null>(null);
  const saveMutation = useMutation({
    mutationFn: (input: VaultConfigMutation) => saveVaultConfig(input),
    onSuccess: async () => {
      setAzureClientSecret('');
      setHashicorpToken('');
      onSaved('Secret provider configuration saved. Runtime cache cleared.');
      await queryClient.invalidateQueries({ queryKey: ['platform-config'] });
    },
  });
  const testMutation = useMutation({
    mutationFn: () => testVaultConfig(),
    onSuccess: result => onSaved(result.ok
      ? `Vault connection succeeded in ${result.latencyMs ?? 0} ms.`
      : `Vault connection failed: ${result.error ?? 'unknown error'}`),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const payload: VaultConfigMutation = { type: provider, mappings: parseMap(mappings, 'Secret mappings') };
      if (provider === 'azure-kv') {
        payload.azureKvUri = azureUri;
        payload.azureAuth = azureAuth;
        payload.azureTenantId = azureTenantId || undefined;
        payload.azureClientId = azureClientId || undefined;
        payload.azureClientSecret = azureClientSecret || undefined;
      }
      if (provider === 'hashicorp') {
        payload.hashicorpUrl = hashicorpUrl;
        payload.hashicorpMount = hashicorpMount || 'secret';
        payload.hashicorpNamespace = hashicorpNamespace || undefined;
        payload.hashicorpToken = hashicorpToken || undefined;
      }
      setValidation(null);
      saveMutation.mutate(payload);
    } catch (error) {
      setValidation(error instanceof Error ? error.message : String(error));
    }
  };

  return <ConfigPanel eyebrow="SECRET RESOLUTION" title="Secret provider" description="Resolve mapped runtime secrets from Azure Key Vault or HashiCorp Vault while retaining environment fallback for unmapped names." icon={<KeyRound size={19} />}>
    <form className="platform-config-form" onSubmit={submit}>
      <section className="config-form-section">
        <div className="config-section-heading"><b>Provider</b><small>Selecting env-only removes persisted provider credentials on save.</small></div>
        <div className="config-choice-grid">
          {([
            ['none', 'Environment only', 'Read every secret from process environment'],
            ['azure-kv', 'Azure Key Vault', 'Workload identity or client credentials'],
            ['hashicorp', 'HashiCorp Vault', 'KV v2 with token authentication'],
          ] as const).map(([value, label, hint]) => <label className={provider === value ? 'is-selected' : ''} key={value}><input type="radio" name="vault-provider" checked={provider === value} onChange={() => setProvider(value)} /><span className="connection-check">{provider === value && <CheckCircle2 size={12} />}</span><span><b>{label}</b><small>{hint}</small></span></label>)}
        </div>
      </section>

      {provider === 'azure-kv' && <section className="config-form-section">
        <div className="config-section-heading"><b>Azure Key Vault</b><small>HTTPS endpoint and pod identity configuration.</small></div>
        <div className="policy-field-grid">
          <label className="editor-field"><span>Vault URI <em>required</em></span><input required type="url" value={azureUri} onChange={event => setAzureUri(event.target.value)} placeholder="https://argus-prod-kv.vault.azure.net" /></label>
          <label className="editor-field"><span>Authentication</span><select value={azureAuth} onChange={event => setAzureAuth(event.target.value as typeof azureAuth)}><option value="workload-identity">Workload identity</option><option value="client-secret">Client secret</option></select></label>
          {azureAuth === 'client-secret' && <><label className="editor-field"><span>Tenant ID <em>required</em></span><input required value={azureTenantId} onChange={event => setAzureTenantId(event.target.value)} /></label><label className="editor-field"><span>Client ID <em>required</em></span><input required value={azureClientId} onChange={event => setAzureClientId(event.target.value)} /></label><label className="editor-field"><span>Client secret {config.azureClientSecretConfigured && <i>configured</i>}</span><input required={!config.azureClientSecretConfigured} type="password" autoComplete="new-password" value={azureClientSecret} onChange={event => setAzureClientSecret(event.target.value)} placeholder={config.azureClientSecretConfigured ? 'Leave blank to keep existing' : 'Required'} /></label></>}
        </div>
      </section>}

      {provider === 'hashicorp' && <section className="config-form-section">
        <div className="config-section-heading"><b>HashiCorp Vault</b><small>KV v2 endpoint and authentication.</small></div>
        <div className="policy-field-grid">
          <label className="editor-field"><span>Vault URL <em>required</em></span><input required type="url" value={hashicorpUrl} onChange={event => setHashicorpUrl(event.target.value)} placeholder="https://vault.argus.local" /></label>
          <label className="editor-field"><span>KV mount</span><input value={hashicorpMount} onChange={event => setHashicorpMount(event.target.value)} placeholder="secret" /></label>
          <label className="editor-field"><span>Token {config.hashicorpTokenConfigured && <i>configured</i>}</span><input required={!config.hashicorpTokenConfigured} type="password" autoComplete="new-password" value={hashicorpToken} onChange={event => setHashicorpToken(event.target.value)} placeholder={config.hashicorpTokenConfigured ? 'Leave blank to keep existing' : 'Required'} /></label>
          <label className="editor-field"><span>Enterprise namespace</span><input value={hashicorpNamespace} onChange={event => setHashicorpNamespace(event.target.value)} placeholder="Optional" /></label>
        </div>
      </section>}

      <section className="config-form-section">
        <div className="config-section-heading"><b>Secret mappings</b><small>Only mapped names use Vault. Every other name continues to resolve from the environment.</small></div>
        <label className="editor-field"><span>Environment name to Vault path</span><textarea rows={8} value={mappings} onChange={event => setMappings(event.target.value)} placeholder={'{\n  "OPENAI_API_KEY": "argus/prod/openai"\n}'} /></label>
      </section>
      <SaveFeedback error={validation ?? saveMutation.error?.message ?? testMutation.error?.message ?? null} />
      <footer><button className="button button-secondary" type="button" disabled={testMutation.isPending || saveMutation.isPending || provider === 'none'} onClick={() => testMutation.mutate()}><TestTube2 size={14} />{testMutation.isPending ? 'Testing…' : 'Test saved configuration'}</button><button className="button button-primary" type="submit" disabled={saveMutation.isPending}><Save size={14} />{saveMutation.isPending ? 'Saving…' : 'Save secret provider'}</button></footer>
    </form>
  </ConfigPanel>;
}

function OtelPanel({ config, onSaved }: { config: OtelConfig; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [endpoint, setEndpoint] = useState(config.endpoint);
  const [sampling, setSampling] = useState(String(config.sampling));
  const [serviceName, setServiceName] = useState(config.serviceName);
  const [headers, setHeaders] = useState(mapText(config.headers));
  const [validation, setValidation] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: (input: OtelConfig) => saveOtelConfig(input), onSuccess: async () => { onSaved('OpenTelemetry configuration saved. Restart Argus to rebuild the tracing SDK.'); await queryClient.invalidateQueries({ queryKey: ['platform-config'] }); } });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const rate = Number(sampling);
      if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('Sampling rate must be between 0 and 1.');
      setValidation(null);
      mutation.mutate({ endpoint, sampling: rate, serviceName, headers: parseMap(headers, 'OTLP headers') });
    } catch (error) { setValidation(error instanceof Error ? error.message : String(error)); }
  };
  return <ConfigPanel eyebrow="OBSERVABILITY" title="OpenTelemetry tracing" description="Export Argus traces to an OTLP-compatible collector and control the volume at the source." icon={<RadioTower size={19} />}>
    <form className="platform-config-form" onSubmit={submit}>
      <section className="config-form-section"><div className="policy-field-grid"><label className="editor-field"><span>OTLP collector endpoint</span><input type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="http://otel-collector:4318" /></label><label className="editor-field"><span>Sampling rate</span><input required type="number" min="0" max="1" step="0.01" value={sampling} onChange={event => setSampling(event.target.value)} /><small>0 disables tracing; 0.1 samples ten percent.</small></label><label className="editor-field"><span>Service name</span><input required value={serviceName} onChange={event => setServiceName(event.target.value)} placeholder="argus-mcp-server" /></label></div><label className="editor-field"><span>OTLP headers</span><textarea rows={7} value={headers} onChange={event => setHeaders(event.target.value)} placeholder={'{\n  "x-honeycomb-team": "token"\n}'} /></label></section>
      <div className="config-restart-note"><AlertTriangle size={15} /><span><b>Restart required</b><small>The setting is persisted immediately, but the tracing SDK is initialized during process startup.</small></span></div>
      <SaveFeedback error={validation ?? mutation.error?.message ?? null} /><footer><button className="button button-primary" type="submit" disabled={mutation.isPending}><Save size={14} />{mutation.isPending ? 'Saving…' : 'Save tracing configuration'}</button></footer>
    </form>
  </ConfigPanel>;
}

function HydePanel({ config, onSaved }: { config: HydeConfig; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState(config.model);
  const [maxTokens, setMaxTokens] = useState(String(config.maxTokens));
  const [prompt, setPrompt] = useState(config.prompt);
  const mutation = useMutation({ mutationFn: (input: HydeConfig) => saveHydeConfig(input), onSuccess: async () => { onSaved('Global HyDE defaults saved and active for enabled RAG indexes.'); await queryClient.invalidateQueries({ queryKey: ['platform-config'] }); } });
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate({ model, maxTokens: Number(maxTokens), prompt }); };
  return <ConfigPanel eyebrow="RETRIEVAL" title="RAG HyDE defaults" description="Generate a hypothetical answer before vector search to improve recall for sparse or ambiguous queries." icon={<SearchCheck size={19} />}>
    <form className="platform-config-form" onSubmit={submit}><section className="config-form-section"><div className="policy-field-grid"><label className="editor-field"><span>Generation model</span><input required value={model} onChange={event => setModel(event.target.value)} placeholder="gpt-4o-mini" /></label><label className="editor-field"><span>Maximum tokens</span><input required type="number" min="50" max="500" value={maxTokens} onChange={event => setMaxTokens(event.target.value)} /></label></div><label className="editor-field"><span>Prompt template <em>must include {'{query}'}</em></span><textarea required rows={13} value={prompt} onChange={event => setPrompt(event.target.value)} /></label></section><div className="config-info-note"><SearchCheck size={15} /><span>HyDE is enabled per RAG index. This page defines only the shared generation defaults.</span></div><SaveFeedback error={mutation.error?.message ?? null} /><footer><button className="button button-primary" type="submit" disabled={mutation.isPending || !prompt.includes('{query}')}><Save size={14} />{mutation.isPending ? 'Saving…' : 'Save HyDE defaults'}</button></footer></form>
  </ConfigPanel>;
}

function K8sPanel({ config, onSaved }: { config: K8sImpersonationConfig; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(config.enabled);
  const [userSource, setUserSource] = useState(config.userSource);
  const [userHeader, setUserHeader] = useState(config.userHeader ?? '');
  const [defaultGroup, setDefaultGroup] = useState(config.defaultGroup ?? '');
  const [groupMap, setGroupMap] = useState(mapText(config.groupMap));
  const [validation, setValidation] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: (input: K8sImpersonationConfig) => saveK8sImpersonationConfig(input), onSuccess: async () => { onSaved(`Kubernetes user impersonation ${enabled ? 'enabled' : 'disabled'}.`); await queryClient.invalidateQueries({ queryKey: ['platform-config'] }); } });
  const submit = (event: FormEvent) => { event.preventDefault(); try { setValidation(null); mutation.mutate({ enabled, userSource, userHeader: userHeader || undefined, defaultGroup: defaultGroup || undefined, groupMap: parseMap(groupMap, 'Group mapping') }); } catch (error) { setValidation(error instanceof Error ? error.message : String(error)); } };
  return <ConfigPanel eyebrow="IDENTITY PROPAGATION" title="Kubernetes impersonation" description="Forward the authenticated Argus user to Kubernetes so cluster RBAC evaluates the human identity instead of only the service account." icon={<CloudCog size={19} />}>
    <form className="platform-config-form" onSubmit={submit}><section className="config-form-section"><label className="config-master-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span className="connection-check">{enabled && <CheckCircle2 size={12} />}</span><span><b>Enable Kubernetes impersonation</b><small>Immediately affects Kubernetes tool calls after saving.</small></span></label><div className="policy-field-grid"><label className="editor-field"><span>User source</span><select value={userSource} onChange={event => setUserSource(event.target.value as typeof userSource)}><option value="username">Argus username</option><option value="email">Entra preferred username / email</option><option value="custom">Custom session header</option></select></label>{userSource === 'custom' && <label className="editor-field"><span>Custom header <em>required</em></span><input required value={userHeader} onChange={event => setUserHeader(event.target.value)} placeholder="X-User-Email" /></label>}<label className="editor-field"><span>Default impersonation group</span><input value={defaultGroup} onChange={event => setDefaultGroup(event.target.value)} placeholder="argus-developers" /></label></div><label className="editor-field"><span>Argus role to Kubernetes group</span><textarea rows={8} value={groupMap} onChange={event => setGroupMap(event.target.value)} placeholder={'{\n  "developer": "argus-devs"\n}'} /></label></section>{enabled && <div className="config-risk-note"><ShieldCheck size={15} /><span><b>Cluster prerequisite</b><small>The Argus service account needs Kubernetes impersonation permission, and forwarded users require explicit RBAC bindings.</small></span></div>}<SaveFeedback error={validation ?? mutation.error?.message ?? null} /><footer><button className="button button-primary" type="submit" disabled={mutation.isPending}><Save size={14} />{mutation.isPending ? 'Saving…' : 'Save identity propagation'}</button></footer></form>
  </ConfigPanel>;
}

function UpstreamPanel({ config, onSaved }: { config: UpstreamTokenExchangeConfig; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(config.enabled);
  const mutation = useMutation({ mutationFn: (input: UpstreamTokenExchangeConfig) => saveUpstreamTokenExchangeConfig(input), onSuccess: async () => { onSaved(`Upstream token exchange ${enabled ? 'enabled' : 'disabled'} across the platform.`); await queryClient.invalidateQueries({ queryKey: ['platform-config'] }); } });
  return <ConfigPanel eyebrow="DELEGATED ACCESS" title="Upstream token exchange" description="Allow OAuth-capable backends to execute with the connected end-user identity instead of only the platform service account." icon={<Network size={19} />}>
    <form className="platform-config-form" onSubmit={event => { event.preventDefault(); mutation.mutate({ enabled }); }}><section className="config-form-section"><label className="config-master-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span className="connection-check">{enabled && <CheckCircle2 size={12} />}</span><span><b>Enable delegated upstream identity</b><small>User OAuth modes stop on missing delegation. Service accounts must be configured explicitly.</small></span></label><div className="upstream-flow"><span><UserTokenIcon /></span><i /><span><Network size={17} /></span><i /><span><Boxes size={17} /></span><small>Argus session</small><small>OAuth backend</small><small>Upstream system</small></div></section><div className={enabled ? 'config-risk-note' : 'config-info-note'}><KeyRound size={15} /><span>{enabled ? 'Users must connect each OAuth backend under My Connections. Configure individual backends as permissive or strict in MCP Fabric.' : 'User OAuth calls are blocked while this switch is disabled. Explicit service-account connections are unaffected.'}</span></div><SaveFeedback error={mutation.error?.message ?? null} /><footer><button className="button button-primary" type="submit" disabled={mutation.isPending}><Save size={14} />{mutation.isPending ? 'Saving…' : 'Save token exchange'}</button></footer></form>
  </ConfigPanel>;
}

function UserTokenIcon() { return <KeyRound size={17} />; }

export function PlatformConfigPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const activeTab = TABS.some(tab => tab.id === requested) ? requested as ConfigTab : 'vault';
  const [notice, setNotice] = useState('');
  const query = useQuery({ queryKey: ['platform-config'], queryFn: getPlatformConfig, staleTime: 10_000 });
  if (query.isLoading) return <LoadingState label="Loading platform configuration…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;
  const data = query.data;
  const providerLabel = data.vault.type === 'none' ? 'Environment' : data.vault.type === 'azure-kv' ? 'Azure KV' : 'HashiCorp';

  return <>
    <a className="back-link" href="/settings"><ArrowLeft size={14} />Back to settings</a>
    <PageHeader eyebrow="PLATFORM SETTINGS" title="Platform Configuration" description="Control secret resolution, telemetry and identity propagation without editing deployment manifests." />
    {notice && <div className={`connection-notice ${notice.includes('failed') ? 'is-error' : 'is-success'}`} role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}
    <section className="metric-grid platform-config-metrics" aria-label="Platform configuration summary"><article className="metric-card"><span className="metric-icon violet"><DatabaseZap size={17} /></span><div><span>Secret provider</span><strong className="metric-word">{providerLabel}</strong><small>{Object.keys(data.vault.mappings ?? {}).length} mapped names</small></div></article><article className="metric-card"><span className="metric-icon blue"><Activity size={17} /></span><div><span>Trace sampling</span><strong>{Math.round(data.otel.sampling * 100)}%</strong><small>{data.otel.endpoint ? 'collector configured' : 'no collector endpoint'}</small></div></article><article className="metric-card"><span className="metric-icon teal"><CloudCog size={17} /></span><div><span>Kubernetes identity</span><strong className="metric-word">{data.k8s_impersonation.enabled ? 'Forwarded' : 'Service account'}</strong><small>{data.k8s_impersonation.userSource} source</small></div></article><article className="metric-card"><span className="metric-icon amber"><Network size={17} /></span><div><span>Upstream identity</span><strong className="metric-word">{data.upstream_token_exchange.enabled ? 'Delegated' : 'Service account'}</strong><small>platform master switch</small></div></article></section>
    <div className="platform-config-layout">
      <nav className="platform-config-nav" aria-label="Configuration sections">{TABS.map(tab => { const Icon = tab.icon; return <button className={activeTab === tab.id ? 'is-active' : ''} type="button" key={tab.id} onClick={() => setSearchParams({ tab: tab.id })}><Icon size={16} /><span><b>{tab.label}</b><small>{tab.hint}</small></span></button>; })}</nav>
      <main>{activeTab === 'vault' && <VaultPanel key={`vault-${data.vault.type}`} config={data.vault} onSaved={setNotice} />}{activeTab === 'otel' && <OtelPanel config={data.otel} onSaved={setNotice} />}{activeTab === 'hyde' && <HydePanel config={data.hyde} onSaved={setNotice} />}{activeTab === 'k8s' && <K8sPanel config={data.k8s_impersonation} onSaved={setNotice} />}{activeTab === 'upstream' && <UpstreamPanel config={data.upstream_token_exchange} onSaved={setNotice} />}</main>
    </div>
  </>;
}
