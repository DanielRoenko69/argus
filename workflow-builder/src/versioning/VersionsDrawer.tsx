// Workflow version history drawer.
// Lists last 50 versions; click a version → side-by-side step diff vs current.

import { useState } from 'react';
import { X, History, RotateCw, Loader2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/ui/button';

interface VersionRow {
  id: number;
  version: number;
  saved_by: string | null;
  saved_at: string;
  comment: string | null;
  step_count: number;
}

interface Props {
  open: boolean;
  workflowId: number | null;
  onClose: () => void;
}

export function VersionsDrawer({ open, workflowId, onClose }: Props) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['versions', workflowId],
    queryFn: () => api.get<{ versions: VersionRow[] }>(`/api/workflows/${workflowId}/versions`),
    enabled: open && workflowId != null,
  });
  const [selected, setSelected] = useState<number | null>(null);
  const { data: selDetail } = useQuery({
    queryKey: ['version', workflowId, selected],
    queryFn: () => api.get<{
      version: number; steps: unknown[]; saved_at: string; saved_by: string | null;
    }>(`/api/workflows/${workflowId}/versions/${selected}`),
    enabled: selected != null && workflowId != null,
  });
  const restore = useMutation({
    mutationFn: (v: number) => api.post(`/api/workflows/${workflowId}/versions/${v}/restore`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['flow', workflowId] });
      qc.invalidateQueries({ queryKey: ['versions', workflowId] });
      setSelected(null);
    },
  });

  if (!open) return null;

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-[28rem] border-l border-border bg-card/95 backdrop-blur flex flex-col animate-slide-in-right z-20">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4" />
          <div>
            <h3 className="text-small font-medium">Version History</h3>
            <p className="text-xs text-muted-foreground mt-0.5">letzte 50 Versionen</p>
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary">
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
        {isLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> lädt…
          </div>
        ) : (data?.versions ?? []).length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">noch keine Versionen — speichere einmal</div>
        ) : (
          (data?.versions ?? []).map((v) => (
            <button
              key={v.id}
              onClick={() => setSelected(selected === v.version ? null : v.version)}
              className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${
                selected === v.version ? 'border-primary bg-primary/10' : 'border-border/60 hover:bg-secondary/30'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-foreground">v{v.version}</span>
                <span className="text-muted-foreground text-[10px] ml-auto">{v.step_count} Steps</span>
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {new Date(v.saved_at).toLocaleString()}
                {v.saved_by && <span className="ml-2">— {v.saved_by}</span>}
              </div>
              {v.comment && (
                <div className="text-[11px] text-amber-300 mt-0.5 italic">{v.comment}</div>
              )}
            </button>
          ))
        )}
      </div>

      {selected != null && (
        <footer className="p-3 border-t border-border space-y-2">
          {selDetail && (
            <div className="text-[11px] text-muted-foreground">
              Vorschau: <span className="font-mono text-foreground">v{selDetail.version}</span> — {(selDetail.steps ?? []).length} Steps
            </div>
          )}
          <Button
            variant="default"
            size="sm"
            className="w-full"
            disabled={restore.isPending}
            onClick={() => restore.mutate(selected)}
          >
            {restore.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <RotateCw className="w-3.5 h-3.5" />
            v{selected} wiederherstellen
          </Button>
          {restore.isError && <div className="text-[11px] text-red-400">{String(restore.error)}</div>}
        </footer>
      )}
    </aside>
  );
}
