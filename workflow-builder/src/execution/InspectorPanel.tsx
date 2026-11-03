// Memory + Hook inspector — fetches data for a specific run and renders
// timeline of what memories were used and which hooks fired.

import { useQuery } from '@tanstack/react-query';
import { Brain, ShieldCheck, Loader2 } from 'lucide-react';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';

interface Memory { id: number; agent_id: number; memory_type: string; content: string; importance: number; created_at: string }
interface Hook { id: number; ts: string; event_type: string; tool: string | null; parameters: Record<string, unknown> | null; risk_level: string | null; error_type: string | null }

interface Props {
  workflowId: number | null;
  runId: number | null;
  kind: 'memories' | 'hooks';
}

export function InspectorPanel({ workflowId, runId, kind }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: [kind, workflowId, runId],
    queryFn: () => api.get<{ memories?: Memory[]; hooks?: Hook[]; error?: string }>(`/api/workflows/${workflowId}/runs/${runId}/${kind}`),
    enabled: workflowId != null && runId != null,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6 text-muted-foreground text-xs">
        <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> lädt…
      </div>
    );
  }
  if (data?.error) {
    return <div className="text-center py-4 text-muted-foreground text-xs">{data.error}</div>;
  }

  if (kind === 'memories') {
    const memories = data?.memories ?? [];
    if (memories.length === 0) {
      return <div className="text-center py-4 text-muted-foreground text-xs">Keine Memories in diesem Run-Fenster</div>;
    }
    return (
      <ul className="space-y-1 p-2">
        {memories.map((m) => (
          <li key={m.id} className="rounded border border-border/60 p-2 text-xs">
            <div className="flex items-center gap-2 mb-1">
              <Brain className="w-3 h-3 text-purple-400" />
              <span className="font-mono text-[10px] text-muted-foreground">agent#{m.agent_id}</span>
              <span className="text-purple-300 text-[10px] px-1.5 rounded bg-purple-500/15">{m.memory_type}</span>
              <span className="text-[10px] text-muted-foreground ml-auto">imp {m.importance.toFixed(2)}</span>
            </div>
            <div className="text-foreground/80 line-clamp-3 break-words">{m.content}</div>
          </li>
        ))}
      </ul>
    );
  }

  const hooks = data?.hooks ?? [];
  if (hooks.length === 0) {
    return <div className="text-center py-4 text-muted-foreground text-xs">Keine Hook-Decisions in diesem Run</div>;
  }
  return (
    <ul className="space-y-1 p-2">
      {hooks.map((h) => {
        const isBlock = String(h.error_type ?? '').includes(':block:');
        const tone = isBlock ? 'border-red-500/40 bg-red-500/5' : h.risk_level === 'high' ? 'border-amber-500/40 bg-amber-500/5' : 'border-emerald-500/30 bg-emerald-500/5';
        return (
          <li key={h.id} className={cn('rounded border p-2 text-xs', tone)}>
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-3 h-3" />
              <span className="font-mono text-[10px] text-muted-foreground">{new Date(h.ts).toLocaleTimeString()}</span>
              <span className={isBlock ? 'text-red-300 font-medium' : 'text-emerald-300'}>
                {isBlock ? 'BLOCKED' : 'allowed'}
              </span>
              {h.tool && <span className="text-muted-foreground">· {h.tool}</span>}
            </div>
            {h.error_type && <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">{h.error_type}</div>}
          </li>
        );
      })}
    </ul>
  );
}
