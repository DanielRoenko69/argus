import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  Bot,
  Boxes,
  GitBranch,
  KeyRound,
  Layers3,
  LockKeyhole,
  Network,
  Plus,
  ServerCog,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';

interface QuickCreateDialogProps {
  canAdmin: boolean;
  onClose: () => void;
}

interface QuickCreateAction {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  href: string | ((canAdmin: boolean) => string);
}

interface QuickCreateGroup {
  label: string;
  actions: QuickCreateAction[];
}

const quickCreateGroups: QuickCreateGroup[] = [
  {
    label: 'Agent setup',
    actions: [
      {
        key: 'agent',
        label: 'Create agent',
        description: 'Build a governed agent with a model and runtime settings.',
        icon: Bot,
        href: canAdmin => canAdmin ? '/build/agents/manage?create=agent' : '/home?quickCreate=agent',
      },
      {
        key: 'preset',
        label: 'Create agent preset',
        description: 'Author a reusable, provider-neutral agent blueprint.',
        icon: Layers3,
        adminOnly: true,
        href: '/build/agents/manage?create=preset',
      },
    ],
  },
  {
    label: 'AI setup',
    actions: [
      {
        key: 'provider',
        label: 'Create provider',
        description: 'Connect an AI provider for models and agent execution.',
        icon: ServerCog,
        href: canAdmin => canAdmin ? '/settings/models?create=provider' : '/home?quickCreate=provider',
      },
      {
        key: 'model',
        label: 'Create model',
        description: 'Register a model alias against an existing provider.',
        icon: BrainCircuit,
        href: canAdmin => canAdmin ? '/settings/models?create=model' : '/home?quickCreate=model',
      },
      {
        key: 'credential',
        label: 'Create credential profile',
        description: 'Create a reusable credential for governed provider access.',
        icon: KeyRound,
        adminOnly: true,
        href: '/settings/models?create=credential',
      },
    ],
  },
  {
    label: 'Build',
    actions: [
      {
        key: 'skill',
        label: 'Create skill',
        description: 'Create reusable prompt context for governed agents.',
        icon: Sparkles,
        adminOnly: true,
        href: '/build/skills?create=skill',
      },
      {
        key: 'workflow',
        label: 'Create workflow',
        description: 'Open the visual builder for a new agentic workflow.',
        icon: GitBranch,
        adminOnly: true,
        href: '/build/workflows/studio',
      },
      {
        key: 'knowledge',
        label: 'Create knowledge source',
        description: 'Add governed retrieval context for agents and workflows.',
        icon: BookOpen,
        adminOnly: true,
        href: '/build/knowledge?create=knowledge',
      },
    ],
  },
  {
    label: 'MCP fabric',
    actions: [
      {
        key: 'bundle',
        label: 'Create bundle',
        description: 'Group MCP tools into a governed access bundle.',
        icon: Boxes,
        adminOnly: true,
        href: '/mcp-fabric?create=bundle',
      },
      {
        key: 'mcp',
        label: 'Create MCP connection',
        description: 'Connect an MCP server and discover its available tools.',
        icon: Network,
        adminOnly: true,
        href: '/mcp-fabric?create=mcp',
      },
    ],
  },
];

function resolveHref(action: QuickCreateAction, canAdmin: boolean): string {
  return typeof action.href === 'function' ? action.href(canAdmin) : action.href;
}

export function QuickCreateDialog({ canAdmin, onClose }: QuickCreateDialogProps) {
  const navigate = useNavigate();

  return (
    <div className="quick-create-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="quick-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-create-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="quick-create-header">
          <div>
            <span className="eyebrow">QUICK CREATE</span>
            <h2 id="quick-create-title">Create a resource</h2>
            <p>Choose what you want to configure next.</p>
          </div>
          <button className="quick-create-close" type="button" aria-label="Close quick create" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="quick-create-body">
          {quickCreateGroups.map(group => (
            <section className="quick-create-group" key={group.label} aria-labelledby={`quick-create-group-${group.label.toLowerCase().replaceAll(' ', '-')}`}>
              <h3 id={`quick-create-group-${group.label.toLowerCase().replaceAll(' ', '-')}`}>{group.label}</h3>
              <div className="quick-create-grid">
                {group.actions.map(action => {
                  const disabled = Boolean(action.adminOnly && !canAdmin);
                  return (
                    <button
                      className={`quick-create-action${disabled ? ' is-disabled' : ''}`}
                      type="button"
                      key={action.key}
                      disabled={disabled}
                      aria-label={disabled ? `${action.label} (Admin access required)` : action.label}
                      title={disabled ? 'Admin access required' : undefined}
                      onClick={() => {
                        if (disabled) return;
                        onClose();
                        navigate(resolveHref(action, canAdmin));
                      }}
                    >
                      <span className="quick-create-action-icon"><action.icon size={17} /></span>
                      <span className="quick-create-action-copy"><b>{action.label}</b><small>{action.description}</small>{disabled && <em><LockKeyhole size={11} />Admin access required</em>}</span>
                      {disabled ? <LockKeyhole className="quick-create-action-state" size={15} /> : <ArrowRight className="quick-create-action-state" size={15} />}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <footer className="quick-create-footer">
          <span><Plus size={13} />Existing create dialogs will open automatically.</span>
          {!canAdmin && <span><KeyRound size={13} />Some resources require administrator access.</span>}
        </footer>
      </section>
    </div>
  );
}
