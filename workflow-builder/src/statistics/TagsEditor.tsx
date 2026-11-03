// Inline tags editor — chips with X-delete, input adds new on Enter/Tab/comma.

import { useState, useEffect } from 'react';
import { Tag, X, Loader2 } from 'lucide-react';
import { useSetTags } from '@/api/stats';
import { useFlow } from '@/api/workflows';

interface Props { workflowId: number | null }

export function TagsEditor({ workflowId }: Props) {
  const { data: flow } = useFlow(workflowId);
  const setTags = useSetTags(workflowId);
  const [tags, setLocalTags] = useState<string[]>([]);
  const [input, setInput] = useState('');

  // sync from server
  useEffect(() => {
    const initial = ((flow as unknown as { tags?: string[] })?.tags) ?? [];
    setLocalTags(initial);
  }, [flow]);

  function add(t: string) {
    const v = t.trim().toLowerCase().replace(/[^a-z0-9_:-]/g, '-');
    if (!v) return;
    if (tags.includes(v)) return;
    const next = [...tags, v];
    setLocalTags(next);
    setTags.mutate(next);
    setInput('');
  }

  function remove(t: string) {
    const next = tags.filter((x) => x !== t);
    setLocalTags(next);
    setTags.mutate(next);
  }

  if (!workflowId) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <Tag className="w-3 h-3 text-muted-foreground shrink-0" />
      {tags.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-secondary text-foreground/80">
          {t}
          <button onClick={() => remove(t)} className="hover:text-destructive">
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
            e.preventDefault();
            if (input.trim()) add(input);
          } else if (e.key === 'Backspace' && !input && tags.length > 0) {
            remove(tags[tags.length - 1]!);
          }
        }}
        placeholder={tags.length === 0 ? '+ tag' : '+'}
        className="bg-transparent text-[11px] outline-none placeholder:text-muted-foreground min-w-[60px] w-20"
      />
      {setTags.isPending && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
    </div>
  );
}
