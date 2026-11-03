// Subscribe to workflow notifications (Slack DM on success/failure).

import { useState } from 'react';
import { Bell, BellRing, Loader2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

interface Subscriber {
  user_id: number;
  username: string | null;
  channel: string;
  channel_target: string | null;
  on_success: boolean;
  on_failure: boolean;
}

interface Props { workflowId: number | null }

export function SubscribeButton({ workflowId }: Props) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['subscribers', workflowId],
    queryFn: () => api.get<{ subscribers: Subscriber[] }>(`/api/workflows/${workflowId}/subscribers`),
    enabled: workflowId != null,
  });
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [onSuccess, setOnSuccess] = useState(false);
  const [onFailure, setOnFailure] = useState(true);

  const subscribe = useMutation({
    mutationFn: () => api.post(`/api/workflows/${workflowId}/subscribers`, {
      channel: 'slack',
      channel_target: target || null,
      on_success: onSuccess,
      on_failure: onFailure,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subscribers', workflowId] }),
  });

  if (!workflowId) return null;
  const subs = data?.subscribers ?? [];
  const youAreSubbed = subs.some((s) => s.channel === 'slack');

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-secondary text-xs"
        title="Slack-Benachrichtigungen für Workflow-Ergebnis"
      >
        {youAreSubbed ? <BellRing className="w-3 h-3 text-emerald-400" /> : <Bell className="w-3 h-3 text-muted-foreground" />}
        Benachrichtigungen {subs.length > 0 && <span className="text-muted-foreground">({subs.length})</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-72 bg-card border border-border rounded-md shadow-2xl p-3 animate-fade-in">
          <div className="text-xs font-medium mb-2">Slack-Benachrichtigung</div>
          <label className="block text-[11px] text-muted-foreground mb-1">Channel/User (optional)</label>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="#ops-alerts oder @alex"
            className="w-full text-xs px-2 py-1 rounded bg-input border border-border mb-2 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="space-y-1 mb-2">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={onSuccess} onChange={(e) => setOnSuccess(e.target.checked)} className="w-3 h-3 accent-primary" />
              Bei Erfolg
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input type="checkbox" checked={onFailure} onChange={(e) => setOnFailure(e.target.checked)} className="w-3 h-3 accent-primary" />
              Bei Fehler
            </label>
          </div>
          <button
            onClick={() => subscribe.mutate()}
            disabled={subscribe.isPending}
            className="w-full px-2 py-1 rounded bg-primary text-primary-foreground text-xs disabled:opacity-50 flex items-center justify-center gap-1"
          >
            {subscribe.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
            Speichern
          </button>
          {subs.length > 0 && (
            <div className="mt-3 pt-2 border-t border-border">
              <div className="text-[10px] text-muted-foreground mb-1">Aktuelle Abonnenten:</div>
              <ul className="text-[11px] space-y-0.5">
                {subs.map((s) => (
                  <li key={s.user_id} className="text-foreground/80">
                    {s.username ?? `#${s.user_id}`} → {s.channel_target ?? 'default channel'}
                    <span className="text-muted-foreground ml-1">
                      {s.on_failure ? '✗' : ''}{s.on_success ? '✓' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
