// Inline autocomplete for {{ input.X }} / {{ steps.Y.result }} mentions.
// Wraps a textarea/input — detects '{{ ' or '@' prefix, shows dropdown,
// inserts on click.

import { useState, useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { useBuilderStore } from '@/stores/builderStore';
import { cn } from '@/lib/utils';

interface Suggestion {
  label: string;       // displayed
  insert: string;      // what gets typed in
  hint: string;        // right-side hint
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  type?: 'input' | 'textarea';
  className?: string;
}

const TRIGGER = '@';

export function VarAutocomplete({ value, onChange, placeholder, rows = 4, type = 'textarea', className }: Props) {
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const nodes = useBuilderStore((s) => s.nodes);

  const suggestions: Suggestion[] = (() => {
    const sugg: Suggestion[] = [
      { label: '{{ input.task }}',  insert: '{{ input.task }}',  hint: 'workflow input' },
      { label: '{{ input.jira_id }}', insert: '{{ input.jira_id }}', hint: 'workflow input' },
    ];
    for (const n of nodes) {
      const label = (n.data as { label?: string } | undefined)?.label ?? n.id;
      sugg.push({
        label: `{{ steps.${n.id}.result }}`,
        insert: `{{ steps.${n.id}.result }}`,
        hint: label,
      });
      sugg.push({
        label: `{{ steps.${n.id}.status }}`,
        insert: `{{ steps.${n.id}.status }}`,
        hint: label,
      });
    }
    return sugg;
  })();

  // Filter by query after @
  const filtered: Suggestion[] = (() => {
    if (openAt == null || !inputRef.current) return [];
    const el = inputRef.current;
    const caret = el.selectionStart ?? value.length;
    const q = value.slice(openAt + 1, caret).toLowerCase();
    return suggestions.filter((s) => s.label.toLowerCase().includes(q)).slice(0, 8);
  })();

  function onCh(e: ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) {
    const v = e.target.value;
    onChange(v);
    const caret = e.target.selectionStart ?? v.length;
    // Find last @ before caret with no whitespace between
    const lastAt = v.lastIndexOf(TRIGGER, caret - 1);
    if (lastAt >= 0) {
      const between = v.slice(lastAt + 1, caret);
      if (between.length === 0 || /^[a-zA-Z0-9_.{}]*$/.test(between)) {
        setOpenAt(lastAt);
        setHighlight(0);
        return;
      }
    }
    setOpenAt(null);
  }

  function insert(s: Suggestion) {
    if (openAt == null || !inputRef.current) return;
    const el = inputRef.current;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, openAt);
    const after = value.slice(caret);
    const next = before + s.insert + after;
    onChange(next);
    setOpenAt(null);
    setTimeout(() => {
      el.focus();
      const newCaret = before.length + s.insert.length;
      el.setSelectionRange(newCaret, newCaret);
    }, 0);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (openAt == null) return;
    if (e.key === 'Escape') { setOpenAt(null); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((i) => Math.min(filtered.length - 1, i + 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlight((i) => Math.max(0, i - 1)); }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (filtered[highlight]) {
        e.preventDefault();
        insert(filtered[highlight]!);
      }
    }
  }

  const baseCls = cn(
    'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring',
    type === 'textarea' && 'font-mono text-xs resize-y',
    className
  );

  return (
    <div className="relative">
      {type === 'textarea' ? (
        <textarea
          ref={(r) => { inputRef.current = r; }}
          value={value}
          onChange={onCh}
          onKeyDown={onKey}
          rows={rows}
          placeholder={placeholder}
          className={baseCls}
        />
      ) : (
        <input
          ref={(r) => { inputRef.current = r; }}
          type="text"
          value={value}
          onChange={onCh}
          onKeyDown={onKey}
          placeholder={placeholder}
          className={baseCls}
        />
      )}
      {openAt != null && filtered.length > 0 && (
        <div className="absolute z-30 top-full left-0 mt-1 w-72 max-h-56 overflow-y-auto bg-card border border-border rounded-md shadow-2xl py-1 text-xs animate-fade-in">
          <div className="px-2 pb-1 text-[10px] text-muted-foreground">Tippe weiter zum filtern · ↑↓ wählen · ↵/Tab einfügen</div>
          {filtered.map((s, i) => (
            <button
              key={i}
              onClick={() => insert(s)}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                'w-full text-left px-2 py-1 flex items-center justify-between gap-2',
                i === highlight ? 'bg-primary/15' : 'hover:bg-secondary'
              )}
            >
              <span className="font-mono text-foreground truncate">{s.label}</span>
              <span className="text-muted-foreground truncate text-[10px] shrink-0">{s.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
