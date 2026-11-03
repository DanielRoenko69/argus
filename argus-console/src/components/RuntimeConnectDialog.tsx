import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, ExternalLink, KeyRound, Loader2, ShieldCheck, X, XCircle } from 'lucide-react';
import {
  cancelRuntimeAuthSession,
  getClaudeRuntimeStatus,
  getCodexRuntimeStatus,
  getRuntimeAuthSession,
  startRuntimeAuthSession,
  submitRuntimeAuthCode,
} from '../api';
import type { AgentRuntimeProfile, CodexRuntimeStatus, RuntimeAuthProvider, RuntimeAuthSession } from '../types';

const TERMINAL_STATES = new Set<RuntimeAuthSession['state']>(['completed', 'failed', 'canceled', 'expired']);

function runtimeProvider(profile: AgentRuntimeProfile): RuntimeAuthProvider {
  return profile.runtime_type === 'codex' ? 'codex' : 'claude-code';
}

export function RuntimeConnectDialog({ profile, onClose }: { profile: AgentRuntimeProfile; onClose: () => void }) {
  const provider = runtimeProvider(profile);
  const queryClient = useQueryClient();
  const [session, setSession] = useState<RuntimeAuthSession | null>(null);
  const [code, setCode] = useState('');
  const [sso, setSso] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pollError, setPollError] = useState('');
  const statusQuery = useQuery<CodexRuntimeStatus>({
    queryKey: ['runtime-status', provider],
    queryFn: provider === 'codex' ? getCodexRuntimeStatus : getClaudeRuntimeStatus,
    staleTime: 2_000,
  });
  const start = useMutation({
    mutationFn: () => startRuntimeAuthSession(provider, provider === 'claude-code' ? { sso } : {}),
    onSuccess: next => { setSession(next); setPollError(''); },
  });
  const submit = useMutation({
    mutationFn: () => submitRuntimeAuthCode(provider, session!.id, code),
    onSuccess: next => { setSession(next); setCode(''); setPollError(''); },
  });
  const cancel = useMutation({
    mutationFn: () => cancelRuntimeAuthSession(provider, session!.id),
    onSuccess: next => setSession(next),
  });

  useEffect(() => {
    if (!session || TERMINAL_STATES.has(session.state)) return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await getRuntimeAuthSession(provider, session.id);
        if (!disposed) { setSession(next); setPollError(''); }
      } catch (error) {
        if (!disposed) setPollError(error instanceof Error ? error.message : 'Could not refresh sign-in status.');
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1_500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [provider, session?.id, session?.state]);

  useEffect(() => {
    if (session?.state !== 'completed') return;
    void queryClient.invalidateQueries({ queryKey: ['runtime-status', provider] });
    void queryClient.invalidateQueries({ queryKey: ['agent-runtime-profiles'] });
  }, [provider, queryClient, session?.state]);

  const status = statusQuery.data;
  const connected = Boolean(status?.enabled && status.authenticated);
  const busy = start.isPending || submit.isPending || cancel.isPending;
  const error = start.error ?? submit.error ?? cancel.error;
  const copyCode = async () => {
    if (!session?.userCode) return;
    await navigator.clipboard?.writeText(session.userCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (code.trim()) submit.mutate();
  };

  return <div className="llm-editor-layer runtime-connect-layer" role="presentation">
    <section className="runtime-connect-dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-connect-title">
      <header>
        <span className="llm-editor-icon"><KeyRound size={20} /></span>
        <div><span className="eyebrow">SECURE RUNTIME SIGN-IN</span><h2 id="runtime-connect-title">Connect {profile.label}</h2><p>Follow the provider sign-in flow here. No terminal commands or API-token copy and paste are required.</p></div>
        <button type="button" aria-label="Close runtime connection" onClick={onClose}><X size={18} /></button>
      </header>

      <div className="runtime-connect-body">
        <div className={`runtime-connect-status${connected ? ' is-connected' : ''}`}>
          {statusQuery.isLoading ? <Loader2 className="spin" size={18} /> : connected ? <CheckCircle2 size={18} /> : <KeyRound size={18} />}
          <span><b>{statusQuery.isLoading ? 'Checking runtime…' : connected ? 'Runtime connected' : status?.enabled === false ? 'Runtime disabled' : 'Sign-in required'}</b><small>{connected ? `Authenticated through ${status?.authMethod || profile.auth_mode}.` : status?.enabled === false ? 'Enable this runtime in the local deployment configuration first.' : 'Credentials remain exclusively in the protected runtime credential store.'}</small></span>
        </div>

        {!session && <section className="runtime-connect-step">
          <span className="runtime-connect-number">1</span>
          <div><h3>{connected ? 'Start a fresh sign-in' : 'Start secure sign-in'}</h3><p>{provider === 'codex' ? 'Argus starts the official Codex device authorization flow and displays its one-time code here.' : 'Argus starts the official Claude Code browser flow. The returned authorization code is passed directly to the waiting CLI process.'}</p>
            {provider === 'claude-code' && <label className="runtime-connect-sso"><input type="checkbox" checked={sso} onChange={event => setSso(event.target.checked)} /><span>Use organization SSO</span></label>}
            <button className="button button-primary" type="button" disabled={busy || statusQuery.isLoading || status?.enabled === false} onClick={() => start.mutate()}>{start.isPending ? <><Loader2 className="spin" size={14} />Starting…</> : connected ? 'Reconnect runtime' : 'Start sign-in'}</button>
          </div>
        </section>}

        {session && <>
          <section className="runtime-connect-step">
            <span className="runtime-connect-number">1</span>
            <div><h3>Open the provider sign-in</h3><p>{session.message}</p>
              {session.verificationUri
                ? <a className="button button-primary" href={session.verificationUri} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open sign-in page</a>
                : !TERMINAL_STATES.has(session.state) && <span className="runtime-connect-wait"><Loader2 className="spin" size={14} />Waiting for the official CLI…</span>}
            </div>
          </section>

          {session.userCode && <section className="runtime-connect-step">
            <span className="runtime-connect-number">2</span>
            <div><h3>Enter this one-time code</h3><div className="runtime-connect-code"><code>{session.userCode}</code><button type="button" aria-label="Copy one-time code" onClick={() => void copyCode()}>{copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy'}</button></div><p>The code expires at {new Date(session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p></div>
          </section>}

          {provider === 'claude-code' && session.requiresCodeSubmission && !TERMINAL_STATES.has(session.state) && <form className="runtime-connect-step" onSubmit={submitCode}>
            <span className="runtime-connect-number">2</span>
            <div><h3>Paste the returned code</h3><p>After completing Claude.ai or SSO in the new tab, paste the one-time authorization code here.</p><div className="runtime-connect-submit"><input aria-label="Claude authorization code" type="password" autoComplete="off" value={code} disabled={session.state === 'code_submitted' || busy} onChange={event => setCode(event.target.value)} placeholder="Authorization code" /><button className="button button-primary" type="submit" disabled={!code.trim() || session.state === 'code_submitted' || busy}>Submit code</button></div></div>
          </form>}

          <section className={`runtime-connect-result state-${session.state}`} aria-live="polite">
            {session.state === 'completed' ? <CheckCircle2 size={17} /> : session.state === 'failed' || session.state === 'expired' ? <XCircle size={17} /> : <Loader2 className="spin" size={17} />}
            <span><b>{session.state.replaceAll('_', ' ')}</b><small>{session.error || session.message}</small></span>
          </section>
        </>}

        {(error || pollError || statusQuery.error) && <div className="editor-error" role="alert"><XCircle size={15} />{error instanceof Error ? error.message : pollError || (statusQuery.error instanceof Error ? statusQuery.error.message : 'Runtime sign-in failed.')}</div>}
        <div className="config-info-note"><ShieldCheck size={15} /><span>Only a platform administrator can start this flow. OAuth tokens remain isolated in the runtime credential store and are never returned to the browser or stored in Argus.</span></div>
      </div>

      <footer><button className="button button-secondary" type="button" onClick={onClose}>{session?.state === 'completed' ? 'Done' : 'Close'}</button>{session && !TERMINAL_STATES.has(session.state) && <button className="button button-secondary is-danger" type="button" disabled={busy} onClick={() => cancel.mutate()}>Cancel sign-in</button>}</footer>
    </section>
  </div>;
}
