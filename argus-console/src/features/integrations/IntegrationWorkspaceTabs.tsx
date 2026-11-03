import type { ReactNode } from 'react';
import { Boxes, Cable, SlidersHorizontal, Wrench } from 'lucide-react';
import './integrationWorkspace.css';

export type IntegrationWorkspaceView = 'connections' | 'access' | 'capabilities' | 'advanced';

const views: Array<{
  id: IntegrationWorkspaceView;
  label: string;
  description: string;
  href: string;
  icon: ReactNode;
}> = [
  {
    id: 'access',
    label: 'Bundles',
    description: 'Govern reusable capability access',
    href: '/mcp-fabric?view=access#access-bundles',
    icon: <Boxes size={14} />,
  },
  {
    id: 'connections',
    label: 'Backends',
    description: 'Connect and verify MCP systems',
    href: '/mcp-fabric?view=backends#connections',
    icon: <Cable size={14} />,
  },
  {
    id: 'capabilities',
    label: 'Capabilities',
    description: 'Inspect the effective tool catalog',
    href: '/mcp-fabric/capabilities',
    icon: <Wrench size={14} />,
  },
  {
    id: 'advanced',
    label: 'Trust & sources',
    description: 'Catalog fingerprints and source controls',
    href: '/mcp-fabric?view=advanced#tool-registry',
    icon: <SlidersHorizontal size={14} />,
  },
];

export function IntegrationWorkspaceTabs({ active }: { active: IntegrationWorkspaceView }) {
  return (
    <nav className="integration-workspace-tabs" aria-label="Integration workspace">
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
