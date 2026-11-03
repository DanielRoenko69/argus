import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BrainCircuit, Cable, Gauge, KeyRound, Settings2, ShieldCheck, UserRoundCheck, Users } from 'lucide-react';
import { isPlatformAdminRole } from '../access';
import { getOverview } from '../api';
import { ErrorState, LoadingState, PageHeader } from '../components/Ui';

export function SettingsPage() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview, staleTime: 15_000 });

  if (overview.isLoading) return <LoadingState label="Loading workspace settings…" />;
  if (overview.error) return <ErrorState error={overview.error} />;

  const canManagePlatform = isPlatformAdminRole(overview.data?.user.role);

  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE"
        title="Settings"
        description={canManagePlatform
          ? 'Configure providers, identities and platform-wide behavior.'
          : 'Manage your personal connections and workspace access.'}
      />
      <div className="feature-grid">
        <a className="feature-card" href="/connections">
          <span className="feature-icon teal"><Cable size={19} /></span>
          <div><h3>Identity & access</h3><p>Open workforce SSO portals and manage user-scoped OAuth delegations.</p><b>Open identity hub <ArrowRight size={13} /></b></div>
        </a>
        <a className="feature-card" href="/settings/identity">
          <span className="feature-icon violet"><UserRoundCheck size={19} /></span>
          <div><h3>Sign-in & MFA</h3><p>Link your Argus account to company SSO, verify MFA and inspect report-export readiness.</p><b>Open identity security <ArrowRight size={13} /></b></div>
        </a>
        {canManagePlatform && <>
          <a className="feature-card" href="/settings/readiness">
            <span className="feature-icon teal"><Gauge size={19} /></span>
            <div><h3>Platform readiness</h3><p>Verify the pilot and live-demo path across Core, SSO, delivery, AIOps and signed evidence.</p><b>Run readiness checks <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/settings/models">
            <span className="feature-icon violet"><BrainCircuit size={19} /></span>
            <div><h3>AI providers & models</h3><p>Connect direct APIs, compatible runtimes and stable model aliases without a mandatory gateway.</p><b>Configure AI runtime <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/settings/models/runtime-controls">
            <span className="feature-icon teal"><ShieldCheck size={19} /></span>
            <div><h3>Execution policies</h3><p>Advanced, platform-wide tool filters and policy hooks enforced before every MCP, Agent and Workflow action.</p><b>Manage execution policies <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/settings/api-keys">
            <span className="feature-icon blue"><KeyRound size={19} /></span>
            <div><h3>API keys</h3><p>Create scoped credentials for MCP clients and automations.</p><b>Manage keys <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/settings/users">
            <span className="feature-icon amber"><Users size={19} /></span>
            <div><h3>Users & roles</h3><p>Manage local identities, platform roles and base bundle access.</p><b>Manage users <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/governance/policies?tab=users">
            <span className="feature-icon teal"><ShieldCheck size={19} /></span>
            <div><h3>Access policies</h3><p>Compose resource and capability policies for users, groups and technical identities.</p><b>Open policies <ArrowRight size={13} /></b></div>
          </a>
          <a className="feature-card" href="/settings/platform">
            <span className="feature-icon violet"><Settings2 size={19} /></span>
            <div><h3>Platform configuration</h3><p>Configure secrets, observability, identity propagation and infrastructure integration.</p><b>Open configuration <ArrowRight size={13} /></b></div>
          </a>
        </>}
      </div>
    </>
  );
}
