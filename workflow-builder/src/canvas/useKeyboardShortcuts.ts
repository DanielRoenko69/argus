// Keyboard shortcuts wired against the Argus Builder Store.
// Pattern inspired by sim/apps/sim/.../keyboard-shortcuts (Apache 2.0).

import { useEffect } from 'react';
import { useReactFlow } from 'reactflow';
import { useBuilderStore } from '@/stores/builderStore';
import { autoLayout } from './autoLayout';

interface ShortcutDeps {
  onSave?: () => void;
  onRun?: () => void;
  onOpenPalette?: () => void;
  onOpenSearch?: () => void;
  onToggleCopilot?: () => void;
}

export function useKeyboardShortcuts({ onSave, onRun, onOpenPalette, onOpenSearch, onToggleCopilot }: ShortcutDeps): void {
  const { fitView } = useReactFlow();

  useEffect(() => {
    function handler(e: KeyboardEvent): void {
      const target = e.target as HTMLElement;
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);

      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const s = useBuilderStore.getState();
      const selectedIds = s.nodes.filter((node) => node.selected).map((node) => node.id);
      const activeIds = selectedIds.length > 0
        ? selectedIds
        : s.selectedNodeId
          ? [s.selectedNodeId]
          : [];

      // These shortcuts work even when typing in fields (global navigation):
      if (meta && k === 'k')                        { e.preventDefault(); onOpenPalette?.(); return; }
      if (meta && k === 'f' && !e.shiftKey)         { e.preventDefault(); onOpenSearch?.(); return; }
      if (meta && k === '/')                        { e.preventDefault(); onToggleCopilot?.(); return; }

      if (inField) return; // remaining shortcuts only when not typing

      if (meta && k === 'z' && !e.shiftKey)         { e.preventDefault(); s.undo(); }
      else if (meta && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); s.redo(); }
      else if (meta && k === 'a')                   { e.preventDefault(); s.selectNodes(s.nodes.map((node) => node.id)); }
      else if (meta && k === 's')                   { e.preventDefault(); onSave?.(); }
      else if (meta && k === 'enter')               { e.preventDefault(); onRun?.(); }
      else if (meta && k === 'd' && s.selectedNodeId) { e.preventDefault(); s.duplicateNode(s.selectedNodeId); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && activeIds.length > 0) { e.preventDefault(); s.removeNodes(activeIds); }
      else if (!meta && k === 'f')                  { e.preventDefault(); fitView({ padding: 0.2, duration: 250 }); }
      else if (meta && k === 'l')                   {
        e.preventDefault();
        const laid = autoLayout(s.nodes, s.edges);
        s.setNodes(laid);
      }
    }

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onSave, onRun, onOpenPalette, onOpenSearch, onToggleCopilot, fitView]);
}
