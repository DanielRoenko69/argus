// Compact stats popover — shown via small badge in TopBar.

import { useState, useRef, useEffect } from 'react';
import { BarChart3, TrendingUp, AlertCircle, Clock } from 'lucide-react';
import { useWorkflowStats } from '@/api/stats';

interface Props { workflowId: number | null }

export function StatsCard({ workflowId }: Props) {
  const { data } = useWorkflowStats(workflowId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!workflowId || !data) return null;
  const successPct = Math.round(data.success_rate * 100);
  const tone =
    data.runs === 0       ? 'text-muted-foreground' :
    successPct >= 95      ? 'text-emerald-400' :
    successPct >= 70      ? 'text-amber-400' :
                            'text-red-400';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-secondary text-xs"
        title="30-Tage-Statistik"
      >
        <BarChart3 className="w-3 h-3 text-muted-foreground" />
        <span className={tone}>{data.runs}× · {successPct}%</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-64 bg-card border border-border rounded-md shadow-2xl p-3 animate-fade-in">
          <div className="text-xs font-medium text-muted-foreground mb-2">Letzte 30 Tage</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Stat icon={TrendingUp} label="Runs" value={`${data.runs}`} />
            <Stat icon={TrendingUp} label="Erfolg" value={`${successPct}%`} tone={tone} />
            <Stat icon={AlertCircle} label="Failed" value={`${data.failed}`} />
            <Stat icon={Clock} label="Avg" value={`${data.avg_duration_ms}ms`} />
            <Stat icon={Clock} label="p99" value={`${data.p99_duration_ms}ms`} />
            {data.last_run_at && (
              <Stat icon={Clock} label="Letzter" value={new Date(data.last_run_at).toLocaleDateString()} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: typeof BarChart3; label: string; value: string; tone?: string }) {
  return (
    <div className="rounded bg-secondary/30 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground flex items-center gap-1">
        <Icon className="w-2.5 h-2.5" /> {label}
      </div>
      <div className={`font-mono text-foreground mt-0.5 ${tone ?? ''}`}>{value}</div>
    </div>
  );
}
