import type { ReactNode } from 'react';
import { ListTree, ShieldCheck } from 'lucide-react';
import './runWorkspace.css';

export type RunWorkspaceView = 'runs' | 'approvals';

const views: Array<{
  id: RunWorkspaceView;
  label: string;
  description: string;
  href: string;
  icon: ReactNode;
}> = [
  {
    id: 'runs',
    label: 'Runs',
    description: 'Root runs, retries and execution lineage',
    href: '/runs',
    icon: <ListTree size={14} />,
  },
  {
    id: 'approvals',
    label: 'Approvals',
    description: 'Human decisions and exact paused checkpoints',
    href: '/governance',
    icon: <ShieldCheck size={14} />,
  },
];

export function RunWorkspaceTabs({ active }: { active: RunWorkspaceView }) {
  return (
    <nav className="run-workspace-tabs" aria-label="Run control workspace">
      {views.map(view => (
        <a
          key={view.id}
          href={view.href}
          className={view.id === active ? 'is-active' : undefined}
          aria-current={view.id === active ? 'page' : undefined}
          title={view.description}
        >
          {view.icon}
          <span>{view.label}</span>
          <small>{view.description}</small>
        </a>
      ))}
    </nav>
  );
}
