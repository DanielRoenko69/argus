// Magic-wand button shown next to text/textarea fields in PropertiesPanel.
// Opens a small popover with a prompt input, calls /copilot-field, shows
// suggested value with Accept/Cancel.

import { useState, useRef, useEffect } from 'react';
import { Sparkles, Check, X, Loader2 } from 'lucide-react';
import { useCopilotField } from '@/api/copilot';

interface Props {
  fieldName: string;
  currentValue: string;
  nodeType: string;
  nodeLabel: string;
  onAccept: (v: string) => void;
}

export function WandButton({ fieldName, currentValue, nodeType, nodeLabel, onAccept }: Props) {
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState('');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const wand = useCopilotField();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setHint('');
        setSuggestion(null);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function onAsk() {
    if (!hint.trim()) return;
    try {
      const r = await wand.mutateAsync({
        field_name: fieldName,
        current_value: currentValue,
        user_hint: hint,
        node_type: nodeType,
        node_label: nodeLabel,
      });
      setSuggestion(r.value);
    } catch {/* error in wand.error */}
  }

  function accept() {
    if (suggestion != null) onAccept(suggestion);
    setOpen(false); setSuggestion(null); setHint('');
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-accent transition-colors"
        title="Copilot: Feld umschreiben"
      >
        <Sparkles className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-72 bg-card border border-border rounded-md shadow-2xl p-2 animate-fade-in">
          <div className="text-[10px] text-muted-foreground mb-1">Feld: <code className="text-foreground">{fieldName}</code></div>
          <textarea
            autoFocus
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="z.B. 'mach den Prompt strikter'"
            rows={2}
            className="w-full px-2 py-1 bg-input border border-border rounded text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void onAsk(); }
            }}
          />
          <div className="flex justify-end gap-1 mt-1">
            <button
              onClick={() => { setOpen(false); setHint(''); setSuggestion(null); }}
              className="px-2 py-0.5 rounded text-[11px] hover:bg-secondary"
            >Abbrechen</button>
            <button
              onClick={onAsk}
              disabled={!hint.trim() || wand.isPending}
              className="px-2 py-0.5 rounded text-[11px] bg-primary text-primary-foreground disabled:opacity-50"
            >
              {wand.isPending ? <Loader2 className="w-2.5 h-2.5 animate-spin inline" /> : '→ Vorschlag'}
            </button>
          </div>
          {suggestion != null && (
            <div className="mt-2 border-t border-border pt-2 space-y-1">
              <div className="text-[10px] text-muted-foreground">Vorschlag:</div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-input rounded p-1.5 max-h-32 overflow-y-auto">{suggestion}</pre>
              <div className="flex justify-end gap-1">
                <button onClick={() => setSuggestion(null)} className="px-2 py-0.5 rounded text-[11px] hover:bg-secondary flex items-center gap-1">
                  <X className="w-2.5 h-2.5" /> verwerfen
                </button>
                <button onClick={accept} className="px-2 py-0.5 rounded text-[11px] bg-emerald-600 text-white hover:bg-emerald-500 flex items-center gap-1">
                  <Check className="w-2.5 h-2.5" /> übernehmen
                </button>
              </div>
            </div>
          )}
          {wand.isError && (
            <div className="mt-1 text-[10px] text-red-400">Fehler: {String(wand.error)}</div>
          )}
        </div>
      )}
    </div>
  );
}
