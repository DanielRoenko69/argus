import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import type {
  FabricConnectionDiscoveryResult,
  FabricConnectionMutation,
  FabricConnectionSaveResult,
  FabricConnectionTestResult,
  FabricManagementBackend,
  FabricManagementBundle,
} from '../types';
import { BundleGlyph } from './BundleGlyph';

type HeaderRow = { id: number; name: string; value: string };
type WizardPhase = 'idle' | 'saving' | 'testing' | 'discovering' | 'ready' | 'activating' | 'complete';

const WIZARD_STEPS = [
  { label: 'Endpoint', detail: 'Transport and identity', icon: Network },
  { label: 'Security', detail: 'Credentials and OAuth', icon: KeyRound },
  { label: 'Access', detail: 'Bundles and activation', icon: ShieldCheck },
  { label: 'Verify', detail: 'Test and capabilities', icon: Wrench },
] as const;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 64);
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const EXECUTION_TARGET_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const KUBERNETES_NAMESPACE_PATTERN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

function parseNamespaces(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map(namespace => namespace.trim()).filter(Boolean))];
}

export function ConnectionEditor({
  connection,
  preset,
  bundles,
  saving,
  deleting,
  error,
  onClose,
  onSave,
  onTest,
  onDiscover,
  onTrust,
  onDelete,
}: {
  connection: FabricManagementBackend | null;
  preset?: {
    type?: 'mcp' | 'http';
    name: string;
    description: string;
    baseUrl: string;
    mcpEndpoint: string;
  } | null;
  bundles: FabricManagementBundle[];
  saving: boolean;
  deleting: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: FabricConnectionMutation, idOverride?: number) => Promise<FabricConnectionSaveResult>;
  onTest: (id: number) => Promise<FabricConnectionTestResult>;
  onDiscover: (id: number) => Promise<FabricConnectionDiscoveryResult>;
  onTrust: (id: number) => Promise<unknown>;
  onDelete: (() => void) | null;
}) {
  const initialExecutionTarget = connection?.executionTargets?.[0];
  const initialExecutionNamespaces = connection?.executionTargets
    ?.filter(target => target.targetId === initialExecutionTarget?.targetId)
    .map(target => target.namespace) ?? [];
  const [step, setStep] = useState(0);
  const [furthestStep, setFurthestStep] = useState(0);
  const [phase, setPhase] = useState<WizardPhase>('idle');
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<FabricConnectionSaveResult | null>(null);
  const [testResult, setTestResult] = useState<FabricConnectionTestResult | null>(null);
  const [discoveryResult, setDiscoveryResult] = useState<FabricConnectionDiscoveryResult | null>(null);
  const [activated, setActivated] = useState(connection?.enabled ?? false);
  const [type, setType] = useState<'mcp' | 'http'>(
    connection?.type === 'http' || (!connection && preset?.type === 'http') ? 'http' : 'mcp',
  );
  const [name, setName] = useState(connection?.name ?? preset?.name ?? '');
  const [description, setDescription] = useState(connection?.description ?? preset?.description ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? preset?.baseUrl ?? '');
  const [mcpEndpoint, setMcpEndpoint] = useState(connection?.mcpEndpoint ?? preset?.mcpEndpoint ?? '/mcp');
  const [healthPath, setHealthPath] = useState(connection?.healthPath ?? '/health');
  const [authType, setAuthType] = useState<FabricConnectionMutation['authType']>(
    connection?.authType ?? 'none',
  );
  const [authValue, setAuthValue] = useState('');
  const [clearAuthValue, setClearAuthValue] = useState(false);
  const [authMode, setAuthMode] = useState<FabricConnectionMutation['authMode']>(
    connection?.authMode ?? 'service-account',
  );
  const [oauthAuthorizeUrl, setOauthAuthorizeUrl] = useState(connection?.oauthAuthorizeUrl ?? '');
  const [oauthTokenUrl, setOauthTokenUrl] = useState(connection?.oauthTokenUrl ?? '');
  const [oauthClientId, setOauthClientId] = useState(connection?.oauthClientId ?? '');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [clearOauthClientSecret, setClearOauthClientSecret] = useState(false);
  const [oauthScopes, setOauthScopes] = useState(connection?.oauthScopes.join(' ') ?? '');
  const [oauthRevokeUrl, setOauthRevokeUrl] = useState(connection?.oauthRevokeUrl ?? '');
  const [timeoutMs, setTimeoutMs] = useState(connection?.timeoutMs ?? 10_000);
  const [tlsSkipVerify, setTlsSkipVerify] = useState(connection?.tlsSkipVerify ?? false);
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [bundleIds, setBundleIds] = useState<number[]>(connection?.bundleIds ?? []);
  const [executionTargetEnabled, setExecutionTargetEnabled] = useState(Boolean(initialExecutionTarget));
  const [executionTargetTouched, setExecutionTargetTouched] = useState(false);
  const [targetPlatform, setTargetPlatform] = useState<NonNullable<FabricConnectionMutation['executionTarget']>['platform']>(initialExecutionTarget?.platform ?? 'kubernetes');
  const [targetId, setTargetId] = useState(initialExecutionTarget?.targetId ?? '');
  const [targetLabel, setTargetLabel] = useState(initialExecutionTarget?.targetLabel ?? '');
  const [targetCluster, setTargetCluster] = useState(initialExecutionTarget?.cluster ?? '');
  const [targetEnvironment, setTargetEnvironment] = useState(initialExecutionTarget?.environment ?? 'production');
  const [targetNamespaces, setTargetNamespaces] = useState(initialExecutionNamespaces.join('\n'));
  const [headers, setHeaders] = useState<HeaderRow[]>(() =>
    Object.entries(connection?.defaultHeaders ?? {}).map(([headerName, value], index) => ({
      id: index + 1,
      name: headerName,
      value,
    })),
  );
  const [nextHeaderId, setNextHeaderId] = useState(headers.length + 1);
  const [dirty, setDirty] = useState(false);
  const selectedBundles = useMemo(() => new Set(bundleIds), [bundleIds]);
  const workflowBusy = ['saving', 'testing', 'discovering', 'activating'].includes(phase);
  const busy = saving || deleting || workflowBusy;

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        if (!dirty || phase === 'complete' || window.confirm('Ungespeicherte Änderungen verwerfen?')) onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('has-dialog');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [busy, dirty, onClose, phase]);

  const requestClose = () => {
    if (busy) return;
    if (!dirty || phase === 'complete' || window.confirm('Ungespeicherte Änderungen verwerfen?')) onClose();
  };
  const change = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setDirty(true);
    setWorkflowError(null);
  };
  const toggleBundle = (id: number) => {
    setBundleIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
    setDirty(true);
  };
  const changeExecutionTarget = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    setExecutionTargetTouched(true);
    setDirty(true);
    setWorkflowError(null);
  };
  const addHeader = () => {
    setHeaders(current => [...current, { id: nextHeaderId, name: '', value: '' }]);
    setNextHeaderId(current => current + 1);
    setDirty(true);
  };
  const updateHeader = (id: number, field: 'name' | 'value', value: string) => {
    setHeaders(current => current.map(header => header.id === id ? { ...header, [field]: value } : header));
    setDirty(true);
  };
  const removeHeader = (id: number) => {
    setHeaders(current => current.filter(header => header.id !== id));
    setDirty(true);
  };

  const buildInput = (activation = enabled): FabricConnectionMutation => {
    const defaultHeaders = Object.fromEntries(
      headers
        .map(header => [header.name.trim(), header.value] as const)
        .filter(([headerName]) => Boolean(headerName)),
    );
    return {
      ...(!connection ? { name } : {}),
      type,
      description,
      baseUrl,
      mcpEndpoint: type === 'mcp' ? mcpEndpoint : null,
      authType,
      ...(clearAuthValue
        ? { authValue: null }
        : authValue
          ? { authValue }
          : {}),
      healthPath: type === 'http' ? healthPath || null : null,
      defaultHeaders,
      timeoutMs,
      tlsSkipVerify,
      enabled: activation,
      authMode,
      oauthAuthorizeUrl: authMode === 'service-account' ? null : oauthAuthorizeUrl || null,
      oauthTokenUrl: authMode === 'service-account' ? null : oauthTokenUrl || null,
      oauthClientId: authMode === 'service-account' ? null : oauthClientId || null,
      ...(clearOauthClientSecret
        ? { oauthClientSecret: null }
        : oauthClientSecret
          ? { oauthClientSecret }
          : {}),
      oauthScopes: authMode === 'service-account'
        ? []
        : oauthScopes.split(/\s+/).map(scope => scope.trim()).filter(Boolean),
      oauthRevokeUrl: authMode === 'service-account' ? null : oauthRevokeUrl || null,
      bundleIds,
      ...(executionTargetTouched || !connection && executionTargetEnabled
        ? {
            executionTarget: executionTargetEnabled
              ? {
                  kind: 'kubernetes' as const,
                  platform: targetPlatform,
                  targetId: targetId.trim(),
                  label: targetLabel.trim(),
                  cluster: targetCluster.trim(),
                  environment: targetEnvironment.trim(),
                  namespaces: parseNamespaces(targetNamespaces),
                }
              : null,
          }
        : {}),
    };
  };

  const stepError = (targetStep: number): string | null => {
    if (targetStep === 0) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return 'Enter a valid internal name.';
      if (!validHttpUrl(baseUrl)) return 'Enter a valid HTTP or HTTPS base URL.';
      const path = type === 'mcp' ? mcpEndpoint : healthPath;
      if (path && !path.startsWith('/')) return 'The endpoint path must start with /.';
      if (timeoutMs < 500 || timeoutMs > 120_000) return 'Timeout must be between 500 and 120000 ms.';
    }
    if (targetStep === 1) {
      const hasServiceCredential = Boolean(connection?.hasAuthValue && !clearAuthValue) || Boolean(authValue);
      if (authType !== 'none' && !hasServiceCredential) {
        return 'Provide the selected service credential.';
      }
      if (authMode !== 'service-account') {
        if (!validHttpUrl(oauthAuthorizeUrl) || !validHttpUrl(oauthTokenUrl)) {
          return 'OAuth requires valid authorize and token URLs.';
        }
        if (!oauthClientId.trim()) return 'OAuth requires a client ID.';
        const hasClientSecret = Boolean(connection?.hasOauthClientSecret && !clearOauthClientSecret)
          || Boolean(oauthClientSecret);
        if (!hasClientSecret) return 'OAuth requires a client secret.';
      }
    }
    if (targetStep === 2 && executionTargetEnabled) {
      if (type !== 'mcp') return 'Kubernetes execution targets require a remote MCP connection.';
      if (bundleIds.length === 0) return 'Assign at least one access bundle to publish this runtime target.';
      if (!EXECUTION_TARGET_ID_PATTERN.test(targetId.trim()) || targetId.trim().length > 128) {
        return 'Target ID must be a lowercase slug, for example production-kubernetes.';
      }
      if (!targetLabel.trim() || targetLabel.trim().length > 200) return 'Enter a target display name.';
      if (!targetCluster.trim() || targetCluster.trim().length > 200) return 'Enter the cluster identity.';
      if (!EXECUTION_TARGET_ID_PATTERN.test(targetEnvironment.trim()) || targetEnvironment.trim().length > 120) {
        return 'Environment must be a lowercase slug, for example production.';
      }
      const namespaces = parseNamespaces(targetNamespaces);
      if (namespaces.length < 1 || namespaces.length > 64
        || namespaces.some(namespace => namespace.length > 63 || !KUBERNETES_NAMESPACE_PATTERN.test(namespace))) {
        return 'Provide between 1 and 64 valid Kubernetes namespaces.';
      }
    }
    return null;
  };

  const goNext = () => {
    const validation = stepError(step);
    if (validation) {
      setWorkflowError(validation);
      return;
    }
    const next = Math.min(step + 1, 2);
    setStep(next);
    setFurthestStep(current => Math.max(current, next));
    setWorkflowError(null);
  };

  const verifyConnection = async (event?: FormEvent) => {
    event?.preventDefault();
    const endpointError = stepError(0);
    const securityError = stepError(1);
    const accessError = stepError(2);
    if (endpointError || securityError || accessError) {
      setWorkflowError(endpointError || securityError || accessError);
      return;
    }
    setWorkflowError(null);
    setTestResult(null);
    setDiscoveryResult(null);
    let staged: FabricConnectionSaveResult | null = null;
    try {
      setPhase('saving');
      const saved = await onSave(buildInput(connection ? enabled : false));
      staged = saved;
      setSaveResult(saved);
      setActivated(connection ? enabled : false);
      setStep(3);
      setFurthestStep(3);

      setPhase('testing');
      const tested = await onTest(saved.connection.id);
      setTestResult(tested);
      if (!tested.reachable) {
        setPhase('ready');
        return;
      }

      if (type === 'mcp') {
        setPhase('discovering');
        const discovered = await onDiscover(saved.connection.id);
        setDiscoveryResult(discovered);
      }
      setPhase(connection ? 'complete' : 'ready');
      if (connection) setDirty(false);
    } catch (caught) {
      setWorkflowError(caught instanceof Error ? caught.message : 'Connection verification failed.');
      setPhase(staged ? 'ready' : 'idle');
    }
  };

  const activateConnection = async () => {
    if (!saveResult || !testResult?.reachable) return;
    setWorkflowError(null);
    setPhase('activating');
    try {
      if (type === 'mcp') await onTrust(saveResult.connection.id);
      await onSave(buildInput(enabled), saveResult.connection.id);
      setActivated(enabled);
      setDirty(false);
      setPhase('complete');
    } catch (caught) {
      setWorkflowError(caught instanceof Error ? caught.message : 'Connection activation failed.');
      setPhase('ready');
    }
  };

  const retryVerification = async () => {
    if (!saveResult) return;
    setWorkflowError(null);
    try {
      setPhase('testing');
      const tested = await onTest(saveResult.connection.id);
      setTestResult(tested);
      if (tested.reachable && type === 'mcp') {
        setPhase('discovering');
        setDiscoveryResult(await onDiscover(saveResult.connection.id));
      }
      setPhase(connection ? 'complete' : 'ready');
    } catch (caught) {
      setWorkflowError(caught instanceof Error ? caught.message : 'Connection verification failed.');
      setPhase('ready');
    }
  };

  const endpoint = `${baseUrl.replace(/\/$/, '')}${type === 'mcp' ? mcpEndpoint : healthPath}`;
  const parsedExecutionNamespaces = parseNamespaces(targetNamespaces);
  const verificationLabel = phase === 'saving'
    ? 'Saving configuration'
    : phase === 'testing'
      ? 'Testing endpoint'
      : phase === 'discovering'
        ? 'Discovering capabilities'
        : phase === 'activating'
          ? 'Approving and activating'
          : null;

  return (
    <div className="editor-layer" role="presentation" onMouseDown={requestClose}>
      <section
        className="bundle-editor connection-editor connection-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-editor-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="editor-header">
          <div>
            <span className="eyebrow">MCP FABRIC · CONNECTION WIZARD</span>
            <h2 id="connection-editor-title">{connection ? `Edit ${connection.name}` : 'Connect server or system'}</h2>
            <p>Define the endpoint, secure its identity, scope access and verify live capabilities.</p>
          </div>
          <button type="button" className="editor-close" aria-label="Close connection editor" onClick={requestClose}>
            <X size={18} />
          </button>
        </header>

        <nav className="connection-wizard-steps" aria-label="Connection setup progress">
          {WIZARD_STEPS.map((wizardStep, index) => {
            const Icon = wizardStep.icon;
            const available = index <= furthestStep || index < step;
            return (
              <button
                type="button"
                className={`${index === step ? 'is-active' : ''}${index < step || phase === 'complete' ? ' is-complete' : ''}`}
                disabled={!available || busy || index === 3 && !saveResult}
                onClick={() => {
                  if (available) {
                    setStep(index);
                    setWorkflowError(null);
                  }
                }}
                key={wizardStep.label}
              >
                <span>{index < step || phase === 'complete' ? <Check size={14} /> : <Icon size={14} />}</span>
                <div><b>{wizardStep.label}</b><small>{wizardStep.detail}</small></div>
              </button>
            );
          })}
        </nav>

        <form className="connection-wizard-form" onSubmit={verifyConnection}>
          <div className={`connection-wizard-stage wizard-stage-${step}`}>
            {step === 0 && (
              <>
                <section className="editor-section">
                  <div className="editor-section-heading">
                    <span><Network size={17} /></span>
                    <div><small>STEP 1 · ENDPOINT</small><h3>Connection definition</h3></div>
                  </div>
                  <div className="connection-type-switch" aria-label="Connection type">
                    <button type="button" className={type === 'mcp' ? 'is-selected' : ''} disabled={Boolean(connection)} onClick={() => change(setType, 'mcp')}>
                      <Server size={17} /><span><b>Remote MCP</b><small>Discover tools from an MCP server</small></span>
                    </button>
                    <button type="button" className={type === 'http' ? 'is-selected' : ''} disabled={Boolean(connection)} onClick={() => change(setType, 'http')}>
                      <Braces size={17} /><span><b>HTTP backend</b><small>Attach REST-based dynamic tools</small></span>
                    </button>
                  </div>
                  <label className="editor-field">
                    <span>Internal name <em>required</em></span>
                    <input autoFocus disabled={Boolean(connection)} maxLength={64} value={name} onChange={event => change(setName, slugify(event.target.value))} placeholder="github_mcp" />
                    <small>{connection ? 'Stable to preserve tool prefixes and registry identity.' : `Tool prefix: ${name || 'connection'}_…`}</small>
                  </label>
                  <label className="editor-field">
                    <span>Description</span>
                    <textarea rows={3} maxLength={5000} value={description} onChange={event => change(setDescription, event.target.value)} placeholder="What this system provides to agents and workflows." />
                  </label>
                  <label className="editor-field">
                    <span>Base URL <em>required</em></span>
                    <input type="url" maxLength={2048} value={baseUrl} onChange={event => change(setBaseUrl, event.target.value)} placeholder="https://mcp.example.com" />
                  </label>
                  <div className="editor-field-grid">
                    {type === 'mcp' ? (
                      <label className="editor-field">
                        <span>MCP endpoint</span>
                        <input maxLength={256} value={mcpEndpoint} onChange={event => change(setMcpEndpoint, event.target.value)} placeholder="/mcp" />
                      </label>
                    ) : (
                      <label className="editor-field">
                        <span>Health endpoint</span>
                        <input maxLength={256} value={healthPath} onChange={event => change(setHealthPath, event.target.value)} placeholder="/health" />
                      </label>
                    )}
                    <label className="editor-field">
                      <span>Timeout</span>
                      <div className="input-with-suffix">
                        <input type="number" min={500} max={120000} step={500} value={timeoutMs} onChange={event => change(setTimeoutMs, Number(event.target.value))} />
                        <span>ms</span>
                      </div>
                    </label>
                  </div>
                  <div className="editor-toggle-row single">
                    <label className={tlsSkipVerify ? 'is-warning' : ''}>
                      <input type="checkbox" checked={tlsSkipVerify} onChange={event => change(setTlsSkipVerify, event.target.checked)} />
                      <span><b>Skip TLS verification</b><small>Development only. Blocked in production.</small></span>
                    </label>
                  </div>
                </section>

                <aside className="wizard-context-card">
                  <span className="wizard-context-icon">{type === 'mcp' ? <Server size={20} /> : <Braces size={20} />}</span>
                  <span className="eyebrow">LIVE CONFIGURATION</span>
                  <h3>{name || 'New connection'}</h3>
                  <code>{validHttpUrl(baseUrl) ? endpoint : 'Endpoint not configured'}</code>
                  <dl>
                    <div><dt>Transport</dt><dd>{type === 'mcp' ? 'Streamable HTTP / SSE fallback' : 'HTTP health probe'}</dd></div>
                    <div><dt>Timeout</dt><dd>{timeoutMs.toLocaleString()} ms</dd></div>
                    <div><dt>TLS</dt><dd>{tlsSkipVerify ? 'Verification disabled' : 'Verified'}</dd></div>
                  </dl>
                  <p>Argus validates the URL server-side and applies its SSRF policy before making a request.</p>
                </aside>
              </>
            )}

            {step === 1 && (
              <>
                <section className="editor-section">
                  <div className="editor-section-heading">
                    <span><KeyRound size={17} /></span>
                    <div><small>STEP 2 · SERVICE IDENTITY</small><h3>Request authentication</h3></div>
                  </div>
                  <label className="editor-field">
                    <span>Authentication</span>
                    <select value={authType} onChange={event => change(setAuthType, event.target.value as FabricConnectionMutation['authType'])}>
                      <option value="none">No service credential</option>
                      <option value="bearer">Bearer token</option>
                      <option value="basic">Basic auth (user:password)</option>
                      <option value="header">Custom header (Header-Name: value)</option>
                    </select>
                  </label>
                  {authType !== 'none' && (
                    <div className="secret-editor">
                      <label className="editor-field">
                        <span>{connection?.hasAuthValue ? 'Replace saved credential' : 'Credential'} <em>required</em></span>
                        <input
                          type="password"
                          autoComplete="new-password"
                          disabled={clearAuthValue}
                          value={authValue}
                          onChange={event => {
                            change(setAuthValue, event.target.value);
                            setClearAuthValue(false);
                          }}
                          placeholder={connection?.hasAuthValue ? 'Leave empty to keep current value' : 'Token or credential'}
                        />
                      </label>
                      {connection?.hasAuthValue && (
                        <label className="clear-secret">
                          <input type="checkbox" checked={clearAuthValue} onChange={event => {
                            change(setClearAuthValue, event.target.checked);
                            if (event.target.checked) setAuthValue('');
                          }} />
                          Remove stored service credential
                        </label>
                      )}
                    </div>
                  )}
                  <div className="header-editor">
                    <div className="header-editor-heading">
                      <div><b>Default headers</b><small>Sent with every request. Do not place secrets here.</small></div>
                      <button type="button" onClick={addHeader}><Plus size={13} />Add header</button>
                    </div>
                    {headers.map(header => (
                      <div className="header-row" key={header.id}>
                        <input aria-label="Header name" maxLength={256} value={header.name} onChange={event => updateHeader(header.id, 'name', event.target.value)} placeholder="X-Environment" />
                        <input aria-label="Header value" maxLength={4096} value={header.value} onChange={event => updateHeader(header.id, 'value', event.target.value)} placeholder="production" />
                        <button type="button" aria-label="Remove header" onClick={() => removeHeader(header.id)}><X size={14} /></button>
                      </div>
                    ))}
                    {headers.length === 0 && <div className="picker-empty compact">No default headers configured.</div>}
                  </div>
                </section>

                <section className="editor-section">
                  <div className="editor-section-heading">
                    <span><LockKeyhole size={17} /></span>
                    <div><small>STEP 2 · USER IDENTITY</small><h3>Upstream OAuth</h3></div>
                  </div>
                  <p className="editor-section-description">Let tools act as the signed-in user. The platform Token Exchange switch must also be enabled.</p>
                  <label className="editor-field">
                    <span>Identity mode</span>
                    <select value={authMode} onChange={event => change(setAuthMode, event.target.value as FabricConnectionMutation['authMode'])}>
                      <option value="service-account">Service account only</option>
                      <option value="permissive">User OAuth (legacy permissive; no automatic fallback)</option>
                      <option value="strict">Require user token</option>
                    </select>
                  </label>
                  {authMode !== 'service-account' && (
                    <div className="oauth-field-stack">
                      <label className="editor-field"><span>Authorize URL <em>required</em></span><input type="url" maxLength={2048} value={oauthAuthorizeUrl} onChange={event => change(setOauthAuthorizeUrl, event.target.value)} placeholder="https://provider.example.com/oauth/authorize" /></label>
                      <label className="editor-field"><span>Token URL <em>required</em></span><input type="url" maxLength={2048} value={oauthTokenUrl} onChange={event => change(setOauthTokenUrl, event.target.value)} placeholder="https://provider.example.com/oauth/token" /></label>
                      <label className="editor-field"><span>Client ID <em>required</em></span><input maxLength={2048} value={oauthClientId} onChange={event => change(setOauthClientId, event.target.value)} placeholder="client_id" /></label>
                      <div className="secret-editor">
                        <label className="editor-field">
                          <span>{connection?.hasOauthClientSecret ? 'Replace client secret' : 'Client secret'} <em>required</em></span>
                          <input
                            type="password"
                            autoComplete="new-password"
                            disabled={clearOauthClientSecret}
                            value={oauthClientSecret}
                            onChange={event => {
                              change(setOauthClientSecret, event.target.value);
                              setClearOauthClientSecret(false);
                            }}
                            placeholder={connection?.hasOauthClientSecret ? 'Leave empty to keep current value' : 'OAuth client secret'}
                          />
                        </label>
                        {connection?.hasOauthClientSecret && (
                          <label className="clear-secret">
                            <input type="checkbox" checked={clearOauthClientSecret} onChange={event => {
                              change(setClearOauthClientSecret, event.target.checked);
                              if (event.target.checked) setOauthClientSecret('');
                            }} />
                            Remove stored OAuth client secret
                          </label>
                        )}
                      </div>
                      <label className="editor-field"><span>Scopes</span><input value={oauthScopes} onChange={event => change(setOauthScopes, event.target.value)} placeholder="repository:read pullrequest:write" /><small>Space-separated.</small></label>
                      <label className="editor-field"><span>Revoke URL</span><input type="url" maxLength={2048} value={oauthRevokeUrl} onChange={event => change(setOauthRevokeUrl, event.target.value)} placeholder="https://provider.example.com/oauth/revoke" /></label>
                    </div>
                  )}
                  <div className="assignment-note"><ShieldCheck size={15} /><span>Secrets are encrypted at rest and never returned to this browser. User consent uses signed state and PKCE.</span></div>
                </section>
              </>
            )}

            {step === 2 && (
              <>
                <section className="editor-section">
                  <div className="editor-section-heading">
                    <span><ShieldCheck size={17} /></span>
                    <div><small>STEP 3 · ACCESS CONTROL</small><h3>Assigned bundles</h3></div>
                    <strong>{bundleIds.length} selected</strong>
                  </div>
                  <p className="editor-section-description">Only consumers eligible for one of these bundles receive this connection and its tools.</p>
                  <div className="picker-actions">
                    <button type="button" onClick={() => { setBundleIds(bundles.map(bundle => bundle.id)); setDirty(true); }}>Select all</button>
                    <button type="button" onClick={() => { setBundleIds([]); setDirty(true); }}>Clear</button>
                  </div>
                  <div className="bundle-option-list">
                    {bundles.map(bundle => (
                      <label className={`bundle-option${selectedBundles.has(bundle.id) ? ' is-selected' : ''}`} key={bundle.id}>
                        <input type="checkbox" checked={selectedBundles.has(bundle.id)} onChange={() => toggleBundle(bundle.id)} />
                        <span className="connection-check">{selectedBundles.has(bundle.id) && <Check size={13} />}</span>
                        <span className="bundle-option-icon"><BundleGlyph icon={bundle.icon} size={15} /></span>
                        <span><b>{bundle.label}</b><small>{bundle.toolCount} tools · {bundle.backendCount} connections</small></span>
                      </label>
                    ))}
                    {bundles.length === 0 && <div className="picker-empty">Create an access bundle before exposing this connection.</div>}
                  </div>
                  {bundleIds.length === 0 && (
                    <div className="scope-notice inline-warning">
                      <AlertTriangle size={15} />
                      <span>This connection will be unscoped and visible outside bundle restrictions.</span>
                    </div>
                  )}
                </section>

                <section className="editor-section runtime-target-editor">
                  <div className="editor-section-heading">
                    <span><Server size={17} /></span>
                    <div><small>STEP 3 · RUNTIME TARGET</small><h3>Kubernetes execution boundary</h3></div>
                    {executionTargetEnabled && <strong>{parsedExecutionNamespaces.length} namespace{parsedExecutionNamespaces.length === 1 ? '' : 's'}</strong>}
                  </div>
                  <p className="editor-section-description">
                    Publish a bundle-scoped cluster target that solution packs can select without receiving credentials or arbitrary provider configuration.
                  </p>
                  <div className="runtime-target-switch">
                    <label className={executionTargetEnabled ? 'is-selected' : ''}>
                      <input
                        type="checkbox"
                        checked={executionTargetEnabled}
                        disabled={type !== 'mcp'}
                        onChange={event => changeExecutionTarget(setExecutionTargetEnabled, event.target.checked)}
                      />
                      <span className="connection-check">{executionTargetEnabled && <Check size={13} />}</span>
                      <span>
                        <b>Publish as governed Kubernetes target</b>
                        <small>{type === 'mcp' ? 'Available only through the assigned MCP bundles.' : 'Switch this connection to Remote MCP to enable targets.'}</small>
                      </span>
                    </label>
                  </div>
                  {executionTargetEnabled && (
                    <div className="runtime-target-fields">
                      <label className="editor-field">
                        <span>Kubernetes platform <em>required</em></span>
                        <select aria-label="Kubernetes platform" value={targetPlatform} onChange={event => changeExecutionTarget(setTargetPlatform, event.target.value as typeof targetPlatform)}>
                          <option value="kubernetes">Kubernetes / local</option>
                          <option value="aks">Azure Kubernetes Service</option>
                          <option value="eks">Amazon EKS</option>
                          <option value="gke">Google Kubernetes Engine</option>
                          <option value="openshift">Red Hat OpenShift</option>
                        </select>
                      </label>
                      <label className="editor-field">
                        <span>Target ID <em>required</em></span>
                        <input maxLength={128} value={targetId} onChange={event => changeExecutionTarget(setTargetId, event.target.value.toLowerCase())} placeholder="production-kubernetes" />
                      </label>
                      <label className="editor-field">
                        <span>Display name <em>required</em></span>
                        <input maxLength={200} value={targetLabel} onChange={event => changeExecutionTarget(setTargetLabel, event.target.value)} placeholder="Production Kubernetes" />
                      </label>
                      <label className="editor-field">
                        <span>Cluster identity <em>required</em></span>
                        <input maxLength={200} value={targetCluster} onChange={event => changeExecutionTarget(setTargetCluster, event.target.value)} placeholder="eu-central-platform-01" />
                      </label>
                      <label className="editor-field">
                        <span>Environment <em>required</em></span>
                        <input maxLength={120} value={targetEnvironment} onChange={event => changeExecutionTarget(setTargetEnvironment, event.target.value.toLowerCase())} placeholder="production" />
                      </label>
                      <label className="editor-field runtime-target-namespaces">
                        <span>Allowed namespaces <em>required</em></span>
                        <textarea rows={4} value={targetNamespaces} onChange={event => changeExecutionTarget(setTargetNamespaces, event.target.value)} placeholder={'payments\nobservability'} />
                        <small>One namespace per line or comma-separated. This is the hard execution boundary exposed to solution packs.</small>
                      </label>
                      <div className="runtime-target-preview" aria-label="Safe runtime target preview">
                        <div><ShieldCheck size={15} /><span><b>Safe catalog preview</b><small>Only target metadata leaves MCP Fabric. Credentials remain private.</small></span></div>
                        <div className="runtime-target-chips">
                          {parsedExecutionNamespaces.slice(0, 6).map(namespace => (
                            <code key={namespace}>{targetCluster.trim() || 'cluster'} · {namespace}</code>
                          ))}
                          {parsedExecutionNamespaces.length > 6 && <code>+{parsedExecutionNamespaces.length - 6} more</code>}
                          {parsedExecutionNamespaces.length === 0 && <span>Add at least one namespace to publish this target.</span>}
                        </div>
                      </div>
                    </div>
                  )}
                </section>

                <section className="editor-section wizard-review">
                  <div className="editor-section-heading">
                    <span><CheckCircle2 size={17} /></span>
                    <div><small>STEP 3 · REVIEW</small><h3>Verify before exposure</h3></div>
                  </div>
                  <div className="wizard-review-endpoint"><span>{type.toUpperCase()}</span><code>{endpoint}</code></div>
                  <dl>
                    <div><dt>Service identity</dt><dd>{authType === 'none' ? 'No credential' : authType}</dd></div>
                    <div><dt>User identity</dt><dd>{authMode.replace('-', ' ')}</dd></div>
                    <div><dt>Access scope</dt><dd>{bundleIds.length ? `${bundleIds.length} bundle${bundleIds.length === 1 ? '' : 's'}` : 'Unscoped'}</dd></div>
                    <div><dt>Runtime target</dt><dd>{executionTargetEnabled ? `${targetCluster || 'Cluster'} · ${parsedExecutionNamespaces.length} namespace${parsedExecutionNamespaces.length === 1 ? '' : 's'}` : 'Not published'}</dd></div>
                    <div><dt>Desired state</dt><dd>{enabled ? 'Activate after review' : 'Keep disabled'}</dd></div>
                  </dl>
                  <div className="editor-toggle-row single">
                    <label>
                      <input type="checkbox" checked={enabled} onChange={event => change(setEnabled, event.target.checked)} />
                      <span><b>Activate after successful review</b><small>New connections remain disabled until you approve the live result.</small></span>
                    </label>
                  </div>
                  <div className="wizard-verification-sequence">
                    <span><i>1</i>Save configuration</span>
                    <ArrowRight size={12} />
                    <span><i>2</i>Test endpoint</span>
                    <ArrowRight size={12} />
                    <span><i>3</i>{type === 'mcp' ? 'Discover tools' : 'Confirm health'}</span>
                  </div>
                </section>
              </>
            )}

            {step === 3 && (
              <section className="wizard-verification">
                {verificationLabel && (
                  <div className="wizard-progress-state">
                    <LoaderCircle size={25} className="spin" />
                    <div><span className="eyebrow">LIVE VERIFICATION</span><h3>{verificationLabel}…</h3><p>Argus is validating the connection from the server runtime.</p></div>
                  </div>
                )}

                {!verificationLabel && saveResult && (
                  <>
                    <div className={`wizard-result-hero ${testResult?.reachable ? 'is-success' : 'is-warning'}`}>
                      <span>{testResult?.reachable ? <CheckCircle2 size={24} /> : <AlertTriangle size={24} />}</span>
                      <div>
                        <span className="eyebrow">{testResult?.reachable ? 'CONNECTION VERIFIED' : 'CONNECTION SAVED · ACTION REQUIRED'}</span>
                        <h3>{testResult?.reachable ? `${saveResult.connection.name} is reachable` : `${saveResult.connection.name} could not be reached`}</h3>
                        <p>
                          {testResult?.reachable
                            ? `${testResult.latencyMs == null ? 'Endpoint responded' : `Endpoint responded in ${testResult.latencyMs} ms`}${type === 'mcp' ? ` and exposed ${discoveryResult?.toolCount ?? testResult.toolCount ?? 0} capabilities.` : '.'}`
                            : testResult?.error || saveResult.warning || 'Review the endpoint and credentials, then retry.'}
                        </p>
                      </div>
                      <button type="button" disabled={busy} onClick={retryVerification}><RefreshCw size={13} />Retry</button>
                    </div>

                    <div className="wizard-result-grid">
                      <article>
                        <span className="eyebrow">RUNTIME CHECKS</span>
                        <ul className="wizard-check-list">
                          <li className="is-success"><Check size={13} /><span><b>Configuration stored</b><small>Secrets encrypted at rest</small></span></li>
                          <li className={executionTargetEnabled ? 'is-success' : 'is-pending'}>{executionTargetEnabled ? <Check size={13} /> : <CircleDashed size={13} />}<span><b>Runtime target contract</b><small>{executionTargetEnabled ? `${parsedExecutionNamespaces.length} namespace${parsedExecutionNamespaces.length === 1 ? '' : 's'} published through assigned bundles` : 'No execution target published'}</small></span></li>
                          <li className={testResult?.reachable ? 'is-success' : 'is-failed'}>{testResult?.reachable ? <Check size={13} /> : <X size={13} />}<span><b>Endpoint reachable</b><small>{testResult?.latencyMs == null ? 'No latency available' : `${testResult.latencyMs} ms`}</small></span></li>
                          {type === 'mcp' && (
                            <li className={discoveryResult ? 'is-success' : 'is-pending'}>{discoveryResult ? <Check size={13} /> : <CircleDashed size={13} />}<span><b>Capability discovery</b><small>{discoveryResult ? `${discoveryResult.toolCount} tools · ${discoveryResult.trustStatus}` : 'Waiting for reachable MCP server'}</small></span></li>
                          )}
                          <li className={activated ? 'is-success' : 'is-pending'}>{activated ? <Check size={13} /> : <CircleDashed size={13} />}<span><b>Connection activation</b><small>{activated ? 'Enabled in MCP Fabric' : enabled ? 'Awaiting your approval' : 'Configured to remain disabled'}</small></span></li>
                        </ul>
                      </article>

                      <article>
                        <div className="wizard-capability-heading">
                          <div><span className="eyebrow">{type === 'mcp' ? 'DISCOVERED CAPABILITIES' : 'CONNECTION DETAILS'}</span><h3>{type === 'mcp' ? `${discoveryResult?.toolCount ?? 0} live tools` : 'HTTP backend'}</h3></div>
                          {discoveryResult && <span className={`trust-badge trust-${discoveryResult.trustStatus}`}>{discoveryResult.trustStatus}</span>}
                        </div>
                        {type === 'mcp' && discoveryResult?.tools.length ? (
                          <div className="wizard-discovered-tools">
                            {discoveryResult.tools.slice(0, 20).map(tool => (
                              <div key={tool.name}><code>{tool.name}</code><span>{tool.description || 'No description provided'}</span></div>
                            ))}
                            {discoveryResult.tools.length > 20 && <small>+{discoveryResult.tools.length - 20} additional tools</small>}
                          </div>
                        ) : (
                          <div className="wizard-empty-result">
                            {testResult?.reachable ? <CheckCircle2 size={22} /> : <CircleDashed size={22} />}
                            <span>{type === 'mcp' ? 'No live capabilities discovered yet.' : endpoint}</span>
                          </div>
                        )}
                      </article>
                    </div>

                    {testResult?.reachable && !connection && !activated && enabled && (
                      <div className="wizard-activation-gate">
                        <ShieldCheck size={20} />
                        <div><b>Review complete</b><span>Approve the observed catalog and activate this connection for its assigned bundles.</span></div>
                        <button className="button button-primary" type="button" disabled={busy || type === 'mcp' && !discoveryResult} onClick={activateConnection}>
                          <ShieldCheck size={14} />Approve & activate
                        </button>
                      </div>
                    )}

                    {authMode !== 'service-account' && activated && (
                      <div className="wizard-oauth-gate">
                        <LockKeyhole size={20} />
                        <div><b>Connect your user identity</b><span>Start the signed OAuth Authorization Code flow with PKCE. You will return to MCP Fabric afterward.</span></div>
                        <a className="button button-secondary" href={`/connections/connect/${saveResult.connection.id}?returnTo=${encodeURIComponent('/mcp-fabric')}`}>
                          Authorize with provider <ExternalLink size={13} />
                        </a>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </div>

          {(workflowError || error) && (
            <div className="editor-error wizard-error" role="alert">
              <AlertTriangle size={16} /><span>{workflowError || error}</span>
            </div>
          )}

          <footer className="editor-footer connection-wizard-footer">
            <div>
              {onDelete && step < 3 && (
                <button
                  className="button editor-delete"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Connection „${connection?.name}“ löschen? Zugehörige Remote- und dynamische Tools werden entfernt.`)) onDelete();
                  }}
                >
                  <Trash2 size={15} />{deleting ? 'Deleting…' : 'Delete connection'}
                </button>
              )}
              {step > 0 && step < 3 && (
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setStep(current => current - 1); setWorkflowError(null); }}>
                  <ArrowLeft size={14} />Back
                </button>
              )}
            </div>
            <div>
              {step < 3 && <button className="button button-secondary" type="button" disabled={busy} onClick={requestClose}>Cancel</button>}
              {step < 2 && (
                <button className="button button-primary" type="button" disabled={busy} onClick={goNext}>
                  Continue <ArrowRight size={14} />
                </button>
              )}
              {step === 2 && (
                <button className="button button-primary" type="submit" disabled={busy}>
                  {saving ? 'Saving…' : connection ? 'Save & verify' : 'Connect & discover'} <ArrowRight size={14} />
                </button>
              )}
              {step === 3 && !verificationLabel && (
                <button className="button button-primary" type="button" disabled={busy} onClick={requestClose}>
                  {phase === 'complete' || !enabled ? 'Done' : 'Close for now'}
                </button>
              )}
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
}
