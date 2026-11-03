import type { ReactNode } from 'react';
import { BarChart3, Bot, Layers3, MessageSquare } from 'lucide-react';
import './agentWorkspace.css';

export type AgentWorkspaceView = 'installed' | 'blueprints' | 'evaluations' | 'channels';

const views: Array<{ id: AgentWorkspaceView; label: string; href: string; icon: ReactNode }> = [
  { id: 'installed', label: 'Agents', href: '/build/agents', icon: <Bot size={14} /> },
  { id: 'blueprints', label: 'Blueprints', href: '/build/agents/manage', icon: <Layers3 size={14} /> },
  { id: 'evaluations', label: 'Evaluations', href: '/build/evaluations', icon: <BarChart3 size={14} /> },
  { id: 'channels', label: 'Channels', href: '/build/agents/channels', icon: <MessageSquare size={14} /> },
];

export function AgentWorkspaceTabs({ active }: { active: AgentWorkspaceView }) {
  return (
    <nav className="agent-workspace-tabs" aria-label="Agent workspace">
      {views.map(view => (
        <a key={view.id} href={view.href} className={view.id === active ? 'is-active' : undefined} aria-current={view.id === active ? 'page' : undefined}>
          {view.icon}<span>{view.label}</span>
        </a>
      ))}
    </nav>
  );
}
