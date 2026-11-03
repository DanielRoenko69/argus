import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  deleteAdminApiKey,
  getAdminApiKeys,
  getApiKeyBindingTargets,
  getFabric,
  rotateAdminApiKey,
  saveAdminApiKey,
} from '../api';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/Ui';
import type { AdminApiKey, AdminApiKeyMutation, AdminApiKeySecret, FabricBundle } from '../types';

type KeyAction = { id: number; kind: 'rotate' | 'delete' } | null;

function patterns(value: string): string[] | null {
  const entries = [...new Set(value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean))];
  return entries.length > 0 ? entries : null;
}

function dateTimeLocal(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function ApiKeyEditor({
  apiKey,
  bundles,
  saving,
  error,
  onClose,
  onSave,
}: {
  apiKey: AdminApiKey | null;
  bundles: FabricBundle[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: AdminApiKeyMutation) => void;
}) {
  const [label, setLabel] = useState(apiKey?.label ?? '');
  const [scope, setScope] = useState<AdminApiKeyMutation['scope']>(apiKey?.scope ?? 'mcp');
  const [enabled, setEnabled] = useState(apiKey?.enabled ?? true);
  const [bundleMode, setBundleMode] = useState<'all' | 'selected'>(
    apiKey ? apiKey.allowed_bundles == null ? 'all' : 'selected' : 'selected',
  );
  const [bundleIds, setBundleIds] = useState<number[]>(apiKey?.allowed_bundles ?? []);
  const [allowedTools, setAllowedTools] = useState((apiKey?.allowed_tools ?? []).join('\n'));
  const [deniedTools, setDeniedTools] = useState((apiKey?.denied_tools ?? []).join('\n'));
  const [rateLimit, setRateLimit] = useState(apiKey?.max_requests_per_minute?.toString() ?? '120');
  const [expiresAt, setExpiresAt] = useState(dateTimeLocal(apiKey?.expires_at ?? null));
  const [identity, setIdentity] = useState('');
  const targetsQuery = useQuery({ queryKey: ['api-key-binding-targets'], queryFn: getApiKeyBindingTargets, enabled: !apiKey, retry: false });
  const identityValid = Boolean(apiKey) || identity === 'service' || (
    !targetsQuery.isFetching && !targetsQuery.error && Boolean(targetsQuery.data?.some(user => String(user.id) === identity))
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!identityValid || saving || !label.trim()) return;
    onSave({
      label: label.trim(),
      allowed_bundles: bundleMode === 'all' ? null : bundleIds,
      allowed_tools: patterns(allowedTools),
      denied_tools: patterns(deniedTools),
      max_requests_per_minute: rateLimit ? Number(rateLimit) : null,
      scope,
      enabled,
      acting_as_user_id: apiKey ? apiKey.acting_as_user_id : identity === 'service' ? null : Number(identity),
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    });
  };

  return (
    <div className="api-key-editor-layer" role="presentation">
      <form className="api-key-editor" aria-labelledby="api-key-editor-title" onSubmit={submit}>
        <header>
          <span className="api-key-editor-icon"><KeyRound size={19} /></span>
          <div><span className="eyebrow">TECHNICAL IDENTITY</span><h2 id="api-key-editor-title">{apiKey ? `Edit ${apiKey.label}` : 'Create API key'}</h2><p>Define the resource boundary before generating a credential.</p></div>
          <button type="button" aria-label="Close API key editor" onClick={onClose}><X size={17} /></button>
        </header>

        <div className="api-key-editor-body">
          <section>
            <div className="api-key-section-title"><ShieldCheck size={15} /><span><small>IDENTITY</small><b>Key definition</b></span></div>
            <div className="policy-field-grid">
              <label className="editor-field"><span>Label <em>required</em></span><input required maxLength={128} value={label} onChange={event => setLabel(event.target.value)} placeholder="ci-deployment" /></label>
              <label className="editor-field"><span>Request limit per minute</span><input type="number" min={1} max={100_000} value={rateLimit} onChange={event => setRateLimit(event.target.value)} /></label>
              <label className="editor-field"><span>Scope</span><select value={scope} onChange={event => setScope(event.target.value as AdminApiKeyMutation['scope'])}><option value="mcp">MCP only</option><option value="agents">Agents only</option><option value="both">MCP and agents</option></select></label>
              <label className="editor-field"><span>Expiration</span><input type="datetime-local" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /><small>Leave empty for no automatic expiry.</small></label>
            </div>
            <label className="policy-enabled-toggle api-key-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>{enabled ? 'Key enabled' : 'Key disabled'}</span></label>
            {apiKey ? <div className="api-key-binding-note"><UserRound size={14} /><span>{apiKey.acting_as_user_id == null ? 'Service identity: no user binding.' : `This key acts as user #${apiKey.acting_as_user_id}.`} Editing and rotation preserve this identity. Create a replacement key to change it.</span></div> : <>
              <label className="editor-field"><span>Act as identity <em>required</em></span>
                <select required value={identity} onChange={event => setIdentity(event.target.value)} aria-describedby="api-key-identity-help">
                  <option value="" disabled>Choose an identity…</option>
                  <option value="service">Service identity — no personal SSO</option>
                  {!targetsQuery.error && !targetsQuery.isFetching && targetsQuery.data?.map(user => <option key={user.id} value={String(user.id)}>{user.display_name || user.username} (@{user.username}){user.is_self ? ' — you' : ''}</option>)}
                </select>
              </label>
              <p id="api-key-identity-help" className="policy-help">A user-bound key uses that user's connected backend identity. Bundle scope and user/tool policies still apply. This does not sign in or connect a backend. Service keys cannot satisfy personal SSO requirements. The identity cannot be changed later.</p>
              {targetsQuery.isFetching && <p role="status">Loading eligible user identities…</p>}
              {targetsQuery.error && <div role="alert">User identities could not be loaded. Personal SSO key creation is unavailable. <button type="button" onClick={() => { void targetsQuery.refetch(); }}>Retry user identities</button></div>}
            </>}
          </section>

          <section>
            <div className="api-key-section-title"><Boxes size={15} /><span><small>RESOURCE SCOPE</small><b>Allowed bundles</b></span></div>
            <div className="policy-mode-switch">
              <button type="button" className={bundleMode === 'selected' ? 'is-active' : ''} onClick={() => setBundleMode('selected')}><LockKeyhole size={14} /><span><b>Selected bundles</b><small>Least-privilege boundary</small></span></button>
              <button type="button" className={bundleMode === 'all' ? 'is-active' : ''} onClick={() => setBundleMode('all')}><Boxes size={14} /><span><b>All bundles</b><small>Includes future bundles</small></span></button>
            </div>
            {bundleMode === 'all' ? <div className="policy-scope-warning"><AlertTriangle size={14} /><span>This key will inherit access to bundles created in the future.</span></div> : (
              <div className="api-key-bundle-grid">
                {bundles.map(bundle => {
                  const checked = bundleIds.includes(bundle.id);
                  return <label className={checked ? 'is-selected' : ''} key={bundle.id}><input type="checkbox" checked={checked} onChange={() => setBundleIds(current => checked ? current.filter(id => id !== bundle.id) : [...current, bundle.id])} /><span className="connection-check">{checked && <Check size={12} />}</span><span aria-hidden="true">{bundle.icon || '◈'}</span><span><b>{bundle.label}</b><small>{bundle.toolCount} tools</small></span></label>;
                })}
                {bundles.length === 0 && <small>No bundles are currently available.</small>}
              </div>
            )}
          </section>

          <section>
            <div className="api-key-section-title"><LockKeyhole size={15} /><span><small>CAPABILITY FILTER</small><b>Tool patterns</b></span></div>
            <p className="policy-help">One glob per line. Deny rules win. Empty allow rules permit every tool inside the bundle boundary.</p>
            <div className="policy-field-grid">
              <label className="editor-field"><span>Allow patterns</span><textarea rows={5} value={allowedTools} onChange={event => setAllowedTools(event.target.value)} placeholder={'github_*\nk8s_get_*'} /></label>
              <label className="editor-field"><span>Deny patterns</span><textarea rows={5} value={deniedTools} onChange={event => setDeniedTools(event.target.value)} placeholder={'*_delete\n*_destroy'} /></label>
            </div>
          </section>
        </div>

        {error && <div className="editor-error" role="alert"><AlertTriangle size={15} />{error}</div>}
        <footer><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving || !label.trim() || !identityValid}>{saving ? 'Saving…' : apiKey ? 'Save key policy' : 'Generate API key'}</button></footer>
      </form>
    </div>
  );
}

