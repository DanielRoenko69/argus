// Inline rename of the workflow name + description from the TopBar.

import { useState, useRef, useEffect } from 'react';
import { Pencil, Check, X, Loader2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useFlow } from '@/api/workflows';
import { useToast } from '@/ui/toast';

interface Props { workflowId: number | null }

export function InlineRename({ workflowId }: Props) {
  const { data: flow } = useFlow(workflowId);
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = useMutation({
    mutationFn: (name: string) => api.put(`/api/admin/workflows/${workflowId}`, { name }),
    onSuccess: (_d, name) => {
      qc.invalidateQueries({ queryKey: ['flow', workflowId] });
      setEditing(false);
      toast.show(`Workflow umbenannt → ${name}`, 'success');
    },
    onError: (err) => toast.show(`Rename failed: ${err}`, 'error'),
  });

  if (!flow) return <span className="text-small font-medium">Workflow Builder</span>;

  if (editing) {
    const sanitize = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter')   { e.preventDefault(); save.mutate(sanitize(value)); }
            if (e.key === 'Escape')  { e.preventDefault(); setEditing(false); }
          }}
          className="text-small px-1.5 py-0.5 rounded bg-input border border-primary/50 outline-none focus:border-primary w-48"
        />
        <button onClick={() => save.mutate(sanitize(value))} disabled={save.isPending} className="text-emerald-400 hover:text-emerald-300">
          {save.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
        </button>
        <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground">
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => { setValue(flow.name); setEditing(true); }}
      className="group flex items-center gap-1 text-small font-medium hover:text-foreground"
      title="Workflow umbenennen (klick zum Editieren)"
    >
      <span>{flow.name}</span>
      <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 text-muted-foreground transition" />
    </button>
  );
}
