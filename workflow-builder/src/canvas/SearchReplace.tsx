// Cmd+F: floating search bar at top of canvas, with optional Replace mode.
// Searches across node label, type, and string fields in data.

import { useState, useMemo, useEffect } from 'react';
import { Search, Replace, X, ChevronUp, ChevronDown } from 'lucide-react';
import { useBuilderStore } from '@/stores/builderStore';
import { useReactFlow } from 'reactflow';

interface Match {
  nodeId: string;
  label: string;
  field: string;
  snippet: string;
}

interface Props { open: boolean; onClose: () => void }

export function SearchReplace({ open, onClose }: Props) {
  const [q, setQ] = useState('');
  const [replace, setReplace] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const nodes = useBuilderStore((s) => s.nodes);
  const updateNodeData = useBuilderStore((s) => s.updateNodeData);
  const selectNode = useBuilderStore((s) => s.selectNode);
  const { setCenter } = useReactFlow();

  const matches = useMemo<Match[]>(() => {
    if (!q.trim()) return [];
    const needle = q.toLowerCase();
    const out: Match[] = [];
    for (const n of nodes) {
      const label = ((n.data as { label?: string } | undefined)?.label) ?? '';
      const fields = collectStringFields(n.data ?? {});
      // Header match (type/label)
      if (label.toLowerCase().includes(needle) || (n.type ?? '').toLowerCase().includes(needle)) {
        out.push({ nodeId: n.id, label, field: 'label/type', snippet: label || (n.type ?? '') });
      }
      for (const [key, val] of fields) {
        if (val.toLowerCase().includes(needle)) {
          const idx = val.toLowerCase().indexOf(needle);
          const start = Math.max(0, idx - 20);
          const end   = Math.min(val.length, idx + needle.length + 20);
          out.push({ nodeId: n.id, label, field: key, snippet: `…${val.slice(start, end)}…` });
        }
      }
    }
    return out;
  }, [q, nodes]);

  useEffect(() => { setActiveIdx(0); }, [q]);

  function gotoMatch(i: number) {
    const m = matches[i];
    if (!m) return;
    const n = nodes.find((x) => x.id === m.nodeId);
    if (!n) return;
    selectNode(n.id);
    setCenter(n.position.x + 100, n.position.y + 40, { zoom: 1.2, duration: 350 });
    setActiveIdx(i);
  }

  function doReplaceAll() {
    if (!q || !replace) return;
    let count = 0;
    for (const n of nodes) {
      const data = (n.data ?? {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'string' && val.toLowerCase().includes(q.toLowerCase())) {
          patch[key] = val.replace(new RegExp(escapeRegex(q), 'gi'), replace);
          count++;
        }
      }
      if (Object.keys(patch).length > 0) updateNodeData(n.id, patch);
    }
    // eslint-disable-next-line no-alert
    alert(`${count} Felder ersetzt`);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && !e.shiftKey && matches.length) { e.preventDefault(); gotoMatch((activeIdx + 1) % matches.length); }
      if (e.key === 'Enter' && e.shiftKey && matches.length) { e.preventDefault(); gotoMatch((activeIdx - 1 + matches.length) % matches.length); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, matches, activeIdx, onClose]);

  if (!open) return null;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 w-[520px] bg-card border border-border rounded-md shadow-2xl animate-slide-in-bottom">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Search className="w-3.5 h-3.5 text-muted-foreground" />
        <input
          autoFocus
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Suchen in Nodes…"
          className="flex-1 bg-transparent text-small outline-none placeholder:text-muted-foreground"
        />
        <span className="text-xs text-muted-foreground font-mono">
          {matches.length > 0 ? `${activeIdx + 1}/${matches.length}` : '0/0'}
        </span>
        <button onClick={() => gotoMatch((activeIdx - 1 + matches.length) % matches.length)} disabled={!matches.length} className="p-1 hover:bg-secondary rounded disabled:opacity-30">
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => gotoMatch((activeIdx + 1) % matches.length)} disabled={!matches.length} className="p-1 hover:bg-secondary rounded disabled:opacity-30">
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => setShowReplace((v) => !v)} className={`p-1 rounded ${showReplace ? 'bg-secondary' : 'hover:bg-secondary'}`} title="Replace">
          <Replace className="w-3.5 h-3.5" />
        </button>
        <button onClick={onClose} className="p-1 hover:bg-secondary rounded">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {showReplace && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Replace className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            placeholder="Ersetzen mit…"
            className="flex-1 bg-transparent text-small outline-none placeholder:text-muted-foreground"
          />
          <button onClick={doReplaceAll} disabled={!q} className="px-2.5 py-1 rounded bg-primary text-primary-foreground text-xs disabled:opacity-50">
            Alle ersetzen
          </button>
        </div>
      )}
      {matches.length > 0 && (
        <ul className="max-h-64 overflow-y-auto text-xs py-1">
          {matches.slice(0, 30).map((m, i) => (
            <li key={i}>
              <button
                onClick={() => gotoMatch(i)}
                className={`w-full text-left px-3 py-1.5 hover:bg-secondary ${i === activeIdx ? 'bg-primary/10 border-l-2 border-primary' : ''}`}
              >
                <span className="font-medium text-foreground">{m.label || m.nodeId}</span>
                <span className="text-muted-foreground"> · {m.field}</span>
                <div className="text-[11px] text-muted-foreground font-mono truncate">{m.snippet}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function collectStringFields(data: Record<string, unknown>, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([key, v]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...collectStringFields(v as Record<string, unknown>, key));
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
