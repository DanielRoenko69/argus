import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Check,
  FlaskConical,
  KeyRound,
  Link2,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Trash2,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import { isPlatformAdminRole } from '../access';
import {
  deleteRuntimePolicy,
  getOverview,
  getRuntimeControls,
  saveRuntimePolicy,
  testRuntimePolicy,
} from '../api';
import { ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import type {
  RuntimePolicyMutation,
  RuntimePolicyRecord,
  RuntimePolicyTestResult,
} from '../types';

interface PolicyDraft {
  name: string;
  description: string;
  webhookUrl: string;
  timeoutMs: number;
  patterns: string;
  enabled: boolean;
  onFailure: 'allow' | 'deny';
  secretAction: 'keep' | 'replace' | 'clear';
  hmacSecret: string;
}

function draftFor(policy: RuntimePolicyRecord | null): PolicyDraft {
  return policy ? {
    name: policy.name,
    description: policy.description,
    webhookUrl: policy.webhookUrl,
    timeoutMs: policy.timeoutMs,
    patterns: policy.toolPatterns.join('\n'),
    enabled: policy.enabled,
    onFailure: policy.onFailure,
    secretAction: 'keep',
    hmacSecret: '',
  } : {
    name: '',
    description: '',
    webhookUrl: '',
    timeoutMs: 3000,
    patterns: '',
    enabled: true,
    onFailure: 'deny',
    secretAction: 'replace',
    hmacSecret: '',
  };
}

function parsePatterns(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map(pattern => pattern.trim()).filter(Boolean))];
}

function mutationFor(draft: PolicyDraft, create: boolean): RuntimePolicyMutation {
  return {
    ...(create ? { name: draft.name.trim() } : {}),
    description: draft.description.trim(),
    webhookUrl: draft.webhookUrl.trim(),
    timeoutMs: Number(draft.timeoutMs),
    toolPatterns: parsePatterns(draft.patterns),
    enabled: draft.enabled,
    onFailure: draft.onFailure,
    secretAction: draft.secretAction,
    ...(draft.secretAction === 'replace' ? { hmacSecret: draft.hmacSecret } : {}),
  };
}

function decisionLabel(result: RuntimePolicyTestResult): string {
  if (result.decision === 'allow') return 'Request allowed';
  if (result.decision === 'deny') return 'Request denied';
  if (result.decision === 'unreachable') return 'Endpoint unreachable';
  return 'Invalid policy response';
}

