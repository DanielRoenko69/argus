import { Database, GitBranch, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import '../agents/agentWorkspace.css';

export type KnowledgeWorkspaceView = 'sources' | 'repositories' | 'skills';

const views = [
  { id: 'sources', label: 'RAGs', href: '/build/knowledge', icon: <Database size={14} /> },
  { id: 'repositories', label: 'Repository snapshots', href: '/build/knowledge?view=repository', icon: <GitBranch size={14} /> },
  { id: 'skills', label: 'Skills', href: '/build/skills', icon: <Sparkles size={14} /> },
] as const;

export function KnowledgeWorkspaceTabs({ active }: { active: KnowledgeWorkspaceView }) {
  return (
    <nav className="agent-workspace-tabs" aria-label="Knowledge workspace">
      {views.map(view => (
        <Link key={view.id} to={view.href} className={view.id === active ? 'is-active' : undefined} aria-current={view.id === active ? 'page' : undefined}>
          {view.icon}<span>{view.label}</span>
        </Link>
      ))}
    </nav>
  );
}
