// Cmd+K command palette — fuzzy-search any builder action.

import { useState, useMemo, useEffect } from 'react';
import { Command as CmdIcon, ArrowRight } from 'lucide-react';
import { useBuilderStore } from '@/stores/builderStore';
import { useReactFlow } from 'reactflow';
import { getAllNodeDefinitions } from '@/nodes/registry';
import { autoLayout } from './autoLayout';
import { cn } from '@/lib/utils';
import { getIcon } from '@/lib/iconRegistry';

export interface Cmd {
  id: string;
  label: string;
  category: string;
  icon?: string;
  shortcut?: string;
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSave?: () => void;
  onRun?: () => void;
  onToggleCopilot?: () => void;
}

export function CommandPalette({ open, onClose, onSave, onRun, onToggleCopilot }: Props) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(0);
  const s = useBuilderStore();
  const { fitView } = useReactFlow();

  const cmds = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      { id: 'save', label: 'Workflow speichern', category: 'Aktion', icon: 'Save', shortcut: '⌘S', run: () => onSave?.() },
      { id: 'run',  label: 'Workflow ausführen', category: 'Aktion', icon: 'Play', shortcut: '⌘↵', run: () => onRun?.() },
      { id: 'copilot', label: 'Copilot öffnen/schließen', category: 'Aktion', icon: 'Sparkles', run: () => onToggleCopilot?.() },
      { id: 'undo', label: 'Rückgängig', category: 'Aktion', icon: 'Undo2', shortcut: '⌘Z', run: () => s.undo() },
      { id: 'redo', label: 'Wiederherstellen', category: 'Aktion', icon: 'Redo2', shortcut: '⌘⇧Z', run: () => s.redo() },
      { id: 'fit',  label: 'Fit View', category: 'View', icon: 'Maximize', shortcut: 'F', run: () => { fitView({ padding: 0.2, duration: 250 }); } },
      { id: 'auto', label: 'Auto-Layout', category: 'View', icon: 'LayoutGrid', shortcut: '⌘L', run: () => s.setNodes(autoLayout(s.nodes, s.edges)) },
    ];
    const addNodes: Cmd[] = getAllNodeDefinitions().map((def) => ({
      id: `add.${def.type}`,
      label: `Block hinzufügen: ${def.label}`,
      category: def.category,
      icon: def.icon,
      run: () => {
        const id = `${def.type}.${crypto.randomUUID().slice(0, 8)}`;
        s.addNode({ id, type: def.type, position: { x: 200, y: 200 }, data: def.defaultData() });
      },
    }));
    return [...base, ...addNodes];
  }, [s, fitView, onSave, onRun, onToggleCopilot]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return cmds;
    return cmds.filter((c) =>
      c.label.toLowerCase().includes(needle) || c.category.toLowerCase().includes(needle) || c.id.includes(needle)
    );
  }, [q, cmds]);

  useEffect(() => { setSelected(0); }, [q]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => Math.min(filtered.length - 1, i + 1)); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected((i) => Math.max(0, i - 1)); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[selected];
        if (cmd) { void cmd.run(); onClose(); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, selected, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[600px] bg-card border border-border rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <CmdIcon className="w-4 h-4 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Aktion suchen…"
            className="flex-1 bg-transparent text-small outline-none placeholder:text-muted-foreground"
          />
          <span className="text-[10px] text-muted-foreground font-mono">↑↓ Navigieren · ↵ Ausführen · Esc Schließen</span>
        </div>
        <ul className="max-h-96 overflow-y-auto py-1">
          {filtered.slice(0, 60).map((c, i) => {
            const Icon = c.icon ? getIcon(c.icon, ArrowRight) : ArrowRight;
            return (
              <li key={c.id}>
                <button
                  onClick={() => { void c.run(); onClose(); }}
                  onMouseEnter={() => setSelected(i)}
                  className={cn(
                    'w-full text-left px-3 py-2 flex items-center gap-2 text-xs',
                    i === selected ? 'bg-primary/15 text-foreground' : 'text-foreground/80 hover:bg-secondary'
                  )}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{c.label}</span>
                  <span className="text-[10px] text-muted-foreground">{c.category}</span>
                  {c.shortcut && <span className="text-[10px] font-mono text-muted-foreground ml-2">{c.shortcut}</span>}
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-muted-foreground">Keine Treffer</li>
          )}
        </ul>
      </div>
    </div>
  );
}
