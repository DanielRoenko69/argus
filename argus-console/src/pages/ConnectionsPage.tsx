import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Cable,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileClock,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Unplug,
  UserRound,
  X,
} from 'lucide-react';
import { disconnectUserConnection, getUserConnections, getWorkforceIdentityAccess } from '../api';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/Ui';
import type { UserConnection, WorkforceSsoPortal } from '../types';

function connectionNeedsAttention(connection: UserConnection): boolean {
  return connection.refresh_failed_at != null || connection.readiness === 'reconnect_required' || connection.readiness === 'disabled';
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not yet';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Not available' : parsed.toLocaleString();
}

function portalState(portal: WorkforceSsoPortal): { label: string; className: string } {
  if (portal.state === 'ready') return { label: 'Ready with SSO', className: 'is-connected' };
  if (portal.state === 'sso_required') return { label: 'SSO sign-in required', className: 'is-warning' };
  return { label: 'Premium required', className: 'is-warning' };
}

export function ConnectionsPage() {
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery({ queryKey: ['user-connections'], queryFn: getUserConnections, staleTime: 10_000 });
  const workforceQuery = useQuery({ queryKey: ['workforce-identity-access'], queryFn: getWorkforceIdentityAccess, staleTime: 10_000 });
  const disconnectMutation = useMutation({
    mutationFn: (backendId: number) => disconnectUserConnection(backendId),
    onSuccess: async () => {
      setDisconnectTarget(null);
      setNotice({ kind: 'success', message: 'Personal OAuth delegation disconnected. Delegated calls stop until you reconnect; no service-account fallback is used.' });
      await queryClient.invalidateQueries({ queryKey: ['user-connections'] });
    },
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get('connected');
    const error = url.searchParams.get('error');
    if (connected) setNotice({ kind: 'success', message: `Connected to ${connected.slice(0, 100)}.` });
    if (error) setNotice({ kind: 'error', message: error.slice(0, 200) });
    if (!connected && !error) return;
    url.searchParams.delete('connected');
    url.searchParams.delete('error');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const connections = connectionsQuery.data?.connections ?? [];
  const workforce = workforceQuery.data;
  const portals = workforce?.portals ?? [];
  const stats = useMemo(() => ({
    connected: connections.filter(connection => connection.connected && !connectionNeedsAttention(connection)).length,
    attention: connections.filter(connectionNeedsAttention).length,
  }), [connections]);

  if (connectionsQuery.isLoading && workforceQuery.isLoading) return <LoadingState label="Loading identity and access…" />;
  if (connectionsQuery.error && workforceQuery.error) return <ErrorState error={connectionsQuery.error} />;

  return (
    <>
      <a className="back-link" href="/settings"><ArrowLeft size={14} />Back to settings</a>
      <PageHeader
        eyebrow="IDENTITY & ACCESS"
        title="Connections"
        description="Open company systems with workforce SSO or delegate narrowly scoped OAuth access to Argus agents and workflows."
        actions={<>
          <a className="button button-secondary" href="/settings/identity"><Fingerprint size={15} />Sign-in & MFA</a>
          <a className="button button-secondary" href="/mcp-fabric"><Cable size={15} />Open MCP Fabric</a>
        </>}
      />

      {notice && (
        <div className={`connection-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.kind === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      )}
      {disconnectMutation.error && (
        <div className="connection-notice is-error" role="alert"><AlertTriangle size={16} /><span>{disconnectMutation.error.message}</span></div>
      )}
      {workforceQuery.error && (
        <div className="connection-notice is-error" role="alert"><AlertTriangle size={16} /><span>Workforce SSO apps are temporarily unavailable. Personal OAuth management remains usable.</span></div>
      )}
      {connectionsQuery.error && (
        <div className="connection-notice is-error" role="alert"><AlertTriangle size={16} /><span>Personal OAuth connections are temporarily unavailable. Workforce portal access remains usable.</span></div>
      )}

      <section className="identity-access-assurance panel" aria-label="Current identity assurance">
        <span className="identity-access-assurance-icon"><ShieldCheck size={22} /></span>
        <div>
          <span className="eyebrow">CURRENT IDENTITY</span>
          <h2>{workforce?.session.authMethod === 'oidc' ? `${workforce.provider.name} workforce session` : 'Local Argus session'}</h2>
          <p>{workforce?.session.authMethod === 'oidc'
            ? 'Your Argus identity can launch entitled backend portals. Each launch is written to the audit trail.'
            : 'Sign in with company SSO to open entitled backend portals with your workforce identity.'}</p>
        </div>
        <span className={`identity-security-state ${workforce?.session.mfaFresh ? 'is-ready' : 'is-attention'}`}>
          {workforce?.session.mfaFresh ? <CheckCircle2 size={14} /> : <LockKeyhole size={14} />}
          {workforce?.session.mfaFresh ? 'Fresh MFA verified' : 'MFA not fresh'}
        </span>
        <a className="button button-secondary" href="/settings/identity">Review identity <ArrowRight size={13} /></a>
      </section>

      <section className="metric-grid connection-metrics" aria-label="Identity access summary">
        <article className="metric-card"><span className="metric-icon violet"><Building2 size={17} /></span><div><span>Workforce apps</span><strong>{workforce?.stats.ready ?? 0}/{workforce?.stats.available ?? 0}</strong><small>{workforce?.stats.configuredBackends ?? 0} governed backend configs</small></div></article>
        <article className="metric-card"><span className="metric-icon teal"><UserRound size={17} /></span><div><span>OAuth delegations</span><strong>{stats.connected}/{connections.length}</strong><small>connected for automation</small></div></article>
        <article className="metric-card"><span className={`metric-icon ${workforce?.session.mfaFresh ? 'teal' : 'amber'}`}><ShieldCheck size={17} /></span><div><span>MFA assurance</span><strong>{workforce?.session.mfaFresh ? 'Fresh' : 'Action'}</strong><small>{workforce?.session.mfaMethod ?? 'provider verification required'}</small></div></article>
        <article className="metric-card"><span className="metric-icon blue"><FileClock size={17} /></span><div><span>Audited launches</span><strong>{workforce?.stats.launched ?? 0}</strong><small>apps used by this identity</small></div></article>
      </section>

      <section className="identity-access-section" aria-labelledby="workforce-access-title">
        <header className="identity-access-section-head">
          <div><span className="eyebrow">PREMIUM · WORKFORCE SSO</span><h2 id="workforce-access-title">Open company applications</h2><p>Interactive browser access using the same organization identity that authenticated you to Argus.</p></div>
          <span className={`identity-access-entitlement ${workforce?.entitlement.enabled ? 'is-ready' : 'is-locked'}`}>
            {workforce?.entitlement.enabled ? <ShieldCheck size={13} /> : <LockKeyhole size={13} />}
            {workforce?.entitlement.enabled ? 'Entitled' : 'Premium not enabled'}
          </span>
        </header>
        {portals.length > 0 ? (
          <div className="workforce-portal-grid">
            {portals.map(portal => {
              const state = portalState(portal);
              return <article className="workforce-portal-card" key={portal.backendId}>
                <div className="user-connection-head">
                  <span className="user-connection-icon"><Building2 size={18} /></span>
                  <span className="user-connection-title"><small>{portal.providerName}</small><h2>{portal.application}</h2></span>
                  <span className={`user-connection-state ${state.className}`}><KeyRound size={12} />{state.label}</span>
                </div>
                <p>{portal.presentationRole}</p>
                <div className="workforce-portal-facts">
                  <span><Cable size={14} /><small>Governed backends</small><b title={portal.backendNames.join(', ')}>{portal.connectionCount} connections</b></span>
                  <span><ShieldCheck size={14} /><small>Authorized bundles</small><b>{portal.bundleIds.length || 'Unscoped'}</b></span>
                  <span><FileClock size={14} /><small>Last audited launch</small><b>{formatTimestamp(portal.lastLaunch?.launchedAt ?? null)}</b></span>
                  <span><Fingerprint size={14} /><small>Audit evidence</small><b>{portal.lastLaunch ? `#${portal.lastLaunch.auditId}` : 'Created on first launch'}</b></span>
                </div>
                <div className="user-connection-actions">
                  <a href="/observe/audit">View audit trail <ArrowRight size={13} /></a>
                  {portal.state === 'ready' && portal.launchPath && <a className="is-primary" href={portal.launchPath} target="_blank" rel="noreferrer">{portal.label} <ExternalLink size={13} /></a>}
                  {portal.state === 'sso_required' && <a className="is-primary" href="/auth/oidc/login">Sign in with SSO <ArrowRight size={13} /></a>}
                  {portal.state === 'premium_required' && <a href="/settings/platform"><LockKeyhole size={13} />Review SSO setup</a>}
                </div>
              </article>;
            })}
          </div>
        ) : (
          <section className="panel identity-access-empty"><EmptyState title="No workforce applications published" description="Configure an SSO portal on an MCP backend to make it available here. Community OAuth connections below remain fully usable." /></section>
        )}
      </section>

      <section className="identity-access-explainer" aria-label="Connection type explanation">
        <article><span><Building2 size={17} /></span><div><b>Workforce SSO is for people</b><p>Argus records the launch and redirects your browser. Authentication, MFA and the application session stay with your company identity provider and backend.</p></div></article>
        <article><span><KeyRound size={17} /></span><div><b>Personal OAuth is for delegated actions</b><p>You approve explicit scopes. Argus stores the user token encrypted so governed agents and workflows can act as you; disconnect it at any time.</p></div></article>
      </section>

      <section className="identity-access-section" aria-labelledby="oauth-access-title">
        <header className="identity-access-section-head">
          <div><span className="eyebrow">PERSONAL DELEGATION</span><h2 id="oauth-access-title">OAuth connections</h2><p>Scoped credentials used by Argus automation, separate from interactive workforce portal sessions.</p></div>
          {stats.attention > 0 && <span className="identity-access-entitlement is-locked"><AlertTriangle size={13} />{stats.attention} need attention</span>}
        </header>
        {connectionsQuery.data?.delegationEnabled === false && <div className="connection-notice is-error" role="alert"><AlertTriangle size={16} /><span>Personal API delegation is disabled by an administrator. Browser SSO does not enable API delegation. No automatic service-account fallback is used.</span></div>}
        {connections.length > 0 ? (
          <div className="user-connection-grid" aria-label="Personal OAuth connections">
            {connections.map(connection => {
              const needsAttention = connectionNeedsAttention(connection);
              const grantedScopes = connection.scopes_granted ?? [];
              const requestedScopes = connection.oauth_scopes ?? [];
              const confirming = disconnectTarget === connection.backend_id;
              const disconnecting = disconnectMutation.isPending && disconnectMutation.variables === connection.backend_id;
              return (
                <article className={`user-connection-card${needsAttention ? ' needs-attention' : ''}`} key={connection.backend_id}>
                  <div className="user-connection-head">
                    <span className="user-connection-icon"><Cable size={18} /></span>
                    <span className="user-connection-title"><small>OAUTH BACKEND</small><h2>{connection.name}</h2></span>
                    <span className={`user-connection-state ${needsAttention ? 'is-warning' : connection.connected ? 'is-connected' : 'is-disconnected'}`}>
                      {needsAttention ? <AlertTriangle size={12} /> : connection.connected ? <CheckCircle2 size={12} /> : <Unplug size={12} />}
                      {connection.readiness === 'disabled' ? 'Delegation disabled' : needsAttention ? 'Re-auth required' : connection.readiness === 'refresh_required' ? 'Refresh on next call' : connection.connected ? 'Connected' : 'Not connected'}
                    </span>
                  </div>
                  <div className="user-connection-facts">
                    <span><LockKeyhole size={14} /><small>Identity mode</small><b>User OAuth · no fallback</b></span>
                    <span><UserRound size={14} /><small>Upstream account</small><b>{connection.upstream_username || 'Not authorized'}</b></span>
                    <span><Clock3 size={14} /><small>Token expires</small><b>{formatTimestamp(connection.expires_at)}</b></span>
                    <span><RefreshCw size={14} /><small>Last used</small><b>{formatTimestamp(connection.last_used_at)}</b></span>
                  </div>
                  <div className="user-connection-scopes">
                    <span><KeyRound size={14} /><b>{connection.connected ? 'Granted scopes' : 'Requested scopes'}</b></span>
                    <div>
                      {(connection.connected ? grantedScopes : requestedScopes).length > 0
                        ? (connection.connected ? grantedScopes : requestedScopes).map(scope => <code key={scope}>{scope}</code>)
                        : <small>No scopes declared</small>}
                    </div>
                  </div>
                  {confirming ? (
                    <div className="user-connection-confirm" role="alert">
                      <span><AlertTriangle size={15} /><b>Disconnect {connection.name}?</b><small>Delegated calls will stop until you reconnect. No service-account fallback.</small></span>
                      <button type="button" onClick={() => setDisconnectTarget(null)}>Cancel</button>
                      <button className="is-danger" type="button" disabled={disconnecting} onClick={() => disconnectMutation.mutate(connection.backend_id)}>{disconnecting ? 'Disconnecting…' : 'Confirm disconnect'}</button>
                    </div>
                  ) : (
                    <div className="user-connection-actions">
                      <a href="/mcp-fabric?view=backends#connections">Inspect backend <ArrowRight size={13} /></a>
                      {connection.connected ? (
                        <>
                          {connectionsQuery.data?.delegationEnabled !== false && <a href={`/connections/connect/${connection.backend_id}`}>{needsAttention ? 'Reauthorize' : 'Refresh authorization'} <RefreshCw size={13} /></a>}
                          <button type="button" onClick={() => setDisconnectTarget(connection.backend_id)}><Unplug size={13} />Disconnect</button>
                        </>
                      ) : connectionsQuery.data?.delegationEnabled !== false && <a className="is-primary" href={`/connections/connect/${connection.backend_id}`}>Connect identity <ArrowRight size={13} /></a>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <section className="panel identity-access-empty"><EmptyState title="No OAuth-capable systems" description="An administrator must configure an enabled backend with permissive or strict OAuth before users can delegate an identity." /></section>
        )}
      </section>
    </>
  );
}
