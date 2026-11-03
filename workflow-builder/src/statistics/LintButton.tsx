// Smart-Linter trigger — runs LLM-based workflow review and shows findings.

import { useState } from 'react';
import { Sparkle, Loader2, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { useLint, type LintFinding } from '@/api/approval';
import { useBuilderStore } from '@/stores/builderStore';
import { buildSavePayload } from '@/api/workflows';
import { cn } from '@/lib/utils';

interface Props { workflowId: number | null }

export function LintButton({ workflowId }: Props) {
  const lint = useLint(workflowId);
  const [open, setOpen] = useState(false);
  const [findings, setFindings] = useState<LintFinding[] | null>(null);
  const selectNode = useBuilderStore((s) => s.selectNode);

  async function run() {
    if (!workflowId) return;
    const s = useBuilderStore.getState();
    const payload = buildSavePayload(s.nodes, s.edges, s.viewport);
    try {
      const r = await lint.mutateAsync(payload.steps);
      setFindings(r.findings);
      setOpen(true);
    } catch { /* error in lint.error */ }
  }

  if (!workflowId) return null;
  return (
    <div className="relative">
      <button
        onClick={open ? () => setOpen(false) : run}
        disabled={lint.isPending}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-secondary text-xs disabled:opacity-50"
        title="Smart-Lint via LLM"
      >
        {lint.isPending ? <Loader2 className="w-3 h-3 animate-spin text-amber-400" /> : <Sparkle className="w-3 h-3 text-amber-400" />}
        Lint
      </button>
      {open && findings && (
        <div className="absolute right-0 top-full mt-1 z-30 w-96 max-h-96 overflow-y-auto bg-card border border-border rounded-md shadow-2xl animate-fade-in">
          <header className="px-3 py-2 border-b border-border text-xs">
            <span className="font-medium">{findings.length} Finding{findings.length === 1 ? '' : 's'}</span>
          </header>
          {findings.length === 0 && (
            <div className="text-center py-6 text-emerald-400 text-xs">✓ Linter findet nichts zu verbessern</div>
          )}
          <ul className="p-2 space-y-2">
            {findings.map((f, i) => {
              const Icon = f.severity === 'error' ? AlertCircle : f.severity === 'warning' ? AlertTriangle : Info;
              const tone = f.severity === 'error' ? 'text-red-400 border-red-500/40 bg-red-500/5'
                       : f.severity === 'warning' ? 'text-amber-400 border-amber-500/40 bg-amber-500/5'
                       : 'text-sky-400 border-sky-500/40 bg-sky-500/5';
              return (
                <li key={i} className={cn('rounded-md border px-3 py-2 text-xs', tone)}>
                  <div className="flex items-start gap-2">
                    <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground">{f.title}</div>
                      <div className="text-foreground/80 mt-0.5">{f.suggestion}</div>
                      {f.step_id && (
                        <button
                          onClick={() => { selectNode(f.step_id!); setOpen(false); }}
                          className="text-[10px] mt-1 underline text-muted-foreground hover:text-foreground"
                        >
                          → Step {f.step_id} öffnen
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {lint.isError && open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-72 bg-card border border-red-500/40 rounded-md p-2 text-xs text-red-400">
          {String(lint.error)}
        </div>
      )}
    </div>
  );
}
