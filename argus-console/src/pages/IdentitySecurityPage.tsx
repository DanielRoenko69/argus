import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileCheck2,
  KeyRound,
  Link2,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { beginIdentitySecurityLink, getIdentitySecurityStatus } from '../api';
import { ErrorState, LoadingState, PageHeader } from '../components/Ui';

function SecurityState({ ok, children }: { ok: boolean; children: string }) {
  return (
    <span className={`identity-security-state ${ok ? 'is-ready' : 'is-attention'}`}>
      {ok ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}{children}
    </span>
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not verified in this session';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

export function IdentitySecurityPage() {
  const status = useQuery({
    queryKey: ['identity-security'],
    queryFn: getIdentitySecurityStatus,
    staleTime: 10_000,
  });
  const link = useMutation({
    mutationFn: beginIdentitySecurityLink,
    onSuccess: result => window.location.assign(result.authorizationUrl),
  });

  if (status.isLoading) return <LoadingState label="Loading identity security…" />;
  if (status.error) return <ErrorState error={status.error} />;
  const data = status.data!;
  const actionHref = `/auth/oidc/step-up?returnTo=${encodeURIComponent('/settings/identity')}`;

  return (
    <>
      <PageHeader
        eyebrow="IDENTITY SECURITY"
        title="Sign-in & MFA"
        description="Connect your existing Argus account to company SSO and verify strong authentication for protected actions."
      />

      <section className="identity-security-hero panel">
        <div className="identity-security-hero-icon"><LockKeyhole size={25} /></div>
        <div>
          <span className="eyebrow">CURRENT SESSION</span>
          <h2>{data.session.ssoLinked ? data.provider.name : 'Local Argus account'}</h2>
          <p>{data.session.ssoLinked
            ? 'Your stable Argus identity is linked to the organization provider. Workspace ownership and access remain in Argus.'
            : data.provider.enabled
              ? 'Link this account once. Argus preserves its user ID, workspaces, bundles and owned resources.'
              : 'No external identity provider is enabled for this environment.'}</p>
        </div>
        <SecurityState ok={data.session.mfaFresh}>{data.session.mfaFresh ? 'Fresh MFA verified' : 'Fresh MFA required'}</SecurityState>
      </section>

      <div className="identity-security-grid">
        <section className="panel identity-security-card">
          <header><span><Link2 size={18} /></span><div><small>ACCOUNT</small><h3>SSO connection</h3></div></header>
          <dl>
            <div><dt>Provider</dt><dd>{data.provider.enabled ? `${data.provider.name} · ${data.provider.type}` : 'Not configured'}</dd></div>
            <div><dt>Current login</dt><dd>{data.session.authMethod === 'oidc' ? 'SSO' : 'Local password'}</dd></div>
            <div><dt>Account linked</dt><dd>{data.session.ssoLinked ? 'Yes' : 'No'}</dd></div>
          </dl>
          {data.actions.canLink && <button className="button button-primary" type="button" disabled={link.isPending} onClick={() => link.mutate()}>
            <KeyRound size={15} />{link.isPending ? 'Opening provider…' : 'Link SSO & verify MFA'}
          </button>}
          {data.actions.canStepUp && <a className="button button-primary" href={actionHref}>
            <ShieldCheck size={15} />{data.session.mfaFresh ? 'Verify MFA again' : 'Verify MFA now'}
          </a>}
          {data.actions.canManageMfa && data.provider.accountManagementUrl && <a
            className="button button-secondary"
            href={data.provider.accountManagementUrl}
            target="_blank"
            rel="noreferrer"
          >
            <KeyRound size={15} />Manage MFA at {data.provider.name}
          </a>}
          {!data.provider.enabled && <p className="identity-security-note">An administrator must configure OIDC before accounts can be linked.</p>}
          {link.error && <p className="identity-security-error" role="alert">{link.error.message}</p>}
        </section>

        <section className="panel identity-security-card">
          <header><span><Clock3 size={18} /></span><div><small>ASSURANCE</small><h3>MFA evidence</h3></div></header>
          <dl>
            <div><dt>Status</dt><dd><SecurityState ok={data.session.mfaFresh}>{data.session.mfaFresh ? 'Valid' : 'Missing or expired'}</SecurityState></dd></div>
            <div><dt>Verified at</dt><dd>{formatTimestamp(data.session.mfaVerifiedAt)}</dd></div>
            <div><dt>Method</dt><dd>{data.session.mfaMethod ?? '—'}</dd></div>
            <div><dt>Freshness window</dt><dd>{Math.round(data.provider.mfaMaxAgeSeconds / 60)} minutes</dd></div>
          </dl>
          <p className="identity-security-note">Argus accepts MFA only from signed OIDC token claims and records the method and timestamp in protected evidence actions.</p>
        </section>

        <section className="panel identity-security-card">
          <header><span><FileCheck2 size={18} /></span><div><small>COMPLIANCE</small><h3>Protected report exports</h3></div></header>
          <dl>
            <div><dt>Authorized role</dt><dd>{data.complianceReports.roleAuthorized ? 'Yes' : 'Platform Admin required'}</dd></div>
            <div><dt>Fresh MFA</dt><dd>{data.session.mfaFresh ? 'Satisfied' : 'Required'}</dd></div>
            <div><dt>Ready now</dt><dd><SecurityState ok={data.complianceReports.ready}>{data.complianceReports.ready ? 'Ready' : 'Action required'}</SecurityState></dd></div>
          </dl>
          <a className="button button-secondary" href="/observe/audit?tab=reports">Open audit reports <ArrowRight size={14} /></a>
        </section>

        <section className="panel identity-security-card">
          <header><span><UsersRound size={18} /></span><div><small>ORGANIZATION POLICY</small><h3>Enforce MFA for everyone</h3></div></header>
          <dl>
            <div><dt>SSO-only mode</dt><dd>{data.provider.ssoOnly ? 'Enforced' : 'Not enforced'}</dd></div>
            <div><dt>Local login</dt><dd>{data.provider.localLoginEnabled ? 'Available' : 'Disabled'}</dd></div>
            <div><dt>Emergency admin</dt><dd>{data.provider.emergencyLocalAdmin ? 'Enabled' : 'Disabled'}</dd></div>
          </dl>
          <p className="identity-security-note">Enrollment and MFA policy remain in the identity provider. Production enforcement uses SSO-only Argus login plus an IdP Conditional Access or authentication-flow policy.</p>
          {data.actions.canManageOrganizationPolicy && data.provider.adminConsoleUrl && <a
            className="button button-secondary"
            href={data.provider.adminConsoleUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ShieldCheck size={15} />Open identity-provider policy
          </a>}
        </section>
      </div>
    </>
  );
}
