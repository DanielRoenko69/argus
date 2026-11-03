// Validation badge — shows last validate result inline in TopBar.

import { useValidate, type ValidationResult } from '@/api/builder';
import { useBuilderStore } from '@/stores/builderStore';
import { buildSavePayload } from '@/api/workflows';
import { Button } from '@/ui/button';
import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { useState } from 'react';

interface Props { workflowId: number | null }

export function ValidationBadge({ workflowId }: Props) {
  const validate = useValidate();
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const nodes = useBuilderStore((s) => s.nodes);
  const edges = useBuilderStore((s) => s.edges);
  const viewport = useBuilderStore((s) => s.viewport);

  async function onCheck() {
    if (!workflowId) return;
    const payload = buildSavePayload(nodes, edges, viewport);
    try {
      const r = await validate.mutateAsync({ workflowId, steps: payload.steps });
      setResult(r);
      setShowDetail(true);
    } catch { /* error in validate.error */ }
  }

  return (
    <div className="relative">
      <Button variant="ghost" size="sm" disabled={!workflowId || validate.isPending} onClick={onCheck} title="Workflow prüfen">
        {!result ? (
          <ShieldCheck className="w-3.5 h-3.5" />
        ) : result.valid && result.warnings.length === 0 ? (
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
        ) : result.valid ? (
          <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
        ) : (
          <ShieldX className="w-3.5 h-3.5 text-red-400" />
        )}
        Prüfen
      </Button>
      {showDetail && result && (
        <div
          className="absolute right-0 top-full mt-1 w-80 max-h-72 overflow-y-auto rounded-md border border-border bg-card shadow-2xl z-30 animate-slide-in-bottom"
          onMouseLeave={() => setShowDetail(false)}
        >
          <div className="px-3 py-2 border-b border-border flex items-center gap-2">
            {result.valid ? (
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <ShieldX className="w-3.5 h-3.5 text-red-400" />
            )}
            <span className="text-small font-medium">
              {result.valid ? 'Workflow ist valide' : `${result.errors.length} Fehler`}
              {result.warnings.length > 0 && ` · ${result.warnings.length} Warnungen`}
            </span>
          </div>
          <div className="p-2 space-y-1 text-xs">
            {result.errors.map((e, i) => (
              <div key={`e${i}`} className="px-2 py-1 rounded bg-red-500/10 border border-red-500/30">
                <span className="font-mono text-[10px] text-red-300">{e.stepId}</span>
                <div className="text-red-200 mt-0.5">{e.issue}</div>
              </div>
            ))}
            {result.warnings.map((w, i) => (
              <div key={`w${i}`} className="px-2 py-1 rounded bg-amber-500/10 border border-amber-500/30">
                <span className="font-mono text-[10px] text-amber-300">{w.stepId}</span>
                <div className="text-amber-200 mt-0.5">{w.issue}</div>
              </div>
            ))}
            {result.valid && result.warnings.length === 0 && (
              <div className="text-center py-4 text-emerald-400 text-small">Alles tipptopp ✓</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
