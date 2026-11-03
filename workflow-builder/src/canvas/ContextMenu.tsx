// Right-click context menu — used both for node and pane.
// Visual pattern adapted from sim/.../block-menu + canvas-menu (Apache 2.0).

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import { getIcon } from '@/lib/iconRegistry';

export interface MenuAction {
  label: string;
  icon?: string;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  divider?: boolean;
  onClick?: () => void;
  submenu?: MenuAction[];
}

interface Props {
  x: number;
  y: number;
  items: MenuAction[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onEsc(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  // Keep menu on screen
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = Math.min(x, winW - 240);
  const top  = Math.min(y, winH - 24 * items.length - 16);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[200px] rounded-md border border-border bg-card shadow-2xl py-1 animate-fade-in"
      style={{ left, top }}
    >
      {items.map((item, i) => <MenuRow key={i} item={item} onClose={onClose} />)}
    </div>
  );
}

function MenuRow({ item, onClose }: { item: MenuAction; onClose: () => void }) {
  if (item.divider) return <div className="h-px bg-border my-1" />;
  const Icon = item.icon ? getIcon(item.icon) : null;
  const isSubmenu = !!item.submenu?.length;

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!item.disabled && item.onClick) { item.onClick(); onClose(); }
      }}
      disabled={item.disabled}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
        item.disabled
          ? 'opacity-40 cursor-not-allowed'
          : item.destructive
          ? 'text-red-300 hover:bg-red-500/10'
          : 'text-foreground hover:bg-secondary'
      )}
    >
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
      <span className="flex-1">{item.label}</span>
      {item.shortcut && (
        <span className="text-[10px] text-muted-foreground font-mono">{item.shortcut}</span>
      )}
      {isSubmenu && <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />}
    </button>
  );
}