export function RuntimeControlsPage() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, staleTime: 15_000 });
  const catalog = useQuery({ queryKey: ['runtime-controls'], queryFn: getRuntimeControls });
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<{ id: number | null; draft: PolicyDraft } | null>(null);
  const [testTarget, setTestTarget] = useState<RuntimePolicyRecord | null>(null);
  const [testTool, setTestTool] = useState('workspace_read_file');
  const [testArgs, setTestArgs] = useState('{\n  "path": "README.md"\n}');
  const [testResult, setTestResult] = useState<RuntimePolicyTestResult | null>(null);
  const [testInputError, setTestInputError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RuntimePolicyRecord | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: ({ id, input }: { id: number | null; input: RuntimePolicyMutation }) => saveRuntimePolicy(input, id ?? undefined),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['runtime-controls'] });
      setEditor(null);
      setNotice(variables.id == null ? 'Runtime policy created.' : 'Runtime policy updated.');
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteRuntimePolicy(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['runtime-controls'] });
      setDeleteTarget(null);
      setDeleteConfirmation('');
      setNotice('Runtime policy deleted.');
    },
  });
  const toggle = useMutation({
    mutationFn: (policy: RuntimePolicyRecord) => saveRuntimePolicy({ enabled: !policy.enabled }, policy.id),
    onSuccess: async policy => {
      await queryClient.invalidateQueries({ queryKey: ['runtime-controls'] });
      setNotice(policy.enabled ? 'Runtime policy enabled.' : 'Runtime policy disabled.');
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      if (!testTarget) throw new Error('Select a runtime policy');
      let args: unknown;
      try { args = JSON.parse(testArgs); } catch { throw new Error('Test arguments must be valid JSON'); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Test arguments must be a JSON object');
      return testRuntimePolicy(testTarget.id, testTool.trim(), args as Record<string, unknown>);
    },
    onSuccess: result => { setTestResult(result); setTestInputError(''); },
    onError: error => { setTestResult(null); setTestInputError(error instanceof Error ? error.message : 'Policy test failed'); },
  });

  const visiblePolicies = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (catalog.data?.policies ?? []).filter(policy => !needle || [
      policy.name, policy.description, policy.webhookUrl, ...policy.toolPatterns,
    ].join(' ').toLowerCase().includes(needle));
  }, [catalog.data?.policies, search]);

  if (overview.isLoading || catalog.isLoading) return <LoadingState label="Loading runtime controls…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  if (!isPlatformAdminRole(overview.data?.user.role)) return <ErrorState error={new Error('Platform administrator access required.')} />;
  if (catalog.error) return <ErrorState error={catalog.error} />;
  if (!catalog.data) return null;

  const activePolicies = catalog.data.policies.filter(policy => policy.enabled).length;
  const failClosed = catalog.data.policies.filter(policy => policy.enabled && policy.onFailure === 'deny').length;
  const signed = catalog.data.policies.filter(policy => policy.hasHmacSecret).length;
  const updateDraft = <K extends keyof PolicyDraft>(key: K, value: PolicyDraft[K]) => setEditor(current => current
    ? { ...current, draft: { ...current.draft, [key]: value } }
    : current);
  const openTest = (policy: RuntimePolicyRecord) => {
    setTestTarget(policy);
    setTestResult(null);
    setTestInputError('');
  };

  return (
    <>
      <PageHeader
        eyebrow="GOVERN · EXECUTION"
        title="Execution policies"
        description="Advanced platform-wide policies enforced before direct MCP calls, agents and automated workflows."
        actions={<button className="button button-primary" type="button" onClick={() => setEditor({ id: null, draft: draftFor(null) })}><Plus size={15} />Add external policy</button>}
      />

      <section className="runtime-posture" role="status">
        <span><ShieldCheck size={19} /></span>
        <div><b>Shared enforcement boundary active</b><p>Built-in safeguards and external policy decisions run in priority order before tool execution. Blocks are written to immutable audit evidence.</p></div>
        <em><i />MCP · Agents · Workflows</em>
      </section>
      {notice && <div className="console-notice is-success" role="status"><Check size={14} />{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={13} /></button></div>}

      <section className="runtime-metrics" aria-label="Runtime control summary">
        <article><span className="metric-icon violet"><Zap size={17} /></span><div><small>Hook chain</small><strong>{catalog.data.hooks.length}</strong><em>ordered controls</em></div></article>
        <article><span className="metric-icon teal"><Activity size={17} /></span><div><small>External active</small><strong>{activePolicies}</strong><em>pre-execution endpoints</em></div></article>
        <article><span className="metric-icon amber"><ShieldAlert size={17} /></span><div><small>Fail closed</small><strong>{failClosed}</strong><em>active policies</em></div></article>
        <article><span className="metric-icon blue"><KeyRound size={17} /></span><div><small>Signed</small><strong>{signed}</strong><em>HMAC-protected endpoints</em></div></article>
      </section>

      <section className="runtime-chain panel">
        <div className="panel-heading"><div><span className="eyebrow">ENFORCEMENT ORDER</span><h2>Pre-execution chain</h2></div><small>Lower priority executes first · first block wins</small></div>
        <div className="runtime-chain-track">
          {catalog.data.hooks.map((hook, index) => (
            <div className={`runtime-hook ${hook.kind}`} key={`${hook.name}-${hook.priority}`} title={hook.description}>
              <span>{hook.priority}</span><b>{hook.name.replace(/-/g, ' ')}</b><small>{hook.kind === 'external' ? 'Managed policies' : 'Built in'}</small>
              {index < catalog.data.hooks.length - 1 && <i aria-hidden="true" />}
            </div>
          ))}
        </div>
      </section>

      <div className="runtime-toolbar">
        <label className="search-field"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Policy, endpoint or tool pattern" /></label>
        <span><LockKeyhole size={13} />Secrets stay encrypted and are never returned to the browser</span>
      </div>

      {visiblePolicies.length > 0 ? (
        <div className="runtime-policy-grid">
          {visiblePolicies.map(policy => (
            <article className={`runtime-policy-card${policy.enabled ? '' : ' is-disabled'}`} key={policy.id}>
              <header>
                <span><Webhook size={17} /></span>
                <div><small>EXTERNAL POLICY</small><h2>{policy.name}</h2></div>
                <em className={policy.enabled ? 'is-active' : ''}><i />{policy.enabled ? 'Active' : 'Disabled'}</em>
              </header>
              <p>{policy.description || 'No description provided.'}</p>
              <div className="runtime-endpoint"><Link2 size={13} /><code>{policy.webhookUrl}</code></div>
              <section><span>Tool scope</span><div>{policy.toolPatterns.length ? policy.toolPatterns.map(pattern => <code key={pattern}>{pattern}</code>) : <em>All tools</em>}</div></section>
              <dl>
                <div><dt><Timer size={12} />Timeout</dt><dd>{policy.timeoutMs} ms</dd></div>
                <div><dt><ShieldAlert size={12} />Failure</dt><dd className={policy.onFailure === 'deny' ? 'is-closed' : 'is-open'}>{policy.onFailure === 'deny' ? 'Deny · closed' : 'Allow · open'}</dd></div>
                <div><dt><KeyRound size={12} />Signature</dt><dd>{policy.hasHmacSecret ? 'HMAC SHA-256' : 'Unsigned'}</dd></div>
                <div><dt>Updated</dt><dd>{timeAgo(policy.updatedAt)}</dd></div>
              </dl>
              <footer>
                <button type="button" onClick={() => openTest(policy)}><FlaskConical size={13} />Test</button>
                <button type="button" onClick={() => setEditor({ id: policy.id, draft: draftFor(policy) })}><Pencil size={13} />Edit</button>
                <button type="button" disabled={toggle.isPending} onClick={() => toggle.mutate(policy)}><Zap size={13} />{policy.enabled ? 'Disable' : 'Enable'}</button>
                <button className="is-danger" type="button" onClick={() => { setDeleteTarget(policy); setDeleteConfirmation(''); }}><Trash2 size={13} />Delete</button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel runtime-empty"><Webhook size={25} /><h2>{catalog.data.policies.length ? 'No policies match this filter' : 'No external policies yet'}</h2><p>{catalog.data.policies.length ? 'Try a different search.' : 'The built-in safeguards remain active. Add a webhook policy when an external decision service should participate.'}</p></section>
      )}

      {editor && (
        <div className="runtime-layer" role="presentation" onMouseDown={() => setEditor(null)}>
          <section className="runtime-editor" role="dialog" aria-modal="true" aria-label={editor.id == null ? 'Create runtime policy' : `Edit ${editor.draft.name}`} onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">EXTERNAL PRE-EXECUTION POLICY</span><h2>{editor.id == null ? 'Add runtime policy' : `Edit ${editor.draft.name}`}</h2></div><button type="button" aria-label="Close policy editor" onClick={() => setEditor(null)}><X size={17} /></button></header>
            <form onSubmit={event => { event.preventDefault(); save.mutate({ id: editor.id, input: mutationFor(editor.draft, editor.id == null) }); }}>
              <div className="runtime-form-grid">
                <label><span>Name</span><input aria-label="Policy name" value={editor.draft.name} readOnly={editor.id != null} required pattern="[a-z0-9_-]+" maxLength={128} onChange={event => updateDraft('name', event.target.value)} /><small>Immutable lowercase runtime identifier.</small></label>
                <label><span>Timeout</span><div className="runtime-input-unit"><input aria-label="Policy timeout" type="number" min={catalog.data.limits.minTimeoutMs} max={catalog.data.limits.maxTimeoutMs} value={editor.draft.timeoutMs} onChange={event => updateDraft('timeoutMs', Number(event.target.value))} /><em>ms</em></div><small>100–30,000 ms; latency is added before every matching call.</small></label>
                <label className="is-wide"><span>Description</span><input aria-label="Policy description" value={editor.draft.description} maxLength={1000} onChange={event => updateDraft('description', event.target.value)} /></label>
                <label className="is-wide"><span>Webhook URL</span><input aria-label="Webhook URL" type="url" value={editor.draft.webhookUrl} required placeholder="https://policy.example.com/v1/decide" maxLength={2048} onChange={event => updateDraft('webhookUrl', event.target.value)} /><small>Validated against SSRF, DNS rebinding and the configured egress allowlist on every dispatch.</small></label>
                <label className="is-wide"><span>Tool patterns</span><textarea aria-label="Tool patterns" rows={4} value={editor.draft.patterns} placeholder={'workspace_*\nk8s_%\nterraform_plan'} onChange={event => updateDraft('patterns', event.target.value)} /><small>One pattern per line. <code>*</code> and <code>%</code> are wildcards; empty matches all tools.</small></label>
                <fieldset className="runtime-failure"><legend>Failure behavior</legend><label className={editor.draft.onFailure === 'deny' ? 'is-selected' : ''}><input type="radio" name="failure" checked={editor.draft.onFailure === 'deny'} onChange={() => updateDraft('onFailure', 'deny')} /><ShieldCheck size={15} /><span><b>Deny · fail closed</b><small>Recommended for governance-critical decisions.</small></span></label><label className={editor.draft.onFailure === 'allow' ? 'is-selected' : ''}><input type="radio" name="failure" checked={editor.draft.onFailure === 'allow'} onChange={() => updateDraft('onFailure', 'allow')} /><Activity size={15} /><span><b>Allow · fail open</b><small>Preserves availability if the policy endpoint fails.</small></span></label></fieldset>
                <fieldset className="runtime-secret"><legend>HMAC secret</legend><div className="runtime-secret-tabs">{(['keep', 'replace', 'clear'] as const).filter(action => editor.id != null || action !== 'keep').map(action => <button className={editor.draft.secretAction === action ? 'is-active' : ''} type="button" key={action} onClick={() => updateDraft('secretAction', action)}>{action === 'keep' ? 'Keep current' : action === 'replace' ? 'Set / replace' : 'No signature'}</button>)}</div>{editor.draft.secretAction === 'replace' ? <input aria-label="HMAC secret" type="password" autoComplete="new-password" minLength={1} maxLength={4096} required value={editor.draft.hmacSecret} onChange={event => updateDraft('hmacSecret', event.target.value)} placeholder="Enter a new shared secret" /> : <p>{editor.draft.secretAction === 'keep' ? 'The existing encrypted secret remains unchanged.' : 'Requests will be sent without X-Argus-Signature.'}</p>}</fieldset>
                <label className="runtime-enable"><input aria-label="Runtime policy enabled" type="checkbox" checked={editor.draft.enabled} onChange={event => updateDraft('enabled', event.target.checked)} /><span><b>Policy enabled</b><small>Disabled policies remain configured but leave the execution chain.</small></span></label>
              </div>
              {save.error && <p className="runtime-form-error" role="alert">{save.error instanceof Error ? save.error.message : 'Runtime policy could not be saved.'}</p>}
              <footer><button className="button button-secondary" type="button" onClick={() => setEditor(null)}>Cancel</button><button className="button button-primary" type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : editor.id == null ? 'Create policy' : 'Save changes'}</button></footer>
            </form>
          </section>
        </div>
      )}

      {testTarget && (
        <div className="runtime-layer" role="presentation" onMouseDown={() => setTestTarget(null)}>
          <section className="runtime-test" role="dialog" aria-modal="true" aria-label={`Test ${testTarget.name}`} onMouseDown={event => event.stopPropagation()}>
            <header><div><span className="eyebrow">SIGNED DRY RUN</span><h2>Test {testTarget.name}</h2></div><button type="button" aria-label="Close policy test" onClick={() => setTestTarget(null)}><X size={17} /></button></header>
            <div className="runtime-test-note"><FlaskConical size={16} /><p><b>The real endpoint is called</b><span>The request carries <code>X-Argus-Test: true</code>, uses the stored HMAC secret and does not execute the selected tool.</span></p></div>
            <label><span>Tool name</span><input aria-label="Test tool name" value={testTool} maxLength={256} onChange={event => setTestTool(event.target.value)} /></label>
            <label><span>Arguments · JSON object</span><textarea aria-label="Test arguments" rows={8} value={testArgs} onChange={event => setTestArgs(event.target.value)} /></label>
            {(testInputError || test.error) && <p className="runtime-form-error" role="alert">{testInputError || (test.error instanceof Error ? test.error.message : 'Policy test failed')}</p>}
            {testResult && <section className={`runtime-test-result decision-${testResult.decision}`}><span>{testResult.decision === 'allow' ? <Check size={18} /> : <ShieldAlert size={18} />}</span><div><b>{decisionLabel(testResult)}</b><p>{testResult.reason || `HTTP ${testResult.status ?? '—'} · ${testResult.latencyMs} ms`}</p><small>{testResult.signed ? 'HMAC signed' : 'Unsigned'} · {testResult.latencyMs} ms{testResult.status ? ` · HTTP ${testResult.status}` : ''}</small></div>{testResult.responsePreview && <pre>{testResult.responsePreview}</pre>}</section>}
            <footer><button className="button button-secondary" type="button" onClick={() => setTestTarget(null)}>Close</button><button className="button button-primary" type="button" disabled={test.isPending || !testTool.trim()} onClick={() => test.mutate()}><FlaskConical size={14} />{test.isPending ? 'Calling endpoint…' : 'Run policy test'}</button></footer>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="runtime-layer" role="presentation" onMouseDown={() => setDeleteTarget(null)}>
          <section className="runtime-delete" role="alertdialog" aria-modal="true" aria-label={`Delete ${deleteTarget.name}`} onMouseDown={event => event.stopPropagation()}>
            <span><Trash2 size={19} /></span><div><h2>Delete {deleteTarget.name}?</h2><p>The endpoint leaves the shared execution chain immediately. Built-in safeguards remain active.</p></div>
            <label><span>Type <b>{deleteTarget.name}</b> to confirm</span><input aria-label="Confirm policy name" autoFocus value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} /></label>
            {remove.error && <p className="runtime-form-error" role="alert">{remove.error instanceof Error ? remove.error.message : 'Runtime policy could not be deleted.'}</p>}
            <footer><button className="button button-secondary" type="button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="button button-danger" type="button" disabled={deleteConfirmation !== deleteTarget.name || remove.isPending} onClick={() => remove.mutate(deleteTarget.id)}>{remove.isPending ? 'Deleting…' : 'Delete policy'}</button></footer>
          </section>
        </div>
      )}
    </>
  );
}
