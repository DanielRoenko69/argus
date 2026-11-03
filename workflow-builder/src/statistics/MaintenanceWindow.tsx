// Maintenance window editor — IT-Ops-specific: workflow may only fire (via
// cron/webhook trigger) during the configured time-window.

import { useState, useEffect } from 'react';
import { Clock, CalendarCheck } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useFlow } from '@/api/workflows';
import { cn } from '@/lib/utils';

const DAYS = [
  { key: 'mon', label: 'Mo' },
  { key: 'tue', label: 'Di' },
  { key: 'wed', label: 'Mi' },
  { key: 'thu', label: 'Do' },
  { key: 'fri', label: 'Fr' },
  { key: 'sat', label: 'Sa' },
  { key: 'sun', label: 'So' },
];

interface MW {
  days?: string[];
  from?: string;
  to?: string;
  timezone?: string;
}

interface Props { workflowId: number | null }

export function MaintenanceWindow({ workflowId }: Props) {
  const { data: flow } = useFlow(workflowId);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mw, setMw] = useState<MW>({});

  useEffect(() => {
    setMw(((flow as unknown as { maintenance_window?: MW })?.maintenance_window) ?? {});
  }, [flow]);

  const save = useMutation({
    mutationFn: (next: MW) => api.put(`/api/workflows/${workflowId}/flow`, { trigger_config: { ...((flow as unknown as { trigger_config?: object })?.trigger_config ?? {}) } } /* noop body, real update below */).then(() =>
      // tags route is the easiest pre-existing mutation we can hijack? No — better: add a dedicated maintenance-window endpoint? For now use PUT /flow with extra field is not supported.
      // Workaround: use admin-workflows PUT to set maintenance_window.
      api.put(`/api/admin/workflows/${workflowId}`, { maintenance_window: next })
    ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flow', workflowId] }),
  });

  if (!workflowId) return null;
  const active = mw.days && mw.days.length > 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border transition',
          active
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
            : 'border-border bg-card/30 text-muted-foreground hover:text-foreground'
        )}
        title="Maintenance Window für Cron/Webhook-Trigger"
      >
        {active ? <CalendarCheck className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
        {active
          ? `${mw.days!.length}d ${mw.from ?? ''}–${mw.to ?? ''}`
          : 'Window'}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-72 bg-card border border-border rounded-md shadow-2xl p-3 animate-fade-in">
          <div className="text-xs font-medium mb-2">Trigger nur in diesem Zeitfenster:</div>
          <div className="flex gap-1 mb-3">
            {DAYS.map((d) => (
              <button
                key={d.key}
                onClick={() => {
                  const cur = new Set(mw.days ?? []);
                  if (cur.has(d.key)) cur.delete(d.key); else cur.add(d.key);
                  setMw({ ...mw, days: [...cur] });
                }}
                className={cn(
                  'w-7 h-7 rounded text-[11px] font-medium transition border',
                  (mw.days ?? []).includes(d.key)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs mb-3">
            <label className="block">
              <div className="text-[10px] text-muted-foreground mb-0.5">Von</div>
              <input
                type="time" value={mw.from ?? ''} onChange={(e) => setMw({ ...mw, from: e.target.value || undefined })}
                className="w-full px-2 py-1 rounded bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
            <label className="block">
              <div className="text-[10px] text-muted-foreground mb-0.5">Bis</div>
              <input
                type="time" value={mw.to ?? ''} onChange={(e) => setMw({ ...mw, to: e.target.value || undefined })}
                className="w-full px-2 py-1 rounded bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </label>
          </div>
          <p className="text-[10px] text-muted-foreground mb-2">
            Cron- und Webhook-Trigger feuern nur in diesem Fenster. Manual-Run ist immer möglich.
          </p>
          <div className="flex gap-1">
            <button
              onClick={() => save.mutate({})}
              className="flex-1 px-2 py-1 rounded text-xs bg-secondary hover:bg-secondary/70"
              disabled={save.isPending}
            >Deaktivieren</button>
            <button
              onClick={() => save.mutate(mw)}
              className="flex-1 px-2 py-1 rounded text-xs bg-primary text-primary-foreground disabled:opacity-50"
              disabled={save.isPending || !mw.days?.length}
            >Speichern</button>
          </div>
        </div>
      )}
    </div>
  );
}