function SecretDialog({ secret, onClose }: { secret: AdminApiKeySecret; onClose: () => void }) {
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret.api_key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="api-key-editor-layer" role="presentation">
      <section className="api-key-secret-dialog" role="dialog" aria-modal="true" aria-labelledby="api-key-secret-title">
        <span className="api-key-secret-icon"><KeyRound size={23} /></span>
        <span className="eyebrow">DISPLAYED ONCE</span>
        <h2 id="api-key-secret-title">Store {secret.label} securely</h2>
        <p>Argus stores only the SHA-256 hash. This credential cannot be retrieved again.</p>
        <div className="api-key-secret-value"><code>{secret.api_key}</code><button type="button" onClick={copy}><Clipboard size={14} />{copied ? 'Copied' : 'Copy'}</button></div>
        <label className="api-key-stored-check"><input type="checkbox" checked={stored} onChange={event => setStored(event.target.checked)} /><span className="connection-check">{stored && <Check size={12} />}</span><span>I stored this key in an approved secret manager.</span></label>
        <button className="button button-primary" type="button" disabled={!stored} onClick={onClose}>Close one-time secret</button>
      </section>
    </div>
  );
}

export function ApiKeysPage() {
  const [editorTarget, setEditorTarget] = useState<'new' | number | null>(null);
  const [pendingAction, setPendingAction] = useState<KeyAction>(null);
  const [secret, setSecret] = useState<AdminApiKeySecret | null>(null);
  const [notice, setNotice] = useState('');
  const queryClient = useQueryClient();
  const keysQuery = useQuery({ queryKey: ['admin-api-keys'], queryFn: getAdminApiKeys, staleTime: 10_000 });
  const fabricQuery = useQuery({ queryKey: ['mcp-fabric'], queryFn: getFabric, staleTime: 15_000 });
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin-api-keys'] }),
    queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
  ]);
  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: AdminApiKeyMutation; id?: number }) => saveAdminApiKey(input, id),
    onSuccess: async result => {
      setEditorTarget(null);
      if ('api_key' in result) setSecret(result);
      else setNotice(`API key “${result.label}” updated.`);
      await refresh();
    },
  });
  const rotateMutation = useMutation({
    mutationFn: (id: number) => rotateAdminApiKey(id),
    onSuccess: async result => {
      setPendingAction(null);
      setSecret(result);
      await refresh();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteAdminApiKey(id),
    onSuccess: async () => {
      setPendingAction(null);
      setNotice('API key permanently revoked and deleted.');
      await refresh();
    },
  });

  if (keysQuery.isLoading || fabricQuery.isLoading) return <LoadingState label="Loading technical identities…" />;
  if (keysQuery.error) return <ErrorState error={keysQuery.error} />;
  if (fabricQuery.error) return <ErrorState error={fabricQuery.error} />;

  const keys = keysQuery.data ?? [];
  const bundles = fabricQuery.data?.bundles ?? [];
  const now = Date.now();
  const active = keys.filter(key => key.enabled && (!key.expires_at || new Date(key.expires_at).getTime() > now)).length;
  const expired = keys.filter(key => key.expires_at && new Date(key.expires_at).getTime() <= now).length;
  const unrestricted = keys.filter(key => key.allowed_bundles == null).length;
  const editorKey = typeof editorTarget === 'number' ? keys.find(key => key.id === editorTarget) ?? null : null;
  const actionKey = pendingAction ? keys.find(key => key.id === pendingAction.id) ?? null : null;
  const mutationError = saveMutation.error?.message ?? rotateMutation.error?.message ?? deleteMutation.error?.message ?? null;

  return (
    <>
      <a className="back-link" href="/settings"><ArrowLeft size={14} />Back to settings</a>
      <PageHeader eyebrow="TECHNICAL IDENTITIES" title="API Keys" description="Issue scoped credentials for MCP clients, agents and external automations." actions={<button className="button button-primary" type="button" onClick={() => { saveMutation.reset(); setEditorTarget('new'); }}><Plus size={15} />Create API key</button>} />

      {notice && <div className="connection-notice is-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}
      {mutationError && !editorTarget && <div className="connection-notice is-error" role="alert"><AlertTriangle size={16} /><span>{mutationError}</span></div>}

      <section className="metric-grid api-key-metrics" aria-label="API key summary">
        <article className="metric-card"><span className="metric-icon violet"><KeyRound size={17} /></span><div><span>API keys</span><strong>{keys.length}</strong><small>managed credentials</small></div></article>
        <article className="metric-card"><span className="metric-icon teal"><CheckCircle2 size={17} /></span><div><span>Active</span><strong>{active}</strong><small>enabled and valid</small></div></article>
        <article className="metric-card"><span className="metric-icon amber"><Clock3 size={17} /></span><div><span>Expired</span><strong>{expired}</strong><small>automatic denial</small></div></article>
        <article className="metric-card"><span className="metric-icon blue"><Boxes size={17} /></span><div><span>All bundles</span><strong>{unrestricted}</strong><small>wide resource scope</small></div></article>
      </section>

      {keys.length > 0 ? <section className="api-key-grid" aria-label="API keys">
        {keys.map(key => {
          const isExpired = Boolean(key.expires_at && new Date(key.expires_at).getTime() <= now);
          const isConfirming = pendingAction?.id === key.id;
          const selectedBundles = key.allowed_bundles == null ? [] : bundles.filter(bundle => key.allowed_bundles!.includes(bundle.id));
          return <article className={`api-key-card${!key.enabled || isExpired ? ' is-inactive' : ''}`} key={key.id}>
            <header><span className="api-key-card-icon"><KeyRound size={17} /></span><span><small>{key.scope.toUpperCase()} SCOPE</small><h2>{key.label}</h2></span><span className={`api-key-state ${isExpired ? 'is-expired' : key.enabled ? 'is-active' : 'is-disabled'}`}>{isExpired ? 'Expired' : key.enabled ? 'Active' : 'Disabled'}</span></header>
            <code className="api-key-preview">{key.key_prefix}••••{key.key_suffix ?? ''}</code>
            <div className="api-key-facts"><span><small>Bundles</small><b>{key.allowed_bundles == null ? 'All bundles' : `${key.allowed_bundles.length} selected`}</b></span><span><small>Rate limit</small><b>{key.max_requests_per_minute ?? 'Default'} / min</b></span><span><small>Expires</small><b>{formatDate(key.expires_at)}</b></span><span><small>Last used</small><b>{formatDate(key.last_used_at)}</b></span></div>
            <div className="api-key-card-badges">{selectedBundles.slice(0, 3).map(bundle => <span key={bundle.id}>{bundle.icon || '◈'} {bundle.label}</span>)}{selectedBundles.length > 3 && <span>+{selectedBundles.length - 3}</span>}{key.allowed_bundles?.length === 0 && <span className="is-denied">No bundles</span>}{key.acting_as_user_id != null && <span><UserRound size={10} />User-bound</span>}{key.composite_id != null && <span><ShieldCheck size={10} />Composite policy</span>}</div>
            {isConfirming && actionKey ? <div className={`api-key-action-confirm is-${pendingAction.kind}`} role="alert"><AlertTriangle size={15} /><span><b>{pendingAction.kind === 'rotate' ? `Rotate ${actionKey.label}?` : `Delete ${actionKey.label}?`}</b><small>{pendingAction.kind === 'rotate' ? 'The current credential stops working immediately.' : 'This action permanently revokes the credential.'}</small></span><button type="button" onClick={() => setPendingAction(null)}>Cancel</button><button className="is-danger" type="button" disabled={rotateMutation.isPending || deleteMutation.isPending} onClick={() => pendingAction.kind === 'rotate' ? rotateMutation.mutate(key.id) : deleteMutation.mutate(key.id)}>{pendingAction.kind === 'rotate' ? 'Confirm rotation' : 'Confirm deletion'}</button></div> : <footer><button type="button" onClick={() => { saveMutation.reset(); setEditorTarget(key.id); }}><Pencil size={12} />Edit</button><button type="button" onClick={() => { rotateMutation.reset(); setPendingAction({ id: key.id, kind: 'rotate' }); }}><RefreshCw size={12} />Rotate</button><button className="is-danger" type="button" onClick={() => { deleteMutation.reset(); setPendingAction({ id: key.id, kind: 'delete' }); }}><Trash2 size={12} />Delete</button></footer>}
          </article>;
        })}
      </section> : <section className="panel"><EmptyState title="No API keys" description="Create a least-privilege key for an MCP client, agent runtime or automation." /></section>}

      {editorTarget && <ApiKeyEditor key={String(editorTarget)} apiKey={editorKey} bundles={bundles} saving={saveMutation.isPending} error={saveMutation.error?.message ?? null} onClose={() => setEditorTarget(null)} onSave={input => saveMutation.mutate({ input, ...(typeof editorTarget === 'number' ? { id: editorTarget } : {}) })} />}
      {secret && <SecretDialog secret={secret} onClose={() => { setSecret(null); setNotice(`API key “${secret.label}” is ready.`); }} />}
    </>
  );
}
