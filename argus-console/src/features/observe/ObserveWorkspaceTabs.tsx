import type { ReactNode } from 'react';
import { Activity, BellRing, HeartPulse, Radio, ShieldCheck } from 'lucide-react';
import './observeWorkspace.css';

export type ObserveWorkspaceView = 'overview' | 'health' | 'alerts' | 'activity' | 'evidence';
export type ObserveWorkspaceSection = 'service-health' | 'slos' | 'dependencies' | 'logs' | 'audit' | 'quality';

const views: Array<{
  id: ObserveWorkspaceView;
  label: string;
  description: string;
  href: string;
  icon: ReactNode;
  requiresAdmin?: boolean;
}> = [
  { id: 'overview', label: 'Overview', description: 'Platform and execution signals', href: '/observe', icon: <Activity size={14} /> },
  { id: 'health', label: 'Health', description: 'Services, SLOs and dependencies', href: '/observe/health', icon: <HeartPulse size={14} />, requiresAdmin: true },
  { id: 'alerts', label: 'Alerts', description: 'Rules, incidents and AIOps outcomes', href: '/observe/alerts', icon: <BellRing size={14} />, requiresAdmin: true },
  { id: 'activity', label: 'Activity', description: 'Live Agent and Tool execution', href: '/observe/activity', icon: <Radio size={14} />, requiresAdmin: true },
  { id: 'evidence', label: 'Evidence', description: 'Logs, traces, audit and reports', href: '/observe/logs', icon: <ShieldCheck size={14} /> },
];

const sections: Partial<Record<ObserveWorkspaceView, Array<{
  id: ObserveWorkspaceSection;
  label: string;
  href: string;
}>>> = {
  health: [
    { id: 'service-health', label: 'Service health', href: '/observe/health' },
    { id: 'slos', label: 'SLOs', href: '/observe/slos' },
    { id: 'dependencies', label: 'Dependencies', href: '/observe/dependencies' },
  ],
  evidence: [
    { id: 'logs', label: 'Logs & traces', href: '/observe/logs' },
    { id: 'quality', label: 'Quality Inbox', href: '/observe/quality' },
    { id: 'audit', label: 'Audit & reports', href: '/observe/audit' },
  ],
};

export function ObserveWorkspaceTabs({
  active,
  section,
  isAdmin = false,
}: {
  active: ObserveWorkspaceView;
  section?: ObserveWorkspaceSection;
  isAdmin?: boolean;
}) {
  const secondary = (sections[active] ?? []).filter(item => isAdmin || !['audit','quality'].includes(item.id));
  return (
    <div className="observe-workspace-navigation">
      <nav className="observe-workspace-tabs" aria-label="Observe workspace">
        {views.filter(view => isAdmin || !view.requiresAdmin).map(view => (
          <a
            key={view.id}
            href={view.href}
            className={view.id === active ? 'is-active' : undefined}
            aria-current={view.id === active ? 'page' : undefined}
            title={view.description}
            aria-label={view.label}
          >
            {view.icon}
            <span>{view.label}</span>
            <small>{view.description}</small>
          </a>
        ))}
      </nav>
      {secondary.length > 0 && (
        <nav className="observe-workspace-sections" aria-label={`${active} views`}>
          {secondary.map(item => (
            <a
              key={item.id}
              href={item.href}
              className={item.id === section ? 'is-active' : undefined}
              aria-current={item.id === section ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
